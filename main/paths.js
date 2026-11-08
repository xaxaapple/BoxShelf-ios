const path = require('path');
const fs = require('fs');

let APP_ROOT = process.cwd();
function setAppRoot(p) { APP_ROOT = p; }
function appRoot() { return APP_ROOT; }

// Expand %VAR% and {app} placeholders.
function expand(p) {
  if (!p) return p;
  return p
    .replace(/\{app\}/gi, APP_ROOT)
    .replace(/%([^%]+)%/g, (m, name) => {
      const key = Object.keys(process.env).find(k => k.toLowerCase() === name.toLowerCase());
      return key ? process.env[key] : m;
    });
}

function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function readDir(p) { try { return fs.readdirSync(p, { withFileTypes: true }); } catch { return []; } }

// Find the first file named one of `names` under `root`, up to `depth` folders deep.
function findFile(root, names, depth = 2) {
  const want = names.map(n => n.toLowerCase());
  const queue = [[root, 0]];
  while (queue.length) {
    const [dir, d] = queue.shift();
    for (const ent of readDir(dir)) {
      const full = path.join(dir, ent.name);
      if (ent.isFile() && want.includes(ent.name.toLowerCase())) return full;
      if (ent.isDirectory() && d < depth && !ent.name.startsWith('.')) queue.push([full, d + 1]);
    }
  }
  return null;
}

// Name used for a game's art files: the file name without extension, or for folder games (PS4 eboot.bin) the game folder
function artBase(file) {
  const b = path.basename(file);
  // PS3 folder games: …\<Game>\PS3_GAME\USRDIR\EBOOT.BIN (named by <Game>) or …\NPUB12345\USRDIR\EBOOT.BIN (by the id folder)
  if (/^eboot\.bin$/i.test(b) && /^usrdir$/i.test(path.basename(path.dirname(file)))) {
    let d = path.dirname(path.dirname(file)); if (/^ps3_game$/i.test(path.basename(d))) d = path.dirname(d);
    return path.basename(d).replace(/[<>:"/\\|?*]+/g, '_');
  }
  // folder games (PS4 eboot.bin, Wii U NUS title.tmd, extracted Wii U code\*.rpx is handled by name) are named by their folder
  if (/^(eboot\.bin|title\.tmd)$/i.test(b) || /^(dvd|disc|game|image|iso|default|xbox ?360)\s*\d*\.(iso|xex|zar)$/i.test(b)) {
    const dir = path.basename(path.dirname(file));
    // a game unpacked loose into the console's own games folder (…\ROMS\ps4\eboot.bin): that folder's name is shared by
    // whatever game is put there next, so its art would follow the folder, not the game. Named by its title id instead.
    if (/^eboot\.bin$/i.test(b) && consoleFolderName(dir)) { const id = ps4TitleId(file); if (id) return id; }
    return dir.replace(/[<>:"/\\|?*]+/g, '_');
  }
  // unpacked Switch 2 games: …\<Game>\exefs\main, …\<Game>\base\exefs\main or …\<Game>\<version>\exefs\main, named by
  // <Game> (every one is "main")
  if (b.toLowerCase() === 'main' && /^exefs$/i.test(path.basename(path.dirname(file)))) return path.basename(require('./nx2').gameRoot(file)).replace(/[<>:"/\\|?*]+/g, '_');
  return b.replace(/\.[^.]+$/, '');
}
let folderNames = null;
function consoleFolderName(name) {
  if (!folderNames) { folderNames = new Set(['roms', 'games', 'game', 'ps4 games']); try { for (const c of require('./systems').CONSOLES) for (const n of c.romFolderNames || []) folderNames.add(String(n).toLowerCase()); } catch {} }
  return folderNames.has(String(name || '').toLowerCase().trim());
}
const titleIds = new Map();
function ps4TitleId(eboot) {
  // (PS5 games carry sce_sys\param.json instead of param.sfo: the same title id is in it)
  let sfo = path.join(path.dirname(eboot), 'sce_sys', 'param.sfo'); if (!isFile(sfo)) sfo = path.join(path.dirname(eboot), 'sce_sys', 'param.json');
  let key = eboot; try { key += '|' + fs.statSync(sfo).mtimeMs; } catch { return ''; } // a different game unpacked there later reads again
  if (titleIds.has(key)) return titleIds.get(key); let id = '';
  try { const b = fs.readFileSync(sfo); const m = /\b([A-Z]{4}\d{5})\b/.exec(b.toString('latin1')); if (m) id = m[1]; } catch {}
  if (titleIds.size > 500) titleIds.clear(); titleIds.set(key, id); return id;
}
// Is `file` inside folder `dir`? (resolved, case-insensitive, separator-aware: D:\PS2 must not claim D:\PS2 Extra, and E:\ works)
function inDir(file, dir) {
  if (!file || !dir) return false;
  const f = path.resolve(String(file)).toLowerCase(), d = path.resolve(String(dir)).toLowerCase();
  return f.startsWith(d.endsWith(path.sep) ? d : d + path.sep);
}
// Where a game's art goes. A console with its own art folder (Settings) keeps everything there. Otherwise, with an art
// library chosen (Settings → Box art, or at setup), each console gets a folder in it named after its games folder,
// with covers\ and manuals\ inside (Art\PS2\covers, Art\PS2\manuals); without one, it's <games folder>\covers.
let artLib = '', libRoots = [];
// roots: every console's games folders, so two that share a last name (D:\GameCube\Games and D:\Wii\Games) get a
// folder each instead of one shared Art\Games where same-named covers and manuals overwrote each other
function setArtLibrary(dir, roots) { artLib = dir ? path.resolve(expand(String(dir))) : ''; if (Array.isArray(roots)) libRoots = [...new Set(roots.filter(Boolean).map(r => path.resolve(String(r)).toLowerCase()))]; } // ({app} and %VAR% work here like in other paths)
const artLibrary = () => artLib;
const romRoot = (cfg, file) => ((cfg && cfg.romDirs) || []).find(d => inDir(file, d)) || path.dirname(file);
const libName = r => (path.basename(r) || 'Games').replace(/[<>:"|?*]/g, '_');
const plainLib = root => path.join(artLib, libName(path.resolve(String(root))));
// the name stays the folder's own (Art\PS2) unless another games folder shares it: then its parent path is added,
// "Games (D GameCube)", "PS2 (E)". The shared folder from before is still read (artDirsFor), so no art goes missing.
const clashes = root => { const r = path.resolve(String(root)), n = libName(r).toLowerCase(); return libRoots.some(o => o !== r.toLowerCase() && libName(o).toLowerCase() === n); };
const libFolder = root => { if (!clashes(root)) return plainLib(root); const r = path.resolve(String(root)), where = path.dirname(r).replace(/[<>:"|?*\\/]+/g, ' ').trim() || 'root'; return path.join(artLib, `${libName(r)} (${where})`); };
function artDirFor(cfg, file) { if (cfg && cfg.artDir) return expand(cfg.artDir); const root = romRoot(cfg, file); return artLib ? path.join(libFolder(root), 'covers') : path.join(root, 'covers'); }
function manualDirFor(cfg, file) { if (cfg && cfg.artDir) return expand(cfg.artDir); const root = romRoot(cfg, file); return artLib ? path.join(libFolder(root), 'manuals') : path.join(root, 'covers'); }
// every folder a console's art may be in, the library first (art left beside the games is still found)
function artDirsFor(cfg) { const roms = (cfg && cfg.romDirs) || []; return [cfg && cfg.artDir && expand(cfg.artDir), ...(artLib ? roms.flatMap(d => [path.join(libFolder(d), 'covers'), path.join(libFolder(d), 'manuals'), ...(clashes(d) ? [path.join(plainLib(d), 'covers'), path.join(plainLib(d), 'manuals')] : [])]) : []), ...roms.flatMap(d => [path.join(d, 'covers'), path.join(d, 'media', 'covers'), path.join(d, 'boxart')])].filter(Boolean); }
// ---- the reading corner's folder (Settings → Magazines & guides): Magazines\ and Guides\ live in it. Empty = beside Boxshelf ----
let readLib = '';
function setReadingLibrary(dir) { readLib = dir ? path.resolve(expand(String(dir))) : ''; }
function readingRoot() { return readLib || APP_ROOT; }
// Magazines left behind in an earlier Boxshelf folder (e.g. the Boxshelf folder was renamed or moved and
// the reading corner came up empty). Found three ways, none of them a fixed name:
//  - folders the settings remember Boxshelf running from (known)
//  - folders the log mentions as Boxshelf's own (…\<install>\data\…, …\<install>\Magazines\…): the log moves with the data
//  - Boxshelf-looking folders next to this one (a data\config.json, a Boxshelf .exe or start .bat inside)
// Only folders whose Magazines\ or Guides\ hold something are offered, with a count; this one never is.
const READ_KINDS = ['Magazines', 'Guides'], READ_FILE = /\.(pdf|cbz|cbr|cb7|zip|7z|rar|jpe?g|png|webp|gif)$/i;
function tally(dir) { const r = { files: 0, bytes: 0 }; const walk = (d, depth) => { for (const e of readDir(d)) { if (r.files >= 20000 || e.name.startsWith('.')) continue; const f = path.join(d, e.name);
  if (e.isDirectory()) { if (depth < 4) walk(f, depth + 1); } else if (e.isFile() && READ_FILE.test(e.name)) { r.files++; try { r.bytes += fs.statSync(f).size; } catch {} } } }; walk(dir, 0); return r; }
const looksLikeBoxshelf = d => isFile(path.join(d, 'data', 'config.json')) || isFile(path.join(d, 'Start Boxshelf.bat')) || readDir(d).some(e => e.isFile() && /^boxshelf.*\.exe$/i.test(e.name));
function logRoots(logFile, home) {
  const out = new Set(); let txt = '';
  try { const st = fs.statSync(logFile), fd = fs.openSync(logFile, 'r'); try { const n = Math.min(st.size, 8 << 20), b = Buffer.alloc(n); fs.readSync(fd, b, 0, n, st.size - n); txt = b.toString('utf8'); } finally { fs.closeSync(fd); } } catch { return []; }
  // C:\…\<install>\data\…  or  ~\Desktop\<install>\Magazines\… (the log writes the home folder as ~)
  const re = /((?:[A-Za-z]:|~)\\[^\r\n"*?<>|:\\]+(?:\\[^\r\n"*?<>|:\\]+)*?)\\(?:data|Magazines|Guides)\\/g; let m;
  while ((m = re.exec(txt)) && out.size < 50) { let r = m[1]; if (r.startsWith('~')) { if (!home) continue; r = path.join(home, r.slice(2)); } out.add(r); }
  return [...out];
}
function findOldReading({ current, logFile, known = [], home } = {}) {
  const cur = path.resolve(current || readingRoot()).toLowerCase(), seen = new Set([cur]), cands = [];
  const add = (r, why) => { if (!r) return; let k; try { k = path.resolve(String(r)); } catch { return; } if (seen.has(k.toLowerCase())) return; seen.add(k.toLowerCase()); cands.push([k, why]); };
  known.forEach(r => add(r, 'settings'));
  if (logFile) logRoots(logFile, home).forEach(r => add(r, 'log'));
  const parent = path.dirname(APP_ROOT); if (parent && parent !== APP_ROOT) readDir(parent).filter(e => e.isDirectory()).slice(0, 300).forEach(e => { const d = path.join(parent, e.name); if (READ_KINDS.some(k => isDir(path.join(d, k))) && looksLikeBoxshelf(d)) add(d, 'nearby'); });
  const out = [];
  for (const [root, why] of cands) {
    if (!isDir(root)) continue;
    const mags = tally(path.join(root, 'Magazines')), guides = tally(path.join(root, 'Guides'));
    if (mags.files + guides.files) out.push({ root, why, magazines: mags, guides, files: mags.files + guides.files, bytes: mags.bytes + guides.bytes });
  }
  return out.sort((a, b) => b.files - a.files);
}
// Copies an old folder's Magazines\ and Guides\ into this one. Copy only: the old files are never moved or deleted, a file
// already here (same name, same size) is skipped and a different one with the same name is never overwritten.
// onProgress({ done, total, bytes, file }); cancelled() stops between files. → { copied, skipped, failed, bytes }
async function copyReading(src, dest, onProgress, cancelled) {
  const jobs = [];
  for (const k of READ_KINDS) { const walk = (d, rel, depth) => { for (const e of readDir(d)) { if (e.name.startsWith('.')) continue; const f = path.join(d, e.name), r = path.join(rel, e.name);
    if (e.isDirectory()) { if (depth < 4) walk(f, r, depth + 1); } else if (e.isFile() && !/\.part$/i.test(e.name)) jobs.push([f, path.join(dest, k, r)]); } }; walk(path.join(src, k), '', 0); }
  if (path.resolve(src).toLowerCase() === path.resolve(dest).toLowerCase()) return { copied: 0, skipped: jobs.length, failed: 0, bytes: 0 };
  const res = { copied: 0, skipped: 0, failed: 0, bytes: 0, total: jobs.length };
  for (let i = 0; i < jobs.length; i++) {
    if (cancelled && cancelled()) { res.cancelled = true; break; }
    const [from, to] = jobs[i];
    try {
      const a = fs.statSync(from); let b = null; try { b = fs.statSync(to); } catch {}
      if (b) res.skipped++; // there already (the same copy, or a different file of that name: left alone)
      else { await fs.promises.mkdir(path.dirname(to), { recursive: true }); const tmp = to + '.copying'; await fs.promises.copyFile(from, tmp);
        // a rename replaces what's there: a file of that name that appeared while this one copied (a download) is kept
        if (isFile(to) || isDir(to)) { await fs.promises.rm(tmp, { force: true }); res.skipped++; } else { await fs.promises.rename(tmp, to); res.copied++; res.bytes += a.size; } }
    } catch (e) { res.failed++; res.lastError = e.message; try { fs.rmSync(to + '.copying', { force: true }); } catch {} }
    if (onProgress) onProgress({ done: i + 1, total: jobs.length, bytes: res.bytes, file: path.basename(from) });
  }
  return res;
}
// Windows PowerShell writes stderr as CLIXML when it's redirected (progress records too): keep only real error text
function psError(s) {
  s = String(s || '');
  if (!/^#< CLIXML/.test(s.trim())) return s.trim();
  const out = []; s.replace(/<S S="Error">([\s\S]*?)<\/S>/g, (m, t) => { out.push(t); return m; });
  return out.join('').replace(/_x000D__x000A_/g, ' ').replace(/_x([0-9A-F]{4})_/g, (m, h) => String.fromCharCode(parseInt(h, 16))).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}
module.exports = { setReadingLibrary, readingRoot, findOldReading, copyReading, _logRoots: logRoots, artBase, inDir, artDirFor, manualDirFor, artDirsFor, setArtLibrary, artLibrary, libFolder, psError, setAppRoot, appRoot, expand, isFile, isDir, readDir, findFile };
