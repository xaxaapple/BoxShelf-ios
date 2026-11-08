// Auto-detect emulators, ROM folders, Steam and media apps.
const path = require('path');
const { execFile } = require('child_process');
const { CONSOLES, APPS, SEARCH_ROOTS, ROM_ROOT_NAMES } = require('./systems');
const { expand, isFile, isDir, readDir, findFile, appRoot } = require('./paths');

// (1.82) Each folder searched is listed once, two folders deep, and every console and app looks its program names up in
// that list: the same answer as findFile (the first match, breadth first), without walking the Desktop, Downloads and
// Documents again for each of a dozen consoles while the setup window waits.
function makeIndex() {
  const cache = new Map();
  return dir => {
    const key = dir.toLowerCase(); let m = cache.get(key); if (m) return m;
    m = new Map(); let seq = 0; const queue = [[dir, 0]];
    while (queue.length) {
      const [d, depth] = queue.shift();
      for (const ent of readDir(d)) {
        const full = path.join(d, ent.name);
        if (ent.isFile()) { const k = ent.name.toLowerCase(); if (!m.has(k)) m.set(k, { full, seq: seq++ }); }
        else if (ent.isDirectory() && depth < 2 && !ent.name.startsWith('.')) queue.push([full, depth + 1]);
      }
    }
    cache.set(key, m); return m;
  };
}
function findIn(index, dir, exeNames) {
  const m = index(dir); let best = null;
  for (const n of exeNames) {
    if (n.startsWith('re:')) { // (Linux) a pattern, for versioned AppImage names: "re:^duckstation.*\.appimage$"
      const re = new RegExp(n.slice(3), 'i');
      for (const [k, h] of m) if (re.test(k) && (!best || h.seq < best.seq)) best = h;
      continue; }
    const h = m.get(n.toLowerCase()); if (h && (!best || h.seq < best.seq)) best = h; }
  return best ? best.full : null;
}
// (Linux) SD cards and USB drives: /run/media/<user>/<card> (SteamOS, most desktops), /run/media/mmcblk0p1 (older SteamOS),
// /media/<user>/<card> (Ubuntu). Each card, and its Emulation and retrodeck folders, is searched like the home folder.
function mediaRoots() {
  if (process.platform !== 'linux') return [];
  const out = [], user = require('os').userInfo().username;
  for (const base of ['/run/media/' + user, '/run/media', '/media/' + user]) {
    for (const ent of readDir(base)) { if (!ent.isDirectory() || ent.name === user) continue; const d = path.join(base, ent.name); out.push(d, path.join(d, 'Emulation'), path.join(d, 'retrodeck')); }
  }
  return [...new Set(out)];
}
const searchRoots = () => [...SEARCH_ROOTS.map(expand), ...mediaRoots()];

function findExe(folders, exeNames, index = makeIndex()) {
  for (const f of folders) {
    const dir = expand(f);
    if (!isDir(dir)) continue;
    const hit = findIn(index, dir, exeNames);
    if (hit) return hit;
  }
  // Portable copies in common places (e.g. Desktop\Emulators\Dolphin-x64\Dolphin.exe)
  for (const root of searchRoots()) {
    if (!isDir(root)) continue;
    const hit = findIn(index, root, exeNames);
    if (hit) return hit;
  }
  return null;
}

// Look for "<root>\ROMS\<system>" style folders.
function findRomDirs(sys) {
  const found = new Set();
  const roots = [appRoot(), ...searchRoots()];
  for (const root of roots) {
    if (!isDir(root)) continue;
    const candidates = [root];
    for (const ent of readDir(root)) {
      if (ent.isDirectory() && ROM_ROOT_NAMES.includes(ent.name.toLowerCase())) candidates.push(path.join(root, ent.name));
    }
    for (const c of candidates) {
      for (const ent of readDir(c)) {
        if (ent.isDirectory() && sys.romFolderNames.includes(ent.name.toLowerCase())) found.add(path.join(c, ent.name));
      }
    }
  }
  return [...found];
}

function regQuery(key, value) {
  return new Promise(resolve => {
    if (process.platform !== 'win32') return resolve(null);
    execFile('reg', ['query', key, '/v', value], { windowsHide: true }, (err, out) => {
      if (err) return resolve(null);
      const m = String(out).match(new RegExp(value + '\\s+REG_\\w+\\s+(.+)', 'i'));
      resolve(m ? m[1].trim() : null);
    });
  });
}

async function findSteam() {
  // (Linux) Steam's own folder (the one with steamapps): native, the Steam Deck's, or the Flatpak's
  if (process.platform === 'linux') {
    for (const p of ['%HOME%/.steam/steam', '%HOME%/.local/share/Steam', '%HOME%/.var/app/com.valvesoftware.Steam/.local/share/Steam'].map(expand))
      if (isDir(path.join(p, 'steamapps'))) { try { return require('fs').realpathSync(p); } catch { return p; } }
    return null;
  }
  const reg = await regQuery('HKCU\\Software\\Valve\\Steam', 'SteamPath');
  const options = [reg && reg.replace(/\//g, '\\'), expand('%ProgramFiles(x86)%\\Steam'), expand('%ProgramFiles%\\Steam'), 'C:\\Steam', 'D:\\Steam'];
  for (const p of options) if (p && isFile(path.join(p, 'steam.exe'))) return p;
  return null;
}

async function detectAll() {
  const systems = {}, index = makeIndex();
  for (const s of CONSOLES) {
    systems[s.id] = { emulator: findExe(s.emulatorFolders, s.exeNames, index), romDirs: findRomDirs(s) };
  }
  const apps = {};
  for (const a of APPS) apps[a.id] = { path: findExe(a.folders, a.exeNames, index) };
  return { systems, apps, steam: { path: await findSteam() }, appRoot: appRoot() };
}

// one console's emulator and games folders (a console added in an update, found once as setup would have)
function detectSystem(id) { const s = CONSOLES.find(c => c.id === id); return s ? { emulator: findExe(s.emulatorFolders, s.exeNames), romDirs: findRomDirs(s) } : null; }

module.exports = { detectAll, detectSystem, findSteam };
