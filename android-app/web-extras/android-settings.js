// Boxshelf on Android (0.3.4): Settings regrouped for the handheld, as the mock (Settings mock, 2026-10-24): seven plain
// sections instead of thirteen, Art Studio second, everything for one thing in one place.
//   Games            consoles (each opens its own page), Magazines & guides
//   Art Studio       open the studio, the downloads for every console, sources (LaunchBox), manuals (per console on a sub-page)
//   Shelf & museum   console order, shuffle, attract mode, then the museum's room (its live preview shows behind those rows)
//   Display & sound  theme, background, clock, start-up, then performance, then sounds
//   Controls & screens  the controller, then the bottom screen
//   Accounts         sign-ins and keys
//   System           start-up, folders, home screen, about
// Every row is the same object it was (its settings, sub-pages and search keep working); merged sections keep their old ids
// as aliases, so deep links (Setup.open({ page: 'museum' }), 'bottom', 'reading'…) still land on the right rows. Runs last
// of the BS_SETTINGS_PATCH chain (after android-api.js's art / accounts rows and android-reading.js's magazines rows).
// Windows never loads this file.
(function () {
  'use strict';
  const prev = window.BS_SETTINGS_PATCH;
  const head = text => ({ t: 'head', text });
  window.BS_SETTINGS_PATCH = (sections, h) => {
    let S = sections;
    try { if (typeof prev === 'function') S = prev(sections, h) || sections; } catch (e) { console.error('settings patch', e); }
    try { return regroup(S, h || {}); } catch (e) { console.error('settings regroup', e); return S; } // (a mistake here never costs the page its settings)
  };

  function regroup(S, h) {
    const by = id => S.find(s => s && s.id === id), used = new Set();
    const take = id => { const s = by(id); if (s) used.add(s); return s; };
    const rowsOf = s => (s && Array.isArray(s.rows) ? s.rows : []);
    const out = [];
    const sec = (base, o) => { const s = Object.assign(base || {}, o, { g: '' }); out.push(s); return s; }; // (no group: seven sections need no headings, and the page's crumb stays empty)

    // ----- Games: the consoles, then the magazines & guides (and the PC's apps / Steam, where a platform has them) -----
    const con = take('consoles'), apps = take('apps'), pc = take('pc'), reading = take('reading');
    // the store row answers to the PC's old name, so links into the reading corner (Setup.open({ page: 'reading' })) land on it
    for (const r of rowsOf(reading)) if (r && r.t !== 'head' && /store/i.test(String(r.label || ''))) { r.was = 'Find on the Internet Archive'; break; }
    // (beta.9) Ports & custom APKs (android-api.js) go last, after the reading corner: the consoles' and magazines' rows keep their places
    const isPorts = r => r && (r.pg === 'android-ports' || (r.t === 'head' && r.text === 'Ports & custom APKs'));
    const ports = rowsOf(con).filter(isPorts);
    if (con) sec(con, { name: 'Games', ic: 'games', lead: 'Your consoles, their emulators and games folders, and the reading corner.',
      alias: ['consoles', 'apps', 'pc', 'reading', 'magazines', 'guides'],
      rows: [...rowsOf(con).filter(r => !isPorts(r)), ...(pc ? [head(pc.name), ...rowsOf(pc)] : []), ...(apps ? [head(apps.name), ...rowsOf(apps)] : []), ...(reading ? [head('Magazines & guides'), ...rowsOf(reading).filter((r, i) => !(r && r.t === 'head' && i === 0))] : []), ...ports] }); // (its own first heading would sit right under this one)

    // ----- Art Studio: the studio first, then what every console gets, the sources, the manuals -----
    const art = take('art');
    if (art) {
      const R = rowsOf(art), pick = test => R.filter(r => r && r.t !== 'head' && test(r)), lbl = r => String(r.label || '');
      const studio = pick(r => r.pg === 'art-studio');
      const manuals = pick(r => /manual|Confident English/i.test(lbl(r)) && !/^Manuals: /.test(lbl(r)));
      const perCon = pick(r => /^Manuals: /.test(lbl(r)));
      const sources = pick(r => /LaunchBox/.test(lbl(r)));
      const hidden = pick(r => r.pg === 'art-hidden');
      const taken = new Set([...studio, ...manuals, ...perCon, ...sources, ...hidden]);
      const boxart = pick(r => !taken.has(r));
      // the consoles' manual switches on a page of their own (one row here says how many are on)
      const conPage = perCon.length && h.M ? [h.M('Consoles for manuals', 'art-man-cons', 'Which consoles get their manuals fetched.', 'Each console\'s manuals come down in the background, while the shelf is quiet.', perCon,
        { keys: 'manual booklet console per console', sub: () => { const on = perCon.filter(r => r.get && r.get()).length; return { text: `${on} of ${perCon.length} console${perCon.length === 1 ? '' : 's'} on` }; } })] : perCon;
      sec(art, { name: 'Art Studio', ic: 'art', lead: 'How your box art and manuals look, and where they come from.', alias: ['art', 'manuals', 'library'],
        rows: [...studio, head('For every console'), ...boxart, ...(sources.length ? [head('Sources'), ...sources] : []), ...(manuals.length || conPage.length ? [head('Manuals'), ...manuals, ...conPage] : []), ...(hidden.length ? [head('More'), ...hidden] : [])] });
    }

    // ----- Shelf & museum (the museum's rows marked: Settings shows the room behind them) -----
    const shelf = take('shelf'), museum = take('museum'), pv = take('previews');
    // (beta.9) video previews: one row here opening their own page (Windows gives them a section of their own)
    const pvRow = pv && h.M ? [head('Video previews'), h.M('Video previews', 'pv-android', 'Previews in Details: videos beside your games, or YouTube trailers in the Media tab.', pv.lead || '', rowsOf(pv),
      { keys: 'video preview previews trailer youtube videos' })] : [];
    if (shelf || museum) {
      const mus = rowsOf(museum).map(r => { if (r && typeof r === 'object') r._mus = true; return r; });
      sec(shelf || museum, { id: shelf ? 'shelf' : 'museum', name: 'Shelf & museum', ic: shelf ? shelf.ic : 'museum', lead: 'How the shelf behaves, and your collection\'s room.', alias: ['shelf', 'museum', 'previews', 'videos', 'trailers'],
        rows: [...rowsOf(shelf), ...pvRow, ...(museum ? [Object.assign(head('Museum'), { _mus: true }), ...mus] : [])] });
    }

    // ----- Display & sound (the bottom screen's switch moves to Controls & screens) -----
    const disp = take('display'), perf = take('perf'), sound = take('sound');
    const isBottom = r => r && r.label === 'Bottom screen';
    const bottomRows = rowsOf(disp).filter(isBottom);
    if (disp || perf || sound) sec(disp || perf || sound, { id: disp ? 'display' : perf ? 'perf' : 'sound', name: 'Display & sound', ic: 'display', lead: 'How everything looks and sounds, and how hard the graphics work.',
      alias: ['display', 'perf', 'performance', 'sound'],
      rows: [...rowsOf(disp).filter(r => !isBottom(r)), ...(perf ? [head('Performance'), ...rowsOf(perf)] : []), ...(sound ? [head('Sound'), ...rowsOf(sound)] : [])] });

    // ----- Controls & screens -----
    const pad = take('pad'), phone = take('phone');
    if (pad || bottomRows.length || phone) sec(pad || {}, { id: 'pad', name: 'Controls & screens', ic: 'pad', lead: 'Your controller, the bottom screen' + (phone ? ' and the phone companion.' : '.'), alias: ['pad', 'controller', 'bottom', 'phone'],
      rows: [...rowsOf(pad), ...(bottomRows.length ? [head('Bottom screen'), ...bottomRows] : []), ...(phone ? [head(phone.name), ...rowsOf(phone)] : [])] });

    // ----- Accounts, System -----
    const acct = take('acct'); if (acct) sec(acct, { name: 'Accounts', alias: ['acct', 'accounts'] });
    const sys = take('sys'); if (sys) sec(sys, { alias: ['sys', 'system', 'startup'] });

    // anything a later version adds that isn't placed above keeps its own page, at the end (nothing is ever lost)
    for (const s of S) if (s && !used.has(s)) out.push(Object.assign(s, { g: '' }));
    return out;
  }
})();
