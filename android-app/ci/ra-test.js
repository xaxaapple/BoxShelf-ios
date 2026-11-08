// Device test pass "RetroAchievements" (0.3.5, android-ra.js), run by web-device-test.js on the pretend Thor
// (?fakeNative=1). The pretend device answers RetroAchievements' Web API deterministically (installFake in android-ra.js):
// GameCube Pikmin mastered, The Wind Waker 5 of 40; SNES Chrono Trigger by title, Super Metroid only by its ROM hash.
// Checks results, never speed: every wait polls with a generous timeout (the build machine draws in software).
//   Off until signed in; Test refuses a wrong key, then connects; the key never in an address the page makes;
//   the shelf's badges, Details' ring and the full list, the quick menu's Trophies row, the bottom screen's Trophies;
//   hashes only where the title doesn't match (never for disc consoles); a game played → its unlock shown on return and
//   fresh numbers; a fresh start answers from the saved copies (no new requests, no hashing again).
'use strict';
const path = require('path');

module.exports = async function raPass({ browser, base, check, newPage, OUT }) {
  const { ctx, page, errors } = await newPage(browser, null);
  await ctx.route(/media\.retroachievements\.org/, r => r.abort()).catch(() => {}); // (badges: no network in the test)
  const url = base + '?fakeNative=1';
  const until = (fn, arg, ms = 60000) => page.waitForFunction(fn, arg, { timeout: ms, polling: 200 }).then(() => true, () => false);
  const keyFree = () => page.evaluate(() => { const C = window.__fakeRa ? __fakeRa.calls : []; return C.length > 0 && C.every(c => c.ra && !/[?&](y|z)=/.test(c.url)); });
  try {
    await page.goto(url); await page.waitForTimeout(4000);
    // ---- set up three consoles, then the account ----
    const acct = await page.evaluate(async () => {
      const api = window.boxshelf, c = (await api.getConfig()).config, det = await api.detect();
      const dirs = [await api.pick({ kind: 'folder' }), await api.pick({ kind: 'folder' }), await api.pick({ kind: 'folder' })];
      for (const [i, id] of ['gc', 'psx', 'snes'].entries()) { c.systems[id].romDirs = [dirs[i]]; c.systems[id].emulator = det.systems[id].emulator; }
      c.setupDone = true; await api.saveConfig(c); await api.scan();
      const off = await api.raEnabled(), none = await api.testApi('ra'), offShelf = await api.raShelf('gc', ['Pikmin']);
      c.ra = { user: 'tester', key: 'wrong', enabled: true }; await api.saveConfig(c);
      const bad = await api.testApi('ra');
      c.ra.key = 'k3y-for-tests'; await api.saveConfig(c);
      const good = await api.testApi('ra'), status = (await api.apiStatus()).ra, on = await api.raEnabled();
      localStorage.setItem('boxshelf-ui', JSON.stringify({ sys: 'gc', sel: 0 }));
      return { off, none, offShelf, bad, good, status, on };
    });
    check('RetroAchievements: off until signed in (no requests); Test refuses a wrong key, then connects with name and points',
      acct.off && !acct.off.enabled && acct.none.state === 'none' && !Object.keys(acct.offShelf || {}).length && acct.bad.state === 'fail' && /not accepted/i.test(acct.bad.msg) &&
      acct.good.state === 'ok' && acct.good.user === 'tester' && acct.good.points === 4321 && acct.status && acct.status.state === 'ok' && acct.on.enabled && ['gc', 'snes', 'nes', 'gba', 'psx', 'n64', 'nds'].every(s => acct.on.systems.includes(s)),
      `off ${acct.off && acct.off.enabled} · ${acct.none.state} · wrong key: ${acct.bad.state} "${acct.bad.msg}" · ${acct.good.state} ${acct.good.user} ${acct.good.points} pts · ${acct.on.systems.length} consoles`);

    // ---- a start with the account: the points by the clock, the shelf's numbers ----
    await page.goto(url);
    const pts = await until(() => { const e = document.getElementById('raPts'); return e && !e.hidden && /4,321 pts/.test(e.textContent) && /tester/.test(e.textContent); });
    const sh = await page.evaluate(async () => {
      const api = window.boxshelf, lib = await api.cachedLibrary(), titles = id => lib.find(s => s.id === id).games.map(g => g.title);
      const gc = await api.raShelf('gc', titles('gc')), psx = await api.raShelf('psx', titles('psx'));
      const n0 = __fakeRa.calls.length; await api.raShelf('gc', titles('gc')); await api.raShelf('psx', titles('psx'));
      return { gc, psx, again: __fakeRa.calls.length - n0, titles: titles('gc') };
    });
    const ww = sh.titles.find(t => /Wind Waker/.test(t)) || '';
    check('RetroAchievements: the points by the clock (profile summary)', pts, pts ? '4,321 pts · tester' : 'not shown');
    check('RetroAchievements: shelf numbers by title (GameCube, PlayStation), answered again from the cache',
      sh.gc.Pikmin && sh.gc.Pikmin.id === 1601 && sh.gc.Pikmin.earned === 30 && sh.gc.Pikmin.mastered === 'mastered' && sh.gc[ww] && sh.gc[ww].id === 1602 && sh.gc[ww].earned === 5 && sh.gc[ww].total === 40 &&
      sh.gc['Metroid Prime'] && sh.gc['Metroid Prime'].earned === 0 && sh.psx['Crash Bandicoot'] && sh.psx['Crash Bandicoot'].id === 1201 && sh.again === 0,
      `Pikmin ${JSON.stringify(sh.gc.Pikmin)} · ${ww} ${JSON.stringify(sh.gc[ww])} · Crash ${JSON.stringify(sh.psx['Crash Bandicoot'])} · ${sh.again} requests the second time`);

    // ---- SNES: Chrono Trigger by title; Super Metroid only by its ROM's hash, made natively once ----
    const sn = await page.evaluate(async () => {
      const api = window.boxshelf, wait = ms => new Promise(r => setTimeout(r, ms)), T = ['Super Metroid', 'Chrono Trigger'];
      const first = await api.raShelf('snes', T);
      for (let i = 0; i < 300 && !__fakeRa.hash.some(h => /^Super Metroid/.test(h.name)); i++) await wait(100);
      await wait(800);
      return { first, after: await api.raShelf('snes', T), hash: __fakeRa.hash.slice() };
    });
    check('RetroAchievements: a title that matches nothing is found by the ROM\'s hash (never by a hack with a close title)',
      !sn.first['Super Metroid'] && sn.first['Chrono Trigger'] && sn.first['Chrono Trigger'].id === 302 && sn.after['Super Metroid'] && sn.after['Super Metroid'].id === 301 && sn.after['Super Metroid'].earned === 10 && sn.after['Super Metroid'].total === 64,
      `before: ${JSON.stringify(sn.first['Super Metroid'] || null)} · after: ${JSON.stringify(sn.after['Super Metroid'] || null)} · Chrono ${JSON.stringify(sn.first['Chrono Trigger'] || null)}`);
    check('RetroAchievements: hashes only where the title isn\'t exact (SNES rule), never for disc consoles',
      sn.hash.length === 1 && sn.hash[0].kind === 'snes' && /^Super Metroid/.test(sn.hash[0].name), JSON.stringify(sn.hash));

    // ---- on the shelf: Pikmin's line, the bottom screen's Trophies, the quick menu ----
    for (let i = 0; i < 8 && await page.evaluate(() => Shelf._qs().g) !== 'Pikmin'; i++) { await page.keyboard.press('ArrowRight'); await page.waitForTimeout(700); }
    const onShelf = await until(() => /Mastered/.test((document.getElementById('gMeta') || {}).textContent || ''), null, 30000);
    const bottom = await until(() => { const m = (window.__fakeBottom || []).filter(x => x && x.type === 'game' && x.game && x.game.title === 'Pikmin').pop();
      return !!(m && m.game.achOn && m.game.ach && m.game.ach.earned === 30 && m.game.ach.total === 30 && m.game.ach.mastered === true); }, null, 30000);
    const qm = await page.evaluate(async () => { Shelf.quickMenu(); await new Promise(r => setTimeout(r, 900)); const t = (document.getElementById('quickMenu') || {}).innerText || '';
      Shelf.homeButton(); await new Promise(r => setTimeout(r, 500)); return t.replace(/\s+/g, ' '); });
    await page.screenshot({ path: path.join(OUT, 'ra-1-shelf.png') });
    check('RetroAchievements: the shelf\'s line says Mastered for Pikmin', onShelf, await page.evaluate(() => (document.getElementById('gMeta') || {}).textContent));
    check('RetroAchievements: the bottom screen\'s Trophies get the game\'s numbers', bottom, bottom ? 'Pikmin 30 / 30, mastered' : JSON.stringify(await page.evaluate(() => ((window.__fakeBottom || []).filter(x => x && x.game).pop() || {}).game || null)).slice(0, 160));
    check('RetroAchievements: the quick menu\'s Trophies row', /Trophies/.test(qm) && /30 \/ 30 · 4,321 pts/.test(qm), (qm.match(/Trophies.{0,60}/) || [qm.slice(0, 80)])[0]);

    // ---- Details: The Wind Waker's ring, then the full list ----
    for (let i = 0; i < 8 && await page.evaluate(() => Shelf._qs().g) !== ww; i++) { await page.keyboard.press('ArrowRight'); await page.waitForTimeout(700); }
    await page.evaluate(() => __fakeN.fireBottom({ type: 'cmd', cmd: 'details' }));
    const det = await until(() => { const b = document.getElementById('dAch'), s = document.getElementById('dAchSub'); return b && !b.hidden && b.dataset.state === 'ok' && /5 of 40 unlocked/.test(s.textContent); }, null, 30000);
    await page.screenshot({ path: path.join(OUT, 'ra-2-details.png') });
    await page.evaluate(() => { const b = document.getElementById('dAchBtn'); if (b && !b.hidden) b.click(); });
    const list = await until(() => { const v = document.getElementById('achv'); return v && v.classList.contains('on') && document.querySelectorAll('#achList .ach').length > 0; }, null, 30000);
    const L = await page.evaluate(() => ({ rows: document.querySelectorAll('#achList .ach').length, locked: document.querySelectorAll('#achList .ach.locked').length, tabs: (document.getElementById('achTabs') || {}).innerText || '' }));
    check('RetroAchievements: Details shows the game\'s ring (5 of 40), and its full list opens', det && list && L.rows === 40 && L.locked === 35 && /Unlocked 5/.test(L.tabs.replace(/\s+/g, ' ')),
      `ring ${det ? 'ok' : 'missing'} · list ${L.rows} rows, ${L.locked} locked · ${L.tabs.replace(/\s+/g, ' ')}`);
    await page.keyboard.press('Escape'); await page.waitForTimeout(500); await page.keyboard.press('Escape'); await page.waitForTimeout(800);

    // ---- a game played: the unlock shown on the way back, then fresh numbers ----
    const play = await page.evaluate(async ww => {
      const api = window.boxshelf, wait = ms => new Promise(r => setTimeout(r, ms));
      const g = (await api.cachedLibrary()).find(s => s.id === 'gc').games.find(x => x.title === ww);
      __fakeRa.unlocks = [{ AchievementID: 160206, Title: 'Sail the Great Sea', Description: 'A pretend unlock', Points: 10, BadgeName: '00006', GameTitle: 'The Wind Waker', HardcoreMode: 0, Date: '2026-10-25 10:00:00' }];
      const n0 = __fakeRa.calls.length;
      await api.launchGame('gc', g.file);
      let seen = '';
      for (let i = 0; i < 200 && !seen; i++) { await wait(100); const u = document.querySelector('#unlocks .unlock'); if (u) seen = u.innerText.replace(/\s+/g, ' '); }
      await wait(1500);
      const shelf = await api.raShelf('gc', [ww]), prog = await api.raProgress('gc', ww);
      const asked = __fakeRa.calls.slice(n0).map(c => (c.url.match(/API_\w+/) || [''])[0] + (/[?&]g=1602/.test(c.url) ? ':1602' : ''));
      return { seen, shelf: shelf[ww], earned: prog && prog.earned, asked };
    }, ww);
    check('RetroAchievements: back from a game, its unlock is shown and its numbers are asked again',
      /Sail the Great Sea/.test(play.seen) && play.shelf && play.shelf.earned === 6 && play.earned === 6 && play.asked.includes('API_GetUserRecentAchievements') && play.asked.includes('API_GetGameInfoAndUserProgress:1602'),
      `"${play.seen.slice(0, 70)}" · shelf ${play.shelf && play.shelf.earned}/40 · details ${play.earned} · asked ${[...new Set(play.asked)].join(', ')}`);

    // ---- a fresh start: everything from the saved copies ----
    await page.goto(url);
    await until(() => { const e = document.getElementById('raPts'); return e && !e.hidden && /4,321/.test(e.textContent); }, null, 30000);
    await page.waitForTimeout(2500);
    const fresh = await page.evaluate(async () => { const api = window.boxshelf, sn = await api.raShelf('snes', ['Super Metroid', 'Chrono Trigger']);
      await new Promise(r => setTimeout(r, 800)); return { calls: __fakeRa.calls.map(c => (c.url.match(/API_\w+/) || [''])[0]), sm: sn['Super Metroid'], hash: __fakeRa.hash.length }; });
    check('RetroAchievements: a fresh start answers from the saved copies (no requests, no hashing again)', !fresh.calls.length && fresh.sm && fresh.sm.id === 301 && !fresh.hash,
      `${fresh.calls.length} requests (${fresh.calls.join(', ')}) · Super Metroid ${JSON.stringify(fresh.sm || null)} · ${fresh.hash} hashed`);

    // ---- Settings: the account's chip, and the Android note about the emulators' own sign-in ----
    await page.evaluate(async () => { await window.boxshelf.testApi('ra'); Setup.open({ page: 'acct' }); });
    // (waits for the account's status too: it comes from a background request a moment after the page draws)
    const set = await until(() => { const t = ((document.querySelector('#bss') || {}).innerText || '').replace(/\s+/g, ' '); return /RetroAchievements/.test(t) && /Connected · tester/.test(t); }, null, 30000);
    const setText = await page.evaluate(() => ((document.querySelector('#bss') || {}).innerText || '').replace(/\s+/g, ' '));
    const rowInfo = await page.evaluate(() => { let info = ''; try { const S = window.BS_SETTINGS_PATCH([{ id: 'acct', name: 'Accounts', rows: [{ t: 'action', label: 'RetroAchievements', status: 'ra', info: 'x' }] }], {}); for (const s of S) for (const r of s.rows || []) if (r && r.status === 'ra') info = r.info; } catch (e) { info = 'ERR ' + e.message; } return info; });
    await page.screenshot({ path: path.join(OUT, 'ra-3-settings.png') });
    check('RetroAchievements: Settings shows the account connected, and says to sign in inside each emulator', set && /Connected · tester/.test(setText) && /RetroArch: Settings → Achievements/.test(rowInfo),
      `${(setText.match(/RetroAchievements.{0,50}/) || [''])[0]} · ${rowInfo.slice(0, 60)}`);
    check('RetroAchievements: the web API key never appears in an address the page makes', await keyFree(), 'added natively');
    check('RetroAchievements pass: no script errors', !errors.length, errors.slice(0, 3).join(' | '));
  } catch (e) { check('RetroAchievements pass ran to the end', false, e && e.stack ? e.stack.split('\n').slice(0, 2).join(' ') : e); }
  await ctx.close();
};
