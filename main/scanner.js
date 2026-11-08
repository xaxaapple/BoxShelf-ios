// Scans ROM folders and turns file names into clean game titles.
const fs = require('fs');
const path = require('path');
const x360 = require('./x360');
const kyty = require('./kyty'); // (PS5 games' param.json)
const nx2 = require('./nx2'); // (Switch 2 unpacked games)
const { readDir, isFile, artBase, artDirsFor } = require('./paths');

// update / DLC packages, not games: a tag ([UPD], (Update), [DLC]) or the word after a separator ("Game - Update v1.0.1",
// "Game_DLC"). (1.82) Not the bare word anywhere: "DLC Quest" (Xbox 360) is a game, and was hidden
const SKIP_NAME = /[[(](upd|update|dlc)[\])]|(?<=[\s._-])(update|dlc)(?![a-z0-9])/i;
const ART_EXT = ['png', 'jpg', 'jpeg', 'webp'];

// The title rules live in shared/titles.js (the Android build uses the same file)
const Titles = require('../shared/titles');
const Arcade = require('./arcadenames');
// BIOS sets that sit beside the games, hidden even before the arcade list has arrived (main/arcadenames.js knows them all)
const ARCADE_BIOS = new Set(['neogeo', 'pgm', 'skns', 'stvbios', 'decocass', 'cpzn1', 'cpzn2', 'taitofx1', 'konamigx', 'nss', 'naomi', 'awbios', 'hod2bios', 'f355bios', 'airlbios', 'megaplay', 'megatech', 'playch10', 'qsound', 'neocdz', 'isgsm', 'nmk004', 'ym2608', 'bubsys', 'cchip', 'sp-cpu']);
function cleanTitle(file) { return Titles.cleanTitle(path.basename(file)); }

// (beta.10) the walk and the scan ask for each folder listing and file check (yield [op, path]) and their caller answers:
// at once (scanSystem) or through fs.promises (scanSystemAsync: a games folder on a NAS never holds the main process up)
function* walkG(dir, exts, depth, out, gameFile) {
  const ents = yield ['dir', dir];
  // (0.3.5) a PS4 / PS5 game folder: its eboot.bin is the game, and its data folders (thousands of files) hold no other
  if (gameFile === 'eboot.bin' && !/^usrdir$/i.test(path.basename(dir)) && ents.some(e => e.isFile() && e.name.toLowerCase() === 'eboot.bin') && ((yield ['file', path.join(dir, 'sce_sys', 'param.sfo')]) || (yield ['file', path.join(dir, 'sce_sys', 'param.json')]))) {
    out.push(path.join(dir, ents.find(e => e.isFile() && e.name.toLowerCase() === 'eboot.bin').name)); return out; }
  // (beta.10) an extracted Xbox 360 game's folder (default.xex): its subfolders are the game's data, never another game
  const xexHere = !gameFile && exts.includes('xex') && ents.some(e => e.isFile() && e.name.toLowerCase() === 'default.xex');
  for (const ent of ents) {
    const full = path.join(dir, ent.name);
    // (beta.10) a link or junction to a folder or game elsewhere (another drive, a NAS) was skipped: followed now, by what it
    // points at (the depth limit stops a link that loops)
    let isDir = ent.isDirectory(), isFileE = ent.isFile();
    if (ent.isSymbolicLink && ent.isSymbolicLink()) { const st = yield ['stat', full]; if (!st) continue; isDir = st.isDirectory(); isFileE = st.isFile(); }
    if (isDir) { if (gameFile && /^usrdir$/i.test(path.basename(dir))) continue; // a PS3 game's data folder: thousands of files, never another game
      if (xexHere || /\.data$/i.test(ent.name) && exts.includes('stfs')) continue; // (a Games on Demand package's data folder: "<hash>.data")
      if (depth > 0 && !ent.name.startsWith('.') && !/^(dlc|updates?|patches|mods|sce_sys|sce_module|romfs|exefs)$/i.test(ent.name)) yield* walkG(full, exts, depth - 1, out, gameFile); continue; } // (romfs / exefs: an unpacked Switch game's data, thousands of files)
    if (!isFileE) continue;
    if (gameFile) { if (ent.name.toLowerCase() === gameFile) out.push(full); continue; }
    const ext = path.extname(ent.name).slice(1).toLowerCase();
    if (exts.includes(ext) && !SKIP_NAME.test(ent.name)) out.push(full);
    // (beta.10) Xbox 360 Games on Demand / Arcade: a package with no extension in a content-type folder (…\00007000\<hash>);
    // its header decides later (x360.stfsInfo) whether it's a game
    else if (!ext && exts.includes('stfs') && x360.isStfsCandidate(full)) out.push(full);
  }
  return out;
}
// the answers: sync, the way the scan always read the disk…
const statOrNull = p => { try { return fs.statSync(p); } catch { return null; } };
// (beta.10) a games folder that can't be read (a NAS that dropped out, no permission) left its games out without a word:
// now it's in the log (each folder at most once in ten minutes), so a problem report says why games are missing
let log = () => {}; const unreadable = new Map();
function setLog(fn) { if (typeof fn === 'function') log = fn; }
function noteUnreadable(p, e) { const now = Date.now(); if (now - (unreadable.get(p) || 0) < 600e3) return; unreadable.set(p, now); if (unreadable.size > 500) unreadable.clear();
  log('Scan: couldn\'t read', p, '-', (e && (e.code || e.message)) || 'unknown error'); }
const readDirLogged = p => { try { return fs.readdirSync(p, { withFileTypes: true }); } catch (e) { noteUnreadable(p, e); return []; } };
function runSync(g) { let r = g.next(); while (!r.done) { const [op, p] = r.value; r = g.next(op === 'dir' ? readDirLogged(p) : op === 'file' ? isFile(p) : op === 'stat' ? statOrNull(p) : undefined); } return r.value; }
// …or async: 16 file details at a time ('prefetch': every game file's, before the per-game pass), and a breath for the
// event loop whenever the scan has held it for 25 ms (covers, IPC and the freeze watch get through between)
const ASYNC_N = 16, SLICE_MS = 25;
// (beta.10) the shelf's title order: localeCompare with options built an ICU collator for every comparison (65 ms per 2,000 titles)
const COLL = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
async function statAll(list, into) { let i = 0; const one = async () => { while (i < list.length) { const f = list[i++]; into.set(f, await fs.promises.stat(f).catch(() => null)); } };
  await Promise.all(Array.from({ length: Math.min(ASYNC_N, list.length) }, one)); }
async function runAsync(g) {
  const stats = new Map(); let r = g.next(), t = Date.now();
  while (!r.done) { const [op, p] = r.value; let v;
    if (op === 'dir') v = await fs.promises.readdir(p, { withFileTypes: true }).catch(e => { noteUnreadable(p, e); return []; });
    else if (op === 'file') v = await fs.promises.stat(p).then(s => s.isFile(), () => false);
    else if (op === 'stat') v = stats.has(p) ? stats.get(p) : await fs.promises.stat(p).catch(() => null);
    else if (op === 'prefetch') await statAll(p, stats);
    if (Date.now() - t > SLICE_MS) { await new Promise(z => setImmediate(z)); t = Date.now(); }
    r = g.next(v); }
  return r.value;
}

// PlayStation param.sfo: a small key/value table with TITLE and TITLE_ID
function readSfo(file) { try { return parseSfo(fs.readFileSync(file)); } catch { return null; } }
function parseSfo(b) {
  try {
    if (b.readUInt32LE(0) !== 0x46535000) return null; // "\0PSF"
    const keyTab = b.readUInt32LE(8), dataTab = b.readUInt32LE(12), n = b.readUInt32LE(16);
    const out = {};
    for (let i = 0; i < n; i++) {
      const e = 20 + i * 16, keyOff = b.readUInt16LE(e), fmt = b.readUInt16LE(e + 2), len = b.readUInt32LE(e + 4), dataOff = b.readUInt32LE(e + 12);
      let k = keyTab + keyOff, end = k; while (end < b.length && b[end] !== 0) end++;
      const key = b.toString('utf8', k, end);
      if (fmt === 0x0204) { let s = dataTab + dataOff, se = s; const max = s + len; while (se < max && b[se] !== 0) se++; out[key] = b.toString('utf8', s, se); }
      else if (fmt === 0x0404) out[key] = b.readUInt32LE(dataTab + dataOff);
    }
    return out;
  } catch { return null; }
}
// Extracted Wii U games: <game>\code\<name>.rpx, title from <game>\meta\meta.xml (longname_en, else shortname_en)
function wiiuFolderInfo(file) {
  if (path.basename(path.dirname(file)).toLowerCase() !== 'code') return null;
  const root = path.dirname(path.dirname(file));
  let title = '';
  try {
    const xml = fs.readFileSync(path.join(root, 'meta', 'meta.xml'), 'utf8');
    const tag = t => { const m = new RegExp(`<${t}[^>]*>([^<]*)</${t}>`, 'i').exec(xml); return m ? m[1].replace(/&#(\d+);/g, (m, c) => +c === 10 || +c === 13 ? ' ' : String.fromCharCode(+c)).replace(/&amp;/g, '&').replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim() : ''; };
    title = tag('longname_en') || tag('shortname_en');
  } catch {}
  return { root, title };
}
// A PS4 .pkg that hasn't been installed yet: its param.sfo sits unencrypted in the package's entry table (id 0x1000),
// which gives the real title, the CUSA id and whether it's a game (gd), a patch (gp) or add-on (ac). Header is big-endian.
function pkgInfo(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r'); const h = Buffer.alloc(32); fs.readSync(fd, h, 0, 32, 0);
    if (h.readUInt32BE(0) !== 0x7F434E54) return null; // "\x7FCNT"
    const count = h.readUInt32BE(0x10), tableOff = h.readUInt32BE(0x18); if (count > 10000) return null;
    const t = Buffer.alloc(count * 32); fs.readSync(fd, t, 0, t.length, tableOff);
    for (let i = 0; i < count; i++) { if (t.readUInt32BE(i * 32) !== 0x1000) continue;
      const off = t.readUInt32BE(i * 32 + 16), size = t.readUInt32BE(i * 32 + 20); if (size > 1 << 20) return null;
      const sb = Buffer.alloc(size); fs.readSync(fd, sb, 0, size, off); return parseSfo(sb); }
  } catch {} finally { if (fd != null) try { fs.closeSync(fd); } catch {} }
  return null;
}
// a readable title from a download-style name: "[Site]-The.Last.of.Us.Remastered_CUSA00556_v1.00_UPLOADER.pkg"
function pkgTitleFromName(file) {
  let b = path.basename(file).replace(/\.pkg$/i, '').replace(/\[[^\]]*\]/g, ' ');
  b = b.split(/[_ ]?(?:CUSA|PLAS|PCAS|PLJM|PCJS)\d{5}/i)[0];
  return b.replace(/[._]+/g, ' ').replace(/^[\s-]+|[\s-]+$/g, '').replace(/\s+/g, ' ').trim();
}
// PS3 folder game: EBOOT.BIN sits in USRDIR; PARAM.SFO, ICON0.PNG and PIC1.PNG sit one level up (PS3_GAME for discs,
// the NPxx00000 folder for digital games). The game's name folder is above PS3_GAME.
function ps3GameInfo(file, romDirs) {
  const usr = path.dirname(file); if (path.basename(usr).toLowerCase() !== 'usrdir') return null;
  const base = path.dirname(usr), sfo = readSfo(path.join(base, 'PARAM.SFO'));
  if (sfo && /^(GD|2P|AT)$/i.test(String(sfo.CATEGORY || ''))) return null; // installed patch / game data, not a game
  const isDisc = path.basename(base).toLowerCase() === 'ps3_game', folder = isDisc ? path.dirname(base) : base;
  let title = sfo && sfo.TITLE ? String(sfo.TITLE).replace(/\s+/g, ' ').trim() : '';
  if (!title) title = path.basename(folder);
  title = title.replace(/[™®]/g, '').trim();
  const icon = path.join(base, 'ICON0.PNG'), pic = path.join(base, 'PIC1.PNG');
  const titleId = sfo && (sfo.TITLE_ID || '') || ((/\b([A-Z]{4}\d{5})\b/.exec(path.basename(folder) + ' ' + path.basename(base)) || [])[1] || '');
  return { title, titleId, region: ps3Region(titleId), folder, icon: isFile(icon) ? icon : null, hero: isFile(pic) ? pic : null };
}
// (beta.10) a PS3 game's region from its id (BLUS / BCUS / NPUB… USA, BLES / NPEB… Europe, BLJM / NPJB… Japan, BLAS… Asia):
// a US and a European copy of a game are two boxes, as they are for every other console (they were one, and one went missing)
function ps3Region(id) {
  const m = /^[BN][CLP]([A-Z])([A-Z])/i.exec(String(id || '')); if (!m) return '';
  const r = (m[1] + m[2]).toUpperCase();
  return /^(US|UB|UA)$/.test(r) ? 'USA' : /^(ES|EB|EA)$/.test(r) ? 'Europe' : /^(JS|JM|JB|JA|JJ)$/.test(r) ? 'Japan' : /^(AS|HA|HB)$/.test(r) ? 'Asia' : /^(KS|KB)$/.test(r) ? 'Korea' : '';
}
// For folder games (PS4): title from param.sfo, else the folder name; icon0/pic1 as fallback art
function folderGameInfo(file, romDirs) {
  const dir = path.dirname(file);
  let sfo = readSfo(path.join(dir, 'sce_sys', 'param.sfo'));
  if (!sfo) { const p = kyty.readParam(dir); if (p) sfo = { TITLE: p.title, TITLE_ID: p.titleId }; } // (PS5: sce_sys\param.json)
  let title = sfo && sfo.TITLE ? String(sfo.TITLE).replace(/\s+/g, ' ').trim() : '';
  const folder = path.basename(dir), parent = path.dirname(dir);
  // "CUSA00207" folder: the folder above usually carries the name, unless that's the games folder itself (every game would be called "games")
  const parentIsRoot = (romDirs || []).some(d => path.resolve(d) === path.resolve(parent));
  if (!title) title = /^[A-Z]{4}\d{5}/.test(folder) && !parentIsRoot && path.basename(parent) ? path.basename(parent) : folder;
  title = title.replace(/[™®]/g, '').trim();
  const icon = path.join(dir, 'sce_sys', 'icon0.png'); let pic = path.join(dir, 'sce_sys', 'pic1.png'); if (!isFile(pic)) pic = path.join(dir, 'sce_sys', 'pic0.png'); // (PS5 games often have only pic0)
  return { title, titleId: sfo && sfo.TITLE_ID, folder: dir, icon: isFile(icon) ? icon : null, hero: isFile(pic) ? pic : null };
}

// One directory listing per art folder per scan (instead of hundreds of stat calls per game).
const dirCache = new Map();
function listing(dir) {
  if (dirCache.has(dir)) return dirCache.get(dir);
  let m = null;
  try { const names = fs.readdirSync(dir); m = new Map(); for (const n of names) m.set(n.toLowerCase(), n); } catch {}
  dirCache.set(dir, m);
  return m;
}
// <name>-manual-NN.<img> pages of every game in a folder, indexed once per scan (was a filter over the whole folder per game)
const manualCache = new Map();
function manualIndex(dir) {
  if (manualCache.has(dir)) return manualCache.get(dir);
  const L = listing(dir); let idx = null;
  if (L) {
    idx = new Map();
    for (const [low, real] of L) {
      const i = low.lastIndexOf('-manual-'); if (i <= 0 || !ART_EXT.includes(path.extname(low).slice(1))) continue;
      const k = low.slice(0, i); if (!idx.has(k)) idx.set(k, []); idx.get(k).push(low);
    }
    for (const [k, list] of idx) idx.set(k, list.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map(f => path.join(dir, L.get(f))));
  }
  manualCache.set(dir, idx); return idx;
}
function findArt(file, title, artDirs) {
  const base = artBase(file);
  const names = [...new Set([base, title])];
  const look = (suffix) => {
    for (const dir of artDirs) { const L = listing(dir); if (!L) continue; for (const n of names) for (const e of ART_EXT) {
      const real = L.get(`${n}${suffix}.${e}`.toLowerCase());
      if (real) return path.join(dir, real);
    } }
    return null;
  };
  // Manual pages: <name>-manual-01.jpg, -02.jpg … (any image type), in page order.
  let manual = [];
  for (const dir of artDirs) {
    const M = manualIndex(dir); if (!M) continue;
    for (const n of names) { const pages = M.get(n.toLowerCase()); if (pages) { manual = pages.slice(); break; } }
    if (manual.length) break;
  }
  let manualPdf = null;
  if (!manual.length) for (const dir of artDirs) { const L = listing(dir); if (!L) continue; for (const n of names) { const real = L.get(`${n}-manual.pdf`.toLowerCase()); if (real) { manualPdf = path.join(dir, real); break; } } if (manualPdf) break; }
  // (a made back, "-backmade": only while there's no real one; madeBack keeps the weekly art check looking for a scan)
  const back = look('-back'), made = back ? null : look('-backmade');
  // (a made spine, "-spinemade": the same, for a game no source has a spine of)
  const spine = look('-spine'), madeSp = spine ? null : look('-spinemade');
  return { front: look(''), back: back || made, madeBack: !!made, spine: spine || madeSp, madeSpine: !!madeSp, disc: look('-disc'), manual, manualPdf };
}

// (beta.9) The slow part of a scan (walking the games folders, each game's file details, disc headers, param files, a
// Wii U game's NUS files) is kept for a short while. One background pass (manual collections, the manual search, PDF
// pages, spreads, made backs and spines) used to scan every console again and again within the same minute, and each
// scan held up the main process (and with it the shelf's input). The art is still looked up fresh on every call: those
// passes add pictures and manual pages between scans. A change in a games folder (main.js watchRoms) or a settings save
// clears it (forget), and the key holds everything the slow part reads.
const SCAN_TTL = 90 * 1000, scanMemo = new Map();
function fileKey(sysDef, sysCfg) {
  return sysDef.id + '|' + JSON.stringify((sysCfg && sysCfg.romDirs) || []) + '|' + (sysDef.gameFile || '') + (sysDef.deep ? '|d' : '') +
    (Arcade.SYSTEMS.has(sysDef.id) ? '|a' + (Arcade.ready() ? 1 : 0) : '') + (sysDef.id === 'x360' && x360.stamp ? '|x' + x360.stamp() : ''); // (names that arrive later change the titles)
}
function scanSystem(sysDef, sysCfg, fresh) { // fresh: read the folders again now (the Studios' "look again", a game not found)
  const k = fileKey(sysDef, sysCfg), now = Date.now();
  for (const [mk, mv] of scanMemo) if (now - mv.at > SCAN_TTL) scanMemo.delete(mk); // (old entries never pile up)
  let m = fresh ? null : scanMemo.get(k);
  if (!m) { m = { at: now, list: runSync(scanFilesG(sysDef, sysCfg)) }; scanMemo.set(k, m); }
  return withArt(m.list, sysCfg);
}
// (beta.10) the same scan, the same list, without holding the main process up: the shelf's library scan (main.js
// buildLibrary) and the background art passes. Two at once for the same folders share one walk; a forget() while one runs
// keeps its (older) result out of the kept scans
let scanGen = 0; const scanFlight = new Map();
async function scanSystemAsync(sysDef, sysCfg, fresh) {
  const k = fileKey(sysDef, sysCfg), now = Date.now();
  for (const [mk, mv] of scanMemo) if (now - mv.at > SCAN_TTL) scanMemo.delete(mk);
  let m = fresh ? null : scanMemo.get(k);
  if (!m) { let p = fresh ? null : scanFlight.get(k);
    if (!p) { const gen = scanGen; p = runAsync(scanFilesG(sysDef, sysCfg)).then(list => { const v = { at: now, list }; if (gen === scanGen) scanMemo.set(k, v); return v; });
      if (!fresh) { scanFlight.set(k, p); p.then(() => {}, () => {}).then(() => { if (scanFlight.get(k) === p) scanFlight.delete(k); }); } }
    m = await p; }
  return withArt(m.list, sysCfg, await artListings(artDirsFor(sysCfg)));
}
function forget() { scanMemo.clear(); scanFlight.clear(); scanGen++; }
// the art folders' listings read ahead with fs.promises (withArt then looks everything up in memory)
async function artListings(dirs) { const pre = new Map();
  await Promise.all([...new Set(dirs)].map(d => fs.promises.readdir(d).then(names => { const m = new Map(); for (const n of names) m.set(n.toLowerCase(), n); pre.set(d, m); }, () => pre.set(d, null))));
  return pre; }
// the art for each game, fresh: new objects every time, so a caller changing a game never changes the kept list
function withArt(list, sysCfg, pre) { // pre: listings read ahead (scanSystemAsync)
  dirCache.clear(); manualCache.clear(); if (pre) for (const [d, m] of pre) dirCache.set(d, m);
  const artDirs = artDirsFor(sysCfg);
  return list.map(g => { const { _art, ...o } = g, a = findArt(g.file, _art.title, artDirs), fg = _art.fg;
    if (fg) { if (!a.front && fg.icon) a.front = fg.icon; if (fg.hero) a.hero = fg.hero; if (!a.disc && fg.icon) a.disc = fg.icon; }
    o.art = a; if (Array.isArray(o.discs)) o.discs = o.discs.slice(); return o; }); // (art keeps its place among the keys)
}
function* scanFilesG(sysDef, sysCfg) {
  const files = [];
  // (beta.10) one folder deeper everywhere (games sorted into genre or series folders went missing), and two more for
  // consoles whose games are folders (PS3 <group>\<game>\PS3_GAME\USRDIR, Xbox 360 Content\<profile>\<title id>\00007000).
  // Games' own data folders are never walked (USRDIR, romfs, an extracted 360 game, a package's .data)
  const deep = !!(sysDef.gameFile || sysDef.deep || sysDef.id === 'x360'), DEPTH = deep ? 6 : 4;
  const exts = sysDef.id === 'x360' ? [...sysDef.extensions, 'stfs'] : sysDef.extensions; // ('stfs': Games on Demand / Arcade packages, which have no extension)
  // the bare words update / dlc / patch / pass mean an update package only on the Switch shelves (shared/titles.js)
  const ct = f => Titles.cleanTitle(path.basename(f), { updateWords: sysDef.id === 'sw' || sysDef.id === 'sw2' });
  for (const dir of sysCfg.romDirs || []) yield* walkG(dir, exts, DEPTH, files, sysDef.gameFile);
  const byTitle = new Map(), byName = new Map(), discOf = new Map(); // discOf: file → { n: disc number, size }
  // PS4: .pkg packages too (shown as "not installed" until shadPS4 has installed them, unless the installed copy is here)
  const pkgs = []; if (sysDef.id === 'ps4') for (const dir of sysCfg.romDirs || []) yield* walkG(dir, ['pkg'], 4, pkgs, null);
  // systems whose games are folders but that also take loose disc images (PS3: .iso)
  if (sysDef.alsoFiles) for (const dir of sysCfg.romDirs || []) yield* walkG(dir, sysDef.alsoFiles, 4, files, null);
  // Switch 2: unpacked game folders (exefs\main), besides any .nsp / .xci
  if (sysDef.id === 'sw2') {
    const packed = files.splice(0), roots = [];
    for (const dir of sysCfg.romDirs || []) nx2.find(dir, 3, files);
    for (const f of files) roots.push(nx2.gameRoot(f).toLowerCase() + path.sep);
    // a .nsp / .xci / .nup kept inside an unpacked game's folder (DKB's base [id]\*.nsp) is that game again, not another
    for (const f of packed) if (!roots.some(r => f.toLowerCase().startsWith(r))) files.push(f);
  }
  yield ['prefetch', files]; // (beta.10: every game file's details at once, async; nothing sync)
  // extracted Xbox 360 games: a folder with default.xex (plus other .xex helpers we don't want as separate boxes)
  const xexDirs = new Set(files.filter(f => path.basename(f).toLowerCase() === 'default.xex').map(f => path.dirname(f)));
  for (const f of files) {
    let fg = null;
    const isXex = /\.xex$/i.test(f), isDefault = isXex && path.basename(f).toLowerCase() === 'default.xex';
    if (isXex && !isDefault && xexDirs.has(path.dirname(f))) continue;
    const asFolder = sysDef.gameFile && path.basename(f).toLowerCase() === sysDef.gameFile;
    if (asFolder && sysDef.id === 'ps3') { fg = ps3GameInfo(f, sysCfg.romDirs); if (!fg) continue; }
    if (sysDef.id === 'sw2') { const n = /(^|[\\/])exefs[\\/]main$/i.test(f) ? nx2.info(f) : nx2.fileInfo(f); fg = { title: n.title, titleId: n.titleId || undefined, folder: n.folder || path.dirname(f), icon: null, hero: null }; }
    // (beta.10) an Xbox 360 Games on Demand / Arcade package: a game only if its header says so (not a save, DLC or update)
    const stfs = sysDef.id === 'x360' && !path.extname(f) ? x360.stfsInfo(f) : null; if (sysDef.id === 'x360' && !path.extname(f) && !stfs) continue;
    let info = stfs ? { title: stfs.title || 'Xbox 360 game ' + stfs.titleId, region: '', disc: 0, rev: '' }
      : asFolder || fg ? (fg = fg || folderGameInfo(f, sysCfg.romDirs), { title: fg.title, region: fg.region || '', disc: 0, rev: '' }) : ct(isDefault ? path.dirname(f) + '.xex' : f);
    // (beta.7) arcade / Neo Geo: "sf2.zip" is named from FinalBurn Neo's list; BIOS sets (neogeo.zip) aren't games
    if (Arcade.SYSTEMS.has(sysDef.id)) { const set = path.basename(f, path.extname(f)).toLowerCase(), a = Arcade.lookup(set);
      if ((a && a.bios) || (!a && ARCADE_BIOS.has(set))) continue;
      // ("A / B": two names for one game, the first is the shelf's; versions of a game, "(World 910522)" / "(USA 910206)",
      // are one box, the fuller zip kept)
      if (a && a.title) { info = ct(a.title.split(' / ')[0].replace(/[\\/]/g, '-') + '.zip'); info.region = ''; } }
    if (sysDef.id === 'wiiu' && /\.tmd$/i.test(f)) {
      // NUS folder ("Game Name [0005000010xxxxxx]\title.tmd + *.app"): the folder is the game; updates (0005000E…) and DLC (0005000C…) aren't
      if (path.basename(f).toLowerCase() !== 'title.tmd') continue;
      const dir = path.dirname(f), idm = /\b(0005000[0-9A-F])([0-9A-F]{8})\b/i.exec(path.basename(dir));
      if (idm && /^0005000[CE]$/i.test(idm[1])) continue;
      info = ct(dir + '.tmd'); info.extra = false; /* the Switch update rule doesn't apply to Wii U ids */ if (!info.title || /^[0-9A-F]{16}$/i.test(info.title)) info.title = 'Wii U game ' + (idm ? idm[0] : path.basename(dir));
      try { info.nusBytes = fs.readdirSync(dir).reduce((a, n) => { try { return a + fs.statSync(path.join(dir, n)).size; } catch { return a; } }, 0); } catch {}
    }
    if (sysDef.id === 'wiiu' && /\.rpx$/i.test(f)) { const w = wiiuFolderInfo(f); if (!w) continue; // a loose .rpx outside a game's code folder isn't a game
      info = ct(w.root + '.rpx'); if (w.title) info.title = w.title.replace(/[™®]/g, '').trim(); }
    let x = null;
    if (sysDef.id === 'x360') {
      // "DVD.iso" / "game.iso" inside a folder: the folder is the name; then the title id inside the image beats any file name
      // "DVD.iso" / "DVD1.iso" / "game.iso" inside a folder: the folder is the name (a digit in the file name is the disc number)
      const gen = !stfs && /^(dvd|disc|game|image|iso|default|xbox ?360)\s*(\d*)$/i.exec(info.title);
      if (gen && !(sysCfg.romDirs || []).some(d => path.resolve(d) === path.resolve(path.dirname(f)))) { Object.assign(info, ct(path.dirname(f) + path.extname(f))); if (!info.disc && gen[2]) info.disc = +gen[2]; }
      else if (gen && gen[2] && !info.disc) info.disc = +gen[2];
      x = x360.lookup(f, stfs); // (beta.10: a package's header, read just above, isn't read again for its title id)
      // FFxxxxxx ids are generic (bonus / downloadable-content discs share FFED2000): never trust the title list for them
      if (x && /^FF/i.test(x.titleId || '')) x = null;
      if (x && x.title) info.title = x.title.replace(/[™®]/g, '').trim();
      else if (x && /^(dvd|disc|game|image|iso|default|xbox ?360)\s*\d*$/i.test(info.title)) info.title = 'Xbox 360 game ' + x.titleId; // unknown id at the top level: at least don't call it "DVD"
    }
    // Wii U ids say it outright: 00050000… is a game, 0005000E… an update, 0005000C… DLC (the Switch rule doesn't apply)
    if (sysDef.id === 'wiiu') { const wid = /\b0005000([0-9A-F])[0-9A-F]{8}\b/i.exec(f); info.extra = !!(wid && /[CE]/i.test(wid[1])) || /\b(update|dlc)\b/i.test(info.title); }
    if (info.extra) continue; // Switch updates / DLC packages are not games on the shelf
    // added: when the game arrived in your folder (file creation time), for the museum's "in your collection since"
    let size = info.nusBytes || 0, added = 0; const st = yield ['stat', f]; if (st) { added = Math.round(st.birthtimeMs || st.mtimeMs) || 0; if (!fg && !size) size = st.size; }
    const key = x && x.titleId ? 'x360:' + x.titleId : info.title.toLowerCase() + '|' + (info.region || '');
    if (sysDef.id === 'x360' && !stfs) { const nt = ct(f).title; if (!/^(dvd|disc|game|image|iso|default|xbox ?360)\s*\d*$/i.test(nt)) byName.set(key, nt.toLowerCase()); } // file-name title, to pair later discs with disc 1 (never a generic "DVD1")
    const prev = byTitle.get(key); discOf.set(f, { n: info.disc || 1, size });
    // One box per game: prefer disc 1, then the larger (fuller) dump.
    if (prev) {
      const better = (info.disc || 1) < (prev.disc || 1) || ((info.disc || 1) === (prev.disc || 1) && size > prev.sizeBytes);
      // two dumps of the same disc (an .iso and an .rvz of Disc 1) are one disc, not "2 discs": keep the fuller one
      if (prev.discs && info.disc) { const i = prev.discs.findIndex(d => (discOf.get(d) || { n: 1 }).n === info.disc); if (i < 0) prev.discs.push(f); else if (size > ((discOf.get(prev.discs[i]) || {}).size || 0)) prev.discs[i] = f; }
      if (!better) continue;
    }
    byTitle.set(key, {
      kind: 'rom',
      id: sysDef.id + ':' + f,
      title: info.title,
      region: info.region,
      disc: info.disc,
      file: f,
      ext: path.extname(f).slice(1).toLowerCase(),
      sizeBytes: size, added,
      art: null, _art: { title: info.title, fg: fg ? { icon: fg.icon, hero: fg.hero } : null }, // (looked up in withArt; the title before any "(Disc 2)" is added below)
      discs: prev ? prev.discs : [f],
      titleId: x ? x.titleId : fg && fg.titleId ? fg.titleId : undefined, compat: x ? x.compat : undefined
    });
  }
  if (pkgs.length) {
    const installed = new Set([...byTitle.values()].map(g => g.titleId).filter(Boolean));
    for (const f of pkgs) {
      const sfo = pkgInfo(f) || {}, cat = String(sfo.CATEGORY || 'gd').toLowerCase();
      if (cat && cat !== 'gd') continue; // patches and add-ons aren't games
      const id = sfo.TITLE_ID || ((/(CUSA|PLAS|PCAS|PLJM|PCJS)\d{5}/i.exec(path.basename(f)) || [])[0] || '').toUpperCase();
      if (id && installed.has(id)) continue; // already installed: the installed copy is the one on the shelf
      const title = (sfo.TITLE ? String(sfo.TITLE).replace(/\s+/g, ' ').replace(/[™®]/g, '').trim() : '') || pkgTitleFromName(f) || path.basename(f);
      const key = title.toLowerCase() + '|pkg'; if (byTitle.has(key)) continue;
      let size = 0; const st = yield ['stat', f]; if (st) size = st.size;
      byTitle.set(key, { kind: 'rom', id: sysDef.id + ':' + f, title, region: 'Not installed', disc: 0, file: f, ext: 'pkg', sizeBytes: size, notInstalled: true, titleId: id || undefined, art: null, _art: { title, fg: null }, discs: [f] });
    }
  }
  // Xbox 360: a disc 2+ (bonus / content disc, its own title id) joins its disc 1 by file-name title; on its own it says
  // which disc it is, so it isn't mistaken for the game
  if (sysDef.id === 'x360') {
    const firsts = new Map(); for (const [k, g] of byTitle) if (!(g.disc > 1)) firsts.set(byName.get(k), g);
    const roots = (sysCfg.romDirs || []).map(d => path.resolve(d).toLowerCase());
    // …or a disc 1 in the same game folder (the disc 2 file sits beside disc 1, or in the folder that holds it)
    const inFolder = g => { const dir = path.resolve(path.dirname(g.file)).toLowerCase(); if (roots.includes(dir)) return null;
      for (const h of byTitle.values()) if (!(h.disc > 1) && h !== g && path.resolve(h.file).toLowerCase().startsWith(dir + path.sep)) return h; return null; };
    for (const [k, g] of [...byTitle]) { if (!(g.disc > 1)) continue; const host = firsts.get(byName.get(k)) || inFolder(g);
      if (host) { (host.discs = host.discs || [host.file]).push(g.file); byTitle.delete(k); } else if (!/\(disc \d+\)$/i.test(g.title)) g.title += ` (Disc ${g.disc})`; }
  }
  return [...byTitle.values()].sort((a, b) => COLL.compare(a.title, b.title)); // (beta.10: one collator, the same order as localeCompare with these options)
}

module.exports = { scanSystem, scanSystemAsync, forget, cleanTitle, SKIP_NAME, setLog, ps3Region }; // (SKIP_NAME for the device test; forget: main.js clears the kept scans)
