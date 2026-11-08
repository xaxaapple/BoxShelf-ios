// Device test pass "menu music" (1.75, sound.js), run by web-device-test.js. Checks results, never speed or how it sounds.
//   Windows (the demo page as Windows): the shelf plays the Drift track by default (1.77: Drift / Night / Glow, ambient); each track renders offline (seeded) with
//   sound in it, no clipping and quieter than the limiter; the quick menu's Customize has Menu music and Music volume chips
//   that switch, stop and save it; Settings → Sound has the two rows and no ambient rows left.
//   Android (the pretend Thor): the music plays on the shelf, and the quick menu's Sounds row holds the music chips.
'use strict';
const path = require('path');

// the quick menu's chips for a row (opened, read, closed again); act: [[k, v], ...] chosen in turn, with what followed
const QM = async ({ row, act }) => { const w = ms => new Promise(r => setTimeout(r, ms)), out = { steps: [] };
  const esc = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  Shelf.quickMenu(); for (let i = 0; i < 30 && !Shelf._qs().open; i++) await w(150); await w(400);
  const r = [...document.querySelectorAll('#quickMenu .qm-row')].find(e => new RegExp(row).test(e.textContent)); if (r) r.click();
  for (let i = 0; i < 30 && !document.querySelector('#quickMenu .qm-opt[data-k="music"]'); i++) await w(150); await w(300);
  const chips = k => [...document.querySelectorAll(`#quickMenu .qm-opt[data-k="${k}"]`)].map(b => b.dataset.v);
  out.music = chips('music'); out.mvol = chips('mvol');
  for (const [k, v] of act || []) {
    // (a click on a chip moves the highlight to it first, then chooses it)
    for (let i = 0; i < 3; i++) { const b = document.querySelector(`#quickMenu .qm-opt[data-k="${k}"][data-v="${v}"]`); if (!b) break; b.click(); await w(350);
      const m = Sound.music(); if (k === 'music' ? (v === 'off' ? !m : m && m.track === v) : m && Math.abs(m.level - +v) < .01) break; }
    await w(900); // (the quick menu saves half a second after a change)
    const ui = (await window.boxshelf.getConfig()).config.ui;
    out.steps.push({ k, v, now: Sound.music(), saved: k === 'music' ? ui.music : ui.musicLevel, mvolShown: chips('mvol').length });
  }
  for (let i = 0; i < 4 && Shelf._qs().open; i++) { esc(); await w(500); }
  return out; };

module.exports = async function musicPass({ browser, base, check, newPage, OUT }) {
  // ---------- Windows: the demo page as Windows ----------
  { const { ctx, page, errors } = await newPage(browser, null);
    try {
      await page.goto(base + '?platform=windows&shelf=1');
      await page.waitForFunction(() => window.Shelf && Shelf._qs && Shelf._qs().g && window.Sound && Sound.music, null, { timeout: 90000, polling: 250 });
      const start = await page.waitForFunction(() => Sound.music(), null, { timeout: 20000, polling: 250 }).then(h => h.jsonValue(), () => null);
      check('Music (Windows): the shelf plays the Drift track by default (Soft, 40%)', !!start && start.track === 'drift' && Math.abs(start.level - .4) < .01, JSON.stringify(start));

      // each track, rendered offline with a fixed seed: sound in it, under the limiter, no broken samples, three different pieces
      const r = await page.evaluate(async () => { const out = {};
        for (const [id] of Sound.tracks) { const b = await Sound.renderMusic(id, 16, 3); let pk = 0, ss = 0, n = 0, bad = 0, sig = 0;
          for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (!isFinite(d[i])) bad++; else { if (a > pk) pk = a; ss += d[i] * d[i]; n++; } } }
          const d0 = b.getChannelData(0); for (let i = 0; i < d0.length; i += 997) sig = (sig * 31 + Math.round(d0[i] * 1e4)) | 0;
          out[id] = { peakDb: +(20 * Math.log10(pk || 1e-9)).toFixed(1), rmsDb: +(10 * Math.log10(ss / Math.max(1, n) || 1e-12)).toFixed(1), bad, sig }; }
        return out; });
      const ids = Object.keys(r), sigs = new Set(ids.map(id => r[id].sig));
      check('Music: Drift, Night and Glow each render with sound in them, quiet (peaks under -24 dB), no broken samples, all different',
        ids.join() === 'drift,night,glow' && ids.every(id => r[id].bad === 0 && r[id].rmsDb > -55 && r[id].peakDb < -24) && sigs.size === 3, JSON.stringify(r));

      // the quick menu: chips, switching, Off (stops it, hides the volume chips), back on, volume; each saved
      const q = await page.evaluate(QM, { row: 'Customize', act: [['music', 'night'], ['music', 'off'], ['music', 'glow'], ['mvol', '0.7']] });
      const [a, b, c, d] = q.steps;
      check('Music (Windows): the quick menu\'s Customize offers Menu music (Drift, Night, Glow, Off) and Music volume (Quiet, Soft, Full)',
        q.music.join() === 'drift,night,glow,off' && q.mvol.join() === '0.2,0.4,0.7', `${q.music.join()} · ${q.mvol.join()}`);
      check('Music (Windows): choosing a track switches it, Off stops it (and hides the volume), the volume applies; each is saved',
        !!(a && a.now && a.now.track === 'night' && a.saved === 'night' && b && !b.now && b.saved === 'off' && b.mvolShown === 0 && c && c.now && c.now.track === 'glow' && c.saved === 'glow'
          && d && d.now && Math.abs(d.now.level - .7) < .01 && d.saved === .7), JSON.stringify(q.steps).slice(0, 400));

      // Settings → Sound
      const rows = await page.evaluate(async () => { const w = ms => new Promise(r => setTimeout(r, ms)); Setup.open({ page: 'sound' });
        for (let i = 0; i < 40 && !document.querySelector('#bss.on .bss-row'); i++) await w(150); await w(600);
        const t = [...document.querySelectorAll('#bss .bss-row')].map(r => r.textContent.replace(/\s+/g, ' ').trim());
        if (window.Settings && Settings.isOpen && Settings.isOpen()) { await Settings.close(); await w(800); } return t; });
      check('Music (Windows): Settings → Sound has Menu music and Music volume, and no ambient rows', rows.some(t => /^Menu music/.test(t)) && rows.some(t => /^Music volume/.test(t)) && !rows.some(t => /Ambient/i.test(t)), rows.join(' | ').slice(0, 300));
      await page.screenshot({ path: path.join(OUT, 'music-windows.png') });
      check('Music pass (Windows page): no script errors', !errors.length, errors.slice(0, 3).join(' | '));
    } catch (e) { check('Music pass (Windows page) ran to the end', false, e && e.stack ? e.stack.split('\n').slice(0, 2).join(' ') : e); }
    await ctx.close(); }

  // ---------- Android: the pretend Thor ----------
  { const { ctx, page, errors } = await newPage(browser, null);
    try {
      const url = base + '?fakeNative=1';
      await page.goto(url); await page.waitForTimeout(4000);
      await page.evaluate(async () => { const api = window.boxshelf, c = (await api.getConfig()).config, det = await api.detect();
        const d = await api.pick({ kind: 'folder' }); c.systems.gc.romDirs = [d]; c.systems.gc.emulator = det.systems.gc.emulator;
        c.setupDone = true; await api.saveConfig(c); await api.scan(); });
      await page.goto(url);
      await page.waitForFunction(() => window.Shelf && Shelf._qs && Shelf._qs().g && window.Sound && Sound.music, null, { timeout: 90000, polling: 250 });
      const start = await page.waitForFunction(() => Sound.music(), null, { timeout: 20000, polling: 250 }).then(h => h.jsonValue(), () => null);
      check('Music (Android): the shelf plays the Drift track by default', !!start && start.track === 'drift', JSON.stringify(start));
      const q = await page.evaluate(QM, { row: 'Sounds', act: [['music', 'off'], ['music', 'drift']] });
      check('Music (Android): the quick menu\'s Sounds row holds the music chips; Off stops it, Drift brings it back',
        q.music.join() === 'drift,night,glow,off' && q.steps.length === 2 && !q.steps[0].now && q.steps[1].now && q.steps[1].now.track === 'drift', JSON.stringify(q).slice(0, 300));
      check('Music pass (Android): no script errors', !errors.length, errors.slice(0, 3).join(' | '));
    } catch (e) { check('Music pass (Android) ran to the end', false, e && e.stack ? e.stack.split('\n').slice(0, 2).join(' ') : e); }
    await ctx.close(); }
};
