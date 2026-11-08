// Linux build, test 2: the real AppImage on a virtual screen (xvfb-run), in a made-up home folder.
//   node linux/ci/app-test.js <Boxshelf-…-linux.AppImage>
// A SNES game in ~/Emulation/roms/snes and a pretend RetroArch (~/.local/bin/retroarch: writes down the options it was
// given, runs 7 s, closes) with its SNES core. Checks: Boxshelf starts and reports Linux, the shelf shows the game, Play
// starts RetroArch with -f -L <snes9x core> <game>, Boxshelf steps aside during the game and is back on the shelf after,
// detection inside the app finds RetroArch and the ROM folder, no script errors. Screenshots and the app's log go to
// linux-test-out/. Exit code 1 = a check failed.
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), { spawn } = require('child_process');
const img = path.resolve(process.argv[2] || '');
const OUT = path.resolve('linux-test-out'); fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const check = (name, ok, detail) => { console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail == null ? '' : '  -> ' + String(detail).slice(0, 400))); if (!ok) fails++; };

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bxapp-'));
const mk = (p, body, exec) => { const f = path.join(HOME, p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body || ''); if (exec) fs.chmodSync(f, 0o755); return f; };
const argsFile = path.join(HOME, 'ra-args.txt');
const ra = mk('.local/bin/retroarch', `#!/bin/sh\nfor a in "$@"; do echo "$a"; done > "${argsFile}"\nsleep 7\nexit 0\n`, true);
const core = mk('.config/retroarch/cores/snes9x_libretro.so', 'x');
const rom = mk('Emulation/roms/snes/Test Game (USA).sfc', 'x');
mk('Boxshelf/data/config.json', JSON.stringify({ setupDone: true,
  // lastSeenVersion: this version's What's new already seen (beta.7: its card would take the keys this test presses)
  ui: { bootIntro: 'off', sound: false, music: 'off', startFullscreen: true, openInto: 'last', autoCovers: false, lastSeenVersion: require('../../package.json').version },
  steam: { enabled: false }, pc: { epic: false, quiver: false, custom: [] },
  systems: { snes: { enabled: true, emulator: ra, romDirs: [path.dirname(rom)] } } }, null, 2));

async function cdp(url) {
  const ws = new WebSocket(url); let id = 0; const wait = new Map(), events = [];
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); } else if (d.method) events.push(d); };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300)); return r.result && r.result.result && r.result.result.value; };
  return { send, ev, events, close: () => ws.close() };
}
async function pageTarget(port = 9333) {
  for (let i = 0; i < 120; i++) { try { const l = await (await fetch('http://127.0.0.1:' + port + '/json')).json(); const t = l.find(x => x.type === 'page' && /index\.html/.test(x.url)); if (t) return t.webSocketDebuggerUrl; } catch {} await sleep(500); }
  throw new Error('the Boxshelf page never came up');
}
const shot = async (p, name) => { try { const r = await p.send('Page.captureScreenshot', { format: 'png' }); if (r.result && r.result.data) fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.result.data, 'base64')); } catch {} };

(async () => {
  check('the AppImage exists', fs.existsSync(img), img);
  const app = spawn(img, ['--no-sandbox', '--remote-debugging-port=9333'], { env: { ...process.env, HOME, APPIMAGE_EXTRACT_AND_RUN: '1' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let appOut = ''; app.stdout.on('data', d => appOut += d); app.stderr.on('data', d => appOut += d);
  let p;
  try {
    p = await cdp(await pageTarget()); await p.send('Runtime.enable'); await p.send('Page.enable');
    let ready = false; for (let i = 0; i < 90 && !ready; i++) { ready = await p.ev('!!(window.Shelf && Shelf._qs && Shelf._qs().g)').catch(() => false); if (!ready) await sleep(500); }
    await sleep(2000); await shot(p, '1-shelf');
    check('Boxshelf reports Linux to the page', (await p.ev('window.bsPlatform && bsPlatform.os')) === 'linux', await p.ev('window.bsPlatform && bsPlatform.os'));
    // (the shelf opens on its "Open RetroArch" tile: step right to the game)
    const key = async (k, vk) => { for (const type of ['keyDown', 'keyUp']) await p.send('Input.dispatchKeyEvent', { type, key: k, code: k, windowsVirtualKeyCode: vk }); };
    let g = await p.ev('Shelf._qs().g');
    for (let i = 0; i < 4 && !/Test Game/.test(String(g)); i++) { await key('ArrowRight', 39); await sleep(1200); g = await p.ev('Shelf._qs().g'); }
    check('the shelf shows the SNES game from ~/Emulation/roms/snes', ready && /Test Game/.test(String(g)), g);
    const det = await p.ev('window.boxshelf.detect()').catch(e => ({ error: e.message }));
    const snes = det && det.systems && det.systems.snes || {};
    check('detection in the app finds RetroArch and the ROM folder', snes.emulator === ra && (snes.romDirs || []).includes(path.dirname(rom)), JSON.stringify(snes));
    // (beta.8) Add Boxshelf to Steam: Steam's list of non-Steam games gets an entry that starts this AppImage
    const sdir = path.join(HOME, '.local/share/Steam/userdata/4242/config'); fs.mkdirSync(sdir, { recursive: true });
    const add = await p.ev('window.boxshelf.addToSteam(false)').catch(e => ({ error: e.message }));
    const vdf = (() => { try { return fs.readFileSync(path.join(sdir, 'shortcuts.vdf')).toString('latin1'); } catch { return ''; } })();
    check('Add Boxshelf to Steam writes Steam\'s shortcut to this AppImage', !!add && add.ok && vdf.includes('Boxshelf') && vdf.includes('.AppImage'), JSON.stringify(add));
    check('the data folder is ~/Boxshelf (the AppImage itself is read-only)', fs.existsSync(path.join(HOME, 'Boxshelf', 'data', 'boxshelf.log')), fs.readdirSync(path.join(HOME, 'Boxshelf')).join(','));
    // Play
    await key('Enter', 13);
    let args = null; for (let i = 0; i < 60 && !args; i++) { await sleep(500); try { args = fs.readFileSync(argsFile, 'utf8').split('\n').filter(Boolean); } catch {} }
    check('Play starts RetroArch fullscreen with the SNES core and the game', !!args && args[0] === '-f' && args[1] === '-L' && args[2] === core && args[3] === rom, JSON.stringify(args));
    let hidden = false; for (let i = 0; i < 16 && !hidden; i++) { await sleep(500); hidden = (await p.ev('document.visibilityState').catch(() => '')) === 'hidden' || (await p.ev('document.body.classList.contains("aside")').catch(() => false)); }
    check('Boxshelf steps aside while the game runs', hidden, 'never hidden');
    let back = false; for (let i = 0; i < 40 && !back; i++) { await sleep(500); back = await p.ev('document.visibilityState === "visible" && !document.body.classList.contains("aside") && Shelf.getMode() === "browse"').catch(() => false); }
    await sleep(1500); await shot(p, '2-back-on-the-shelf');
    check('back on the shelf after the game closes', back, await p.ev('[document.visibilityState, document.body.className, Shelf.getMode()].join(" | ")').catch(e => e.message));
    const errs = p.events.filter(e => e.method === 'Runtime.exceptionThrown').map(e => (e.params.exceptionDetails.exception || {}).description || e.params.exceptionDetails.text);
    check('no script errors', !errs.length, errs.slice(0, 3).join(' | '));
  } catch (e) { check('the test ran to the end', false, e && e.stack || e); }
  finally {
    try { fs.copyFileSync(path.join(HOME, 'Boxshelf', 'data', 'boxshelf.log'), path.join(OUT, 'boxshelf.log')); } catch {}
    fs.writeFileSync(path.join(OUT, 'app-output.txt'), appOut);
    try { if (p) p.close(); } catch {}
    try { process.kill(-app.pid, 'SIGTERM'); } catch {} await sleep(1500); try { process.kill(-app.pid, 'SIGKILL'); } catch {}
  }
  // (beta.8) started the way Steam's Game Mode starts it (no options of our own): the AppImage's wrapper adds --no-sandbox
  // and X11, the app comes up, knows it's in Game Mode on a Deck, and shows no Desktop Mode card
  { const app2 = spawn(img, ['--remote-debugging-port=9334'], { env: { ...process.env, HOME, APPIMAGE_EXTRACT_AND_RUN: '1', SteamClientLaunch: '1', SteamGameId: '123', SteamGamepadUI: '1', XDG_CURRENT_DESKTOP: 'gamescope', BS_FAKE_DECK: '1' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let out2 = ''; app2.stdout.on('data', d => out2 += d); app2.stderr.on('data', d => out2 += d); let p2;
    try { p2 = await cdp(await pageTarget(9334)); let ok = false; for (let i = 0; i < 90 && !ok; i++) { ok = await p2.ev('!!(window.Shelf && Shelf._qs && Shelf._qs().g)').catch(() => false); if (!ok) await sleep(500); }
      await sleep(13000); const mode = await p2.ev('Shelf.getMode()').catch(() => '?'); await shot(p2, '3-game-mode');
      const logT = (() => { try { return fs.readFileSync(path.join(HOME, 'Boxshelf', 'data', 'boxshelf.log'), 'utf8'); } catch { return ''; } })(), line = (logT.match(/Linux start:[^\n]*/g) || []).pop() || '';
      check('started like Steam\'s Game Mode: the wrapper adds --no-sandbox and X11, the app comes up as a Deck in Game Mode, no Desktop Mode card', ok && /Steam Deck/.test(line) && /started by Steam: true/.test(line) && /Game Mode: true/.test(line) && /--no-sandbox/.test(line) && /--ozone-platform=x11/.test(line) && mode === 'browse', line + ' | mode ' + mode);
    } catch (e) { check('the Game Mode start ran to the end', false, (e && e.message) + ' | ' + out2.slice(-400)); }
    finally { fs.writeFileSync(path.join(OUT, 'app-output-game-mode.txt'), out2); try { if (p2) p2.close(); } catch {} try { process.kill(-app2.pid, 'SIGTERM'); } catch {} await sleep(1500); try { process.kill(-app2.pid, 'SIGKILL'); } catch {} } }
  console.log(fails ? `${fails} failed` : 'all passed');
  process.exit(fails ? 1 : 0);
})();
