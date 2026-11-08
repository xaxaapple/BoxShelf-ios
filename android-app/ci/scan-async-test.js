// Node check (beta.10): a big library on a slow disk (a NAS) never holds Boxshelf's main process up. Checks results, and
// how long the event loop is held at most (a loose 100 ms bound, never speed).
//   A made-up library (2,000 Game Boy ROMs with art, manual pages, duplicates and update files beside them, GameCube discs,
//   PS4 folder games) on a "slow disk": every sync fs call busy-waits (a network round trip on the main process), every
//   fs.promises call waits a moment without blocking.
//   (a) main/scanner.js scanSystemAsync gives exactly what scanSystem gives (again from the kept scan, and for two at once);
//   (b) while it runs the event loop is never held longer than 100 ms, and a plain console's scan makes no sync fs call;
//       a forget() while it runs keeps its result out of the kept scans;
//   (c) main/covers.js downloadCovers over 800 games (most with art, some low-res, some with none; the "network" is a stub)
//       gets the same pictures into the same places, holding the event loop under 100 ms;
//   (d) Pause stops it after the games in flight, Resume carries on, Cancel ends a paused run; Pause with nothing running
//       says so.
// Run:  node android-app/ci/scan-async-test.js            (exit code 1 on a failure)
//       node android-app/ci/scan-async-test.js --old <dir>  (<dir>\main holds an older copy of main\: compares with it too)
'use strict';
const path = require('path'), fs = require('fs'), os = require('os'), Module = require('module');
const fsp = fs.promises, { performance } = require('perf_hooks');
const ROOT = path.resolve(__dirname, '..', '..');

// ---- the slow disk (only while `slow` is on) ----
const SYNC_MS = 0.6, ASYNC_MS = 1;
let slow = false, syncCalls = 0;
const spin = ms => { const t = process.hrtime.bigint() + BigInt(Math.round(ms * 1e6)); while (process.hrtime.bigint() < t); };
for (const k of ['statSync', 'lstatSync', 'readdirSync', 'readFileSync', 'openSync', 'readSync', 'existsSync', 'writeFileSync', 'renameSync', 'mkdirSync', 'unlinkSync', 'accessSync', 'utimesSync']) {
  const o = fs[k]; fs[k] = function (...a) { if (slow) { syncCalls++; spin(SYNC_MS); if (process.env.BS_SYNC_TRACE) console.log('sync', k, String(a[0]).slice(-60), new Error().stack.split('\n').slice(2, 4).map(s => s.trim()).join(' < ')); } return o.apply(this, a); }; } // (BS_SYNC_TRACE=1: where each sync call comes from)
for (const k of ['stat', 'lstat', 'readdir', 'readFile', 'writeFile', 'rename', 'mkdir', 'unlink', 'access', 'open', 'utimes']) {
  const o = fsp[k]; fsp[k] = async function (...a) { if (slow) await new Promise(r => setTimeout(r, ASYNC_MS)); return o.apply(this, a); }; }
// ---- electron's net.fetch, stubbed: any libretro address gives a 1000x1400 PNG ----
const png = (w, h, n = 2048) => { const b = Buffer.alloc(n, 1); b[0] = 0x89; b.write('PNG', 1, 'latin1'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };
let fetches = 0, fetchMs = 2;
const fakeNet = { fetch: async url => { fetches++; await new Promise(r => setTimeout(r, fetchMs)); if (!/thumbnails\.libretro\.com/.test(url)) return { ok: false, status: 404 };
  const b = png(1000, 1400); return { ok: true, status: 200, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length), text: async () => '' }; } };
const load0 = Module._load; Module._load = function (req, ...a) { return req === 'electron' ? { net: fakeNet } : load0.call(this, req, ...a); };

let fails = 0;
const check = (name, ok, info) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || info == null ? '' : '\n     ' + String(info).slice(0, 700))); if (!ok) fails++; };
function watchLoop() { let last = performance.now(), max = 0; const t = setInterval(() => { const n = performance.now(); max = Math.max(max, n - last - 10); last = n; }, 10);
  return () => { clearInterval(t); max = Math.max(max, performance.now() - last - 10); return Math.round(max); }; }
const wait = ms => new Promise(r => setTimeout(r, ms));
const mk = (p, body = '') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };
const pad = i => String(i).padStart(4, '0'), REG = ['USA', 'Europe', 'Japan'];

// ---- the made-up library ----
function makeScanLibrary(root) {
  const gb = path.join(root, 'gb'), art = path.join(gb, 'covers');
  for (let i = 0; i < 2000; i++) {
    const name = `Game ${pad(i)} (${REG[i % 3]})`, dir = i % 10 === 0 ? path.join(gb, 'Sub ' + (i % 7)) : gb;
    mk(path.join(dir, name + '.gb'), 'x'.repeat(16 + (i % 13)));
    if (i % 50 === 0) mk(path.join(dir, name + '.zip'), 'x'.repeat(64)); // the same game twice: the fuller one stays
    if (i % 97 === 0) mk(path.join(dir, name + ' [UPD].gb'), 'x'); // an update file: not a game
    if (i % 4 === 0) mk(path.join(art, name + '.png'), png(1000, 1400));
    if (i % 4 === 1) { mk(path.join(art, name + '.JPG'), 'jpeg'); mk(path.join(art, name + '-back.png'), png(1000, 1400)); }
    if (i % 4 === 2) for (const s of ['', '-back', '-spine', '-disc']) mk(path.join(art, name + s + '.webp'), 'webp');
    if (i % 25 === 0) { mk(path.join(art, name + '-manual-02.jpg'), 'p'); mk(path.join(art, name + '-manual-01.jpg'), 'p'); mk(path.join(art, name + '-manual-10.jpg'), 'p'); }
  }
  const gc = path.join(root, 'gc');
  for (let i = 0; i < 20; i++) { const t = `Disc Game ${pad(i)} (USA)`;
    mk(path.join(gc, t + ' (Disc 1).iso'), 'x'.repeat(100 + i)); mk(path.join(gc, t + ' (Disc 1).rvz'), 'x'.repeat(50)); if (i % 2) mk(path.join(gc, t + ' (Disc 2).rvz'), 'x'.repeat(70)); }
  const ps4 = path.join(root, 'ps4');
  for (let i = 0; i < 3; i++) { const d = path.join(ps4, 'Folder Game ' + i); mk(path.join(d, 'eboot.bin'), 'elf'); mk(path.join(d, 'sce_sys', 'param.sfo'), ''); mk(path.join(d, 'sce_sys', 'icon0.png'), png(512, 512)); }
  return { gb, gc, ps4 };
}
// art: of n games, a quarter have nothing (their fronts are "online"), an eighth a low-res front (a sharper one is online),
// the rest every part. Returns what should happen.
function makeArtLibrary(root, n) {
  const roms = path.join(root, 'gb'), art = path.join(roms, 'covers'), online = [], want = { front: 0, upgraded: 0 };
  for (let i = 0; i < n; i++) { const name = `Art Game ${pad(i)} (USA)`; mk(path.join(roms, name + '.gb'), 'rom');
    if (i % 4 === 3) { online.push(name); want.front++; continue; }
    const low = i % 8 === 1; if (low) { online.push(name); want.upgraded++; }
    mk(path.join(art, name + (i % 3 === 0 ? '.PNG' : '.png')), low ? png(300, 400) : png(1000, 1400));
    for (const s of ['-back', '-spine', '-disc']) mk(path.join(art, name + s + (i % 2 ? '.jpg' : '.png')), i % 2 ? 'jpeg' : png(1000, 1400)); }
  return { roms, art, online, want };
}
const tree = dir => { const out = []; const go = (d, rel) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const r = rel ? rel + '/' + e.name : e.name; if (e.isDirectory()) go(path.join(d, e.name), r); else out.push(r.replace(/ \(\d{4}(-\d+){6}(-\d+)?\)/, ' (stamp)')); } }; go(dir, ''); return out.sort(); };

async function scanChecks(work, mainDir, oldDir) {
  const scanner = require(path.join(mainDir, 'scanner.js')), { CONSOLES } = require(path.join(mainDir, 'systems.js'));
  const lib = makeScanLibrary(path.join(work, 'scan'));
  const oldScanner = oldDir ? require(path.join(oldDir, 'scanner.js')) : null;
  for (const id of ['gb', 'gc', 'ps4']) {
    const def = CONSOLES.find(c => c.id === id), cfg = { enabled: true, romDirs: [lib[id]] };
    scanner.forget(); slow = true; let t = performance.now(); const want = scanner.scanSystem(def, cfg); const syncMs = Math.round(performance.now() - t); slow = false;
    scanner.forget(); slow = true; syncCalls = 0; const stop = watchLoop(); t = performance.now();
    const got = await scanner.scanSystemAsync(def, cfg), held = stop(), asyncMs = Math.round(performance.now() - t), calls = syncCalls; slow = false;
    const again = await scanner.scanSystemAsync(def, cfg); scanner.forget(); const [two1, two2] = await Promise.all([scanner.scanSystemAsync(def, cfg), scanner.scanSystemAsync(def, cfg)]);
    const W = JSON.stringify(want), n = want.length;
    check(`${id}: the async scan gives exactly what the sync scan gives (${n} games; again from the kept scan, and two at once)`, n > 0 && JSON.stringify(got) === W && JSON.stringify(again) === W && JSON.stringify(two1) === W && JSON.stringify(two2) === W,
      JSON.stringify({ n, got: got.length, first: got[0], want: want[0] }));
    // (beta.10) the bar: 100 ms, or a quarter of what the old sync scan held it for in this same run (GitHub's slow runners)
    const bar = Math.max(100, Math.round(syncMs * 0.25));
    check(`${id}: the event loop is never held ${bar} ms or more during the async scan (held at most ${held} ms; the sync scan held it ${syncMs} ms; async took ${asyncMs} ms)`, held < bar, held);
    if (id !== 'ps4') check(`${id}: the async scan makes no sync fs call`, calls === 0, calls); // (PS4 folder games still read their param files sync)
    if (oldScanner) { oldScanner.forget(); const old = oldScanner.scanSystem(def, cfg); check(`${id}: the same games as the older scanner`, JSON.stringify(old) === W, JSON.stringify({ old: old.length, now: n, a: old.find((g, i) => JSON.stringify(g) !== JSON.stringify(want[i])) })); }
  }
  // a forget() while an async scan runs: its (older) result is not kept, the next sync scan reads the folders again
  const gb = CONSOLES.find(c => c.id === 'gb'), cfg = { enabled: true, romDirs: [lib.gb] };
  scanner.forget(); slow = true; const p = scanner.scanSystemAsync(gb, cfg); scanner.forget(); await p; syncCalls = 0; scanner.scanSystem(gb, cfg); const walked = syncCalls; slow = false;
  check('a forget() during an async scan keeps its result out of the kept scans', walked > 100, walked);
  // (beta.10) the shelf's order comes from one Intl.Collator now: still localeCompare's order with the same options (accents,
  // case, numbers), in the sync and the async scan alike
  { const dir = path.join(work, 'order'), names = ['éclair 10', 'Eclair 2', 'eclair', 'Zelda', 'zelda 2', 'Ábc', 'abc 3', 'Mario 10', 'Mario 9', 'mario', 'Ölfass', 'Olfass 1', 'Game 100', 'Game 20'];
    names.forEach(n => mk(path.join(dir, n + ' (USA).gb'), 'x')); const c2 = { enabled: true, romDirs: [dir] };
    scanner.forget(); const s = scanner.scanSystem(gb, c2).map(g => g.title); scanner.forget(); const a = (await scanner.scanSystemAsync(gb, c2)).map(g => g.title);
    const lc = s.slice().sort((x, y) => x.localeCompare(y, undefined, { sensitivity: 'base', numeric: true }));
    check('the titles are sorted as localeCompare sorts them (sensitivity base, numeric), sync and async alike', s.length === names.length && JSON.stringify(s) === JSON.stringify(lc) && s.every((t, i) => !i || s[i - 1].localeCompare(t, undefined, { sensitivity: 'base', numeric: true }) <= 0) && JSON.stringify(a) === JSON.stringify(s), JSON.stringify(s)); }
  // (beta.10) an Xbox 360 Games on Demand package: its header is read once per scan (x360.lookup takes the scanner's reading),
  // and the async scan gives the same game
  { const root = path.join(work, 'x360'), pkg = path.join(root, '4D5307E6', '00007000', 'ABCDEF0123456789ABCDEF0123456789ABCDEF01');
    const h = Buffer.alloc(0x1712); h.write('CON ', 0, 'latin1'); h.writeUInt32BE(0x00007000, 0x344); h.writeUInt32BE(0x4D5307E6, 0x360); const t = Buffer.from('Test Arcade Game', 'utf16le'); t.swap16(); t.copy(h, 0x411); mk(pkg, h);
    const def = CONSOLES.find(c => c.id === 'x360'), c3 = { enabled: true, romDirs: [root] }; let opens = 0, want = [];
    const o = fs.openSync; fs.openSync = function (p, ...r) { if (String(p) === pkg) opens++; return o.call(this, p, ...r); };
    try { scanner.forget(); want = scanner.scanSystem(def, c3); } finally { fs.openSync = o; }
    scanner.forget(); const got = await scanner.scanSystemAsync(def, c3);
    check('x360: a Games on Demand package is read once per scan (not again for its title id); the async scan gives the same game', opens === 1 && want.length === 1 && want[0].title === 'Test Arcade Game' && want[0].titleId === '4D5307E6' && JSON.stringify(got) === JSON.stringify(want), JSON.stringify({ opens, want }).slice(0, 400)); }
}

async function artRun(work, mainDir, n, opts = {}) {
  const covers = require(path.join(mainDir, 'covers.js')), { CONSOLES } = require(path.join(mainDir, 'systems.js')), scanner = require(path.join(mainDir, 'scanner.js'));
  const root = path.join(work, opts.name || 'art'), lib = makeArtLibrary(root, n), data = path.join(root, 'data');
  covers.init(data, () => {}); covers._setIndex({ games: {}, images: {}, at: 1 });
  fs.writeFileSync(path.join(data, 'boxart-cache', 'libretro-gb.json'), JSON.stringify({ at: Date.now(), names: lib.online }));
  scanner.forget(); const def = CONSOLES.find(c => c.id === 'gb'), list = [{ def, cfg: { enabled: true, romDirs: [lib.roms] } }];
  return { covers, lib, scanner, def, cfg: list[0].cfg, run: (progress) => covers.downloadCovers(list, progress || (() => {}), ['front', 'back', 'spine', 'disc'], { hd: true, tag: 'auto' }) };
}
async function artChecks(work, mainDir, oldDir) {
  const N = 800, A = await artRun(work, mainDir, N);
  // (beta.10) the bar for the event loop: 100 ms, or a quarter of what a sync scan of the same library holds it for in this run
  A.scanner.forget(); slow = true; const ts = performance.now(); A.scanner.scanSystem(A.def, A.cfg); const syncMs = Math.round(performance.now() - ts); slow = false; A.scanner.forget();
  const bar = Math.max(100, Math.round(syncMs * 0.25));
  fetches = 0; slow = true; syncCalls = 0; const stop = watchLoop(), t = performance.now();
  const rep = await A.run(), held = stop(), ms = Math.round(performance.now() - t), calls = syncCalls; slow = false;
  const r = rep.systems[0] || {}, files = tree(A.lib.art);
  const had = N - A.lib.want.front - A.lib.want.upgraded;
  check(`art: the download gets every missing front and every sharper one, the rest left alone (${N} games, ${ms} ms)`, r.total === N && r.front === A.lib.want.front && r.upgraded === A.lib.want.upgraded && r.had === had && r.back + r.spine + r.disc === 0 && !rep.cancelled,
    JSON.stringify({ total: r.total, front: r.front, up: r.upgraded, had: r.had, want: A.lib.want, fetches }));
  check('art: the new fronts are where the scanner finds them (<name>.png), the low-res ones moved to replaced\\', A.lib.online.every(nm => files.includes(nm + '.png') || files.includes(nm + '.PNG')) && files.filter(f => f.startsWith('replaced/')).length === A.lib.want.upgraded && !files.some(f => /\.(part|incoming)/.test(f)),
    files.filter(f => f.startsWith('replaced/')).length);
  check(`art: the event loop is never held ${bar} ms or more (held at most ${held} ms, ${calls} sync fs calls; a sync scan of it held it ${syncMs} ms)`, held < bar, held);
  if (oldDir) {
    const O = await artRun(work, oldDir, N, { name: 'art-old' }); slow = true; const orep = await O.run(); slow = false; const o = orep.systems[0] || {}, ofiles = tree(O.lib.art);
    const pick = x => JSON.stringify({ total: x.total, front: x.front, back: x.back, spine: x.spine, disc: x.disc, up: x.upgraded, had: x.had, missed: x.missed.slice().sort(), kinds: x.missedKinds, got: x.got.map(g => g.join(':')).sort(), upl: x.up.map(g => g.join(':')).sort() });
    check('art: the same report and the same files as the older code', pick(o) === pick(r) && JSON.stringify(ofiles) === JSON.stringify(files), pick(o).slice(0, 300) + ' / ' + pick(r).slice(0, 300) + ' files ' + ofiles.length + '/' + files.length);
  }
  // Pause / Resume / Cancel (every game's front is "online", each fetch 15 ms)
  const P = await artRun(work, mainDir, 160, { name: 'art-pause' }); fetchMs = 15;
  check('art: Pause with nothing running says so', P.covers.pause('auto', true) === false);
  let done = 0; const run = P.run(i => { if (i && i.total) done = i.done; });
  while (done < 8) await wait(5);
  const paused = P.covers.pause('auto', true), ip1 = P.covers.isPaused('auto'), ipOther = P.covers.isPaused('other'); await wait(250); const d1 = done; await wait(600); const d2 = done;
  P.covers.pause('auto', false); const ip2 = P.covers.isPaused('auto'); const t0 = Date.now(); while (done <= d2 && Date.now() - t0 < 3000) await wait(5); const d3 = done;
  check('art: isPaused says when the background run is paused (main\'s waiters resume it or stop waiting)', ip1 === true && ipOther === false && ip2 === false, JSON.stringify({ ip1, ipOther, ip2 }));
  P.covers.pause('auto', true); await wait(200); P.covers.cancel('other'); await wait(300); const d4 = done; P.covers.cancel('auto'); const t1 = Date.now(); const prep = await run; const endMs = Date.now() - t1;
  fetchMs = 2;
  check('art: Pause holds the run (only the games in flight finish), Resume carries on, a Cancel for another run leaves it, Cancel ends it while paused',
    paused && d2 === d1 && d3 > d2 && done === d4 && prep.cancelled && endMs < 1500 && (prep.systems[0] || {}).front < 160, JSON.stringify({ paused, d1, d2, d3, d4, done, cancelled: prep.cancelled, endMs }));
  // (beta.10) a picture dropped in while the run is paused is seen after Resume (the folder is listed again): never taken for
  // missing, downloaded over and moved to replaced\
  { const R = await artRun(work, mainDir, 40, { name: 'art-relist' }); fetchMs = 15; let dn = 0; const rr = R.run(i => { if (i && i.total) dn = i.done; });
    while (dn < 1) await wait(5); R.covers.pause('auto', true); await wait(150);
    const mine = path.join(R.lib.art, 'Art Game 0039 (USA).png'); fs.writeFileSync(mine, png(1000, 1400, 3000)); // (game 39 has no front: it's "online")
    R.covers.pause('auto', false); const rep2 = await rr; fetchMs = 2; const files2 = tree(R.lib.art);
    check('art: a picture dropped in during a Pause is kept after Resume (not downloaded over, not moved to replaced\\)', fs.statSync(mine).size === 3000 && !files2.some(f => /^replaced\/Art Game 0039/.test(f)) && !rep2.cancelled,
      JSON.stringify({ size: fs.statSync(mine).size, replaced: files2.filter(f => f.startsWith('replaced/')) })); }
}

async function main() {
  const oi = process.argv.indexOf('--old'), oldDir = oi > 0 ? path.resolve(process.argv[oi + 1], 'main') : null;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-scan-'));
  try { await scanChecks(work, path.join(ROOT, 'main'), oldDir); await artChecks(work, path.join(ROOT, 'main'), oldDir); }
  catch (e) { check('ran to the end', false, e && e.stack); }
  finally { slow = false; try { fs.rmSync(work, { recursive: true, force: true }); } catch {} }
  console.log(fails ? `${fails} FAILED` : 'ALL PASSED'); process.exit(fails ? 1 : 0);
}
main();
