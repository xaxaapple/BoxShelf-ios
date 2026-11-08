// SteamGridDB (steamgriddb.com, API v2): community-made posters ("grids") for the Art Studio's Front, offered next to the
// real box scans. Optional: nothing happens without the user's own free key (Settings → Accounts & services). The key is
// sent only as the Authorization header to www.steamgriddb.com and never logged; errors are reported as words, not bodies.
// Lookups are cached on disk (which SteamGridDB game a title is: a week; a game's grid list: a day), at most two requests
// run at once, every request has a short timeout, and a 429 pauses everything for the time the server asks.
const fs = require('fs');
const path = require('path');
const { net } = require('electron');

const BASE = 'https://www.steamgriddb.com/api/v2';
const UA = `Boxshelf/${(() => { try { return require('../package.json').version; } catch { return '0'; } })()}`;
const ID_TTL = 7 * 864e5, MISS_TTL = 864e5, LIST_TTL = 864e5; // a title with no match is asked again after a day (SteamGridDB grows)
const TIMEOUT = 8000, MAX_LISTS = 4000, MAX_IDS = 20000;
// portrait posters only: the Front is a box. 600x900 is Steam's library capsule, 342x482 / 660x930 the older poster sizes.
// (920x430 wide grids are left out: no part of a box is that shape.)
const DIMS = ['600x900', '342x482', '660x930'];
const STYLES = ['alternate', 'white_logo', 'no_logo', 'material', 'blurred'];
const STYLE_N = { alternate: 'Alternate', white_logo: 'White logo', no_logo: 'No logo', material: 'Material', blurred: 'Blurred' };

let getKey = () => '', log = () => {}, cacheFile = null, cache = null, saveT = null, fetchFn = null;
let pausedUntil = 0, badKey = '', active = 0; const queue = [];
function init(o = {}) { getKey = o.key || getKey; log = o.log || log; cacheFile = o.dataDir ? path.join(o.dataDir, 'sgdb-cache.json') : null; cache = null; fetchFn = o.fetch || null; pausedUntil = 0; badKey = ''; }
const key = () => String((getKey && getKey()) || '').trim();
const enabled = () => !!key() && key() !== badKey; // a key the server refused isn't sent again until it changes

// ---------- cache: { ids: { "<what>": [gameId|0, at] }, lists: { "<gameId>|<dims>": [at, [grid]] } } ----------
function cacheGet() {
  if (cache) return cache;
  try { const j = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); if (j && j.ids && j.lists && typeof j.ids === 'object' && typeof j.lists === 'object') cache = { ids: j.ids, lists: j.lists }; } catch {}
  return cache || (cache = { ids: {}, lists: {} });
}
function cacheSave() {
  if (!cacheFile) return; clearTimeout(saveT);
  saveT = setTimeout(() => { saveT = null; const c = cacheGet(), now = Date.now();
    for (const [k, v] of Object.entries(c.ids)) if (now - v[1] > ID_TTL) delete c.ids[k]; // only what's still fresh is kept
    for (const [k, v] of Object.entries(c.lists)) if (now - v[0] > LIST_TTL) delete c.lists[k];
    const trim = (m, n, at) => { const ks = Object.keys(m); if (ks.length > n) ks.sort((a, b) => at(m[a]) - at(m[b])).slice(0, ks.length - n).forEach(k => delete m[k]); };
    trim(c.ids, MAX_IDS, v => v[1]); trim(c.lists, MAX_LISTS, v => v[0]);
    const tmp = cacheFile + '.tmp'; fs.promises.writeFile(tmp, JSON.stringify(c)).then(() => fs.promises.rename(tmp, cacheFile)).catch(e => log('SteamGridDB: cache not saved', e.message)); }, 2000);
  if (saveT.unref) saveT.unref();
}

// ---------- requests ----------
class SgError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
async function limited(fn) { // two at a time, everything together (the picker and a restyle job)
  while (active >= 2) await new Promise(r => queue.push(r)); active++; // (while: a caller arriving as a slot frees can't make it three)
  try { return await fn(); } finally { active--; const n = queue.shift(); if (n) n(); }
}
// GET one API path → the "data" field, null on 404 (no such game / nothing found). Throws SgError: 'nokey' | 'auth' (401/403)
// | 'rate' (429) | 'net' (offline, timeout, 5xx). k: the key to use (the Settings test passes the one typed in)
async function api(p, k = key()) {
  if (!k) throw new SgError('nokey', 'No SteamGridDB key');
  if (Date.now() < pausedUntil) throw new SgError('rate', 'SteamGridDB asked us to slow down');
  return limited(async () => {
    let r; try { r = await (fetchFn || net.fetch)(BASE + p, { headers: { Authorization: 'Bearer ' + k, 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT), cache: 'no-store' }); }
    catch (e) { throw new SgError('net', /abort|timeout/i.test(e && e.name + ' ' + e.message) ? 'SteamGridDB took too long to answer' : "Couldn't reach SteamGridDB"); } // (never the raw error: it may echo the request)
    if (r.status === 401 || r.status === 403) { if (k === key()) badKey = k; throw new SgError('auth', 'The SteamGridDB key was not accepted'); }
    if (r.status === 429) { const s = Math.min(600, Math.max(30, +(r.headers && r.headers.get && r.headers.get('retry-after')) || 60)); pausedUntil = Date.now() + s * 1000; log('SteamGridDB: rate limited, pausing', s, 's'); throw new SgError('rate', 'SteamGridDB asked us to slow down'); }
    if (r.status === 404) return null;
    if (!r.ok) throw new SgError('net', 'SteamGridDB answered ' + r.status);
    let j; try { j = await r.json(); } catch { throw new SgError('net', 'SteamGridDB sent something unexpected'); }
    if (!j || j.success === false) return null;
    return j.data == null ? null : j.data;
  });
}

// ---------- which SteamGridDB game this is ----------
// Steam / PC games by their appid; console games by title through autocomplete, accepted only on an exact or near match
// (the same title matching the LaunchBox lookup uses: "Pikmin" never stands in for "Pikmin 2"). 0 = no match (cached too).
async function gameId(game, match) {
  const c = cacheGet(), appid = game && /^\d{1,10}$/.test(String(game.appid || '')) ? String(game.appid) : '';
  const title = String((game && game.title) || '').trim(); if (!appid && !title) return 0;
  const ck = appid ? 'steam:' + appid : 'title:' + title.toLowerCase(), hit = c.ids[ck];
  if (hit && Date.now() - hit[1] < (hit[0] ? ID_TTL : MISS_TTL)) return hit[0];
  let id = 0;
  if (appid) { const d = await api('/games/steam/' + appid); id = d && +d.id || 0; }
  else {
    // game.names: its other names, most specific first (covers.lookupNames: without "Nintendo Switch 2 Edition" and the
    // like); each further one must match exactly (match's third argument). At most three searches per game.
    const names = Array.isArray(game.names) && game.names.length ? game.names.slice(0, 3) : [title];
    for (let i = 0; i < names.length && !id; i++) {
      const d = await api('/search/autocomplete/' + encodeURIComponent(String(names[i]).slice(0, 120)));
      const list = Array.isArray(d) ? d.filter(x => x && x.id && x.name) : [];
      const m = list.length && match ? match(list.map(x => ({ id: x.id, name: String(x.name), year: x.release_date ? new Date(x.release_date * 1000).getUTCFullYear() : 0 })), { ...game, title: String(names[i]) }, i > 0) : null;
      id = m ? +m.id || 0 : 0;
    }
  }
  c.ids[ck] = [id, Date.now()]; cacheSave(); return id;
}
// the poster grids of one game (or a Steam app), SteamGridDB's own order (best voted first)
async function grids(id, appid) {
  const c = cacheGet(), ck = (appid ? 'steam:' + appid : id) + '|' + DIMS.join(','), hit = c.lists[ck];
  if (hit && Date.now() - hit[0] < LIST_TTL) return hit[1];
  const q = `?dimensions=${DIMS.join(',')}&styles=${STYLES.join(',')}&nsfw=false&humor=false&epilepsy=false`;
  const d = await api((appid ? '/grids/steam/' + appid : '/grids/game/' + id) + q);
  // only what the candidate list needs, checked: an https address on SteamGridDB's CDN, a known size, not NSFW / humour
  const okUrl = u => typeof u === 'string' && /^https:\/\/([a-z0-9-]+\.)*steamgriddb\.com\/[^\s"<>]+$/i.test(u) && u.length < 600;
  const list = (Array.isArray(d) ? d : []).filter(g => g && g.id && okUrl(g.url) && !g.nsfw && !g.humor && +g.width > 0 && +g.height > 0 && +g.height >= +g.width)
    .slice(0, 40).map(g => ({ id: +g.id, url: g.url, thumb: okUrl(g.thumb) ? g.thumb : null, w: +g.width, h: +g.height, style: String(g.style || ''), author: String((g.author && g.author.name) || '').slice(0, 40), score: +g.score || 0, mime: String(g.mime || '') }));
  c.lists[ck] = [Date.now(), list]; cacheSave(); return list;
}
const extOf = (u, mime) => { const m = /\.(png|jpe?g|webp)(?:$|\?)/i.exec(u); return m ? '.' + m[1].toLowerCase().replace('jpeg', 'jpg') : /png/.test(mime) ? '.png' : /webp/.test(mime) ? '.webp' : '.jpg'; };
// Art Studio candidates for a game's Front: [{ url, thumbUrl, ext, source:'steamgriddb', w, h, style, author, rank }].
// Never throws: no key, no match, offline, rate limited or a refused key all mean "nothing from SteamGridDB this time".
async function posters(game, match) {
  if (!enabled()) return [];
  try {
    const appid = game && /^\d{1,10}$/.test(String(game.appid || '')) ? String(game.appid) : '';
    let list;
    if (appid) list = await grids(0, appid);
    else { const id = await gameId(game, match); if (!id) return []; list = await grids(id); }
    return list.map((g, i) => ({ url: g.url, thumbUrl: g.thumb, ext: extOf(g.url, g.mime), source: 'steamgriddb', type: 'grid', sgId: g.id, w: g.w, h: g.h, style: g.style, styleName: STYLE_N[g.style] || '', author: g.author, rank: i }));
  } catch (e) { if (e.code !== 'nokey') log('SteamGridDB:', e.message); return []; }
}
// A game's logos (its title art on a clear background), best voted first: the made spine prints one. Static PNGs only.
// [{ url, ext, w, h }]; never throws (no key, no match, offline: []).
async function logos(game, match) {
  if (!enabled()) return [];
  try {
    const id = await gameId(game, match); if (!id) return [];
    const c = cacheGet(), ck = id + '|logos', hit = c.lists[ck];
    if (hit && Date.now() - hit[0] < LIST_TTL) return hit[1];
    const d = await api('/logos/game/' + id + '?types=static&nsfw=false&humor=false&epilepsy=false');
    const okUrl = u => typeof u === 'string' && /^https:\/\/([a-z0-9-]+\.)*steamgriddb\.com\/[^\s"<>]+\.png$/i.test(u) && u.length < 600;
    const list = (Array.isArray(d) ? d : []).filter(g => g && okUrl(g.url) && !g.nsfw && !g.humor && +g.width > 0 && +g.height > 0)
      .slice(0, 12).map(g => ({ url: g.url, ext: '.png', w: +g.width, h: +g.height }));
    c.lists[ck] = [Date.now(), list]; cacheSave(); return list;
  } catch (e) { if (e.code !== 'nokey') log('SteamGridDB:', e.message); return []; }
}
// Settings → Test: { ok } or { ok:false, error } (a word for the screen, never the key)
async function test(k) {
  k = String(k || '').trim(); if (!k) return { ok: false, error: 'no key' };
  try { await api('/search/autocomplete/' + encodeURIComponent('zelda'), k); if (k === badKey) badKey = ''; return { ok: true }; }
  catch (e) { return { ok: false, error: e.code === 'auth' ? 'not accepted' : e.message }; }
}
module.exports = { init, posters, logos, test, enabled, gameId, grids, DIMS, _t: { cacheGet, reset: () => { cache = null; pausedUntil = 0; badKey = ''; }, paused: () => pausedUntil } };
