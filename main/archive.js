// "Find magazines & guides": search the Internet Archive (archive.org) for scanned magazines and strategy guides and
// download the ones it offers freely into your Magazines\ or Guides\ folder. Lending-library (borrow-only) items are
// left out of the results and refused on download.
// Everything that goes wrong is logged (the finder used to fail silently, so the log showed nothing to go on), and a busy
// archive.org (429 / 503, a dropped connection) is waited out and retried instead of being read as "not downloadable".
const fs = require('fs');
const path = require('path');
const M = require('./manuals'); // its HTTP helpers: per-host limits, timeouts, redirects
const library = require('./library');

let log = () => {};
function init(logger) { if (logger) log = logger; }

// ---------- retries: archive.org asks clients to slow down with 429 / 503 (+ Retry-After) ----------
// one shared "quiet until" for searches, checks and downloads, so a burst of checks doesn't keep hammering a busy server
let slowUntil = 0, RETRY_MS = 1000;
const cancelErr = () => Object.assign(new Error('Cancelled.'), { cancelled: true });
const sleep = (ms, signal) => new Promise((res, rej) => {
  if (signal && signal.aborted) return rej(cancelErr());
  const t = setTimeout(() => { if (signal) signal.removeEventListener('abort', stop); res(); }, ms);
  const stop = () => { clearTimeout(t); rej(cancelErr()); };
  if (signal) signal.addEventListener('abort', stop, { once: true });
});
// worth another go: no answer at all, a timeout, bad JSON, "too many requests", or the server having a bad moment
const transient = e => !e || !e.status || e.status === 408 || e.status === 429 || e.status >= 500;
const busyErr = e => !!e && (e.status === 429 || e.status === 503);
async function getJsonRetry(url, what, tries = 4, signal) {
  let last;
  for (let t = 0; t < tries; t++) {
    const quiet = slowUntil - Date.now(); if (quiet > 0) await sleep(Math.min(quiet, 60000), signal);
    if (signal && signal.aborted) throw cancelErr();
    try { return await M.getJson(url); }
    catch (e) {
      last = e; if (!transient(e) || t === tries - 1) break;
      let wait = Math.min(20000, RETRY_MS * 2 ** t) + Math.floor(Math.random() * RETRY_MS * .3);
      if (busyErr(e)) { wait = Math.max(wait, e.retryAfter > 0 ? Math.min(60, e.retryAfter) * 1000 : wait); slowUntil = Math.max(slowUntil, Date.now() + wait); }
      log('Archive', what, 'retrying in', (wait / 1000).toFixed(1), 's:', e.message);
      await sleep(wait, signal);
    }
  }
  throw last;
}

// ---------- the search ----------
// your words in the title, scanned books/magazines only, nothing that's borrow-only
const RESTRICT = 'mediatype:texts AND NOT access-restricted-item:true AND NOT collection:(inlibrary OR printdisabled OR lendinglibrary)';
const clean = s => String(s || '').replace(/[^\p{L}\p{N}\s'&-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
const fold = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '');
// Each typed word becomes one search term. "&", lone symbols and the words AND / OR / NOT / TO are not searched for (they'd
// be read as search operators: "Mario & Luigi" or "EGM 1 OR 2" used to come back empty); a word with a hyphen or an
// apostrophe is quoted (Spider-Man, Assassin's); an accented word also matches without its accents (Pokémon / Pokemon).
function terms(text) {
  const words = String(text || '').replace(/&/g, ' ').replace(/[^\p{L}\p{N}\s'’-]/gu, ' ').replace(/’/g, "'").split(/\s+/)
    .map(w => w.replace(/^[-']+|[-']+$/g, '')).filter(w => w && /[\p{L}\p{N}]/u.test(w) && !/^(and|or|not|to)$/i.test(w));
  return words.slice(0, 12).map(w => { const q = x => /[-']/.test(x) ? `"${x}"` : x, f = fold(w); return f !== w && f ? `${q(f)} OR ${q(w)}` : q(w); });
}
// nudges, not hard filters (a search that finds nothing with them is run again without): guides usually say "guide"
// somewhere; magazines are tagged as one or sit in a magazine collection (so "Zelda" under Magazines isn't all manuals)
const GUIDE_HINT = ' AND (title:(guide) OR subject:(guide) OR subject:(strategy) OR subject:(walkthrough))';
const MAG_HINT = ' AND (subject:(magazine OR magazines OR periodical OR periodicals) OR collection:(magazine_rack OR gamemagazines OR videogamemagazines OR computermagazines) OR title:(magazine OR issue))';
function query(text, kind, plain) {
  const t = terms(text); if (!t.length) throw new Error('Type what to look for.');
  const title = t.map(w => `title:(${w})`).join(' AND ');
  const hint = plain ? '' : kind === 'guide' ? GUIDE_HINT : kind === 'magazine' ? MAG_HINT : '';
  return `(${title})${hint} AND ${RESTRICT}`;
}
const ROWS = 36;
const searchUrl = (q, p) => `https://archive.org/advancedsearch.php?q=${encodeURIComponent(q)}&fl[]=identifier&fl[]=title&fl[]=date&fl[]=year&fl[]=imagecount&fl[]=downloads&sort[]=${encodeURIComponent('downloads desc')}&rows=${ROWS}&page=${p}&output=json`;
async function runSearch(q, p, text) {
  let r;
  try { r = await getJsonRetry(searchUrl(q, p), 'search'); }
  catch (e) { log('Archive search failed', JSON.stringify(text), 'page', p, e.message); throw new Error(busyErr(e) ? 'archive.org is busy right now. Try again in a minute.' : `archive.org didn't answer (${e.message}).`); }
  if (!r || !r.response) { log('Archive search: no results block', JSON.stringify(text), r && r.error ? String(r.error).slice(0, 200) : ''); throw new Error('archive.org couldn\'t run that search. Try other words.'); }
  return { docs: r.response.docs || [], total: +r.response.numFound || 0 };
}
// plain: the words alone, without the magazine / guide nudge (the first page told the screen it found nothing with it)
async function search(text, kind, page = 1, plain = false) {
  const p = Math.max(1, Math.min(20, page | 0));
  let used = !!plain, r = await runSearch(query(text, kind, used), p, text);
  if (!r.docs.length && !used && p === 1) { used = true; r = await runSearch(query(text, kind, true), p, text); }
  log('Archive search', JSON.stringify(String(text).slice(0, 80)), kind, 'page', p, used ? '(words only)' : '', '→', r.docs.length, 'of', r.total);
  return {
    total: r.total, page: p, plain: used, rows: ROWS,
    items: r.docs.filter(d => d && /^[A-Za-z0-9._-]{1,100}$/.test(d.identifier || '')).map(d => ({
      id: d.identifier, title: String(Array.isArray(d.title) ? d.title[0] : d.title || d.identifier).slice(0, 200),
      date: String(d.date || d.year || '').slice(0, 10), pages: +d.imagecount || 0, downloads: +d.downloads || 0,
      thumb: `https://archive.org/services/img/${encodeURIComponent(d.identifier)}`, page: `https://archive.org/details/${encodeURIComponent(d.identifier)}`,
    })),
  };
}

// ---------- what to take from an item ----------
// best first: the uploader's own PDF(s) (several big ones = a bundle of issues); a comic archive or a zip of page images;
// loose page images; the archive's page scans (sharper than the "Text PDF" it derives, which is heavily compressed);
// that derived PDF last
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
const isOrig = f => /original/.test(f.source || '');
const MAX_PAGES = 800;
function plan(meta) {
  const files = (meta.files || []).filter(f => f && typeof f.name === 'string' && f.private !== 'true' && !f.name.split('/').some(p => p === '..' || p === '' || p === '.'));
  const pdfs = files.filter(f => /\.pdf$/i.test(f.name) && !/_text\.pdf$/i.test(f.name) && !/encrypted/i.test(f.format || ''));
  const orig = pdfs.filter(isOrig);
  // several original PDFs, each a real issue (not a tiny insert): a bundle
  const big = orig.filter(f => +f.size > 2e6);
  if (big.length >= 2) return { type: 'bundle', files: big.sort((a, b) => natural(a.name, b.name)).slice(0, 150) };
  pdfs.sort((a, b) => (isOrig(a) ? 0 : 1) - (isOrig(b) ? 0 : 1) || (+b.size || 0) - (+a.size || 0));
  // comic archives always; a plain zip / rar / 7z only as the uploader's own file (the archive's own *_jp2.zip etc. are not readable pages)
  const arch = files.filter(f => /\.(cbz|cbr|cb7)$/i.test(f.name) || (isOrig(f) && /\.(zip|rar|7z)$/i.test(f.name) && !/_(jp2|tif|tiff|raw|orig_jp2|jpg|png|images|djvu|hocr|chocr)\.(zip|rar|7z)$/i.test(f.name) && +f.size > 1e6));
  if (orig.length) return { type: 'file', files: [...orig, ...arch, ...pdfs.filter(f => !isOrig(f))].slice(0, 4) }; // the best first; the next ones if a file is missing on the server
  if (arch.length) return { type: 'file', files: [...arch, ...pdfs].slice(0, 4) };
  const imgs = files.filter(f => isOrig(f) && /\.(jpe?g|png|webp|gif)$/i.test(f.name) && !/(^|\/)__ia_thumb|_thumb\./i.test(f.name));
  if (imgs.length >= 2) return { type: 'images', files: imgs.sort((a, b) => natural(a.name, b.name)).slice(0, MAX_PAGES) };
  const pages = +(meta.metadata && meta.metadata.imagecount) || 0;
  if (pages > 0 && files.some(f => /_jp2\.(zip|tar)$/i.test(f.name))) return { type: 'pages', pages: Math.min(pages, MAX_PAGES), ...(pdfs.length ? { alt: { type: 'file', files: pdfs.slice(0, 4) } } : {}) };
  if (pdfs.length) return { type: 'file', files: pdfs.slice(0, 4) };
  return null;
}
const pickFile = files => { const p = plan({ files }); return p && (p.type === 'file' || p.type === 'bundle') ? p.files[0] : null; };

// ---------- file transfer ----------
// Downloads go through Chromium's network stack (redirects to the archive's storage servers, proxies, HTTP/2), streamed
// to <dest>.part and renamed when complete. Resolves { ok, status }.
let fetchImpl = null; // tests swap this
const UA = `Boxshelf/${(() => { try { return require('../package.json').version; } catch { return '0'; } })()}`;
async function fetchFile(url, dest, onBytes, expect, resume, signal) {
  if (signal && signal.aborted) return { ok: false, status: 'cancelled' };
  if (fetchImpl) return fetchImpl(url, dest, onBytes, expect, resume, signal);
  const { net } = require('electron');
  const ac = new AbortController(); let idle = setTimeout(() => ac.abort(), 60000);
  const onCancel = () => ac.abort(); if (signal) signal.addEventListener('abort', onCancel, { once: true });
  const part = dest + '.part';
  // a retry after a dropped connection carries on from what's already in .part instead of starting over (the
  // archive's storage servers answer byte ranges); a first try always starts clean
  let have = 0; if (resume) { try { have = fs.statSync(part).size; } catch {} } else { try { fs.rmSync(part, { force: true }); } catch {} }
  if (expect && have >= expect) { try { fs.rmSync(part, { force: true }); } catch {} have = 0; }
  let n = 0, werr = null;
  try {
    const headers = { 'User-Agent': UA }; if (have > 0) headers.Range = `bytes=${have}-`;
    const r = await net.fetch(url, { headers, signal: ac.signal, cache: 'no-store', redirect: 'follow' });
    if (r.status === 416 && have) { try { await r.body.cancel(); } catch {} fs.rmSync(part, { force: true }); return { ok: false, status: 'network', drop: true }; } // what we had doesn't fit: start over
    if (!r.ok) { log('Archive file HTTP', r.status, url); const ra = r.headers.get('retry-after'); try { await r.body.cancel(); } catch {} fs.rmSync(part, { force: true }); return { ok: false, status: r.status, retryAfter: ra && /^\d+$/.test(ra.trim()) ? +ra : ra ? Math.max(0, (Date.parse(ra) - Date.now()) / 1000) || 0 : 0 }; }
    // 206 from the right place: append; anything else (the server sent the whole file): start the file again
    const from = r.status === 206 ? +((/^bytes (\d+)-/.exec(r.headers.get('content-range') || '') || [])[1] ?? -1) : 0;
    const append = have > 0 && r.status === 206 && from === have;
    if (have > 0 && r.status === 206 && !append) { try { await r.body.cancel(); } catch {} fs.rmSync(part, { force: true }); return { ok: false, status: 'network', drop: true }; }
    if (append) log('Archive file: resuming at', Math.round(have / 1048576), 'MB', url);
    n = append ? have : 0;
    const total = (+r.headers.get('content-length') || 0) + n || expect || 0;
    const out = fs.createWriteStream(part, { flags: append ? 'a' : 'w' });
    // a write failing (disk full, path too long) must end the download, not crash or leave it waiting for 'drain' forever
    out.on('error', e => { if (!werr) { werr = e; ac.abort(); } });
    const reader = r.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        clearTimeout(idle); idle = setTimeout(() => ac.abort(), 60000);
        if (werr) throw werr;
        n += value.length;
        if (!out.write(Buffer.from(value))) await new Promise((res, rej) => { const ok = () => { off(); res(); }, bad = e => { off(); rej(e); }, off = () => { out.off('drain', ok); out.off('close', ok); out.off('error', bad); }; out.on('drain', ok); out.on('close', ok); out.on('error', bad); });
        if (werr) throw werr;
        if (onBytes) onBytes(n, expect || total);
      }
    } finally { if (werr || out.destroyed) out.destroy(); else await new Promise((res, rej) => out.end(e => e ? rej(e) : res())).catch(e => { werr = werr || e; }); }
    if (werr) throw werr;
    if (n < 2048) { log('Archive file too small', n, url); fs.rmSync(part, { force: true }); return { ok: false, status: 'short' }; }
    // shorter than the archive's listed size: kept, the next try carries on from here. (Its listing can be out of date:
    // a server that said "complete" with content-length matching what we have is believed over the listing.)
    if (expect && n < expect && !(r.status === 200 && +r.headers.get('content-length') === n)) { log('Archive file short', n, 'of', expect, url); return { ok: false, status: 'short' }; }
    fs.renameSync(part, dest); return { ok: true };
  } catch (e) {
    if (signal && signal.aborted) { try { fs.rmSync(part, { force: true }); } catch {} return { ok: false, status: 'cancelled' }; }
    if (werr) { log('Archive file could not be saved', dest, werr.message); try { fs.rmSync(part, { force: true }); } catch {} return { ok: false, status: 'write' }; }
    log('Archive file failed', url, e.message, n ? `(${Math.round(n / 1048576)} MB kept to resume)` : ''); return { ok: false, status: e.name === 'AbortError' ? 'stalled' : 'network' }; }
  finally { clearTimeout(idle); if (signal) signal.removeEventListener('abort', onCancel); }
}
// a few tries for a dropped connection, each carrying on where the last stopped; 401/403/404 are final. Whatever is
// left half-done when it gives up is removed.
// 429 / 503 (the archive asking us to slow down) holds back every request for its Retry-After (up to a minute)
const slowWait = signal => { const ms = slowUntil - Date.now(); return ms > 0 ? sleep(ms, signal) : null; };
async function fetchRetry(url, dest, onBytes, expect, signal, tries = 4) {
  let r = { ok: false, status: 'network' }, resume = false;
  try {
    for (let t = 0; t < tries; t++) {
      await slowWait(signal);
      r = await fetchFile(url, dest, onBytes, expect, resume, signal); if (r.ok || [401, 403, 404, 410, 451, 'write', 'cancelled'].includes(r.status)) break;
      if (t === tries - 1) break;
      let wait = 1500 * (t + 1) * RETRY_MS / 1000;
      if ((r.status === 429 || r.status === 503)) { wait = Math.max(wait, Math.min(60, r.retryAfter > 0 ? r.retryAfter : 5 * (t + 1)) * 1000 * RETRY_MS / 1000); slowUntil = Math.max(slowUntil, Date.now() + wait); }
      resume = !r.drop; await sleep(wait, signal);
    }
  } catch (e) { if (!e.cancelled) throw e; r = { ok: false, status: 'cancelled' }; }
  if (!r.ok) { try { fs.rmSync(dest + '.part', { force: true }); } catch {} }
  return r;
}
const why = st => st === 'cancelled' ? 'Cancelled.' : st === 'write' ? 'The file couldn\'t be saved (is the disk full?).' : st === 403 || st === 401 || st === 451 ? 'The Internet Archive won\'t let this file be downloaded (it may be restricted).' : st === 404 || st === 410 ? 'That file is missing on the Internet Archive.' : st === 429 || st === 503 ? 'archive.org is busy right now. Try again in a minute.' : st === 'stalled' ? 'The download stalled. Try again in a minute.' : 'The download didn\'t finish. Check your connection and try again.';
const PAGE_PAR = 6; // page images fetched at once
const MAX_BYTES = 2 * 1024 ** 3, MAX_BUNDLE = 6 * 1024 ** 3;
const safeName = s => clean(s).replace(/['&]/g, '').slice(0, 90).trim() || 'Untitled';
const MARK = '.boxshelf-archive.json'; // in a folder a download made: which item it is
const dl = (id, name) => `https://archive.org/download/${encodeURIComponent(id)}/${name.split('/').map(encodeURIComponent).join('/')}`;

// ---------- what you already have: id → the file it became (kept beside the cover cache) ----------
let owned = null;
const ownedFile = () => { const d = library.cacheDir && library.cacheDir(); return d ? path.join(d, 'archive-downloads.json') : null; };
function ownedLoad() { if (owned) return owned; owned = {}; const f = ownedFile(); if (f) { try { const o = JSON.parse(fs.readFileSync(f, 'utf8')); if (o && typeof o === 'object') owned = o; } catch {} } return owned; }
function ownedSave() { const f = ownedFile(); if (!f || !owned) return; try { fs.mkdirSync(path.dirname(f), { recursive: true }); const tmp = `${f}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(owned)); fs.renameSync(tmp, f); } catch (e) { log('Archive: could not save the download list', e.message); } }
// the file an item was saved as, if it's still there (a moved or deleted file isn't "owned" any more)
function ownedPath(id) { const o = ownedLoad()[id]; return o && o.file && fs.existsSync(o.file) ? o.file : null; }
function remember(id, kind, file) { ownedLoad()[id] = { kind, file, at: Date.now() }; const keys = Object.keys(owned); if (keys.length > 5000) delete owned[keys[0]]; ownedSave(); }

// a downloaded PDF's cover: the archive's own picture of page 1, saved where the reading corner looks for covers, so the
// museum never has to open a several-hundred-MB PDF just to show its front (best effort: without it the PDF is drawn)
async function saveCover(id, file, signal) {
  const out = library.coverPath && library.coverPath(file); if (!out || fs.existsSync(out)) return false;
  try { fs.mkdirSync(path.dirname(out), { recursive: true }); } catch { return false; }
  for (const u of [`https://archive.org/download/${encodeURIComponent(id)}/page/n0_w800.jpg`, `https://archive.org/services/img/${encodeURIComponent(id)}`]) {
    // (beta.10) into a temp name, kept only if it's a picture: an error page saved as the cover was trusted for good
    const tmp = `${out}.${process.pid}.dl`, r = await fetchFile(u, tmp, null, 0, false, signal).catch(e => ({ ok: false, status: e.message }));
    if (r.ok) { let ok = false; try { ok = require('./imgcheck').isImageBuf(await fs.promises.readFile(tmp)); if (ok) await fs.promises.rename(tmp, out); } catch { ok = false; } if (!ok) { await fs.promises.unlink(tmp).catch(() => {}); log('Archive cover: not a picture from', u); } if (ok) return true; continue; }
    if (r.status === 'cancelled') return false;
  }
  log('Archive cover: none from archive.org for', id, '(it will be drawn from the PDF)');
  return false;
}

// ---------- downloads: several can run, each can be cancelled ----------
const jobs = new Map(), dests = new Set(), MAX_JOBS = 3;
function cancel(id) { const j = jobs.get(String(id)); if (!j) return false; j.abort(); return true; }
const running = () => [...jobs.keys()];
// download one item into Magazines\ or Guides\ (a sub-folder per series when given). onProgress(done, total, unit)
async function download(id, kind, opts = {}, onProgress) {
  id = String(id);
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(id)) throw new Error('Unknown item.');
  if (jobs.has(id)) throw new Error('That one is downloading already.');
  if (jobs.size >= MAX_JOBS) throw new Error('A few downloads are running already. Try again when one finishes.');
  const ac = new AbortController(), t0 = Date.now(); jobs.set(id, ac);
  try {
    const r = await downloadOne(id, kind, opts, onProgress, ac.signal);
    if (ac.signal.aborted) log('Archive download: Cancel came after it finished; kept', id); // a whole file, already remembered: say "Saved", not "Cancelled" with the file left there
    log('Archive download done', id, '→', r.file, r.existed ? '(already there)' : `(${r.count ? r.count + ' files, ' : ''}${Math.round((Date.now() - t0) / 1000)} s)`);
    return r;
  } catch (e) {
    if (ac.signal.aborted || e.cancelled) { log('Archive download cancelled', id); throw cancelErr(); }
    log('Archive download failed', id, e.message); throw e;
  } finally { jobs.delete(id); }
}
async function downloadOne(id, kind, opts, onProgress, signal) {
  const meta = await getJsonRetry(`https://archive.org/metadata/${encodeURIComponent(id)}`, 'metadata', 4, signal).catch(e => { if (e.cancelled) throw e; throw new Error(busyErr(e) ? why(429) : `Couldn't reach archive.org (${e.message}).`); });
  if (!meta || !meta.metadata) throw new Error('The Internet Archive has no such item.');
  if (meta.is_dark || String(meta.metadata['access-restricted-item']) === 'true') throw new Error('This one is borrow-only on the Internet Archive, so it can\'t be downloaded.');
  const had = ownedPath(id); if (had && !opts.again) return { file: had, existed: true };
  const p = plan(meta);
  if (!p) throw new Error('This item has no PDF or page scans Boxshelf can use. Press View to see what it has.');
  const title = opts.title || (Array.isArray(meta.metadata.title) ? meta.metadata.title[0] : meta.metadata.title) || id;
  const dir = path.join(library.folder(kind), opts.series ? safeName(opts.series) : '');
  fs.mkdirSync(dir, { recursive: true });
  log('Archive download', id, kind, p.type, p.type === 'pages' ? p.pages + ' pages' : p.files.length + ' files: ' + p.files.slice(0, 4).map(f => f.name + ' ' + f.size).join(', '), '→', dir);
  const r = await take(id, p, title, dir, onProgress, signal);
  if (!r.existed) remember(id, kind, r.file);
  return r;
}
// a name nothing else is using: two downloads with the same title must not share a .part file
function claim(dest, alt) { const d = dests.has(dest.toLowerCase()) ? alt : dest; dests.add(d.toLowerCase()); return d; }
async function take(id, p, title, dir, onProgress, signal) {
  if (p.type === 'file') {
    let last = null;
    for (const f of p.files) {
      if (+f.size > MAX_BYTES) { last = 'big'; continue; }
      const ext = path.extname(f.name).toLowerCase();
      let dest = path.join(dir, safeName(title) + ext);
      if (fs.existsSync(dest)) { if (fs.statSync(dest).size === +f.size) return { file: dest, existed: true }; dest = path.join(dir, `${safeName(title)} (${id})${ext}`); }
      dest = claim(dest, path.join(dir, `${safeName(title)} (${id})${ext}`));
      let r; try { r = await fetchRetry(dl(id, f.name), dest, (n, t) => onProgress && onProgress(n, +f.size || t || 0), +f.size || 0, signal); } finally { dests.delete(dest.toLowerCase()); }
      if (r.ok) { if (ext === '.pdf') await saveCover(id, dest, signal).catch(e => log('Archive cover', id, e.message)); return { file: dest, existed: false }; }
      last = r.status; if (![404, 410].includes(r.status)) break; // only a missing file moves on to the next candidate
    }
    if (last === 'cancelled') throw cancelErr();
    throw new Error(last === 'big' ? 'That file is over 2 GB.' : why(last));
  }
  // a bundle of issues, loose page images, or the archive's page scans: a folder named after the item. A cancelled or
  // failed first page removes the folder only when this download made it.
  // a folder of that name holding another item (two issues with one title, or your own folder) is never written into: its
  // pages would be overwritten (0001.jpg…) or mixed in. This item's own folder (an earlier try) carries on.
  const mine = f => { try { return JSON.parse(fs.readFileSync(path.join(f, MARK), 'utf8')).id === id; } catch { return false; } };
  let folder = path.join(dir, safeName(title)); if (fs.existsSync(folder) && !mine(folder)) folder = path.join(dir, `${safeName(title)} (${id})`);
  const fresh = !fs.existsSync(folder); fs.mkdirSync(folder, { recursive: true });
  if (fresh) { try { fs.writeFileSync(path.join(folder, MARK), JSON.stringify({ id })); } catch {} } // (a dot file: the reading corner doesn't list it)
  const dropIfFresh = () => { if (fresh) { try { fs.rmSync(folder, { recursive: true, force: true }); } catch {} } };
  if (p.type === 'bundle' || p.type === 'images') {
    const total = p.files.reduce((a, f) => a + (+f.size || 0), 0); if (total > MAX_BUNDLE) { dropIfFresh(); throw new Error('That bundle is over 6 GB. Press View to pick single files.'); }
    let doneBytes = 0, got = 0, i = 0;
    for (const f of p.files) {
      if (signal.aborted) { dropIfFresh(); throw cancelErr(); }
      const ext = path.extname(f.name).toLowerCase();
      const dest = path.join(folder, p.type === 'images' ? String(++i).padStart(4, '0') + ext : safeName(path.basename(f.name, ext)) + '.pdf');
      if (fs.existsSync(dest) && fs.statSync(dest).size === +f.size) { doneBytes += +f.size || 0; got++; continue; }
      const r = await fetchRetry(dl(id, f.name), dest, n => onProgress && onProgress(doneBytes + n, total), +f.size || 0, signal);
      if (r.status === 'cancelled') { dropIfFresh(); throw cancelErr(); }
      if (r.ok) got++; else log('Archive', p.type, 'file skipped', f.name, r.status);
      doneBytes += +f.size || 0; if (onProgress) onProgress(doneBytes, total);
    }
    if (!got) { dropIfFresh(); throw new Error(why('network')); }
    return { file: folder, existed: false, count: got };
  }
  // scanned pages (the archive's own page images, 1600 px wide)
  // The archive makes each page image on request (about a second each), so several are fetched at once. The first
  // page goes alone: if that fails nothing else is tried. A missing page past the first is the end of the book.
  const pageUrl = i => `https://archive.org/download/${encodeURIComponent(id)}/page/n${i}_w1600.jpg`;
  const pageFile = i => path.join(folder, String(i + 1).padStart(4, '0') + '.jpg');
  // ~8 pages failing in a row (the archive refusing us, the disk full): stop the whole book, keeping what came in
  let got = 0, done = 0, end = p.pages, fails = 0, stopped = null;
  const one = async i => { if (i >= end || stopped || signal.aborted) return; const dest = pageFile(i);
    if (!fs.existsSync(dest)) { const r = await fetchRetry(pageUrl(i), dest, null, 0, signal); if (!r.ok) { if (r.status === 'cancelled') { stopped = 'cancelled'; return; } if (i && [404, 410].includes(r.status)) { end = Math.min(end, i); return; } if (!i) throw Object.assign(new Error(why(r.status)), { first: true, status: r.status }); done++; if (++fails >= 8 || r.status === 'write') stopped = stopped || r.status; return; } }
    fails = 0; got++; done++; if (onProgress) onProgress(Math.min(done, end), end, 'pages'); };
  try { await one(0); } catch (e) {
    if (e.first) { dropIfFresh(); if (p.alt && e.status !== 'write') { log('Archive pages: no page images for', id, '- taking its PDF instead'); return take(id, p.alt, title, dir, onProgress, signal); } }
    throw e;
  }
  if (stopped === 'cancelled' || signal.aborted) { dropIfFresh(); throw cancelErr(); }
  await M.pool(Array.from({ length: p.pages - 1 }, (_, k) => k + 1), jobs.size > 1 ? 3 : PAGE_PAR, one);
  if (stopped === 'cancelled' || signal.aborted) { dropIfFresh(); throw cancelErr(); }
  if (stopped) { log('Archive pages: stopped after repeated failures', id, stopped); throw new Error(why(stopped)); }
  for (let i = end; i < p.pages; i++) { try { fs.rmSync(pageFile(i), { force: true }); } catch {} } // past the end: keep the book in one piece
  got = 0; for (let i = 0; i < end; i++) if (fs.existsSync(pageFile(i))) got++;
  return { file: folder, existed: false, count: got };
}

// ---------- which results can really be downloaded ----------
// The item's metadata says it isn't borrow-only and has a PDF / comic / page scans (its own file list is trusted: a HEAD
// request per item made a search take ages). Remembered for the session. A busy or unreachable archive.org is retried a
// few times, then answered with retry:true (busy:true for 429 / 503) so the screen keeps the item and checks it again
// later instead of dropping it as "not downloadable".
// → { id: { ok, type, size, files, pages, owned } | { ok:false, why, retry?, busy? } }
const checked = new Map(), checking = new Map();
async function checkOne(id) {
  if (checked.has(id)) return checked.get(id);
  if (checking.has(id)) return checking.get(id);
  const p = (async () => {
    let meta;
    try { meta = await getJsonRetry(`https://archive.org/metadata/${encodeURIComponent(id)}`, 'check', 3); }
    catch (e) {
      if (transient(e)) { log('Archive check: no answer for', id, e.message); return { ok: false, why: busyErr(e) ? 'archive.org is busy' : e.message, retry: true, busy: busyErr(e) }; } // not remembered: asked again later
      log('Archive check failed', id, e.message); meta = null;
    }
    let res;
    if (!meta || !meta.metadata) res = { ok: false, why: 'missing' };
    else if (meta.is_dark || String(meta.metadata['access-restricted-item']) === 'true') res = { ok: false, why: 'borrow-only' };
    else {
      const pl = plan(meta);
      if (!pl) res = { ok: false, why: 'no usable files' };
      else {
        const size = pl.type === 'pages' ? 0 : pl.files.reduce((a, f) => a + (+f.size || 0), 0);
        res = { ok: true, type: pl.type, size, files: pl.type === 'bundle' || pl.type === 'images' ? pl.files.length : 1, pages: pl.pages || 0 };
      }
    }
    checked.set(id, res); if (checked.size > 3000) checked.delete(checked.keys().next().value);
    return res;
  })();
  checking.set(id, p); p.finally(() => checking.delete(id)).catch(() => {});
  return p;
}
async function check(ids) {
  const list = (Array.isArray(ids) ? ids : []).map(String).filter(id => /^[A-Za-z0-9._-]{1,100}$/.test(id)).slice(0, 60), out = {};
  await M.pool(list, 4, async id => { const r = await checkOne(id); out[id] = r.ok && ownedPath(id) ? { ...r, owned: true } : r; });
  return out;
}

module.exports = { init, search, check, download, cancel, running, _query: query, _terms: terms, _pickFile: pickFile, _plan: plan, _setFetch: f => { fetchImpl = f; }, _setRetry: ms => { RETRY_MS = ms; slowUntil = 0; }, _reset: () => { checked.clear(); owned = null; slowUntil = 0; } };
