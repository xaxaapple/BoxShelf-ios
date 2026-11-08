// Device test pass "screens" (Android 0.4.0), run by web-device-test.js. Checks results, never speed.
// The Android build on screens other than the Thor's (the adapter's pretend device, ?fakeNative=1): a 20:9 phone, a small
// phone and a 16:10 tablet, all landscape. On each: the shelf comes up with a game chosen, nothing spills sideways (no
// horizontal scroll), the console tabs and the chosen case are on screen, Settings fits, the test meter is off, and there
// are no script errors. A screenshot of each is kept (screens-<name>.png / -settings.png).
'use strict';
const path = require('path');

const SIZES = [
  { name: 'phone-20x9', width: 915, height: 412, dpr: 2.625 },  // a 2400×1080 phone
  { name: 'phone-small', width: 740, height: 360, dpr: 3 },     // a small 2220×1080 phone
  { name: 'tablet-16x10', width: 1280, height: 800, dpr: 2 },   // a 2560×1600 tablet
];

module.exports = async function screensPass({ browser, base, check, OUT }) {
  for (const sz of SIZES) {
    const ctx = await browser.newContext({ viewport: { width: sz.width, height: sz.height }, deviceScaleFactor: sz.dpr, isMobile: true, hasTouch: true });
    ctx.setDefaultTimeout(90000);
    const page = await ctx.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text().slice(0, 200)); });
    try {
      await page.goto(base + '?fakeNative=1'); await page.waitForTimeout(4000);
      // set up three consoles the way pass 2 does, then start again on a filled shelf
      await page.evaluate(async () => {
        const api = window.boxshelf, info = await api.getConfig(), det = await api.detect(), c = info.config;
        const dirs = [await api.pick({ kind: 'folder' }), await api.pick({ kind: 'folder' }), await api.pick({ kind: 'folder' })];
        c.systems.gc.romDirs = [dirs[0]]; c.systems.gc.emulator = det.systems.gc.emulator;
        c.systems.psx.romDirs = [dirs[1]]; c.systems.psx.emulator = det.systems.psx.emulator;
        c.systems.snes.romDirs = [dirs[2]]; c.systems.snes.emulator = det.systems.snes.emulator;
        c.setupDone = true; await api.saveConfig(c); await api.scan();
      });
      await page.reload();
      await page.waitForFunction(() => window.Shelf && Shelf._qs && Shelf._qs().g && Shelf.getMode() === 'browse', null, { timeout: 90000, polling: 250 });
      await page.waitForTimeout(2500);
      const r = await page.evaluate(() => {
        const vw = innerWidth, vh = innerHeight, box = e => { if (!e) return null; const b = e.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), b: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height) }; };
        const tabs = box(document.getElementById('tabs')), hud = document.getElementById('thorHud');
        // the chosen case: the slot nearest the middle of the screen
        const slots = [...document.querySelectorAll('#track > *')].map(box).filter(b => b && b.w > 0);
        const mid = slots.sort((a, b) => Math.abs((a.l + a.r) / 2 - vw / 2) - Math.abs((b.l + b.r) / 2 - vw / 2))[0] || null;
        return { vw, vh, scrollW: document.documentElement.scrollWidth, scrollH: document.documentElement.scrollHeight, tabs, mid, game: Shelf._qs().g,
          hud: hud ? getComputedStyle(hud).display : 'none' };
      });
      await page.screenshot({ path: path.join(OUT, `screens-${sz.name}.png`) }).catch(() => {});
      const fits = b => !!b && b.l >= -2 && b.r <= r.vw + 2 && b.t >= -2 && b.b <= r.vh + 2;
      check(`Screens (${sz.name} ${sz.width}×${sz.height}): the shelf comes up with a game chosen, nothing spills sideways, the tabs and the chosen case are on screen, the test meter is off`,
        !!r.game && r.scrollW <= r.vw + 1 && fits(r.tabs) && !!r.mid && r.mid.h > r.vh * 0.25 && r.mid.t >= -2 && r.mid.b <= r.vh + 2 && r.hud === 'none', JSON.stringify(r).slice(0, 500));
      // Settings fits the screen
      const s = await page.evaluate(async () => { const w = ms => new Promise(r => setTimeout(r, ms));
        Setup.open(); for (let i = 0; i < 40 && !document.querySelector('#bss.on .bss-row'); i++) await w(150); await w(900);
        const el = document.getElementById('bss'), b = el ? el.getBoundingClientRect() : null, rows = document.querySelectorAll('#bss .bss-row').length;
        return { open: !!(el && el.classList.contains('on')), rows, l: b && Math.round(b.left), r: b && Math.round(b.right), t: b && Math.round(b.top), b: b && Math.round(b.bottom), vw: innerWidth, vh: innerHeight, scrollW: document.documentElement.scrollWidth }; });
      await page.screenshot({ path: path.join(OUT, `screens-${sz.name}-settings.png`) }).catch(() => {});
      check(`Screens (${sz.name}): Settings opens and fits the screen`,
        s.open && s.rows >= 1 && s.l >= -2 && s.r <= s.vw + 2 && s.t >= -2 && s.b <= s.vh + 2 && s.scrollW <= s.vw + 1, JSON.stringify(s));
      await page.evaluate(async () => { if (window.Settings && Settings.isOpen && Settings.isOpen()) await Settings.close(); });
      check(`Screens (${sz.name}): no script errors`, !errors.length, errors.slice(0, 3).join(' | '));
    } catch (e) { check(`Screens (${sz.name}) ran to the end`, false, e && e.stack ? e.stack.split('\n').slice(0, 2).join(' ') : e); }
    await ctx.close();
  }
};
