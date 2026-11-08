// Device test pass "issues" (beta.10), run by web-device-test.js: fixes for what beta testers reported.
//   - An 8BitDo pad gets Xbox-style prompts (and A / B the Xbox way round), not Nintendo's, unless it says it's a Switch pad;
//     the controller list in main (padsense) agrees.
//   - Android: ARMSX2 (PS2) starts with the game (VIEW with the game's document); an emulator app Boxshelf has no launch data
//     for is handed the game the same way instead of a dead end; the picker marks such apps.
//   - A game added by hand can sit on the PC shelf: kept through the settings check, passed on by the PC library.
//   - Settings → Switch names the emulator actually picked (Citron, Ryujinx), not always Eden.
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

module.exports = async function issuesPass({ browser, base, check, OUT }) {
  const ROOT = path.join(__dirname, '..', '..');
  // ---- plain Node test scripts: missing games (scan-missing-test.js), scans and art downloads that never hold the main process up (scan-async-test.js) ----
  for (const [file, name] of [['scan-missing-test.js', 'Games that went missing are found: Xbox 360 Games on Demand / Arcade, PS3 regions and genre folders, linked folders, "Pass" / "Booster" titles off the Switch (ci/scan-missing-test.js)'],
    ['scan-async-test.js', 'A big library on a slow drive: the scan and the art download never hold the main process up, with the same results; Pause / Resume / Cancel (ci/scan-async-test.js)'],
    ['steam-test.js', 'Steam games show however the Steam folder was given (its steamapps folder, a trailing slash), with an update waiting, from every library, with a byte-order mark (ci/steam-test.js)']]) {
    let out = '', ok = true; try { out = require('child_process').execFileSync(process.execPath, [path.join(__dirname, file)], { encoding: 'utf8', timeout: 240000 }); } catch (e) { ok = false; out = String(e.stdout || e.message); }
    const bad = out.split('\n').filter(l => /^(❌|FAIL)/.test(l));
    check(name, ok && !bad.length, bad.join(' | ') || (out.trim().split('\n').pop() || ''));
  }
  // ---- plain Node: main's own modules ----
  {
    const padsense = require(path.join(ROOT, 'main', 'padsense.js'));
    const list = padsense.parse(['HID\\VID_2DC8&PID_3106&IG_00\\8&1|HIDClass|HID-compliant game controller', 'USB\\VID_054C&PID_0CE6\\5&2|HIDClass|DualSense Wireless Controller'].join('\n'));
    const bit = list.find(x => x.vendor === '2dc8'), ds = list.find(x => x.vendor === '054c');
    check('8BitDo pads plugged in count as Xbox-style in main\'s controller list (were Nintendo); a DualSense stays PlayStation', !!bit && bit.style === 'xbox' && !!ds && ds.style === 'ps', JSON.stringify(list));

    const config = require(path.join(ROOT, 'main', 'config.js')), pcgames = require(path.join(ROOT, 'main', 'pcgames.js'));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bx-issues-')), exe = path.join(tmp, 'Game.exe'); fs.writeFileSync(exe, 'MZ');
    const cfg = config.defaults(); cfg.pc.custom = [{ id: 'a', title: 'On PC', exe, args: '', shelf: 'pc' }, { id: 'b', title: 'On Custom', exe, args: '' }, { id: 'c', title: 'Odd', exe, args: '', shelf: 'nope' }];
    config.sanitize(cfg);
    const games = pcgames.customGames(cfg.pc.custom);
    check('A game added by hand can be put on the PC shelf: its choice survives the settings check, other values are dropped',
      cfg.pc.custom[0].shelf === 'pc' && !('shelf' in cfg.pc.custom[1]) && !('shelf' in cfg.pc.custom[2]) && games[0].shelf === 'pc' && !games[1].shelf && !games[2].shelf,
      JSON.stringify(games.map(g => [g.title, g.shelf || ''])));
    // (beta.10) main.js buildLibrary's own split line, run on those games (buildLibrary itself needs Electron): the PC shelf
    // gets the one marked 'pc', Custom the rest; the Custom shelf is still made from what's left
    const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8'), line = (/^[ \t]*const toPc = [^\r\n]*$/m.exec(main) || [''])[0];
    let split = null; try { split = line ? new Function('mine', line + '\nreturn { toPc, onCustom };')(games) : null; } catch (e) { split = { error: e.message }; }
    check('The PC library sorts those games onto the PC shelf and leaves the rest on Custom',
      !!split && Array.isArray(split.toPc) && split.toPc.map(g => g.title).join() === 'On PC' && split.onCustom.map(g => g.title).join() === 'On Custom,Odd' && /onCustom\.length\) shelves\.push\(\{ id: 'custom'/.test(main),
      JSON.stringify(split && (split.error || { pc: (split.toPc || []).map(g => g.title), custom: (split.onCustom || []).map(g => g.title) })) + (line ? '' : ' (the toPc line was not found in main.js)'));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  // ---- the Windows page: the pad's prompts, Settings → Switch ----
  {
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 }); ctx.setDefaultTimeout(90000);
    const page = await ctx.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    try {
      await page.goto(base + '?platform=windows&shelf=1');
      await page.waitForFunction(() => window.Shelf && Shelf._qs && Shelf._qs().g && window.BS_padInfo, null, { timeout: 90000, polling: 250 });
      const p = await page.evaluate(() => ({
        bit: BS_padInfo('8BitDo Ultimate C 2.4G (STANDARD GAMEPAD Vendor: 2dc8 Product: 3106)'),
        bitSw: BS_padInfo('8BitDo Pro 2 Switch mode (STANDARD GAMEPAD Vendor: 057e Product: 2009)'),
        ds: BS_padInfo('DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)') }));
      check('An 8BitDo pad gets Xbox-style prompts on the shelf, named 8BitDo; one in Switch mode still gets Nintendo\'s; a DualSense PlayStation\'s',
        p.bit.style === 'xbox' && p.bit.name === '8BitDo controller' && p.bitSw.style === 'nintendo' && p.ds.style === 'ps', JSON.stringify(p));
      await page.evaluate(async () => { const c = (await window.boxshelf.getConfig()).config; c.systems.sw = Object.assign({}, c.systems.sw, { emulator: 'C:\\Emus\\Citron\\citron.exe' }); await window.boxshelf.saveConfig(c); Setup.open({ console: 'sw' }); });
      await page.waitForTimeout(1500);
      // the Consoles grid: the Switch tile names the emulator picked; pressing it opens the Switch page
      const tile = await page.evaluate(() => { const t = [...document.querySelectorAll('.bss-ctile')].find(x => (x.querySelector('b') || {}).textContent === 'Switch'); return t ? (t.querySelector('span') || {}).textContent : null; });
      await page.locator('.bss-ctile', { has: page.locator('b', { hasText: /^Switch$/ }) }).first().click(); await page.waitForTimeout(1200);
      // (to the Emulator row: its explanation shows; a slow runner can miss a press, so press until it does, at most four times)
      for (let i = 0; i < 4 && !await page.evaluate(() => /Eden, Citron or Ryujinx/.test(document.body.innerText)); i++) { await page.keyboard.press('ArrowDown'); await page.waitForTimeout(900); }
      await page.screenshot({ path: path.join(OUT, 'issues-switch.png') });
      // (beta.10) the Emulator row's own value (its .vt spans), not the page text: the help line names Citron too
      const sw = await page.evaluate(() => { const t = document.body.innerText, row = [...document.querySelectorAll('.bss-row')].find(r => ((r.querySelector('.lbl .nm') || {}).textContent || '').trim() === 'Emulator');
        return { row: !!row, value: row ? [...row.querySelectorAll('.bss-val .vt')].map(v => v.textContent.trim()).filter(Boolean).join(' ') : '', help: /Eden, Citron or Ryujinx/.test(t) }; }).catch(e => ({ error: e.message }));
      await page.keyboard.press('Escape'); await page.waitForTimeout(600);
      check('Settings → Switch names the emulator picked (Citron, not Eden) and says Eden, Citron or Ryujinx all work', sw.row && /\bCitron\b/.test(sw.value) && !/Eden/.test(sw.value) && sw.help && tile === 'Citron', JSON.stringify({ ...sw, tile }));
      check('No script errors on the Windows page (issues pass)', !errors.length, errors.slice(0, 3).join(' | '));
    } catch (e) { check('Issues pass (Windows page) ran to the end', false, e && e.message); }
    await ctx.close();
  }

  // ---- the pretend Thor: ARMSX2 and an emulator app with no launch data ----
  {
    const ctx = await browser.newContext({ viewport: { width: 853, height: 480 }, deviceScaleFactor: 2.25, hasTouch: true }); ctx.setDefaultTimeout(90000);
    const page = await ctx.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    try {
      await page.goto(base + '?platform=android&fakeNative=1&shelf=1');
      await page.waitForFunction(() => window.boxshelf && window.__fakeLaunches, null, { timeout: 90000, polling: 250 });
      const r = await page.evaluate(async () => {
        const api = window.boxshelf, c = (await api.getConfig()).config, out = {};
        const dir = await api.pick({ kind: 'folder' }); // the pretend device's first folder (GameCube games)
        c.systems.gc = Object.assign({}, c.systems.gc, { enabled: true, romDirs: [dir] }); c.setupDone = true;
        const lib = async () => ((await api.scan()).find(s => s.id === 'gc') || { games: [] }).games[0];
        for (const [k, emu] of [['armsx2', 'ARMSX2 (come.nanodata.armsx2)'], ['unknown', 'Some Emulator (com.example.someemu)']]) {
          c.systems.gc.emulator = emu; await api.saveConfig(c); const g = await lib();
          try { await api.launchGame('gc', g.file); out[k] = window.__fakeLaunches[window.__fakeLaunches.length - 1]; } catch (e) { out[k] = 'ERROR ' + e.message; }
          await new Promise(res => setTimeout(res, 1800)); // (the pretend emulator "closes")
        }
        return out;
      });
      const a = r.armsx2, u = r.unknown;
      check('ARMSX2 (PS2 on Android) starts with the game: VIEW with the game\'s document, read access granted',
        a && typeof a === 'object' && a.pkg === 'come.nanodata.armsx2' && a.action === 'android.intent.action.VIEW' && /\/document\//.test(String(a.data || '')) && (a.grant || []).includes(a.data), JSON.stringify(a).slice(0, 300));
      check('An emulator app Boxshelf has no launch data for is handed the game (VIEW) instead of "doesn\'t know how to start"',
        u && typeof u === 'object' && u.pkg === 'com.example.someemu' && u.action === 'android.intent.action.VIEW' && !!u.data, JSON.stringify(u).slice(0, 300));
      check('No script errors on the pretend Thor (issues pass)', !errors.length, errors.slice(0, 3).join(' | '));
    } catch (e) { check('Issues pass (pretend Thor) ran to the end', false, e && e.message); }
    await ctx.close();
  }
};
