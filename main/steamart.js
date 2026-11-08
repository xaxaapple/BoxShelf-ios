// Steam art and game info. Steam only keeps a portrait cover in its librarycache for games you've looked at in its
// library grid (and some older games never get one), so Boxshelf fills the gaps from Steam's own public store CDN —
// no account or key. Release date, developer, publisher, genres, Metacritic score and screenshots come from the public
// store API (store.steampowered.com/api/appdetails), cached for a month in data\steam-info.json.
const fs = require('fs');
const path = require('path');
const { net } = require('electron');
const { isFile } = require('./paths');

let dir = null, infoFile = null, info = {}, log = () => {};
const tried = new Set();
const MONTH = 30 * 864e5, RETRY = 7 * 864e5;

function init(dataDir, logger) {
  dir = path.join(dataDir, 'steam-art'); infoFile = path.join(dataDir, 'steam-info.json'); if (logger) log = logger;
  try { info = JSON.parse(fs.readFileSync(infoFile, 'utf8')) || {}; } catch { info = {}; }
}
const asset = (id, name) => [
  `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${id}/${name}`,
  `https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/${name}`
];
const coverFile = id => path.join(dir, `${id}_cover.jpg`), heroFile = id => path.join(dir, `${id}_hero.jpg`), missFile = id => path.join(dir, `${id}.missing`);

// Art Boxshelf has already downloaded for this game (used when Steam's own cache has none)
function local(appid) { return { front: isFile(coverFile(appid)) ? coverFile(appid) : null, hero: isFile(heroFile(appid)) ? heroFile(appid) : null }; }

// null = the CDN answered "not here" (404/403 or a stub); throws on network trouble / server errors
async function fetchBuf(url, ms = 20000) {
  const r = await net.fetch(url, { headers: { 'User-Agent': 'Boxshelf' }, signal: AbortSignal.timeout(ms), cache: 'no-store' });
  if (r.status === 404 || r.status === 403) return null;
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const b = Buffer.from(await r.arrayBuffer()); return b.length > 2048 ? b : null;
}
// 'ok' | 'missing' (really not on the CDN: worth remembering) | 'error' (offline etc.: try again next time, remember nothing)
async function save(urls, dest) {
  let err = false;
  // (beta.10) a 200 that isn't a picture (a proxy's block page, a CDN error page) is never saved: a saved cover is trusted for good.
  // Counted as an error (tried again next launch), never remembered as missing
  for (const u of urls) { try { const b = await fetchBuf(u); if (b && !require('./imgcheck').isImageBuf(b)) { err = true; continue; } if (b) { fs.mkdirSync(dir, { recursive: true }); try { fs.writeFileSync(dest + '.part', b); fs.renameSync(dest + '.part', dest); } catch (e) { try { fs.unlinkSync(dest + '.part'); } catch {} throw e; } return 'ok'; } } catch { err = true; } }
  return err ? 'error' : 'missing';
}
function recentlyMissed(id) { try { return Date.now() - fs.statSync(missFile(id)).mtimeMs < RETRY; } catch { return false; } }

// Store info in the same shape as the LaunchBox info the console shelves get, plus metacritic
function gameInfo(appid) {
  const d = info[appid]; if (!d || !d.ok) return null;
  return { overview: d.overview, release: d.release, year: d.year, dev: d.dev, pub: d.pub, genres: d.genres, metacritic: d.metacritic, shots: d.shots || [], bg: d.bg || null, name: d.name };
}
async function fetchInfo(appid) {
  try {
    const r = await net.fetch(`https://store.steampowered.com/api/appdetails?appids=${appid}&l=english`, { headers: { 'User-Agent': 'Boxshelf' }, cache: 'no-store', signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = (await r.json())[appid];
    if (!j || !j.success || !j.data) { info[appid] = { ok: false, at: Date.now() }; return; }
    const d = j.data, rel = d.release_date && d.release_date.date || '', y = (/(\d{4})/.exec(rel) || [])[1];
    const iso = (() => { const t = Date.parse(rel); return isNaN(t) ? (y || '') : new Date(t).toISOString().slice(0, 10); })();
    info[appid] = { ok: true, at: Date.now(), name: d.name, release: iso || undefined, year: y || undefined,
      dev: (d.developers || []).join(', ') || undefined, pub: (d.publishers || []).join(', ') || undefined,
      genres: (d.genres || []).map(g => g.description).join('; ') || undefined,
      metacritic: d.metacritic && d.metacritic.score || undefined,
      overview: String(d.short_description || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").slice(0, 1200) || undefined,
      shots: (d.screenshots || []).slice(0, 8).map(s => s.path_full).filter(u => /^https:\/\//.test(u)), bg: /^https:\/\//.test(d.background_raw || '') ? d.background_raw : null };
  } catch (e) { log('steam info', appid, e.message); }
}

// Fill in covers and info for the installed Steam games; resolves to { covers, other }: new covers (worth a toast) and
// heroes / store info (a quiet refresh). Kept apart so a monthly info refresh never reads as "Added covers for 40 games"
async function fill(games) {
  if (!dir) return { covers: 0, other: 0 };
  let covers = 0, other = 0;
  const need = games.filter(g => !tried.has(g.appid)); need.forEach(g => tried.add(g.appid));
  for (const g of need) {
    const id = g.appid;
    if (!g.art.front && !isFile(coverFile(id)) && !recentlyMissed(id)) {
      const r = await save(asset(id, 'library_600x900_2x.jpg').concat(asset(id, 'library_600x900.jpg')), coverFile(id));
      if (r === 'ok') covers++;
      else if (r === 'missing') { try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(missFile(id), ''); } catch {} log('steam cover: none on the CDN for', id, g.title); }
      else { log('steam art: network trouble, trying again next launch'); break; } // offline: don't mark anything, don't hammer
    }
    if (!g.art.hero && !isFile(heroFile(id)) && !recentlyMissed(id + '_hero')) {
      const r = await save(asset(id, 'library_hero.jpg'), heroFile(id));
      if (r === 'ok') other++;
      else if (r === 'missing') { try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(missFile(id + '_hero'), ''); } catch {} } // the folder may not exist yet: without it the marker was lost and the lookup repeated every launch
      else break;
    }
    const old = info[id];
    if (!old || Date.now() - old.at > (old.ok ? MONTH : RETRY)) { await fetchInfo(id); if (info[id] !== old && info[id].ok) other++; await new Promise(r => setTimeout(r, 350)); } // the store API rate-limits bursts; a failed refresh leaves the old entry, which isn't a change
  }
  if (need.length) { try { fs.writeFileSync(infoFile + '.tmp', JSON.stringify(info)); fs.renameSync(infoFile + '.tmp', infoFile); } catch {} } // temp + rename: a cut-off file lost every game's info
  return { covers, other };
}

module.exports = { init, local, gameInfo, fill };
