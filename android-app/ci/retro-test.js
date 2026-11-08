// Device test pass "retro" (beta.6), run by web-device-test.js. Checks results, never speed.
//   Node: the 12 retro shelves are in main/systems.js with a RetroArch core each, RetroArch's usual folders searched, the
//   standalone first where it's the better emulator (DuckStation, melonDS); every table main keys by console has them (box
//   art: libretro + LaunchBox; manuals: GamesDatabase + search words; ScreenScraper with carts marked).
//   The demo page as Windows with ?retro=1 (PlayStation, SNES, GBA, Mega Drive, Dreamcast): each shelf comes up with its
//   own case (the systems-extra look) and a visible title; their Settings pages link RetroArch / DuckStation.
//   Screenshots: retro-<id>.png.
'use strict';
const path = require('path');

module.exports = async function retroPass({ browser, base, check, newPage, OUT }) {
  const root = path.resolve(__dirname, '..', '..');
  try {
    const { CONSOLES } = require(path.join(root, 'main', 'systems.js')); // (plain data: CI has no Electron, so only files that don't need it)
    const ids = ['psx', 'nes', 'snes', 'n64', 'gb', 'gbc', 'gba', 'nds', 'megadrive', 'mastersystem', 'gamegear', 'dreamcast'];
    const R = ids.map(id => CONSOLES.find(c => c.id === id));
    // (the tables are the platform's own: retroarch.exe on Windows; on Linux, where this CI runs, retroarch / its Flatpak /
    // AppImage, see systems.js forLinux)
    const isRA = n => /^(retroarch(\.exe)?|org\.libretro\.retroarch|re:\^retroarch.*)$/i.test(n);
    const bad = R.map((c, i) => !c ? ids[i] + ': missing' : !c.raCore ? c.id + ': no core' : !c.exeNames.some(isRA) ? c.id + ': no RetroArch' : !c.emulatorFolders.some(f => /RetroArch/i.test(f)) ? c.id + ': no RetroArch folders' : !c.extensions.length ? c.id + ': no extensions' : '').filter(Boolean);
    const psx = R[0], nds = R[7], snes = R[2];
    check('Retro: the 12 retro shelves each have a RetroArch core and RetroArch\'s folders; DuckStation and melonDS are looked for first',
      !bad.length && /duckstation/i.test(psx.exeNames[0]) && /melonds/i.test(nds.exeNames[0]) && isRA(snes.exeNames[0]), bad.join(', ') || JSON.stringify([psx.exeNames[0], nds.exeNames[0], snes.exeNames[0]]));
    const read = f => require('fs').readFileSync(path.join(root, 'main', f + '.js'), 'utf8');
    const has = (txt, id) => new RegExp('\\b' + id + ':\\s').test(txt);
    const miss = [];
    for (const id of ids) {
      if (!has(read('covers'), id)) miss.push('covers:' + id);
      if (!has(read('manuals'), id)) miss.push('manuals:' + id);
      if (!has(read('screenscraper'), id)) miss.push('screenscraper:' + id);
    }
    check('Retro: box art (libretro, LaunchBox), manuals (GamesDatabase, search words) and ScreenScraper know every retro shelf', !miss.length, miss.join(', '));
  } catch (e) { check('Retro: module checks ran', false, e && e.stack ? e.stack.split('\n').slice(0, 2).join(' ') : e); }

  const { ctx, page, errors } = await newPage(browser, null);
  try {
    await page.goto(base + '?platform=windows&shelf=1&retro=1');
    await page.waitForFunction(() => window.Shelf && Shelf._qs && Shelf._qs().g && window.Setup, null, { timeout: 90000, polling: 250 });
    await page.waitForTimeout(1500);
    const want = ['psx', 'snes', 'gba', 'megadrive', 'dreamcast'], seen = {};
    const look = () => page.evaluate(() => { const w = document.getElementById('sysWord'), m = w && w.querySelector('.wm-main'), cs = m ? getComputedStyle(m) : null;
      const id = (w && [...w.classList].find(c => /^wm-/.test(c) && c !== 'wm-main')) || '';
      return { id: id.replace(/^wm-/, ''), word: m ? m.textContent : '', grad: cs ? cs.backgroundImage : '', game: Shelf._qs().g, slots: document.querySelectorAll('#track > *').length }; });
    // one shelf per press, waiting for each switch to land (a slow runner otherwise takes two presses as one long slide)
    const first = (await look()).id;
    for (let i = 0; i < 40 && Object.keys(seen).length < want.length; i++) {
      let s = await look();
      if (want.includes(s.id) && !seen[s.id]) { await page.waitForTimeout(500); s = await look(); seen[s.id] = s; await page.screenshot({ path: path.join(OUT, `retro-${s.id}.png`) }).catch(() => {}); }
      await page.keyboard.press('ArrowDown');
      for (let t = 0; t < 30; t++) { await page.waitForTimeout(150); const n = await look(); if (n.id !== s.id && !(await page.evaluate(() => window.BS_BUSY && BS_BUSY()))) break; }
      if (i > 0 && (await look()).id === first) break; // all the way round
    }
    const okShelf = id => seen[id] && seen[id].word && /gradient/.test(seen[id].grad) && seen[id].slots > 0 && !!seen[id].game;
    check('Retro (Windows): PlayStation, SNES, GBA, Mega Drive and Dreamcast each come up as a shelf with games and a visible title',
      want.every(okShelf), JSON.stringify(Object.fromEntries(want.map(id => [id, seen[id] ? { w: seen[id].word, g: /gradient/.test(seen[id].grad), n: seen[id].slots } : null]))));
    // Settings → the PlayStation's page: DuckStation's link; the SNES page: RetroArch's
    const st = await page.evaluate(async () => { const w = ms => new Promise(r => setTimeout(r, ms)), out = {};
      for (const id of ['psx', 'snes']) { if (window.Settings && Settings.isOpen && Settings.isOpen()) { await Settings.close(); await w(800); }
        Setup.open({ page: id }); for (let i = 0; i < 40 && !document.querySelector('#bss.on .bss-row'); i++) await w(150); await w(600);
        const adv = [...document.querySelectorAll('#bss .bss-row')].find(r => /Emulator & advanced/.test((r.querySelector('.nm') || {}).textContent || ''));
        if (adv) { adv.click(); await w(900); }
        out[id] = [...document.querySelectorAll('#bss .bss-row .nm')].map(e => e.textContent); }
      if (window.Settings && Settings.isOpen && Settings.isOpen()) { await Settings.close(); await w(800); } return out; });
    check('Retro (Windows): a retro console\'s Settings page offers its emulator (Get DuckStation / Get RetroArch)',
      (st.psx || []).includes('Get DuckStation') && (st.snes || []).includes('Get RetroArch'), JSON.stringify(st).slice(0, 400));
    check('Retro pass (Windows page): no script errors', !errors.length, errors.slice(0, 3).join(' | '));
  } catch (e) { check('Retro pass (Windows page) ran to the end', false, e && e.stack ? e.stack.split('\n').slice(0, 2).join(' ') : e); }
  await ctx.close();
};
