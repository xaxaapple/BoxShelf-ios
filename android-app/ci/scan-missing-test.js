// Plain Node test (beta.10): games that went missing from the shelf. Builds made-up games folders and scans them with
// main/scanner.js (sync and async). Run: node android-app/ci/scan-missing-test.js   (also run by ci/issues-test.js)
//   - Xbox 360 Games on Demand / Arcade packages (no extension, …\00007000\<hash>) are games; a save in the same layout isn't;
//     an extracted game's data folder adds no extra games
//   - PS3: a US and a European copy are two boxes (region from the id); a game four folders down is found
//   - a games folder reached through a link / junction is scanned
//   - "Hall Pass" and a "Booster" game show on other consoles; on the Switch an update package stays hidden
//   - a game four folders deep (genre folders) is found
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..', '..');
const { CONSOLES } = require(path.join(ROOT, 'main', 'systems.js'));
const scanner = require(path.join(ROOT, 'main', 'scanner.js'));
let fails = 0; const check = (name, ok, detail) => { console.log((ok ? '✅ ' : '❌ ') + name + (ok || detail == null ? '' : '  -> ' + String(detail).slice(0, 400))); if (!ok) fails++; };
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'bx-missing-'));
const mk = (p, data) => { const f = path.join(T, p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data == null ? 'x' : data); return f; };
const def = id => CONSOLES.find(c => c.id === id);
const titles = list => list.map(g => g.title + (g.region ? ' [' + g.region + ']' : '')).sort();

// an STFS package header: magic, content type at 0x344, title id at 0x360, display name (UTF-16BE) at 0x411
function stfs(type, titleId, name) {
  const b = Buffer.alloc(0x2000); b.write('CON ', 0, 'latin1'); b.writeUInt32BE(type, 0x344); b.writeUInt32BE(parseInt(titleId, 16), 0x360);
  const u = Buffer.from(name, 'utf16le'); u.swap16(); u.copy(b, 0x411); return b;
}
// a PARAM.SFO with TITLE, TITLE_ID, CATEGORY
function sfo(o) {
  const keys = Object.keys(o), n = keys.length; let keyTab = Buffer.concat(keys.map(k => Buffer.from(k + '\0', 'utf8')));
  const datas = keys.map(k => { const s = Buffer.from(String(o[k]) + '\0', 'utf8'); const l = Math.ceil(s.length / 4) * 4; const d = Buffer.alloc(l); s.copy(d); return d; });
  const keyOff = 20 + n * 16, dataOff = keyOff + Math.ceil(keyTab.length / 4) * 4, head = Buffer.alloc(dataOff);
  head.writeUInt32LE(0x46535000, 0); head.writeUInt32LE(0x101, 4); head.writeUInt32LE(keyOff, 8); head.writeUInt32LE(dataOff, 12); head.writeUInt32LE(n, 16);
  let ko = 0, dpos = 0; keys.forEach((k, i) => { const e = 20 + i * 16; head.writeUInt16LE(ko, e); head.writeUInt16LE(0x0204, e + 2); head.writeUInt32LE(Buffer.byteLength(String(o[k])) + 1, e + 4); head.writeUInt32LE(datas[i].length, e + 8); head.writeUInt32LE(dpos, e + 12); ko += Buffer.byteLength(k) + 1; dpos += datas[i].length; });
  keyTab.copy(head, keyOff); return Buffer.concat([head, ...datas]);
}

(async () => {
  try {
    // ---- Xbox 360 ----
    mk('x360/Content/0000000000000000/545407F2/00007000/0123456789ABCDEF0123456789ABCDEF01234567', stfs(0x7000, '545407F2', 'Made Up Racer'));
    mk('x360/Content/0000000000000000/545407F2/00007000/0123456789ABCDEF0123456789ABCDEF01234567.data/Data0000');
    mk('x360/Content/0000000000000000/58410A5D/000D0000/89ABCDEF0123456789ABCDEF0123456789ABCDEF', stfs(0xD0000, '58410A5D', 'Tiny Arcade Game'));
    mk('x360/Content/E000000000000000/545407F2/00000001/AAAABBBBCCCCDDDDEEEEFFFF0000111122223333', stfs(0x1, '545407F2', 'Made Up Racer save'));
    mk('x360/Extracted Game/default.xex', 'not a real xex'); mk('x360/Extracted Game/media/extra.xex'); mk('x360/Extracted Game/media/deep/more.xex');
    const xs = { romDirs: [path.join(T, 'x360')] }, x = scanner.scanSystem(def('x360'), xs, true), xa = await scanner.scanSystemAsync(def('x360'), xs, true);
    check('Xbox 360: Games on Demand and Arcade packages are games, named from their header; a save isn\'t; an extracted game is one box',
      JSON.stringify(titles(x)) === JSON.stringify(['Extracted Game', 'Made Up Racer', 'Tiny Arcade Game']), JSON.stringify(titles(x)));
    check('Xbox 360: the background scan finds the same', JSON.stringify(titles(xa)) === JSON.stringify(titles(x)), JSON.stringify(titles(xa)));

    // ---- PS3 ----
    const ps3game = (dir, id, title) => { mk(dir + '/PS3_GAME/USRDIR/EBOOT.BIN'); mk(dir + '/PS3_GAME/PARAM.SFO', sfo({ CATEGORY: 'DG', TITLE: title, TITLE_ID: id })); };
    ps3game('ps3/Made Up Quest [BLUS31234]', 'BLUS31234', 'Made Up Quest'); ps3game('ps3/Made Up Quest [BLES01234]', 'BLES01234', 'Made Up Quest');
    ps3game('ps3/Action/Shooters/Deep Shooter', 'BCUS98765', 'Deep Shooter');
    mk('ps3/dev_hdd0/game/NPUB30001/USRDIR/EBOOT.BIN'); mk('ps3/dev_hdd0/game/NPUB30001/PARAM.SFO', sfo({ CATEGORY: 'HG', TITLE: 'Download Game', TITLE_ID: 'NPUB30001' }));
    mk('ps3/dev_hdd0/game/BLUS31234/USRDIR/EBOOT.BIN'); mk('ps3/dev_hdd0/game/BLUS31234/PARAM.SFO', sfo({ CATEGORY: 'GD', TITLE: 'Made Up Quest', TITLE_ID: 'BLUS31234' })); // (its patch: not a game)
    const p = scanner.scanSystem(def('ps3'), { romDirs: [path.join(T, 'ps3')] }, true);
    check('PS3: a US and a European copy are two boxes, a game in genre folders is found, a download game too, a patch isn\'t',
      JSON.stringify(titles(p)) === JSON.stringify(['Deep Shooter [USA]', 'Download Game [USA]', 'Made Up Quest [Europe]', 'Made Up Quest [USA]']), JSON.stringify(titles(p)));
    check('PS3: regions from ids', scanner.ps3Region('BLJM60001') === 'Japan' && scanner.ps3Region('NPEB00001') === 'Europe' && scanner.ps3Region('BCAS20001') === 'Asia' && scanner.ps3Region('XYZ') === '', '');

    // ---- a link / junction to a folder elsewhere; deep folders; the update words ----
    mk('elsewhere/Linked Game (USA).sfc'); mk('snes/A/B/C/Deep Game (USA).sfc'); mk('snes/Plain Game (USA).sfc');
    let linked = true; try { fs.symlinkSync(path.join(T, 'elsewhere'), path.join(T, 'snes', 'Linked'), 'junction'); } catch (e) { linked = false; console.log('(no link made: ' + e.code + ')'); }
    const s = scanner.scanSystem(def('snes'), { romDirs: [path.join(T, 'snes')] }, true), sa = await scanner.scanSystemAsync(def('snes'), { romDirs: [path.join(T, 'snes')] }, true);
    check('A game four folders down is found' + (linked ? ', and one in a linked folder' : ''), titles(s).includes('Deep Game [USA]') && titles(s).includes('Plain Game [USA]') && (!linked || titles(s).includes('Linked Game [USA]')), JSON.stringify(titles(s)));
    check('…the background scan the same', JSON.stringify(titles(sa)) === JSON.stringify(titles(s)), JSON.stringify(titles(sa)));
    mk('gc/Hall Pass (USA).iso'); mk('gc/Booster Bash (USA).iso');
    const g = scanner.scanSystem(def('gc'), { romDirs: [path.join(T, 'gc')] }, true);
    check('"Hall Pass" and "Booster Bash" show on the GameCube shelf (they were taken for update packages)', titles(g).includes('Hall Pass [USA]') && titles(g).includes('Booster Bash [USA]'), JSON.stringify(titles(g)));
    mk('sw/Some Game (USA).nsp'); mk('sw/Some Game Update v131072.nsp'); mk('sw/Some Game [UPD].nsp'); mk('sw/Some Game Expansion Pass.nsp');
    const w = scanner.scanSystem(def('sw'), { romDirs: [path.join(T, 'sw')] }, true);
    check('Switch: update and DLC packages beside a game stay hidden', JSON.stringify(titles(w)) === JSON.stringify(['Some Game [USA]']), JSON.stringify(titles(w)));
  } catch (e) { check('the test ran to the end', false, e && e.stack); }
  try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
  console.log(fails ? fails + ' check(s) failed' : 'ALL PASSED');
  process.exit(fails ? 1 : 0);
})();
