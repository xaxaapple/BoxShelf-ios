// RetroAchievements: progress and achievement lists for the shelves whose emulators support it
// (GameCube and Wii through Dolphin, PSP through PPSSPP, PS2 through PCSX2). Achievements are earned inside the emulator;
// this just reads your account through the RA web API and matches games by title.
const fs = require('fs');
const path = require('path');
const https = require('https');

const CONSOLE_ID = { gc: 16, wii: 19, psp: 41, ps2: 21 }; // RA console ids (Wii sets since March 2026); Switch, PS4 and Xbox 360 have no achievement sets
const API = 'https://retroachievements.org/API/';
const MEDIA = 'https://media.retroachievements.org';
let dir = null, log = () => {}, creds = { user: '', key: '' };
const mem = new Map();
const UA = `Boxshelf/${(() => { try { return require('../package.json').version; } catch { return '0'; } })()}`;

function init(dataDir, logger) { dir = path.join(dataDir, 'ra'); fs.mkdirSync(dir, { recursive: true }); if (logger) log = logger; }
function setCredentials(user, key) { const next = { user: String(user || '').trim(), key: String(key || '').trim() }; if (next.user !== creds.user || next.key !== creds.key) failed.clear(); /* a fixed key is tried at once, not after the failure pause */ creds = next; }
// the username goes into cache file names: anything but plain letters/digits/_/- (a "..\\..\\x" would leave data\ra)
// becomes a hash, so two odd names can't share a cache either
const userKey = () => /^[A-Za-z0-9_-]{1,64}$/.test(creds.user) ? creds.user : 'u' + require('crypto').createHash('sha1').update(creds.user).digest('hex').slice(0, 16);
function enabled() { return !!(creds.user && creds.key); }

function getJson(u) {
  return new Promise((resolve, reject) => {
    const req = https.get(u, { headers: { 'User-Agent': UA } }, res => {
      if (res.statusCode === 429) { res.resume(); return reject(new Error('RetroAchievements is busy (too many requests). Try again in a minute.')); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(res.statusCode === 401 || res.statusCode === 403 ? 'RetroAchievements didn\'t accept your web API key. Check it in Settings → Accounts.' : `RetroAchievements didn't answer (HTTP ${res.statusCode}). Try again in a moment.`)); } // never the URL: it carries the API key
      let b = ''; res.setEncoding('utf8'); res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { reject(new Error('RetroAchievements sent an answer Boxshelf couldn\'t read. Try again in a moment.')); } }); /* a maintenance or proxy page in HTML, not "Unexpected token <" */ res.on('error', reject);
    });
    req.on('error', reject); req.setTimeout(20000, () => req.destroy(new Error('timed out')));
  });
}
function call(endpoint, params, who = creds) {
  const q = new URLSearchParams({ z: who.user, y: who.key, ...params });
  return getJson(`${API}${endpoint}.php?${q}`);
}
// small disk cache with a max age
function cached(name, maxAgeMs, fetch) {
  name = String(name).replace(/[^A-Za-z0-9_-]/g, '_'); // belt and braces: a name never leaves data\ra
  const f = path.join(dir, name + '.json');
  if (mem.has(name) && Date.now() - mem.get(name).at < maxAgeMs) return Promise.resolve(mem.get(name).data);
  try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); if (Date.now() - j.at < maxAgeMs) { mem.set(name, j); return Promise.resolve(j.data); } } catch {}
  if (inflight.has(name)) return inflight.get(name);
  // it failed a moment ago (offline, site down, rate limited): answer from that instead of asking again for every shelf
  // and Details visit; a forced reload (maxAge 0, "Try again") always asks
  const nope = failed.get(name); if (maxAgeMs > 0 && nope && Date.now() - nope.at < RETRY_MS) return nope.data !== undefined ? Promise.resolve(nope.data) : Promise.reject(nope.err);
  const p = fetch().then(data => { const j = { at: Date.now(), data }; mem.set(name, j); failed.delete(name); try { fs.writeFileSync(f, JSON.stringify(j)); } catch {} return data; })
    .catch(e => { let old; try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); if (j && j.data !== undefined) old = j.data; } catch {}
      failed.set(name, { at: Date.now(), err: e, data: old }); if (failed.size > 200) failed.delete(failed.keys().next().value);
      if (old !== undefined) { log('RA: using the saved copy of', ((/^(game-\d+|profile|completed)/.exec(String(name)) || ['a list'])[0]), '(' + e.message + ')'); /* (beta.10: the cache name ends in the account name, which stays out of the log) */ return old; } throw e; }) // offline / site down: the last copy rather than an error
    .finally(() => inflight.delete(name));
  inflight.set(name, p); return p;
}
const inflight = new Map(), failed = new Map(), RETRY_MS = 60e3;

// the site answers some failures with 200 and an object ({ message, errors }): say so instead of "x.map is not a function"
const need = v => { if (Array.isArray(v)) return v; throw new Error(v && typeof v === 'object' && typeof v.message === 'string' && v.message ? 'RetroAchievements: ' + v.message.slice(0, 200) : 'RetroAchievements sent an unexpected answer. Try again in a moment.'); };
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ').replace(/['’]/g, '').replace(/\s*\|.*$/, '').replace(/\s*~.*?~\s*/g, ' ').replace(/[^a-z0-9]+/g, ' ').replace(/\b(the|a|an)\b/g, ' ').replace(/\s+/g, ' ').trim();

// All games with achievement sets for a console (cached a day)
function gameList(sysId) {
  const cid = CONSOLE_ID[sysId]; if (!cid || !enabled()) return Promise.resolve([]);
  return cached(`list-${cid}`, 864e5, () => call('API_GetGameList', { i: cid, f: 1, h: 0 }).then(list => need(list).map(g => ({ id: g.ID, title: g.Title, n: norm(g.Title), count: g.NumAchievements, points: g.Points, icon: g.ImageIcon }))));
}
function matchGame(list, title) {
  const want = norm(title); if (!want) return null;
  let g = list.find(x => x.n === want); if (g) return g;
  // RA titles often carry subtitles after a colon or a "|" alternate; try prefix / containment both ways
  const W = new Set(want.split(' ')); let best = null, bs = 0;
  for (const x of list) {
    let s = 0;
    if (x.n.startsWith(want + ' ') || want.startsWith(x.n + ' ')) { const extra = x.n.length > want.length ? x.n.slice(want.length) : want.slice(x.n.length); if (!/\b(\d+|[ivx]+)\b/.test(extra)) s = .9 - Math.abs(x.n.length - want.length) / 200; }
    else { const G = x.n.split(' '); let hit = 0; for (const w of G) if (W.has(w)) hit++; const j = hit / new Set([...W, ...G]).size; if (j >= .75) s = j; }
    if (s > bs) { bs = s; best = x; }
  }
  return best;
}

// Progress for one game: { id, title, total, earned, points, pointsEarned, hardcore, icon, achievements:[{id,title,desc,points,badge,earned,earnedHardcore,date}] }
async function progress(sysId, title, force) {
  const list = await gameList(sysId);
  const g = matchGame(list, title); if (!g) return null;
  const data = await cached(`game-${g.id}-${userKey()}`, force ? 0 : 10 * 60e3, () => call('API_GetGameInfoAndUserProgress', { g: g.id, u: creds.user, a: 1 }) /* u: whose progress (the site refuses the call without it) */)
    .catch(e => { log('RA: achievements for', title, '(game ' + g.id + ') failed:', e.message); throw e; });
  if (!data || typeof data !== 'object' || !data.Achievements) { log('RA: achievements for', title, 'came back without a list', JSON.stringify(data).slice(0, 200)); throw new Error('RetroAchievements sent no achievement list for this game. Try again in a moment.'); }
  const ach = Object.values(data.Achievements || {}).sort((a, b) => (a.DisplayOrder || 0) - (b.DisplayOrder || 0)).map(a => ({
    id: a.ID, title: a.Title, desc: a.Description, points: +a.Points || 0, type: a.Type || a.type || '', badge: `${MEDIA}/Badge/${a.BadgeName}${a.DateEarnedHardcore || a.DateEarned ? '' : '_lock'}.png`,
    earned: !!(a.DateEarned || a.DateEarnedHardcore), hardcore: !!a.DateEarnedHardcore, date: a.DateEarnedHardcore || a.DateEarned || null,
    rarity: a.NumAwarded && data.NumDistinctPlayers ? Math.round(100 * a.NumAwarded / data.NumDistinctPlayers) : null
  }));
  return { id: g.id, title: data.Title || g.title, console: data.ConsoleName, icon: data.ImageIcon ? MEDIA + data.ImageIcon : null, box: data.ImageBoxArt ? MEDIA + data.ImageBoxArt : null,
    total: ach.length, earned: ach.filter(a => a.earned).length, points: ach.reduce((s, a) => s + a.points, 0), pointsEarned: ach.filter(a => a.earned).reduce((s, a) => s + a.points, 0),
    completion: data.UserCompletion || null, completionHardcore: data.UserCompletionHardcore || null, mastered: data.HighestAwardKind || null, achievements: ach, url: `https://retroachievements.org/game/${g.id}` };
}

// Lightweight progress for a whole shelf (for badges): uses the per-user completed list (cached 10 min)
async function shelfProgress(sysId, titles) {
  if (!CONSOLE_ID[sysId] || !enabled()) return {};
  const list = await gameList(sysId);
  const done = await cached(`completed-${userKey()}`, 10 * 60e3, () => call('API_GetUserCompletionProgress', { u: creds.user, c: 500 }).then(r => need(r && r.Results)));
  const byId = new Map(done.map(r => [r.GameID, r]));
  const out = {};
  for (const t of titles) { const g = matchGame(list, t); if (!g) continue; const r = byId.get(g.id); out[t] = { id: g.id, total: g.count, earned: r ? Math.max(+r.NumAwarded || 0, +r.NumAwardedHardcore || 0) : 0, mastered: r ? (r.HighestAwardKind || null) : null }; }
  return out;
}

async function profile() {
  if (!enabled()) return null;
  return cached(`profile-${userKey()}`, 5 * 60e3, () => call('API_GetUserProfile', { u: creds.user }).then(p => { if (!p || !p.User) throw new Error('No profile came back. Check the username and web API key.'); return p; }).then(p => ({ user: p.User, points: p.TotalPoints, softcore: p.TotalSoftcorePoints, pic: p.UserPic ? MEDIA + p.UserPic : null, rich: p.RichPresenceMsg || '' })));
}
// Achievements unlocked in the last N minutes (shown when you come back from a game)
async function recent(minutes) {
  if (!enabled()) return [];
  const r = await call('API_GetUserRecentAchievements', { u: creds.user, m: Math.max(1, Math.ceil(minutes)) });
  return (Array.isArray(r) ? r : []).map(a => ({ id: a.AchievementID, title: a.Title, desc: a.Description, points: a.Points, badge: `${MEDIA}/Badge/${a.BadgeName}.png`, game: a.GameTitle, hardcore: a.HardcoreMode === 1, date: a.Date }));
}
// user / key: check these without switching the account in use (a shelf or Details look-up running meanwhile keeps the saved one)
async function test(user, key) { const who = user !== undefined ? { user: String(user || '').trim(), key: String(key || '').trim() } : creds; if (!who.user || !who.key) throw new Error('Fill in the username and web API key first.');
  const p = await call('API_GetUserProfile', { u: who.user }, who); if (!p || !p.User) throw new Error('No profile came back. Check the username and web API key.'); return { user: p.User, points: p.TotalPoints }; }

module.exports = { init, setCredentials, enabled, progress, shelfProgress, profile, recent, test, CONSOLE_ID, matchGame, norm };
