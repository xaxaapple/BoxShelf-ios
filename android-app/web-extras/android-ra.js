// Boxshelf on Android (0.3.5): RetroAchievements. Until now the Android adapter answered every RetroAchievements call
// with "not here" (raEnabled → off, Test → "Not used on Android yet"), so the shelf never asked for anything. This file
// backs the same calls the Windows build has (main/ra.js): raEnabled, raProfile, raShelf, raProgress, onRaUnlocks, and
// Settings → Accounts → RetroAchievements → Test, with the RetroAchievements Web API (username + web API key).
//   - The key never passes through the page: the native side adds the saved username and key to the address (httpText
//     with ra: true, as ScreenScraper's sign-in is added), and only for retroachievements.org's API.
//   - Games are matched by title against the console's list of games with achievement sets (as on Windows), and, for
//     the cartridge consoles where it's cheap, by RetroAchievements' own hash of the ROM, made natively (raHash: the
//     file never crosses the bridge). A hash is only made when the title isn't an exact match, once per file.
//   - Answers are cached (the API is rate-limited): console game lists for a week, your completion list and profile for
//     a few hours, a game's achievements for a day; whatever you just played is asked again when you come back, along
//     with the achievements you unlocked meanwhile (shown on the shelf, as on Windows).
//   - Nothing runs while the shelf slides (window.BS_BUSY), and hashing waits while Boxshelf is in the background.
// The emulators' own sign-in (RetroArch, Dolphin, PPSSPP, DuckStation, NetherSX2) can't be set from here on Android:
// their settings live in each app's private storage, and their sign-in needs your password (Boxshelf only has the web
// API key). Settings says to sign in inside the emulator. Windows never loads this file.
(function () {
  'use strict';
  const C = window.BS_ANDROID_CTX, api = window.boxshelf;
  if (!C || !api || !C.N) return; // only with the Android adapter (on the device, or the ?fakeNative=1 pretend device)
  const { N, st, ready, load, store, log, isNative } = C;
  const API = 'https://retroachievements.org/API/', MEDIA = 'https://media.retroachievements.org', SITE = 'https://retroachievements.org';
  // RetroAchievements' console ids for the shelves Boxshelf has on Android (Neo Geo sets are in its Arcade list)
  const CONSOLE_ID = { megadrive: 1, n64: 2, snes: 3, gb: 4, gba: 5, gbc: 6, nes: 7, pcengine: 8, mastersystem: 11, psx: 12, gamegear: 15, gc: 16, nds: 18,
    wii: 19, ps2: 21, arcade: 27, neogeo: 27, saturn: 39, dreamcast: 40, psp: 41, segacd: 9, sega32x: 10, atari2600: 25, atarilynx: 13, wonderswan: 53 }; // (beta.9; DOS has no RetroAchievements)
  // how a console's games are hashed natively (RaHash.java); disc consoles are matched by title only
  const HASH = { nes: 'nes', snes: 'snes', pcengine: 'pce', n64: 'n64', nds: 'nds', gb: 'plain', gbc: 'plain', gba: 'plain', mastersystem: 'plain', gamegear: 'plain',
    megadrive: 'plain', arcade: 'name', neogeo: 'name', sega32x: 'plain', atari2600: 'plain', wonderswan: 'plain' }; // (Lynx and Sega CD: by title)
  const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;
  const LIST_MS = 7 * DAY, DONE_MS = 6 * HOUR, PROFILE_MS = 30 * MIN, GAME_MS = DAY, FORCE_MS = 2 * MIN, RETRY_MS = MIN;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const sysExts = Object.fromEntries(((window.BS_ANDROID && BS_ANDROID.SYSTEMS) || []).map(s => [s.id, (s.extensions || []).filter(e => e !== 'zip' && e !== '7z')]));

  // ---------- the account (Settings → Accounts → RetroAchievements) ----------
  const acc = () => (st.config && st.config.ra) || {};
  const user = () => String(acc().user || '').trim();
  const hasKey = () => !!String(acc().key || '').trim();
  const enabled = () => !!(user() && hasKey() && acc().enabled !== false);

  // ---------- quiet moments ----------
  // never while the shelf slides; bg (hashing): not while Boxshelf is behind a game either
  async function calm(bg) { while ((window.BS_BUSY && window.BS_BUSY()) || (bg && document.hidden)) await sleep(150); }
  let lastYield = 0; // long loops (matching a whole shelf) give the page a frame every ~8 ms
  async function tick() { const t = performance.now(); if (t - lastYield > 8) { await sleep(0); await calm(); lastYield = performance.now(); } }

  // ---------- the Web API ----------
  const err = (msg, code) => Object.assign(new Error(msg), { code });
  let chain = Promise.resolve(); // one request at a time (the API is rate-limited)
  function raGet(endpoint, params) {
    const run = async () => {
      const q = new URLSearchParams(params || {}).toString();
      let r;
      try { r = await N.httpText({ url: `${API}${endpoint}.php${q ? '?' + q : ''}`, ra: true, headers: { Accept: 'application/json' } }); }
      catch { throw err("Couldn't reach RetroAchievements. Check the connection and try again.", 'net'); }
      const s = r && r.status;
      if (s === 429) throw err('RetroAchievements is busy (too many requests). Try again in a minute.', 'busy');
      if (s === 401 || s === 403) throw err("RetroAchievements didn't accept your username or web API key. Check them in Settings → Accounts.", 'auth');
      if (s !== 200) throw err(`RetroAchievements didn't answer (HTTP ${s}). Try again in a moment.`, 'http');
      await calm(); // (a big console list is read in a quiet moment)
      try { return JSON.parse(r.text); } catch { throw err("RetroAchievements sent an answer Boxshelf couldn't read. Try again in a moment.", 'bad'); }
    };
    const p = chain.then(run, run); chain = p.catch(() => {}); return p;
  }
  // the site answers some failures with 200 and an object ({ message, errors })
  const need = v => { if (Array.isArray(v)) return v; throw err(v && typeof v === 'object' && typeof v.message === 'string' && v.message ? 'RetroAchievements: ' + v.message.slice(0, 200) : 'RetroAchievements sent an unexpected answer. Try again in a moment.', 'bad'); };

  // ---------- cache: memory, then a file in Boxshelf's storage, then the site; offline / busy: the last copy ----------
  const mem = new Map(), inflight = new Map(), failed = new Map(), expired = new Set();
  function keep(name, j) { mem.set(name, j); if (mem.size > 90) for (const k of mem.keys()) if (/^ra-game-/.test(k) && k !== name) { mem.delete(k); break; } }
  function saveSoon(name, j) { calm().then(() => store(name, j)); }
  async function cached(name, maxAge, fetch, o) {
    o = o || {};
    let j = mem.get(name);
    if (j === undefined) { await calm(); j = mem.get(name); // (a saved console list can be a MB of JSON: read after the slide)
      if (j === undefined) { j = await load(name, null); if (!j || typeof j !== 'object' || !('data' in j)) j = null; if (!mem.has(name)) keep(name, j); else j = mem.get(name); } }
    if (j && expired.has(name)) { j.at = 0; } expired.delete(name);
    if (j && o.perUser && j.u !== user()) j = null;
    if (j && o.valid && !o.valid(j.data)) j = null;
    if (j && Date.now() - j.at < maxAge) return j.data;
    if (inflight.has(name)) return inflight.get(name);
    const nope = failed.get(name);
    if (!o.force && nope && Date.now() - nope.at < RETRY_MS) { if (j) return j.data; throw nope.err; } // it failed a moment ago: not again for every shelf and Details visit
    const old = j, p = (async () => {
      try { const data = await fetch(); const k = { v: 1, u: user(), at: Date.now(), data }; keep(name, k); failed.delete(name); saveSoon(name, k); return data; }
      catch (e) { failed.set(name, { at: Date.now(), err: e }); if (failed.size > 200) failed.delete(failed.keys().next().value);
        if (old) { log('RetroAchievements: using the saved copy of', name, '(' + e.message + ')'); return old.data; } throw e; }
      finally { inflight.delete(name); }
    })();
    inflight.set(name, p); return p;
  }
  function expire(name) { const j = mem.get(name); if (j) j.at = 0; else expired.add(name); failed.delete(name); }

  // ---------- titles ----------
  // main/ra.js's norm: "The Legend of Zelda: The Wind Waker" = "Legend of Zelda, The - The Wind Waker"
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, ' and ').replace(/['\u2019]/g, '')
    .replace(/\s*\|.*$/, '').replace(/\s*~.*?~\s*/g, ' ').replace(/[^a-z0-9]+/g, ' ').replace(/\b(the|a|an)\b/g, ' ').replace(/\s+/g, ' ').trim();
  const prepped = new WeakMap();
  // a console's list, ready to match: by exact title (real releases ahead of hacks and subsets) and by hash
  function prep(data) {
    let L = prepped.get(data); if (L) return L;
    const games = (data.games || []).map(x => ({ id: x[0], title: String(x[1] || ''), count: +x[2] || 0, points: +x[3] || 0, icon: x[4] || '', n: norm(x[1]), w: null,
      hack: /~\s*hack\s*~|\[subset/i.test(String(x[1] || '')), odd: /~/.test(String(x[1] || '')) }));
    const byN = new Map(), byHash = new Map();
    games.forEach((g, i) => { const o = byN.get(g.n); if (g.n && (!o || (o.odd && !g.odd))) byN.set(g.n, g); for (const h of (data.games[i][5] || [])) byHash.set(String(h).toLowerCase(), g); });
    L = { games, byN, byHash, fz: new Map() }; prepped.set(data, L); return L;
  }
  // main/ra.js's matchGame (prefix / shared words), but never a hack or a subset by a near title
  function byTitle(L, title) {
    const want = norm(title); if (!want) return null;
    const hit = L.byN.get(want); if (hit) return hit;
    if (L.fz.has(want)) return L.fz.get(want);
    const W = new Set(want.split(' ')); let best = null, bs = 0;
    for (const x of L.games) {
      if (x.hack || !x.n) continue;
      let s = 0;
      if (x.n.startsWith(want + ' ') || want.startsWith(x.n + ' ')) { const extra = x.n.length > want.length ? x.n.slice(want.length) : want.slice(x.n.length); if (!/\b(\d+|[ivx]+)\b/.test(extra)) s = .9 - Math.abs(x.n.length - want.length) / 200; }
      else { const G = x.w || (x.w = [...new Set(x.n.split(' '))]); let n = 0; for (const w of G) if (W.has(w)) n++; const j = n / (W.size + G.length - n); if (j >= .75) s = j; }
      if (x.odd) s -= .05; // (~Unlicensed~, ~Prototype~…: only when nothing else is as close)
      if (s > bs) { bs = s; best = x; }
    }
    L.fz.set(want, best); return best;
  }

  // ---------- the console lists (games with achievement sets), cached a week ----------
  async function gameList(sys) {
    const cid = CONSOLE_ID[sys], h = HASH[sys] ? 1 : 0;
    const data = await cached(`ra-list-${cid}.json`, LIST_MS, async () => {
      const list = need(await raGet('API_GetGameList', { i: cid, f: 1, h }));
      return { h, games: list.map(g => [g.ID, g.Title, g.NumAchievements, g.Points, g.ImageIcon || '', h && Array.isArray(g.Hashes) ? g.Hashes.map(x => String(x).toLowerCase()) : []]) };
    }, { valid: d => d && Array.isArray(d.games) && (d.h || 0) >= h }); // (a list saved without hashes is asked again for a console that hashes)
    if (!prepped.has(data)) await calm(); // (indexing a few thousand titles: not mid-slide)
    return prep(data);
  }

  // ---------- the shelf's games, and their hashes ----------
  const shelfGames = sys => { const sh = (st.library || []).find(s => s && s.id === sys); return sh ? (sh.games || []).filter(g => g && g.kind === 'rom') : []; };
  const gameByTitle = (sys, title) => shelfGames(sys).find(g => g.title === title) || null;
  const baseName = f => String(f || '').split('/').pop();
  const hkey = g => `${g.id}|${g.sizeBytes || 0}|${g.added || 0}`; // a changed file is hashed again
  function kindFor(sys, g) {
    const k = HASH[sys], e = String(g.ext || '').toLowerCase(); if (!k) return '';
    if (k === 'name') return 'name';
    if (!g.uri || e === '7z') return '';
    if (sys === 'pcengine' && !/^(pce|sgx|zip)$/.test(e)) return ''; // (CD games: titles)
    if (sys === 'megadrive' && e === '32x') return ''; // (a console of its own on RetroAchievements)
    return k;
  }
  const hz = { db: null, q: [], queued: new Set(), running: false, off: false, found: false };
  async function hashDb() { if (!hz.db) { const d = await load('ra-hash.json', null); hz.db = d && typeof d === 'object' && d.v === 1 && d.h ? d.h : {}; } return hz.db; }
  // the game's match: its hash when RetroAchievements knows it, else its title
  function matchGame(sys, L, g, title) {
    if (g && hz.db) { const h = hz.db[hkey(g)]; if (h && L.byHash.has(h)) return L.byHash.get(h); }
    return byTitle(L, g ? g.title : title);
  }
  // a hash is worth making only where the title isn't an exact match (arcade names cost nothing to hash)
  const wantsHash = (sys, L, g) => { const k = kindFor(sys, g); return !!k && !hz.off && !(hkey(g) in hz.db) && (k === 'name' || !L.byN.has(norm(g.title))); };
  async function hashNow(sys, games) { // → how many of them now match by hash
    if (hz.off || !games.length || typeof N.raHash !== 'function') return 0;
    let r; try { r = await N.raHash({ items: games.map(g => ({ uri: g.uri || '', kind: kindFor(sys, g), name: baseName(g.file), exts: sysExts[sys] || [] })) }); }
    catch (e) { hz.off = true; log('RetroAchievements: hashing not available here', e && e.message); return 0; } // (an older build without raHash)
    const list = (r && Array.isArray(r.hashes)) ? r.hashes : [];
    games.forEach((g, i) => { hz.db[hkey(g)] = String(list[i] || '').toLowerCase(); });
    await calm(); store('ra-hash.json', { v: 1, h: hz.db });
    let L = null; try { L = await gameList(sys); } catch { return 0; }
    return games.filter((g, i) => list[i] && L.byHash.has(String(list[i]).toLowerCase())).length;
  }
  // a shelf's games that need a hash, a few at a time in the background; the shelf is told when new ones matched
  function hashShelf(sys, L) {
    for (const g of shelfGames(sys)) if (!hz.queued.has(g.id) && wantsHash(sys, L, g)) { hz.queued.add(g.id); hz.q.push({ sys, g }); }
    if (!hz.running && hz.q.length) runHashes();
  }
  async function runHashes() {
    hz.running = true;
    try {
      while (hz.q.length && !hz.off) {
        await calm(true);
        const sys = hz.q[0].sys, batch = [];
        while (batch.length < 6 && hz.q.length && hz.q[0].sys === sys) batch.push(hz.q.shift());
        const games = batch.map(x => x.g).filter(g => !(hkey(g) in hz.db));
        if (await hashNow(sys, games)) hz.found = true;
        batch.forEach(x => hz.queued.delete(x.g.id));
      }
    } catch (e) { log('RetroAchievements: hashing stopped', e && e.message); }
    finally { hz.running = false; }
    if (hz.found) { hz.found = false; reloadShelf(); }
  }
  // the shelf asks again (Shelf.raReload: its numbers, the points, the Trophies row)
  async function reloadShelf() { await calm(); try { if (window.Shelf && Shelf.raReload) Shelf.raReload(); } catch (e) { log('RetroAchievements: reload', e && e.message); } }

  // ---------- your progress ----------
  // every game you've played: id → { earned, mastered } (pages of 500; the site's own order, newest first)
  async function completion() {
    const rows = await cached('ra-done.json', DONE_MS, async () => {
      const out = []; let total = Infinity;
      for (let o = 0; o < total && o < 2000; o += 500) {
        const r = await raGet('API_GetUserCompletionProgress', { u: user(), c: 500, o });
        const res = need(r && r.Results); total = +(r && r.Total) || 0;
        for (const x of res) out.push([x.GameID, Math.max(+x.NumAwarded || 0, +x.NumAwardedHardcore || 0), x.HighestAwardKind || null]);
        if (res.length < 500) break;
      }
      return out;
    }, { perUser: true });
    return new Map(rows.map(x => [x[0], { earned: x[1], mastered: x[2] }]));
  }
  const shapeProfile = p => ({ user: p.User, points: +p.TotalPoints || 0, softcore: +p.TotalSoftcorePoints || 0, pic: p.UserPic ? MEDIA + p.UserPic : null, rich: p.RichPresenceMsg || '' });
  let raSt = null; // Settings' status chip (Connected · name · points / not accepted)
  const okSt = p => (raSt = { state: 'ok', at: Date.now(), msg: 'Connected', user: String(p.user || user()), points: +p.points || 0 });
  const failSt = e => (raSt = { state: 'fail', at: Date.now(), msg: e && e.code === 'auth' ? 'Username or key not accepted' : String((e && e.message) || "Didn't work").slice(0, 80) });
  async function profile() {
    try { const p = await cached('ra-profile.json', PROFILE_MS, async () => { const p = await raGet('API_GetUserProfile', { u: user() }); if (!p || !p.User) throw err('No profile came back. Check the username and web API key.', 'auth'); return shapeProfile(p); }, { perUser: true });
      if (!raSt || raSt.state !== 'ok') okSt(p); return p; }
    catch (e) { if (e.code === 'auth') failSt(e); throw e; }
  }
  // one game's achievements (main/ra.js's progress), cached a day; a forced look (Try again, the full list) at most every 2 min
  function gameProgress(id, force) {
    return cached(`ra-game-${id}.json`, force ? FORCE_MS : GAME_MS, async () => {
      const d = await raGet('API_GetGameInfoAndUserProgress', { g: id, u: user(), a: 1 });
      if (!d || typeof d !== 'object' || !d.Achievements) throw err('RetroAchievements sent no achievement list for this game. Try again in a moment.', 'bad');
      const ach = Object.values(d.Achievements || {}).sort((a, b) => (a.DisplayOrder || 0) - (b.DisplayOrder || 0)).map(a => ({
        id: a.ID, title: a.Title, desc: a.Description, points: +a.Points || 0, type: a.Type || a.type || '', badge: `${MEDIA}/Badge/${a.BadgeName}${a.DateEarnedHardcore || a.DateEarned ? '' : '_lock'}.png`,
        earned: !!(a.DateEarned || a.DateEarnedHardcore), hardcore: !!a.DateEarnedHardcore, date: a.DateEarnedHardcore || a.DateEarned || null,
        rarity: a.NumAwarded && d.NumDistinctPlayers ? Math.round(100 * a.NumAwarded / d.NumDistinctPlayers) : null }));
      return { id, title: d.Title || '', console: d.ConsoleName, icon: d.ImageIcon ? MEDIA + d.ImageIcon : null, box: d.ImageBoxArt ? MEDIA + d.ImageBoxArt : null,
        total: ach.length, earned: ach.filter(a => a.earned).length, points: ach.reduce((s, a) => s + a.points, 0), pointsEarned: ach.filter(a => a.earned).reduce((s, a) => s + a.points, 0),
        completion: d.UserCompletion || null, completionHardcore: d.UserCompletionHardcore || null, mastered: d.HighestAwardKind || null, achievements: ach, url: `${SITE}/game/${id}` };
    }, { perUser: true, force: !!force });
  }

  // ---------- window.boxshelf: the calls the shelf makes (preload.js's on Windows) ----------
  const unlockFns = [];
  const ra = {
    raEnabled: async () => { await ready; return { enabled: enabled(), systems: Object.keys(CONSOLE_ID) }; },
    raProfile: async () => { await ready; if (!enabled()) return null; return profile(); },
    // { title: { id, total, earned, mastered } } for a shelf's badges
    raShelf: async (sys, titles) => {
      await ready; if (!enabled() || !CONSOLE_ID[sys]) return {};
      const L = await gameList(sys); await hashDb();
      const done = await completion();
      const byT = new Map(); for (const g of shelfGames(sys)) if (!byT.has(g.title)) byT.set(g.title, g);
      const out = {};
      for (const t of titles || []) {
        await tick();
        const m = matchGame(sys, L, byT.get(t) || null, t); if (!m) continue;
        const r = done.get(m.id);
        out[t] = { id: m.id, total: m.count, earned: r ? r.earned : 0, mastered: r ? r.mastered : null };
      }
      hashShelf(sys, L); // the games whose titles didn't match exactly: by their hash, in the background
      return out;
    },
    // one game's full progress (Details, the achievements list)
    raProgress: async (sys, title, force) => {
      await ready; if (!enabled() || !CONSOLE_ID[sys]) return null;
      const L = await gameList(sys); await hashDb();
      const g = gameByTitle(sys, title);
      if (g && wantsHash(sys, L, g)) { await calm(); await hashNow(sys, [g]); } // (one file: Details waits for it)
      const m = matchGame(sys, L, g, title); if (!m) return null;
      const p = await gameProgress(m.id, force);
      return Object.assign({}, p, { title: p.title || m.title });
    },
    onRaUnlocks: fn => { if (typeof fn === 'function') unlockFns.push(fn); }
  };
  Object.assign(api, ra);
  // Settings → Accounts → RetroAchievements: Test, and its status chip
  const test0 = api.testApi, status0 = api.apiStatus;
  api.testApi = s => String(s || '') === 'ra' ? test() : (test0 ? test0(s) : Promise.resolve({ state: 'fail', msg: 'Not here' }));
  api.apiStatus = async () => { const s = Object.assign({}, status0 ? await status0() : {}); if (raSt) s.ra = Object.assign({}, raSt); return s; };
  async function test() {
    await ready;
    if (!user() || !hasKey()) return (raSt = { state: 'none', at: 0, msg: 'Not set up' });
    for (const k of [...failed.keys()]) failed.delete(k); // a fixed key is tried at once, not after the pause
    try {
      const p = await raGet('API_GetUserProfile', { u: user() });
      if (!p || !p.User) throw err('No profile came back. Check the username and web API key.', 'auth');
      const prof = shapeProfile(p), j = { v: 1, u: user(), at: Date.now(), data: prof }; keep('ra-profile.json', j); saveSoon('ra-profile.json', j);
      return okSt(prof);
    } catch (e) { return failSt(e); }
  }

  // ---------- back from a game: what you unlocked, and fresh numbers ----------
  let played = null;
  const launch0 = api.launchGame;
  if (typeof launch0 === 'function') api.launchGame = async (sys, file) => {
    const r = await launch0(sys, file);
    if (enabled() && CONSOLE_ID[sys]) played = { sys, file, at: Date.now() };
    return r;
  };
  if (N.addListener) Promise.resolve().then(() => N.addListener('resume', () => {
    const p = played; if (!p) return; played = null;
    const mins = (Date.now() - p.at) / MIN;
    setTimeout(() => afterPlay(p, mins).catch(e => log('RetroAchievements after a game:', e && e.message)), 4000); // (the site takes a moment to have them)
  })).catch(e => log('RetroAchievements: resume listener', e && e.message));
  async function afterPlay(p, mins) {
    await ready; if (!enabled()) return;
    await calm();
    expire('ra-done.json'); expire('ra-profile.json');
    try { const L = await gameList(p.sys); await hashDb(); const g = shelfGames(p.sys).find(x => x.file === p.file || (x.discs || []).includes(p.file)); const m = g && matchGame(p.sys, L, g); if (m) expire(`ra-game-${m.id}.json`); } catch {}
    let list = [];
    try {
      const r = await raGet('API_GetUserRecentAchievements', { u: user(), m: Math.max(1, Math.ceil(mins) + 1) });
      list = (Array.isArray(r) ? r : []).map(a => ({ id: a.AchievementID, title: a.Title, desc: a.Description, points: +a.Points || 0, badge: `${MEDIA}/Badge/${a.BadgeName}.png`, game: a.GameTitle, hardcore: +a.HardcoreMode === 1, date: a.Date }));
    } catch (e) { log('RetroAchievements: recent unlocks', e && e.message); }
    await calm();
    if (list.length && unlockFns.length) { unlockFns.forEach(f => { try { f(list); } catch (e) { log('RetroAchievements: unlocks', e && e.message); } }); // (the shelf shows them and asks for fresh numbers)
      setTimeout(reloadShelf, 1500); } // (…and the points by the clock)
    else reloadShelf();
  }

  // ---------- Settings: what the row says on Android ----------
  const prevPatch = window.BS_SETTINGS_PATCH;
  window.BS_SETTINGS_PATCH = (sections, h) => {
    let s = sections; if (typeof prevPatch === 'function') { try { s = prevPatch(sections, h) || sections; } catch (e) { console.error('settings patch', e); } }
    try { const acct = (s || []).find(x => x && x.id === 'acct'), row = acct && (acct.rows || []).find(r => r && r.status === 'ra');
      if (row) row.info = 'Achievements for your games: progress on the shelf, in Details, the quick menu and the bottom screen, and what you unlocked when you come back from a game. Needs your username and web API key. Achievements only unlock where the emulator is signed in too: sign in inside each one (RetroArch: Settings → Achievements; Dolphin, PPSSPP, DuckStation, NetherSX2: their Achievements settings). Android doesn\'t let Boxshelf do that for them.';
    } catch (e) { console.error('settings patch (RetroAchievements)', e); }
    return s;
  };

  if (!isNative) installFake();

  // ---------- the pretend device (?fakeNative=1): RetroAchievements' answers, deterministic, for the device test ----------
  // The saved username + key stand in for the native signing (key "wrong" is refused). GameCube: Pikmin (mastered), The
  // Wind Waker (5 of 40), Metroid Prime; PlayStation: Crash, Final Fantasy VII; SNES: Chrono Trigger by its title, and
  // Super Metroid only by its hash (its pretend RetroAchievements title, "Zebes Mission", matches nothing; a hack whose
  // title is close must never be picked). Each call is kept in __fakeRa.calls (never with a key in it).
  function installFake() {
    const F = window.__fakeRa = { calls: [], hash: [], unlocks: [], recent: 0 };
    const H = s => String(s).padStart(32, '0');
    const LISTS = {
      16: [[1601, 'Pikmin', 30, 400], [1602, 'Legend of Zelda, The: The Wind Waker', 40, 500], [1603, 'Metroid Prime', 50, 600], [1604, 'Pikmin 2', 45, 450]],
      12: [[1201, 'Crash Bandicoot', 20, 300], [1202, 'Final Fantasy VII', 60, 800]],
      3: [[301, 'Zebes Mission', 64, 700, [H('f00d301')]], [302, 'Chrono Trigger', 77, 900, [H('302')]], [303, '~Hack~ Super Metroid Redesign', 10, 100, [H('303')]]]
    };
    const earned = () => ({ 1601: [30, 'mastered'], 1602: [F.recent ? 6 : 5, null], 301: [10, null] });
    const ok = o => ({ status: 200, text: JSON.stringify(o) });
    const http0 = N.httpText;
    N.httpText = async o => {
      const url = String((o && o.url) || '');
      if (!/^https:\/\/retroachievements\.org\/API\//.test(url)) return http0(o);
      F.calls.push({ url, ra: !!(o && o.ra) }); await sleep(20);
      const a = acc(); if (!o.ra || !user() || !hasKey() || String(a.key).trim() === 'wrong') return { status: 401, text: '' };
      const u = new URL(url), ep = (u.pathname.match(/\/(API_\w+)\.php$/) || [])[1], q = k => u.searchParams.get(k);
      if (ep === 'API_GetUserProfile') return ok({ User: user(), TotalPoints: 4321, TotalSoftcorePoints: 12, UserPic: '', RichPresenceMsg: '' });
      if (ep === 'API_GetGameList') return ok((LISTS[q('i')] || []).map(([ID, Title, NumAchievements, Points, Hashes]) => Object.assign({ ID, Title, NumAchievements, Points, ImageIcon: '' }, q('h') === '1' ? { Hashes: Hashes || [] } : {})));
      if (ep === 'API_GetUserCompletionProgress') { const E = earned(), R = Object.entries(E).map(([id, [n, kind]]) => ({ GameID: +id, NumAwarded: n, NumAwardedHardcore: 0, HighestAwardKind: kind }));
        return ok({ Count: R.length, Total: R.length, Results: R }); }
      if (ep === 'API_GetGameInfoAndUserProgress') { const id = +q('g'), g = Object.values(LISTS).flat().find(x => x[0] === id); if (!g) return ok({});
        const n = (earned()[id] || [0])[0], A = {};
        for (let i = 1; i <= g[2]; i++) A[id * 100 + i] = { ID: id * 100 + i, Title: `${g[1]} #${i}`, Description: 'A pretend achievement', Points: 5, BadgeName: '0000' + i, DisplayOrder: i, Type: '',
          DateEarned: i <= n ? '2026-01-02 10:00:00' : null, DateEarnedHardcore: null, NumAwarded: 10, };
        return ok({ ID: id, Title: g[1], ConsoleName: 'Pretend', ImageIcon: '', NumDistinctPlayers: 40, Achievements: A, UserCompletion: '', HighestAwardKind: (earned()[id] || [])[1] || null }); }
      if (ep === 'API_GetUserRecentAchievements') { F.recent++; const L = F.unlocks.splice(0); return ok(L); }
      return { status: 404, text: '' };
    };
    N.raHash = async ({ items }) => { F.hash.push(...(items || []).map(i => ({ name: i.name, kind: i.kind }))); await sleep(30);
      return { hashes: (items || []).map(i => /^Super Metroid/.test(i.name) ? H('f00d301') : '') }; };
  }
})();
