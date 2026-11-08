// (beta.5) Choosing a PC game's cover: Steam, Epic, Quiver and games added by hand (console games have the Art Studio).
// The options: SteamGridDB's posters (with the player's own SteamGridDB key, Settings → Accounts & services), Steam's own
// cover for a Steam game, and a picture of your own. The chosen one is kept as data\pc-covers\<game id>.<ext> and wins over
// every automatic cover (cover(id)); Reset goes back to the automatic one.
// The page may only show local files, so the posters' thumbnails are fetched here into data\pc-cover-cache (by address,
// a few at a time) and handed back as bsfile: addresses. The page only ever names a game id and an option's key: the
// addresses stay here (last options per game).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let o = { dataDir: '', log: () => {} };
const EXTS = ['jpg', 'png', 'webp'];
const safeId = id => String(id || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 120);
const dir = () => path.join(o.dataDir, 'pc-covers'), cacheDir = () => path.join(o.dataDir, 'pc-cover-cache');
const isFile = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const sha = s => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 24);
const steamArt = (appid, name) => [`https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${appid}/${name}`, `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/${name}`]; // (Steam's public store CDN, as steamart.js)
const { isImageBuf: isImg } = require('./imgcheck'); // (beta.10: PNG / JPEG / WebP / GIF / BMP / AVIF by its first bytes)
const extOf = (u, buf) => { if (buf && buf[0] === 0x89 && buf[1] === 0x50) return 'png'; if (buf && buf.slice(8, 12).toString() === 'WEBP') return 'webp'; const m = /\.(png|webp|jpe?g)(?:$|\?)/i.exec(String(u || '')); return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg'; };

function init(opts) { o = Object.assign(o, opts || {}); }

// the chosen cover of a game, or null
function cover(id) { const b = path.join(dir(), safeId(id)); for (const e of EXTS) if (isFile(b + '.' + e)) return b + '.' + e; return null; }
function clear(id) { const b = path.join(dir(), safeId(id)); for (const e of EXTS) { try { fs.unlinkSync(b + '.' + e); } catch {} } }
async function save(id, buf, ext) {
  fs.mkdirSync(dir(), { recursive: true });
  const dest = path.join(dir(), safeId(id) + '.' + ext), tmp = dest + '.tmp';
  await fs.promises.writeFile(tmp, buf); clear(id); await fs.promises.rename(tmp, dest); return dest;
}

// a thumbnail, fetched once into the cache (three at a time); null when it couldn't be fetched
let slots = 3; const waiting = [];
async function slot(fn) { if (slots > 0) slots--; else await new Promise(r => waiting.push(r)); try { return await fn(); } finally { const n = waiting.shift(); if (n) n(); else slots++; } }
async function thumb(url) {
  if (!url) return null;
  const f = path.join(cacheDir(), sha(url));
  for (const e of EXTS) if (isFile(f + '.' + e)) return f + '.' + e;
  // (beta.10) only a picture is kept, and through a temp name: a cached thumbnail is trusted whenever it's there
  return slot(async () => { const b = await o.fetchImage(url); if (!b || !isImg(b)) return null; fs.mkdirSync(cacheDir(), { recursive: true }); const p = f + '.' + extOf(url, b), tmp = p + '.tmp';
    try { await fs.promises.writeFile(tmp, b); await fs.promises.rename(tmp, p); } catch (e) { await fs.promises.unlink(tmp).catch(() => {}); o.log('PC cover: thumbnail not saved', e.message); return null; } return p; });
}

// the options for one game: { list: [{ key, thumb, source, label, sub }], sgdb: has a SteamGridDB key, current: chosen? }
const last = new Map(); // game id → { key → full address }
async function options(game) {
  const id = String(game.id), keys = {}, list = [];
  const mine = cover(id); if (mine) list.push({ key: 'current', thumb: o.fileUrl(mine), source: 'yours', label: 'Your choice now', sub: 'Chosen before' });
  if (game.appid) { const s = o.steamCover(game.appid); if (s) { keys.steam = { file: s }; list.push({ key: 'steam', thumb: o.fileUrl(s), source: 'steam', label: "Steam's cover", sub: 'From your Steam library' }); } }
  // (beta.9) with no key at all: Steam's official cover from its public store (no account): a Steam game's own when Steam
  // hasn't kept it on this PC, and for any other game the Steam games of that name (the player picks: a name can be shared)
  try {
    const apps = game.appid ? (keys.steam ? [] : [{ id: String(game.appid), name: '' }]) : (o.steamSearch ? await o.steamSearch(game.title, !game.term) : []);
    const got = await Promise.all(apps.map(async (a, i) => ({ a, i, t: await thumb(steamArt(a.id, 'library_600x900.jpg')[0]) || await thumb(steamArt(a.id, 'library_600x900.jpg')[1]) })));
    for (const { a, i, t } of got) { if (!t) continue; const k = 'st' + i; keys[k] = { urls: [...steamArt(a.id, 'library_600x900_2x.jpg'), ...steamArt(a.id, 'library_600x900.jpg')] };
      list.push({ key: k, thumb: o.fileUrl(t), source: 'steamstore', label: "Steam's cover", sub: a.name ? `${a.name} on Steam` : "From Steam's store" }); }
  } catch (e) { o.log('PC cover: Steam store', e.message); }
  const sgdb = !!(o.steamgrid && o.steamgrid.enabled && o.steamgrid.enabled());
  if (sgdb) {
    let posters = [];
    try { posters = await o.steamgrid.posters(game.appid ? { appid: game.appid, title: game.title } : { title: game.title, names: [game.title] }, o.match); } catch (e) { o.log('PC cover: SteamGridDB', e.message); }
    const got = await Promise.all(posters.slice(0, 24).map(async (p, i) => ({ p, i, t: await thumb(p.thumbUrl || p.url) })));
    for (const { p, i, t } of got) { if (!t) continue; const k = 'sg' + i; keys[k] = { url: p.url }; list.push({ key: k, thumb: o.fileUrl(t), source: 'steamgriddb', label: p.styleName ? `SteamGridDB · ${p.styleName}` : 'SteamGridDB', sub: p.author ? 'by ' + p.author : '' }); }
  }
  last.set(id, keys);
  return { list, sgdb, current: !!mine };
}
// use one of the last options (by key) as the game's cover
async function use(id, key) {
  id = String(id); const k = (last.get(id) || {})[String(key || '')]; if (!k) throw new Error('That cover isn\'t in the list any more. Open the picker again.');
  let buf = null, ext = 'jpg';
  if (k.file) { buf = await fs.promises.readFile(k.file); ext = extOf(k.file, buf); }
  else if (k.url || k.urls) { const us = k.urls || [k.url]; let u = null; for (const x of us) { buf = await o.fetchImage(x); if (buf && isImg(buf)) { u = x; break; } buf = null; } // (the sharpest first: Steam's 2x cover, then its 1x; beta.10: an error page is never the cover)
    if (!buf) throw new Error("Couldn't download that cover. Check the connection and try again."); ext = extOf(u, buf); }
  const dest = await save(id, buf, ext); o.log('PC cover chosen:', id, key.startsWith('sg') ? 'SteamGridDB' : key.startsWith('st') ? "Steam's store" : key); return dest;
}
// a picture of your own (a file the player picked in the dialog)
async function own(id, file) {
  const ext = String(path.extname(file)).slice(1).toLowerCase().replace('jpeg', 'jpg'); if (!EXTS.includes(ext)) throw new Error('Pick a JPG, PNG or WebP picture.');
  const st = await fs.promises.stat(file); if (st.size > 25e6) throw new Error('That picture is too big (over 25 MB).');
  return save(String(id), await fs.promises.readFile(file), ext);
}

module.exports = { init, cover, options, use, own, reset: id => clear(String(id)) };
