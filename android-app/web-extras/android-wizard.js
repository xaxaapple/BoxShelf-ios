// Boxshelf on Android: the first-run wizard's own questions (setup.js shows them right after Welcome).
// One question per page, with big choices that work with a finger and with the controller (D-pad + A), and a short plain
// explanation each: where your games are, box art (download it? full cases? where to keep it?), the bottom screen and
// Boxshelf as the Home app. Every answer can be changed later in Settings. The Windows wizard never loads this file.
(function () {
  const api = window.boxshelf;
  if (!api || typeof api.romRoot !== 'function') return; // the Android adapter isn't running (a plain browser)

  // the main ROMs folder's last look: { path, found: [{ id, name, dir, folder, games, by }], other: [{ folder, why }] }
  let root = null, busy = false, err = '';

  // a big choice: a title, one line under it, "Recommended" when it is
  function choice(x, { title, note, on, rec, primary, click }) {
    const b = x.el('button', { type: 'button', class: 'wz-choice' + (on ? ' on' : '') + (primary ? ' primary' : ''), 'aria-pressed': on ? 'true' : 'false', onclick: click },
      rec ? x.el('i', { class: 'wz-rec', text: 'Recommended' }) : null, x.el('b', { text: title }), note ? x.el('span', { text: note }) : null);
    return b;
  }
  const choices = (x, ...kids) => x.el('div', { class: 'wz-choices' }, ...kids);
  // a yes / no page: the answer is saved and the wizard moves on
  function yesNo(b, x, { kicker, title, lead, value, yes, no, set }) {
    x.head(b, kicker, title, lead);
    b.append(choices(x,
      choice(x, { title: yes[0], note: yes[1], on: value === true, rec: yes[2], click: () => { set(true); x.changed(); x.next(); } }),
      choice(x, { title: no[0], note: no[1], on: value === false, click: () => { set(false); x.changed(); x.next(); } })));
  }
  const ui = x => (x.cfg.ui = x.cfg.ui || {});

  // ---------- your games ----------
  function applyRoot(x) {
    if (!root) return;
    x.cfg.romRoot = root.path;
    // switched off here stays off: the next look for games (detect) skips these folders too
    x.cfg.romRootOff = root.found.filter(f => f.off).map(f => f.dir);
    for (const f of root.found) { const c = x.cfg.systems[f.id]; if (!c) continue;
      if (f.was === undefined) f.was = c.enabled; // as it was before this folder was picked, to put back when switched off
      if (f.off) { c.romDirs = (c.romDirs || []).filter(d => d !== f.dir); if (!c.romDirs.length) c.enabled = f.was; continue; }
      c.enabled = true; if (!(c.romDirs || []).includes(f.dir)) c.romDirs = [...(c.romDirs || []), f.dir]; }
    x.changed();
  }
  // another main folder instead: the consoles the first one added are taken off again
  function dropRoot(x) {
    if (!root) return;
    for (const f of root.found) f.off = true;
    applyRoot(x); root = null; delete x.cfg.romRoot; delete x.cfg.romRootOff;
  }
  async function pickRoot(x, again) {
    if (busy) return; busy = true; err = ''; x.render();
    try { const r = await api.romRoot(again && root ? { path: root.path } : null); if (r) { root = r; applyRoot(x); } }
    catch (e) { err = (e && e.message) || String(e); }
    busy = false; x.render();
    const f = document.querySelector('#suBody .wz-found input, #suBody .wz-choice'); if (f && document.querySelector('#setup').contains(document.activeElement)) f.focus({ preventScroll: true });
  }
  function gamesPage(b, x) {
    if (!root && busy) { x.head(b, 'Your games', 'Looking through your folder…', 'Matching each folder to its console.'); b.append(x.el('div', { class: 'wz-wait' }, x.el('span', { class: 'scanning' }), ' Looking…')); return; }
    if (!root) {
      x.head(b, 'Your games', 'Where are your games?', 'Most people keep one ROMs folder with a folder for each console inside (like ROMs/gc, ROMs/psx). Pick that one folder and Boxshelf finds every console in it, by folder name or by the games inside.');
      b.append(choices(x,
        choice(x, { title: 'Pick your main ROMs folder', note: 'One folder, every console found for you', rec: true, primary: true, click: () => pickRoot(x) }),
        choice(x, { title: 'Pick folders per console', note: 'Advanced: you set each console’s folder after these questions', click: () => x.next() })));
      if (err) b.append(x.el('p', { class: 'wz-err', text: err }));
      return;
    }
    const on = root.found.filter(f => !f.off);
    const title = on.length ? `Found ${on.length} console${on.length === 1 ? '' : 's'}` : 'No console folders found here';
    const sum = on.length ? on.map(f => `${f.name} (${f.games} game${f.games === 1 ? '' : 's'})`).join(', ') + ` in ${root.path}. Switch off any you don't want on the shelf.` : `None of the folders in ${root.path} looks like a console's games folder.`;
    x.head(b, 'Your games', title, sum);
    const list = x.el('div', { class: 'wz-found' });
    for (const f of root.found) {
      const inp = x.el('input', { type: 'checkbox', 'aria-label': f.name }); inp.checked = !f.off;
      inp.addEventListener('change', () => { f.off = !inp.checked; applyRoot(x); x.render(); });
      list.append(x.el('label', { class: 'wz-con' + (f.off ? ' off' : '') }, inp, x.el('b', { text: f.name }),
        x.el('span', { text: `${f.games} game${f.games === 1 ? '' : 's'} · ${f.folder}${f.by === 'files' ? ' (found by its games)' : ''}` })));
    }
    b.append(list);
    if (root.other.length) b.append(x.el('p', { class: 'wz-note', text: 'Not matched: ' + root.other.map(o => `${o.folder} (${o.why})`).join(', ') + '. You can add those per console later in Settings.' }));
    b.append(x.el('div', { class: 'wz-row' },
      x.el('button', { type: 'button', class: 'btn primary', onclick: () => x.next() }, 'Continue'),
      x.el('button', { type: 'button', class: 'btn', onclick: () => { dropRoot(x); pickRoot(x); } }, 'Pick a different folder')));
  }

  // ---------- box art ----------
  const artPage = (b, x) => yesNo(b, x, { kicker: 'Box art', title: 'Download box art automatically?', lead: 'Boxshelf finds a cover for each game in the background, while you\'re not scrolling. It sends game file names to libretro and GameTDB (free, no account). Art you already have is never downloaded again.',
    value: ui(x).autoCovers === false ? false : ui(x).autoCovers === true ? true : undefined, yes: ['Yes, get box art', 'Covers appear on their own', true], no: ['No thanks', 'Plain cases with the game\'s name'], set: v => { ui(x).autoCovers = v; } });
  const fullPage = (b, x) => yesNo(b, x, { kicker: 'Box art', title: 'Full case art (backs and spines) too?', lead: 'The back and spine of each case as well, where a source has them, so a case looks complete when you turn it around. Takes a bit more space. ' +
      'Fronts come from libretro for every console; backs, spines and discs from GameTDB (GameCube and Wii) or a ScreenScraper account (Settings → Accounts & services). Copying your PC\'s ROMS\\<console>\\covers folders onto this device works too.',
    value: ui(x).fullArt === true ? true : ui(x).fullArt === false ? false : undefined, yes: ['Yes, full cases', 'Front, back and spine'], no: ['Just the fronts', 'Smaller and quicker'], set: v => { ui(x).fullArt = v; } });
  function wherePage(b, x) {
    const w = ui(x).artWhere === 'app' ? 'app' : 'roms';
    x.head(b, 'Box art', 'Where should art be saved?', 'Art you already have in a "Boxshelf Art" folder is used either way.');
    const set = v => { ui(x).artWhere = v; x.changed(); x.next(); };
    b.append(choices(x,
      choice(x, { title: 'Next to my ROMs', note: 'A "Boxshelf Art" folder in each ROMs folder. Keeps art with your games and survives reinstalling Boxshelf.', on: w === 'roms', rec: true, click: () => set('roms') }),
      choice(x, { title: 'Inside Boxshelf', note: 'Private to the app; nothing is written to your games folders. Removed if you uninstall.', on: w === 'app', click: () => set('app') })));
  }

  // ---------- game manuals (0.3.0): yes = every console with games; pick them one by one later in Settings ----------
  const manualPage = (b, x) => yesNo(b, x, { kicker: 'Manuals', title: 'Download game manuals too?', lead: 'Each game\'s instruction booklet from the Internet Archive, as pages you can read in Inspect. Fetched in the background and saved in a "Boxshelf Manuals" folder beside your games. Manuals you copied from your PC are used either way.',
    value: ui(x).autoManuals === true ? true : ui(x).autoManuals === false ? false : undefined, yes: ['Yes, get manuals', 'For every console found'], no: ['Not now', 'Choose consoles later in Settings'],
    set: v => { ui(x).autoManuals = v; for (const [id, s] of Object.entries(x.cfg.systems || {})) if (s && (s.romDirs || []).length) ui(x)['manual_' + id] = v; } });

  // ---------- the Thor's bottom screen and Home ----------
  const hasBottom = () => { try { return !!(api.bottomScreen && api.bottomScreen.available()); } catch { return false; } };
  const bottomPage = (b, x) => yesNo(b, x, { kicker: 'Bottom screen', title: 'Use the bottom screen?', lead: 'The small screen shows the game you\'re on: its case to turn with a finger, its details and big touch buttons. While you play, the screen always belongs to the game.',
    value: ui(x).bottomScreen === 'off' ? false : ui(x).bottomScreen === 'on' ? true : undefined, yes: ['Yes, use it', 'Game info and touch buttons', true], no: ['Leave it off', 'You can switch it on later'],
    set: v => { ui(x).bottomScreen = v ? 'on' : 'off'; try { api.bottomScreen.set(v); } catch {} } });
  let isHome = false;
  function homePage(b, x) {
    x.head(b, 'Home screen', 'Use Boxshelf as the Home screen?', isHome ? 'Boxshelf is already your Home screen: the Home button brings you here.' : 'The Home button then opens Boxshelf, like a console. Android shows its own list next: pick Boxshelf there. Your old launcher stays one press away in the quick menu.');
    b.append(choices(x,
      choice(x, { title: isHome ? 'Change Home app' : 'Yes, choose Boxshelf', note: 'Opens Android\'s Home app list', primary: !isHome, click: async () => { try { await api.openHomeSettings(); } catch (e) { x.toast((e && e.message) || String(e)); } x.next(); } }),
      choice(x, { title: isHome ? 'Keep it' : 'Not now', note: 'Change it any time in Settings', click: () => x.next() })));
  }

  // ---------- welcome ----------
  function welcome(b, x) {
    x.head(b, 'Welcome', 'Let\'s set up your Boxshelf', 'A few quick questions: where your games are, box art and your screens. Boxshelf finds your emulator apps by itself. Everything can be changed later in Settings.');
    b.append(x.el('div', { class: 'wz-choices one' }, choice(x, { title: 'Get started', note: 'Finds your emulators, then asks about your games', primary: true, rec: false, click: async () => { await x.detect(); x.next(); } })));
  }

  window.BS_WIZARD_EXTRA = {
    welcome,
    // when: shown only if it applies (asked again each time the list is made)
    pages: () => [
      { id: 'wz-games', label: 'Your games', render: gamesPage },
      { id: 'wz-art', label: 'Box art', render: artPage },
      { id: 'wz-full', label: 'Full case art', render: fullPage, when: c => !(c && c.ui && c.ui.autoCovers === false) },
      { id: 'wz-where', label: 'Where art goes', render: wherePage, when: c => !(c && c.ui && c.ui.autoCovers === false) },
      { id: 'wz-manuals', label: 'Manuals', render: manualPage },
      ...(hasBottom() ? [{ id: 'wz-bottom', label: 'Bottom screen', render: bottomPage }] : []),
      { id: 'wz-home', label: 'Home screen', render: homePage }
    ]
  };
  // the Home screen question knows whether Boxshelf already is it
  if (api.homeStatus) Promise.resolve().then(() => api.homeStatus()).then(h => { isHome = !!(h && h.isDefault); }).catch(() => {});

  // looks: big, even cards two across (one across on a narrow screen), plain enough for a TV-style launcher
  const css = document.createElement('style');
  css.textContent = `
.wz-choices{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px;margin-top:22px;max-width:880px}
#setup .wz-choice{position:relative;display:flex;flex-direction:column;align-items:flex-start;justify-content:center;gap:6px;min-height:118px;padding:20px 24px;border-radius:16px;
  border:2px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:inherit;font:inherit;text-align:left;cursor:pointer;transition:border-color .15s,background .15s}
#setup .wz-choice b{font-size:21px;font-weight:600}
#setup .wz-choice span{font-size:14px;line-height:1.45;color:rgba(243,245,251,.72)}
#setup .wz-choice.primary{background:rgba(255,255,255,.1)}
#setup .wz-choice.on{border-color:#fff;background:rgba(255,255,255,.14)}
#setup .wz-choice:hover,#setup .wz-choice:focus-visible{border-color:rgba(255,255,255,.6)}
#setup .wz-choice:active{transform:scale(.99)}
.wz-choices.one{max-width:430px}
#setup .wz-rec{font-style:normal;margin-bottom:2px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;padding:3px 8px;border-radius:99px;background:#fff;color:#111}
.wz-found{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:10px;margin-top:18px;max-width:880px}
.wz-con{display:grid;grid-template-columns:auto 1fr;column-gap:12px;align-items:center;padding:12px 16px;border-radius:12px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);cursor:pointer}
.wz-con input{grid-row:span 2;width:22px;height:22px;accent-color:#fff}
.wz-con b{font-size:16px}.wz-con span{font-size:12.5px;color:rgba(243,245,251,.65);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wz-con.off{opacity:.5}
.wz-row{display:flex;gap:12px;margin-top:20px;flex-wrap:wrap}
.wz-note{margin-top:14px;font-size:13px;color:rgba(243,245,251,.6);max-width:880px}
.wz-err{margin-top:14px;color:#ff9a8a}
.wz-wait{margin-top:24px;font-size:16px}`;
  document.head.appendChild(css);
})();
