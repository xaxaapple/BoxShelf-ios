// Device test pass "setup" (beta.7), run by web-device-test.js: the demo page as Windows on a 1920x1080 TV.
//   The consoles added in beta.7 (Saturn … DOS) are in every table they need; the arcade list names "sf2.zip" and hides
//   BIOS zips; Set up for me (ci/emusetup-test.js, run here too) writes, keeps and undoes what it should.
//   First run with RetroArch installed and 17 retro consoles it could run: only consoles with games come ticked; the rest
//   fold away, grouped by maker as small chips. Finish shows "Set up my emulators for me"; Done says what was set up.
//   Settings → SNES → Set up RetroArch for me: Set up, then Undo (pressed twice). Screenshots: setup-*.png.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..', '..');

module.exports = async function setupPass({ browser, base, check, OUT }) {
  // ---------- node side: tables, the arcade list, the setup engine ----------
  const WAVE2 = ['saturn', 'pcengine', 'neogeo', 'arcade', 'segacd', 'sega32x', 'atari2600', 'atarilynx', 'wonderswan', 'dos'];
  { const { CONSOLES } = require(path.join(ROOT, 'main', 'systems'));
    const rows = WAVE2.map(id => CONSOLES.find(c => c.id === id));
    const txt = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
    const main = txt('main.js'), covers = txt('main/covers.js'), ss = txt('main/screenscraper.js'), man = txt('main/manuals.js'), style = txt('renderer/style.css'), extra = txt('renderer/systems-extra.js');
    const missing = [];
    rows.forEach((c, i) => { const id = WAVE2[i]; if (!c || !c.raCore || !c.retro) { missing.push(id + ':systems'); return; }
      if (!new RegExp('\\b' + c.raCore + ": '").test(main)) missing.push(id + ':core name');
      if ((covers.match(new RegExp('\\b' + id + ": '", 'g')) || []).length < 2) missing.push(id + ':covers');
      if (!new RegExp('\\b' + id + ': \\d+').test(ss)) missing.push(id + ':screenscraper');
      if ((man.match(new RegExp('\\b' + id + ':', 'g')) || []).length < 3) missing.push(id + ':manuals');
      if (!style.includes('.wm-' + id + '{')) missing.push(id + ':wordmark');
      if (!new RegExp('\\b' + id + ':').test(extra)) missing.push(id + ':case style'); });
    check('beta.7 consoles: Saturn … DOS each have a RetroArch core, art sources, manuals, ScreenScraper, a wordmark and a case', !missing.length, missing.join(', ') || 'all 10'); }
  { // the arcade list: a small FinalBurn Neo-style list, parsed and used by the scanner
    const os = require('os'), { Readable } = require('stream');
    const A = require(path.join(ROOT, 'main', 'arcadenames')), data = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-arcade-'));
    const games = Array.from({ length: 120 }, (_, i) => `\t<game name="g${i}"><description>Game ${i}</description></game>`).join('\n');
    const dat = `<datafile>\n<game isbios="yes" name="neogeo" sourcefile="neogeo/d_neogeo.cpp">\n\t<description>Neo-Geo</description>\n</game>\n<game name="sf2" sourcefile="capcom/d_cps1.cpp">\n\t<description>Street Fighter II: The World Warrior (World 910522)</description>\n</game>\n<game name="sf2ua" cloneof="sf2">\n\t<description>Street Fighter II: The World Warrior (USA 910206)</description>\n</game>\n<game name="kof98" romof="neogeo">\n\t<description>The King of Fighters '98 - The Slugfest / King of Fighters '98 - Dream Match Never Ends</description>\n</game>\n${games}\n</datafile>\n`;
    const t = await A.parse(Readable.from([dat.slice(0, 200), dat.slice(200)]));
    A.init(data); fs.writeFileSync(path.join(data, 'arcade-names.json'), JSON.stringify(t));
    const roms = path.join(data, 'roms'); fs.mkdirSync(roms); for (const n of ['sf2.zip', 'sf2ua.zip', 'kof98.zip', 'neogeo.zip', 'pgm.zip']) fs.writeFileSync(path.join(roms, n), 'x'.repeat(4000));
    const def = require(path.join(ROOT, 'main', 'systems')).CONSOLES.find(c => c.id === 'arcade');
    const titles = require(path.join(ROOT, 'main', 'scanner')).scanSystem(def, { romDirs: [roms] }).map(g => g.title).sort();
    fs.rmSync(data, { recursive: true, force: true });
    check('Arcade: zips named from the FinalBurn Neo list, one box per game, BIOS zips (neogeo, pgm) left off the shelf',
      JSON.stringify(titles) === JSON.stringify(['Street Fighter II: The World Warrior', 'The King of Fighters \'98 - The Slugfest']) && t.bios.includes('neogeo'), JSON.stringify(titles)); }
  { let out = '', ok = true; try { out = execFileSync(process.execPath, [path.join(__dirname, 'emusetup-test.js')], { encoding: 'utf8' }); } catch (e) { ok = false; out = String(e.stdout || e.message); }
    const bad = out.split('\n').filter(l => l.startsWith('❌'));
    check('Set up for me: RetroArch, DuckStation, PCSX2 and Dolphin files written, your own mapping and BIOS kept, Undo puts them back (ci/emusetup-test.js)', ok && !bad.length, bad.join(' | ') || (out.trim().split('\n').pop() || '')); }

  // ---------- the page ----------
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  ctx.setDefaultTimeout(90000);
  const page = await ctx.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text().slice(0, 200)); });
  const pause = ms => page.waitForTimeout(ms);
  try {
    // first run: RetroArch installed, a few retro consoles with games, many without
    await page.goto(base + '?platform=windows&retro=1&wave2=1');
    await page.waitForSelector('#setup.on', { timeout: 90000 }); await pause(800);
    await page.getByRole('button', { name: 'Find my emulators and games' }).click(); await pause(1800);
    const p = await page.evaluate(() => {
      const big = [...document.querySelectorAll('.wz2-grid .wz2-card')].map(c => c.dataset.pick);
      return { big, ticked: big.filter(id => document.querySelector(`[data-pick="${id}"]`).getAttribute('aria-checked') === 'true').length, more: (document.querySelector('.con-more') || {}).textContent || '' };
    });
    check('First run: consoles RetroArch could run but with no games aren\'t ticked; they wait under More consoles',
      !p.big.some(id => ['nes', 'n64', 'pcengine', 'neogeo', 'dos', 'wonderswan'].includes(id)) && p.big.includes('saturn') && /More consoles and apps \(\d+\)/.test(p.more), JSON.stringify({ big: p.big.length, more: p.more }));
    await page.locator('.con-more').click(); await pause(600);
    const m = await page.evaluate(() => ({ heads: [...document.querySelectorAll('#suBody .con-sub')].map(x => x.textContent), chips: document.querySelectorAll('.wz2-more .wz2-chip').length, note: !!document.querySelector('.wz2-more-note'),
      cards: document.querySelectorAll('.wz2-grid.small .wz2-card').length }));
    await page.screenshot({ path: path.join(OUT, 'setup-more-consoles.png') });
    check('First run: More consoles is grouped by maker (Nintendo, Sega, Retro & arcade) as small chips, with one line about RetroArch',
      m.heads.includes('Nintendo') && m.heads.includes('Sega') && m.heads.includes('Retro & arcade') && m.chips >= 10 && m.note && m.cards === 0, JSON.stringify(m));
    await page.locator('[data-pick="dos"]').click(); await pause(300);
    check('First run: a chip ticks (DOS gets a shelf)', await page.evaluate(() => document.querySelector('[data-pick="dos"]').getAttribute('aria-checked') === 'true'));
    await page.locator('[data-pick="dos"]').click(); await pause(300); // (back off: DOS has no games here)
    await page.getByRole('button', { name: 'Next' }).click(); await pause(800);
    const fin = await page.evaluate(() => { const a = document.querySelector('.wz2-auto'); return { has: !!a, text: a ? a.textContent : '', on: !!(a && a.querySelector('input:checked')) }; });
    await page.screenshot({ path: path.join(OUT, 'setup-finish.png') });
    check('First run: Finish setting up offers "Set up my emulators for me", on, naming the emulators found', fin.has && fin.on && /RetroArch/.test(fin.text) && /DuckStation/.test(fin.text), JSON.stringify({ has: fin.has, on: fin.on }));
    await page.getByRole('button', { name: 'Next' }).click(); await pause(800);
    await page.getByRole('button', { name: 'Next' }).click(); await pause(800);
    // (beta.9) Accounts, optional: one card per service, and the page can be skipped without filling anything in
    const ac = await page.evaluate(() => ({ title: (document.getElementById('suTitle') || {}).textContent || '', nav: [...document.querySelectorAll('#suNav .su-step')].map(s => s.textContent.trim()),
      cards: [...document.querySelectorAll('.wz2-acct')].map(c => c.dataset.svc), next: (document.querySelector('#suFoot [data-next]') || {}).textContent || '' }));
    check('First run (beta.9): an optional Accounts page between Box art and Done, a card each for RetroAchievements, SteamGridDB, ScreenScraper (and fanart.tv under More), skippable',
      /Connect your accounts/.test(ac.title) && ac.nav.join('|') === 'Welcome|Your consoles|Finish setting up|Box art|Accounts|Done' && ac.cards.join() === 'ra,steamgriddb,screenscraper,fanart' && ac.next === 'Skip for now', JSON.stringify(ac));
    await page.getByRole('button', { name: 'Skip for now' }).click(); await pause(2500);
    const skipped = await page.evaluate(async () => { const c = (await window.boxshelf.getConfig()).config; return { title: (document.getElementById('suTitle') || {}).textContent || '', ra: (c.ra && c.ra.user) || '', sg: (c.keys && c.keys.steamgriddb) || '' }; });
    check('First run (beta.9): Skip for now goes on to Done and leaves every account empty', /library/i.test(skipped.title) && !skipped.ra && !skipped.sg, JSON.stringify(skipped));
    const done = await page.evaluate(() => (document.querySelector('.wz2-emudone') || {}).textContent || '');
    check('First run: Done says what was set up and what was left as you had it', /Set up: .*RetroArch/.test(done) && /Left as you had them: Dolphin/.test(done), done.slice(0, 160));
    // (beta.9) Accounts filled in: typed on a keyboard, and with a controller (A on a box opens the on-screen keyboard, B puts it away)
    await page.goto(base + '?platform=windows&retro=1');
    await page.waitForSelector('#setup.on', { timeout: 90000 }); await pause(800);
    await page.locator('#suNav .su-step', { hasText: 'Accounts' }).click(); await pause(600);
    await page.locator('input[data-osk="ra.user"]').fill('tester'); await pause(200);
    const fill = await page.evaluate(async () => { const w = ms => new Promise(r => setTimeout(r, ms)), o = {}, q = s => document.querySelector(s);
      o.next = (q('#suFoot [data-next]') || {}).textContent;
      document.body.classList.add('pad-input'); o.typeBtn = getComputedStyle(q('.wz2-kb')).display !== 'none';
      q('input[data-osk="ra.key"]').focus(); Setup.pad('ok'); await w(300);
      o.osk = !!q('.wz2-osk'); o.onKey = document.activeElement.classList.contains('ia-key');
      Setup.pad('ok'); Setup.pad('right'); Setup.pad('ok'); Setup.pad('down'); Setup.pad('ok'); await w(200); // 1, 2, then w (the row below)
      [...document.querySelectorAll('.wz2-osk .ia-key')].find(b => b.textContent === 'ABC').click(); await w(200);
      [...document.querySelectorAll('.wz2-osk .ia-key')].find(b => b.textContent === 'Q').click(); await w(150);
      o.typed = q('input[data-osk="ra.key"]').value;
      Setup.key(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })); await w(300);
      o.oskGone = !q('.wz2-osk'); o.stillHere = /Connect your accounts/.test(q('#suTitle').textContent); o.focusBack = (document.activeElement.dataset || {}).osk || '';
      q('[data-test="ra"]').click(); for (let i = 0; i < 30 && !/Connected/.test((q('.wz2-acct[data-svc="ra"] .badge') || {}).textContent || ''); i++) await w(200);
      o.badge = (q('.wz2-acct[data-svc="ra"] .badge') || {}).textContent || '';
      document.body.classList.remove('pad-input'); o.typeBtnMouse = getComputedStyle(q('.wz2-kb')).display !== 'none';
      // Paste (most keys are copied from the browser): one line, trimmed
      window.__bsClip = '  sgkey123  \nsecond line'; q('[data-paste="keys.steamgriddb"]').click(); await w(300);
      o.pasted = q('input[data-osk="keys.steamgriddb"]').value;
      await w(600); const c = (await window.boxshelf.getConfig()).config; o.ra = c.ra; o.sg = c.keys && c.keys.steamgriddb; return o; });
    await page.screenshot({ path: path.join(OUT, 'setup-accounts.png') });
    check('First run (beta.9): Accounts typed in turns Skip into Next; a controller types the key on the on-screen keyboard (capitals too), B / Esc puts it away and stays on the page; Test says Connected; both are saved',
      fill.next === 'Next' && fill.typeBtn && !fill.typeBtnMouse && fill.osk && fill.onKey && fill.typed === '12wQ' && fill.oskGone && fill.stillHere && fill.focusBack === 'ra.key' && /Connected/.test(fill.badge) &&
      fill.ra && fill.ra.user === 'tester' && fill.ra.key === '12wQ', JSON.stringify(fill));
    check('First run (beta.9): Paste beside a key box fills it from the clipboard (first line, trimmed) and saves it', fill.pasted === 'sgkey123' && fill.sg === 'sgkey123', JSON.stringify({ pasted: fill.pasted, saved: fill.sg }));
    // Settings → SNES → Set up RetroArch for me (on the demo shelf, set up already)
    await page.goto(base + '?platform=windows&shelf=1&retro=1');
    await page.waitForFunction(() => window.Shelf && Shelf._qs && Shelf._qs().g && window.Setup, null, { timeout: 90000, polling: 250 }); await pause(1500);
    await page.evaluate(() => Setup.open({ page: 'snes' })); await pause(1200);
    await page.getByText('Set up RetroArch for me', { exact: true }).click(); await pause(1200);
    const sp = await page.evaluate(() => document.body.innerText.split('\n').map(s => s.trim()).filter(Boolean));
    check('Settings: Set up RetroArch for me has a switch per kind of change, Set up and Show what will change',
      ['No quit questions', 'Home menu hotkeys', 'Controller', 'Resume where you left off', 'Set up RetroArch', 'Show what will change'].every(t => sp.includes(t)), sp.slice(0, 14).join(' | '));
    await page.getByText('Set up RetroArch', { exact: true }).click(); await page.keyboard.press('Enter'); await pause(1500);
    const after = await page.evaluate(() => document.body.innerText);
    await page.screenshot({ path: path.join(OUT, 'setup-settings.png') });
    check('Settings: Set up runs, and the page then says RetroArch is set up and offers Undo', /RetroArch is set up/.test(after) && /\bUndo\b/.test(after));
    await page.getByText('Undo', { exact: true }).first().click(); await page.keyboard.press('Enter'); await pause(300); await page.keyboard.press('Enter'); await pause(1500);
    check('Settings: Undo (pressed twice) puts it back', /RetroArch isn.t set up yet/.test(await page.evaluate(() => document.body.innerText)));
    check('Setup pass: no page errors', !errors.length, errors.slice(0, 3).join(' | '));
  } catch (e) { check('Setup pass ran to the end', false, e.message.split('\n')[0]); try { await page.screenshot({ path: path.join(OUT, 'setup-fail.png') }); } catch {} }
  await ctx.close();
};
