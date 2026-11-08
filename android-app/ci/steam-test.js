// Plain Node test (beta.10): Steam games are found however the Steam folder was given, and games with an update waiting
// still show. Run: node android-app/ci/steam-test.js   (also run by ci/issues-test.js)
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const { scanSteam, steamRoot } = require(path.join(__dirname, '..', '..', 'main', 'steam.js'));
let fails = 0; const check = (name, ok, detail) => { console.log((ok ? '✅ ' : '❌ ') + name + (ok || detail == null ? '' : '  -> ' + String(detail).slice(0, 300))); if (!ok) fails++; };
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'bx-steam-'));
const mk = (p, s) => { const f = path.join(T, p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s == null ? 'x' : s); return f; };
const acf = (id, name, flags, dir, size, bom) => (bom ? '﻿' : '') + `"AppState"\n{\n\t"appid"\t\t"${id}"\n\t"name"\t\t"${name}"\n\t"StateFlags"\t\t"${flags}"\n\t"installdir"\t\t"${dir}"\n\t"SizeOnDisk"\t\t"${size}"\n}\n`;
try {
  const lib2 = path.join(T, 'SteamLibrary');
  mk('Steam/steam.exe'); mk('Steam/steamapps/libraryfolders.vdf', `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"${path.join(T, 'Steam').replace(/\\/g, '\\\\')}"\n\t}\n\t"1"\n\t{\n\t\t"path"\t\t"${lib2.replace(/\\/g, '\\\\')}"\n\t}\n}\n`);
  mk('Steam/steamapps/appmanifest_10.acf', acf(10, 'Installed Game', 4, 'Installed Game', 1000));
  mk('Steam/steamapps/common/Installed Game/game.exe');
  mk('Steam/steamapps/appmanifest_20.acf', acf(20, 'Update Waiting', 1026, 'Update Waiting', 5000)); mk('Steam/steamapps/common/Update Waiting/game.exe');
  mk('Steam/steamapps/appmanifest_30.acf', acf(30, 'Still Downloading', 1026, 'Still Downloading', 0));
  mk('Steam/steamapps/appmanifest_40.acf', acf(40, 'Proton 9.0', 4, 'Proton 9.0', 100));
  mk('SteamLibrary/steamapps/appmanifest_50.acf', acf(50, 'Other Drive Game', 4, 'Other Drive Game', 100, true)); // (with a byte-order mark)
  const want = ['Installed Game', 'Other Drive Game', 'Update Waiting'];
  const t = list => list.map(g => g.title).sort();
  const a = scanSteam(path.join(T, 'Steam')), b = scanSteam(path.join(T, 'Steam', 'steamapps')), c = scanSteam(path.join(T, 'Steam') + path.sep);
  check('Steam folder: installed games and one with an update waiting, from both libraries; tools and a download in progress left out', JSON.stringify(t(a)) === JSON.stringify(want), JSON.stringify(t(a)));
  check('Its steamapps folder given instead (or with a trailing slash) finds the same', JSON.stringify(t(b)) === JSON.stringify(want) && JSON.stringify(t(c)) === JSON.stringify(want), JSON.stringify([t(b), t(c)]));
  check('steamRoot: steam.exe itself or a quoted path leads to the Steam folder', steamRoot(path.join(T, 'Steam', 'steam.exe')) === path.join(T, 'Steam') && steamRoot('"' + path.join(T, 'Steam') + '"') === path.join(T, 'Steam'), '');
  check('steamRoot: a library folder works, a folder without steamapps doesn\'t', steamRoot(lib2) === lib2 && steamRoot(path.join(T, 'nowhere')) === null && steamRoot('') === null, '');
  // a library on another drive set as the Steam folder: with Steam's own folder found, every library's games show
  mk('Steam/userdata/1/config/localconfig.vdf', '"UserLocalConfigStore"{}');
  const d = scanSteam(lib2, { mainPath: path.join(T, 'Steam') }), e = scanSteam(lib2);
  check('A library on another drive set as the Steam folder: every drive\'s games once Steam\'s own folder is found (that drive\'s alone without it)',
    JSON.stringify(t(d)) === JSON.stringify(want) && JSON.stringify(t(e)) === JSON.stringify(['Other Drive Game']), JSON.stringify([t(d), t(e)]));
  const logs = []; scanSteam(path.join(T, 'nowhere'), { log: m => logs.push(m) });
  check('A wrong Steam folder says so in the log (no path in it)', logs.length === 1 && /no steamapps folder/.test(logs[0]) && !logs[0].includes(T), JSON.stringify(logs));
} catch (e) { check('the test ran to the end', false, e && e.stack); }
try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
console.log(fails ? fails + ' check(s) failed' : 'ALL PASSED');
process.exit(fails ? 1 : 0);
