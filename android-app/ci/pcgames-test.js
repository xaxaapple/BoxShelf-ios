// Device test pass "pcgames" (beta.4), run by web-device-test.js. Checks results, never speed.
//   Node (main/pcgames.js on made-up folders): Epic's install list keeps installed games only (not the engine, plugins or
//   half-installed ones) and starts them through the launcher's link; Quiver 3 (apps.json beside its program) and Quiver 4
//   (installs.json + library.json) give each installed app its program and name; games added by hand whose program is
//   gone are left out; a saved config keeps only clean entries.
//   The demo page as Windows with ?pcx=1: the PC shelf has the Epic game, a Custom shelf has the Quiver recomp; Play on it
//   goes through launch:pc by id (and back to the shelf when it closes), the Epic game says it starts through Epic;
//   Settings → Custom games adds a program, names it, removes it (twice); Settings → PC games has the Epic switch.
'use strict';
const path = require('path'), fs = require('fs'), os = require('os');

module.exports = async function pcGamesPass({ browser, base, check, newPage }) {
  const root = path.resolve(__dirname, '..', '..');
  // (beta.9) main/pccovers.js with no SteamGridDB key: a Steam game Steam kept no cover for gets Steam's store cover (2x
  // first, 1x if that fails); a custom game gets the Steam games of its exact name (asked exactly), a typed name loosely
  try {
    const pcc = require(path.join(root, 'main', 'pccovers.js')), d = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-pcc-')), asked = [], got = [];
    const img = Buffer.alloc(3000, 7); img[0] = 0xff; img[1] = 0xd8; // (beta.10: a JPEG's first bytes: downloads that aren't pictures are refused now)
    pcc.init({ dataDir: d, log: () => {}, fileUrl: f => 'bsfile:///' + f, steamCover: () => null, steamgrid: { enabled: () => false },
      fetchImage: async u => { got.push(u); return /_2x/.test(u) ? null : img; }, steamSearch: async (t, exact) => { asked.push([t, exact]); return /hollow/i.test(t) ? [{ id: '367520', name: 'Hollow Knight' }] : []; } });
    const st = await pcc.options({ id: 'steam-1145360', appid: '1145360', title: '' });
    const cu = await pcc.options({ id: 'custom-hollow', title: 'Hollow Knight' }), none = await pcc.options({ id: 'custom-x', title: 'Zzq' }), typed = await pcc.options({ id: 'custom-x', title: 'hollow', term: true });
    got.length = 0; const used = await pcc.use('custom-hollow', 'st0');
    check('PC covers (node): with no SteamGridDB key a Steam game gets Steam\'s store cover, a custom game the Steam game of its name (asked exactly, a typed name loosely), none when Steam has none; Use takes the sharpest that downloads',
      !st.sgdb && st.list.length === 1 && st.list[0].source === 'steamstore' && cu.list.length === 1 && /Hollow Knight on Steam/.test(cu.list[0].sub) && none.list.length === 0
        && typed.list.length === 1 && asked.some(a => a[0] === 'Hollow Knight' && a[1] === true) && asked.some(a => a[0] === 'hollow' && a[1] === false)
        && /367520\/library_600x900_2x/.test(got[0]) && fs.existsSync(used) && pcc.cover('custom-hollow') === used, JSON.stringify({ st: st.list, cu: cu.list.map(x => x.sub), none: none.list.length, typed: typed.list.length, asked, got }).slice(0, 600));
    fs.rmSync(d, { recursive: true, force: true });
  } catch (e) { check('PC covers (node) ran to the end', false, e && e.stack ? e.stack.split('\n').slice(0, 2).join(' ') : e); }
  try {
    const pcg = require(path.join(root, 'main', 'pcgames.js'));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-pc-'));
    const mk = (p, body) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };
    // Epic: a game, the engine, a plugin, a half-installed game, a game whose folder is gone
    const man = path.join(tmp, 'Manifests'), inst = path.join(tmp, 'Epic Games');
    mk(path.join(inst, 'Ember', 'Ember.exe'), 'MZ'); mk(path.join(inst, 'UE', 'x'), ''); mk(path.join(inst, 'Half', 'x'), '');
    const item = (f, o) => mk(path.join(man, f + '.item'), JSON.stringify(o));
    item('a', { DisplayName: 'Ember Trail', AppName: 'Ember', CatalogNamespace: 'ns1', CatalogItemId: 'it1', InstallLocation: path.join(inst, 'Ember'), LaunchExecutable: 'Ember.exe', AppCategories: ['public', 'games', 'applications'] });
    item('b', { DisplayName: 'Unreal Engine', AppName: 'UE_5.4', InstallLocation: path.join(inst, 'UE'), AppCategories: ['engines'] });
    item('c', { DisplayName: 'A Plugin', AppName: 'plug', InstallLocation: path.join(inst, 'UE'), AppCategories: ['plugins'] });
    item('d', { DisplayName: 'Half Done', AppName: 'Half', InstallLocation: path.join(inst, 'Half'), bIsIncompleteInstall: true, AppCategories: ['games'] });
    item('e', { DisplayName: 'Gone', AppName: 'Gone', InstallLocation: path.join(inst, 'Gone'), AppCategories: ['games'] });
    const epic = pcg.epicGames(man);
    check('PC games: Epic lists installed games only, started through the Epic launcher\'s link',
      epic.length === 1 && epic[0].title === 'Ember Trail' && epic[0].uri === 'com.epicgames.launcher://apps/ns1%3Ait1%3AEmber?action=launch&silent=true', JSON.stringify(epic));
    // Quiver 3 (portable): apps.json + settings.json beside its program, the games in Apps\<folder>; one listed app not installed
    const q3 = path.join(tmp, 'QuiverLauncher-win-Portable');
    mk(path.join(q3, 'QuiverLauncher.exe'), 'MZ');
    mk(path.join(q3, 'apps.json'), JSON.stringify({ apps: [{ name: 'Quarantine', folderName: 'Quarantine-Recomp', installPath: null, appIconUrl: 'https://cdn.example/icon.png', repository: 'acr/quarantine', tags: ['recomp'] }, { name: 'Not Installed', folderName: 'Nope', repository: 'x/nope' }] }));
    mk(path.join(q3, 'settings.json'), JSON.stringify({ AppsPath: '', UserAppDisplayNames: {} }));
    mk(path.join(q3, 'Apps', 'Quarantine-Recomp', 'Quarantine.exe'), 'MZ' + 'x'.repeat(5000)); mk(path.join(q3, 'Apps', 'Quarantine-Recomp', 'unins000.exe'), 'MZ' + 'x'.repeat(9000));
    const g3 = pcg.quiverGames(q3);
    check('PC games: Quiver 3 gives each installed app its program and name (not the uninstaller, not apps that aren\'t installed)',
      g3.length === 1 && g3[0].title === 'Quarantine' && /Quarantine\.exe$/.test(g3[0].exe) && g3[0].source === 'quiver', JSON.stringify(g3.map(g => ({ t: g.title, e: path.basename(g.exe) }))));
    // Quiver 4: installs.json + library.json (the player's own name wins)
    const q4 = path.join(tmp, 'q4');
    mk(path.join(q4, 'installs.json'), JSON.stringify({ 'github:a/ship': { version: '1', folder: 'Ship', executables: ['soh.exe'] } }));
    mk(path.join(q4, 'library.json'), JSON.stringify([{ id: 'github:a/ship', slug: 'ship', overrides: { name: 'Ship of Harkinian' } }]));
    mk(path.join(q4, 'apps', 'Ship', 'soh.exe'), 'MZ');
    const g4 = pcg.quiverGames(q4);
    check('PC games: Quiver 4 gives each install its program and the name the player chose',
      g4.length === 1 && g4[0].title === 'Ship of Harkinian' && /soh\.exe$/.test(g4[0].exe), JSON.stringify(g4.map(g => ({ t: g.title, e: path.basename(g.exe) }))));
    // games added by hand: a missing program is left out; the config keeps clean entries only
    const c = pcg.customGames([{ id: 'a', title: 'Mine', exe: path.join(q3, 'QuiverLauncher.exe') }, { id: 'b', title: 'Gone', exe: path.join(tmp, 'gone.exe') }]);
    const config = require(path.join(root, 'main', 'config.js'));
    const clean = config.normalize({ pc: { custom: [{ title: 'Ok', exe: 'C:\\x.exe' }, { title: 'No exe' }, 'junk'], epic: 'yes' } }).pc;
    fs.rmSync(tmp, { recursive: true, force: true });
    check('PC games: a hand-added game whose program is gone is left out; a saved config keeps clean entries only',
      c.length === 1 && c[0].title === 'Mine' && clean.custom.length === 1 && clean.custom[0].exe === 'C:\\x.exe' && clean.epic === true, JSON.stringify({ c, clean }));
    // (beta.7) the new stores, from made-up installs: the registry's text (GOG, Ubisoft), EA's installer file, Xbox's game config
    const reg = pcg.parseReg('\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\GOG.com\\Games\\1207658924\r\n    gameName    REG_SZ    Lantern Keep\r\n    path    REG_SZ    C:\\GOG Games\\Lantern Keep\r\n    dependsOn    REG_SZ    \r\n\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher\\Installs\\4740\r\n    InstallDir    REG_SZ    C:/Ubisoft/Harbor Run/\r\n');
    const g1 = reg.get('HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\GOG.com\\Games\\1207658924') || {}, u1 = reg.get('HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher\\Installs\\4740') || {};
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'bxstores-'));
    const ea = path.join(tmp2, 'EA Games', 'Dust Rally'); fs.mkdirSync(path.join(ea, '__Installer'), { recursive: true }); fs.writeFileSync(path.join(ea, 'DustRally.exe'), 'x'.repeat(5000));
    fs.writeFileSync(path.join(ea, '__Installer', 'installerdata.xml'), '<DiPManifest><contentIDs><contentID>Origin.OFR.50.0001234</contentID><contentID>1234567</contentID></contentIDs><gameTitles><gameTitle locale="de_DE">Staub</gameTitle><gameTitle locale="en_US">Dust Rally &amp; Friends</gameTitle></gameTitles></DiPManifest>');
    const xb = path.join(tmp2, 'XboxGames'); fs.mkdirSync(path.join(xb, 'Lumen Garden', 'Content'), { recursive: true }); fs.mkdirSync(path.join(xb, 'GameSave', 'Content'), { recursive: true });
    fs.writeFileSync(path.join(xb, 'Lumen Garden', 'Content', 'MicrosoftGame.config'), '<Game><Identity Name="Studio.LumenGarden" Publisher="CN=Studio" Version="1.0.0.0"/><ExecutableList><Executable Name="Lumen.exe" Id="Game"/></ExecutableList><ShellVisuals DefaultDisplayName="Lumen Garden"/></Game>');
    const eaL = pcg.eaFromDirs([ea]), xbL = pcg.xboxScan([xb]);
    fs.rmSync(tmp2, { recursive: true, force: true });
    check('PC stores: GOG and Ubisoft registry entries read; an EA game\'s title and EA app link; an Xbox game\'s package and title (GameSave skipped)',
      g1.gamename === 'Lantern Keep' && g1.dependson === '' && u1.installdir === 'C:/Ubisoft/Harbor Run/' &&
      eaL.length === 1 && eaL[0].title === 'Dust Rally & Friends' && eaL[0].uri === 'origin2://game/launch?offerIds=Origin.OFR.50.0001234%2C1234567&autoDownload=1' &&
      xbL.length === 1 && xbL[0].name === 'Studio.LumenGarden' && xbL[0].appId === 'Game' && xbL[0].title === 'Lumen Garden', JSON.stringify({ g1, u1, eaL, xbL }));
    const cl2 = config.normalize({ pc: {} }).pc;
    check('PC stores: the four store switches default to on', ['gog', 'ubisoft', 'ea', 'xbox'].every(k => cl2[k] === true), JSON.stringify(cl2));
  } catch (e) { check('PC games: module checks ran', false, e && e.stack ? e.stack.split('\n').slice(0, 2).join(' ') : e); }

  const { ctx, page, errors } = await newPage(browser, null);
  try {
    await page.goto(base + '?platform=windows&shelf=1&pcx=1');
    await page.waitForFunction(() => window.Shelf && Shelf._qs && Shelf._qs().g && window.Setup, null, { timeout: 90000, polling: 250 });
    await page.waitForTimeout(1500);
    const sh = await page.evaluate(() => ({ counts: Shelf.gameCounts(), tabs: [...document.querySelectorAll('#tabs > *')].map(e => e.textContent.trim()) }));
    check('PC games (Windows): a Custom shelf (its own tab) holds the Quiver recomp; the PC shelf has one more game (Epic\'s)',
      sh.tabs.includes('Custom') && sh.counts.custom === 1 && sh.counts.pc >= 1, JSON.stringify(sh)); // (the demo has no Steam folder: PC holds Epic's game only)
    // to the Custom shelf (↓ walks the shelves), then Play: launch:pc by id, the launch screen, back to the shelf when it closes
    const play = await page.evaluate(async () => { const w = ms => new Promise(r => setTimeout(r, ms));
      const key = k => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
      const word = () => (document.getElementById('sysWord') || {}).textContent || '';
      for (let i = 0; i < 20 && !/Custom/i.test(word()); i++) { key('ArrowDown'); await w(500); }
      const out = { shelf: word(), game: Shelf._qs().g };
      key('i'); await w(900); out.how = ((document.getElementById('dDesc') || {}).textContent || '') + ' ' + ((document.getElementById('dHow') || {}).textContent || ''); out.chips = ((document.getElementById('dChips') || {}).textContent || ''); key('i'); await w(700);
      key('Enter'); await w(1500); out.mode = Shelf.getMode(); out.launched = (window.__pcLaunched || []).slice();
      for (let i = 0; i < 40 && Shelf.getMode() !== 'browse'; i++) await w(250); out.back = Shelf.getMode();
      // the PC shelf's Epic game: details say Epic, Play hands it to the Epic launcher by id, Back returns to the shelf
      for (let i = 0; i < 20 && !word().trim().startsWith('PC'); i++) { key('ArrowUp'); await w(500); } // (the word carries its tagline)
      for (let i = 0; i < 10 && Shelf._qs().g !== 'Ember Trail'; i++) { key('ArrowRight'); await w(350); }
      out.epic = { shelf: word(), game: Shelf._qs().g };
      if (out.epic.game !== 'Ember Trail') return out; // never Play some other game
      key('i'); await w(900); out.epic.how = ((document.getElementById('dDesc') || {}).textContent || '') + ' ' + ((document.getElementById('dHow') || {}).textContent || ''); out.epic.chips = ((document.getElementById('dChips') || {}).textContent || ''); key('i'); await w(700);
      key('Enter'); await w(1600); out.epic.launched = (window.__pcLaunched || []).includes('epic-ember-trail'); out.epic.mode = Shelf.getMode();
      key('Escape'); for (let i = 0; i < 20 && Shelf.getMode() !== 'browse'; i++) await w(250); out.epic.back = Shelf.getMode(); return out; });
    check('PC games (Windows): the Epic game on the PC shelf says it starts through Epic, Play hands it over by id, Back returns',
      play.epic.game === 'Ember Trail' && /Epic/.test(play.epic.how) && /Epic Games/.test(play.epic.chips) && play.epic.launched && play.epic.back === 'browse', JSON.stringify(play.epic));
    // (beta.7) the new stores on the PC shelf: each game names its store; Ubisoft's is handed to Ubisoft Connect (Back returns),
    // GOG's is started by Boxshelf like an app (the shelf comes back when it closes)
    const st7 = await page.evaluate(async () => { const w = ms => new Promise(r => setTimeout(r, ms)), out = {};
      const key = k => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
      const go = async t => { for (let i = 0; i < 12 && Shelf._qs().g !== t; i++) { key('ArrowRight'); await w(350); } if (Shelf._qs().g !== t) for (let i = 0; i < 12 && Shelf._qs().g !== t; i++) { key('ArrowLeft'); await w(350); } return Shelf._qs().g === t; };
      out.chips = {};
      for (const [t, src] of [['Lantern Keep', 'GOG'], ['Harbor Run', 'Ubisoft'], ['Dust Rally', 'EA'], ['Lumen Garden', 'Xbox']]) {
        if (!(await go(t))) { out.chips[t] = 'not found'; continue; }
        key('i'); await w(800); out.chips[t] = ((document.getElementById('dChips') || {}).textContent || '') + ' | ' + ((document.getElementById('dHow') || {}).textContent || ''); key('i'); await w(600); }
      if (await go('Harbor Run')) { key('Enter'); await w(1600); out.ubi = { launched: (window.__pcLaunched || []).includes('ubisoft-4740'), mode: Shelf.getMode(), note: (document.getElementById('launch') || {}).textContent || '' };
        key('Escape'); for (let i = 0; i < 20 && Shelf.getMode() !== 'browse'; i++) await w(250); out.ubi.back = Shelf.getMode(); }
      if (await go('Lantern Keep')) { key('Enter'); await w(1500); out.gog = { launched: (window.__pcLaunched || []).includes('gog-1207658924'), mode: Shelf.getMode() };
        for (let i = 0; i < 40 && Shelf.getMode() !== 'browse'; i++) await w(250); out.gog.back = Shelf.getMode(); }
      return out; });
    check('PC stores (Windows): GOG, Ubisoft, EA and Xbox games are on the PC shelf, each naming its store in Details',
      ['GOG', 'Ubisoft', 'EA', 'Xbox'].every((s, i) => new RegExp(s).test(st7.chips[['Lantern Keep', 'Harbor Run', 'Dust Rally', 'Lumen Garden'][i]] || '')), JSON.stringify(st7.chips));
    check('PC stores (Windows): a Ubisoft game is handed to Ubisoft Connect (Back returns); a GOG game is started by Boxshelf and the shelf comes back',
      !!st7.ubi && st7.ubi.launched && /Ubisoft Connect/.test(st7.ubi.note) && st7.ubi.back === 'browse' && !!st7.gog && st7.gog.launched && st7.gog.mode === 'launch' && st7.gog.back === 'browse', JSON.stringify({ ubi: st7.ubi, gog: st7.gog }));
    check('PC games (Windows): Play on a Custom shelf game starts it by id (launch:pc) and the shelf comes back when it closes',
      /Custom/i.test(play.shelf) && play.game === 'Quarantine' && play.launched.includes('quiver-quarantine') && play.mode === 'launch' && play.back === 'browse', JSON.stringify(play));
    check('PC games (Windows): a Quiver game says where it came from (no Steam wording)', /Quiver/.test(play.how + play.chips) && !/Steam/.test(play.how), JSON.stringify({ how: play.how, chips: play.chips }));
    // Settings → Custom games: add a program (named from its file), rename it, remove it (twice); PC games has the Epic switch
    const st = await page.evaluate(async () => { const w = ms => new Promise(r => setTimeout(r, ms)), out = {};
      const names = () => [...document.querySelectorAll('#bss .bss-row .nm')].map(e => e.textContent);
      const row = n => [...document.querySelectorAll('#bss .bss-row')].find(r => ((r.querySelector('.nm') || {}).textContent || '') === n);
      const cfg = async () => (await window.boxshelf.getConfig()).config.pc || {};
      for (let i = 0; i < 40 && Shelf.getMode() !== 'browse'; i++) await w(250); // (Settings opens from the shelf only)
      Setup.open({ page: 'pc' }); for (let i = 0; i < 40 && !document.querySelector('#bss.on .bss-row'); i++) await w(150); await w(600);
      out.pcPage = names();
      if (window.Settings && Settings.isOpen && Settings.isOpen()) { await Settings.close(); await w(800); }
      Setup.open({ page: 'custom' }); for (let i = 0; i < 40 && !row('Add games'); i++) await w(150); await w(800); // (beta.7: Add games, a page of its own)
      out.page = names(); out.quiverRow = (row('Quiver Launcher') || {}).textContent || '';
      row('Add games').click(); for (let i = 0; i < 40 && !row('Add one program'); i++) await w(150); await w(400); row('Add one program').click(); await w(1200); out.added = (await cfg()).custom;
      if (window.Settings && Settings.isOpen && Settings.isOpen()) { await Settings.close(); await w(800); }
      Setup.open({ page: 'custom' }); for (let i = 0; i < 40 && !row('Add games'); i++) await w(150); await w(800); out.after = names();
      const rm = names().find(n => /^Remove /.test(n)); if (rm) { row(rm).click(); await w(300); row(rm).click(); await w(1200); }
      out.removed = (await cfg()).custom;
      if (window.Settings && Settings.isOpen && Settings.isOpen()) { await Settings.close(); await w(800); } return out; });
    check('PC games (Windows): Settings → PC games has the Epic switch; Custom games has Quiver and Add games',
      st.pcPage.includes('Show installed Epic Games') && st.page.includes("Show Quiver's games") && st.page.includes('Add games') && /Found/.test(st.quiverRow), JSON.stringify({ pc: st.pcPage, page: st.page, q: st.quiverRow }).slice(0, 500));
    check('PC games (Windows): Add games → Add one program puts it on the Custom shelf named from its file; Remove (pressed twice) takes it off',
      (st.added || []).length === 1 && st.added[0].title === 'program' && /program\.exe$/.test(st.added[0].exe) && st.after.includes('program') && (st.removed || []).length === 0, JSON.stringify({ added: st.added, removed: st.removed }).slice(0, 400));
    // (beta.5) a PC game's cover picker: Details → Box art opens it with the options (SteamGridDB's, a picture of yours);
    // the arrows move, A uses one (by key), the picker closes and the shelf says so; opened again, Automatic cover is offered
    const cv = await page.evaluate(async () => { const w = ms => new Promise(r => setTimeout(r, ms));
      const key = k => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
      for (let i = 0; i < 40 && Shelf.getMode() !== 'browse'; i++) await w(250);
      const word = () => (document.getElementById('sysWord') || {}).textContent || '';
      for (let i = 0; i < 20 && !/^Custom/.test(word().trim()); i++) { key('ArrowDown'); await w(500); }
      const out = { game: Shelf._qs().g };
      // (beta.9) a PC game's Box art is in the main row beside Play (consoles keep theirs in More): the More one stays hidden
      key('i'); await w(900); const btn = document.getElementById('dBoxArtPc'), inMore = document.getElementById('dBoxArt');
      out.button = !!btn && !btn.hidden && !btn.closest('#dMenu') && btn.getBoundingClientRect().width > 0 && !!inMore && inMore.hidden; if (btn) btn.click(); await w(900);
      const tiles = () => [...document.querySelectorAll('.coverpick .cp-tile')].map(t => t.textContent.trim());
      out.mode = Shelf.getMode(); out.tiles = tiles(); out.note = ((document.querySelector('.coverpick .cp-note') || {}).textContent || '');
      out.at = ((document.querySelector('.coverpick .cp-tile.on') || {}).textContent || '').trim();
      key('ArrowRight'); await w(200); out.moved = ((document.querySelector('.coverpick .cp-tile.on') || {}).textContent || '').trim();
      key('Enter'); await w(900); out.used = Object.assign({}, window.__pcCovers || {}); out.after = Shelf.getMode(); out.toast = ((document.getElementById('toast') || {}).textContent || '');
      key('i'); await w(900); const b2 = document.getElementById('dBoxArtPc'); if (b2) b2.click(); await w(900); out.again = tiles();
      key('Escape'); await w(500); out.closed = Shelf.getMode();
      // Search by name: the picker's first tile → Settings' Search for page → Enter → the picker again, for that name
      key('i'); await w(900); const b3 = document.getElementById('dBoxArtPc'); if (b3) b3.click(); await w(900);
      const first = document.querySelector('.coverpick .cp-tile'); out.searchTile = first ? first.textContent.trim() : ''; if (first) first.click();
      for (let i = 0; i < 40 && !document.querySelector('#bss.on .bss-row'); i++) await w(150); await w(600);
      out.searchPage = (document.querySelector('#bss .bss-title') || {}).textContent || '';
      out.searchRows = [...document.querySelectorAll('#bss .bss-row .nm')].map(e => e.textContent).slice(0, 6);
      key('Enter'); await w(400); const inp = document.querySelector('#bss .bss-edit'); if (inp) { inp.value = 'Quarantine 1994'; inp.dispatchEvent(new Event('input', { bubbles: true })); } key('Enter');
      for (let i = 0; i < 30 && Shelf.getMode() !== 'cover'; i++) await w(200); await w(600);
      out.searchMode = Shelf.getMode(); out.term = window.__pcCoverTerm; out.searchNote = ((document.querySelector('.coverpick .cp-note') || {}).textContent || '');
      key('Escape'); await w(500); return out; });
    check('PC games (Windows): Box art on a PC game opens the cover picker (SteamGridDB covers, a picture of yours); A uses one and the picker closes; Automatic cover is offered after',
      cv.button && cv.mode === 'cover' && cv.tiles.length >= 4 && cv.tiles.some(t => /A picture of yours/.test(t)) && /SteamGridDB/.test(cv.at) && cv.moved !== cv.at && /3 covers from SteamGridDB/.test(cv.note)
        && cv.used['quiver-quarantine'] === 'sg1' && cv.after === 'browse' && /New cover for Quarantine/.test(cv.toast) && cv.again.some(t => /Automatic cover/.test(t)) && cv.closed === 'browse', JSON.stringify(cv).slice(0, 600));
    check('PC games (Windows): the cover picker\'s Search by name opens a Search for page; Enter brings the picker back with covers for the typed name',
      /Search by name/.test(cv.searchTile) && /Search for a cover/.test(cv.searchPage) && cv.searchMode === 'cover' && cv.term === 'Quarantine 1994' && /for "Quarantine 1994"/.test(cv.searchNote), JSON.stringify({ t: cv.searchTile, p: cv.searchPage, rows: cv.searchRows, m: cv.searchMode, term: cv.term, n: cv.searchNote }));
    // (beta.9) no SteamGridDB key: the picker still has Steam's store cover and Search by name, plus a lit "Add SteamGridDB"
    // slot after the covers; it opens that key's page in Settings, and closing Settings brings the picker back for the game
    const nk = await page.evaluate(async () => { const w = ms => new Promise(r => setTimeout(r, ms)), out = {};
      const key = k => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
      for (let i = 0; i < 40 && Shelf.getMode() !== 'browse'; i++) await w(250);
      window.__noSgdb = true; out.game = Shelf._qs().g;
      key('i'); await w(900); const b = document.getElementById('dBoxArtPc'); if (b) b.click(); for (let i = 0; i < 20 && !document.querySelector('.coverpick .cp-tile'); i++) await w(150); await w(300);
      const tiles = [...document.querySelectorAll('.coverpick .cp-tile')]; out.tiles = tiles.map(t => t.textContent.trim());
      out.note = ((document.querySelector('.coverpick .cp-note') || {}).textContent || ''); const last = tiles[tiles.length - 1];
      out.slotLast = !!last && last.classList.contains('acct') && /Add SteamGridDB/.test(last.textContent);
      out.at = ((document.querySelector('.coverpick .cp-tile.on') || {}).textContent || '').trim();
      if (last) last.click(); for (let i = 0; i < 30 && !(window.Settings && Settings.isOpen && Settings.isOpen()); i++) await w(150); await w(900);
      out.settings = !!(window.Settings && Settings.isOpen && Settings.isOpen()); out.page = ((document.getElementById('bss') || {}).textContent || '').includes('SteamGridDB');
      if (out.settings) { await Settings.close(); } for (let i = 0; i < 30 && Shelf.getMode() !== 'cover'; i++) await w(150); await w(400);
      out.back = Shelf.getMode(); out.backGame = ((document.querySelector('.coverpick .bp-game') || {}).textContent || '');
      key('Escape'); await w(500); out.closed = Shelf.getMode(); window.__noSgdb = false; return out; });
    check('PC games (Windows): with no SteamGridDB key the cover picker offers Steam\'s cover and Search by name, and a lit Add SteamGridDB slot that opens its page; closing Settings brings the picker back',
      nk.tiles.some(t => /Steam's cover/.test(t)) && nk.tiles.some(t => /Search by name/.test(t)) && /Steam's cover/.test(nk.at) && nk.slotLast && /free SteamGridDB key/.test(nk.note)
        && nk.settings && nk.page && nk.back === 'cover' && nk.backGame === nk.game && nk.closed === 'browse', JSON.stringify(nk).slice(0, 700));
    // (beta.5) Details → Rename: Settings' Rename page; Enter saves the name, the shelf shows it; Use the file's name puts it back
    const rn = await page.evaluate(async () => { const w = ms => new Promise(r => setTimeout(r, ms)), out = {};
      const key = k => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
      for (let i = 0; i < 40 && Shelf.getMode() !== 'browse'; i++) await w(250);
      out.before = Shelf._qs().g;
      key('i'); await w(900); const b = document.getElementById('dRename'); out.button = !!b && !b.hidden; if (b) b.click();
      for (let i = 0; i < 40 && !document.querySelector('#bss.on .bss-row'); i++) await w(150); await w(700);
      out.page = (document.querySelector('#bss .bss-title') || {}).textContent || '';
      out.rows = [...document.querySelectorAll('#bss .bss-row')].map(r => r.textContent.replace(/\s+/g, ' ').trim().slice(0, 40)); out.cur = ((document.querySelector('#bss .bss-row.cur') || {}).textContent || '').slice(0, 40);
      // type the new name into the Name row (Settings' own text editing: Enter starts, typing, Enter saves)
      key('Enter'); await w(400); // (the page opens on its Name row: Enter starts editing it)
      const inp = document.querySelector('#bss .bss-edit'); out.editing = !!inp; if (inp) { inp.value = 'Quarantine DOS'; inp.dispatchEvent(new Event('input', { bubbles: true })); }
      key('Enter'); await w(1200);
      out.saved = ((await window.boxshelf.getConfig()).config.games || {})['quiver-quarantine'];
      out.resetRow = [...document.querySelectorAll('#bss .bss-row .nm')].some(e => e.textContent === "Use the file's name");
      if (window.Settings && Settings.isOpen && Settings.isOpen()) { await Settings.close(); await w(1500); }
      for (let i = 0; i < 20 && Shelf._qs().g !== 'Quarantine DOS'; i++) await w(250); out.after = Shelf._qs().g;
      // and back: Rename → Use the file's name
      key('i'); await w(900); const b2 = document.getElementById('dRename'); if (b2) b2.click(); for (let i = 0; i < 40 && !document.querySelector('#bss.on .bss-row'); i++) await w(150); await w(700);
      const rr = [...document.querySelectorAll('#bss .bss-row')].find(r => ((r.querySelector('.nm') || {}).textContent || '') === "Use the file's name"); if (rr) rr.click(); await w(1200);
      if (window.Settings && Settings.isOpen && Settings.isOpen()) { await Settings.close(); await w(1500); }
      for (let i = 0; i < 20 && Shelf._qs().g !== 'Quarantine'; i++) await w(250); out.back = Shelf._qs().g; return out; });
    check('PC games (Windows): Details → Rename saves a game\'s own name (the shelf shows it), and Use the file\'s name puts it back',
      rn.button && /Rename/.test(rn.page) && rn.saved && rn.saved.title === 'Quarantine DOS' && rn.resetRow && rn.after === 'Quarantine DOS' && rn.back === 'Quarantine', JSON.stringify(rn).slice(0, 500));
    // (beta.9) covers for every custom game: one by one in the picker ("1 of N", A uses SteamGridDB's best), then the best
    // match for each in one go, and Undo
    const bt = await page.evaluate(async () => { const w = ms => new Promise(r => setTimeout(r, ms)), out = {};
      const key = k => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
      for (let i = 0; i < 40 && Shelf.getMode() !== 'browse'; i++) await w(250);
      window.__pcCovers = {}; const missing = await window.boxshelf.pcCoverMissing(); out.n = missing.length; out.titles = [];
      Shelf.pcCoverBatch();
      for (let k = 0; k < out.n; k++) { let t = ''; for (let i = 0; i < 80; i++) { await w(250); const el = document.querySelector('.coverpick.on .bp-title'); if (el && /of \d/.test(el.textContent) && !out.titles.includes(el.textContent) && document.querySelector('.coverpick.on .cp-tile.on')) { t = el.textContent; break; } } // (slow build machines: up to 20 s)
        out.titles.push(t); key('Enter'); await w(700); }
      for (let i = 0; i < 20 && Shelf.getMode() !== 'browse'; i++) await w(200);
      out.chosen = Object.keys(window.__pcCovers || {}).length; out.modeAfter = Shelf.getMode();
      window.__pcCovers = {}; const a = await Shelf.pcCoverAuto(); out.auto = a && a.n; out.undoN = Shelf.coverUndoCount(); out.afterAuto = Object.keys(window.__pcCovers).length;
      out.undone = await Shelf.pcCoverUndo(); out.afterUndo = Object.keys(window.__pcCovers).length; return out; });
    check('PC games (Windows): covers for every custom game: one by one ("1 of N", A uses the best match), or the best for each at once, with Undo',
      bt.n >= 1 && bt.titles.length === bt.n && /1 of \d/.test(bt.titles[0]) && bt.chosen === bt.n && bt.modeAfter === 'browse' && bt.auto === bt.n && bt.undoN === bt.n && bt.afterAuto === bt.n && bt.undone === bt.n && bt.afterUndo === 0, JSON.stringify(bt));
    check('PC games pass (Windows page): no script errors', !errors.length, errors.slice(0, 3).join(' | '));
  } catch (e) { check('PC games pass (Windows page) ran to the end', false, e && e.stack ? e.stack.split('\n').slice(0, 2).join(' ') : e); }
  await ctx.close();

  // (beta.4) a big library (?big=3000: 3,000 games on every console): the shelf builds only the cases near the one in view,
  // so the page stays small however far you scroll or page through (measured: 21,000 games, ~27 cases, ~30 MB)
  const big = await newPage(browser, null);
  try {
    await big.page.goto(base + '?platform=windows&shelf=1&big=3000');
    await big.page.waitForFunction(() => window.Shelf && Shelf._qs && Shelf._qs().g && Shelf.getMode() === 'browse', null, { timeout: 120000, polling: 250 });
    const b = await big.page.evaluate(async () => { const w = ms => new Promise(r => setTimeout(r, ms));
      const key = k => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
      const total = Object.values(Shelf.gameCounts()).reduce((a, x) => a + x, 0); let most = 0;
      for (let i = 0; i < 40; i++) { key('ArrowRight'); await w(90); most = Math.max(most, document.querySelectorAll('#track > *').length); }
      for (let i = 0; i < 15; i++) { key('e'); await w(160); most = Math.max(most, document.querySelectorAll('#track > *').length); }
      key('ArrowDown'); await w(900); most = Math.max(most, document.querySelectorAll('#track > *').length);
      return { total, most, nodes: document.getElementsByTagName('*').length, game: Shelf._qs().g }; });
    check('Big library (21,000 games): the shelf keeps only the cases near the one in view (the page stays small while scrolling)',
      b.total >= 20000 && b.most > 0 && b.most <= 60 && b.nodes < 4000 && !!b.game, JSON.stringify(b));
    check('Big library pass: no script errors', !big.errors.length, big.errors.slice(0, 3).join(' | '));
  } catch (e) { check('Big library pass ran to the end', false, e && e.stack ? e.stack.split('\n').slice(0, 2).join(' ') : e); }
  await big.ctx.close();
};
