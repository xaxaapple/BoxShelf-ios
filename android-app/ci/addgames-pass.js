// Device test pass "addgames" (beta.7), run by web-device-test.js: the demo page as Windows on a 1920x1080 TV.
//   ci/addgames-test.js (plain Node: folder scan, names, the Playnite mapping) run here too; then Settings → Custom games →
//   Add games: several programs at once and a scanned folder are listed with a tick each before anything is added (an
//   unticked one stays off); Import from Playnite (experimental) shows its summary, imports the ticked games and folders
//   (a favourite stays one) and Remove what was imported takes them away; the Custom shelf ends in an Add games tile
//   that opens this page; the first run offers the Playnite import when Playnite is there. Screenshots: addgames-*.png.
'use strict';
const path = require('path');
const { execFileSync } = require('child_process');

module.exports = async function addGamesPass({ browser, base, check, OUT }) {
  { let out = '', ok = true; try { out = execFileSync(process.execPath, [path.join(__dirname, 'addgames-test.js')], { encoding: 'utf8' }); } catch (e) { ok = false; out = String(e.stdout || e.message); }
    const bad = out.split('\n').filter(l => l.startsWith('❌'));
    check('Add games: a folder of games is scanned (each folder\'s main program, helpers left out) and a Playnite library maps to PC games and console folders (ci/addgames-test.js)', ok && !bad.length, bad.join(' | ') || (out.trim().split('\n').pop() || '')); }

  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  ctx.setDefaultTimeout(90000);
  const page = await ctx.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text().slice(0, 200)); });
  const pause = ms => page.waitForTimeout(ms);
  const cfg = () => page.evaluate(async () => { const c = (await window.boxshelf.getConfig()).config; c.pc = c.pc || {}; c.pc.custom = c.pc.custom || []; c.ui = c.ui || {}; return c; });
  // (beta.8) one click acts on a row; the Enter this used to add only did nothing because focus was left on a row that had
  // gone (now fixed: focus moves to the row now last, so a second press would act on it)
  const press = async label => { await page.getByText(label, { exact: true }).first().click(); await pause(900); };
  try {
    await page.goto(base + '?platform=windows&shelf=1&playnite=1&pcx=1'); // (pcx: the demo's Custom shelf)
    await page.waitForFunction(() => window.Shelf && Shelf._qs && Shelf._qs().g && window.Setup, null, { timeout: 90000, polling: 250 }); await pause(1500);
    await page.evaluate(() => Setup.open({ page: 'addgames' })); await pause(1200);
    const n0 = (await cfg()).pc.custom.length;
    // several programs at once
    await press('Add several programs');
    const listed = await page.evaluate(() => document.body.innerText);
    await press('Add the ticked games'); await pause(600);
    const c1 = await cfg();
    check('Add games: several programs at once are listed by name first, then added together',
      /Star Rally/.test(listed) && /Moon Forge/.test(listed) && c1.pc.custom.length === n0 + 2 && c1.pc.custom.some(c => c.title === 'Moon Forge'), JSON.stringify({ n0, n1: c1.pc.custom.length }));
    // a folder: untick one
    await press('Scan a folder');
    await page.getByText('Clockwork Garden', { exact: true }).first().click(); await pause(400); // (a click toggles a tick row)
    await page.screenshot({ path: path.join(OUT, 'addgames-folder.png') });
    await press('Add the ticked games'); await pause(600);
    const c2 = await cfg();
    check('Add games: a scanned folder lists its games with a tick each; an unticked one stays off the shelf',
      c2.pc.custom.length === n0 + 4 && c2.pc.custom.some(c => c.title === 'Aurora Drift') && !c2.pc.custom.some(c => c.title === 'Clockwork Garden'), JSON.stringify(c2.pc.custom.map(c => c.title)));
    // Playnite
    await press('Import from Playnite (experimental)'); await pause(800);
    const sum = await page.evaluate(() => document.body.innerText);
    await page.screenshot({ path: path.join(OUT, 'addgames-playnite.png') });
    await press('Import'); await pause(900);
    const c3 = await cfg();
    check('Playnite (experimental): its summary (PC games, GameCube folder, what\'s left out and why), then Import adds the ticked games and folders',
      /From Playnite/i.test(sum) && /GameCube games/.test(sum) && /store games/.test(sum) && c3.pc.custom.some(c => c.title === 'Lantern Path' && c.src === 'playnite') && !c3.pc.custom.some(c => c.title === 'Old Tower')
        && c3.systems.gc.romDirs.includes('E:\\ROMs\\GameCube') && (c3.ui.favorites || []).some(f => /pn-p1/.test(f)), JSON.stringify({ pn: c3.pc.custom.filter(c => c.src).map(c => c.title), gc: c3.systems.gc.romDirs, fav: c3.ui.favorites }));
    await press('Remove what was imported from Playnite'); await page.keyboard.press('Enter'); await pause(900);
    const c4 = await cfg();
    check('Playnite: Remove what was imported takes its games and folders off again (the others stay)',
      !c4.pc.custom.some(c => c.src === 'playnite') && !c4.systems.gc.romDirs.includes('E:\\ROMs\\GameCube') && c4.pc.custom.length === n0 + 4, JSON.stringify({ n: c4.pc.custom.length, gc: c4.systems.gc.romDirs }));
    await page.evaluate(() => window.Settings && Settings.close && Settings.close()); await pause(1500);
    // the Custom shelf's Add games tile
    const tile = await page.evaluate(() => { const s = Shelf._lib.shelves().find(x => x.id === 'custom'); return s ? s.last : null; });
    check('The Custom shelf ends in an Add games tile', tile === 'setup-custom', String(tile));
    // first run: the Playnite offer
    await page.goto(base + '?platform=windows&playnite=1'); await page.waitForSelector('#setup.on', { timeout: 90000 }); await pause(800);
    await page.getByRole('button', { name: 'Find my emulators and games' }).click(); await pause(2200);
    check('First run: with Playnite on the PC, Your consoles offers to import its library (experimental)', !!(await page.$('#wz-pn')));
    check('Add games pass: no page errors', !errors.length, errors.slice(0, 3).join(' | '));
  } catch (e) { check('Add games pass ran to the end', false, e.message.split('\n')[0]); try { await page.screenshot({ path: path.join(OUT, 'addgames-fail.png') }); } catch {} }
  await ctx.close();
};
