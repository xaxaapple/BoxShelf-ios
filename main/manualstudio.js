// Manual Studio (Settings → Art & manuals → Manuals, Details → Choose manual…, the Art Studio's "Manual" part): every
// manual found for a game side by side — archive.org uploads, GamesDatabase's PDF, the console's manual collections, the
// manual on disk and earlier ones Boxshelf set aside — with a first-page preview, language / region, pages and scan quality.
// "Use" downloads one, turns it into pages the same way the automatic download does, puts it in place (the manual it
// replaces goes to covers\.manual-originals\<game>\<time>, never deleted); it is your pick, not a lock (1.73): only the Lock switch keeps
// a new console choice off it. Automatic passes leave a picked manual alone.
// Undo puts the previous manual back. "My PDF…" adds your own (main opens the picker; the file is copied, never moved).
// Each console also has a one-tap choice (best English manual, or a language / region) that the automatic download follows.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const paths = require('./paths');
const M = require('./manuals');
const C = require('./manualcoll');
const spreads = require('./spreads');

const PREFS = [
  { id: 'best', label: 'Best English manual', sub: 'The sharpest complete English manual (how Boxshelf always chose)' },
  { id: 'region:eur', label: 'English · Europe', sub: 'PAL booklets in English' },
  { id: 'region:jpn', label: 'Japanese', sub: 'Japanese booklets' },
  { id: 'lang:fr', label: 'French', sub: 'Manuals in French' },
  { id: 'lang:de', label: 'German', sub: 'Manuals in German' },
  { id: 'lang:es', label: 'Spanish', sub: 'Manuals in Spanish' },
  { id: 'lang:it', label: 'Italian', sub: 'Manuals in Italian' }
];
const LANG_LABEL = { en: 'English', fr: 'French', de: 'German', es: 'Spanish', it: 'Italian', ja: 'Japanese', pt: 'Portuguese', nl: 'Dutch' };
const REG_LABEL = { usa: 'USA', eur: 'Europe', jpn: 'Japan' };
const SIDE = '.boxshelf-manual.json'; // in a backup folder: what that manual was (for its "Earlier" card)
const CACHE_CAP = 600 * 1048576, CACHE_DAYS = 14, MAX_PDF = 400 * 1048576, JOB_MAX = 40, HIST_MAX = 12;
const PDF_CUT = 80, IA_CUT = 60; // renderPdfPages draws at most 80 pages of a PDF, fetchManual takes at most 60 archive.org pages (MAX_PAGES): a longer manual is cut there, and the counts say so

let env = null, log = () => {}, storeFile = null, store = null, candDir = null, thumbGen = 0, jobN = 0;
const lists = new Map(), gameChain = new Map(), jobs = new Map(), gamesMemo = new Map();

function init(e) {
  env = e; if (e.log) log = e.log;
  storeFile = path.join(e.dataDir, 'manual-studio.json'); store = null;
  candDir = path.join(e.dataDir, 'manual-cand');
  setTimeout(() => pruneCache(), 20000).unref?.();
}
const cacheDir = () => candDir;
function db() {
  if (store) return store;
  try { store = JSON.parse(fs.readFileSync(storeFile, 'utf8')); } catch { store = {}; }
  for (const k of ['prefs', 'locks', 'cur', 'hist']) if (!store[k] || typeof store[k] !== 'object' || Array.isArray(store[k])) store[k] = {};
  return store;
}
function save() { if (!storeFile || !store) return; try { fs.mkdirSync(path.dirname(storeFile), { recursive: true }); fs.writeFileSync(storeFile + '.tmp', JSON.stringify(store)); fs.renameSync(storeFile + '.tmp', storeFile); } catch (e) { log('Manual Studio: could not save', e.message); } }
// the same key the automatic search and the collections use for a game
const keyOf = (sysId, file) => sysId + '|' + String(file).toLowerCase();
const isLocked = (sysId, file) => !!db().locks[keyOf(sysId, file)];
const prefFor = sysId => db().prefs[sysId] || 'best';
// a manual the user picked (Use, My PDF…): automatic passes leave it alone, a new console choice replaces it (1.73)
const isPick = c => !!(c && (c.origin === 'studio' || c.origin === 'own'));
const picked = (sysId, file) => isPick(db().cur[keyOf(sysId, file)]);
// a manual Boxshelf put in from somewhere else than the game itself (the reader then doesn't open a Wii U e-manual on the box front)
const chosen = (sysId, file) => { const c = db().cur[keyOf(sysId, file)]; return !!(c && c.src && c.src !== 'builtin'); };

// ---------- arguments (everything the screen sends is checked) ----------
function needObj(a) { if (!a || typeof a !== 'object' || Array.isArray(a)) throw new Error('Bad request.'); return a; }
function sysArg(a) { const id = String(needObj(a).systemId || ''), item = env.consoles().find(x => x.def.id === id); if (!item) throw new Error('Unknown system.'); return item; }
async function gamesFor(sysId, fresh) {
  const m = gamesMemo.get(sysId); if (m && !fresh && Date.now() - m.at < 30000) return m;
  const item = env.consoles().find(x => x.def.id === sysId); if (!item) throw new Error('Unknown system.');
  await new Promise(r => setImmediate(r));
  const list = (await env.scan(item.def, item.sc, !!fresh)).filter(g => g.kind !== 'app' && !g.extra); // (beta.9: fresh reads the folders again, past the scanner's kept scan; beta.10: env.scan is the async scan)
  const r = { at: Date.now(), list, byFile: new Map(list.map(g => [path.resolve(g.file).toLowerCase(), g])) }; gamesMemo.set(sysId, r); return r;
}
async function gameArg(a) {
  const { def, sc } = sysArg(a); if (typeof a.file !== 'string' || !a.file || a.file.length > 4096) throw new Error('Bad game.');
  const file = env.gameFile(def.id, a.file).file, want = path.resolve(file).toLowerCase();
  let g = (await gamesFor(def.id)).byFile.get(want); if (!g) g = (await gamesFor(def.id, true)).byFile.get(want);
  if (!g) throw new Error('That game is not on this shelf.');
  return gameRec(def.id, sc, g);
}
// dir: where the manual the reader shows lives now (the scanner takes the first art folder that has one: an older layout's
// manual beside the box art, or one beside the games not yet copied to the art library), so a new one replaces exactly
// that one and the reader opens it; else where manuals go. home: where manuals go (earlier copies may be kept there too)
function gameRec(sysId, sc, g) {
  const home = paths.manualDirFor(sc, g.file), a = g.art || {}, now = (a.manual && a.manual[0]) || a.manualPdf;
  return { sysId, sc, game: g, dir: now ? path.dirname(now) : home, home, base: paths.artBase(g.file), key: keyOf(sysId, g.file) };
}

// ---------- what a manual on disk is ----------
const PAGE_RE = /-manual-\d+\.(jpe?g|png|webp)$/i;
const byNum = (a, b) => a.localeCompare(b, undefined, { numeric: true });
function pagesIn(dir, base) { const pre = (base + '-manual-').toLowerCase(); let n = []; try { n = fs.readdirSync(dir); } catch {} return n.filter(f => f.toLowerCase().startsWith(pre) && PAGE_RE.test(f)).sort(byNum); }
function quality(w, bpp) {
  if (w) return w >= 1400 ? { q: 'sharp', label: `Sharp · ${w} px` } : w >= 900 ? { q: 'good', label: `Good · ${w} px` } : w >= 600 ? { q: 'fair', label: `Fair · ${w} px` } : { q: 'low', label: `Low-res · ${w} px` };
  if (bpp) { const kb = Math.round(bpp / 1024); return bpp >= 250000 ? { q: 'sharp', label: `PDF · ${kb} KB a page` } : bpp >= 120000 ? { q: 'good', label: `PDF · ${kb} KB a page` } : { q: 'fair', label: `PDF · ${kb} KB a page` }; }
  return { q: '', label: '' };
}
const thumbUrl = f => { if (!f) return null; const u = env.fileUrl(f); return u + (u.includes('?') ? '&' : '?') + 't=360'; };
const readSide = d => { try { return JSON.parse(fs.readFileSync(path.join(d, SIDE), 'utf8')); } catch { return null; } };
// what the manual in use is, as far as Boxshelf knows: picked here, fetched by the automatic search, or from a collection
function curMeta(g) {
  const s = db().cur[g.key]; if (s) return s;
  const c = C.info(g.key); if (c && c.src) return { src: c.src.startsWith('gdb/') ? 'gdb:' + c.src.slice(4) : 'coll:' + c.src, label: c.src.startsWith('gdb/') ? 'GamesDatabase' : 'Collection · ' + c.src.split('/')[0], lang: 'en', region: c.src.startsWith('gdb/') ? '' : 'usa', origin: 'auto' };
  const a = M.autoInfo(g.key); if (a && a.got) return { src: String(a.got).startsWith('gdb:') ? a.got : 'ia:' + a.got, label: a.title || '', lang: 'en', region: M.regionOf(a.title), origin: 'auto' };
  if (g.sysId === 'wiiu') return { src: 'builtin', label: 'Built-in e-manual', lang: '', region: '', origin: 'auto' };
  return null;
}
function currentCand(g) {
  const pages = (g.game.art && g.game.art.manual && g.game.art.manual.length) ? g.game.art.manual.slice() : pagesIn(g.dir, g.base).map(f => path.join(g.dir, f));
  const pdf = g.game.art && g.game.art.manualPdf;
  if (!pages.length && !pdf) return null;
  const ws = pages.slice(0, 6).map(f => (spreads.sizeOf(f) || [0])[0]).filter(w => w >= 300).sort((a, b) => a - b);
  const w = ws.length ? ws[ws.length >> 1] : 0, meta = curMeta(g) || {};
  return { key: 'cur', source: 'current', label: meta.label || 'The manual on disk', lang: meta.lang || '', region: meta.region || '', pages: pages.length || null, w,
    thumb: thumbUrl(pages[0]), inUse: true, pdfOnly: !pages.length, src: meta.src || null, expected: meta.expected || null, origin: meta.origin || '' };
}
function earlierCands(g) {
  // the backups beside the manual in use, and (when that's an older place) the ones where manuals go now
  let ds = []; [g.dir, g.home].filter((r, i, a) => r && a.findIndex(x => x && path.resolve(x).toLowerCase() === path.resolve(r).toLowerCase()) === i).forEach((r, ri) => {
    const root = path.join(r, '.manual-originals', g.base); try { fs.readdirSync(root, { withFileTypes: true }).forEach(d => { if (d.isDirectory()) ds.push({ root, d: d.name, k: (ri ? 'h/' : '') + d.name }); }); } catch {} });
  ds = ds.sort((a, b) => a.d < b.d ? 1 : a.d > b.d ? -1 : 0);
  // (beta.9) the same manual is listed once: Repair, Wrong game and every Use each keep a copy of what was there, so one
  // manual could fill the list. Same pages (count, first and last page's size) = the same manual; the newest copy is shown,
  // and none that matches the manual in use. Nothing is deleted
  const fsz = f => { try { return fs.statSync(f).size; } catch { return 0; } };
  const sig = (dir, pages) => pages.length + ':' + fsz(path.join(dir, pages[0])) + ':' + fsz(path.join(dir, pages[pages.length - 1]));
  const curPages = g.dir ? pagesIn(g.dir, g.base) : [], seen = new Set(curPages.length ? [sig(g.dir, curPages)] : []);
  const out = [];
  for (const { root, d, k } of ds.slice(0, 30)) {
    if (out.length >= 10) break;
    const full = path.join(root, d), pages = pagesIn(full, g.base); if (!pages.length) continue;
    const s = sig(full, pages); if (seen.has(s)) continue; seen.add(s);
    const side = readSide(full) || {}, w = (spreads.sizeOf(path.join(full, pages[0])) || [0])[0];
    const when = /^(\d{4})-(\d\d)-(\d\d)/.exec(d);
    out.push({ key: 'earlier:' + k, source: 'earlier', label: (side.label ? side.label + ' · ' : '') + 'Earlier' + (when ? ` (${when[3]}/${when[2]}/${when[1]})` : ''), lang: side.lang || '', region: side.region || '', pages: pages.length, w, thumb: thumbUrl(path.join(full, pages[0])), dir: full, src: side.src || null });
  }
  return out;
}

// ---------- the candidate cache (data\manual-cand): first pages, and PDFs kept for Use ----------
const cacheName = (key, ext) => path.join(candDir, crypto.createHash('sha1').update(key).digest('hex').slice(0, 24) + ext);
function pruneCache() {
  if (!candDir) return; let all = [];
  try { all = fs.readdirSync(candDir).map(n => { const f = path.join(candDir, n); try { const st = fs.statSync(f); return { f, t: st.mtimeMs, n: st.size }; } catch { return null; } }).filter(Boolean); } catch { return; }
  const old = Date.now() - CACHE_DAYS * 864e5; let total = 0;
  all.sort((a, b) => b.t - a.t).forEach(x => { total += x.n; if (x.t < old || total > CACHE_CAP || (/\.part$/.test(x.f) && x.t < Date.now() - 3600e3)) { try { fs.unlinkSync(x.f); } catch {} } }); // (a .part still downloading is left alone)
}
let addedBytes = 0; // pruned again every 64 MB downloaded, not only at start-up (a launcher left running for days)
// a PDF's page count from its page tree (the largest /Count); null when the PDF hides it (compressed object streams)
async function pdfPages(file) {
  try { const st = await fs.promises.stat(file); if (st.size > 64 * 1048576) return null; /* read and searched on the main thread: a bigger one goes uncounted */ const t = (await fs.promises.readFile(file)).toString('latin1'); let n = 0; for (const m of t.matchAll(/\/Type\s*\/Pages\b[^]*?\/Count\s+(\d+)|\/Count\s+(\d+)[^]{0,200}?\/Type\s*\/Pages\b/g)) n = Math.max(n, +(m[1] || m[2])); return n || null; } catch { return null; }
}
const isPdf = f => { let fd; try { fd = fs.openSync(f, 'r'); const b = Buffer.alloc(5); fs.readSync(fd, b, 0, 5, 0); return b.toString('latin1') === '%PDF-'; } catch { return false; } finally { if (fd != null) try { fs.closeSync(fd); } catch {} } };
async function fetchPdf(c, url) {
  const pdf = cacheName(c.key, '.pdf');
  if (!paths.isFile(pdf)) { fs.mkdirSync(candDir, { recursive: true }); if (!await M.getFile(url, pdf, 0, { stall: 30000, deadline: 300000 })) return null; try { addedBytes += fs.statSync(pdf).size; } catch {} if (addedBytes > 64 * 1048576) { addedBytes = 0; setImmediate(pruneCache); } }
  if (!isPdf(pdf)) { try { fs.unlinkSync(pdf); } catch {} return null; }
  return pdf;
}
// a downloaded PDF's first page as the card's picture
async function pdfThumb(c, pdf) {
  const jpg = cacheName(c.key, '.jpg');
  if (!paths.isFile(jpg)) { const b = env.renderFirst ? await env.renderFirst(pdf) : null; if (!b || !b.length) return null; const tmp = `${jpg}.${process.pid}.tmp`; // (beta.10) temp + rename: a cut-off write was trusted from then on
    try { fs.writeFileSync(tmp, b); fs.renameSync(tmp, jpg); } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; } }
  const size = fs.statSync(pdf).size, n = await pdfPages(pdf);
  return { jpg, pages: n, bpp: n ? size / n : 0 };
}

// ---------- the candidates ----------
const iaKey = id => 'ia:' + id;
function iaCand(h) { const lang = M.langCode(h.language, h.title) || (h.language ? '' : 'en'); return { key: iaKey(h.id), id: h.id, source: 'archive', rel: h.score, title: h.title, label: 'Internet Archive · ' + h.title, lang, region: M.regionOf(h.title), pages: h.pages || null, url: h.url }; }
function gdbCand(h) { const url = h.id.slice(4); return { key: 'gdb:' + url, id: h.id, pdfUrl: url, source: 'gamesdatabase', rel: 9.5, title: h.title, label: 'GamesDatabase · ' + h.title, lang: 'en', region: M.regionOf(h.title) || 'usa', pages: null }; }
function collCand(col, ix, e) {
  const tags = (e.tags || []).join(' '), lt = (e.tags || []).find(t => /^[A-Z][a-z](,[A-Z][a-z])+$/.test(t)), lang = lt ? M.langCode(lt.split(',')[0].toLowerCase()) : '';
  const region = /\bUSA\b|^U$|World/.test(tags) ? 'usa' : /Europe|^E$|\bUK\b/.test(tags) ? 'eur' : /Japan|^J$/.test(tags) ? 'jpn' : 'usa';
  return { key: 'coll:' + col.id + '/' + e.name, col, ix, e, source: 'collection', rel: 12, title: e.title, label: (col.digital ? 'Official digital manual · ' : 'Collection scan · ') + e.title + (e.disc > 1 ? ` (disc ${e.disc})` : ''), lang: lang || (region === 'jpn' ? 'ja' : 'en'), region, pages: null, digital: !!col.digital };
}
// checks a candidate can really be downloaded, and fetches its first page: false = not shown at all
async function verify(c) {
  fs.mkdirSync(candDir, { recursive: true });
  const jpg = cacheName(c.key, '.jpg'), page1 = async url => paths.isFile(jpg) || await M.getFile(url, jpg, 0, { stall: 15000, deadline: 60000 }).catch(() => false);
  if (c.source === 'archive') {
    const meta = await M.getJson(`https://archive.org/metadata/${encodeURIComponent(c.id)}`); const files = meta.files || [], md = meta.metadata || {};
    if (/borrow|inlibrary|printdisabled/i.test(String(md.collection || '')) && !files.some(f => /_jp2\.zip$/i.test(f.name))) return false;
    const jp2 = files.find(f => /_jp2\.zip$/i.test(f.name)), imgs = files.filter(f => /\.(jpe?g|png)$/i.test(f.name) && !/__ia_thumb|_thumb\./i.test(f.name)).sort((a, b) => byNum(a.name, b.name));
    if (!jp2 && !imgs.length) return false; // nothing fetchManual could save
    c.pages = +md.imagecount || (jp2 ? c.pages : imgs.length) || null;
    c.lang = M.langCode(md.language, c.title) || c.lang; c.region = M.regionOf([c.title, md.description, md.subject].join(' ')) || c.region;
    if (/incomplete|missing pages|pages missing/i.test(String(c.title) + ' ' + String(md.description || ''))) c.incomplete = true;
    if (!await page1(jp2 ? `https://archive.org/download/${encodeURIComponent(c.id)}/page/n0_w1600.jpg` : `https://archive.org/download/${encodeURIComponent(c.id)}/${encodeURIComponent(imgs[0].name)}`)) return false;
    c.w = (spreads.sizeOf(jpg) || [0])[0]; c.thumbFile = jpg; return true;
  }
  if (c.source === 'collection' && !c.digital && c.e.jp2) {
    const urls = await C.jp2Pages(c.col, c.ix, c.e); if (!urls.length) return false; c.pages = urls.length;
    if (!(urls[0].full && await page1(urls[0].full)) && !await page1(urls[0].half)) return false;
    c.w = (spreads.sizeOf(jpg) || [0])[0]; c.thumbFile = jpg; return true;
  }
  // a PDF (GamesDatabase, a digital manual): downloaded now, so Use doesn't wait for it again
  const pdf = await fetchPdf(c, c.pdfUrl || `https://archive.org/download/${encodeURIComponent(c.col.id)}/${c.e.name.split('/').map(encodeURIComponent).join('/')}`);
  if (!pdf) return false; const t = await pdfThumb(c, pdf); if (!t) return false;
  c.pdf = pdf; c.thumbFile = t.jpg; c.pages = t.pages || c.pages; c.bpp = t.bpp; return true;
}
// the expected page count per language: the count most copies agree on (two or more), else none
function expectOf(list) {
  // one vote per copy: the manual in use and its earlier backup of the same download are one copy, not two agreeing
  const by = {}, once = new Set(); for (const c of list) if (c.pages && !c.pdfOnly) { const id = c.src || c.key; if (id && id !== 'cur') { if (once.has(id)) continue; once.add(id); } const l = c.lang || 'en'; (by[l] = by[l] || []).push(c.pages); }
  const out = {}; for (const [l, ns] of Object.entries(by)) { const f = new Map(); ns.forEach(n => f.set(n, (f.get(n) || 0) + 1)); const best = [...f].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]; if (best && best[1] >= 2) out[l] = best[0]; }
  return out;
}
// "Complete" / "2 pages missing" / '' (nothing to compare with)
function completeness(c, expect) {
  if (c.incomplete) return { complete: false, missing: 0, text: 'Incomplete (says the upload)' };
  if (c.junk) return { complete: false, missing: c.junk, text: `${c.junk} blank page${c.junk === 1 ? '' : 's'}` };
  const want = (expect || {})[c.lang || 'en'] || c.expected; if (!c.pages || !want) return { complete: null, missing: 0, text: '' };
  return c.pages >= want ? { complete: true, missing: 0, text: 'Complete' } : { complete: false, missing: want - c.pages, text: `${want - c.pages} page${want - c.pages === 1 ? '' : 's'} missing` };
}
// how well a candidate fits the console's choice (the list's order, and what a re-pick takes)
function rank(c, pref, expect) {
  const ok = M.prefMatch(c, pref), en = !c.lang || c.lang === 'en';
  let s = ok ? 30 : en ? 10 : 0; s += Math.min(12, c.rel || 0) + (c.source === 'collection' ? 3 : c.source === 'gamesdatabase' ? 1 : 0);
  if (c.w) s += c.w >= 1400 ? 3 : c.w >= 900 ? 2 : c.w < 600 ? -2 : 0; else if (c.bpp) s += c.bpp >= 250000 ? 3 : c.bpp >= 120000 ? 1 : -1;
  const k = completeness(c, expect); if (k.complete === false) s -= 6; else if (k.complete) s += 1;
  if (pref === 'best' || !pref) s += c.region === 'usa' ? 1 : 0;
  return s;
}
function pub(c, expect, pref) {
  const k = completeness(c, expect), q = quality(c.w, c.bpp);
  return { key: c.key, source: c.source, label: c.label, title: c.title || '', lang: c.lang || '', langName: LANG_LABEL[c.lang] || (c.lang ? c.lang : 'Language unknown'), region: c.region || '', regionName: REG_LABEL[c.region] || '',
    pages: c.pages || null, complete: k.complete, completeText: [k.text, (c.pdf || c.bpp) && c.pages > PDF_CUT ? `only the first ${PDF_CUT} pages are kept` : c.source === 'archive' && c.pages > IA_CUT ? `only the first ${IA_CUT} pages are kept` : ''].filter(Boolean).join(' · '), missing: k.missing, w: c.w || null, quality: q.q, qualityText: q.label,
    thumb: c.thumb || (c.thumbFile ? thumbUrl(c.thumbFile) : null), inUse: !!c.inUse, pdfOnly: !!c.pdfOnly, origin: c.origin || '', fits: M.prefMatch(c, pref), score: Math.round(rank(c, pref, expect) * 10) / 10 };
}
// the list for one game: what's on disk now (instant), then every remote copy as it proves downloadable (events)
async function cands(a) {
  const g = await gameArg(a), gen = ++thumbGen, pref = prefFor(g.sysId);
  const cur = currentCand(g), local = [...(cur ? [cur] : []), ...earlierCands(g)];
  const entry = { g, gen, list: local.slice(), searching: true, at: Date.now() }; lists.set(g.key, entry);
  const send = d => env.send('manual:cand', { systemId: g.sysId, file: g.game.file, ...d });
  const expect = () => expectOf(entry.list);
  (async () => {
    const title = g.game.title, found = [], seen = new Set(local.map(c => c.src).filter(Boolean)); let offline = false;
    // the copy already in use (Boxshelf knows where it came from) isn't offered twice: the "in use" card stands for it
    const add = x => { if (!x || found.some(y => y.key === x.key)) return; if (seen.has(x.key)) return; found.push(x); };
    const searches = [
      ...(C.COLLECTIONS[g.sysId] || []).map(col => C.index(col).then(ix => C.matches(ix.entries, g.game).slice(0, 3).forEach(e => add(collCand(col, ix, e)))).catch(e => log('Manual Studio: collection', col.id, e.message))),
      M.searchGamesDatabase(g.sysId, title).then(h => { if (h) add(gdbCand(h)); }).catch(() => {}),
      M.searchArchive(g.sysId, title).then(l => l.forEach(h => add(iaCand(h)))).catch(e => { offline = true; log('Manual Studio: search', title, e.message); })
    ];
    // checks start as soon as each search answers, three at a time, newest request first
    let i = 0, done = false, wake = null; const settle = Promise.all(searches).then(() => { done = true; if (wake) wake(); });
    const worker = async () => {
      for (;;) {
        if (gen !== thumbGen) return;
        if (i >= found.length) { if (done) return; await new Promise(r => { wake = r; setTimeout(r, 250); }); continue; }
        const c = found[i++];
        let okk = false; try { okk = await verify(c); } catch (e) { log('Manual Studio: candidate', c.key.slice(0, 80), e.message); }
        if (!okk || gen !== thumbGen) continue;
        entry.list.push(c); const ex = expect();
        send({ key: c.key, cand: pub(c, ex, pref), expect: ex });
      }
    };
    await Promise.all([settle, worker(), worker(), worker()]);
    if (gen !== thumbGen) return;
    entry.searching = false; const ex = expect();
    send({ done: true, expect: ex, count: entry.list.length, offline: offline && entry.list.length === local.length, list: entry.list.map(c => pub(c, ex, pref)) });
  })().catch(e => log('Manual Studio: search', e.message));
  const ex = expect();
  return { list: local.map(c => pub(c, ex, pref)), searching: true, expect: ex, locked: isLocked(g.sysId, g.game.file), pref, canUndo: !!(db().hist[g.key] || []).length, title: g.game.title };
}

// ---------- putting a manual in place ----------
function withGame(k, fn) { const prev = gameChain.get(k) || Promise.resolve(); const run = prev.catch(() => {}).then(fn); const tail = run.catch(() => {}); gameChain.set(k, tail); tail.then(() => { if (gameChain.get(k) === tail) gameChain.delete(k); }); return run; }
const stageDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'boxshelf-manual-studio-'));
async function pdfToPages(pdf, stage, base) {
  if (!env.renderPdf) throw new Error('no PDF renderer');
  const pages = await env.renderPdf(pdf); const n = await M.writePages(stage, base, pages);
  if (!n) throw new Error('the PDF could not be turned into pages');
  const of = n >= PDF_CUT ? await pdfPages(pdf) : n; return { n, cut: n >= PDF_CUT && (!of || of > n) ? { max: PDF_CUT, of: of || 0 } : 0 }; // cut: only the first 80 came out (of: the PDF's own count, 0 when unknown)
}
const cutNote = cut => cut ? ` · only the first ${cut.max}${cut.of ? ' of ' + cut.of : ''} pages` : '';
// the chosen candidate's pages into a temporary folder, cut into single pages like every other download
async function fill(g, c, stage, progress) {
  let cut = 0;
  if (c.source === 'earlier') { for (const f of pagesIn(c.dir, g.base)) await fs.promises.copyFile(path.join(c.dir, f), path.join(stage, f)); return 0; } // copied: the earlier copy stays where it is
  if (c.source === 'archive') { await M.fetchManual(c.id, stage, g.base, progress); if (c.pages > IA_CUT) cut = { max: IA_CUT, of: c.pages }; }
  else if (c.source === 'collection' && !c.digital && c.e.jp2) { await C.fetchTo(c.col, c.ix, c.e, stage, g.base, { cancelled: () => false }); }
  else { const pdf = c.pdf && paths.isFile(c.pdf) ? c.pdf : await fetchPdf(c, c.pdfUrl || `https://archive.org/download/${encodeURIComponent(c.col.id)}/${c.e.name.split('/').map(encodeURIComponent).join('/')}`); if (!pdf) throw new Error('the PDF could not be downloaded'); progress({ stage: 'Turning the PDF into pages…' }); cut = (await pdfToPages(pdf, stage, g.base)).cut; }
  if (env.crop) { try { await spreads.splitManual(stage, g.base, env.crop, { scan: c.source === 'collection' && !c.digital, discard: true }); } catch (e) { log('Manual Studio: spreads', e.message); } }
  return cut;
}
// the old manual aside (a new .manual-originals folder with a note of what it was), the new pages in: a failure anywhere
// puts everything back. Returns the backup folder (null when there was no manual).
function swapIn(g, stage, prevMeta) {
  const pages = pagesIn(stage, g.base); if (!pages.length) throw new Error('No pages came out of that manual.');
  fs.mkdirSync(g.dir, { recursive: true });
  const olds = C.manualFiles(g.dir, g.base), keep = olds.length ? spreads.backupDir(g.dir, g.base) : null, moved = [], placed = [];
  try {
    for (const f of olds) { C.moveFile(path.join(g.dir, f), path.join(keep, f)); moved.push(f); }
    pages.forEach((f, i) => { const d = path.join(g.dir, `${g.base}-manual-${String(i + 1).padStart(2, '0')}${path.extname(f).toLowerCase()}`); C.moveFile(path.join(stage, f), d); placed.push(d); });
  } catch (e) {
    for (const d of placed) { try { fs.unlinkSync(d); } catch {} }
    for (const f of moved) { try { C.moveFile(path.join(keep, f), path.join(g.dir, f)); } catch {} }
    if (keep) { try { fs.rmdirSync(keep); } catch {} }
    throw new Error('Couldn\'t put the manual in place (' + (e.code || e.message) + '). Is a page open in another program? The old one was kept.');
  }
  if (keep) { try { fs.writeFileSync(path.join(keep, SIDE), JSON.stringify(prevMeta || { label: 'Manual from before' })); } catch {} }
  return { keep, n: placed.length };
}
function remember(g, keep, meta, lock) {
  const s = db(), h = s.hist[g.key] = s.hist[g.key] || [];
  h.push({ dir: keep, cur: s.cur[g.key] || null, lock: s.locks[g.key] || null, at: Date.now() }); while (h.length > HIST_MAX) h.shift();
  s.cur[g.key] = { ...meta, at: Date.now() }; if (lock) s.locks[g.key] = { at: Date.now(), src: meta.src }; save();
}
function result(g) { gamesMemo.delete(g.sysId); lists.delete(g.key); env.changed({ manualStudio: 1, systemId: g.sysId, file: g.game.file });
  const pages = pagesIn(g.dir, g.base).map(f => env.fileUrl(path.join(g.dir, f)));
  return { manual: pages, locked: isLocked(g.sysId, g.game.file), canUndo: !!(db().hist[g.key] || []).length, cur: db().cur[g.key] || null }; }
const metaOf = c => ({ src: c.source === 'earlier' ? (c.src || c.key) : c.key, label: c.source === 'earlier' ? (c.label.replace(/(^| · )Earlier.*$/, '') || 'Your manual from before') : c.label.replace(/ · Earlier.*$/, ''), lang: c.lang || '', region: c.region || '', expected: c.pages || null, origin: 'studio' });
// one game's manual from a candidate (it never locks: only the Lock switch does, 1.73). opts.skip(): asked inside the
// game's turn, so a re-pick queued behind a Use or a lock the user made meanwhile gives way (→ null)
async function apply(g, c, opts = {}) {
  const prog = opts.progress || (() => {});
  return withGame(g.key, async () => {
    if (opts.skip && opts.skip()) return null;
    const stage = stageDir();
    try {
      const cut = await fill(g, c, stage, prog);
      const prev = curMeta(g), r = swapIn(g, stage, prev), meta = { ...metaOf(c), origin: opts.origin || 'studio' };
      if (cut) meta.expected = r.n; // cut at 80 / 60: what came out is the whole of what Boxshelf can show (not "N pages missing" for ever)
      remember(g, r.keep, meta, opts.lock === true);
      // (beta.9) an earlier copy put back is moved, not copied: it leaves the Earlier list (it used to stay there, and the
      // manual it replaced was kept as one more, so every press added a copy). Undo still has the one it replaced
      if (c.source === 'earlier' && c.dir && path.resolve(c.dir).toLowerCase() !== path.resolve(r.keep || '').toLowerCase()) {
        try { fs.rmSync(c.dir, { recursive: true, force: true }); } catch {}
        const s = db(), h = s.hist[g.key]; if (h) { s.hist[g.key] = h.filter(e => !e || path.resolve(String(e.dir || '')).toLowerCase() !== path.resolve(c.dir).toLowerCase()); save(); } }
      log('Manual Studio:', path.basename(g.game.file), '->', c.key.slice(0, 120), '-', r.n, 'pages', cut ? '(cut at ' + cut.max + ' pages)' : '', r.keep ? '(old one kept in ' + path.basename(r.keep) + ')' : '');
      return { n: r.n, cut };
    } finally { try { fs.rmSync(stage, { recursive: true, force: true }); } catch {} }
  });
}
function candArg(g, key) {
  if (typeof key !== 'string' || !key || key.length > 2048) throw new Error('Bad version.');
  const e = lists.get(g.key), c = e && e.list.find(x => x.key === key);
  if (c) return c;
  if (key === 'cur') return currentCand(g);
  if (key.startsWith('earlier:')) { const x = earlierCands(g).find(y => y.key === key); if (x) return x; }
  throw new Error('That version isn\'t in the list any more. Open the game again.'); // never a URL the screen made up
}
const useJob = (g, what) => { const id = 'mu' + (++jobN); const send = d => env.send('manual:job', { id, kind: 'use', systemId: g.sysId, file: g.game.file, label: what, ...d }); return send; };
async function use(a) {
  const g = await gameArg(a), c = candArg(g, needObj(a).key);
  if (c.key === 'cur') return result(g); // the one in use: nothing to do (1.73: Use doesn't lock; the Lock switch does)
  const send = useJob(g, g.game.title); send({ state: 'run', msg: 'Downloading…' });
  try { const r = await apply(g, c, { lock: false, progress: p => send({ state: 'run', msg: String(p && p.stage || '').replace(/^.*?: /, '') }) }); send({ state: 'done', msg: 'Manual in place' + cutNote(r && r.cut) }); }
  catch (e) { send({ state: 'error', msg: e.message }); log('Manual Studio: use failed', path.basename(g.game.file), e.message); throw e; }
  return result(g);
}
// the previous manual back; the one in use goes aside in its turn (so this can be undone by choosing it under Earlier)
async function undo(a) {
  const g = await gameArg(a);
  return withGame(g.key, async () => {
    const s = db(), h = s.hist[g.key] || [], last = h[h.length - 1]; if (!last) throw new Error('Nothing to undo');
    if (last.dir && !pagesIn(last.dir, g.base).length && !C.manualFiles(last.dir, g.base).length) { h.pop(); save(); throw new Error('The earlier manual isn\'t there any more.'); }
    const olds = C.manualFiles(g.dir, g.base), keep = olds.length ? spreads.backupDir(g.dir, g.base) : null, moved = [], back = [];
    const from = last.dir ? C.manualFiles(last.dir, g.base) : [];
    try {
      for (const f of olds) { C.moveFile(path.join(g.dir, f), path.join(keep, f)); moved.push(f); }
      fs.mkdirSync(g.dir, { recursive: true });
      for (const f of from) { C.moveFile(path.join(last.dir, f), path.join(g.dir, f)); back.push(f); }
    } catch (e) {
      for (const f of back) { try { C.moveFile(path.join(g.dir, f), path.join(last.dir, f)); } catch {} }
      for (const f of moved) { try { C.moveFile(path.join(keep, f), path.join(g.dir, f)); } catch {} }
      if (keep) { try { fs.rmdirSync(keep); } catch {} }
      throw new Error('Couldn\'t undo (' + (e.code || e.message) + '). Nothing was changed.');
    }
    if (keep) { try { fs.writeFileSync(path.join(keep, SIDE), JSON.stringify(curMeta(g) || { label: 'Manual from before' })); } catch {} }
    if (last.dir) { try { fs.unlinkSync(path.join(last.dir, SIDE)); } catch {} try { fs.rmdirSync(last.dir); } catch {} } // only when it's empty now
    h.pop(); if (last.cur) s.cur[g.key] = last.cur; else delete s.cur[g.key]; save(); // the lock stays as the switch has it (1.73: only the switch locks or unlocks)
    log('Manual Studio: undo', path.basename(g.game.file), from.length ? '- the earlier manual is back' : '- back to no manual');
    return result(g);
  });
}
async function lock(a) {
  const g = await gameArg(a), s = db();
  if (needObj(a).locked) s.locks[g.key] = { at: Date.now(), src: (curMeta(g) || {}).src || (currentCand(g) ? 'cur' : 'none') }; else delete s.locks[g.key];
  save(); gamesMemo.delete(g.sysId); return { locked: !!s.locks[g.key] };
}
// "My PDF…": main opens the picker (the screen never sends a path); the file is copied into a temp folder, checked there
async function own(a) {
  const g = await gameArg(a); if (!env.pickPdf) throw new Error('Not available.');
  const src = await env.pickPdf({ title: `Your own manual for ${g.game.title} (PDF)` }); if (!src) return { canceled: true };
  let st; try { st = fs.statSync(src); } catch { throw new Error('That file isn\'t there any more.'); }
  if (!st.isFile()) throw new Error('That isn\'t a file.'); if (st.size < 1024) throw new Error('That PDF is empty.'); if (st.size > MAX_PDF) throw new Error('That PDF is over 400 MB: too big for a game manual.');
  const send = useJob(g, g.game.title); send({ state: 'run', msg: 'Turning your PDF into pages…' });
  const tmp = stageDir(), copy = path.join(tmp, 'own.pdf');
  try {
    await fs.promises.copyFile(src, copy); // never moved or changed: Boxshelf works on its own copy
    if (!isPdf(copy)) throw new Error('That file isn\'t a PDF.');
    const name = path.basename(src).replace(/\.pdf$/i, '');
    const c = { key: 'own', source: 'own', pdf: copy, label: 'Your PDF · ' + name, lang: '', region: '', pages: await pdfPages(copy) };
    const cut = await withGame(g.key, async () => {
      const stage = stageDir();
      try { const t = await pdfToPages(copy, stage, g.base); if (env.crop) { try { await spreads.splitManual(stage, g.base, env.crop, { discard: true }); } catch {} }
        const r = swapIn(g, stage, curMeta(g)); remember(g, r.keep, { src: 'own', label: c.label, lang: '', region: '', expected: t.cut ? r.n : c.pages, origin: 'own' }, false); // your pick, not a lock (1.73)
        log('Manual Studio: own PDF', path.basename(g.game.file), '-', r.n, 'pages', t.cut ? '(cut at ' + PDF_CUT + ' pages)' : ''); return t.cut; }
      finally { try { fs.rmSync(stage, { recursive: true, force: true }); } catch {} }
    });
    send({ state: 'done', msg: 'Your manual is in place' + cutNote(cut) });
  } catch (e) { send({ state: 'error', msg: e.message }); throw e; }
  finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }
  return result(g);
}

// ---------- consoles and games ----------
function counts(def, sc, list) {
  let have = 0, locked = 0; const s = db();
  for (const g of list) { if ((g.art && g.art.manual && g.art.manual.length) || (g.art && g.art.manualPdf)) have++; if (s.locks[keyOf(def.id, g.file)]) locked++; }
  return { have, locked };
}
function jobOf(sysId) { const j = [...jobs.values()].find(x => x.systemId === sysId && x.state === 'run'); return j ? { jobId: j.id, label: j.label, done: j.done, total: j.total } : null; }
async function studio() {
  const out = [];
  for (const { def, sc } of env.consoles()) {
    let list = []; try { list = (await gamesFor(def.id)).list; } catch { continue; }
    if (!list.length) continue;
    out.push({ id: def.id, name: def.name, total: list.length, ...counts(def, sc, list), pref: prefFor(def.id), job: jobOf(def.id) });
  }
  return { consoles: out, prefs: PREFS };
}
async function games(a) {
  const { def, sc } = sysArg(a), list = (await gamesFor(def.id, !!a.fresh)).list, s = db();
  return list.map(g => {
    const pages = (g.art && g.art.manual) || [], pdf = g.art && g.art.manualPdf, k = keyOf(def.id, g.file), cur = s.cur[k] || null;
    const have = pages.length > 0 || !!pdf, incomplete = have && ((pages.length && pages.length <= 2) || (cur && cur.expected && pages.length && pages.length < cur.expected));
    return { file: g.file, title: g.title, cover: g.art && g.art.front ? thumbUrl(g.art.front) : null, page: pages[0] ? thumbUrl(pages[0]) : null, pages: pages.length, status: !have ? 'missing' : incomplete ? 'incomplete' : 'have', locked: !!s.locks[k], source: cur ? cur.label : '' };
  });
}

// ---------- a console's choice, and the re-pick it starts ----------
function cancel(a) { const j = jobs.get(String(needObj(a).jobId || '')); if (j && j.state === 'run') { j.cancelled = true; return true; } return false; }
async function setPref(a) {
  const { def } = sysArg(a), pref = String(a.pref || 'best'); if (!PREFS.some(p => p.id === pref)) throw new Error('Unknown choice.');
  const s = db(); if (pref === 'best') delete s.prefs[def.id]; else s.prefs[def.id] = pref; save();
  M.forgetMisses(def.id); // games that found nothing for the old choice are looked up again
  for (const j of jobs.values()) if (j.systemId === def.id && j.state === 'run') j.cancelled = true; // the newer choice wins
  const job = { id: 'mj' + (++jobN), systemId: def.id, label: def.name + ' manuals · ' + PREFS.find(p => p.id === pref).label, done: 0, total: 0, state: 'run', cancelled: false, at: Date.now() };
  jobs.set(job.id, job); repick(job, pref).catch(e => log('Manual Studio: re-pick', e.message));
  log('Manual Studio:', def.id, 'manuals now follow', pref);
  return { pref, jobId: job.id };
}
// 1.73 (the owner's rule): only the Lock switch keeps a game's manual from a new console choice. Manuals Boxshelf fetched,
// picks and your own PDF that don't give the new choice get the best copy that does (only one that does: never a swap for
// another copy that doesn't); games with none get one. Left alone: locked games, Wii U built-in manuals, manuals of unknown
// origin (added by hand, or from before Boxshelf kept a record), and a pick made after the choice changed. JOB_MAX a run,
// each old manual kept in .manual-originals.
async function repick(job, pref) {
  const send = d => env.send('manual:job', { id: job.id, systemId: job.systemId, label: job.label, done: job.done, total: job.total, state: job.state, ...d });
  let changed = 0, kept = 0;
  try {
    send({ msg: 'Looking at the games…' });
    const list = (await gamesFor(job.systemId, true)).list, todo = [];
    for (const game of list) {
      const item = env.consoles().find(x => x.def.id === job.systemId); if (!item) throw new Error('That console is gone from the shelf.');
      const g = gameRec(job.systemId, item.sc, game);
      if (isLocked(job.systemId, game.file)) continue;
      const has = (game.art && game.art.manual && game.art.manual.length) || (game.art && game.art.manualPdf), meta = curMeta(g);
      if (has && (!meta || meta.src === 'builtin')) { kept++; continue; } // unknown origin (no record: Boxshelf can't tell what it is) or the Wii U's own
      if (has && M.prefMatch(meta, pref)) continue;
      todo.push(g);
    }
    const batch = todo.slice(0, JOB_MAX); job.total = batch.length; send({ msg: batch.length ? `0 of ${batch.length}` : 'Nothing to change' });
    for (const g of batch) {
      if (job.cancelled) break; if (env.idle) await env.idle();
      let hits = []; try { hits = await M.search(g.sysId, g.game.title); } catch (e) { log('Manual Studio: re-pick search', g.game.title, e.message); }
      const best = M.prefPick(hits, pref, g.key), meta = curMeta(g);
      const has = (g.game.art && g.game.art.manual && g.game.art.manual.length) || (g.game.art && g.game.art.manualPdf);
      // a game with a manual only swaps it for a copy that gives the choice (the English fallback would just trade one copy
      // that doesn't for another); a game with none takes the fallback
      if (best && best.score >= M.AUTO_MIN && !job.cancelled && (!has || M.prefMatch(best, pref))) {
        const c = String(best.id).startsWith('gdb:') ? gdbCand(best) : iaCand(best);
        // asked again in the game's own turn: locked meanwhile, or picked by hand after the choice changed → left alone
        const skip = () => job.cancelled || isLocked(g.sysId, g.game.file) || (() => { const x = db().cur[g.key]; return isPick(x) && (x.at || 0) > job.at; })();
        if (!meta || meta.src !== c.key) { try { if (c.source === 'archive' ? await verify(c) : true) { if (await apply(g, c, { lock: false, origin: 'auto', skip })) changed++; } } catch (e) { log('Manual Studio: re-pick', g.game.title, e.message); } }
      }
      job.done++; send({ msg: `${job.done} of ${job.total}${changed ? ' · ' + changed + ' changed' : ''}` });
    }
    job.state = job.cancelled ? 'cancelled' : 'done';
    if (changed) { gamesMemo.delete(job.systemId); env.changed({ manualStudio: 1, systemId: job.systemId }); }
    send({ msg: (job.cancelled ? 'Stopped · ' : '') + `${changed} manual${changed === 1 ? '' : 's'} changed` + (kept ? ` · ${kept} built-in or added by hand kept as they are` : '') + (todo.length > JOB_MAX ? ` · ${todo.length - JOB_MAX} not looked at yet (${JOB_MAX} a run)` : '') });
  } catch (e) { job.state = 'error'; send({ msg: e.message }); }
  finally { setTimeout(() => jobs.delete(job.id), 60000).unref?.(); }
}

module.exports = { init, cacheDir, studio, games, cands, use, undo, lock, own, setPref, cancel, isLocked, picked, prefFor, chosen, PREFS, _t: { expectOf, completeness, rank, keyOf, db: () => db(), reset: () => { store = null; lists.clear(); gamesMemo.clear(); }, verify, pdfPages, collCand, iaCand, earlierCands, apply } };
