// Reads installed Steam games, playtime and cover art straight from the Steam folder.
const fs = require('fs');
const path = require('path');
const vdf = require('./vdf');
const { isDir, isFile, readDir } = require('./paths');

// Steam installs helpers alongside games (Proton, runtimes, redistributables, SteamVR…): they're not for the shelf.
// cfg.steam.hideTools (default on) hides them; soundtracks, dedicated servers, SDKs and benchmarks are never games.
const NEVER_GAMES = /soundtrack|dedicated server|\bsdk\b|benchmark/i;
const TOOL_NAMES = /redistributable|steamworks common|^proton\b|proton (experimental|hotfix|easyanticheat|battleye)|steam linux runtime|^steamvr\b|steam audio|directx|visual c\+\+|vc\+\+ ?redist|vcredist|\.net framework|physx|steam controller config|steamworks shared|openvr|compatibility tool/i;
const TOOL_IDS = new Set([ // the well-known ones; anything else is caught by its name
  '228980', // Steamworks Common Redistributables
  '1070560', '1391110', '1628350', // Steam Linux Runtime (scout / soldier / sniper)
  '858280', '961940', '1054830', '1113280', '1245040', '1420170', '1580130', '1887720', '2348590', '2805730', '1493710', '2180100', '2230260', // Proton 3.7 … 9.0, Experimental, Hotfix, Next
  '1161040', '1826330', // Proton BattlEye / EasyAntiCheat runtimes
  '250820', '323910', // SteamVR, SteamVR Performance Test
  '241100' // Steam Controller Configs
]);
function isTool(appid, name) { return TOOL_IDS.has(String(appid)) || TOOL_NAMES.test(String(name || '')); }

function readVdf(file) {
  try { return vdf.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } // (beta.10: a byte-order mark made the first key unreadable)
}
// (beta.10) the folder the user gave: Steam's own folder, or by mistake its steamapps folder or another library
// ("D:\SteamLibrary"): all of them lead to the games. Returns the folder that holds steamapps, or null
function steamRoot(p) {
  if (!p) return null;
  let s = String(p).trim().replace(/^"(.*)"$/, '$1').replace(/[\\/]+$/, '');
  if (/\.(exe|sh)$/i.test(s) || /[\\/]steam$/i.test(s) && !isDir(s)) s = path.dirname(s); // (beta.10: steam.exe itself picked, or pasted with quotes)
  if (/^steamapps$/i.test(path.basename(s)) && isDir(s)) return path.dirname(s);
  if (isDir(path.join(s, 'steamapps'))) return s;
  return null;
}
// installed: Steam's "fully installed" flag, or a game whose update is waiting / paused / running (flags like 6, 1026,
// 1542 drop the 4 while an update is queued): it's on disk and still plays
function installedState(st, lib) {
  const flags = +(vdf.get(st, 'StateFlags') || 0);
  if (flags & 4) return true;
  if (flags & 1) return false; // uninstalled
  const dir = vdf.get(st, 'installdir');
  return +(vdf.get(st, 'SizeOnDisk') || 0) > 0 && !!dir && isDir(path.join(lib, 'steamapps', 'common', String(dir)));
}

function libraryFolders(steamPath) {
  // the same folder spelled differently ("C:\Steam\" vs "c:\steam") is one library: keyed by its normalised path
  const out = new Map(), add = p => { const k = path.resolve(p).replace(/[\\/]+$/, '').toLowerCase(); if (!out.has(k)) out.set(k, p); };
  add(steamPath);
  const lf = readVdf(path.join(steamPath, 'steamapps', 'libraryfolders.vdf'));
  const root = lf && (vdf.get(lf, 'libraryfolders') || vdf.get(lf, 'LibraryFolders'));
  if (root) {
    for (const v of Object.values(root)) {
      const p = typeof v === 'string' ? v : vdf.get(v, 'path');
      if (p && isDir(p)) add(p.replace(/\\\\/g, '\\'));
    }
  }
  return [...out.values()];
}

// Playtime + last played from the most recently used Steam account.
function userStats(steamPath) {
  const ud = path.join(steamPath, 'userdata');
  let best = null, bestTime = 0;
  for (const ent of readDir(ud)) {
    if (!ent.isDirectory()) continue;
    const f = path.join(ud, ent.name, 'config', 'localconfig.vdf');
    try { const t = fs.statSync(f).mtimeMs; if (t > bestTime) { bestTime = t; best = f; } } catch {}
  }
  if (!best) return {};
  const data = readVdf(best);
  const apps = data && vdf.get(data, 'UserLocalConfigStore', 'Software', 'Valve', 'Steam', 'apps');
  const stats = {};
  if (apps) for (const [id, a] of Object.entries(apps)) {
    stats[id] = { minutes: +(vdf.get(a, 'Playtime') || 0), lastPlayed: +(vdf.get(a, 'LastPlayed') || 0) };
  }
  return stats;
}

// Steam stores covers as librarycache\<id>_library_600x900.jpg (older)
// or librarycache\<id>\...\library_600x900.jpg (newer).
function findArt(steamPath, appid) {
  const cache = path.join(steamPath, 'appcache', 'librarycache');
  const pick = (names) => {
    for (const n of names) { const f = path.join(cache, n); if (isFile(f)) return f; }
    const dir = path.join(cache, appid);
    const stack = [[dir, 0]];
    while (stack.length) {
      const [d, depth] = stack.pop();
      for (const ent of readDir(d)) {
        const full = path.join(d, ent.name);
        if (ent.isFile() && names.some(x => ent.name.toLowerCase() === x.replace(appid + '_', '').toLowerCase())) return full;
        if (ent.isDirectory() && depth < 2) stack.push([full, depth + 1]);
      }
    }
    return null;
  };
  return {
    front: pick([`${appid}_library_600x900_2x.jpg`, `${appid}_library_600x900.jpg`]),
    hero: pick([`${appid}_library_hero.jpg`])
  };
}

// Steam's own folder (the one with the list of every library, playtimes and its cover cache), not just a library on
// another drive: it has userdata or appcache beside steamapps
const isMainSteam = p => !!p && (isDir(path.join(p, 'userdata')) || isDir(path.join(p, 'appcache')));
function scanSteam(givenPath, opts = {}) {
  const hideTools = opts.hideTools !== false, log = typeof opts.log === 'function' ? opts.log : () => {};
  const given = steamRoot(givenPath);
  if (!given) { log('Steam: no steamapps folder in the Steam folder set in Settings'); return []; }
  // (beta.10) a library on another drive set as "the Steam folder" (D:\SteamLibrary): Steam's own folder (opts.mainPath,
  // found by main.js) still lists every library on every drive, so games on the other drives, playtimes and covers show too
  const main = steamRoot(opts.mainPath), steamPath = isMainSteam(given) || !main ? given : main;
  const stats = userStats(steamPath);
  const games = [], seen = new Set(); let manifests = 0, notInstalled = 0, tools = 0;
  const libs = libraryFolders(steamPath); if (steamPath !== given && !libs.some(l => path.resolve(l).toLowerCase() === path.resolve(given).toLowerCase())) libs.push(given);
  for (const lib of libs) {
    const apps = path.join(lib, 'steamapps');
    for (const ent of readDir(apps)) {
      if (!/^appmanifest_\d+\.acf$/i.test(ent.name)) continue;
      const m = readVdf(path.join(apps, ent.name));
      const st = m && vdf.get(m, 'AppState');
      if (!st) continue; manifests++;
      const appid = String(vdf.get(st, 'appid') || '');
      const name = vdf.get(st, 'name') || '';
      if (!appid || NEVER_GAMES.test(name) || (hideTools && isTool(appid, name))) { tools++; continue; }
      if (!installedState(st, lib)) { notInstalled++; continue; } // (beta.10: a game with an update waiting counts as installed)
      if (seen.has(appid)) continue; seen.add(appid);
      const s = stats[appid] || {};
      games.push({
        kind: 'steam',
        id: 'steam-' + appid,
        appid,
        title: name,
        sizeBytes: +(vdf.get(st, 'SizeOnDisk') || 0),
        minutes: s.minutes || 0,
        lastPlayed: s.lastPlayed || +(vdf.get(st, 'LastPlayed') || 0),
        art: findArt(steamPath, appid)
      });
    }
  }
  games.sort((a, b) => a.title.localeCompare(b.title));
  // (beta.10) what was found, so a problem report says why the PC shelf is empty (counts only, no paths)
  const key = [libs.length, manifests, games.length, notInstalled, tools].join('/'); if (key !== lastLogKey) { lastLogKey = key; log(`Steam: ${libs.length} ${libs.length === 1 ? 'library' : 'libraries'}, ${manifests} installed items, ${games.length} games (${tools} tools / soundtracks left out, ${notInstalled} not installed)`); }
  return games;
}
let lastLogKey = '';

module.exports = { scanSteam, isTool, steamRoot, isMainSteam };
