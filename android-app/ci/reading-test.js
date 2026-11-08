// Device test pass "magazines & guides" (0.3.2, android-reading.js), run by web-device-test.js on the pretend Thor
// (?fakeNative=1, Thor-like screen, touch, a controller plugged in). The pretend device answers archive.org's search,
// metadata and downloads deterministically (installFake in android-reading.js). Checks results, never speed: every wait
// polls with a generous timeout (the build machine draws in software).
//   Settings → Magazines & guides (Android rows) → the store; covers with year and size; d-pad + A downloads into
//   "Boxshelf Reading/Magazines/<series>" beside the ROMs; touch search, tap + Download (into Guides); borrow-only and
//   scan-only items refused; X cancels; back to Settings; the museum's reading corner has the downloads (and the PC-style
//   folders), the museum's reader draws a downloaded page, X there opens the store; a comic archive's pages open.
'use strict';
const path = require('path');
const PAD = `(() => { const pad = window.__pad = { id: 'Thor pad', index: 0, connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0],
  buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })) };
  Navigator.prototype.getGamepads = function () { return [pad, null, null, null]; }; })();`;

module.exports = async function readingPass({ browser, base, check, newPage, OUT }) {
  const { ctx, page, errors } = await newPage(browser, PAD);
  const url = base + '?fakeNative=1';
  const pause = ms => page.waitForTimeout(ms);
  const st = () => page.evaluate(() => window.BS_READING ? BS_READING.state() : null);
  const until = (fn, arg, ms = 60000) => page.waitForFunction(fn, arg, { timeout: ms, polling: 100 }).then(() => true, () => false);
  // a controller button, held until the store has acted on it (released in the page itself, so a slow machine never
  // holds it long enough to repeat)
  const pad = (b, key, val) => page.evaluate(async ({ b, key, val }) => {
    const w = ms => new Promise(r => setTimeout(r, ms)), ok = () => { const s = BS_READING.state(); return key === 'job' ? s.jobs.some(j => j.id === val) : s[key] === val; };
    __pad.buttons[b] = { pressed: true, touched: true, value: 1 }; __pad.timestamp++;
    for (let i = 0; i < 1500 && !ok(); i++) await w(10);
    __pad.buttons[b] = { pressed: false, touched: false, value: 0 }; __pad.timestamp++; await w(300); return ok(); }, { b, key, val });
  try {
    await page.goto(url); await pause(4000);
    // the main ROMs folder picked (as the setup wizard does) and its consoles scanned
    await page.evaluate(async () => { const api = window.boxshelf, c = (await api.getConfig()).config, det = await api.detect();
      window.__fakePickNext = 'primary:ROMs'; const root = await api.romRoot(); c.romRoot = root.path;
      for (const f of root.found) { c.systems[f.id].romDirs = [f.dir]; c.systems[f.id].emulator = det.systems[f.id].emulator; }
      c.setupDone = true; await api.saveConfig(c); await api.scan(); });
    await page.goto(url); await pause(5000);

    // ---- Settings → Magazines & guides ----
    await page.evaluate(() => Setup.open({ page: 'reading' }));
    // (beta.9: waits for the whole line it checks, the folder included: it can come a moment after the counts on a slow machine)
    await until(() => /Your magazines & guides[\s\S]*1 magazine · 1 guide · ROMs\/Boxshelf Reading/.test((document.querySelector('#bss') || {}).innerText || ''), null, 30000);
    const set = await page.evaluate(() => (document.querySelector('#bss') || {}).innerText || '');
    await page.screenshot({ path: path.join(OUT, 'R0-settings-reading.png') });
    check('Store: Settings → Magazines & guides has the store and "Your magazines & guides" (no PC folder rows)', /Magazines & guides store/.test(set) && /Your magazines & guides/.test(set) && !/Magazines & guides folder|Guides folder|Bring them over/.test(set),
      (set.match(/Magazines & guides store|Your magazines & guides|Magazines & guides folder/g) || []).join(', '));
    // (beta.7: on a miss, say what the scan was waiting on, not just "none")
    const why = /1 magazine · 1 guide · ROMs\/Boxshelf Reading/.test(set) && !process.env.BS_DIAG ? '' : await page.evaluate(async () => { const N = window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.BoxshelfNative, c = (await window.boxshelf.getConfig()).config;
      const L = async uri => { try { return ((await N.listDirs({ uri })) || {}).dirs.map(d => d.name); } catch (e) { return 'error: ' + e.message; } };
      const folders = window.BS_FOLDERS ? BS_FOLDERS() : null, rr = c.romRoot, tree = folders && rr ? folders[rr] : null;
      return JSON.stringify({ row: ((document.querySelector('#bss') || {}).innerText || '').split('\n').filter(l => /magazine|Looking|Boxshelf Reading/i.test(l)).slice(0, 3), romRoot: rr, folders: folders ? Object.fromEntries(Object.entries(folders).map(([k, v]) => [k, typeof v + ':' + String(v).slice(0, 90)])) : 'n/a',
        reading: window.BS_READING && BS_READING.diag ? await BS_READING.diag() : 'n/a', fake: (window.__fakeReading || null), quiet: window.BS_QUIET ? BS_QUIET() : null }); });
    if (why) console.log('READING DIAGNOSIS ' + why); // (beta.7: the full picture in the build log; the summary table cuts details short)
    check('Store: PC-style Magazines / Guides folders copied next to the ROMs are read (a PDF, a folder of pages)', /1 magazine · 1 guide · ROMs\/Boxshelf Reading/.test(set), (set.match(/\d+ magazines? · \d+ guides?[^\n]*/) || ['none'])[0] + (why ? ' · ' + why : ''));
    // A on the store row (the first row): the store opens over a paused Settings
    await page.keyboard.press('Enter');
    const opened = await until(() => window.BS_READING && BS_READING.isOpen() && BS_READING.state().items >= 6, null, 60000);
    const o = await page.evaluate(() => ({ s: BS_READING.state(), settingsActive: Settings.active(), full: document.body.classList.contains('brd-full') }));
    check('Store opens from Settings (Settings paused under it, nothing else drawn)', opened && o.s.shelf === 'np' && o.settingsActive === false, JSON.stringify({ shelf: o.s.shelf, items: o.s.items, settings: o.settingsActive, full: o.full }));
    // covers (Internet Archive thumbnails) with year and the download size, before anything is downloaded
    await until(() => [...document.querySelectorAll('#bsReading .brd-card')].slice(0, 6).every(c => /MB/.test(c.querySelector('.s').textContent) && c.classList.contains('pic')), null, 60000);
    const cards = await page.evaluate(() => [...document.querySelectorAll('#bsReading .brd-card')].slice(0, 6).map(c => ({ y: c.querySelector('.y').textContent, s: c.querySelector('.s').textContent, img: c.querySelector('img').getAttribute('src') || '', pic: c.classList.contains('pic') })));
    await page.screenshot({ path: path.join(OUT, 'R1-store.png') });
    check('Store: a shelf shows covers with their year and download size', cards.length === 6 && cards.every(c => c.pic && /__art|archive\.org\/services\/img/.test(c.img) && /\d/.test(c.y) && /\d+ MB/.test(c.s)), cards.map(c => `${c.y} ${c.s}`).join(' | '));

    // ---- the controller: d-pad moves, A downloads ----
    const r1 = await pad(15, 'cur', 1), r2 = await pad(13, 'cur', 7), r3 = await pad(0, 'job', 'fk-np-008');
    check('Store: the controller moves along the covers (d-pad) and A starts the download', r1 && r2 && r3, `right ${r1}, down ${r2}, A ${r3}`);
    const seenPct = await until(() => [...document.querySelectorAll('#bsReading .brd-card[data-s="run"] .brd-badge')].some(b => /\d+%/.test(b.textContent)), null, 30000);
    await until(() => BS_READING.state().jobs.some(j => j.id === 'fk-np-008' && j.state === 'done'), null, 60000);
    const d1 = await page.evaluate(() => ({ job: BS_READING.state().jobs.find(j => j.id === 'fk-np-008'), saved: __fakeReading.saved.slice(), req: __fakeReading.dl[0], badge: (document.querySelector('#bsReading .brd-card[data-i="7"] .brd-badge') || {}).textContent }));
    check('Store: native download with progress, saved in "Boxshelf Reading/Magazines/<series>" beside the ROMs', seenPct && d1.job && d1.job.state === 'done' && d1.saved.includes('primary:ROMs/Boxshelf Reading/Magazines/Nintendo Power/Nintendo Power Issue 008 (1995).pdf')
      && d1.req && /^https:\/\/archive\.org\/download\/fk-np-008\/.+\.pdf$/.test(d1.req.url) && /tree\/primary%3AROMs$/.test(d1.req.tree) && d1.req.size > 0 && d1.badge === 'Saved',
      `progress shown ${seenPct}, ${d1.saved.join(', ')}, badge ${d1.badge}`);

    // ---- touch: search with Android's keyboard, tap a cover, Download ----
    await page.tap('#bsReading .brd-input'); await pause(400);
    await page.keyboard.type('zelda'); await page.keyboard.press('Enter');
    await until(() => BS_READING.state().shelf === 'search' && BS_READING.state().items === 4, null, 30000);
    await page.tap('#bsReading .brd-kinds [data-h="guide"]');
    await until(() => BS_READING.state().kind === 'guide' && BS_READING.state().items === 4, null, 30000);
    await until(() => [...document.querySelectorAll('#bsReading .brd-card')].every(c => !/…/.test(c.querySelector('.s').textContent)), null, 60000);
    const found = await page.evaluate(() => [...document.querySelectorAll('#bsReading .brd-card')].map(c => ({ t: c.querySelector('.brd-ct').textContent, s: c.querySelector('.s').textContent, st: c.dataset.s })));
    await page.screenshot({ path: path.join(OUT, 'R2-search.png') });
    const by = t => found.find(f => f.t.includes(t)) || {};
    check('Store: a touch search finds covers with sizes; borrow-only and scan-only items are marked, not offered', found.length === 4 && /40 MB/.test(by('Official Strategy').s) && /17 MB · CBZ/.test(by('Comic').s) && by('Lending').st === 'no' && /Borrow-only/.test(by('Lending').s) && by('Scans').st === 'no',
      found.map(f => `${f.t}: ${f.s}`).join(' | '));
    // a borrow-only one: tapped twice, nothing is downloaded
    const lendI = found.findIndex(f => /Lending/.test(f.t));
    await page.tap(`#bsReading .brd-card[data-i="${lendI}"]`); await pause(300); await page.tap(`#bsReading .brd-card[data-i="${lendI}"]`); await pause(600);
    // the comic: a tap picks it, the big button downloads it (a guide search: into Guides)
    const comicI = found.findIndex(f => /Comic/.test(f.t));
    await page.tap(`#bsReading .brd-card[data-i="${comicI}"]`);
    const picked = await until(i => BS_READING.state().cur === i && BS_READING.state().zone === 'grid', comicI, 15000);
    await page.tap('#bsReading .brd-act');
    await until(() => BS_READING.state().jobs.some(j => j.id === 'fk-zelda-comic' && j.state === 'done'), null, 60000);
    const d2 = await page.evaluate(() => ({ saved: __fakeReading.saved.slice(), reqs: __fakeReading.dl.map(d => d.id), jobs: BS_READING.state().jobs.map(j => j.id + ':' + j.state) }));
    check('Store: a tap picks a cover and Download gets it (into Guides); a borrow-only one is never downloaded', picked && d2.saved.includes('primary:ROMs/Boxshelf Reading/Guides/Zelda Comic Collection.cbz') && !d2.reqs.some(id => /lend|scan/.test(id)),
      `picked ${picked}; ${d2.saved.slice(-1)[0]}; requests ${d2.reqs.join(', ')}`);
    // X cancels a running download: nothing is kept
    await page.evaluate(() => { __fakeReading.lat = 900; });
    const guideI = found.findIndex(f => /Official Strategy/.test(f.t));
    await page.tap(`#bsReading .brd-card[data-i="${guideI}"]`); await pause(300);
    await page.keyboard.press('Enter');
    await until(() => BS_READING.state().jobs.some(j => j.id === 'fk-zelda-guide' && j.state === 'run'), null, 20000);
    await page.keyboard.press('x');
    const gone = await until(() => !BS_READING.state().jobs.some(j => j.id === 'fk-zelda-guide'), null, 30000);
    const d3 = await page.evaluate(() => ({ saved: __fakeReading.saved.slice(), cancel: __fakeReading.dl.filter(d => d.id === 'fk-zelda-guide').length }));
    check('Store: X cancels a running download (nothing saved)', gone && d3.cancel === 1 && !d3.saved.some(p => /Official Strategy/.test(p)), `cancelled ${gone}, saved ${d3.saved.length}`);
    await page.evaluate(() => { __fakeReading.lat = 120; });
    // Back: Settings again, at its Magazines & guides page
    await page.keyboard.press('Escape');
    const back = await until(() => !BS_READING.isOpen() && Settings.active() && /Magazines & guides store/.test(document.querySelector('#bss').innerText), null, 20000);
    check('Store: Back returns to Settings → Magazines & guides', back, await page.evaluate(() => `store ${BS_READING.isOpen()}, settings ${Settings.active()}`));

    // ---- the reading corner ----
    for (let i = 0; i < 4 && await page.evaluate(() => Shelf.getMode() !== 'browse'); i++) { await page.keyboard.press('Escape'); await pause(900); }
    const lib = await page.evaluate(() => BS_READING.rescan());
    await page.keyboard.press('m'); await pause(5000);
    await page.evaluate(async () => { const w = ms => new Promise(r => setTimeout(r, ms)); for (let i = 0; i < 6 && window.Museum && Museum._dv && Museum._dv(); i++) { Museum.skipDelivery(); await w(800); } });
    const inRack = await until(() => { const r = (window.Museum && Museum._rack && Museum._rack()) || []; return ['Nintendo Power Issue 008', 'Zelda Comic Collection', 'GamePro 1994-05', 'Mario Guide'].every(t => r.some(x => x.d && x.d.title.startsWith(t))); }, null, 60000);
    const rack = await page.evaluate(() => ((Museum._rack && Museum._rack()) || []).map(x => `${x.d.kind}:${x.d.title}${x.d.series ? ' [' + x.d.series + ']' : ''}`));
    check('Reading corner: the downloads and the PC-copied magazines / guides are on the museum\'s rack', inRack && lib.some(i => i.type === 'arch' && i.kind === 'guide') && lib.some(i => i.type === 'dir'), rack.join(' | '));
    // walk to the downloaded issue, take it, unwrap it, A reads it: the museum's own reader draws its page (pdf.js)
    const took = await page.evaluate(async () => { const w = ms => new Promise(r => setTimeout(r, ms)), it = Museum._rack().find(x => /Nintendo Power Issue 008/.test(x.d.title)); if (!it) return 'not on the rack';
      const k = () => { const c = Museum.current() || {}; return c.lib ? 'lib:' + c.lib.title : c.wide ? 'wide:' + c.wide.label : 'other'; };
      Museum.setRow(it.ri); await w(500);
      for (let i = 0; i < 10 && !/^wide:Magazines|^lib:/.test(k()); i++) { Museum.move(1, 0); await w(600); }
      if (/^wide:/.test(k())) { Museum.activate(); await w(1200); }
      for (let i = 0; i < 6 && !/Nintendo Power Issue 008/.test(k()); i++) { Museum.move(1, 0); await w(700); }
      if (!/Nintendo Power Issue 008/.test(k())) return 'at ' + k();
      Museum.activate(); await w(1500); if (Museum.handState().libWrapped) { Museum.unwrapHeld(); await w(2500); }
      return Museum.handState().libHeld ? 'held' : 'not held'; });
    let reader = { took };
    if (took === 'held') {
      await page.keyboard.press('Enter');
      await until(() => { const c = document.querySelector('#libReader.on .lr-canvas'); return !!c && c.width > 0; }, null, 60000);
      reader = await page.evaluate(() => { const el = document.getElementById('libReader'); return { took: 'held', on: !!el && el.classList.contains('on'), label: el ? el.querySelector('.lr-page').textContent : '', canv: el ? [...el.querySelectorAll('.lr-canvas')].map(c => c.width + 'x' + c.height) : [] }; });
      try { await page.screenshot({ path: path.join(OUT, 'R3-reader.png'), timeout: 15000 }); } catch {}
      for (let i = 0; i < 3 && await page.evaluate(() => !!document.querySelector('#libReader.on') || Museum.isHolding()); i++) { await page.keyboard.press('Escape'); await pause(1200); }
    }
    check('Reading corner: a downloaded magazine opens in the museum\'s reader and its page is drawn', reader.on && /3 pages/.test(reader.label) && reader.canv.length > 0, JSON.stringify(reader));
    // X in the reading corner opens the store over the museum; Back is the museum again
    await page.evaluate(async () => { const w = ms => new Promise(r => setTimeout(r, ms)); for (let i = 0; i < 6 && !(Museum.current() || {}).lib; i++) { Museum.move(-1, 0); await w(600); } });
    await page.keyboard.press('x');
    const fromMus = await until(() => BS_READING.isOpen() && BS_READING.state().items > 0, null, 30000);
    const fm = await page.evaluate(() => ({ mode: Shelf.getMode(), paused: document.body.classList.contains('brd-open') }));
    await page.keyboard.press('Escape');
    const musBack = await until(() => !BS_READING.isOpen() && Shelf.getMode() === 'museum' && !document.querySelector('#musFind.on'), null, 20000);
    check('Reading corner: X there opens the store; Back returns to the museum', fromMus && fm.mode === 'museum' && musBack, `store ${fromMus} over ${fm.mode}, back ${musBack}`);
    // a comic archive (.cbz) opens as page pictures (unpacked natively); a PDF copied from the PC gets a drawn cover
    const comic = lib.find(i => i.type === 'arch');
    const cp = comic ? await page.evaluate(id => BS_READING._renderPage(id, 0), comic.id).catch(e => ({ err: e.message })) : { err: 'no comic' };
    const pc = lib.find(i => /GamePro/.test(i.title));
    const pcCover = pc ? await page.evaluate(async id => { const u = await window.boxshelf.libraryCover(id); return { u, drawn: __fakeReading.covers.some(c => c.drawn) }; }, pc.id) : {};
    check('Reading corner: a comic archive\'s pages open; a PDF from the PC gets a cover drawn from its first page', cp.type === 'images' && cp.w > 0 && !!pcCover.u && pcCover.drawn, JSON.stringify(cp) + ' ' + JSON.stringify(pcCover));
    check('Magazines & guides pass: no script errors', !errors.length, errors.slice(0, 3).join(' | '));
  } catch (e) { check('Magazines & guides pass ran to the end', false, e && e.stack ? e.stack.split('\n').slice(0, 2).join(' ') : e); }
  await ctx.close();
};
