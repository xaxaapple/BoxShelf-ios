// (beta.8) Linux / Steam Deck: where Boxshelf is running (a Steam Deck? started by Steam? Game Mode?) and "Add Boxshelf
// to Steam", the way Steam ROM Manager adds ES-DE and Pegasus: an entry in Steam's own list of non-Steam games
// (userdata/<user>/config/shortcuts.vdf, binary KeyValues), so Boxshelf starts from Steam and Game Mode, and Steam gives
// it (and every emulator it starts) a real gamepad. In Desktop Mode, outside Steam, the Deck's controller is a keyboard
// and mouse: B is Esc, which quits most emulators' games.
// Steam rewrites shortcuts.vdf when it exits, so it's only written while Steam is closed (Boxshelf can close Steam and
// start it again). The old file is kept as shortcuts.vdf.boxshelf-bak; adding again updates the same entry.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const { execFile, spawn } = require('child_process');

let log = () => {};
function init(o) { log = o.log || log; }
const isLinux = process.platform === 'linux';
const read = f => { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return ''; } };

// ---------- where Boxshelf runs ----------
// a Steam Deck (Valve's board; LCD "Jupiter", OLED "Galileo"). BS_FAKE_DECK=1: the tests' pretend Deck
function isDeck() {
  if (process.env.BS_FAKE_DECK === '1') return true;
  if (!isLinux) return false;
  return read('/sys/devices/virtual/dmi/id/board_vendor') === 'Valve' || /^(Jupiter|Galileo)$/i.test(read('/sys/devices/virtual/dmi/id/product_name'));
}
const startedBySteam = () => !!(process.env.SteamGameId || process.env.SteamClientLaunch || process.env.SteamEnv || process.env.SteamGamepadUI || process.env.SteamAppId);
const gameMode = () => process.env.XDG_CURRENT_DESKTOP === 'gamescope' || !!process.env.GAMESCOPE_WAYLAND_DISPLAY || !!process.env.SteamGamepadUI;
function info() {
  return { linux: isLinux, deck: isDeck(), steam: startedBySteam(), gameMode: gameMode(), appImage: process.env.APPIMAGE || '',
    canAdd: isLinux && !!process.env.APPIMAGE, flags: ['--no-sandbox', '--ozone-platform=x11'].filter(f => process.argv.includes(f)) };
}

// ---------- Steam's folders ----------
function steamRoots() {
  const h = os.homedir();
  const c = [path.join(h, '.local', 'share', 'Steam'), path.join(h, '.steam', 'steam'), path.join(h, '.steam', 'root'),
    path.join(h, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam')];
  const out = [], seen = new Set();
  for (const d of c) { let r; try { r = fs.realpathSync(d); } catch { continue; } if (!seen.has(r) && fs.existsSync(path.join(r, 'userdata'))) { seen.add(r); out.push(r); } }
  return out;
}
// every Steam account on this PC that has signed in here (a numeric folder with a config folder)
function userDirs() {
  const out = [];
  for (const root of steamRoots()) { let ids = []; try { ids = fs.readdirSync(path.join(root, 'userdata')); } catch {}
    for (const id of ids) if (/^\d+$/.test(id) && id !== '0' && fs.existsSync(path.join(root, 'userdata', id, 'config'))) out.push({ root, id, dir: path.join(root, 'userdata', id, 'config') }); }
  return out;
}

// ---------- binary KeyValues (shortcuts.vdf) ----------
// types: 0 = a map, 1 = a string, 2 = an int32, 3 = a float32, 7 = a uint64, 8 = end of the map. Read into
// [{ k, t, v }] lists (order and every value kept, so writing it back changes nothing we didn't mean to)
function parse(buf) {
  let p = 0;
  const str = () => { const e = buf.indexOf(0, p); if (e < 0) throw new Error('bad shortcuts.vdf'); const s = buf.toString('utf8', p, e); p = e + 1; return s; };
  function map() { const out = [];
    for (;;) { if (p >= buf.length) throw new Error('bad shortcuts.vdf (ends early)'); const t = buf[p++]; if (t === 8) return out; const k = str();
      if (t === 0) out.push({ k, t, v: map() }); else if (t === 1) out.push({ k, t, v: str() });
      else if (t === 2) { out.push({ k, t, v: buf.readInt32LE(p) }); p += 4; } else if (t === 3) { out.push({ k, t, v: buf.readFloatLE(p) }); p += 4; }
      else if (t === 7) { out.push({ k, t, v: buf.readBigUInt64LE(p) }); p += 8; } else throw new Error('bad shortcuts.vdf (type ' + t + ')'); } }
  const root = map(); return root;
}
function write(list) {
  const parts = [], s = x => Buffer.from(x + '\0', 'utf8');
  (function map(L) { for (const e of L) { parts.push(Buffer.from([e.t]), s(e.k));
      if (e.t === 0) { map(e.v); parts.push(Buffer.from([8])); } else if (e.t === 1) parts.push(s(e.v));
      else if (e.t === 2) { const b = Buffer.alloc(4); b.writeInt32LE(e.v | 0); parts.push(b); } else if (e.t === 3) { const b = Buffer.alloc(4); b.writeFloatLE(e.v); parts.push(b); }
      else if (e.t === 7) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(e.v)); parts.push(b); } } })(list);
  parts.push(Buffer.from([8])); return Buffer.concat(parts);
}
// Steam's id for a non-Steam game: CRC32 of exe + name with the top bit set (the artwork in config/grid uses it too)
function crc32(b) { if (zlib.crc32) return zlib.crc32(b) >>> 0; let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return ~c >>> 0; }
const shortcutId = (exe, name) => (crc32(Buffer.from(exe + name, 'utf8')) | 0x80000000) >>> 0;
const get = (L, k) => (L.find(e => e.k.toLowerCase() === k.toLowerCase()) || {}).v;

// the entry for Boxshelf (exe: the AppImage). Returns the new list and whether one was already there.
function withBoxshelf(root, o) {
  const top = root.find(e => e.t === 0 && e.k.toLowerCase() === 'shortcuts') || (root.push({ k: 'shortcuts', t: 0, v: [] }), root[root.length - 1]);
  const L = top.v, q = s => '"' + s + '"', exe = q(o.exe), id = shortcutId(exe, o.name);
  const fields = [['appid', 2, id | 0], ['AppName', 1, o.name], ['Exe', 1, exe], ['StartDir', 1, q(path.dirname(o.exe))], ['icon', 1, o.icon || ''], ['ShortcutPath', 1, ''],
    ['LaunchOptions', 1, o.launch || ''], ['IsHidden', 2, 0], ['AllowDesktopConfig', 2, 1], ['AllowOverlay', 2, 1], ['OpenVR', 2, 0], ['Devkit', 2, 0], ['DevkitGameID', 1, ''],
    ['DevkitOverrideAppID', 2, 0], ['LastPlayTime', 2, 0], ['FlatpakAppID', 1, '']];
  // (an entry that's ours: the same program, or a Boxshelf AppImage of another version / place)
  const mine = e => { const x = String(get(e.v, 'Exe') || ''); return x === exe || /boxshelf[^/]*\.appimage"?$/i.test(x) || get(e.v, 'AppName') === o.name; };
  let ent = L.find(e => e.t === 0 && mine(e)), had = !!ent;
  if (!ent) { ent = { k: String(L.length), t: 0, v: [] }; L.push(ent); }
  for (const [k, t, v] of fields) { const cur = ent.v.find(e => e.k.toLowerCase() === k.toLowerCase()); if (cur) { cur.t = t; cur.v = v; } else ent.v.push({ k, t, v }); }
  if (!ent.v.some(e => e.k.toLowerCase() === 'tags')) ent.v.push({ k: 'tags', t: 0, v: [] });
  return { root, id, had };
}

// ---------- Steam running? close it, start it again ----------
function steamRunning() {
  if (!isLinux) return false;
  let pids = []; try { pids = fs.readdirSync('/proc').filter(n => /^\d+$/.test(n)); } catch { return false; }
  for (const p of pids) { let c = ''; try { c = fs.readFileSync(`/proc/${p}/comm`, 'utf8').trim(); } catch { continue; } if (c === 'steam' || c === 'steamwebhelper') return true; }
  return false;
}
const steamCmd = () => { for (const c of ['/usr/bin/steam', '/usr/games/steam']) if (fs.existsSync(c)) return c; return 'steam'; };
async function closeSteam() {
  await new Promise(r => execFile(steamCmd(), ['-shutdown'], { timeout: 15000 }, () => r()));
  for (let i = 0; i < 60 && steamRunning(); i++) await new Promise(r => setTimeout(r, 500));
  return !steamRunning();
}
function startSteam() { try { const p = spawn(steamCmd(), [], { detached: true, stdio: 'ignore' }); p.unref(); } catch (e) { log('Steam: could not start it again:', e.message); } }

// ---------- Add Boxshelf to Steam ----------
// o: { exe (the AppImage), iconSrc (Boxshelf's icon, copied beside the data), dataDir, closeSteam (true: close it first and
// start it again after) }. Answers { ok, users, updated } or { ok: false, why: 'steam-running' | 'no-steam' | … }
async function addToSteam(o) {
  if (!isLinux && process.env.BS_FAKE_DECK !== '1') return { ok: false, why: 'not-linux' };
  if (!o.exe) return { ok: false, why: 'not-appimage' };
  if (gameMode()) return { ok: false, why: 'game-mode' }; // (already in Steam; and Steam can't be closed from under its own session)
  const users = userDirs(); if (!users.length) return { ok: false, why: 'no-steam' };
  let reopened = false;
  if (steamRunning()) { if (!o.closeSteam) return { ok: false, why: 'steam-running' }; if (!(await closeSteam())) return { ok: false, why: 'steam-would-not-close' }; reopened = true; }
  let icon = '';
  try { if (o.iconSrc && o.dataDir) { icon = path.join(o.dataDir, 'steam', 'boxshelf-icon.png'); fs.mkdirSync(path.dirname(icon), { recursive: true }); fs.copyFileSync(o.iconSrc, icon); } } catch { icon = ''; }
  const done = []; let updated = 0;
  for (const u of users) {
    const f = path.join(u.dir, 'shortcuts.vdf');
    try {
      let root = [];
      if (fs.existsSync(f)) { const buf = fs.readFileSync(f); root = buf.length ? parse(buf) : []; fs.copyFileSync(f, f + '.boxshelf-bak'); }
      const r = withBoxshelf(root, { exe: o.exe, name: 'Boxshelf', icon, launch: '' });
      const tmp = f + '.part'; fs.writeFileSync(tmp, write(r.root)); fs.renameSync(tmp, f);
      // the Library's artwork: Boxshelf's icon as the tile, until a proper one is chosen in Steam
      try { const grid = path.join(u.dir, 'grid'); fs.mkdirSync(grid, { recursive: true }); if (icon) for (const n of [r.id + '_icon.png']) fs.copyFileSync(icon, path.join(grid, n)); } catch {}
      done.push(u.id); if (r.had) updated++;
      // (beta.10: the account number stays out of the log, which goes into problem reports: "Steam user 1 of 2")
      log('Steam: Boxshelf', r.had ? 'updated in' : 'added to', 'the shortcuts of Steam user', (users.indexOf(u) + 1) + ' of ' + users.length);
    } catch (e) { log('Steam: shortcuts for user', (users.indexOf(u) + 1) + ' of ' + users.length, 'not changed:', e.code || 'error'); } // (e.code only: the message holds the path, with the account number in it)
  }
  if (reopened) startSteam();
  return done.length ? { ok: true, users: done.length, updated: updated > 0, reopened } : { ok: false, why: 'write-failed' };
}
// already in Steam? (any account's shortcuts list has it)
function inSteam(exe) {
  for (const u of userDirs()) { try { const L = parse(fs.readFileSync(path.join(u.dir, 'shortcuts.vdf'))); const top = L.find(e => e.k.toLowerCase() === 'shortcuts'); if (top && top.v.some(e => e.t === 0 && (String(get(e.v, 'Exe') || '') === '"' + exe + '"' || /boxshelf[^/]*\.appimage"?$/i.test(String(get(e.v, 'Exe') || ''))))) return true; } catch {} }
  return false;
}

module.exports = { init, info, isDeck, startedBySteam, gameMode, steamRoots, userDirs, parse, write, withBoxshelf, shortcutId, crc32, steamRunning, addToSteam, inSteam };
