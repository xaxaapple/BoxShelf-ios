/* Boxshelf on Android: the handheld Art Studio (added to the Android build only by copy-web.js; Windows keeps the
   Settings picker). One game's four pictures, laid out for a 6" screen held in two hands:
   - a big row per part (Front, Back, Spine, Disc), and above them (0.3.5) Sets: whole matching sets (USA / Europe / Japan
     / HD, all four parts from one release) and the looks (the sharpest of each part, or every part from one region). The
     row you're on is tall, with every version side by side and large; the others stay as a small strip, so you always
     see the whole case at once and which picture each part uses.
   - on the right (0.3.5), the full set: your case turned so its front and spine show, the disc out beside it, with the
     version (or the set) under the cursor put in; it turns to the back or the spine for those rows, the disc comes forward
     for the disc. Under it, what's under the cursor, big. The cursor itself is a solid white frame; the other versions
     in that row are dimmed.
   - the controller never gets lost: up / down (or L / R) change row, left / right move along the versions, A uses one,
     Y a picture of your own, X puts the part (on Sets: the whole case) back on the shelf style, B (or Start) is Done.
     Every row remembers its place.
   - touch works the same: tap a part or a version to look at it, tap it again (or Use this) to put it in; drag a row.
   - a screen of its own: once it has faded in, everything else on the page is skipped (body.bst-full: no styling, layout
     or drawing behind it) until it closes.
   - the bottom screen shows the game's case only, with the version under the cursor put in, turned to the part being
     edited (android-bottom.js / bottom.js 'studio' messages).
   app.js opens it (artStudioFor; the museum's Box art with o.onClose) and hands it the controller through window.BS_MODAL
   while it's up.
   Performance: built once, on first use. Moving the cursor or changing part changes transforms and a few classes only
   (each row's versions sit in one track that slides and scales on the compositor; the set turns by transform, no loop);
   pictures decode async. */
(function () {
  'use strict';
  // (this file is only in the Android build; it runs before platform.js, so the platform is checked when the studio opens)
  const A = () => window.boxshelf || {};
  const PARTS = ['front', 'back', 'spine', 'disc'], ROWS = ['sets', ...PARTS];
  const NAME = { sets: 'Sets', front: 'Front', back: 'Back', spine: 'Spine', disc: 'Disc' };
  const LONG = { sets: 'Whole case', front: 'Front cover', back: 'Back cover', spine: 'Spine', disc: 'Disc' };
  const SRC = { gametdb: 'GameTDB', launchbox: 'LaunchBox', screenscraper: 'ScreenScraper', libretro: 'Libretro', steamgrid: 'SteamGridDB', steamgriddb: 'SteamGridDB', igdb: 'IGDB', current: 'On your shelf', earlier: 'Earlier pick', own: 'Your picture' };
  // the special cards at the end of a row: [icon, card title, card line, preview title, preview line (p, it), button]
  // more (0.3.1): a source that could add versions of this part isn't set up yet; it opens Accounts & services, and the
  // studio comes back on the same game and part when Settings closes
  const ACTS = {
    own: ['+', 'My own picture', 'From your photos', 'A picture of your own', p => `Choose any photo for the ${LONG[p].toLowerCase()} · it's copied, never moved`, 'Choose a picture'],
    undo: ['↶', 'Undo', 'The picture before', 'Undo', () => 'Put back the picture this part had before', 'Undo'],
    shelf: ['↺', 'Shelf style', 'Let the shelf choose', 'Back to the shelf style', () => 'This part stops being your pick and follows the shelf style again', 'Use the shelf style'],
    more: ['⊕', 'More art sources', '', 'More art sources', (p, it) => `${it.miss.join(' and ')} can add more ${LONG[p].toLowerCase()} versions: set ${it.miss.length > 1 ? 'them' : 'it'} up in Accounts & services (free), then you're back here`, 'Set up'],
    undoset: ['↶', 'Undo set', 'The four before', 'Undo the set', () => 'Put back the pictures all four parts had before the set went in', 'Undo set'] };
  // (0.3.5) the looks on the Sets row: each part picked again by that look (a part with nothing that fits keeps its picture)
  const LOOKS = [['hd', 'Sharpest of each', 'Every part in its HD version', 'HD'], ['region:usa', 'All USA', 'Every part from the USA release', 'USA'],
    ['region:eur', 'All Europe', 'Every part from the European release', 'EUR'], ['region:jpn', 'All Japan', 'Every part from the Japanese release', 'JPN']];
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const cssUrl = u => `url("${String(u).replace(/"/g, '%22')}")`;
  const snd = (n, d) => { try { if (typeof play_ === 'function') play_(n, d ? { dir: d } : undefined); } catch {} };
  const wake = () => { try { if (window.Shelf && Shelf._wake) Shelf._wake(); } catch {} };

  // Layout (the Android page is 1440 x 810): the tall row's cards, and the scale the other rows' strips are drawn at
  // (0.3.5: five rows, so the small ones are a little lower)
  const ROW_BIG = 266, ROW_SMALL = 80, ROW_GAP = 10, CARD_H = 242, IMG_H = 180, CARD_GAP = 14, SMALL_K = 0.28, MIN_W = 136;

  let api = A();         // window.boxshelf (read again on each open: the adapter may replace it)
  let E = null;          // the overlay's elements (built on first open)
  let S = null;          // the game being edited: { sys, file, title, id, ratio, art, lock, sysName, row, rows: {row id: R}, info, o }
  let busy = false;      // a pick is being saved
  let sayT = 0, sendT = 0, fullT = 0, lastSent = '', unsub = null;
  const rowId = () => ROWS[S.row];

  // ---------- opening and closing ----------
  function open(o) {
    if (!window.bsPlatform || bsPlatform.os !== 'android' || !A().artCandidates || !o || !o.systemId || !o.file) return false;
    api = A();
    build();
    const g = o.game || {};
    S = { sys: o.systemId, file: o.file, title: o.title || g.title || '', id: o.id, ratio: 0.71, art: Object.assign({}, g.art || {}), lock: {}, sysName: '', row: 1, rows: {}, info: null, o };
    for (const p of ROWS) S.rows[p] = { part: p, list: null, state: 'idle', i: -1, sx: 0, xs: [], ws: [], cards: [], changed: false, err: '' };
    E.title.textContent = S.title; E.kick.textContent = 'Art Studio'; E.msg.classList.remove('on');
    E.el.classList.toggle('bst-dual', !!(window.BS_BOTTOM_STUDIO && BS_BOTTOM_STUDIO.on()));
    shapeSet(null);
    for (const p of ROWS) paintRow(p);
    // the console's case shape and colour (the same facts the bottom screen gets), and the game's locks
    Promise.resolve(window.Shelf && Shelf.bottomInfo ? Shelf.bottomInfo(g.id != null ? g : undefined) : null).then(info => {
      if (!S || !info) return; const st = info.style || {}; S.info = info;
      if (st.ratio) S.ratio = Math.max(0.55, Math.min(1.45, +st.ratio)); S.sysName = (info.system && info.system.name) || '';
      E.kick.textContent = 'Art Studio' + (S.sysName ? ' · ' + S.sysName : '');
      if (st.glow) E.el.style.setProperty('--acc', st.glow);
      shapeSet(info);
      for (const p of ROWS) if (S.rows[p].list) layoutRow(p); paint(); }).catch(() => {});
    Promise.resolve(api.artGames ? api.artGames({ systemId: S.sys }) : null).then(L => {
      if (!S || !Array.isArray(L)) return; const me = L.find(x => String(x.file).toLowerCase() === String(S.file).toLowerCase()); if (!me) return;
      S.lock = me.lock || {}; S.art = Object.assign({}, S.art, me.art || {}); for (const p of ROWS) if (S.rows[p].list) setActs(p); paint(); }).catch(() => {});
    if (!unsub && api.onArtCand) unsub = api.onArtCand(onCand);
    E.el.classList.add('on'); document.body.classList.add('bst-open');
    clearTimeout(fullT); fullT = setTimeout(() => { if (S) document.body.classList.add('bst-full'); }, 260); // after the fade in
    pad.primed = false; held.clear();
    focusRow(1, true); // (Front: Sets is one up)
    return true;
  }
  function close() {
    if (!S) return; snd('back');
    clearTimeout(fullT); document.body.classList.remove('bst-full'); // the shelf is back underneath before the studio fades out
    E.el.classList.remove('on'); document.body.classList.remove('bst-open');
    const done = S.o && S.o.onClose; // (0.3.5) the museum, which opened it: un-paused, its wall shows the new pictures
    S = null; busy = false; clearTimeout(sendT); sendT = 0; sendBottom(true);
    if (typeof done === 'function') try { done(); } catch (e) { console.error('studio onClose', e); }
    // its pictures go once it has faded out (nothing of this game is kept in memory behind the shelf)
    setTimeout(() => { if (S) return; for (const p of ROWS) { E.rows[p].track.textContent = ''; E.rows[p].mini._u = null; E.rows[p].mini.style.backgroundImage = ''; }
      for (const k in E.faces) { E.faces[k]._u = null; E.faces[k].style.backgroundImage = ''; } }, 400);
  }
  const isOpen = () => !!S;
  // "More art sources": Accounts & services in Settings, then back to this game and part (its versions looked for again)
  function sources(part) {
    if (!S || !window.Setup || !Setup.open) return;
    const o = Object.assign({}, S.o), r = ROWS.indexOf(part); close();
    setTimeout(() => { try { Setup.open({ page: 'acct' }); } catch { return; }
      const mode = () => { try { return window.Shelf && Shelf.getMode ? Shelf.getMode() : ''; } catch { return ''; } };
      const back = () => { if (mode() === 'setup') { setTimeout(back, 400); return; } if (open(o) && r > 1) focusRow(r); };
      setTimeout(back, 900); }, 320);
  }

  // ---------- the overlay ----------
  function build() {
    if (E) return;
    const el = document.createElement('div'); el.id = 'bsStudio'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Art Studio');
    el.innerHTML = `<div class="bst-head"><button class="bst-back" type="button" aria-label="Done"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></button>
      <div class="bst-ht"><div class="bst-kick"></div><h1 class="bst-title"></h1></div><div class="bst-msg" aria-live="polite"></div></div>
      <div class="bst-body"><div class="bst-rows">${ROWS.map((p, r) => `<section class="bst-row" data-part="${p}" data-r="${r}">
        <button class="bst-tab" type="button"><span class="bst-mini ${p}"></span><span class="bst-tt"><b>${NAME[p]}</b><small></small></span></button>
        <div class="bst-strip" data-hswipe><div class="bst-track"></div><div class="bst-note"></div></div></section>`).join('')}</div>
        <aside class="bst-pv"><div class="bst-set" data-v="front"><i class="bst-dsk disc"></i><div class="bst-box"><i class="f front"></i><i class="s spine"></i><i class="b back"></i></div></div>
          <div class="bst-what"><small></small><b></b><span></span></div>
          <button class="bst-use" type="button"></button></aside></div>
      <div class="bst-foot">${[['lr', 'L R', 'Part'], ['a', 'A', 'Use this'], ['y', 'Y', 'My own picture'], ['x', 'X', 'Shelf style'], ['b', 'B', 'Done']].map(([k, b, t]) => `<button type="button" class="bst-hint" data-k="${k}"><kbd>${b}</kbd>${t}</button>`).join('')}</div>`;
    document.body.appendChild(el);
    const q = s => el.querySelector(s);
    E = { el, title: q('.bst-title'), kick: q('.bst-kick'), msg: q('.bst-msg'), rowsEl: q('.bst-rows'), rows: {}, ring: document.createElement('div'),
      set: q('.bst-set'), faces: { front: q('.bst-box .f'), back: q('.bst-box .b'), spine: q('.bst-box .s'), disc: q('.bst-dsk') },
      whatK: q('.bst-what small'), whatB: q('.bst-what b'), whatS: q('.bst-what span'), use: q('.bst-use'), hints: {} };
    E.ring.className = 'bst-ring';
    el.querySelectorAll('.bst-row').forEach(s => { const p = s.dataset.part; E.rows[p] = { s, tab: s.querySelector('.bst-tab'), sub: s.querySelector('.bst-tt small'), mini: s.querySelector('.bst-mini'), strip: s.querySelector('.bst-strip'), track: s.querySelector('.bst-track'), note: s.querySelector('.bst-note') }; });
    el.querySelectorAll('.bst-hint').forEach(b => { E.hints[b.dataset.k] = b; });
    // touch / mouse
    q('.bst-back').onclick = () => close();
    E.use.onclick = () => { wake(); act('a'); };
    el.querySelectorAll('.bst-hint').forEach(b => b.onclick = () => { wake(); const k = b.dataset.k; if (k === 'lr') act('rb'); else act(k); });
    ROWS.forEach((p, r) => { E.rows[p].tab.onclick = () => { wake(); if (S && S.row !== r) { focusRow(r); snd('tick', 1); } }; dragRow(p, r); });
    // a tap on the set: that part's row (the case's front, back or spine, or the disc)
    E.set.addEventListener('click', e => { if (!S) return; const f = e.target.closest && e.target.closest('.bst-box i, .bst-dsk'); if (!f) return;
      const p = PARTS.find(x => f.classList.contains(x)), r = ROWS.indexOf(p); if (r > 0 && r !== S.row) { wake(); focusRow(r); snd('tick', 1); } });
    // keyboard (and Android's back button, which arrives as Escape): taken before the shelf sees it
    addEventListener('keydown', e => {
      if (!S) return;
      const k = e.key, m = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Enter: 'a', ' ': 'a', Escape: 'b', Backspace: 'b', y: 'y', Y: 'y', x: 'x', X: 'x', Tab: e.shiftKey ? 'lb' : 'rb', PageUp: 'lb', PageDown: 'rb', Home: 'lt', End: 'rt', q: 'lb', e: 'rb' }[k];
      e.preventDefault(); e.stopImmediatePropagation(); wake();
      if (m && (!e.repeat || /up|down|left|right/.test(m))) act(m, e.repeat);
    }, true);
    addEventListener('keyup', e => { if (S) { e.stopImmediatePropagation(); } }, true);
    el.addEventListener('wheel', e => { e.stopPropagation(); e.preventDefault(); if (S) act(e.deltaY > 0 ? 'down' : 'up'); }, { passive: false });
  }
  // the set's case: its shape (front proportions, thickness) and colour, from the shelf's facts about the console
  function shapeSet(info) {
    const st = (info && info.style) || {}, r = S.ratio, pack = st.pack || 'keep';
    const ch = r > 1 ? Math.round(236 / r) : 270, cw = r > 1 ? 236 : Math.round(270 * r), cd = pack === 'jewel' ? 14 : pack === 'box' ? 24 : 20;
    E.set.style.setProperty('--cw', cw + 'px'); E.set.style.setProperty('--ch', ch + 'px'); E.set.style.setProperty('--cd', cd + 'px');
    E.set.style.setProperty('--cc', st.caseColor || '#1b1c22');
    E.set.classList.toggle('cart', !!(info && info.media && info.media.kind && info.media.kind !== 'disc'));
  }

  // a finger on a row: tap a version to look at it (tap it again to use it), drag to slide along the row
  function dragRow(p, r) {
    const strip = E.rows[p].strip; let d = null;
    strip.addEventListener('pointerdown', e => { if (!S) return; d = { x: e.clientX, sx: S.rows[p].sx, moved: false, id: e.pointerId }; });
    strip.addEventListener('pointermove', e => {
      if (!d || !S || e.pointerId !== d.id) return; const dx = e.clientX - d.x;
      if (!d.moved && Math.abs(dx) < 10) return;
      if (!d.moved) { d.moved = true; try { strip.setPointerCapture(e.pointerId); } catch {} E.rows[p].track.classList.add('drag'); }
      const R = S.rows[p], k = S.row === r ? 1 : SMALL_K; R.sx = clampX(R, d.sx - dx / k); place(p);
    });
    const up = e => {
      if (!d || !S || e.pointerId !== d.id) return; const was = d; d = null; E.rows[p].track.classList.remove('drag'); wake();
      if (was.moved) return;
      const c = e.target.closest && e.target.closest('.bst-card'), R = S.rows[p];
      if (S.row !== r) { focusRow(r); if (c) { R.i = +c.dataset.i; seeCursor(R); } snd('tick', 1); paint(); return; }
      if (!c) return; const i = +c.dataset.i;
      if (i === R.i) act('a'); else { R.i = i; seeCursor(R); snd('tick', 1); paint(); }
    };
    strip.addEventListener('pointerup', up); strip.addEventListener('pointercancel', () => { d = null; E.rows[p].track.classList.remove('drag'); });
  }

  // ---------- the versions of one part (and the sets) ----------
  async function load(p, force) {
    const R = S && S.rows[p]; if (!R || R.state === 'loading' || (R.state === 'ready' && !force)) return;
    if (p === 'sets' && !api.artSets) { R.state = 'ready'; R.list = []; setActs(p); paint(); return; }
    const me = S; R.state = 'loading'; R.err = ''; if (!R.list) paintRow(p);
    try {
      const keep = R.list && R.list[R.i] && R.list[R.i].key;
      if (p === 'sets') {
        const r = await api.artSets({ systemId: S.sys, file: S.file });
        if (S !== me) return; R.list = ((r && r.sets) || []).map(s => ({ key: 'set:' + s.id, set: s }));
      } else {
        const r = await api.artCandidates({ systemId: S.sys, file: S.file, part: p });
        if (S !== me) return; R.list = ((r && r.list) || []).map(x => Object.assign({}, x));
      }
      R.state = 'ready'; setActs(p, keep);
    } catch (e) { if (S !== me) return; R.state = 'error'; R.err = (e && e.message) || (p === 'sets' ? "Couldn't put the sets together" : "Couldn't look for versions"); R.list = R.list || []; setActs(p); }
    paint(); prefetch();
  }
  // the cards after the versions. A part: a picture of your own (always), Undo (after a change here), back to the shelf
  // style (a pick of yours), more sources. Sets: the looks, then Undo set (after a set went in).
  function setActs(p, keepKey) {
    const R = S.rows[p]; if (!R.list) return; const cur = keepKey || (R.list[R.i] && R.list[R.i].key);
    R.list = R.list.filter(x => !x.act && !x.look);
    if (p === 'sets') {
      if (api.artMix) for (const [look, name, sub, tag] of LOOKS) R.list.push({ look, key: 'look:' + look, name, sub, tag });
      if (api.artUndoSet && R.changed) R.list.push({ act: 'undoset', key: 'act-undoset' });
      for (const x of R.list) if (x.set) x.inUse = PARTS.every(q => S.lock[q] && x.set.parts[q] && S.lock[q].key === x.set.parts[q].key);
    } else {
      if (api.artOwn) R.list.push({ act: 'own', key: 'act-own' });
      if (api.artUndo && R.changed) R.list.push({ act: 'undo', key: 'act-undo' });
      if (api.artMix && S.lock[p]) R.list.push({ act: 'shelf', key: 'act-shelf' });
      const miss = api.artSourcesMissing && !S.o.onClose ? api.artSourcesMissing(S.sys, p) : []; if (miss.length) R.list.push({ act: 'more', key: 'act-more', miss }); // (not over the museum: Settings can't open there)
    }
    let i = cur ? R.list.findIndex(x => x.key === cur) : -1; if (i < 0) i = R.list.findIndex(x => x.inUse); R.i = Math.max(0, i);
    layoutRow(p);
  }
  // a set or look went in: the parts' rows are looked at again when you go to them (their "in use" marks have moved)
  function partsStale() { for (const q of PARTS) { const R = S.rows[q]; if (R.state === 'ready') R.state = 'idle'; } }
  const pending = R => R.part !== 'sets' && !!(R.list && R.list.some(x => !x.act && !x.thumb && !x.failed && !x.stopped));
  // once the row you're on has all its pictures, the next row's versions load in the background (one row's downloads
  // at a time: the adapter cancels the older list's when a newer one starts)
  function prefetch() {
    if (!S) return; const R = S.rows[rowId()];
    if (R.state === 'loading' || pending(R)) return;
    for (let k = 1; k < ROWS.length; k++) { const q = S.rows[ROWS[(S.row + k) % ROWS.length]]; if (q.state === 'idle' && !q.list) { setTimeout(() => load(q.part), 250); return; } }
  }
  // a set's picture that came down (its own events, or the same version fetched for a part's row)
  function setThumb(e) {
    const R = S.rows.sets; if (!R.list) return false; let hit = false;
    for (const x of R.list) { const c = x.set && x.set.parts[e.part]; if (!c || c.key !== e.key) continue; hit = true;
      if (e.thumb) Object.assign(c, { thumb: e.thumb, w: e.w, h: e.h }); else if (e.failed) c.failed = true;
      const card = R.cards[R.list.indexOf(x)]; if (card) fillCard(card, x, 'sets'); }
    if (hit && rowId() === 'sets') { paintPreview(); sendSoon(); }
    return hit;
  }
  function onCand(e) {
    if (!S || !e || e.systemId !== S.sys || String(e.file).toLowerCase() !== String(S.file).toLowerCase() || !S.rows[e.part] || e.part === 'sets') return;
    if (e.thumb || e.failed) setThumb(e);
    if (e.set) return;
    const R = S.rows[e.part]; if (!R.list) return; let x = R.list.find(z => z.key === e.key);
    if (!x && e.cand && !e.failed) { const at = R.list.findIndex(z => z.act); x = Object.assign({}, e.cand); R.list.splice(at < 0 ? R.list.length : at, 0, x); layoutRow(e.part); paint(); return; }
    if (!x) return;
    if (e.cancelled) { x.stopped = true; return; } // another part's list took the downloads over: looked for again when you come back
    if (e.failed || e.dup) { if (x.key === 'current') return; const i = R.list.indexOf(x); R.list.splice(i, 1); if (R.i > i) R.i--; layoutRow(e.part); paint(); prefetch(); return; }
    if (e.thumb) { x.thumb = e.thumb; x.w = e.w; x.h = e.h; x.stopped = false; const c = R.cards[R.list.indexOf(x)]; if (c) fillCard(c, x, e.part); if (S.rows[rowId()] === R && R.list[R.i] === x) paintPreview(); sendSoon(); prefetch(); }
  }

  // ---------- geometry (computed, never measured) ----------
  const aspect = p => p === 'disc' ? 1 : p === 'spine' ? 0.16 : S.ratio;
  function cardW(p, x) { if (x.act || x.look) return 150; return Math.max(MIN_W, Math.round(IMG_H * aspect(p))) + 16; }
  // the strip's width at 1440 (CSS keeps it the same), minus the set column, the track's inset and the fade at the right edge
  const STRIP_W = () => 1440 - 56 - 404 - 172 - 12 - 10 - 30;
  function clampX(R, x) { const end = R.xs.length ? R.xs[R.xs.length - 1] + R.ws[R.ws.length - 1] : 0; return Math.max(0, Math.min(x, Math.max(0, end - STRIP_W() + 8))); }
  function seeCursor(R) { if (!R.xs.length) { R.sx = 0; return; } const x = R.xs[R.i] || 0, w = R.ws[R.i] || 0, W = STRIP_W();
    if (x - 40 < R.sx) R.sx = x - 40; else if (x + w + 40 > R.sx + W) R.sx = x + w + 40 - W; R.sx = clampX(R, R.sx); }

  // the row's cards, laid out along its track (again only when its list changes)
  const OK = '<i class="ok"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.2 4.2L19 7"/></svg></i>';
  function layoutRow(p) {
    const R = S.rows[p], T = E.rows[p].track; R.cards = []; R.xs = []; R.ws = []; T.textContent = '';
    let x = 0; (R.list || []).forEach((it, i) => {
      const w = cardW(p, it), c = document.createElement('div'); c.className = 'bst-card ' + p + (it.act ? ' act' : it.look ? ' look' : ''); c.dataset.i = i;
      c.style.cssText = `width:${w}px;transform:translate3d(${x}px,0,0)`;
      if (it.act) { const K = ACTS[it.act]; c.innerHTML = `<div class="im"><span>${K[0]}</span></div><div class="cap"><b>${K[1]}</b><span>${esc(it.act === 'more' ? it.miss.join(' · ') : K[2])}</span></div>`; }
      else if (it.look) c.innerHTML = `<div class="im"><span class="tag">${esc(it.tag)}</span></div><div class="cap"><b>${esc(it.name)}</b><span>Each part</span></div>`;
      else { c.innerHTML = `<div class="im"><div class="ph"></div>${it.set ? '<i class="dsc"></i>' : ''}</div><div class="cap"><b></b><span></span></div>${OK}`; fillCard(c, it, p); }
      T.appendChild(c); R.cards.push(c); R.xs.push(x); R.ws.push(w); x += w + CARD_GAP; });
    if (S.rows[rowId()] === R) T.appendChild(E.ring);
    R.sx = clampX(R, R.sx); seeCursor(R); paintRow(p);
  }
  const label = it => it.set ? String(it.set.label || 'Set').replace(/ · complete$/, '') : it.look ? it.name
    : it.key === 'current' ? (it.inUse ? 'On your shelf now' : 'The one before') : String(it.label || 'Version').replace(/ · (USA|EUR|JPN|Europe|Japan|World)$/, '');
  function meta(it) {
    if (it.set) return [it.set.hd ? 'Sharpest set' : 'Complete set', it.set.same ? 'one scan' : ''].filter(Boolean).join(' · ');
    if (it.look) return it.sub;
    const a = []; if (it.source && it.key !== 'current') a.push(SRC[it.source] || it.source); if (it.region) a.push(String(it.region).toUpperCase());
    if (it.w && it.h) a.push(`${it.w}×${it.h}`); return a.join(' · '); }
  function fillCard(c, it, p) {
    if (it.look || it.act) return;
    const im = c.querySelector('.im'), u = it.set ? it.set.parts.front && it.set.parts.front.thumb : it.thumb;
    c.querySelector('.cap b').textContent = label(it); c.querySelector('.cap span').textContent = meta(it);
    if (u && im._u !== u) { im._u = u; const old = im.querySelector('img'); if (old) old.remove(); const img = new Image(); img.decoding = 'async'; img.alt = ''; img.draggable = false;
      img.onload = () => { img.classList.add('on'); const ph = im.querySelector('.ph'); if (ph) ph.remove(); }; img.onerror = () => img.remove(); img.src = u; im.insertBefore(img, im.querySelector('.dsc')); }
    if (it.set) { const d = im.querySelector('.dsc'), v = it.set.parts.disc && it.set.parts.disc.thumb; if (d && d._u !== v) { d._u = v; d.style.backgroundImage = v ? cssUrl(v) : ''; d.classList.toggle('on', !!v); } }
    c.classList.toggle('use', !!it.inUse);
  }

  // ---------- painting (classes and transforms only) ----------
  function place(p) {
    const r = ROWS.indexOf(p), R = S.rows[p], on = S.row === r, k = on ? 1 : SMALL_K;
    const t = `translate3d(${-R.sx * k}px,0,0) scale(${k})`; const T = E.rows[p].track; if (T._t !== t) { T._t = t; T.style.transform = t; }
  }
  function paintRow(p) {
    if (!S) return; const R = S.rows[p], el = E.rows[p];
    const st = statusOf(p), [a, b] = st.split(' · '); if (el.sub._t !== st) { el.sub._t = st; el.sub.innerHTML = `<em>${esc(a)}</em>${b ? `<span> · ${esc(b)}</span>` : ''}`; }
    el.s.classList.toggle('mine', p === 'sets' ? PARTS.every(q => S.lock[q]) : !!S.lock[p]);
    const u = p === 'sets' ? S.art.front : S.art[p]; if (el.mini._u !== u) { el.mini._u = u; el.mini.style.backgroundImage = u ? cssUrl(u) : ''; el.mini.classList.toggle('none', !u); }
    const n = R.list ? R.list.filter(x => !x.act && !x.look).length : 0;
    const none = p === 'sets' ? 'No complete set found yet · try a look' : 'Nothing found for this part yet · use a picture of your own';
    const note = R.state === 'loading' && !n ? (p === 'sets' ? 'Putting the sets together…' : 'Looking for every version…') : R.state === 'error' && !n ? R.err : R.list && !n ? none : '';
    el.note.textContent = note; el.note.classList.toggle('on', !!note); el.strip.classList.toggle('wait', R.state === 'loading' && !n);
  }
  function statusOf(p) { const R = S.rows[p], n = R.list ? R.list.filter(x => !x.act && !x.look).length : 0;
    if (p === 'sets') return 'All four parts' + (R.list ? ` · ${n} set${n === 1 ? '' : 's'}` : R.state === 'loading' ? ' · looking…' : '');
    const has = !!S.art[p], mine = !!S.lock[p];
    return (has ? (mine ? 'Your pick' : 'Shelf style') : 'Missing') + (R.list ? ` · ${n} version${n === 1 ? '' : 's'}` : R.state === 'loading' ? ' · looking…' : ''); }
  function paint() {
    if (!S) return;
    ROWS.forEach((p, r) => { const on = S.row === r, el = E.rows[p]; el.s.classList.toggle('on', on); el.s.style.transform = `translate3d(0,${rowY(r)}px,0)`; place(p); paintRow(p); });
    const id = rowId(), R = S.rows[id], c = R.cards[R.i];
    if (c) { const t = `translate3d(${R.xs[R.i] - 7}px,-7px,0)`, w = R.ws[R.i] + 14 + 'px'; if (E.ring._t !== t) { E.ring._t = t; E.ring.style.transform = t; } if (E.ring.style.width !== w) E.ring.style.width = w; E.ring.classList.add('on'); }
    else E.ring.classList.remove('on');
    R.cards.forEach((d, i) => d.classList.toggle('cur', i === R.i));
    const it = R.list && R.list[R.i];
    E.hints.a.classList.toggle('off', !it || busy);
    E.hints.x.classList.toggle('off', id === 'sets' ? !PARTS.some(q => S.lock[q]) : !S.lock[id]);
    E.hints.y.classList.toggle('off', !api.artOwn || id === 'sets');
    paintPreview(); sendSoon();
  }
  // where each row sits: the tall one where it falls, the small ones above and below it (moved by transform only)
  function rowY(r) { let y = 0; for (let k = 0; k < r; k++) y += (S.row === k ? ROW_BIG : ROW_SMALL) + ROW_GAP; return y; }
  // the case as it would be: what's in use, with the version (or the whole set) under the cursor put in
  function viewArt() {
    const id = rowId(), R = S.rows[id], it = R.list && R.list[R.i], art = Object.assign({}, S.art);
    if (id === 'sets') { if (it && it.set) for (const q of PARTS) { const c = it.set.parts[q]; if (c && c.thumb) art[q] = c.thumb; } }
    else if (it && !it.act && it.thumb) art[id] = it.thumb;
    return art;
  }
  function paintPreview() {
    const id = rowId(), R = S.rows[id], it = R.list && R.list[R.i];
    E.el.dataset.part = id; const v = id === 'sets' ? 'front' : id; if (E.set.dataset.v !== v) E.set.dataset.v = v;
    const art = viewArt();
    for (const q of PARTS) { const el = E.faces[q], u = art[q] || null;
      if (el._u !== u) { el._u = u; el.style.backgroundImage = u ? cssUrl(u) : ''; el.classList.toggle('none', !u); } }
    const n = R.list ? R.list.length : 0;
    let k = LONG[id] + (n && it ? ` · ${R.i + 1} of ${n}` : ''), b = LONG[id], s = '';
    if (it && it.act) { const K = ACTS[it.act]; b = K[3]; s = K[4](id, it); }
    else if (it && it.look) { b = it.name; s = `${it.sub} · a part with no such version keeps its picture`; }
    else if (it && it.set) { b = label(it); s = [meta(it), PARTS.every(q => it.set.parts[q] && it.set.parts[q].thumb) ? '' : 'pictures coming in…'].filter(Boolean).join(' · '); }
    else if (it) { b = label(it); s = [meta(it), it.edition === 'special' ? 'Special edition' : it.edition === 'reprint' ? 'Reprint' : '', it.kind === 'hd' ? 'HQ' : ''].filter(Boolean).join(' · ') || LONG[id]; }
    else s = R.state === 'loading' ? (id === 'sets' ? 'Putting the sets together…' : 'Looking for every version…') : 'Nothing to choose from yet';
    if (E.whatK.textContent !== k) E.whatK.textContent = k; if (E.whatB.textContent !== b) E.whatB.textContent = b; if (E.whatS.textContent !== s) E.whatS.textContent = s;
    const inUse = !!(it && it.inUse), ut = busy ? 'Saving…' : inUse ? 'On your shelf' : it && it.act ? ACTS[it.act][5] : it && it.set ? 'Use this set' : it && it.look ? 'Use this look' : 'Use this';
    const uh = inUse ? `<svg viewBox="0 0 24 24"><path d="M5 12.5l4.2 4.2L19 7"/></svg>${ut}` : `<kbd>A</kbd>${esc(ut)}`; if (E.use._h !== uh) { E.use._h = uh; E.use.innerHTML = uh; }
    E.use.classList.toggle('inuse', inUse); E.use.disabled = !it || busy || inUse;
  }
  function say(t, bad) { E.msg.textContent = t; E.msg.classList.toggle('bad', !!bad); E.msg.classList.add('on'); clearTimeout(sayT); sayT = setTimeout(() => E.msg.classList.remove('on'), 3200); }

  // ---------- moving ----------
  function focusRow(r, first) {
    S.row = r; const p = ROWS[r], R = S.rows[p];
    E.rows[p].track.appendChild(E.ring);
    if (R.state === 'idle' || R.list && R.list.some(x => x.stopped)) load(p, true);
    seeCursor(R); paint();
    if (first) E.el.classList.add('fresh'), requestAnimationFrame(() => requestAnimationFrame(() => E.el.classList.remove('fresh')));
  }
  function act(a, rep) {
    if (!S) return; const id = rowId(), R = S.rows[id], n = R.list ? R.list.length : 0;
    if (a === 'b' || a === 'start') { close(); return; }
    if (a === 'up' || a === 'down' || a === 'lb' || a === 'rb') {
      let r = S.row + (a === 'down' || a === 'rb' ? 1 : -1);
      if (a === 'lb' || a === 'rb') r = (r + ROWS.length) % ROWS.length;
      if (r < 0 || r >= ROWS.length) { if (!rep) snd('error'); return; }
      focusRow(r); snd('tick', a === 'down' || a === 'rb' ? 1 : -1); return; }
    if (a === 'left' || a === 'right') { const i = R.i + (a === 'right' ? 1 : -1); if (i < 0 || i >= n) { if (!rep) snd('error'); return; } R.i = i; seeCursor(R); snd('tick', a === 'right' ? 1 : -1); paint(); return; }
    if (a === 'lt' || a === 'rt') { if (!n) return; R.i = a === 'lt' ? 0 : n - 1; seeCursor(R); snd('tick', 1); paint(); return; }
    if (a === 'y') { if (id === 'sets') { snd('error'); say('Your own picture goes on one part: pick Front, Back, Spine or Disc'); return; } own(id); return; }
    if (a === 'x') { if (id === 'sets') allShelf(); else shelfStyle(id); return; }
    if (a === 'a') { const it = R.list && R.list[R.i]; if (!it || busy) return;
      if (it.act === 'own') own(id); else if (it.act === 'undo') undo(id); else if (it.act === 'shelf') shelfStyle(id); else if (it.act === 'more') sources(id); else if (it.act === 'undoset') undoSet();
      else if (it.inUse) { snd('error'); say(`${LONG[id]}: that one is already on your shelf`); } else if (it.set) useSet(it); else if (it.look) useLook(it); else use(id, it); }
  }

  // ---------- changing a picture ----------
  async function use(p, it) {
    const me = S, R = S.rows[p]; busy = true; snd('tick', 1); say(`${LONG[p]}: putting it in…`); markBusy(R, it, true); paint();
    try {
      const r = await api.artUse({ systemId: S.sys, file: S.file, part: p, key: it.key });
      if (S !== me) return; artIn(r && r.art, p); S.lock[p] = { look: 'exact', key: it.key };
      R.list.forEach(x => { x.inUse = x === it; }); R.changed = true; setActs(p, it.key); if (S.rows.sets.list) setActs('sets'); snd('toast'); say(`${LONG[p]}: ${label(it)} · your pick`);
    } catch (e) { if (S === me) { snd('error'); say((e && e.message) || "Couldn't use that version", true); } }
    finally { if (S === me) { busy = false; markBusy(R, it, false); R.cards.forEach((c, i) => { const x = R.list[i]; if (x && !x.act) c.classList.toggle('use', !!x.inUse); }); paint(); } }
  }
  function markBusy(R, it, on) { const c = R.cards[R.list.indexOf(it)]; if (c) c.classList.toggle('busy', on); }
  async function own(p) {
    if (!api.artOwn || busy) return; const me = S; busy = true; paint();
    try { const r = await api.artOwn({ systemId: S.sys, file: S.file, part: p });
      if (S !== me) return; if (r && r.canceled) { busy = false; paint(); return; }
      artIn(r && r.art, p); S.lock[p] = r && r.lock || { look: 'exact', key: 'own' }; S.rows[p].changed = true; busy = false; snd('toast'); say(`${LONG[p]}: your own picture · your pick`);
      S.rows[p].state = 'idle'; await load(p, true); const R = S.rows[p], k = R.list.findIndex(x => x.inUse); if (k >= 0) { R.i = k; seeCursor(R); } paint();
    } catch (e) { if (S === me) { snd('error'); say((e && e.message) || "Couldn't use that picture", true); } }
    finally { if (S === me) { busy = false; paint(); } }
  }
  async function undo(p) {
    if (!api.artUndo || busy) return; const me = S; busy = true; paint();
    try { const r = await api.artUndo({ systemId: S.sys, file: S.file, part: p }); if (S !== me) return;
      artIn(r && r.art, p); if (r && r.lock) S.lock[p] = r.lock; busy = false; snd('back'); say(`${LONG[p]}: back to the picture before`); S.rows[p].state = 'idle'; await load(p, true);
    } catch (e) { if (S === me) { snd('error'); say((e && e.message) || 'Nothing to undo', true); } }
    finally { if (S === me) { busy = false; paint(); } }
  }
  async function shelfStyle(p) {
    if (!api.artMix || busy || !S) return; if (!S.lock[p]) { snd('error'); say(`${LONG[p]} already follows the shelf style`); return; }
    const me = S; busy = true; paint();
    try { await api.artMix({ systemId: S.sys, file: S.file, part: p, look: 'shelf' }); if (S !== me) return;
      S.lock[p] = null; setActs(p); if (S.rows.sets.list) setActs('sets'); snd('tick', -1); say(`${LONG[p]} follows the shelf style again`);
    } catch (e) { if (S === me) { snd('error'); say((e && e.message) || "Couldn't change that", true); } }
    finally { if (S === me) { busy = false; paint(); } }
  }
  // (0.3.5) a whole set: all four parts from one release, in one go (nothing changes if one of them can't be had)
  async function useSet(it) {
    if (!api.artUseSet || busy) return; const me = S, R = S.rows.sets; busy = true; snd('tick', 1); say('Putting the whole set in…'); markBusy(R, it, true); paint();
    try { const r = await api.artUseSet({ systemId: S.sys, file: S.file, setId: it.set.id }); if (S !== me) return;
      artIn(r && r.art); if (r && r.lock) S.lock = r.lock; R.changed = true; partsStale(); setActs('sets', it.key); snd('toast'); say(`${label(it)}: the whole set is in`);
    } catch (e) { if (S === me) { snd('error'); say((e && e.message) || "Couldn't put that set in", true); } }
    finally { if (S === me) { busy = false; markBusy(R, it, false); paint(); } }
  }
  // (0.3.5) a look: each part picked again by it, one after another (the case fills in as they arrive)
  async function useLook(it) {
    if (!api.artMix || busy) return; const me = S, R = S.rows.sets; busy = true; snd('tick', 1); say(`${it.name}: looking for each part…`); markBusy(R, it, true); paint();
    let n = 0, last = null;
    try { for (const q of PARTS) { try { const r = await api.artMix({ systemId: S.sys, file: S.file, part: q, look: it.look }); if (S !== me) return;
        artIn(r && r.art, q); S.lock[q] = { look: it.look, key: r && r.key }; n++; paintPreview(); sendSoon(); } catch (e) { if (S !== me) return; last = e; } }
      partsStale(); setActs('sets', it.key);
      if (n) { snd('toast'); say(`${it.name}: ${n} of 4 parts`); } else { snd('error'); say((last && last.message) || 'No version found for that look', true); }
    } finally { if (S === me) { busy = false; markBusy(R, it, false); paint(); } }
  }
  async function undoSet() {
    if (!api.artUndoSet || busy) return; const me = S; busy = true; paint();
    try { const r = await api.artUndoSet({ systemId: S.sys, file: S.file }); if (S !== me) return;
      artIn(r && r.art); if (r && r.lock) S.lock = r.lock; S.rows.sets.changed = false; partsStale(); setActs('sets'); snd('back'); say('The four pictures before are back');
    } catch (e) { if (S === me) { snd('error'); say((e && e.message) || 'Nothing to undo', true); } }
    finally { if (S === me) { busy = false; paint(); } }
  }
  // X on Sets: every part you picked follows the shelf style again
  async function allShelf() {
    if (!api.artMix || busy || !S) return; const mine = PARTS.filter(q => S.lock[q]);
    if (!mine.length) { snd('error'); say('The whole case already follows the shelf style'); return; }
    const me = S; busy = true; paint();
    try { for (const q of mine) { await api.artMix({ systemId: S.sys, file: S.file, part: q, look: 'shelf' }); if (S !== me) return; S.lock[q] = null; }
      for (const p of ROWS) if (S.rows[p].list) setActs(p); snd('tick', -1); say('The whole case follows the shelf style again');
    } catch (e) { if (S === me) { snd('error'); say((e && e.message) || "Couldn't change that", true); } }
    finally { if (S === me) { busy = false; paint(); } }
  }
  function artIn(art, p) { if (typeof art === 'string') S.art[p] = art; else if (art && typeof art === 'object') for (const q of PARTS) if (q in art) S.art[q] = art[q]; }

  // ---------- the controller (app.js hands it over through BS_MODAL while the studio is up) ----------
  const pad = { primed: false }, held = new Map();
  const BTN = { 0: 'a', 1: 'b', 2: 'x', 3: 'y', 4: 'lb', 5: 'rb', 6: 'lt', 7: 'rt', 9: 'start', 12: 'up', 13: 'down', 14: 'left', 15: 'right' }, REP = /^(up|down|left|right)$/;
  window.BS_MODAL = (gp, t) => {
    if (!S) return false;
    try { if (window.Shelf && Shelf.padBlocked && Shelf.padBlocked()) return false; } catch {} // the dimmed screen wakes up first
    const B = i => !!(gp.buttons[i] && (gp.buttons[i].pressed || gp.buttons[i].value > 0.5)), ax = gp.axes || [], on = new Set();
    for (const [i, a] of Object.entries(BTN)) if (B(+i)) on.add(a);
    const x = ax[0] || 0, y = ax[1] || 0, v = Math.abs(y) >= Math.abs(x); // the stick moves along its stronger axis only
    if (v && y < -0.55) on.add('up'); if (v && y > 0.55) on.add('down'); if (!v && x < -0.55) on.add('left'); if (!v && x > 0.55) on.add('right');
    if (!pad.primed) { pad.primed = true; for (const a of on) held.set(a, Infinity); return true; } // the press that opened it doesn't act here
    for (const a of [...held.keys()]) if (!on.has(a)) held.delete(a);
    for (const a of on) { const h = held.get(a);
      if (h === undefined) { held.set(a, t + 380); wake(); act(a, false); }
      else if (REP.test(a) && t > h) { held.set(a, t + 90); act(a, true); } }
    return true;
  };

  // ---------- the bottom screen ----------
  function sendSoon() { if (!window.BS_BOTTOM_STUDIO || sendT) return; sendT = setTimeout(() => { sendT = 0; sendBottom(false); }, 90); }
  function sendBottom(closed) {
    const B = window.BS_BOTTOM_STUDIO; if (!B || !B.on()) return;
    let m;
    if (closed || !S) m = { open: false };
    else { // the game's case (its shape and colours), with the version (or the set) under the cursor in place
      if (!S.info) return; // (sent once the shelf's facts about the game are in)
      const id = rowId(); m = { open: true, part: id === 'sets' ? 'front' : id, art: viewArt(), game: S.info }; }
    const sig = JSON.stringify(m); if (sig === lastSent) return; lastSent = sig; B.post(m);
  }

  window.BS_STUDIO = { open, close, isOpen, resend: () => { lastSent = ''; sendSoon(); }, _state: () => S && { part: rowId(), row: S.row, i: S.rows[rowId()].i, busy,
    view: E.set.dataset.v, keys: (S.rows[rowId()].list || []).map(x => x.key), msg: E.msg.classList.contains('on') ? E.msg.textContent : '', faces: Object.fromEntries(PARTS.map(q => [q, E.faces[q]._u || null])),
    rows: ROWS.map(p => ({ part: p, state: S.rows[p].state, n: (S.rows[p].list || []).length, inUse: ((S.rows[p].list || []).find(x => x.inUse) || {}).key || null })) } };
})();
