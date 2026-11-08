// Linux build, test 1 (plain Node, on Linux): emulator and games detection in a made-up Steam Deck-style home folder.
// An EmuDeck ROM folder (~/Emulation/roms/snes), a RetroDECK one (~/retrodeck/roms/psx), a Flatpak Dolphin (its
// exported launcher), a DuckStation AppImage in ~/Applications, RetroArch in ~/.local/bin with its SNES core in
// ~/.config/retroarch/cores, and Steam in ~/.local/share/Steam. Exit code 1 = something wasn't found.
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
if (process.platform !== 'linux') { console.log('Linux only: skipped'); process.exit(0); }

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bxhome-'));
process.env.HOME = HOME; // (os.homedir() and %HOME% both follow it)
const mk = (p, body, exec) => { const f = path.join(HOME, p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body || ''); if (exec) fs.chmodSync(f, 0o755); return f; };
const ra = mk('.local/bin/retroarch', '#!/bin/sh\nexit 0\n', true);
const dolphin = mk('.local/share/flatpak/exports/bin/org.DolphinEmu.dolphin-emu', '#!/bin/sh\nexit 0\n', true);
const duck = mk('Applications/DuckStation-x64.AppImage', '#!/bin/sh\nexit 0\n', true);
const core = mk('.config/retroarch/cores/snes9x_libretro.so', 'x');
mk('Emulation/roms/snes/Test Game (USA).sfc', 'x'); mk('Emulation/roms/gc/Test (USA).rvz', 'x'); mk('retrodeck/roms/psx/Test (USA).cue', 'x');
const ryu = mk('Applications/Ryujinx.AppImage', '#!/bin/sh\nexit 0\n', true); mk('Emulation/roms/switch/Test (USA).nsp', 'x'); // (beta.8: EmuDeck's Switch emulator)
fs.mkdirSync(path.join(HOME, '.local/share/Steam/steamapps'), { recursive: true });

const root = path.resolve(__dirname, '..', '..');
const paths = require(path.join(root, 'main', 'paths.js')); paths.setAppRoot(path.join(HOME, 'Boxshelf'));
const { CONSOLES } = require(path.join(root, 'main', 'systems.js'));
const { detectAll } = require(path.join(root, 'main', 'detect.js'));
const linux = require(path.join(root, 'main', 'linux.js'));

let fails = 0; const check = (name, ok, detail) => { console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : '  -> ' + detail)); if (!ok) fails++; };
(async () => {
  check('Linux tables in use (no Windows .exe names)', !CONSOLES.some(c => c.exeNames.some(n => /\.exe$/i.test(n))), CONSOLES.find(c => c.exeNames.some(n => /\.exe$/i.test(n)))?.id);
  const d = await detectAll();
  const s = id => d.systems[id] || {};
  check('Flatpak Dolphin found for GameCube (its exported launcher)', s('gc').emulator === dolphin, s('gc').emulator);
  check('DuckStation AppImage found for PlayStation (standalone first)', s('psx').emulator === duck, s('psx').emulator);
  check('RetroArch found for SNES', s('snes').emulator === ra, s('snes').emulator);
  check('EmuDeck ROM folder found (~/Emulation/roms/snes)', (s('snes').romDirs || []).includes(path.join(HOME, 'Emulation/roms/snes')), JSON.stringify(s('snes').romDirs));
  check('EmuDeck GameCube folder found (~/Emulation/roms/gc)', (s('gc').romDirs || []).includes(path.join(HOME, 'Emulation/roms/gc')), JSON.stringify(s('gc').romDirs));
  check('RetroDECK ROM folder found (~/retrodeck/roms/psx)', (s('psx').romDirs || []).includes(path.join(HOME, 'retrodeck/roms/psx')), JSON.stringify(s('psx').romDirs));
  check('Steam found (~/.local/share/Steam)', d.steam.path === fs.realpathSync(path.join(HOME, '.local/share/Steam')), d.steam.path);
  check('RetroArch recognised, its SNES core found (.so)', linux.isRetroArch(ra) && linux.isRetroArch('/x/org.libretro.RetroArch') && linux.isRetroArch('/x/RetroArch-Linux-x86_64.AppImage') && !linux.isRetroArch(duck) && linux.retroCore(ra, 'snes9x') === core, linux.retroCore(ra, 'snes9x'));
  check('a missing core is reported as missing', linux.retroCore(ra, 'mesen') === null, linux.retroCore(ra, 'mesen'));
  check('(beta.8) EmuDeck\'s Ryujinx AppImage found for Switch', s('sw').emulator === ryu, s('sw').emulator);

  // (beta.8) Add Boxshelf to Steam: Steam's binary shortcuts list (userdata/<id>/config/shortcuts.vdf). A list that already
  // has another non-Steam game keeps it untouched; Boxshelf is added once (adding again updates the same entry)
  const sd = require(path.join(root, 'main', 'steamdeck.js'));
  const cfgDir = path.join(HOME, '.local/share/Steam/userdata/12345/config'); fs.mkdirSync(cfgDir, { recursive: true });
  const other = sd.write([{ k: 'shortcuts', t: 0, v: [{ k: '0', t: 0, v: [{ k: 'appid', t: 2, v: -123 }, { k: 'AppName', t: 1, v: 'Some Game' }, { k: 'Exe', t: 1, v: '"/x/game"' }, { k: 'LastPlayTime', t: 2, v: 5 }, { k: 'tags', t: 0, v: [{ k: '0', t: 1, v: 'Fav' }] }] }] }]);
  fs.writeFileSync(path.join(cfgDir, 'shortcuts.vdf'), other);
  const img = path.join(HOME, 'Applications/Boxshelf-1.82.0-beta.8-linux.AppImage');
  const r1 = await sd.addToSteam({ exe: img, closeSteam: false }), r2 = await sd.addToSteam({ exe: img, closeSteam: false });
  const L = sd.parse(fs.readFileSync(path.join(cfgDir, 'shortcuts.vdf'))), list = (L.find(e => e.k === 'shortcuts') || { v: [] }).v;
  const g = (e, k) => (e.v.find(x => x.k === k) || {}).v, bx = list.filter(e => g(e, 'AppName') === 'Boxshelf');
  check('Add to Steam: Boxshelf added once (again = the same entry), the other game kept as it was, a backup made',
    r1.ok && r2.ok && r2.updated && list.length === 2 && bx.length === 1 && g(bx[0], 'Exe') === '"' + img + '"' && (g(bx[0], 'appid') >>> 0) === sd.shortcutId('"' + img + '"', 'Boxshelf') && g(list[0], 'AppName') === 'Some Game' && g(list[0], 'LastPlayTime') === 5 && g(list[0], 'tags')[0].v === 'Fav' && fs.existsSync(path.join(cfgDir, 'shortcuts.vdf.boxshelf-bak')),
    JSON.stringify({ r1, r2, n: list.length, names: list.map(e => g(e, 'AppName')) }));
  check('Steam\'s id for a shortcut: CRC32 of exe + name with the top bit set', sd.crc32(Buffer.from('123456789')) === 0xCBF43926 && sd.shortcutId('"/a"', 'B') >= 0x80000000, sd.crc32(Buffer.from('123456789')).toString(16));

  // (beta.8) the AppImage's launch wrapper (scripts/linux-wrapper.js): what it adds, started from the desktop, by Steam, in Game Mode
  const { SCRIPT } = require(path.join(root, 'scripts', 'linux-wrapper.js'));
  const wdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bxwrap-')), wrap = path.join(wdir, 'boxshelf');
  fs.writeFileSync(path.join(wdir, 'boxshelf-bin'), '#!/bin/sh\necho "$@"\n', { mode: 0o755 }); fs.writeFileSync(wrap, SCRIPT.replace(/@BIN@/g, 'boxshelf-bin'), { mode: 0o755 });
  const { execFileSync } = require('child_process');
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(Steam|GAMESCOPE)/i.test(k) && k !== 'XDG_CURRENT_DESKTOP'));
  const runW = env => execFileSync(wrap, ['--x'], { env: { ...clean, ...env }, encoding: 'utf8' }).trim();
  const w0 = runW({}), w1 = runW({ SteamClientLaunch: '1' }), w2 = runW({ SteamGameId: '123', XDG_CURRENT_DESKTOP: 'gamescope', SteamGamepadUI: '1' });
  check('launch wrapper: nothing added from the desktop; --no-sandbox when Steam starts it; X11 too in Game Mode',
    w0 === '--x' && w1 === '--no-sandbox --x' && /^--ozone-platform=x11 --no-sandbox --x$/.test(w2), JSON.stringify([w0, w1, w2]));
  fs.rmSync(wdir, { recursive: true, force: true });

  // (beta.9) hold Select + Start for 1.5 s during a game: Boxshelf closes it (main/linuxpad.js, joystick events fed in)
  const LP = require(path.join(root, 'main', 'linuxpad.js'));
  const ev = (value, type, num) => { const b = Buffer.alloc(8); b.writeUInt32LE(1000, 0); b.writeInt16LE(value, 4); b[6] = type; b[7] = num; return b; };
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'bxjs-'));
  const padRun = async steps => { let quit = 0; LP.init({ dir: empty, sysDir: empty, force: true }); LP.begin(() => quit++);
    for (const s of steps) { if (typeof s === 'number') await new Promise(r => setTimeout(r, s)); else LP._feed('js0', Buffer.concat(s)); } LP.end(); return quit; };
  const held = await padRun([[ev(0, 0x81, 6), ev(0, 0x81, 7), ev(1, 1, 6), ev(1, 1, 7)], 1800]);
  const short = await padRun([[ev(1, 1, 6), ev(1, 1, 7)], 700, [ev(0, 1, 7)], 1500]);
  const already = await padRun([[ev(1, 0x81, 6), ev(1, 0x81, 7)], 1800]);
  const otherBtn = await padRun([[ev(1, 1, 6), ev(1, 1, 0)], 1800]);
  check('hold Select + Start 1.5 s closes the game (once); a short press, another button, or buttons already held at the start don\'t',
    held === 1 && short === 0 && already === 0 && otherBtn === 0, JSON.stringify({ held, short, already, otherBtn }));
  fs.rmSync(empty, { recursive: true, force: true });
  console.log(fails ? `${fails} failed` : 'all passed');
  fs.rmSync(HOME, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
