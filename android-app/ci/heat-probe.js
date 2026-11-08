// Heat / efficiency probe (a developer tool, not part of the GitHub build): how much work each screen does while
// nobody touches anything. Opens the pretend Thor (?fakeNative=1, with the bottom page in its preview frame and a
// controller plugged in, like the built-in pad), leaves each place idle, then reads perf-meter.js on both screens.
// It draws in software, so compare the counts (callbacks, draw calls, idle frames, animations), not the timings.
// Usage: node ci/heat-probe.js <www dir> [out.json]
'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const WWW = path.resolve(process.argv[2] || 'www'), OUTF = process.argv[3];
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.glb': 'model/gltf-binary', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };
const server = http.createServer((q, r) => { const u = decodeURIComponent(q.url.split('?')[0]), p = path.join(WWW, u === '/' ? 'index.html' : u);
  if (!p.startsWith(WWW)) { r.writeHead(403); return r.end(); }
  fs.readFile(p, (e, d) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' }); r.end(d); }); });
// the Thor's own controller is always there: a pad that's connected but untouched
const PAD = `(() => { const pad = { id: 'Thor pad', index: 0, connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0],
  buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })) };
  Navigator.prototype.getGamepads = function () { return [pad, null, null, null]; }; })();`;

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/index.html?fakeNative=1`;
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const res = {};
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 810 }, deviceScaleFactor: 1, hasTouch: true });
    ctx.setDefaultTimeout(120000); await ctx.addInitScript({ content: PAD });
    const page = await ctx.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(base); await page.waitForTimeout(4000);
    await page.evaluate(async () => { const api = window.boxshelf, c = (await api.getConfig()).config, det = await api.detect();
      const d = [await api.pick({ kind: 'folder' }), await api.pick({ kind: 'folder' })];
      c.systems.gc.romDirs = [d[0]]; c.systems.gc.emulator = det.systems.gc.emulator; c.systems.psx.romDirs = [d[1]]; c.systems.psx.emulator = det.systems.psx.emulator;
      c.setupDone = true; await api.saveConfig(c); await api.scan(); });
    await page.goto(base + '&bottomPreview=1'); await page.bringToFront(); await page.waitForTimeout(7000);
    const bottom = () => page.frames().find(f => /bottom\.html/.test(f.url()));
    // idle long enough for the meter (and any idle pause) to count it as idle, then measure a quiet stretch
    async function measure(name, settle = 6000, secs = 4000) {
      await page.waitForTimeout(settle);
      await page.evaluate(() => window.BS_METER && BS_METER.reset()); const fr = bottom(); if (fr) await fr.evaluate(() => window.BS_METER && BS_METER.reset()).catch(() => {});
      await page.waitForTimeout(secs);
      const top = await page.evaluate(() => window.BS_METER ? BS_METER.snap(true) : null);
      const bot = fr ? await fr.evaluate(() => window.BS_METER ? BS_METER.snap(true) : null).catch(() => null) : null;
      // who asks for the frames (with TRACE=1): the first line of each caller's stack outside this probe
      if (process.env.TRACE) top.who = await page.evaluate(() => new Promise(done => { const seen = {}, r = window.requestAnimationFrame;
        window.requestAnimationFrame = function (fn) { const s = (new Error().stack || '').split('\n').slice(2, 4).map(l => l.trim().replace(/^at /, '').replace(/https?:\/\/[^/]+\//, '')).join(' < '); seen[s] = (seen[s] || 0) + 1; return r.call(this, fn); };
        setTimeout(() => { window.requestAnimationFrame = r; done(seen); }, 500); }));
      res[name] = { mode: await page.evaluate(() => Shelf.getMode()), top, bottom: bot };
      console.log(name.padEnd(12), JSON.stringify(res[name]));
    }
    await measure('shelf');
    await page.evaluate(() => Shelf.quickMenu()); await measure('quickmenu');
    await page.keyboard.press('Escape'); await page.waitForTimeout(800);
    await page.evaluate(() => Shelf.quickMenu()); await page.waitForTimeout(700);
    await page.evaluate(() => { const r = [...document.querySelectorAll('#quickMenu .qm-row')].find(e => /Art Studio/.test(e.textContent)); if (r) r.click(); });
    await measure('artstudio');
    for (let i = 0; i < 4 && await page.evaluate(() => Shelf.getMode() !== 'browse' || !!(window.BS_STUDIO && BS_STUDIO.isOpen())); i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(900); }
    await page.keyboard.press('m'); await page.waitForTimeout(5000);
    await page.evaluate(async () => { const w = ms => new Promise(r => setTimeout(r, ms)); for (let i = 0; i < 6 && window.Museum && Museum._dv && Museum._dv(); i++) { Museum.skipDelivery(); await w(800); } });
    await measure('museum', 10000);
    res.errors = errors.slice(0, 5);
    if (errors.length) console.log('errors:', errors.slice(0, 5).join(' | '));
    await ctx.close();
  } finally { await browser.close(); server.close(); if (OUTF) fs.writeFileSync(OUTF, JSON.stringify(res, null, 1)); }
});
