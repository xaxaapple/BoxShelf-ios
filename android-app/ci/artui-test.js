// Device test pass "box art screens" (1.80), run by web-device-test.js. Checks results, never speed. The demo page as Windows:
//   Settings → Box art & manuals opens with Art Studio first and a cover summary in its heading; a console's games grid has the
//   No cover filter, part pictures with a mark (✓ ! × •) instead of letters, a key in the console's own word for the disc (UMD
//   on PSP) and the strip under the grid naming the highlighted game; a game's page has its parts as tabs across the top,
//   left / right move along them, down goes into the versions, and trying another version shows "Trying" with the
//   picture in use now beside it.
'use strict';
const path = require('path');

module.exports = async function artUiPass({ browser, base, check, newPage, OUT }) {
  // ---------- (beta.9) node side: Repair's cover, Manual Studio's Earlier copies (main/manuals.js, main/manualstudio.js) ----------
  { const fs = require('fs'), os = require('os'), ROOT = path.join(__dirname, '..', '..'), M = require(path.join(ROOT, 'main', 'manuals')), S = require(path.join(ROOT, 'main', 'manualstudio'));
    const png = (w, h, pad) => { const b = Buffer.alloc(33 + (pad || 0)); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };
    try {
      // Repair: a manual with a thumbnail among upright inside pages gets the box front first on the first go; a second Repair
      // changes nothing; Wii U never gets it (its e-manual opens on the box front by itself)
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-rep-')), b = 'Game (USA)', front = path.join(dir, 'front.png'); fs.writeFileSync(front, png(800, 1100, 500));
      fs.writeFileSync(path.join(dir, `${b}-manual-01.png`), png(1000, 1400, 100)); fs.writeFileSync(path.join(dir, `${b}-manual-02.png`), png(120, 160, 10)); fs.writeFileSync(path.join(dir, `${b}-manual-03.png`), png(1000, 1400, 200));
      const g = { file: path.join(dir, b + '.iso'), title: 'Game' }, r1 = await M.repairInPlace({ artDir: dir }, g, { front, sysId: 'gc' }), p1 = M.manualPages(dir, b);
      const first = p1.length && fs.statSync(path.join(dir, p1[0])).size === fs.statSync(front).size, r2 = await M.repairInPlace({ artDir: dir }, g, { front, sysId: 'gc' });
      const wd = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-rep-')); fs.writeFileSync(path.join(wd, `${b}-manual-01.png`), png(688, 1000, 50)); const rw = await M.repairInPlace({ artDir: wd }, g, { front, sysId: 'wiiu' });
      check('Manuals: one Repair takes thumbnails out and puts the box front first (it used to take two); a second Repair adds no second cover; Wii U never gets one',
        r1.changed && /thumbnail/.test(r1.what) && /box front/.test(r1.what) && first && p1.length === 3 && !r2.changed && !/box front/.test(rw.what || ''), JSON.stringify({ r1, r2, rw }));
      fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(wd, { recursive: true, force: true });
      // Manual Studio: identical earlier copies are listed once (none matching the one in use), and putting one back swaps them
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-ms-')), cd = path.join(tmp, 'covers'); fs.mkdirSync(cd);
      S.init({ dataDir: path.join(tmp, 'data'), log: () => {}, send: () => {}, changed: () => {}, fileUrl: f => 'bsfile:///' + f });
      const put = (d, tag, n) => { fs.mkdirSync(d, { recursive: true }); for (let i = 1; i <= n; i++) fs.writeFileSync(path.join(d, `${b}-manual-${String(i).padStart(2, '0')}.jpg`), Buffer.alloc(1000 + i * 10, tag)); };
      // (the made-up copies are dated 2020, so the backups Boxshelf makes now are always the newest: the order, and so which
      // of two identical copies is listed, never depends on today's date. It did: "2026-11-07T…" sorts after "2026-11-06_…")
      const orig = path.join(cd, '.manual-originals', b); put(cd, 'A', 3); ['10', '11', '12'].forEach(h => put(path.join(orig, `2020-01-01_${h}-00-00`), 'B', 4)); put(path.join(orig, '2020-01-01_13-00-00'), 'A', 3);
      const mg = { sysId: 'gc', key: 'gc|' + path.join(cd, b + '.iso').toLowerCase(), dir: cd, home: cd, base: b, game: { file: path.join(cd, b + '.iso'), title: 'Game' } };
      const inUse = () => fs.readdirSync(cd).filter(f => /-manual-\d+\.jpg$/.test(f)).length, e1 = S._t.earlierCands(mg);
      await S._t.apply(mg, e1[0]); const e2 = S._t.earlierCands(mg), u2 = inUse(); await S._t.apply(mg, e2[0]); const e3 = S._t.earlierCands(mg), u3 = inUse(), h = S._t.db().hist[mg.key] || [];
      check('Manual Studio: three copies of the same earlier manual show once; putting it back swaps it with the one in use, back and forth, without the list growing; Undo still works',
        // (the second swap puts back the copy the first one kept, so that step leaves Undo: one step of Undo is left)
        e1.length === 1 && e1[0].pages === 4 && u2 === 4 && e2.length === 1 && e2[0].pages === 3 && u3 === 3 && e3.length === 1 && h.length === 1 && h.every(x => x.dir && fs.existsSync(x.dir)),
        JSON.stringify({ e1: e1.length, u2, e2: e2.length, u3, e3: e3.length, hist: h.length }));
      S._t.reset(); fs.rmSync(tmp, { recursive: true, force: true });
    } catch (e) { check('Manuals node side ran to the end', false, e && e.stack ? e.stack.split('\n').slice(0, 2).join(' ') : e); } }

  const { ctx, page, errors } = await newPage(browser, null);
  try {
    await page.goto(base + '?platform=windows&shelf=1');
    await page.waitForFunction(() => window.Shelf && Shelf._qs && Shelf._qs().g && window.Setup, null, { timeout: 90000, polling: 250 });
    await page.waitForTimeout(1500);

    // the Box art page
    const pg = await page.evaluate(async () => { const w = ms => new Promise(r => setTimeout(r, ms));
      Setup.open({ page: 'art' }); for (let i = 0; i < 40 && !document.querySelector('#bss.on .bss-row'); i++) await w(150);
      let head = ''; for (let i = 0; i < 30; i++) { await w(200); const h = document.querySelector('#bss .bss-head em'); head = h ? h.textContent : ''; if (/cover/.test(head)) break; }
      const rows = [...document.querySelectorAll('#bss .bss-row .nm')].map(e => e.textContent);
      return { title: document.querySelector('#bss .bss-title').textContent, head, first: rows[0], rows }; });
    check('Box art (Windows): the page is "Box art & manuals", Art Studio is its first row, and its heading sums up the covers',
      pg.title === 'Box art & manuals' && pg.first === 'Art Studio' && /games have a cover/.test(pg.head) && pg.rows.includes('Download missing art now'), JSON.stringify(pg).slice(0, 300));

    // PSP's games grid
    const gr = await page.evaluate(async () => { const w = ms => new Promise(r => setTimeout(r, ms));
      if (window.Settings && Settings.isOpen && Settings.isOpen()) { await Settings.close(); await w(900); } // (Setup.open does nothing while Settings is open)
      Setup.open({ page: 'artstudio', systemId: 'psp' }); for (let i = 0; i < 40 && !document.querySelector('.bsa-tile'); i++) await w(200); await w(600);
      const pills = [...document.querySelectorAll('.bsa-pill')].map(p => p.textContent.replace(/\s+/g, ' ').trim());
      const t = document.querySelector('.bsa-tile'), sl = t ? [...t.querySelectorAll('.sl')] : [];
      return { pills, key: document.querySelector('.bsa-legend .pk') ? document.querySelector('.bsa-legend .pk').textContent : '', icons: sl.filter(s => s.querySelector('svg')).length,
        marks: sl.map(s => (s.querySelector('b') || {}).textContent).join(''), strip: (document.querySelector('.bsa-gi') || {}).textContent || '' }; });
    check('Box art (Windows): the games grid has a No cover filter, part pictures with marks (not letters), the UMD named on PSP, and the highlighted game in the strip',
      gr.pills.some(p => /^No cover/.test(p)) && /UMD/.test(gr.key) && gr.icons === 4 && /^[✓!×•]{4}$/.test(gr.marks) && /Front .* · Back .* · Spine .* · UMD /.test(gr.strip), JSON.stringify(gr).slice(0, 400));

    // a GameCube game's page
    const gp = await page.evaluate(async () => { const w = ms => new Promise(r => setTimeout(r, ms)), out = {};
      const key = k => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
      if (window.Settings && Settings.isOpen && Settings.isOpen()) { await Settings.close(); await w(900); }
      const g = (await window.boxshelf.artGames({ systemId: 'gc' }))[0];
      Setup.open({ page: 'artgame', systemId: 'gc', file: g.file, title: g.title });
      for (let i = 0; i < 50 && document.querySelectorAll('.bsa-card').length < 3; i++) await w(200); await w(800);
      const pk = document.querySelector('.bsa-pk'), parts = document.querySelector('.bsa-parts');
      out.tabs = !!(pk && pk.classList.contains('ptabs')) && !!parts && parts.getBoundingClientRect().height < 120 && parts.getBoundingClientRect().width > 600;
      out.round = pk ? getComputedStyle(pk).borderRadius : '';
      const h3 = () => document.querySelector('.bsa-ch h3').textContent;
      // (each step waits until the page shows it, up to 5 s: a slow machine drawing in software takes longer than a fixed wait)
      const until = async (ok, ms = 5000) => { for (let t = 0; t < ms && !ok(); t += 100) await w(100); await w(150); };
      out.start = h3(); key('ArrowRight'); await until(() => h3() !== out.start); out.right = h3(); key('ArrowLeft'); await until(() => h3() === out.start);
      key('ArrowDown'); await until(() => !pk.classList.contains('inparts')); out.inCards = !pk.classList.contains('inparts');
      out.badge = [...document.querySelectorAll('.bsa-card .use.on')].map(u => u.textContent).join(',');
      const kk = () => (document.querySelector('.bsa-pv .k') || {}).textContent || '';
      key('ArrowRight'); await until(() => /^Trying/.test(kk())); out.k = kk(); out.now = document.querySelector('.bsa-now').classList.contains('on');
      key('ArrowUp'); await until(() => pk.classList.contains('inparts')); out.backUp = pk.classList.contains('inparts');
      return out; });
    await page.screenshot({ path: path.join(OUT, 'art-game-page.png') });
    check('Box art (Windows): a game\'s page has the parts as tabs across the top; right / left change part, down goes into the versions, up comes back',
      gp.tabs && gp.round === '0px' && gp.start === 'Front cover' && gp.right === 'Back cover' && gp.inCards && gp.backUp, JSON.stringify(gp).slice(0, 400));
    check('Box art (Windows): the version in use is badged; trying another says "Trying" and shows the picture in use now beside it',
      /In use/.test(gp.badge) && /^Trying/.test(gp.k) && gp.now, JSON.stringify(gp).slice(0, 400));
    // (beta.9) no SteamGridDB key: the Front has an "Add SteamGridDB" slot; it opens that account's page, Esc comes back to the
    // same game's Front, and the Back has no slot (SteamGridDB has only fronts)
    const sg = await page.evaluate(async () => { const w = ms => new Promise(r => setTimeout(r, ms)), out = {};
      const key = k => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
      const until = async (ok, ms = 5000) => { for (let t = 0; t < ms && !ok(); t += 100) await w(100); await w(150); };
      const h3 = () => (document.querySelector('.bsa-ch h3') || {}).textContent || '';
      const slot = () => [...document.querySelectorAll('.bsa-card')].find(d => d.querySelector('.in.acct'));
      await until(() => h3() === 'Front cover' && !!slot());
      const s = slot(); out.label = s ? s.querySelector('.ed').textContent : '';
      if (s) s.click();
      const crumb = () => (document.querySelector('#bss .bss-crumb') || {}).textContent || '';
      await until(() => /SteamGridDB/.test(crumb())); out.crumb = crumb();
      out.foot = (document.querySelector('#bss .bss-hints') || {}).textContent || '';
      key('Escape'); await until(() => h3() === 'Front cover' && !!slot()); out.back = h3(); out.slotAgain = !!slot();
      const backTab = document.querySelector('.bsa-part[data-r="1"]'); if (backTab) backTab.click(); // (the Back tab, by mouse)
      await until(() => h3() === 'Back cover' && document.querySelectorAll('.bsa-card').length > 1);
      out.backTab = h3(); out.backSlot = !!slot();
      return out; });
    check('Box art (Windows): without a SteamGridDB key the Front has an "Add SteamGridDB" slot that opens its account page and comes back (none on the Back)',
      sg.label === 'Add SteamGridDB' && /Accounts & services\s+›\s+SteamGridDB/.test(sg.crumb) && /Art Studio/.test(sg.foot) && sg.back === 'Front cover' && sg.slotAgain && sg.backTab === 'Back cover' && !sg.backSlot, JSON.stringify(sg).slice(0, 400));
    // (beta.9) Settings → Get manuals → Check my manuals: a step per console with what's been looked at so far, then the result
    const mc = await page.evaluate(async () => { const w = ms => new Promise(r => setTimeout(r, ms)), out = { seen: [] };
      if (window.Settings && Settings.isOpen && Settings.isOpen()) { await Settings.close(); await w(900); }
      Setup.open({ page: 'man-get' }); const find = re => [...document.querySelectorAll('#bss .bss-row')].find(r => re.test(r.textContent));
      for (let i = 0; i < 40 && !find(/Check my manuals/); i++) await w(200);
      const b = find(/Check my manuals/); out.row = !!b; if (b) b.click(); await w(300); if (b && !/Checking your manuals/.test(document.getElementById('bss').textContent)) { b.click(); }
      const txt = () => document.getElementById('bss').textContent.replace(/\s+/g, ' ');
      for (let i = 0; i < 60 && !/Manuals checked/.test(txt()); i++) { await w(100); const m = /Checking manuals · \w+ ?\d+ of \d+ consoles/.exec(txt()); if (m && out.seen[out.seen.length - 1] !== m[0]) out.seen.push(m[0]); }
      out.done = /Manuals checked/.test(txt()); out.line = (/✓ [^›]*/.exec(txt()) || [''])[0]; out.back = !!find(/Back to the list/);
      if (out.back) { find(/Back to the list/).click(); await w(800); } return out; });
    check('Get manuals (Windows): Check my manuals shows each console as it goes, then "Manuals checked" with what was looked at, replaced and made smaller',
      mc.row && mc.seen.length >= 2 && mc.done && /12 looked at · 2 replaced · 1 made smaller/.test(mc.line) && mc.back, JSON.stringify(mc).slice(0, 400));
    // Cancel: pressed as soon as it's running, it stops at the next step and says so (a second press on Check meanwhile is
    // turned away, it doesn't start a second check)
    const mx = await page.evaluate(async () => { const w = ms => new Promise(r => setTimeout(r, ms)), out = {};
      const find = re => [...document.querySelectorAll('#bss .bss-row')].find(r => re.test(r.textContent)), txt = () => document.getElementById('bss').textContent.replace(/\s+/g, ' ');
      for (let i = 0; i < 40 && !find(/Check my manuals/); i++) await w(200);
      const b = find(/Check my manuals/); if (!b) return out; b.click(); b.click(); // (two quick presses)
      for (let i = 0; i < 30 && !find(/^\s*Cancel/); i++) await w(100);
      const c = find(/^\s*Cancel/); out.cancelRow = !!c; if (c) c.click();
      for (let i = 0; i < 40 && !/Check stopped|Manuals checked/.test(txt()); i++) await w(100);
      out.stopped = /Check stopped/.test(txt()); out.finished = /Manuals checked/.test(txt()); out.err = /didn.t finish/.test(txt());
      const back = find(/Back to the list/); if (back) { back.click(); await w(600); } return out; });
    check('Get manuals (Windows): Cancel stops Check my manuals part way and says "Check stopped"; a second quick press doesn\'t start another check',
      mx.cancelRow && mx.stopped && !mx.finished && !mx.err, JSON.stringify(mx));
    // (beta.9) Art Studio → a game → Manual: choosing an earlier copy back and forth never grows the list, and one B goes
    // straight back to the game's art page (it took two, the first only moving to the Manual row)
    const ms = await page.evaluate(async () => { const w = ms => new Promise(r => setTimeout(r, ms)), out = { counts: [] };
      const key = k => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
      if (window.Settings && Settings.isOpen && Settings.isOpen()) { await Settings.close(); await w(900); }
      const g = (await window.boxshelf.artGames({ systemId: 'gc' }))[0]; Setup.open({ page: 'artgame', systemId: 'gc', file: g.file, title: g.title });
      await w(1500); for (let i = 0; i < 40 && !document.querySelector('.bsa-part.man'); i++) await w(200); // (the art page rebuilt first)
      const crumb0 = () => ((document.querySelector('#bss .bss-crumb') || {}).textContent || '');
      for (let i = 0; i < 5 && !/Manual/.test(crumb0()); i++) { const m = document.querySelector('.bsa-part.man'); if (m) m.click(); await w(800); }
      for (let i = 0; i < 40 && document.querySelectorAll('.bsa-card').length < 2; i++) await w(200); await w(600);
      const earlier = () => [...document.querySelectorAll('.bsa-card')].find(d => /Earlier/.test(d.textContent) && !/IN USE/i.test(d.textContent));
      // (this demo game starts without an earlier copy: picking another manual first puts the one in use under Earlier)
      if (!earlier()) { const other = [...document.querySelectorAll('.bsa-card')].find(d => !d.querySelector('.in.act') && !/IN USE/i.test(d.textContent)); if (other) { other.click(); await w(2200); } }
      out.counts.push(document.querySelectorAll('.bsa-card').length);
      for (let n = 0; n < 3; n++) { const c = earlier(); if (!c) { out.noEarlier = n; break; } c.click(); await w(2200); out.counts.push(document.querySelectorAll('.bsa-card').length); }
      const crumb = () => ((document.querySelector('#bss .bss-crumb') || {}).textContent || '').replace(/\s+/g, ' ');
      out.before = crumb(); key('Escape'); await w(900); out.after = crumb(); return out; });
    check('Manual Studio: choosing an earlier manual back and forth never adds cards; one B goes straight back to the game\'s art page',
      ms.counts.length >= 3 && ms.counts.every(n => n === ms.counts[0]) && /› Manual/.test(ms.before) && !/› Manual/.test(ms.after) && /Aether Drift|›/.test(ms.after), JSON.stringify(ms));
    check('Box art pass (Windows page): no script errors', !errors.length, errors.slice(0, 3).join(' | '));
  } catch (e) { check('Box art pass (Windows page) ran to the end', false, e && e.stack ? e.stack.split('\n').slice(0, 2).join(' ') : e); }
  await ctx.close();

  // (beta.9) the reader's Wrong game / Repair (Windows page): the message stays up and says what's happening (waiting for the
  // background pass, looking, the pages coming down), then a tick, and the reader opens again with the new pages
  { const sv = t => 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="600" height="800" fill="#2a3b6b"/><text x="40" y="120" font-size="60" fill="#fff">${t}</text></svg>`);
    const { ctx: c2, page: p, errors: e2 } = await newPage(browser, `window.__mockManual=${JSON.stringify([sv('Cover'), sv('Page 2'), sv('Page 3')])};`);
    try {
      await p.goto(base + '?platform=windows&shelf=1');
      await p.waitForFunction(() => window.Shelf && Shelf._qs && Shelf._qs().g && Shelf._lib, null, { timeout: 90000, polling: 250 }); await p.waitForTimeout(1500);
      const onGc = () => p.evaluate(() => /GameCube/.test((document.querySelector('#tabs .on') || {}).textContent || ''));
      for (let i = 0; i < 12 && !(await onGc()); i++) { await p.keyboard.press('ArrowUp'); await p.waitForTimeout(700); }
      // the first game on the shelf (it opens a step or two before it: Surprise me, the emulator) is given the pretend manual
      // pages (the demo library's own hook doesn't reach the shelf's copy)
      for (let i = 0; i < 8 && !(await p.evaluate(() => { const g = Shelf._lib.cur(); return !!g && g.kind === 'rom'; })); i++) { await p.keyboard.press('ArrowRight'); await p.waitForTimeout(600); }
      await p.evaluate(() => { const g = Shelf._lib.cur(); g.art = Object.assign({}, g.art || {}, { manual: window.__mockManual }); });
      const mode = m => p.waitForFunction(m => Shelf.getMode() === m, m, { timeout: 15000, polling: 100 }).then(() => true, () => false);
      await p.keyboard.press('v'); await mode('inspect'); await p.waitForTimeout(1500);
      await p.keyboard.press('Enter'); await p.waitForTimeout(1500);
      await p.keyboard.press('m'); await p.waitForFunction(() => document.getElementById('reader').classList.contains('on'), null, { timeout: 15000, polling: 100 }).catch(() => {});
      const run = k2 => p.evaluate(async k2 => { const w = ms => new Promise(r => setTimeout(r, ms)), t = document.getElementById('toast'), seen = [], key = k => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
        let lost = false; key('w'); await w(300); key(k2);
        for (let i = 0; i < 160 && !t.classList.contains('done'); i++) { await w(50); const s = t.textContent; if (s && seen[seen.length - 1] !== s) seen.push(s); if (!t.classList.contains('on')) lost = true; }
        await w(400); return { seen, done: t.classList.contains('done') ? t.textContent : '', lost, reader: document.getElementById('reader').classList.contains('on') }; }, k2);
      const wr = await run('w');
      check('Manuals (Windows): Wrong game keeps a message up that says what it\'s doing (waiting, looking, the pages coming down), then a tick, and the reader opens again with the new manual',
        wr.seen.some(s => /^Waiting for the background/.test(s)) && wr.seen.some(s => /^Looking for the right manual/.test(s)) && wr.seen.some(s => /Downloading the new manual · page \d of 3/.test(s)) && /^✓ New manual for /.test(wr.done) && !wr.lost && wr.reader, JSON.stringify(wr).slice(0, 500));
      await p.waitForTimeout(600);
      const rp = await run('r');
      check('Manuals (Windows): Repair keeps "Repairing the manual…" up until it\'s done, then a tick saying what changed, and the reader opens again',
        rp.seen.some(s => /^Repairing the manual/.test(s)) && /^✓ Manual repaired: /.test(rp.done) && !rp.lost && rp.reader, JSON.stringify(rp).slice(0, 500));
      check('Manual fixes pass (Windows page): no script errors', !e2.length, e2.slice(0, 3).join(' | '));
    } catch (e) { check('Manual fixes pass (Windows page) ran to the end', false, e && e.stack ? e.stack.split('\n').slice(0, 2).join(' ') : e); }
    await c2.close(); }
};
