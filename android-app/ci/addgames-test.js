// (beta.7) Add games (main/addgames.js) in plain Node: a folder of games scanned (each folder's main program picked,
// helpers left out), names from programs, and a pretend Playnite library turned into what Boxshelf adds.
// node ci/addgames-test.js
const fs = require('fs'), path = require('path'), os = require('os');
const A = require('../../main/addgames');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-addgames-'));
let fails = 0; const ok = (c, m, d) => { console.log((c ? '✅ ' : '❌ ') + m + (c || d == null ? '' : '  → ' + d)); if (!c) fails++; };
const put = (p, size = 10) => { const f = path.join(root, ...p.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, Buffer.alloc(size)); return f; };

// a games folder: a game named like its program, one whose program sits in bin\x64, one with only a big program, helpers
put('Games/Hollow Knight/hollow_knight.exe', 500); put('Games/Hollow Knight/UnityCrashHandler64.exe', 900);
put('Games/Celeste (GOG)/Celeste.exe', 300); put('Games/Celeste (GOG)/unins000.exe', 2000); put('Games/Celeste (GOG)/__redist/vcredist_x64.exe', 5000);
put('Games/Hades/x64/Hades.exe', 700); put('Games/Hades/x64/EasyAntiCheat_Setup.exe', 9000);
put('Games/Big Game/launcher.exe', 100); put('Games/Big Game/bin/win64/BigGame-Win64-Shipping.exe', 8000);
fs.mkdirSync(path.join(root, 'Games', 'Empty Folder'), { recursive: true });
const r = A.scanFolder(path.join(root, 'Games'));
const by = Object.fromEntries(r.games.map(g => [g.title, path.basename(g.exe)]));
ok(r.games.length === 4 && by['Hollow Knight'] === 'hollow_knight.exe' && by['Celeste'] === 'Celeste.exe' && by['Hades'] === 'Hades.exe' && by['Big Game'] === 'BigGame-Win64-Shipping.exe',
  'Scan a folder: one game per folder, its main program (named like the folder, else the biggest), helpers and empty folders left out', JSON.stringify(by));
ok(A.titleFor(path.join(root, 'Games', 'Big Game', 'bin', 'win64', 'x.exe')) === 'Big Game' && A.titleFor(path.join(root, 'Odd', 'My_Cool.Game.exe'), path.join(root, 'Odd')) === 'My Cool Game',
  'Names: the nearest folder that isn\'t "bin" / "win64", else the program\'s own name tidied');

// Playnite: a pretend library (the shape LiteDB's JSON gives once unwrapped)
const app = path.join(root, 'Playnite'), lib = path.join(app, 'library'); fs.mkdirSync(path.join(lib, 'files', 'g1'), { recursive: true });
const cover = put('Playnite/library/files/g1/cover.jpg', 50);
const EMPTY = '00000000-0000-0000-0000-000000000000', STEAM = 'cb91dfc9-b977-43bf-8e70-55f46e410fab';
const pGC = 'aaaa', pPC = 'bbbb', emuId = 'eeee';
const L = {
  platforms: [{ Id: pGC, Name: 'Nintendo GameCube', SpecificationId: 'nintendo_gamecube' }, { Id: pPC, Name: 'PC (Windows)', SpecificationId: 'pc_windows' }],
  emulators: [{ Id: emuId, Name: 'Dolphin', InstallDir: 'D:\\Emus\\Dolphin' }],
  games: [
    { Id: 'g1', Name: 'Ori', PluginId: EMPTY, PlatformIds: [pPC], InstallDirectory: 'D:\\Games\\Ori', GameActions: [{ Type: 0, Path: '{InstallDir}\\ori.exe', Arguments: '-windowed', IsPlayAction: true }], CoverImage: 'g1\\cover.jpg', Favorite: true },
    { Id: 'g2', Name: 'Portal 2', PluginId: STEAM, PlatformIds: [pPC], GameActions: [{ Type: 0, Path: 'C:\\Steam\\portal2.exe', IsPlayAction: true }] },
    { Id: 'g3', Name: 'Pikmin', PluginId: EMPTY, PlatformIds: [pGC], GameActions: [{ Type: 2, EmulatorId: emuId, IsPlayAction: true }], Roms: [{ Path: 'E:\\ROMs\\GC\\Pikmin.rvz' }] },
    { Id: 'g4', Name: 'Wind Waker', PluginId: EMPTY, PlatformIds: [pGC], GameActions: [{ Type: 2, EmulatorId: emuId, IsPlayAction: true }], Roms: [{ Path: 'E:\\ROMs\\GC\\WW.rvz' }] },
    { Id: 'g5', Name: 'Secret', PluginId: EMPTY, Hidden: true, GameActions: [{ Type: 0, Path: 'x.exe', IsPlayAction: true }] },
    { Id: 'g6', Name: 'Web game', PluginId: EMPTY, GameActions: [{ Type: 1, Path: 'https://example.com', IsPlayAction: true }] }
  ]
};
const P = A.plan(L, { app, library: lib });
const ori = P.pc[0] || {};
ok(P.pc.length === 1 && ori.title === 'Ori' && /D:\\Games\\Ori\\ori\.exe$/.test(ori.exe) && ori.args === '-windowed' && ori.cover === cover && ori.favorite === true,
  'Playnite: a game you added by hand comes over with its program ({InstallDir} filled in), options, cover and favourite', JSON.stringify(ori));
ok(P.consoles.gc && P.consoles.gc.count === 2 && P.consoles.gc.dirs.length === 1 && P.consoles.gc.dirs[0] === 'E:\\ROMs\\GC' && P.consoles.gc.emulatorDir === 'D:\\Emus\\Dolphin',
  'Playnite: emulated games become their folder on the matching console shelf, with the emulator\'s folder', JSON.stringify(P.consoles));
ok(P.skipped.store === 1 && P.skipped.hidden === 1 && P.skipped.link === 1, 'Playnite: store games (Boxshelf reads Steam itself), hidden games and web links are left out and counted', JSON.stringify(P.skipped));

fs.rmSync(root, { recursive: true, force: true });
console.log(fails ? `add games test: ${fails} failed` : 'add games test: all good');
process.exit(fails ? 1 : 0);
