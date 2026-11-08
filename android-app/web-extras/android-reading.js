/* Boxshelf on Android (0.3.2): magazines & guides. Added to the Android build only by copy-web.js; the Windows build has
   its own (main/archive.js, main/library.js, the finder in setup.js).
   - The store: free scans of classic game magazines and strategy guides from the Internet Archive (archive.org), as a
     cover grid laid out for the Thor's top screen. Ready-made shelves (Nintendo Power, EGM, GamePro… and strategy guides,
     your consoles' first) and a search. Every cover says its year and the download size before you download. Only items
     anyone may download are offered (lending-library / borrow-only items are left out and refused). Controller (d-pad,
     A / B / X / Y, L / R) and touch (tap a cover to look at it, tap again or Download to get it) both work. Opened from
     Settings → Magazines & guides, and from the museum's reading corner (X there).
   - Downloads: native (ReadingStore.java), straight to a file, several ranged connections, resumable, cancellable,
     two at a time. Saved in a "Boxshelf Reading" folder beside the ROMs (Magazines/ and Guides/, a sub-folder per
     series), or inside Boxshelf when "Where box art is saved" says so or no folder can be written.
   - The reading corner: window.boxshelf.library / libraryCover / libraryPages for the museum (app.js reads them), from
     "Boxshelf Reading" and PC-style "Magazines" / "Guides" folders copied next to the ROMs, plus the app's own storage.
     PDFs open in the museum's reader (pdf.js, which draws while the museum is paused under it); comic archives (.cbz)
     are unpacked natively; a folder of page pictures is read as it is.
   Performance: nothing runs while the shelf slides or the museum is being moved (idleTurn); the store has no animation
   loop (progress comes from native events); covers load only near the screen (IntersectionObserver). */
(function () {
  'use strict';
  const C = window.BS_ANDROID_CTX;
  if (!C) return; // only with the Android adapter (on the device, or the ?fakeNative=1 pretend device)
  const { N, st, ready, gated, slowDown, idleTurn, fileUrl, pdfLib, toJpegB64, load, store, log, isNative } = C;
  const api = window.boxshelf;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const soundOn = () => !(st.config && st.config.ui && st.config.ui.sound === false);
  const snd = (n, o) => { try { if (soundOn() && window.Sound && Sound.play) Sound.play(n, o); } catch {} };
  const wake = () => { try { if (window.Shelf && Shelf._wake) Shelf._wake(); } catch {} };
  const toast = m => { try { if (window.Shelf && Shelf.toast) Shelf.toast(m); } catch {} };
  const hash = s => { let a = 2166136261, b = 5381; for (const ch of String(s)) { const c = ch.charCodeAt(0); a = Math.imul(a ^ c, 16777619); b = (Math.imul(b, 33) ^ c) >>> 0; } return (a >>> 0).toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0'); };
  const natural = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  const fmtSize = b => !(b > 0) ? '' : b >= 1e9 ? (b / 1073741824).toFixed(1) + ' GB' : b >= 1048576 * 10 ? Math.round(b / 1048576) + ' MB' : b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
  const fake = !isNative;
  if (fake) installFake();

  // ---------- the Internet Archive's search (main/archive.js's query rules) ----------
  const RESTRICT = 'mediatype:texts AND NOT access-restricted-item:true AND NOT collection:(inlibrary OR printdisabled OR lendinglibrary)';
  const fold = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '');
  function terms(text) {
    const words = String(text || '').replace(/&/g, ' ').replace(/[^\p{L}\p{N}\s'’-]/gu, ' ').replace(/’/g, "'").split(/\s+/)
      .map(w => w.replace(/^[-']+|[-']+$/g, '')).filter(w => w && /[\p{L}\p{N}]/u.test(w) && !/^(and|or|not|to)$/i.test(w));
    return words.slice(0, 12).map(w => { const q = x => /[-']/.test(x) ? `"${x}"` : x, f = fold(w); return f !== w && f ? `${q(f)} OR ${q(w)}` : q(w); });
  }
  const GUIDE_HINT = ' AND (title:(guide) OR subject:(guide) OR subject:(strategy) OR subject:(walkthrough))';
  const MAG_HINT = ' AND (subject:(magazine OR magazines OR periodical OR periodicals) OR collection:(magazine_rack OR gamemagazines OR videogamemagazines OR computermagazines) OR title:(magazine OR issue))';
  function query(text, kind, plain) {
    const t = terms(text); if (!t.length) throw new Error('Type what to look for.');
    const hint = plain ? '' : kind === 'guide' ? GUIDE_HINT : kind === 'magazine' ? MAG_HINT : '';
    return `(${t.map(w => `title:(${w})`).join(' AND ')})${hint} AND ${RESTRICT}`;
  }
  const ROWS = 36;
  const searchUrl = (q, p, sort) => `https://archive.org/advancedsearch.php?q=${encodeURIComponent(q)}&fl[]=identifier&fl[]=title&fl[]=date&fl[]=year&fl[]=imagecount&fl[]=downloads&sort[]=${encodeURIComponent(sort || 'downloads desc')}&rows=${ROWS}&page=${p}&output=json`;
  const busyErr = () => Object.assign(new Error('archive.org is busy right now. Try again in a minute.'), { busy: true });
  async function iaJson(url) {
    let r; try { r = await gated('archive', () => N.httpText({ url, headers: { Accept: 'application/json' } })); } catch { throw Object.assign(new Error("archive.org didn't answer. Check the connection."), { offline: true }); }
    if (!r || r.status === 429 || r.status === 503) { slowDown('archive'); throw busyErr(); }
    if (r.status >= 500) throw busyErr();
    slowDown('archive', true);
    if (r.status !== 200) return null;
    try { return JSON.parse(r.text); } catch { return null; }
  }
  async function runSearch(q, p, sort) {
    const j = await iaJson(searchUrl(q, p, sort));
    if (!j || !j.response) throw new Error("archive.org couldn't run that search. Try other words.");
    return { docs: j.response.docs || [], total: +j.response.numFound || 0 };
  }
  const first = v => String(Array.isArray(v) ? v[0] : v == null ? '' : v);
  const docItem = d => ({ id: d.identifier, title: first(d.title || d.identifier).slice(0, 200), date: first(d.date || d.year).slice(0, 10), downloads: +d.downloads || 0,
    thumb: fake ? fakeThumb(d.identifier) : `https://archive.org/services/img/${encodeURIComponent(d.identifier)}` });
  const okId = id => /^[A-Za-z0-9._-]{1,100}$/.test(String(id || ''));
  // "Game Informer Issue 150", "GamePro_June_1995" → the magazine's name (its series folder), as setup.js does on Windows
  const MONTH = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|xmas|christmas|spring|summer|autumn|fall|winter|holiday';
  const seriesOf = t => { const s0 = String(t || '').replace(/[_.]+/g, ' ').replace(/\s+/g, ' ').trim();
    const m = new RegExp(`^(.*?)(?:\\s*[-–:,]?\\s*(?:issue|vol\\.?|volume|no\\.?|number|#)\\s*\\d|\\s*[-–:,(]?\\s*\\b(?:${MONTH})\\b|\\s+\\d{1,4}\\b|\\s*\\(\\d{4})`, 'i').exec(s0);
    const s = (m ? m[1] : '').replace(/[\s\-–:,(]+$/, '').trim(); return s.length > 2 && s.length < 60 ? s : ''; };

  // ---------- what an item offers, and how big it is (its metadata lists every file with its size) ----------
  // On the Thor: one file to read, best first: the uploader's own PDF (several big ones = a bundle of issues), a comic
  // archive (.cbz, or the uploader's own .zip of pages), the PDF the archive made from the scans, and last its smaller
  // "text" PDF. Items with only page scans (no PDF at all) aren't offered here (hundreds of separate page requests).
  const isOrig = f => /original/.test(f.source || '');
  function planFiles(meta) {
    const files = (meta.files || []).filter(f => f && typeof f.name === 'string' && f.private !== 'true' && !f.name.split('/').some(p => p === '..' || p === '' || p === '.'))
      .map(f => Object.assign({}, f, { size: +f.size || 0, ext: (/\.([a-z0-9]+)$/i.exec(f.name) || [])[1] ? (/\.([a-z0-9]+)$/i.exec(f.name)[1]).toLowerCase() : '' }));
    const pdfs = files.filter(f => f.ext === 'pdf' && !/encrypted/i.test(f.format || ''));
    const text = f => /_text\.pdf$/i.test(f.name), bySize = (a, b) => b.size - a.size;
    const orig = pdfs.filter(f => isOrig(f) && !text(f)).sort(bySize);
    const big = orig.filter(f => f.size > 2e6);
    if (big.length >= 2) { const L = big.sort((a, b) => natural(a.name, b.name)).slice(0, 150); return { type: 'bundle', files: L, size: L.reduce((a, f) => a + f.size, 0) }; }
    const arch = files.filter(f => f.ext === 'cbz' || (isOrig(f) && f.ext === 'zip' && f.size > 1e6 && !/_(jp2|tif|tiff|raw|orig_jp2|jpg|png|images|djvu|hocr|chocr)\.zip$/i.test(f.name))).sort(bySize);
    const derived = pdfs.filter(f => !isOrig(f) && !text(f)).sort(bySize), small = pdfs.filter(text).sort(bySize);
    const L = [...orig, ...arch, ...derived, ...small].slice(0, 4);
    return L.length ? { type: 'file', files: L, size: L[0].size } : null;
  }
  const checks = new Map(); // id → promise of { ok, type, files, size, title, date } | { ok: false, why: borrow | nofile | missing | busy | offline }
  function check(id) {
    id = String(id); if (checks.has(id)) return checks.get(id);
    const p = (async () => {
      let meta; try { meta = await iaJson(`https://archive.org/metadata/${encodeURIComponent(id)}`); } catch (e) { return { ok: false, why: e.busy ? 'busy' : 'offline', retry: true }; }
      if (!meta || !meta.metadata) return { ok: false, why: 'missing' };
      const m = meta.metadata, coll = [].concat(m.collection || []).map(String);
      if (meta.is_dark || String(m['access-restricted-item']) === 'true' || coll.some(c => /^(inlibrary|printdisabled|lendinglibrary)$/i.test(c))) return { ok: false, why: 'borrow' };
      const pl = planFiles(meta); if (!pl) return { ok: false, why: 'nofile' };
      return Object.assign({ ok: true, title: first(m.title).slice(0, 200), date: first(m.date || m.year).slice(0, 10) }, pl);
    })();
    checks.set(id, p); p.then(r => { if (r.retry) checks.delete(id); }, () => checks.delete(id));
    if (checks.size > 3000) checks.delete(checks.keys().next().value);
    return p;
  }
  const whyText = c => c.why === 'borrow' ? 'Borrow-only on the Internet Archive' : c.why === 'nofile' ? 'Page scans only (no PDF)' : c.why === 'missing' ? 'No longer on the Internet Archive' : c.why === 'busy' ? 'archive.org is busy' : 'Offline';
  const dlUrl = (id, name) => `https://archive.org/download/${encodeURIComponent(id)}/${String(name).split('/').map(encodeURIComponent).join('/')}`;

  // ---------- what's remembered (reading.json) ----------
  // owned: archive item → the file it became; covers: a library item → its cover picture (app storage); pend: downloads
  // not finished (shown as paused, carried on from where they got to); lib: the last look through the folders
  const db = { v: 1, owned: {}, covers: {}, pend: {}, lib: [] };
  const dbReady = ready.then(async () => { const d = await load('reading.json', null); if (d && typeof d === 'object') Object.assign(db, d); }).catch(() => {});
  let saveT = 0;
  function saveDb(soon) { clearTimeout(saveT); saveT = setTimeout(async () => { saveT = 0; await idleTurn(20000); store('reading.json', db); }, soon ? 300 : 2500); }

  // ---------- where: "Boxshelf Reading" beside the ROMs (the main ROMs folder, else the first games folder), or inside Boxshelf ----------
  const ui = () => (st.config && st.config.ui) || {};
  function romTree() {
    const c = st.config || {}, rr = c.romRoot;
    if (rr && st.folders[rr]) return { tree: st.folders[rr], path: rr };
    for (const s of Object.values(c.systems || {})) for (const d of (s && s.romDirs) || []) if (st.folders[d]) return { tree: st.folders[d], path: d };
    return null;
  }
  function saveRoot() { const t = romTree(); return ui().artWhere === 'app' || !t ? { tree: '', where: 'app' } : { tree: t.tree, where: 'roms', path: t.path }; }
  const whereText = () => { const r = saveRoot(); return r.where === 'app' ? 'Inside Boxshelf' : `${String(r.path).split('/').filter(Boolean).pop() || 'ROMs'}/Boxshelf Reading`; };

  // ---------- the reading corner's list: every magazine and guide on the device ----------
  const IMG = /\.(jpe?g|png|webp|gif)$/i, BOOK = /\.(pdf|cbz|zip)$/i, EXTS = ['pdf', 'cbz', 'zip', 'jpg', 'jpeg', 'png', 'webp', 'gif'];
  const titleOf = n => String(n).replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[_.]+/g, ' ').replace(/\s+/g, ' ').trim();
  const kindOf = n => /^magazines?$/i.test(n) ? 'magazine' : /^(strategy )?guides?$/i.test(n) ? 'guide' : null;
  const idOf = src => 'rd-' + hash(src);
  const lib = { items: new Map(), list: [], byFile: new Set(), at: 0, scanning: null, sig: '' };
  // files of one Magazines / Guides folder → items: each PDF / archive is one; a folder holding page pictures is one
  // (its name the title); folders above become the series ("Nintendo Power · 1992")
  function group(kind, files, out) {
    const pics = new Map();
    for (const f of files) {
      const segs = String(f.dir || '').split('/').filter(Boolean);
      if (IMG.test(f.name)) { if (!segs.length) continue; const k = f.dir; if (!pics.has(k)) pics.set(k, []); pics.get(k).push(f); continue; }
      if (!BOOK.test(f.name)) continue;
      out.push({ id: idOf(f.src), kind, type: /\.pdf$/i.test(f.name) ? 'pdf' : 'arch', title: titleOf(f.name), series: segs.map(titleOf).join(' · '), src: f.src, size: +f.size || 0 });
    }
    for (const [dir, L] of pics) {
      if (L.length < 2) continue; const segs = dir.split('/').filter(Boolean);
      L.sort((a, b) => natural(a.name, b.name));
      out.push({ id: idOf(L[0].src + '|dir'), kind, type: 'dir', title: titleOf(segs[segs.length - 1]), series: segs.slice(0, -1).map(titleOf).join(' · '), src: L[0].src, files: L.slice(0, 1500).map(f => f.src), pages: L.length, size: L.length });
    }
  }
  async function scanLib() {
    const out = [], t = romTree();
    if (t) {
      let top = []; try { top = ((await N.listDirs({ uri: t.tree })) || {}).dirs || []; } catch {}
      const kinds = [];
      for (const d of top) {
        if (/^boxshelf reading$/i.test(d.name)) { try { for (const k of ((await N.listDirs({ uri: d.uri })) || {}).dirs || []) { const kk = kindOf(k.name); if (kk) kinds.push({ kind: kk, uri: k.uri }); } } catch {} }
        else { const kk = kindOf(d.name); if (kk) kinds.push({ kind: kk, uri: d.uri }); } // PC-style "Magazines" / "Guides" copied next to the ROMs
      }
      for (const k of kinds) {
        let files = []; try { files = ((await N.listFiles({ uri: k.uri, exts: EXTS, depth: 3 })) || {}).files || []; } catch {}
        group(k.kind, files.map(f => ({ name: f.name, dir: f.dir || '', src: f.uri, size: f.size })), out);
      }
    }
    try { // inside Boxshelf (no writable games folder, or "Inside Boxshelf")
      const r = await N.readingLocal(), by = { magazine: [], guide: [] };
      for (const f of (r && r.files) || []) if (by[f.kind]) by[f.kind].push({ name: f.name, dir: f.dir || '', src: f.path, size: f.size });
      group('magazine', by.magazine, out); group('guide', by.guide, out);
    } catch {}
    const seen = new Set();
    return out.filter(i => !seen.has(i.id) && seen.add(i.id)).sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'magazine' ? -1 : 1) || natural(a.series, b.series) || natural(a.title, b.title));
  }
  function adopt(items) {
    lib.items = new Map(items.map(i => [i.id, i])); lib.list = items; lib.byFile = new Set(items.map(i => i.src));
  }
  const pub = i => ({ id: i.id, kind: i.kind, type: i.type, title: i.title, series: i.series || '', pages: i.pages || 0 });
  async function rescan() {
    if (lib.scanning) return lib.scanning;
    lib.scanning = (async () => {
      await dbReady; await idleTurn(15000); // (beta.7: at most 15 s: listing folders is the native side's work, and it must not wait forever)
      const items = await scanLib(), sig = items.map(i => i.id).join(',');
      lib.at = Date.now(); const changed = sig !== lib.sig; lib.sig = sig; adopt(items);
      if (changed) { db.lib = items; saveDb(); try { dispatchEvent(new CustomEvent('bs-library-changed')); } catch {} }
      return items;
    })().finally(() => { lib.scanning = null; });
    return lib.scanning;
  }
  async function libraryList() {
    await dbReady;
    if (!lib.at && !lib.list.length && Array.isArray(db.lib) && db.lib.length) { adopt(db.lib); lib.sig = db.lib.map(i => i.id).join(','); } // last time's list at once…
    if (Date.now() - lib.at > 30000) { const p = rescan().catch(() => lib.list); if (!lib.list.length) await p; } // …and a fresh look in the background
    return lib.list.map(pub);
  }
  // what the page may load: a file of the app's own (Capacitor's local server), a picked folder's document (content://)
  const urlOfFile = p => !p ? null : fake ? fakeUrl(p) : fileUrl(p);
  // (a content:// page gets '#p' so the reader's "?t=<size>" lands in the fragment, never in the document's address)
  const imgUrl = src => fake ? fakeUrl(src) : fileUrl(src) + (/^content:/.test(src) ? '#p' : '');
  const pdfUrl = src => fake ? fakePdfUrl(src) : fileUrl(src);
  const coverKey = it => (it.id + '-' + (it.size || 0)).replace(/[^A-Za-z0-9._-]/g, '_');
  async function libraryCover(id, side) {
    await dbReady; const it = lib.items.get(String(id)); if (!it) return null;
    const back = side === 'back';
    if (it.type === 'dir') { const f = back ? it.files[it.files.length - 1] : it.files[0]; return f ? imgUrl(f) : null; }
    if (back) return null; // (the back cover of a PDF or an archive would mean opening all of it)
    const have = db.covers[coverKey(it)]; if (have) return urlOfFile(have);
    return makeCover(it);
  }
  // covers nobody made yet (a PDF or an archive copied over from the PC): one at a time, only in quiet moments
  const coverQ = []; let coverBusy = false;
  function makeCover(it) { return new Promise(res => { coverQ.push({ it, res }); pumpCovers(); }); }
  async function pumpCovers() {
    if (coverBusy) return; coverBusy = true;
    try { while (coverQ.length) { const { it, res } = coverQ.shift(); let f = null; try { await idleTurn(); f = await coverFor(it); } catch (e) { log('reading: cover', it.title, e && e.message); } res(f ? urlOfFile(f) : null); } }
    finally { coverBusy = false; }
  }
  async function coverFor(it) {
    const key = coverKey(it); if (db.covers[key]) return db.covers[key];
    let file = null;
    if (it.type === 'arch') { const r = await N.readingZip({ src: it.src, key: 'c-' + key, first: true }); file = r && r.files && r.files[0]; }
    else if (it.type === 'pdf') file = await pdfCover(it, key);
    if (file) { db.covers[key] = file; saveDb(); }
    return file;
  }
  async function pdfCover(it, key) {
    const L = await pdfLib(); if (!L) return null;
    let doc = null;
    try {
      doc = await L.getDocument({ url: pdfUrl(it.src), isEvalSupported: false }).promise;
      await idleTurn();
      const page = await doc.getPage(1), v0 = page.getViewport({ scale: 1 }), v = page.getViewport({ scale: 760 / Math.max(1, v0.height) });
      const c = document.createElement('canvas'); c.width = Math.round(v.width); c.height = Math.round(v.height);
      const x = c.getContext('2d', { willReadFrequently: true }); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); // (drawn on the CPU: the graphics card stays the museum's)
      await page.render({ canvasContext: x, viewport: v }).promise; page.cleanup();
      const b64 = await toJpegB64(c); c.width = c.height = 0;
      const r = await N.readingCover({ name: key, b64 }); return r && r.ok ? r.file : null;
    } finally { if (doc) try { doc.destroy(); } catch {} }
  }
  async function libraryPages(id) {
    await dbReady; const it = lib.items.get(String(id)); if (!it) throw new Error('Not in the library any more.');
    if (it.type === 'pdf') return { type: 'pdf', url: pdfUrl(it.src) };
    if (it.type === 'dir') return { type: 'images', urls: it.files.map(imgUrl) };
    const r = await N.readingZip({ src: it.src, key: 'p-' + coverKey(it) });
    return { type: 'images', urls: ((r && r.files) || []).map(urlOfFile) };
  }
  // pdf.js: Capacitor's file server answers byte-range requests with the whole file, so a PDF from it is always read as one
  // stream (the reader's own getDocument calls included)
  (function rangesOff() {
    let real = window.pdfjsLib;
    const wrap = L => {
      if (!L || L.__bsReading) return L;
      const w = {}; for (const k of Object.keys(L)) { try { w[k] = L[k]; } catch {} }
      const gd = L.getDocument;
      w.getDocument = src => {
        if (typeof src === 'string' && /_capacitor_(file|content)_/.test(src)) src = { url: src };
        if (src && typeof src === 'object' && typeof src.url === 'string' && /_capacitor_(file|content)_/.test(src.url)) src = Object.assign({}, src, { disableRange: true });
        return gd.call(L, src);
      };
      Object.defineProperty(w, '__bsReading', { value: true });
      return w;
    };
    try { Object.defineProperty(window, 'pdfjsLib', { configurable: true, enumerable: true, get: () => real, set: v => { real = wrap(v); } }); if (real) real = wrap(real); } catch {}
  })();
  // a download is in place (or a file went): looked through again once things are quiet
  let rescanT = 0; function rescanSoon(ms) { clearTimeout(rescanT); rescanT = setTimeout(() => { lib.at = 0; rescan().then(() => { paintAll(); repaintSettings(); }).catch(() => {}); }, ms == null ? 600 : ms); }
  const ownedFile = id => { const o = db.owned[id]; if (!o || !o.file) return null; return !lib.at || lib.byFile.has(o.file) || (o.files > 1) ? o.file : null; };

  // ---------- downloads: two at a time, each from where it got to ----------
  const DL_PAR = 2, dl = { jobs: new Map(), q: [], running: 0, legacy: [] };
  dbReady.then(() => { for (const [id, p] of Object.entries(db.pend || {})) if (okId(id) && p && !dl.jobs.has(id)) dl.jobs.set(id, Object.assign({ id, state: 'paused', bytes: 0, total: p.size || 0, err: 'Paused: press it to carry on' }, p)); });
  const active = () => [...dl.jobs.values()].filter(j => j.state === 'run' || j.state === 'queued').length;
  function download(it, kind, series) {
    const was = dl.jobs.get(it.id); if (was && (was.state === 'run' || was.state === 'queued')) return was;
    const j = Object.assign(was || {}, { id: it.id, title: it.title, date: it.date || '', thumb: it.thumb || '', kind: kind === 'guide' ? 'guide' : 'magazine', series: series || '', state: 'queued', bytes: 0, err: '', at: Date.now() });
    if (!j.done) j.done = new Promise((res, rej) => { j.res = res; j.rej = rej; }); j.done.catch(() => {});
    dl.jobs.set(j.id, j); db.pend[j.id] = { title: j.title, date: j.date, thumb: j.thumb, kind: j.kind, series: j.series, size: j.total || 0 }; saveDb(true);
    dl.q.push(j); pump(); paintJob(j); repaintSettings();
    return j;
  }
  function pump() { while (dl.running < DL_PAR && dl.q.length) { const j = dl.q.shift(); if (j.state !== 'queued') continue; dl.running++; runJob(j).finally(() => { dl.running--; pump(); }); } }
  async function runJob(j) {
    j.state = 'run'; j.err = ''; paintJob(j);
    let outcome;
    try {
      const c = await check(j.id);
      if (!c.ok) throw new Error(whyText(c));
      const where = saveRoot(), bundle = c.type === 'bundle', list = bundle ? c.files : [c.files[0]], alts = bundle ? [] : c.files.slice(1);
      j.total = c.size || 0; let base = 0, last = null, got = 0;
      for (let k = 0; k < list.length; k++) {
        let f = list[k], r = null;
        for (;;) {
          j.nid = (j.id + (bundle ? '-' + (k + 1) : '')).slice(0, 140); j.base = base;
          r = await N.readingDownload({ id: j.nid, url: dlUrl(j.id, f.name), size: f.size || 0, tree: where.tree, kind: j.kind,
            series: bundle ? [j.series, j.title].filter(Boolean).join(' · ').slice(0, 110) : j.series, name: bundle ? titleOf(f.name.split('/').pop()) : j.title, ext: f.ext === 'cbz' || f.ext === 'zip' ? f.ext : 'pdf' });
          if (r && r.ok) break;
          if (r && r.missing && alts.length) { f = alts.shift(); j.total = f.size || j.total; continue; }
          break;
        }
        if (j.cancel || (r && r.cancelled)) throw Object.assign(new Error('Cancelled.'), { cancelled: true });
        if (!r || !r.ok) { if (bundle && got) { log('reading: bundle file skipped', f.name, r && r.error); base += f.size || 0; continue; } throw new Error((r && r.error) || "The download didn't finish."); }
        base += +r.size || f.size || 0; last = r; got++;
      }
      if (!last) throw new Error("The download didn't finish.");
      db.owned[j.id] = { kind: j.kind, title: j.title, file: last.file, name: last.name, saved: last.saved, size: base, files: got, at: Date.now() };
      delete db.pend[j.id];
      if (!bundle) { // the archive's own picture of page 1 as the cover (never opening a 100 MB PDF just for that)
        const key = coverKey({ id: idOf(last.file), size: last.size || base });
        try { const cv = await N.readingCover({ name: key, urls: [`https://archive.org/download/${encodeURIComponent(j.id)}/page/n0_w800.jpg`, `https://archive.org/services/img/${encodeURIComponent(j.id)}`] }); if (cv && cv.ok) db.covers[key] = cv.file; } catch {}
      }
      saveDb(true);
      j.state = 'done'; j.bytes = j.total = base; j.file = last.file; j.saved = last.saved; j.existed = !!last.existed;
      say(`${last.existed ? 'Already on this device' : 'Saved'}: ${j.title}`);
      if (!U.open && Shelf_ok()) toast(`${last.existed ? 'Already have' : 'Saved to your ' + (j.kind === 'guide' ? 'guides' : 'magazines')}: ${j.title}`);
      rescanSoon(); outcome = { existed: !!last.existed, name: last.name, count: got > 1 ? got : 0 };
      j.res && j.res(outcome);
    } catch (e) {
      if (e && e.cancelled) { j.state = 'cancelled'; dl.jobs.delete(j.id); delete db.pend[j.id]; saveDb(); say('Cancelled: ' + j.title); }
      else { j.state = 'failed'; j.err = (e && e.message) || "The download didn't finish."; log('reading: download failed', j.id, j.err); say(j.err, true); }
      j.rej && j.rej(e && e.cancelled ? new Error('Cancelled.') : e);
    } finally { j.cancel = false; j.done = null; paintJob(j); repaintSettings(); }
  }
  function cancelJob(id) {
    const j = dl.jobs.get(id); if (!j) return false;
    if (j.state === 'queued') { j.state = 'cancelled'; dl.q = dl.q.filter(x => x !== j); dl.jobs.delete(id); delete db.pend[id]; saveDb(); if (j.rej) j.rej(new Error('Cancelled.')); j.done = null; }
    else if (j.state === 'run') { j.cancel = true; if (j.nid) Promise.resolve(N.readingCancel({ id: j.nid })).catch(() => {}); }
    else { dl.jobs.delete(id); delete db.pend[id]; saveDb(); } // a failed / paused one: forgotten (its half file goes with the next try)
    paintJob(j); repaintSettings(); return true;
  }
  const progressFns = [];
  Promise.resolve().then(() => N.addListener && N.addListener('readingProgress', e => {
    if (!e) return; for (const j of dl.jobs.values()) if (j.nid === e.id && j.state === 'run') {
      j.bytes = (j.base || 0) + (+e.bytes || 0); if (!j.total && +e.total > 0) j.total = +e.total; j.conns = +e.conns || 0; paintJob(j);
      for (const f of progressFns) try { f({ id: j.id, bytes: j.bytes, total: j.total, unit: 'bytes' }); } catch {}
      repaintSettings(); break; }
  })).catch(() => {});
  const Shelf_ok = () => { try { return window.Shelf && Shelf.getMode && /^(browse|details|museum)$/.test(Shelf.getMode()); } catch { return false; } };
  let repT = 0;
  function repaintSettings() { if (repT) return; repT = setTimeout(() => { repT = 0; try { if (window.Settings && Settings.isOpen && Settings.isOpen() && Settings.active && Settings.active()) Settings.repaint(); } catch {} }, 900); }

  // ---------- the shelves ----------
  const MAGS = [
    ['np', 'Nintendo Power', 'title:("nintendo power")', 'date asc'],
    ['egm', 'Electronic Gaming Monthly', 'title:("electronic gaming monthly") OR collection:(electronic-gaming-monthly)', 'date asc'],
    ['gamepro', 'GamePro', 'title:(gamepro)', 'date asc'],
    ['gi', 'Game Informer', 'title:("game informer")', 'date asc'],
    ['opm', 'PlayStation magazines', 'title:("playstation magazine" OR "official playstation")', 'date asc'],
    ['onm', 'Official Nintendo Magazine', 'title:("official nintendo magazine" OR "nintendo magazine system")', 'date asc'],
    ['sega', 'Sega magazines', 'title:("sega visions" OR "sega power" OR "mean machines" OR "sega saturn magazine" OR "dreamcast magazine")', 'date asc'],
    ['xbox', 'Xbox magazines', 'title:("official xbox magazine" OR "xbox nation")', 'date asc'],
    ['retro', 'Retro Gamer', 'title:("retro gamer")', 'date asc']
  ].map(([id, name, q, sort]) => ({ id, name, q, sort, kind: 'magazine', series: /magazines$/.test(name) ? '' : name, group: 'Magazines' }));
  const GUIDES = [
    ['g-npg', "Nintendo Player's Guides", 'title:("player\'s guide" OR "players guide" OR "nintendo power guide")'],
    ['g-prima', 'Prima official guides', 'title:(prima) AND title:(guide)'],
    ['g-brady', 'BradyGames guides', 'title:(bradygames OR "brady games" OR brady) AND title:(guide)'],
    ['g-versus', 'Versus Books & Piggyback', 'title:("versus books" OR piggyback) AND title:(guide)']
  ].map(([id, name, q]) => ({ id, name, q, sort: 'downloads desc', kind: 'guide', series: '', group: 'Strategy guides' }));
  const CON_WORDS = { gc: ['gamecube'], wii: ['wii'], wiiu: ['"wii u"'], sw: ['"nintendo switch"'], n64: ['"nintendo 64"', 'n64'], snes: ['"super nintendo"', 'snes', '"super nes"'],
    nes: ['nes', '"nintendo entertainment system"'], gb: ['"game boy"', 'gameboy'], gbc: ['"game boy color"'], gba: ['"game boy advance"', 'gba'], nds: ['"nintendo ds"'], n3ds: ['3ds'],
    psx: ['playstation', 'psx'], ps2: ['"playstation 2"', 'ps2'], psp: ['psp'], megadrive: ['genesis', '"mega drive"'], saturn: ['saturn'], dreamcast: ['dreamcast'],
    mastersystem: ['"master system"'], gamegear: ['"game gear"'], pcengine: ['turbografx', '"pc engine"'], neogeo: ['"neo geo"'],
    segacd: ['"sega cd"', '"mega cd"'], sega32x: ['"32x"'], atari2600: ['"atari 2600"'], atarilynx: ['"atari lynx"'], wonderswan: ['wonderswan'], dos: ['"ms-dos"', '"pc games"'] };
  const CON_NAME = { gc: 'GameCube', wii: 'Wii', wiiu: 'Wii U', sw: 'Switch', n64: 'Nintendo 64', snes: 'Super Nintendo', nes: 'NES', gb: 'Game Boy', gbc: 'Game Boy Color', gba: 'Game Boy Advance',
    nds: 'Nintendo DS', n3ds: 'Nintendo 3DS', psx: 'PlayStation', ps2: 'PlayStation 2', psp: 'PSP', megadrive: 'Genesis / Mega Drive', saturn: 'Saturn', dreamcast: 'Dreamcast',
    mastersystem: 'Master System', gamegear: 'Game Gear', pcengine: 'TurboGrafx-16', neogeo: 'Neo Geo', segacd: 'Sega CD', sega32x: '32X', atari2600: 'Atari 2600', atarilynx: 'Lynx', wonderswan: 'WonderSwan', dos: 'DOS' };
  const conShelf = id => ({ id: 'c-' + id, name: CON_NAME[id] + ' guides', q: `title:(guide OR walkthrough OR strategy) AND (title:(${CON_WORDS[id].join(' OR ')}) OR subject:(${CON_WORDS[id].join(' OR ')}))`, sort: 'downloads desc', kind: 'guide', series: CON_NAME[id], group: 'Guides for your consoles' });
  function shelves() {
    const mine = (st.library || []).filter(s => s && s.kind === 'console' && (s.games || []).length && CON_WORDS[s.id]).map(s => s.id);
    const cons = mine.length ? mine : ['snes', 'n64', 'psx', 'gc'];
    return [{ id: 'search', name: 'Search', search: true, group: '' }, { id: 'mine', name: 'My downloads', mine: true, group: '' }, ...MAGS, ...GUIDES,
      ...cons.slice(0, 10).map(conShelf).map(s => mine.length ? s : Object.assign(s, { group: 'Guides by console' }))];
  }

  // ---------- the store screen ----------
  const COLS = 6;
  const U = { open: false, el: null, zone: 'grid', list: [], si: 0, ri: 0, hi: 1, kind: 'magazine', text: '', plain: false, items: [], cur: 0, page: 0, total: 0, more: false,
    loading: false, err: '', gen: 0, osk: false, ok: [0, 0], from: '', onClose: null, msgT: 0, fullT: 0, io: null, cards: [], checking: 0 };
  const shelf = () => U.list[U.si] || U.list[0];
  const HEAD = ['back', 'search', 'magazine', 'guide'];
  function build() {
    if (U.el) return;
    const el = document.createElement('div'); el.id = 'bsReading'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Magazines & guides');
    el.innerHTML = `<header class="brd-head">
        <button class="brd-back" type="button" data-h="back" aria-label="Back"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></button>
        <div class="brd-ht"><div class="brd-kick">Internet Archive · free to download</div><h1 class="brd-title">Magazines &amp; guides</h1></div>
        <label class="brd-search" data-h="search"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>
          <input class="brd-input" type="search" enterkeyhint="search" autocomplete="off" autocorrect="off" spellcheck="false" placeholder="Search magazines and guides"><kbd class="brd-yk">Y</kbd></label>
        <div class="brd-kinds" role="group" aria-label="Search for"><button type="button" data-h="magazine">Magazines</button><button type="button" data-h="guide">Guides</button></div>
      </header>
      <nav class="brd-rail" aria-label="Shelves"></nav>
      <main class="brd-main"><div class="brd-mhead"><h2 class="brd-stitle"></h2><span class="brd-count"></span></div>
        <div class="brd-wrap"><div class="brd-grid"></div><div class="brd-empty"></div><div class="brd-more"></div></div></main>
      <footer class="brd-info"><div class="brd-it"><b></b><span></span></div><button class="brd-act" type="button"></button>
        <div class="brd-hints">${[['lr', 'L R', 'Shelf'], ['y', 'Y', 'Search'], ['x', 'X', 'Cancel'], ['b', 'B', 'Back']].map(([k, b, t]) => `<button type="button" class="brd-hint" data-k="${k}"><kbd>${b}</kbd>${t}</button>`).join('')}</div></footer>
      <div class="brd-msg" aria-live="polite"></div>
      <div class="brd-osk" aria-label="Keyboard"></div>`;
    document.body.appendChild(el);
    const q = s => el.querySelector(s);
    Object.assign(U, { el, rail: q('.brd-rail'), grid: q('.brd-grid'), wrap: q('.brd-wrap'), empty: q('.brd-empty'), moreEl: q('.brd-more'), stitle: q('.brd-stitle'), count: q('.brd-count'),
      itB: q('.brd-it b'), itS: q('.brd-it span'), act: q('.brd-act'), msg: q('.brd-msg'), input: q('.brd-input'), oskEl: q('.brd-osk'), xHint: q('.brd-hint[data-k="x"]') });
    U.heads = HEAD.map(h => q(`[data-h="${h}"]`));
    // touch / mouse
    q('.brd-back').onclick = () => close();
    U.heads[2].onclick = () => setKind('magazine', true); U.heads[3].onclick = () => setKind('guide', true);
    U.act.onclick = () => { wake(); primary(); };
    el.querySelectorAll('.brd-hint').forEach(b => b.onclick = () => { wake(); act(b.dataset.k === 'lr' ? 'rb' : b.dataset.k); });
    U.rail.addEventListener('click', e => { const b = e.target.closest('.brd-shelf'); if (!b) return; wake(); U.ri = +b.dataset.i; pickShelf(U.ri); setZone('rail'); });
    U.grid.addEventListener('click', e => { const c = e.target.closest('.brd-card'); if (!c) return; wake(); const i = +c.dataset.i;
      if (U.zone === 'grid' && U.cur === i) primary(); else { U.cur = i; setZone('grid'); snd('tick', { dir: 1 }); } });
    U.empty.addEventListener('click', e => { const b = e.target.closest('[data-q]'); if (b) { wake(); search(b.dataset.q); } });
    U.wrap.addEventListener('scroll', () => { if (U.more && !U.loading && U.wrap.scrollTop + U.wrap.clientHeight > U.wrap.scrollHeight - 700) loadMore(); }, { passive: true });
    U.input.addEventListener('focus', () => { if (U.osk) { U.osk = false; paintOsk(); } U.zone = 'head'; U.hi = 1; paintFocus(); });
    U.input.addEventListener('input', () => { U.text = U.input.value; });
    el.addEventListener('wheel', e => e.stopPropagation(), { passive: true });
    U.oskEl.addEventListener('click', e => { const b = e.target.closest('.brd-key'); if (!b) return; e.preventDefault(); wake(); U.ok = [+b.dataset.r, +b.dataset.c]; press(); paintOsk(); });
    U.io = 'IntersectionObserver' in window ? new IntersectionObserver(es => { for (const x of es) if (x.isIntersecting) { const img = x.target; U.io.unobserve(img); if (img.dataset.src) img.src = img.dataset.src; } }, { root: U.wrap, rootMargin: '500px 0px' }) : null;
    // keys (and Android's back button, which arrives as Escape): taken before the shelf / Settings / museum see them
    addEventListener('keydown', e => {
      if (!U.open) return;
      if (document.activeElement === U.input && !U.osk) { // typing with Android's own keyboard (the field was tapped)
        e.stopImmediatePropagation();
        if (e.key === 'Enter') { e.preventDefault(); U.input.blur(); search(U.input.value); }
        else if (e.key === 'Escape' || e.key === 'ArrowDown') { e.preventDefault(); U.input.blur(); setZone(U.items.length ? 'grid' : 'rail'); }
        return;
      }
      const m = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Enter: 'a', ' ': 'a', Escape: 'b', Backspace: 'b', y: 'y', Y: 'y', x: 'x', X: 'x', PageUp: 'lb', PageDown: 'rb', q: 'lb', e: 'rb', '/': 'y' }[e.key];
      e.preventDefault(); e.stopImmediatePropagation(); wake();
      if (U.osk && !/^Arrow/.test(e.key)) { // a keyboard plugged in while the on-screen one is up: typed straight in
        if (e.key === 'Enter') search(U.text);
        else if (e.key === 'Backspace') { U.text = U.text.slice(0, -1); U.input.value = U.text; paintOsk(); }
        else if (e.key === 'Escape') { U.osk = false; paintOsk(); }
        else if (e.key.length === 1 && /[\p{L}\p{N} '&.-]/u.test(e.key)) typeText(e.key);
        return;
      }
      if (m && (!e.repeat || /up|down|left|right/.test(m))) act(m, e.repeat);
    }, true);
    addEventListener('keyup', e => { if (U.open && document.activeElement !== U.input) e.stopImmediatePropagation(); }, true);
  }
  function open(o) {
    o = o || {}; build();
    if (U.open) return true;
    U.open = true; U.from = o.from || ''; U.onClose = typeof o.onClose === 'function' ? o.onClose : null;
    U.kind = o.kind === 'guide' || o.kind === 'magazine' ? o.kind : U.kind || 'magazine';
    U.list = shelves(); renderRail();
    const want = o.shelf ? U.list.findIndex(s => s.id === o.shelf) : U.list.findIndex(s => s.kind === U.kind && !s.search);
    U.el.classList.add('on'); document.body.classList.add('brd-open');
    clearTimeout(U.fullT); U.fullT = setTimeout(() => { if (U.open) document.body.classList.add('brd-full'); }, 260); // after the fade in: nothing behind it is drawn
    if (U.from === 'museum') try { Museum.setPaused(true, 'store'); } catch {}
    pad.primed = false; held.clear(); U.osk = false; paintOsk();
    pickShelf(want < 0 ? 2 : want, true); U.ri = U.si; U.zone = 'grid';
    paintKinds(); paintFocus();
    rescan().catch(() => {}); // "Saved" marks for what's on the device
    snd('panel');
    return true;
  }
  function close() {
    if (!U.open) return; snd('back');
    U.open = false; U.osk = false; paintOsk(); try { U.input.blur(); } catch {}
    clearTimeout(U.fullT); document.body.classList.remove('brd-full', 'brd-open'); U.el.classList.remove('on');
    if (U.from === 'museum') try { Museum.setPaused(false, 'store'); } catch {}
    const cb = U.onClose; U.onClose = null;
    setTimeout(() => { if (!U.open) { U.grid.textContent = ''; U.cards = []; } }, 400); // its pictures go once it has faded out
    if (cb) setTimeout(() => { try { cb(); } catch (e) { console.warn('reading: back', e); } }, 0);
  }
  function say(m, bad) { if (!U.el) return; clearTimeout(U.msgT); U.msg.textContent = m; U.msg.classList.toggle('bad', !!bad); U.msg.classList.add('on'); U.msgT = setTimeout(() => U.msg.classList.remove('on'), 3200); }

  function renderRail() {
    let g = null, h = '';
    U.list.forEach((s, i) => { if (s.group && s.group !== g) { g = s.group; h += `<div class="brd-group">${esc(g)}</div>`; }
      const ic = s.search ? '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>' : s.mine ? '<svg viewBox="0 0 24 24"><path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/></svg>' : '';
      h += `<button type="button" class="brd-shelf${s.search ? ' search' : s.mine ? ' mine' : ''}" data-i="${i}"><span>${ic}${esc(s.name)}</span><small></small></button>`; });
    U.rail.innerHTML = h; U.shelfEls = [...U.rail.querySelectorAll('.brd-shelf')];
  }
  function pickShelf(i, now) {
    i = Math.max(0, Math.min(U.list.length - 1, i));
    if (i === U.si && !now && U.items.length) return;
    U.si = i; const s = shelf(); U.shelfEls.forEach((b, k) => b.classList.toggle('on', k === i));
    if (s.kind && !s.search) U.kind = s.kind;
    paintKinds(); clearTimeout(U.pickT);
    reset(); U.stitle.textContent = s.search ? (U.text ? `“${U.text}”` : 'Search') : s.name;
    if (now) loadMore(); else U.pickT = setTimeout(loadMore, 220); // (moving down the rail doesn't ask archive.org for every shelf passed)
  }
  function reset() { U.gen++; U.items = []; U.cur = 0; U.page = 0; U.total = 0; U.more = true; U.err = ''; U.plain = false; U.loading = false; U.grid.textContent = ''; U.cards = []; U.wrap.scrollTop = 0; paintStatus(); paintInfo(); }
  async function loadMore() {
    const s = shelf(), gen = U.gen;
    if (U.loading || !U.more) return;
    if (s.mine) { U.items = mineItems(); U.more = false; appendCards(U.items, true); paintStatus(); paintInfo(); return; }
    if (s.search && !String(U.text).trim()) { U.more = false; paintStatus(); return; }
    U.loading = true; paintStatus();
    try {
      const p = U.page + 1; let r;
      if (s.search) { r = await runSearch(query(U.text, U.kind, U.plain), p);
        if (!r.docs.length && p === 1 && !U.plain && gen === U.gen) { U.plain = true; r = await runSearch(query(U.text, U.kind, true), p); } }
      else r = await runSearch(`(${s.q}) AND ${RESTRICT}`, p, s.sort);
      if (gen !== U.gen) return;
      const have = new Set(U.items.map(x => x.id)), add = r.docs.filter(d => d && okId(d.identifier) && !have.has(d.identifier)).map(docItem);
      add.forEach(x => { x.kind = s.search ? U.kind : s.kind; x.series = s.search ? (x.kind === 'magazine' ? seriesOf(x.title) : '') : (s.series || (s.kind === 'magazine' ? seriesOf(x.title) : '')); });
      U.page = p; U.total = r.total; U.more = add.length > 0 && p * ROWS < r.total && p < 20;
      U.items.push(...add); appendCards(add);
      if (U.toGrid && U.items.length && U.zone === 'rail') { U.zone = 'grid'; paintFocus(true); } U.toGrid = false; // (a search just made: its covers take the cursor)
      checkSoon();
    } catch (e) { if (gen === U.gen) { U.err = (e && e.message) || "archive.org didn't answer"; U.more = false; } }
    finally { if (gen === U.gen) { U.loading = false; paintStatus(); paintInfo(); } }
  }
  function mineItems() {
    const out = [], seen = new Set();
    for (const j of [...dl.jobs.values()].sort((a, b) => (b.at || 0) - (a.at || 0))) { if (j.state === 'cancelled') continue; seen.add(j.id); out.push({ id: j.id, title: j.title, date: j.date, thumb: j.thumb || thumbOf(j.id), kind: j.kind, series: j.series }); }
    for (const [id, o] of Object.entries(db.owned).sort((a, b) => (b[1].at || 0) - (a[1].at || 0))) if (!seen.has(id) && okId(id)) out.push({ id, title: o.title || id, date: '', thumb: thumbOf(id), kind: o.kind, series: '' });
    return out;
  }
  const thumbOf = id => fake ? fakeThumb(id) : `https://archive.org/services/img/${encodeURIComponent(id)}`;
  function search(text) {
    text = String(text || '').trim(); U.text = text; U.input.value = text; U.osk = false; paintOsk();
    const si = U.list.findIndex(s => s.search); U.ri = si;
    if (!text) { pickShelf(si, true); setZone('rail'); return; }
    if (!terms(text).length) { say('Type a word or two to look for', true); return; }
    U.toGrid = true; pickShelf(si, true); setZone('grid');
  }
  function setKind(k, user) {
    if (U.kind === k) return; U.kind = k; paintKinds();
    if (user && shelf().search && U.text) pickShelf(U.si, true);
    else if (user && !shelf().search) { const i = U.list.findIndex(s => s.kind === k && !s.search && !s.mine); if (i >= 0) { U.ri = i; pickShelf(i, true); } }
  }

  // ---------- the cover grid ----------
  function appendCards(list, replace) {
    if (replace) { U.grid.textContent = ''; U.cards = []; }
    const frag = document.createDocumentFragment(), start = U.cards.length;
    list.forEach((it, k) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'brd-card'; b.dataset.i = start + k;
      b.innerHTML = `<div class="brd-cov"><img alt="" decoding="async"><span class="brd-ph">${esc(it.title)}</span><span class="brd-badge"></span><i class="brd-bar"><b></b></i></div><div class="brd-ct"></div><div class="brd-cm"><span class="y"></span><span class="s"></span></div>`;
      b.querySelector('.brd-ct').textContent = it.title;
      const img = b.querySelector('img'); img.dataset.src = it.thumb; img.onload = () => b.classList.add('pic'); img.onerror = () => b.classList.add('nopic');
      if (U.io) U.io.observe(img); else img.src = it.thumb;
      frag.appendChild(b); U.cards.push(b);
    });
    U.grid.appendChild(frag);
    for (let i = start; i < U.cards.length; i++) paintCard(i);
    paintFocus(true);
  }
  const yearOf = d => (/^(\d{4})(?:-(\d{2}))?/.exec(String(d || '')) || []).slice(1).filter(Boolean).join('-').replace(/^(\d{4})-(\d{2})$/, (m, y, mo) => `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+mo - 1] || ''} ${y}`.trim());
  function stateOf(it) {
    const j = dl.jobs.get(it.id), c = it.c;
    if (j && j.state === 'run') return { k: 'run', pct: j.total ? Math.min(1, j.bytes / j.total) : 0 };
    if (j && j.state === 'queued') return { k: 'queued' };
    if ((j && j.state === 'done') || ownedFile(it.id)) return { k: 'owned' };
    if (j && (j.state === 'failed' || j.state === 'paused')) return { k: 'failed', err: j.err };
    if (c && !c.ok) return c.retry ? { k: 'checking' } : { k: 'no', why: whyText(c) }; // (busy / offline: asked again, still downloadable)
    return { k: c ? 'ok' : 'checking' };
  }
  function kindLabel(c) { return !c || !c.ok ? '' : c.type === 'bundle' ? `${c.files.length} PDFs` : (c.files[0].ext || 'pdf').toUpperCase(); }
  function paintCard(i) {
    const b = U.cards[i], it = U.items[i]; if (!b || !it) return;
    const s = stateOf(it), c = it.c;
    b.dataset.s = s.k;
    b.querySelector('.y').textContent = yearOf(it.date || (c && c.date));
    b.querySelector('.s').textContent = s.k === 'no' ? (c.why === 'borrow' ? 'Borrow-only' : c.why === 'nofile' ? 'No PDF' : 'Gone') : c && c.ok ? `${fmtSize(c.size) || 'Size unknown'}${kindLabel(c) !== 'PDF' ? ' · ' + kindLabel(c) : ''}` : c && c.retry ? 'Size later' : '…';
    b.querySelector('.brd-badge').textContent = s.k === 'owned' ? 'Saved' : s.k === 'queued' ? 'Queued' : s.k === 'run' ? Math.round(s.pct * 100) + '%' : s.k === 'failed' ? 'Paused' : '';
    b.querySelector('.brd-bar b').style.transform = `scaleX(${s.k === 'run' ? s.pct.toFixed(3) : 0})`;
    if (i === U.cur) paintInfo();
  }
  function paintJob(j) { if (!U.open) return; U.items.forEach((it, i) => { if (it.id === j.id) paintCard(i); }); if (shelf() && shelf().mine && j.state !== 'run') { const n = mineItems().length; if (n !== U.items.length) { reset(); loadMore(); } } paintRailSubs(); }
  // the sizes: each result's file list, the ones nearest the cursor first, four at a time
  function checkSoon() {
    const gen = U.gen;
    const next = () => { let best = -1, bd = 1e9; U.items.forEach((it, i) => { if (!it.c && !it.asking) { const d = Math.abs(i - U.cur); if (d < bd) { bd = d; best = i; } } }); return best; };
    const worker = async () => { for (;;) { if (gen !== U.gen || !U.open) return; const i = next(); if (i < 0) return; const it = U.items[i]; it.asking = true;
      let c; try { c = await check(it.id); } catch { c = { ok: false, why: 'offline', retry: true }; } it.asking = false; if (gen !== U.gen) return;
      it.c = c; if (c.ok && !it.date && c.date) it.date = c.date; paintCard(i);
      if (c.retry && (it.tries = (it.tries || 0) + 1) < 3) { await sleep(5000); if (gen === U.gen && U.open) { it.c = null; checkSoon(); } return; } } }; // (busy or offline: asked again a couple of times)
    while (U.checking < 4) { U.checking++; worker().finally(() => { U.checking--; }); }
  }
  function paintStatus() {
    const s = shelf(); if (!s || !U.el) return;
    U.count.textContent = s.mine ? (U.items.length ? `${U.items.length} item${U.items.length === 1 ? '' : 's'}` : '') : U.total ? `${U.total.toLocaleString()} found` : '';
    let e = '';
    if (U.err) e = `<b>${esc(U.err)}</b><span>Press A on the shelf to try again.</span>`;
    else if (!U.items.length && U.loading) e = '<b>Looking on the Internet Archive…</b>';
    else if (!U.items.length && s.search && !String(U.text).trim()) e = `<b>Find any magazine or guide</b><span>Press Y (or tap the search box) and type a name, a game or a series.</span><div class="brd-sugg">${(U.kind === 'guide' ? ['Zelda', 'Final Fantasy', 'Pokemon', 'Metroid', 'Resident Evil', 'Sonic'] : ['Nintendo Power', 'EGM', 'GamePro', 'Sega Visions', 'Game Informer', 'Retro Gamer']).map(t => `<button type="button" data-q="${esc(t)}">${esc(t)}</button>`).join('')}</div>`;
    else if (!U.items.length && s.mine) e = '<b>Nothing downloaded yet</b><span>Pick a shelf and press A on a cover to download it. It turns up in the museum\'s reading corner.</span>';
    else if (!U.items.length && !U.more) e = '<b>Nothing found</b><span>Try other words, or the other kind (Magazines / Guides).</span>';
    U.empty.innerHTML = e; U.empty.classList.toggle('on', !!e);
    U.moreEl.textContent = U.items.length && U.loading ? 'Loading more…' : ''; paintRailSubs();
  }
  function paintRailSubs() { if (!U.shelfEls) return; const n = active(); const m = U.list.findIndex(s => s.mine); if (m >= 0) U.shelfEls[m].querySelector('small').textContent = n ? `${n} downloading` : ''; }
  function paintKinds() { U.heads[2].classList.toggle('on', U.kind === 'magazine'); U.heads[3].classList.toggle('on', U.kind === 'guide'); }
  function paintInfo() {
    if (!U.el) return; const it = U.zone === 'grid' ? U.items[U.cur] : null, s = shelf();
    U.xHint.hidden = true;
    if (!it) { U.itB.textContent = U.zone === 'rail' && s ? s.name : 'Magazines & guides';
      U.itS.textContent = U.zone === 'rail' ? (s.search ? 'Search the Internet Archive' : s.mine ? 'Downloads, and what you have' : 'Press right or A to browse it') : `Saved to: ${whereText()}`;
      U.act.hidden = true; return; }
    const st_ = stateOf(it), c = it.c, j = dl.jobs.get(it.id);
    U.itB.textContent = it.title;
    const bits = [yearOf(it.date), c && c.ok ? fmtSize(c.size) + ' · ' + kindLabel(c) : '', it.series ? (it.kind === 'guide' ? 'Guides' : 'Magazines') + ' › ' + it.series : (it.kind === 'guide' ? 'Guides' : 'Magazines')].filter(Boolean);
    let line = bits.join('  ·  '), btn = '', cls = '';
    if (st_.k === 'run') { line = `Downloading ${Math.round(st_.pct * 100)}%  ·  ${fmtSize(j.bytes) || '0 MB'} of ${fmtSize(j.total) || '…'}${j.conns > 1 ? `  ·  ${j.conns} connections` : ''}`; btn = 'Cancel'; cls = 'stop'; U.xHint.hidden = false; }
    else if (st_.k === 'queued') { line = 'Waiting for the downloads before it'; btn = 'Cancel'; cls = 'stop'; U.xHint.hidden = false; }
    else if (st_.k === 'owned') { line = `On this device: in the museum's reading corner  ·  ${line}`; btn = 'Saved ✓'; cls = 'done'; }
    else if (st_.k === 'failed') { line = st_.err || 'Paused'; btn = 'Try again'; U.xHint.hidden = false; }
    else if (st_.k === 'no') { line = `${st_.why}: it can't be downloaded`; btn = ''; }
    else if (st_.k === 'checking') { btn = 'Download'; line += '  ·  checking the size…'; }
    else btn = `Download · ${fmtSize(c.size)}`;
    U.itS.textContent = line; U.act.hidden = !btn; U.act.textContent = btn; U.act.className = 'brd-act' + (cls ? ' ' + cls : '');
  }
  function paintFocus(quiet) {
    if (!U.el) return;
    U.cards.forEach((b, i) => b.classList.toggle('cur', U.zone === 'grid' && i === U.cur));
    U.shelfEls.forEach((b, i) => b.classList.toggle('cur', U.zone === 'rail' && i === U.ri));
    U.heads.forEach((b, i) => b.classList.toggle('cur', U.zone === 'head' && i === U.hi));
    U.el.dataset.zone = U.zone;
    if (U.zone === 'grid') seeCard(U.cur, quiet); if (U.zone === 'rail') { const b = U.shelfEls[U.ri]; if (b) b.scrollIntoView({ block: 'nearest' }); }
    paintInfo();
  }
  function seeCard(i, quiet) {
    const c = U.cards[i]; if (!c) return; const top = c.offsetTop, h = c.offsetHeight, w = U.wrap, view = w.clientHeight;
    if (top - 14 < w.scrollTop) w.scrollTo({ top: Math.max(0, top - 14), behavior: quiet ? 'auto' : 'smooth' });
    else if (top + h + 14 > w.scrollTop + view) w.scrollTo({ top: top + h + 14 - view, behavior: quiet ? 'auto' : 'smooth' });
    if (U.more && !U.loading && i >= U.items.length - COLS * 2) loadMore();
  }
  function setZone(z) { U.zone = z; if (z === 'grid' && !U.items.length) U.zone = 'rail'; paintFocus(); }
  // A (or the big button): download / cancel / try again
  function primary() {
    const it = U.items[U.cur]; if (!it) return; const s = stateOf(it);
    if (s.k === 'run' || s.k === 'queued') { cancelJob(it.id); snd('back'); return; }
    if (s.k === 'owned') { say('It\'s in the museum\'s reading corner'); return; }
    if (s.k === 'no') { say(`${s.why}: it can't be downloaded`, true); snd('error'); return; }
    if (it.c && !it.c.ok && it.c.retry) it.c = null;
    download(it, it.kind || U.kind, it.series); snd('open'); say(`Downloading: ${it.title}`);
  }

  // ---------- the on-screen keyboard (a controller; a finger on the search box gets Android's own) ----------
  const KEYS = [['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'], ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'], ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', "'"], ['z', 'x', 'c', 'v', 'b', 'n', 'm', '-', '&', '.'],
    [['space', 'Space'], ['del', '⌫'], ['clear', 'Clear'], ['go', 'Search']]];
  function openOsk() { U.osk = true; U.ok = [1, 0]; U.input.blur(); paintOsk(); snd('panel'); }
  function paintOsk() {
    if (!U.el) return; U.el.classList.toggle('typing', !!U.osk);
    if (!U.osk) { U.oskEl.textContent = ''; return; }
    if (!U.oskEl.firstChild) U.oskEl.innerHTML = `<div class="brd-otext"></div>` + KEYS.map((row, r) => `<div class="brd-krow">${row.map((k, c) => Array.isArray(k) ? `<button type="button" class="brd-key ${k[0]}" data-r="${r}" data-c="${c}">${k[1]}</button>` : `<button type="button" class="brd-key" data-r="${r}" data-c="${c}">${esc(k)}</button>`).join('')}</div>`).join('') +
      `<div class="brd-ohint"><kbd>A</kbd>Type <kbd>X</kbd>Delete <kbd>Y</kbd>Space <kbd>B</kbd>Close</div>`;
    U.oskEl.querySelector('.brd-otext').innerHTML = esc(U.text) + '<i class="caret"></i>';
    U.oskEl.querySelectorAll('.brd-key').forEach(b => b.classList.toggle('cur', +b.dataset.r === U.ok[0] && +b.dataset.c === U.ok[1]));
  }
  function typeText(t) { U.text = (U.text + t).slice(0, 80); U.input.value = U.text; paintOsk(); }
  function press() {
    const k = KEYS[U.ok[0]][U.ok[1]], id = Array.isArray(k) ? k[0] : null;
    if (!id) { typeText(k); snd('tick', { dir: 1 }); return; }
    if (id === 'space') typeText(' ');
    else if (id === 'del') { U.text = U.text.slice(0, -1); U.input.value = U.text; paintOsk(); }
    else if (id === 'clear') { U.text = ''; U.input.value = ''; paintOsk(); }
    else if (id === 'go') { search(U.text); return; }
    snd('tick', { dir: 1 });
  }
  function oskMove(a) {
    let [r, c] = U.ok; const len = row => KEYS[row].length;
    const frac = (row, col) => (col + 0.5) / len(row);
    if (a === 'left') c = (c - 1 + len(r)) % len(r);
    else if (a === 'right') c = (c + 1) % len(r);
    else { const f = frac(r, c); r = a === 'up' ? Math.max(0, r - 1) : Math.min(KEYS.length - 1, r + 1); c = Math.min(len(r) - 1, Math.floor(f * len(r))); }
    U.ok = [r, c]; paintOsk(); snd('tick', { dir: 1 });
  }

  // ---------- one input for keys, the controller and the hint buttons ----------
  function act(a, rep) {
    if (!U.open) return;
    if (document.activeElement === U.input) { U.input.blur(); if (a === 'b') { setZone(U.items.length ? 'grid' : 'rail'); return; } } // the controller after typing with a finger
    if (U.osk) {
      if (/^(up|down|left|right)$/.test(a)) return oskMove(a);
      if (a === 'a') return press();
      if (a === 'x') { U.text = U.text.slice(0, -1); U.input.value = U.text; paintOsk(); return; }
      if (a === 'y') { typeText(' '); return; }
      if (a === 'start') { search(U.text); return; }
      if (a === 'b') { U.osk = false; paintOsk(); snd('back'); return; }
      return;
    }
    if (a === 'b') { close(); return; }
    if (a === 'y') { const si = U.list.findIndex(s => s.search); if (!shelf().search) { U.ri = si; pickShelf(si, true); } U.zone = 'head'; U.hi = 1; paintFocus(); openOsk(); return; }
    if (a === 'lb' || a === 'rb') { const d = a === 'rb' ? 1 : -1; U.ri = Math.max(0, Math.min(U.list.length - 1, U.si + d)); pickShelf(U.ri, true); snd('shelf', { dir: d }); paintFocus(); return; }
    if (a === 'x') { const it = U.zone === 'grid' && U.items[U.cur], j = it && dl.jobs.get(it.id); if (j && j.state !== 'done') { cancelJob(it.id); snd('back'); paintInfo(); } return; }
    if (U.zone === 'grid') {
      const n = U.items.length, c = U.cur % COLS;
      if (a === 'a') return primary();
      if (a === 'left') { if (c === 0) { setZone('rail'); snd('tick', { dir: -1 }); return; } U.cur--; }
      else if (a === 'right') { if (U.cur + 1 >= n || c === COLS - 1) return; U.cur++; }
      else if (a === 'up') { if (U.cur < COLS) { U.zone = 'head'; U.hi = 1; paintFocus(); snd('tick', { dir: -1 }); return; } U.cur -= COLS; }
      else if (a === 'down') { if (U.cur + COLS >= n) { if (Math.floor(U.cur / COLS) === Math.floor((n - 1) / COLS)) { if (U.more) loadMore(); return; } U.cur = n - 1; } else U.cur += COLS; }
      snd('tick', { dir: a === 'left' || a === 'up' ? -1 : 1 }); paintFocus(rep); return;
    }
    if (U.zone === 'rail') {
      if (a === 'up' || a === 'down') { const ri = Math.max(0, Math.min(U.list.length - 1, U.ri + (a === 'up' ? -1 : 1))); if (ri === U.ri) { if (a === 'up') { U.zone = 'head'; U.hi = 0; paintFocus(); } return; } U.ri = ri; pickShelf(ri); snd('tick', { dir: a === 'up' ? -1 : 1 }); paintFocus(); return; }
      if (a === 'right' || a === 'a') { if (U.ri !== U.si) pickShelf(U.ri, true); if (shelf().search && !U.text) { U.zone = 'head'; U.hi = 1; paintFocus(); openOsk(); return; } if (U.err) { U.err = ''; U.more = true; loadMore(); } if (U.items.length) { setZone('grid'); snd('tick', { dir: 1 }); } return; }
      return;
    }
    if (U.zone === 'head') {
      if (a === 'left') { U.hi = Math.max(0, U.hi - 1); paintFocus(); return; }
      if (a === 'right') { U.hi = Math.min(HEAD.length - 1, U.hi + 1); paintFocus(); return; }
      if (a === 'down') { setZone(U.hi === 0 ? 'rail' : 'grid'); return; }
      if (a === 'a') { const h = HEAD[U.hi]; if (h === 'back') close(); else if (h === 'search') openOsk(); else setKind(h, true); }
    }
  }
  // the controller: app.js hands it over through BS_MODAL while the store is up (the studio's way)
  const pad = { primed: false }, held = new Map();
  const BTN = { 0: 'a', 1: 'b', 2: 'x', 3: 'y', 4: 'lb', 5: 'rb', 9: 'start', 12: 'up', 13: 'down', 14: 'left', 15: 'right' }, REP = /^(up|down|left|right)$/;
  function modal(gp, t) {
    try { if (window.Shelf && Shelf.padBlocked && Shelf.padBlocked()) return false; } catch {} // the dimmed screen wakes up first
    const B = i => !!(gp.buttons[i] && (gp.buttons[i].pressed || gp.buttons[i].value > 0.5)), ax = gp.axes || [], on = new Set();
    for (const [i, a] of Object.entries(BTN)) if (B(+i)) on.add(a);
    const x = ax[0] || 0, y = ax[1] || 0, v = Math.abs(y) >= Math.abs(x);
    if (v && y < -0.55) on.add('up'); if (v && y > 0.55) on.add('down'); if (!v && x < -0.55) on.add('left'); if (!v && x > 0.55) on.add('right');
    if (!pad.primed) { pad.primed = true; for (const a of on) held.set(a, Infinity); return true; } // the press that opened it doesn't act here
    for (const a of [...held.keys()]) if (!on.has(a)) held.delete(a);
    for (const a of on) { const h = held.get(a);
      if (h === undefined) { held.set(a, t + 380); wake(); act(a, false); }
      else if (REP.test(a) && t > h) { held.set(a, t + 95); act(a, true); } }
    return true;
  }
  function paintAll() { if (!U.open) return; U.items.forEach((_, i) => paintCard(i)); paintStatus(); paintInfo(); }

  // ---------- Settings → Magazines & guides on Android (the PC's folder rows don't apply here) ----------
  const libSub = () => { const m = lib.list.filter(i => i.kind === 'magazine').length, g = lib.list.length - m;
    return { text: (lib.scanning && !lib.at ? 'Looking…' : `${m} magazine${m === 1 ? '' : 's'} · ${g} guide${g === 1 ? '' : 's'}`) + ' · ' + whereText() }; };
  const storeSub = () => { const n = active(); if (!n) return null; const run = [...dl.jobs.values()].filter(j => j.state === 'run'), b = run.reduce((a, j) => a + (j.bytes || 0), 0), t = run.reduce((a, j) => a + (j.total || 0), 0);
    return { text: `${n} downloading${t ? ` · ${Math.round(b / t * 100)}%` : ''}`, cls: 'warn' }; };
  function patchReading(sections) {
    const sec = (sections || []).find(s => s && s.id === 'reading'); if (!sec || !Array.isArray(sec.rows)) return sections;
    const find = sec.rows.find(r => r && r.t === 'action' && /Internet Archive/.test(r.label || ''));
    sec.lead = 'The museum\'s reading corner: your magazines and strategy guides, and a store of free scans to download.';
    sec.rows = [{ t: 'head', text: 'Store' },
      { t: 'action', label: 'Magazines & guides store', btn: 'Open', keys: 'store nintendo power egm gamepro magazines guides archive.org download internet archive',
        info: 'Classic game magazines and strategy guides from the Internet Archive (archive.org), with each download\'s size shown first. Only scans anyone may download are offered. They download in the background and turn up in the museum\'s reading corner.',
        run: find && typeof find.run === 'function' ? find.run : () => open({ from: 'settings' }), sub: storeSub },
      { t: 'head', text: 'On this device' },
      { t: 'action', label: 'Your magazines & guides', btn: () => lib.scanning ? 'Looking…' : 'Look again', keys: 'reading corner folder magazines guides boxshelf reading pdf cbz',
        info: 'Saved in a "Boxshelf Reading" folder next to your ROMs (Magazines and Guides, a folder per series), or inside Boxshelf when "Where box art is saved" says so. Magazines and Guides folders copied over from the PC (next to the ROMs) are read too: PDF, CBZ, or a folder of page pictures per issue.',
        run: () => { lib.at = 0; rescan().then(repaintSettings, repaintSettings); repaintSettings(); }, sub: libSub }];
    if (!lib.at && !lib.scanning) rescan().then(repaintSettings, () => {});
    return sections;
  }
  const prevPatch = window.BS_SETTINGS_PATCH;
  window.BS_SETTINGS_PATCH = (sections, h) => { let s = sections; if (typeof prevPatch === 'function') { try { s = prevPatch(sections, h) || sections; } catch (e) { console.error('settings patch', e); } } return patchReading(s); };

  // ---------- window.boxshelf: the reading corner's calls, and the Windows finder's (setup.js) backed by the store ----------
  Object.assign(api, {
    library: () => libraryList(),
    libraryCover: (id, side) => libraryCover(id, side),
    libraryPages: id => libraryPages(id),
    openLibraryFolder: async () => false,
    readingWhere: async () => { await ready; const w = whereText(); return { root: w, custom: false, magazines: w + '/Magazines', guides: w + '/Guides' }; },
    archiveSearch: async (text, kind, page, plain) => {
      const k = kind === 'guide' ? 'guide' : 'magazine', p = Math.max(1, Math.min(20, page | 0 || 1));
      let used = !!plain, r = await runSearch(query(text, k, used), p);
      if (!r.docs.length && !used && p === 1) { used = true; r = await runSearch(query(text, k, true), p); }
      return { total: r.total, page: p, plain: used, rows: ROWS, items: r.docs.filter(d => d && okId(d.identifier)).map(d => Object.assign(docItem(d), { pages: +d.imagecount || 0, page: `https://archive.org/details/${encodeURIComponent(d.identifier)}` })) };
    },
    archiveCheck: async ids => { const out = {}; await Promise.all((Array.isArray(ids) ? ids : []).map(String).filter(okId).slice(0, 60).map(async id => { const c = await check(id);
      out[id] = c.ok ? { ok: true, type: c.type === 'bundle' ? 'bundle' : 'file', size: c.size, files: c.files.length, pages: 0, owned: !!ownedFile(id) } : { ok: false, why: whyText(c), retry: !!c.retry, busy: c.why === 'busy' }; })); return out; },
    archiveDownload: async (id, kind, title, series) => { if (!okId(id)) throw new Error('Unknown item.'); if (ownedFile(id)) return { existed: true, name: db.owned[id].name, count: 0 };
      const j = download({ id, title: String(title || id), thumb: thumbOf(id) }, kind, String(series || '')); return j.done ? j.done : { existed: false, name: '', count: 0 }; },
    onArchiveProgress: fn => { if (typeof fn === 'function') progressFns.push(fn); },
    archiveCancel: async id => cancelJob(String(id || ''))
  });
  for (const k of ['readingOld', 'readingImport', 'readingImportStop', 'onReadingImport']) delete api[k]; // (the PC's "bring them over from an earlier folder")

  // ---------- the ways in, once every script is there ----------
  const hook = () => {
    // Settings → Magazines & guides → the store row opens the "reading" classic page: the store instead (Settings is
    // paused underneath, and comes back at the same row when the store closes)
    const S = window.Setup;
    if (S && typeof S.openLegacy === 'function' && !S.__bsReading) { const ol = S.openLegacy;
      S.openLegacy = function (page, o) { if (page === 'reading') { open({ from: 'settings', onClose: o && o.back }); return; } return ol.apply(this, arguments); }; S.__bsReading = true; }
    // the museum's reading corner (X there) mounts the PC finder in a side panel: the store instead
    const IA = window.BoxshelfIA;
    if (IA && typeof IA.mount === 'function' && !IA.__bsReading) { const m0 = IA.mount;
      IA.mount = function (el, kind) { if (el && el.closest && el.closest('#musFind')) { open({ from: 'museum', kind, onClose: () => { const b = document.querySelector('#musFind .mf-close'); if (b) b.click(); } }); return; } return m0.apply(this, arguments); };
      IA.running = () => active(); IA.__bsReading = true; }
    // the controller while the store is up (whatever else reads it through BS_MODAL keeps it otherwise)
    const prev = window.BS_MODAL;
    window.BS_MODAL = (gp, t) => U.open ? modal(gp, t) : (typeof prev === 'function' ? prev(gp, t) : false);
  };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', hook); else hook();

  window.BS_READING = { open, close, isOpen: () => U.open, rescan: () => { lib.at = 0; return rescan().then(l => l.map(pub)); },
  // (beta.7) for the device test's diagnosis: where the scan looks, what that folder lists, and the scan's own state
  diag: async () => { const t = romTree(); let top = null; try { top = t ? (((await N.listDirs({ uri: t.tree })) || {}).dirs || []).map(d => d.name) : null; } catch (e) { top = 'error: ' + (e && e.message); }
    return { tree: t ? { path: t.path, tree: String(t.tree).slice(0, 90) } : null, top, list: lib.list.length, at: lib.at, scanning: !!lib.scanning, artWhere: ui().artWhere || '' }; },
    state: () => ({ zone: U.zone, shelf: shelf() && shelf().id, cur: U.cur, items: U.items.length, kind: U.kind, text: U.text, osk: U.osk, loading: U.loading, err: U.err, head: HEAD[U.hi], rail: U.list[U.ri] && U.list[U.ri].id,
      jobs: [...dl.jobs.values()].map(j => ({ id: j.id, state: j.state, bytes: j.bytes, total: j.total, err: j.err })) }),
    where: () => saveRoot(), _db: () => JSON.parse(JSON.stringify(db)),
    // tests: draw page n of a library item the way the museum's reader does (libraryPages → pdf.js / a picture) → { w, h, ink }
    _renderPage: async (id, n) => {
      const src = await libraryPages(id), c = document.createElement('canvas'), x = c.getContext('2d', { willReadFrequently: true });
      if (src.type === 'pdf') { const L = await pdfLib(); const doc = await L.getDocument({ url: src.url, isEvalSupported: false }).promise;
        try { const pg = await doc.getPage((n || 0) + 1), v = pg.getViewport({ scale: 1 }); c.width = Math.round(v.width); c.height = Math.round(v.height); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); await pg.render({ canvasContext: x, viewport: v }).promise; } finally { doc.destroy(); } }
      else { const im = new Image(); im.src = src.urls[n || 0]; await im.decode(); c.width = im.naturalWidth; c.height = im.naturalHeight; x.drawImage(im, 0, 0); }
      const d = x.getImageData(0, 0, c.width, c.height).data; let ink = 0; for (let i = 0; i < d.length; i += 16) if (d[i] < 235 || d[i + 1] < 235 || d[i + 2] < 235) ink++;
      return { type: src.type, w: c.width, h: c.height, ink: +(ink / (d.length / 16)).toFixed(3) }; } };

  // ---------- the pretend device (?fakeNative=1): a small Internet Archive and a reading folder, deterministic ----------
  function fakeThumb(id) { let h = 0; for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return '__art/' + (h % 4) + '.jpg?ia=' + encodeURIComponent(id); }
  function fakeUrl(p) { p = String(p); if (/^(__art\/|blob:|data:)/.test(p)) return p; let h = 0; for (const ch of p) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return '__art/' + (h % 4) + '.jpg?f=' + h; }
  function fakePdfUrl(src) { const F = window.__fakeReading; if (F.blobs[src]) return F.blobs[src];
    const n = /GamePro/.test(src) ? 2 : 3; return (F.blobs[src] = URL.createObjectURL(new Blob([F.pdf(n)], { type: 'application/pdf' }))); }
  function installFake() {
    const F = window.__fakeReading = { search: [], meta: [], dl: [], saved: [], cancelled: [], covers: [], zips: [], lat: 120, listeners: [], blobs: {}, fs: null };
    const pdf = n => { // a real n-page PDF (a coloured block on each page)
      const objs = [null, '<< /Type /Catalog /Pages 2 0 R >>', ''], kids = [];
      for (let i = 0; i < n; i++) { const p = 3 + i * 2, s = `${(.25 + .25 * i).toFixed(2)} .35 .55 rg 20 20 260 380 re f`; kids.push(p + ' 0 R');
        objs[p] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 420] /Contents ${p + 1} 0 R >>`; objs[p + 1] = `<< /Length ${s.length} >>\nstream\n${s}\nendstream`; }
      objs[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${n} >>`;
      let out = '%PDF-1.4\n'; const off = [];
      for (let k = 1; k < objs.length; k++) { off[k] = out.length; out += `${k} 0 obj\n${objs[k]}\nendobj\n`; }
      const x = out.length;
      return out + `xref\n0 ${objs.length}\n0000000000 65535 f \n` + off.slice(1).map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF`; };
    F.pdf = pdf;
    // the reading files "on the SD card" (kept like the pretend ROM folders): a PC-style Magazines folder copied over
    // with one PDF, and a Guides folder holding an issue as page pictures
    const seed = ['primary:ROMs/Magazines/GamePro/GamePro 1994-05.pdf', 'primary:ROMs/Guides/Mario Guide/001.jpg', 'primary:ROMs/Guides/Mario Guide/002.jpg', 'primary:ROMs/Guides/Mario Guide/003.jpg'];
    try { F.fs = JSON.parse(localStorage.getItem('fake:reading') || 'null'); } catch {}
    if (!Array.isArray(F.fs)) F.fs = seed.map(p => ({ p, size: 3e6 }));
    const saveFs = () => { try { localStorage.setItem('fake:reading', JSON.stringify(F.fs)); } catch {} };
    const idOfTree = t => decodeURIComponent((/\/document\/([^/]+)/.exec(t) || /\/tree\/([^/]+)/.exec(t) || [])[1] || '');
    const treeOnly = t => String(t).replace(/\/document\/.*$/, '');
    const isReading = id => /\/(Boxshelf Reading|Magazines|Guides)(\/|$)/.test(id);
    // the archive: shelves answer with a few issues each; "zelda" finds a guide (PDF), a comic (CBZ), a borrow-only one
    // and one with page scans only; nothing else is found
    const CAT = { 'fk-zelda-guide': ['The Legend of Zelda Official Strategy Guide', '1998-11', 'pdf', 42e6], 'fk-zelda-comic': ['Zelda Comic Collection', '1990', 'cbz', 18e6],
      'fk-zelda-lend': ['Zelda Player\'s Guide (Lending Library)', '1993', 'lend', 30e6], 'fk-zelda-scan': ['Zelda Scans', '1991', 'scan', 0] };
    const shelfDocs = q => { let h = 0; for (const ch of q) h = (h * 31 + ch.charCodeAt(0)) >>> 0; const n = /nintendo power/.test(q) ? 14 : 8, tag = /nintendo power/.test(q) ? 'np' : 's' + (h % 997);
      return Array.from({ length: n }, (_, i) => { const id = `fk-${tag}-${String(i + 1).padStart(3, '0')}`, yr = 1988 + i;
        if (!CAT[id]) CAT[id] = [/nintendo power/.test(q) ? `Nintendo Power Issue ${String(i + 1).padStart(3, '0')} (${yr})` : `Test Magazine ${tag} No. ${i + 1}`, `${yr}-0${1 + i % 9}`, 'pdf', (12 + (h + i * 7) % 70) * 1e6]; return id; }); };
    const h0 = N.httpText;
    N.httpText = async o => {
      const u = String((o && o.url) || ''), dec = decodeURIComponent(u);
      if (/archive\.org\/advancedsearch/.test(u) && /access-restricted-item/.test(dec)) {
        F.search.push(dec); await sleep(F.lat);
        const isShelf = [...MAGS, ...GUIDES].some(s => dec.includes(s.q)) || dec.includes('title:(guide OR walkthrough OR strategy)');
        const p = +((/[?&]page=(\d+)/.exec(u) || [])[1] || 1), ids = isShelf ? shelfDocs(dec) : /title:\(zelda\)/i.test(dec) ? ['fk-zelda-guide', 'fk-zelda-comic', 'fk-zelda-lend', 'fk-zelda-scan'] : [];
        const docs = ids.slice((p - 1) * ROWS, p * ROWS).map(id => ({ identifier: id, title: CAT[id][0], date: CAT[id][1], downloads: 100 }));
        return { status: 200, text: JSON.stringify({ response: { numFound: ids.length, docs } }) };
      }
      const mm = /archive\.org\/metadata\/(fk-[A-Za-z0-9._-]+)/.exec(u);
      if (mm) { const id = mm[1], c = CAT[id]; F.meta.push(id); await sleep(F.lat / 2); if (!c) return { status: 200, text: '{}' };
        const meta = { identifier: id, title: c[0], date: c[1], collection: c[2] === 'lend' ? ['inlibrary'] : ['magazine_rack'] }; if (c[2] === 'lend') meta['access-restricted-item'] = 'true';
        const files = c[2] === 'scan' ? [{ name: id + '_jp2.zip', source: 'derivative', size: '90000000' }] : c[2] === 'cbz' ? [{ name: c[0] + '.cbz', source: 'original', size: String(c[3]) }]
          : [{ name: c[0] + '.pdf', source: 'original', size: String(c[3]), format: 'Image Container PDF' }, { name: id + '_text.pdf', source: 'derivative', size: String(c[3] / 4) }];
        return { status: 200, text: JSON.stringify({ metadata: meta, files }) }; }
      return h0.call(N, o);
    };
    const al0 = N.addListener;
    N.addListener = (ev, fn) => { if (ev === 'readingProgress') { F.listeners.push(fn); return; } return al0.call(N, ev, fn); };
    N.readingDownload = async o => {
      F.dl.push({ id: o.id, url: o.url, tree: o.tree, kind: o.kind, series: o.series, name: o.name, ext: o.ext, size: o.size });
      const total = +o.size || 1e7, steps = 5;
      for (let k = 1; k <= steps; k++) { await sleep(F.lat); if (F.cancelled.includes(o.id)) { F.cancelled = F.cancelled.filter(x => x !== o.id); return { ok: false, cancelled: true, error: 'Cancelled.' }; }
        F.listeners.forEach(f => f({ id: o.id, bytes: Math.round(total * k / steps), total, conns: 4 })); }
      const kd = o.kind === 'guide' ? 'Guides' : 'Magazines', file = `${o.name}.${o.ext}`;
      const dir = o.tree ? `${idOfTree(o.tree)}/Boxshelf Reading/${kd}${o.series ? '/' + o.series : ''}` : `/data/reading/${kd}${o.series ? '/' + o.series : ''}`, p = dir + '/' + file;
      const had = F.fs.find(x => x.p === p); if (!had) { F.fs.push({ p, size: total }); saveFs(); } F.saved.push(p);
      return { ok: true, file: o.tree ? 'content://fake/' + encodeURIComponent(p) : p, name: file, saved: o.tree ? 'folder' : 'app', size: total, existed: !!had };
    };
    N.readingCancel = async ({ id }) => { F.cancelled.push(id); return { ok: true }; };
    N.readingLocal = async () => ({ files: F.fs.filter(x => x.p.startsWith('/data/reading/')).map(x => { const m = /^\/data\/reading\/(Magazines|Guides)\/(?:(.*)\/)?([^/]+)$/.exec(x.p) || [];
      return { kind: m[1] === 'Guides' ? 'guide' : 'magazine', dir: m[2] || '', name: m[3] || '', path: x.p, size: x.size, mtime: 1.7e12 }; }).filter(f => f.name) });
    N.readingCover = async o => { F.covers.push({ name: o.name, urls: o.urls || null, drawn: !!o.b64 }); return { ok: true, file: fakeThumb(o.name) }; };
    N.readingZip = async o => { F.zips.push({ src: o.src, first: !!o.first }); return { files: o.first ? ['__art/2.jpg?z=' + encodeURIComponent(o.key)] : ['__art/0.jpg?p=1', '__art/1.jpg?p=2', '__art/2.jpg?p=3'] }; };
    // folder listings that reach the reading folders come from this pretend store (the ROM folders stay the adapter's)
    const ld0 = N.listDirs, lf0 = N.listFiles;
    N.listDirs = async o => {
      const r = await ld0.call(N, o), id = idOfTree(o.uri), kids = new Set(((r && r.dirs) || []).map(d => d.name)), out = ((r && r.dirs) || []).slice();
      for (const x of F.fs) if (x.p.startsWith(id + '/')) { const rest = x.p.slice(id.length + 1).split('/'); if (rest.length > 1 && !kids.has(rest[0])) { kids.add(rest[0]); out.push({ name: rest[0], docId: id + '/' + rest[0], uri: treeOnly(o.uri) + '/document/' + encodeURIComponent(id + '/' + rest[0]) }); } }
      return { dirs: out };
    };
    N.listFiles = async o => {
      const id = idOfTree(o.uri); if (!isReading(id)) return lf0.call(N, o);
      return { files: F.fs.filter(x => x.p.startsWith(id + '/')).map(x => { const rest = x.p.slice(id.length + 1).split('/'), name = rest.pop();
        return { name, docId: x.p, dir: rest.join('/'), ext: name.split('.').pop().toLowerCase(), uri: 'content://fake/' + encodeURIComponent(x.p), size: x.size, mtime: 1.7e12 }; }).filter(f => f.dir.split('/').filter(Boolean).length <= 3) };
    };
  }
})();
