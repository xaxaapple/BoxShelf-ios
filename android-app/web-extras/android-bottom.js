// Boxshelf on Android: the AYN Thor's bottom screen, main-page side. The bottom page itself is bottom.html, shown on the
// second display by BottomScreen.java. This file sends it the game the shelf has settled on and runs what its touch
// buttons ask for (play, favourite, inspect, manual, shuffle, previous / next…). In the museum it sends the row on the
// wall instead (Shelf.bottomMuseum), and the bottom page's touches choose a case there or unwrap it (mpick / unwrap).
// Costs the shelf next to nothing: one small message after it has rested on a game for a moment (app.js's "bs-select",
// never per slide frame), built in a quiet moment; on a device without a second screen it does nothing at all.
(function () {
  const N = window.BS_NATIVE, api = window.boxshelf;
  if (!N || !N.bottomStatus || !api) return; // not on a device (or a pretend one)
  const log = (...m) => { try { console.log('[boxshelf] bottom:', ...m); } catch {} };
  let st = { available: false, enabled: false, shown: false }, last = '', busy = false, again = false;
  const refresh = () => N.bottomStatus().then(s => { st = Object.assign({}, st, s || {}); return st; }).catch(() => st);

  // Settings → Display → Bottom screen
  api.bottomScreen = {
    available: () => !!st.available,
    status: () => Object.assign({}, st),
    set: on => (on ? N.bottomShow({ remember: true }) : N.bottomHide({ remember: true })).then(refresh).then(() => { if (on) sendSoon(true); })
  };

  // Not through requestIdleCallback: perf.js holds idle jobs until the shelf has been still for 1.5 s, and the bottom
  // screen lagging that far behind felt broken. "bs-select" already waits until the shelf has rested for a moment, and
  // the message is small (no layout or drawing on this page); the bottom page then draws on its own screen.
  function sendSoon(force) { if (force) last = ''; setTimeout(() => send(force), 0); }
  async function send(force) {
    if (!st.available || !st.enabled) return;
    if (busy) { again = true; return; }
    busy = true;
    try {
      const S = window.Shelf; if (!S || !S.bottomInfo) return;
      if (window.BS_STUDIO && BS_STUDIO.isOpen()) { last = ''; if (force) BS_STUDIO.resend(); return; } // the Art Studio has the bottom screen (sent again when it closes)
      // in the museum: the row on the wall and its chosen case (the bottom screen becomes the museum's companion)
      const mus = S.bottomMuseum ? await S.bottomMuseum() : null;
      let msg;
      if (mus) {
        for (const x of mus.games) x.cover = x.cover ? await one(String(x.cover)) : null;
        if (mus.game) mus.game.art = await portable(mus.game.art || {});
        msg = Object.assign({ type: 'museum' }, mus);
      } else {
        const g = await S.bottomInfo();
        if (g) g.art = await portable(g.art || {});
        msg = { type: 'game', game: g };
      }
      const sig = JSON.stringify(msg);
      if (sig === last) return; // nothing new (the same game settled on again)
      last = sig;
      await N.bottomPost({ msg });
    } catch (e) { log('send failed', e && e.message); }
    finally { busy = false; if (again) { again = false; sendSoon(); } }
  }

  // Picture addresses the bottom page can open too: a cover made on the spot lives in a blob: URL that belongs to this
  // page only, so it travels as a data: URL instead (a few recent ones kept); relative paths become full ones.
  const conv = new Map();
  async function portable(art) {
    const out = {};
    for (const k of Object.keys(art)) out[k] = art[k] ? await one(String(art[k])) : null;
    return out;
  }
  async function one(u) {
    if (/^blob:/.test(u)) {
      if (conv.has(u)) return conv.get(u);
      try {
        const b = await (await fetch(u)).blob();
        const d = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); });
        conv.set(u, d); if (conv.size > 64) conv.delete(conv.keys().next().value);
        return d;
      } catch { return null; }
    }
    if (/^(data:|https?:)/i.test(u)) return u;
    try { return new URL(u, location.href).href; } catch { return null; }
  }

  // The handheld Art Studio (android-studio.js): while it's up the bottom screen shows the game's case only, with the
  // version under the cursor put in. Its messages go one after another (a newer one never overtakes an older one whose
  // pictures are still being made portable); closing it gives the bottom screen back to the shelf's game.
  let sq = Promise.resolve();
  window.BS_BOTTOM_STUDIO = {
    on: () => !!(st.available && st.enabled),
    post: m => { sq = sq.then(async () => {
      try {
        if (m.art) m.art = await portable(m.art);
        if (m.game) m.game = Object.assign({}, m.game, { art: await portable(m.game.art || {}) });
        await N.bottomPost({ msg: Object.assign({ type: 'studio' }, m) });
      } catch (e) { log('studio send failed', e && e.message); }
      if (!m.open) sendSoon(true);
    }); }
  };

  // what the bottom screen's buttons ask for
  // (mpick / unwrap / mrow / mact / mback / mturn / mzoom / room: the museum companion; art / bsettings: the quick ways in)
  // (museum / settings: shortcuts the bottom screen's Shortcuts tab can be given, 0.3.2)
  const CMDS = /^(play|fav|details|inspect|manual|shuffle|prev|next|ach|menu|mpick|unwrap|mrow|mact|mback|mturn|mzoom|room|art|bsettings|museum|settings)$/;
  // what may come with a command: a number (a case on the row, a step), a turn ({ dx, dy }) or a room choice ({ key, val })
  function argOf(a) {
    if (a == null) return null;
    if (typeof a === 'object') { const o = {}; for (const k of ['dx', 'dy', 'key', 'val']) if (k in a && /^(number|string|boolean)$/.test(typeof a[k])) o[k] = a[k]; return o; }
    return +a;
  }
  function run(c, arg) {
    const S = window.Shelf; if (!S || !S.bottomCmd || !CMDS.test(c)) return;
    let r; try { r = S.bottomCmd(c, arg); } catch (e) { log('command', c, e && e.message); }
    if (c === 'fav' || c === 'unwrap' || c === 'room') Promise.resolve(r).then(() => sendSoon(true), () => sendSoon(true)); // the heart (the room) shows what was really saved
  }
  const listen = (ev, fn) => Promise.resolve().then(() => N.addListener(ev, fn)).catch(e => log(ev + ' listener', e && e.message));
  listen('bottom', e => {
    let m; try { m = JSON.parse(e && e.msg); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (m.type === 'ready') refresh().then(() => sendSoon(true)); // a fresh bottom page (first start, or rebuilt): tell it everything
    else if (m.type === 'cmd' && (m.cmd === 'scOpts' || m.cmd === 'scRun')) shortcut(m.cmd, String(m.arg == null ? '' : m.arg).slice(0, 300));
    else if (m.type === 'cmd') run(String(m.cmd || ''), argOf(m.arg));
  });
  // (0.3.5) the Shortcuts tab's own buttons: an app on the device, a console's shelf, a favourite game. scOpts: the choices
  // for one kind, sent back to the bottom page; scRun: one of them pressed
  async function shortcut(c, arg) {
    const S = window.Shelf; if (!S) return;
    if (c === 'scRun') { try { if (S.bottomShortcut) S.bottomShortcut(arg); } catch (e) { log('shortcut', e && e.message); } return; }
    let items = []; try { items = S.shortcutOptions ? await S.shortcutOptions(arg) : []; } catch (e) { log('shortcut options', e && e.message); }
    try { await N.bottomPost({ msg: { type: 'scOpts', kind: arg, items: (items || []).slice(0, 120) } }); } catch (e) { log('shortcut options send', e && e.message); }
  }
  listen('bottomChange', () => refresh());
  addEventListener('bs-select', () => sendSoon());
  // (0.3.2) another theme on the top screen: the bottom screen follows (the body's theme-* class; other class changes cost a string compare)
  const themeNow = () => (/(?:^|\s)theme-([\w-]+)/.exec(document.body.className) || [])[1] || '';
  let theme0 = themeNow();
  try { new MutationObserver(() => { const t = themeNow(); if (t !== theme0) { theme0 = t; sendSoon(true); } }).observe(document.body, { attributes: true, attributeFilter: ['class'] }); } catch {}
  refresh().then(s => { log('status', JSON.stringify(s)); if (s.available) sendSoon(true); });
})();
