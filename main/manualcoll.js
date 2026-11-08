// Manual collections on the Internet Archive: single uploads holding hundreds of manuals for one console, scanned at
// full resolution (GameCube, PS2, PSP, Wii) or Microsoft's own digital manuals (Xbox 360, named with the title id).
// These are the sharpest manuals around, so they are used first, and they replace an existing manual when they are
// not clearly blurrier (and English). Old pages are moved to covers\.manual-originals\<game>\<time> (never deleted or overwritten), and a
// manual is never swapped for a noticeably blurrier one.
const fs = require('fs');
const path = require('path');
const { scanSystem } = require('./scanner');
const { artBase, manualDirFor: artDirFor } = require('./paths'); // manuals: their own folder in an art library
const M = require('./manuals');
const spreads = require('./spreads');

// names: how a collection's files are named. Left out: "Title (Region).pdf" (No-Intro style). 'squash': one word with the
// region at the end ("ProfessorLaytonAndTheUnwoundFutureusa.pdf"). 'loose': Nintendo's own short names
// ("Wii_Super_Smash_Brawl.pdf", "Manual_Nintendo64_MarioKart64_EN.pdf"). 'set': an arcade ROM set's name ("2020bb.pdf").
// (beta.9) every console that has a scan collection on the Internet Archive (checked 2026-11); Wii U reads its own
// e-manuals, and Switch, PS3, PS4 and PS5 games have none to collect
const HIRES = 'Nintendo-Hi-Res-Manuals-2026'; // Nintendo of America's high-resolution manuals, a folder per console
const COLLECTIONS = {
  gc: [{ id: 'NintendoGameCubeManuals' }, { id: 'GCN-GBA-manuals', folder: 'Gamecube/Game Manuals/' }, { id: HIRES, folder: 'Gamecube Games/', names: 'loose' }],
  wii: [{ id: 'wii-manuals_202508' }, { id: HIRES, folder: 'Wii Games/', names: 'loose' }],
  ps2: [{ id: 'SonyPlaystation2Manuals_201812' }, { id: 'Ps2-game-manual' }],
  psp: [{ id: 'SonyPSPManuals' }],
  x360: [{ id: 'xbox-360-marketplace-game-manuals', digital: true }, { id: 'xbox-360-manuals' }],
  psx: [{ id: 'SonyPlaystationManuals' }],
  nes: [{ id: 'NESManuals' }],
  snes: [{ id: 'SNESManuals' }],
  n64: [{ id: 'Nintendo64Manuals_201812' }, { id: HIRES, folder: 'Nintendo 64 Games/', names: 'loose' }],
  gb: [{ id: 'NintendoGameBoyManuals' }],
  gbc: [{ id: 'NintendoGameBoyColorManuals' }],
  gba: [{ id: 'NintendoGameBoyAdvanceManuals' }, { id: HIRES, folder: 'GBA Games/', names: 'loose' }],
  nds: [{ id: 'NintendoDSManuals', names: 'squash' }, { id: HIRES, folder: 'DS Games/', names: 'loose' }],
  n3ds: [{ id: 'Nintendo3DSManuals' }, { id: HIRES, folder: '3DS Games/', names: 'loose' }],
  megadrive: [{ id: 'SEGAGenesisMegaDriveManuals' }],
  mastersystem: [{ id: 'SEGAMasterSystemManuals' }],
  gamegear: [{ id: 'SEGAGameGearManuals' }],
  dreamcast: [{ id: 'SEGADreamcastManuals_201812' }],
  saturn: [{ id: 'SEGASaturnManuals_201812' }],
  segacd: [{ id: 'SEGACDManuals' }],
  sega32x: [{ id: 'SEGA32XManuals_201812' }],
  pcengine: [{ id: 'NECTurboGrafx-16Manuals' }],
  atari2600: [{ id: 'Atari2600Manuals_201812' }],
  atarilynx: [{ id: 'AtariLynxManuals_201812' }],
  neogeo: [{ id: 'SNKNeoGeoMVSManuals', names: 'set' }],
  arcade: [{ id: 'SNKNeoGeoMVSManuals', names: 'set' }]
};
const ERR_V = 1; /* (beta.9) download failures recorded before a download fix are tried again at once: bump with a fix */
const INDEX_V = 3, /* (beta.9: 3, entries carry their collection's naming) */ VERSION = 3, INDEX_DAYS = 30, MAX_GAMES = 80, PARALLEL_GAMES = 2, GAME_DEADLINE = 420000, PDF_DEADLINE = 660000, /* longer than the steps inside (scan pages; or a PDF download up to 300 s + drawing it up to 300 s), so a slow job isn't abandoned half-way every day */ MIN_READABLE = 560, MUCH_SHARPER = 2, LOW_RES = 700, PDF_DETAIL = 150000, GDB_RENDER = 2600, GDB_GAIN = 3; /* MAX_GAMES: downloads per launch; the rest follow on the next ones */
let cacheDir = null, memoFile = null, memo = null, log = () => {};
function init(opts) { cacheDir = opts.cacheDir; memoFile = opts.memoFile; if (opts.log) log = opts.log; }
function loadMemo() { if (memo) return memo; try { memo = JSON.parse(fs.readFileSync(memoFile, 'utf8')); } catch { memo = {}; } return memo; }
function saveMemo() { if (!memoFile || !memo) return; try { fs.writeFileSync(memoFile + '.tmp', JSON.stringify(memo)); fs.renameSync(memoFile + '.tmp', memoFile); } catch {} }

// "Legend of Zelda, The - The Wind Waker (USA)" -> "The Legend of Zelda - The Wind Waker"; region/version tags and the title id kept aside
function clean(stem) {
  let t = stem.replace(/_/g, ' ');
  const tags = [...t.matchAll(/\(([^)]*)\)/g)].map(m => m[1]);
  t = t.replace(/\s*[([][^)\]]*[)\]]/g, '').trim();
  t = t.replace(/^(.*?), (The|A|An)(\s+-\s+.*)?$/i, (m, a, b, c) => `${b} ${a}${c || ''}`);
  const id = tags.find(x => /^[0-9A-F]{8}$/i.test(x));
  return { title: t, tags, titleId: id ? id.toUpperCase() : null, disc: +((tags.find(x => /^disc \d/i.test(x)) || '').replace(/\D/g, '')) || 0 };
}

// ---------- (beta.9) the other ways collections name their files ----------
// region / language codes a squashed name ends with ("…Futureusa", "…Skiesusaenfres"), taken off one at a time
const CODES = ['usa', 'eur', 'europe', 'jpn', 'japan', 'aus', 'kor', 'uk', 'en', 'eng', 'fr', 'de', 'es', 'it', 'ja', 'nl', 'sv', 'da', 'no', 'fi', 'pt', 'ko', 'zh', 'ru', 'pl'];
const camel = s => String(s).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Za-z])(\d)/g, '$1 $2').replace(/(\d)([A-Za-z])/g, '$1 $2');
const squash = s => M.norm(s).replace(/\s+/g, '');
// the ways a squashed name can be read: as it is, then with one more code off its end
function squashVariants(stem) {
  let s = squash(camel(stem)); const out = [s];
  for (let i = 0; i < 6; i++) { const c = CODES.find(k => s.length > k.length + 4 && s.endsWith(k)); if (!c) break; s = s.slice(0, -c.length); out.push(s); }
  return out;
}
// Nintendo's short names: the console in front, the language and "single sheet" / "e-manual" behind, abbreviations
const LOOSE_PRE = /^(manual[-_ ]+)?((nintendo[-_ ]?)?(wii[-_ ]?u|wii|3ds|ds|64|gamecube|gcn|gc)|nintendo[-_ ]?64|n64|agb|gba|ntr|ctr|rvl)[-_ ]+/i;
const LOOSE_POST = /[-_ ]+(en|eng|english|single[-_ ]sheet|e[-_ ]?manual|manual|digital|trilingual|3ds|ds|wii|wiiu|n64)$/i;
const ABBR = { dkc: 'donkey kong country', dk: 'donkey kong', nsmbw: 'new super mario bros wii', nsmb: 'new super mario bros', smb: 'super mario bros', loz: 'legend of zelda' };
function looseName(stem) {
  let s = path.basename(stem); for (let i = 0; i < 3; i++) s = s.replace(LOOSE_PRE, ''); for (let i = 0; i < 4; i++) s = s.replace(LOOSE_POST, '');
  return camel(s).replace(/[-_]+/g, ' ').split(/\s+/).map(w => ABBR[w.toLowerCase()] || w).join(' ');
}
// words that say what a manual is for, not which game: left out on both sides of a loose comparison
const IGNORE = /^(wii|ds|nds|3ds|gba|agb|n64|nintendo|gamecube|manual|edition|special|collectors|collection|version|eng|en|control|new)$/; /* ("New Play Control! Pikmin" = "Play_Control_Pikmin") */
const sig = s => { const out = new Set(); for (const w of M.words(s)) for (const x of (ABBR[w] || w).split(' ')) if (x && !IGNORE.test(x)) out.add(x); return out; };
// every word of the file's name is in the game's name, they cover most of it, and the numbers agree
function looseMatch(E, G) {
  if (!E.size || !G.size) return false;
  for (const w of E) if (!G.has(w) && !G.has(w + 's') && !(w.endsWith('s') && G.has(w.slice(0, -1)))) return false;
  const nums = S => [...S].filter(w => /^\d+$/.test(w)).sort().join(','); if (nums(E) !== nums(G)) return false;
  return (E.size >= 2 || E.size === G.size) && E.size / G.size >= .75;
}
// not a game's manual: the console's own booklets, safety leaflets, accessories
const HARDWARE = /operations? manual|health and safety|precautions|wi-?fi|circle pad|usb connector|ar booklet|browser|agbvideo|hardware/i;

// what an entry is matched on, besides its cleaned title: by naming (see COLLECTIONS)
function entryKeys(stem, mode) {
  if (mode === 'squash') return { sq: squashVariants(path.basename(stem)) };
  if (mode === 'loose') { const title = looseName(stem); return { title, sq: [squash(title), squash(path.basename(stem).replace(LOOSE_PRE, '').replace(LOOSE_POST, ''))] }; }
  if (mode === 'set') return { set: path.basename(stem).toLowerCase() };
  return {};
}
async function index(col) {
  const f = path.join(cacheDir, `ia-${col.id}${col.folder ? '-' + col.folder.replace(/[^a-z0-9]+/gi, '_') : ''}.json`); // (one per folder: a collection can serve several consoles)
  try { const c = JSON.parse(fs.readFileSync(f, 'utf8')); if (c.v === INDEX_V && Date.now() - c.at < INDEX_DAYS * 864e5) return c; } catch {}
  const m = await M.getJson(`https://archive.org/metadata/${encodeURIComponent(col.id)}`);
  const files = m.files || [], names = new Set(files.map(x => x.name));
  const mode = col.names || '';
  const entries = files.filter(x => /\.pdf$/i.test(x.name) && !/_text\.pdf$/i.test(x.name) && (!col.folder || x.name.startsWith(col.folder)) && !(mode && HARDWARE.test(x.name))).map(x => {
    const stem = x.name.replace(/\.pdf$/i, ''), c = clean(path.basename(stem).replace(/^(GCN|AGB)_/, ''));
    return Object.assign({ name: x.name, stem, title: c.title, titleId: c.titleId, tags: c.tags, disc: c.disc, jp2: names.has(stem + '_jp2.zip'), size: +x.size || 0, mode,
      digital: /digital|e-?manual/i.test(x.name) }, entryKeys(stem, mode)); // (a digital manual's screens are never cut in two)
  });
  const out = { v: INDEX_V, at: Date.now(), id: col.id, server: m.server || m.d1 || '', alt: m.d2 || '', dir: m.dir || '', entries };
  try { fs.mkdirSync(cacheDir, { recursive: true }); fs.writeFileSync(f, JSON.stringify(out)); } catch {}
  return out;
}

// the best entry for a game, or null. Exact title id (Xbox 360), else the same name after cleaning, else a very close one
// publisher / licence prefixes dumps carry and collections don't ("Nickelodeon SpongeBob…", "Disney-Pixar The Incredibles")
const BRAND = /^(disney s|disneys|disney pixar|disney|pixar|nickelodeon|nick|mtv|cartoon network|dreamworks|marvel|lego)\s+/;
const unbrand = x => { let y = x; for (let i = 0; i < 2; i++) y = y.replace(BRAND, ''); return y.replace(/\band\b/g, ' ').replace(/\s+/g, ' ').trim(); }; /* 'and' dropped too: "Ocarina of Time & Master Quest" = "Ocarina of Time - Master Quest" */
function pick(entries, g) { const h = matches(entries, g); return h.length ? h[0] : null; }
// every entry that is this game, best first (Manual Studio shows them all: other regions, other discs)
// (beta.9) an entry for one region only, and not one an English player reads (Japan, France…): only for a game of that region
const EN_TAG = /^(USA|Europe|World|Australia|Canada|UK|U|E)\b|USA|Europe|\bEn\b/i, OTHER_TAG = /Japan|France|Germany|Spain|Italy|Korea|China|Brazil|Netherlands|Sweden|Asia|Taiwan/i;
function regionOk(e, g) {
  const tags = e.tags || []; if (!tags.some(t => OTHER_TAG.test(t)) || tags.some(t => EN_TAG.test(t))) return true;
  const r = String(g.region || '').toLowerCase().split(/[ ,]+/).filter(Boolean); return r.some(x => tags.some(t => t.toLowerCase().includes(x)));
}
function matches(entries, g) {
  const want = unbrand(M.norm(clean(g.title).title)), tid = g.titleId ? String(g.titleId).toUpperCase() : null;
  const rank = e => (e.tags.some(t => /^USA\b|^U$|EN-US|^World/i.test(t)) ? 2 : e.tags.some(t => /Europe|^E$/i.test(t)) ? 1 : 0) - (e.tags.some(t => /^v\d/i.test(t)) ? .1 : 0) - (e.disc > 1 ? .5 : 0)
    + (e.digital ? .3 : 0) - (/single sheet/i.test(e.name) ? .3 : 0); // (3DS: the digital manual is the whole one, the sheet a leaflet)
  // (beta.9) arcade sets: the zip's own name is the set ("2020bb.zip")
  if (entries.length && entries[0].mode === 'set') { const set = path.basename(String(g.file || ''), path.extname(String(g.file || ''))).toLowerCase(); return set ? entries.filter(e => e.set === set) : []; }
  let hits = tid ? entries.filter(e => e.titleId === tid) : [];
  // each entry's cleaned title and words are worked out once and kept on it (this ran for every game against every
  // entry and held the main process up for a second or more on big collections)
  if (!hits.length) hits = entries.filter(e => (e._u == null ? (e._u = unbrand(M.norm(e.title))) : e._u) === want);
  // (beta.9) the same name with the spaces and punctuation taken out ("Super Mario All-Stars" = "supermarioallstars"),
  // and for squashed names, with their region codes taken off
  if (!hits.length) { const q = squash(clean(g.title).title), qu = want.replace(/\s+/g, '');
    hits = entries.filter(e => (e.sq || e._sq || (e._sq = [squash(e.title)])).some(v => v.length >= 5 && (v === q || v === qu))); }
  // (beta.9) Nintendo's short names: every word of the file's name in the game's, most of the game's covered, same numbers
  if (!hits.length && entries.some(e => e.mode === 'loose')) { const G = sig(g.title); hits = entries.filter(e => e.mode === 'loose' && looseMatch(e._lw || (e._lw = sig(e.title)), G)); }
  if (hits.length) return hits.filter(e => regionOk(e, g)).sort((a, b) => rank(b) - rank(a));
  if (want.length > 3) {
    const A = M.words(g.title);
    hits = entries.filter(e => {
      const B = e._w || (e._w = M.words(e.title)); if (!A.size || !B.size) return false;
      let hit = 0; for (const w of A) if (B.has(w)) hit++;
      if (hit / A.size < .95 || hit / B.size < .95) return false; // can't reach .95 either way: skip the full comparison (same result, far cheaper)
      return M.similarity(g.title, e.title) >= .95 && M.similarity(e.title, g.title) >= .95;
    });
  }
  return hits.filter(e => regionOk(e, g)).sort((a, b) => rank(b) - rank(a));
}

// page images of a scan, in order: [{ full, half }]. `full` comes from the item's page server at full resolution;
// `half` is archive.org's own JPEG link, which turned out to be half size (kept only as a fallback)
const MAX_SCANS = 240;
// (beta.9) a file in a folder of the collection ("Wii Games/Wii_Mario_Kart"): each part of its path is encoded on its
// own (the "/" stays a "/"), and inside its _jp2.zip the pages sit under the file's own name, without the folder.
// Encoded whole, every page address was wrong: "only 0 of 26 pages came down".
const encPath = p => String(p).split('/').map(encodeURIComponent).join('/');
async function jp2Pages(col, ix, e) {
  const inZip = path.posix.basename(e.stem);
  const zip = `https://archive.org/download/${encodeURIComponent(col.id)}/${encPath(e.stem + '_jp2.zip')}/`;
  const html = await M.getText(zip);
  const inner = [...new Set([...html.matchAll(/_jp2(?:%2F|\/)([^"&]+?_(\d{4})\.jp2)/g)].map(m => decodeURIComponent(m[1])))]
    .sort((a, b) => +(/_(\d{4})\.jp2$/.exec(a) || [0, 0])[1] - +(/_(\d{4})\.jp2$/.exec(b) || [0, 0])[1]);
  // (cut at 80 pages, a long RPG booklet was saved without its last pages and still recorded as the full copy: never
  // fetched again. Anything this long is far more than any game manual: not taken at all.)
  if (inner.length > MAX_SCANS) throw new Error(`${inner.length} page scans: more than a manual has`);
  return inner.map(f => {
    const path_ = `${inZip}_jp2/${f}`;
    const full = ix.server && ix.dir ? `https://${ix.server}/BookReader/BookReaderImages.php?zip=${encodeURIComponent(ix.dir + '/' + e.stem + '_jp2.zip')}&file=${encodeURIComponent(path_)}&id=${encodeURIComponent(col.id)}&scale=1&rotate=0` : null;
    const half = `https://archive.org/download/${encodeURIComponent(col.id)}/${encPath(e.stem + '_jp2.zip')}/${encodeURIComponent(path_)}&ext=jpg`;
    return { full, half };
  });
}

// Download one matched manual into `stage` as <base>-manual-NN.jpg. Returns the page count.
async function fetchTo(col, ix, e, stage, base, opts) {
  if (!col.digital && e.jp2) {
    const urls = await jp2Pages(col, ix, e); if (!urls.length) throw new Error('no page images listed');
    let ok = 0;
    await M.pool(urls.map((u, i) => ({ u, i })), 4, async ({ u, i }) => {
      if (opts.cancelled && opts.cancelled()) return;
      const dest = path.join(stage, `${base}-manual-${String(i + 1).padStart(2, '0')}.jpg`);
      let got = false;
      if (u.full) { try { got = await M.getFile(u.full, dest, 0, { stall: 20000, deadline: 60000 }); } catch {} }
      if (!got) { try { got = await M.getFile(u.half, dest, 0, { stall: 20000, deadline: 60000 }); } catch {} }
      if (got) ok++;
    });
    if (ok !== urls.length) throw new Error(`only ${ok} of ${urls.length} pages came down`);
    return ok;
  }
  // digital manuals (and scans without page images): the PDF itself, drawn into pages by the app
  if (!opts.renderPdf) throw new Error('no PDF renderer');
  const pdf = path.join(stage, `${base}.pdf`);
  if (!await M.getFile(`https://archive.org/download/${encodeURIComponent(col.id)}/${e.name.split('/').map(encodeURIComponent).join('/')}`, pdf, 0, { stall: 30000, deadline: 300000 })) throw new Error('PDF download failed');
  if (opts.cancelled && opts.cancelled()) throw new Error('stopped'); // given up on (deadline) while downloading: don't draw it
  const pages = await opts.renderPdf(pdf); try { fs.unlinkSync(pdf); } catch {}
  const n = await M.writePages(stage, base, pages);
  if (!n) throw new Error('the PDF could not be turned into pages');
  return n;
}

const manualFiles = (dir, base, ls) => { const pre = (base + '-manual').toLowerCase(); return (ls || require('./dircache').fresh).names(dir).filter(f => M.isManualFile(f, pre)); }; // (not a .part)
function moveFile(a, b) { try { fs.renameSync(a, b); } catch { fs.copyFileSync(a, b); fs.unlinkSync(a); } }

// systems: [{def, cfg}]. opts: { renderPdf(pdfPath) -> [dataURL], crop(file, side) -> Buffer, cancelled() }
// a manual's pages as Boxshelf sees them: how many are real pages, how sharp they are, whether some are junk
function inspect(dir, base) {
  const files = manualFiles(dir, base).filter(f => !/\.pdf$/i.test(f));
  const w = files.map(f => (spreads.sizeOf(path.join(dir, f)) || [0])[0]);
  const real = w.filter(x => x >= 300).sort((a, b) => a - b);
  return { files, count: real.length, junk: w.length - real.length, width: real.length ? real[real.length >> 1] : 0 };
}
// a job that runs past its time is told to stop (tok.dead) so it can't write files after it was given up on
const withDeadline = (p, ms, what, tok) => { let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => { if (tok) tok.dead = true; rej(new Error(what + ' took too long')); }, ms); })]).finally(() => clearTimeout(t)); };

// A few collection scans are small (SpongeBob: about 490px a page against 1230 for most). GamesDatabase keeps one PDF
// per game for the same console, usually scanned far larger: fetch it and use it when it really holds more detail.
// (pixel width can't tell for a PDF, it is drawn at any size: its bytes per page can)
const stripBrand = t => { let y = t; for (let i = 0; i < 2; i++) y = y.replace(/^(disney'?s?|disney[- ]pixar|pixar|nickelodeon|nick|mtv|cartoon network|dreamworks|marvel)\s+/i, ''); return y; };
async function sharperPdf(def, g, base, collCount, opts, collBytesPerScan) {
  if (!opts.renderPdf || !M.searchGamesDatabase) return null;
  const t = clean(g.title).title, tries = [...new Set([t, stripBrand(t)])];
  let hit = null; for (const x of tries) { try { hit = await M.searchGamesDatabase(def.id, x); } catch {} if (hit) break; }
  if (!hit) return null;
  const stage = fs.mkdtempSync(path.join(require('os').tmpdir(), 'boxshelf-manual-gdb-')), pdf = path.join(stage, base + '.pdf');
  let keep = false;
  try {
    if (!await M.getFile(hit.id.slice(4), pdf, 0, { stall: 30000, deadline: 150000 })) return null;
    const bytes = fs.statSync(pdf).size;
    if (opts.cancelled && opts.cancelled()) return null;
    const pages = await opts.renderPdf(pdf, GDB_RENDER); try { fs.unlinkSync(pdf); } catch {}
    const n = await M.writePages(stage, base, pages);
    // a PDF is drawn at any size, so its detail is judged by bytes per page against the collection's own PDF
    const per = bytes / Math.max(n, 1), why = !n ? 'no pages' : per < PDF_DETAIL ? 'little detail' : collBytesPerScan && per < collBytesPerScan * GDB_GAIN ? 'not much sharper' : '';
    if (!why && opts.crop) await spreads.splitManual(stage, base, opts.crop, { scan: true, discard: true });
    const cnt = why ? 0 : inspect(stage, base).count; // pages after cutting spreads, like the collection count
    if (why || cnt < Math.max(2, collCount * .6)) { log('Manual collections:', path.basename(g.file), 'GamesDatabase copy not better (', why || `${cnt} of ${collCount} pages`, ',', Math.round(per / 1024), 'KB a page)'); return null; }
    keep = true; return { stage, src: hit.id.slice(4), n, bytes };
  } catch (e) { log('Manual collections:', path.basename(g.file), 'GamesDatabase copy failed:', e.message); return null; }
  finally { if (!keep) { try { fs.rmSync(stage, { recursive: true, force: true }); } catch {} } }
}

async function one(def, cfg, g, hit, m, key, opts, changes) {
  const dir = artDirFor(cfg, g.file), base = artBase(g.file), old = inspect(dir, base), seen = m[key] || {};
  const ours = !!(seen.src && old.files.length); // the manual there is this module's earlier (half-resolution) copy
  let stage = fs.mkdtempSync(path.join(require('os').tmpdir(), 'boxshelf-manual-'));
  try {
    let n = await fetchTo(hit.col, hit.ix, hit.e, stage, base, opts);
    if (opts.crop && !hit.e.digital) await spreads.splitManual(stage, base, opts.crop, { scan: !hit.col.digital, discard: true }); // (beta.9: a digital manual's screens stay whole)
    if (M.shrinkPages) await M.shrinkPages(stage, base); // (beta.9: high-resolution scans made no wider than the reader needs)
    if (opts.cancelled && opts.cancelled()) throw new Error('stopped');
    let altTried = false, neu = inspect(stage, base), src = hit.col.id + '/' + hit.e.name, from = hit.col.id + ' ' + hit.e.name;
    // a small scan: see whether GamesDatabase has a sharper one for the same console
    if (!hit.col.digital && neu.width < LOW_RES) {
      const alt = await sharperPdf(def, g, base, neu.count, opts, hit.e.size && n ? hit.e.size / n : 0);
      altTried = true;
      if (opts.cancelled && opts.cancelled()) throw new Error('stopped'); // past its deadline: the memo isn't this job's any more
      if (!alt && ours && seen.w >= neu.width) { m[key] = Object.assign({}, seen, { altTried: true, at: Date.now() }); log('Manual collections:', path.basename(g.file), 'no sharper copy than the collection scan (', neu.width, 'px)'); return false; }
      if (alt) {
        try { fs.rmSync(stage, { recursive: true, force: true }); } catch {}
        stage = alt.stage; n = alt.n; neu = inspect(stage, base); src = 'gdb/' + alt.src; from = 'GamesDatabase ' + decodeURIComponent(path.basename(alt.src));
      }
    }
    if (neu.width < MIN_READABLE && !ours && old.count) throw new Error(`the collection copy is too blurry to read (${neu.width}px)`);
    // English first: the collection copy (an English, North American edition) replaces a manual of unknown origin when
    // it is readable; an old manual is kept only when it is complete, has no junk pages and is more than twice as sharp
    const incomplete = old.junk > 0 || old.count < Math.max(2, neu.count * .6);
    if (old.count && !ours && !incomplete && old.width > neu.width * MUCH_SHARPER && !opts.force) { // (opts.force: Repair asked for this copy)
      if (opts.cancelled && opts.cancelled()) throw new Error('stopped');
      m[key] = { v: VERSION, at: Date.now(), kept: old.width, offered: neu.width };
      log('Manual collections:', path.basename(g.file), 'kept the current manual (', old.width, 'px,', old.count, 'pages) over', hit.e.name, '(', neu.width, 'px,', neu.count, 'pages)');
      return false;
    }
    const pages = fs.readdirSync(stage).filter(f => /-manual-\d+\.(jpe?g|png)$/i.test(f)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    // last look before anything in the library moves: a job given up on (tok.dead, past its deadline) must not touch it.
    // From here to the end there is no await, so the deadline can't land halfway through the moves.
    if (opts.cancelled && opts.cancelled()) throw new Error('stopped');
    fs.mkdirSync(dir, { recursive: true });
    // Current pages always go to their own .manual-originals\<game>\<time>\, even when the memo says they are our earlier
    // copy (the memo can be wrong, and the user may have swapped files since); an older backup is never overwritten.
    // A failed move puts everything back, so the game never ends up with half a manual.
    const olds = manualFiles(dir, base), keep = olds.length ? spreads.backupDir(dir, base) : null, moved = [], placed = [];
    try {
      for (const f of olds) { moveFile(path.join(dir, f), path.join(keep, f)); moved.push(f); }
      pages.forEach((f, i) => { const d = path.join(dir, `${base}-manual-${String(i + 1).padStart(2, '0')}${path.extname(f).toLowerCase()}`); moveFile(path.join(stage, f), d); placed.push(d); });
    } catch (e) {
      for (const d of placed) { try { fs.unlinkSync(d); } catch {} }
      for (const f of moved) { try { moveFile(path.join(keep, f), path.join(dir, f)); } catch {} }
      if (keep) { try { fs.rmdirSync(keep); } catch {} } // only when everything went back
      throw new Error('could not put the new manual in place (' + e.message + '), the old one was kept');
    }
    const prevW = ours ? (seen.oldW || 0) : old.width;
    m[key] = { v: VERSION, at: Date.now(), src, altTried, render: src.startsWith('gdb/') ? GDB_RENDER : undefined, w: neu.width, oldW: (ours ? seen.oldW : old.count) ? prevW : 0, pages: pages.length, title: g.title, system: def.name };
    if (!ours || src.startsWith('gdb/')) changes.push({ title: g.title, upgraded: !!old.count });
    log('Manual collections:', path.basename(g.file), src.startsWith('gdb/') ? `swapped a small scan for a sharper one (${old.width}px -> ${neu.width}px)` : ours ? `re-downloaded at full resolution (${old.width}px -> ${neu.width}px)` : !old.count ? 'added' : incomplete ? `replaced an incomplete manual (${old.count} pages${old.junk ? ', ' + old.junk + ' blank' : ''})` : neu.width >= old.width ? `upgraded (${old.width}px -> ${neu.width}px)` : `swapped for the English edition (${old.width}px -> ${neu.width}px)`,
      'from', from, '-', pages.length, 'pages', n !== pages.length ? `(${n} scans, spreads split)` : '');
    return true;
  } finally { try { fs.rmSync(stage, { recursive: true, force: true }); } catch {} }
}

// systems: [{def, cfg}]. opts: { renderPdf(pdfPath) -> [dataURL], crop(file, side) -> Promise<Buffer>, cancelled(), report: [] }
async function run(systems, opts = {}) {
  const m = loadMemo(), t0 = Date.now(); let done = 0; const changes = [], jobs = [], ls = require('./dircache').lister();
  for (const { def, cfg } of systems) {
    const cols = COLLECTIONS[def.id]; if (!cols) continue;
    if (opts.skipSystem && opts.skipSystem(def)) continue; // Manual Studio: a console set to another language / region (the collections are English, North American)
    await new Promise(r => setImmediate(r)); // (beta.9: a breath between consoles)
    let games = []; try { games = scanSystem(def, cfg).filter(g => !g.extra); } catch { continue; }
    const idx = [];
    for (const col of cols) { try { idx.push({ col, ix: await index(col) }); } catch (e) { log('Manual collections:', col.id, 'unavailable', e.message); } }
    if (!idx.length) continue;
    let nG = 0;
    for (const g of games) {
      if (++nG % 8 === 0) await new Promise(r => setImmediate(r)); // let the app breathe between games
      const key = def.id + '|' + g.file.toLowerCase(), seen = m[key];
      if (opts.locked && opts.locked(def.id, g.file)) continue; // Manual Studio: chosen by hand, never swapped
      if (seen && seen.err && seen.ev === ERR_V && Date.now() - seen.at < 864e5) continue; // failed lately: tomorrow (a failure from before a download fix: now)
      if (seen && seen.err && seen.ev === ERR_V && seen.failV === VERSION && (seen.fails || 0) >= 3) continue; // failed three times (a page that never comes down): given up until an update
      if (seen && seen.src && seen.v >= VERSION && !(seen.w && seen.w < LOW_RES && !seen.altTried) && !(seen.src.startsWith('gdb/') && (seen.render || 0) < GDB_RENDER)) continue; // already holds the full-resolution collection copy (a small scan gets one look for a sharper copy)
      if (seen && !seen.src && seen.v === VERSION && (seen.err || seen.ix === INDEX_V) && Date.now() - seen.at < (seen.err ? 864e5 : INDEX_DAYS * 864e5)) continue; // (beta.9: a "none" from before the new collections looks again)
      let hit = null; for (const { col, ix } of idx) { const e = pick(ix.entries, g); if (e && !M.isRejected(key, 'coll:' + col.id + '/' + e.name)) { hit = { col, ix, e }; break; } } // never a copy the user marked as the wrong manual
      if (!hit) { m[key] = { v: VERSION, at: Date.now(), none: true, ix: INDEX_V }; continue; }
      const has = manualFiles(artDirFor(cfg, g.file), artBase(g.file), ls).length > 0; // (ls: one listing per folder for this pass)
      jobs.push({ def, cfg, g, hit, key, prio: !has ? 0 : seen && seen.src ? 2 : 1 }); // missing first, then upgrades, then re-downloads
    }
  }
  jobs.sort((a, b) => a.prio - b.prio);
  const batch = jobs.slice(0, MAX_GAMES);
  if (batch.length) log('Manual collections:', batch.length, 'to do', jobs.length > batch.length ? `(${jobs.length - batch.length} more next time)` : '');
  await M.pool(batch, PARALLEL_GAMES, async j => {
    if (opts.idle) await opts.idle(); // never while a game is running: downloads and page drawing would take CPU from it
    if (opts.cancelled && opts.cancelled()) return;
    const tok = { dead: false }, o2 = Object.assign({}, opts, { cancelled: () => tok.dead || !!(opts.cancelled && opts.cancelled()) });
    try { if (await withDeadline(one(j.def, j.cfg, j.g, j.hit, m, j.key, o2, changes), j.hit.col.digital ? PDF_DEADLINE : GAME_DEADLINE, 'downloading', tok)) done++; }
    catch (e) { const seen = m[j.key] || {}; m[j.key] = Object.assign({}, seen.src ? seen : {}, { v: seen.src ? seen.v : VERSION, at: Date.now(), err: e.message, ev: ERR_V, fails: (seen.err && seen.failV === VERSION && seen.ev === ERR_V ? seen.fails || 1 : 0) + (e.message === 'stopped' ? 0 : 1), failV: VERSION }); log('Manual collections:', path.basename(j.g.file), j.hit.e.name, 'failed:', e.message); }
    saveMemo();
  });
  saveMemo();
  if (batch.length) log('Manual collections: finished', done, 'of', batch.length, 'in', Math.round((Date.now() - t0) / 1000), 's');
  if (opts.report) opts.report.push(...changes);
  return done;
}
// (beta.9) one game, now (Wrong game / Repair): the best collection copy that isn't one the user rejected (or opts.skipSrc,
// the copy already there), downloaded and put in place. { got: pages, from } or null when no collection has it.
async function fetchFor(def, cfg, g, opts = {}) {
  const cols = COLLECTIONS[def.id]; if (!cols) return null;
  const m = loadMemo(), key = def.id + '|' + g.file.toLowerCase();
  for (const col of cols) {
    let ix; try { ix = await index(col); } catch (e) { log('Manual collections:', col.id, 'unavailable', e.message); continue; }
    const e = matches(ix.entries, g).find(x => { const id = col.id + '/' + x.name; return id !== opts.skipSrc && !M.isRejected(key, 'coll:' + id); });
    if (!e) continue;
    const tok = { dead: false }, o2 = Object.assign({}, opts, { cancelled: () => tok.dead }), changes = [];
    try {
      const ok = await withDeadline(one(def, cfg, g, { col, ix, e }, m, key, o2, changes), col.digital ? PDF_DEADLINE : GAME_DEADLINE, 'downloading', tok);
      saveMemo(); if (ok) return { got: inspect(artDirFor(cfg, g.file), artBase(g.file)).count || 1, from: col.id + ' · ' + path.posix.basename(e.name) };
    } catch (err) { saveMemo(); log('Manual collections:', path.basename(g.file), e.name, 'failed:', err.message); }
  }
  return null;
}
// "wrong manual": forget this game's collection copy (and say which it was) so the next look starts fresh
const info = key => loadMemo()[key] || null; // what the collections did for a game ({src} when its manual came from one)
function forget(key) { const m = loadMemo(), seen = m[key]; const src = seen && seen.src || null; if (src) m[key] = { v: VERSION, at: Date.now(), none: true, rejected: true }; else delete m[key]; saveMemo(); return src; } /* not ours: leave the collections free to offer one */
// what the collections changed lately, newest first (Settings shows it)
function recent(limit = 30) {
  const m = loadMemo();
  return Object.values(m).filter(x => x && x.src && x.title).sort((a, b) => b.at - a.at).slice(0, limit)
    .map(x => ({ title: x.title, system: x.system || '', at: x.at, upgraded: !!x.oldW, oldW: x.oldW || 0, w: x.w || 0, pages: x.pages || 0, source: x.src.startsWith('gdb/') ? 'GamesDatabase' : x.src.split('/')[0] }));
}

module.exports = { fetchFor, init, run, recent, forget, pick, matches, info, inspect, manualFiles, moveFile, fetchTo, jp2Pages, clean, index, COLLECTIONS, _entryKeys: entryKeys };
