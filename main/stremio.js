// Your Stremio library, for the museum's movie shelves. Stremio 5 (stremio-shell-ng) keeps its web app's storage in a
// WebView2 folder beside the program: Chromium's localStorage, a small LevelDB database. Its "library" and
// "library_recent" entries hold every title you've added (name, type, poster). This reads those files directly (the
// app can be open: the files are only read, never locked or written), so nothing needs signing in to.
// Posters are fetched once into data\stremio-art and served from there.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let log = () => {}, artDir = null, fetchBuf = null, fanartKey = () => '';
function init(opts) { if (opts.log) log = opts.log; artDir = opts.artDir; fetchBuf = opts.fetchBuf; if (opts.fanartKey) fanartKey = opts.fanartKey; }

// ---- Snappy (LevelDB compresses its table blocks with it) ----
function unsnappy(buf) {
  // (a damaged or half-written block must throw, never loop or read past the end)
  const bad = () => { throw new Error('bad snappy data'); }, need = n => { if (pos + n > buf.length) bad(); };
  let pos = 0, len = 0, shift = 0;
  for (;;) { need(1); const b = buf[pos++]; len += (b & 0x7f) * 2 ** shift; if (b < 0x80) break; shift += 7; if (shift > 28) bad(); }
  if (len > 256 * 1024 * 1024) bad();
  const out = Buffer.alloc(len); let op = 0;
  while (pos < buf.length && op < len) {
    const tag = buf[pos++], t = tag & 3;
    if (t === 0) { let l = tag >> 2; if (l < 60) l += 1; else { const nb = l - 59; need(nb); l = 0; for (let i = 0; i < nb; i++) l += buf[pos++] * 2 ** (8 * i); l += 1; } need(l); if (op + l > len) bad(); buf.copy(out, op, pos, pos + l); pos += l; op += l; continue; }
    let l, off;
    if (t === 1) { need(1); l = ((tag >> 2) & 7) + 4; off = ((tag >> 5) << 8) | buf[pos++]; }
    else if (t === 2) { need(2); l = (tag >> 2) + 1; off = buf[pos] | (buf[pos + 1] << 8); pos += 2; }
    else { need(4); l = (tag >> 2) + 1; off = buf.readUInt32LE(pos); pos += 4; }
    if (!off || off > op || op + l > len) bad();
    for (let i = 0; i < l; i++) { out[op] = out[op - off]; op++; }
  }
  return out;
}
function varint(buf, o) { let v = 0, s = 0, b; do { if (o.p >= buf.length || s > 63) throw new Error('bad varint'); b = buf[o.p++]; v += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80); return v; }

// ---- LevelDB: tables (.ldb) and the write-ahead log (.log), newest write wins ----
function tableEntries(file, put) {
  const f = file, ft = f.subarray(f.length - 48), o = { p: 0 };
  varint(ft, o); varint(ft, o); const idxOff = varint(ft, o), idxSize = varint(ft, o);
  const block = (off, size) => { const raw = f.subarray(off, off + size), type = f[off + size]; return type === 1 ? unsnappy(raw) : raw; };
  const entries = (b, cb) => { const nr = b.readUInt32LE(b.length - 4), end = b.length - 4 - 4 * nr, q = { p: 0 }; let prev = Buffer.alloc(0);
    while (q.p < end) { const shared = varint(b, q), ns = varint(b, q), vl = varint(b, q); const key = Buffer.concat([prev.subarray(0, shared), b.subarray(q.p, q.p + ns)]); q.p += ns; const val = b.subarray(q.p, q.p + vl); q.p += vl; prev = key; cb(key, val); } };
  entries(block(idxOff, idxSize), (k, v) => { const h = { p: 0 }, off = varint(v, h), size = varint(v, h);
    entries(block(off, size), (key, val) => { if (key.length < 8) return; const tr = key.readBigUInt64LE(key.length - 8); put(key.subarray(0, key.length - 8), Number(tr >> 8n), Number(tr & 0xffn) === 1 ? val : null); }); });
}
function logEntries(file, put) {
  let rec = [], p = 0;
  const batch = d => { if (d.length < 12) return; const seq = Number(d.readBigUInt64LE(0)), n = d.readUInt32LE(8), o = { p: 12 };
    try { for (let i = 0; i < n && o.p < d.length; i++) { const tag = d[o.p++], kl = varint(d, o), key = d.subarray(o.p, o.p + kl); o.p += kl; let val = null; if (tag === 1) { const vl = varint(d, o); val = d.subarray(o.p, o.p + vl); o.p += vl; } put(key, seq + i, val); } } catch {} }; // (a torn batch: keep the rest of the log)
  while (p + 7 <= file.length) {
    const left = 32768 - (p % 32768); if (left < 7) { p += left; continue; }
    const len = file.readUInt16LE(p + 4), type = file[p + 6], data = file.subarray(p + 7, p + 7 + len); p += 7 + len;
    if (!len && !type) continue;
    if (type === 1) batch(data); else if (type === 2) rec = [data]; else if (type === 3) rec.push(data); else if (type === 4) { rec.push(data); batch(Buffer.concat(rec)); rec = []; }
  }
}
async function readLevelDb(dir) {
  const best = new Map(); const put = (k, seq, v) => { const key = k.toString('latin1'), cur = best.get(key); if (!cur || seq >= cur.seq) best.set(key, { seq, v }); };
  let names = []; try { names = await fs.promises.readdir(dir); } catch { return null; }
  for (const n of names.filter(n => /\.(ldb|sst|log)$/i.test(n))) {
    let buf; try { buf = await fs.promises.readFile(path.join(dir, n)); } catch (e) { log('stremio: could not read', n, e.code || e.message); continue; }
    try { if (/\.log$/i.test(n)) logEntries(buf, put); else tableEntries(buf, put); } catch (e) { log('stremio: skipped', n, e.message); }
    await new Promise(r => setImmediate(r));
  }
  const out = new Map();
  for (const [k, { v }] of best) { if (!v) continue; out.set(k, v); }
  return out;
}
// Chromium's localStorage rows: key "_<origin>\0\x01<name>", value "\x01<latin-1>" or "\0<utf-16>"
const str = v => !v || !v.length ? '' : v[0] === 0 ? v.subarray(1).toString('utf16le') : v.subarray(1).toString('latin1');
function storageDirs(exe) {
  const out = []; if (exe) { const base = exe + '.WebView2'; out.push(path.join(base, 'EBWebView', 'Default', 'Local Storage', 'leveldb')); }
  const la = process.env.LOCALAPPDATA, ra = process.env.APPDATA;
  if (la) out.push(path.join(la, 'Programs', 'Stremio', 'stremio-shell-ng.exe.WebView2', 'EBWebView', 'Default', 'Local Storage', 'leveldb'), path.join(la, 'Stremio', 'EBWebView', 'Default', 'Local Storage', 'leveldb'));
  if (ra) out.push(path.join(ra, 'stremio', 'stremio-shell-ng', 'EBWebView', 'Default', 'Local Storage', 'leveldb'));
  return [...new Set(out)];
}
let memo = null;
// [{ id, type, name, poster, at }] newest first, only titles you added (not removed, not just watched in passing)
async function library(exe) {
  if (memo && Date.now() - memo.t < 60000 && memo.exe === exe) return memo.items;
  let rows = null, from = '';
  for (const d of storageDirs(exe)) { try { if (!fs.existsSync(d)) continue; rows = await readLevelDb(d); if (rows && rows.size) { from = d; break; } } catch (e) { log('stremio: storage', e.message); } }
  const items = new Map(); let seen = 0;
  if (rows) for (const [k, v] of rows) {
    const m = /^_([^\0]*)\0\x01(library|library_recent)$/.exec(k); if (!m) continue;
    let j; try { j = JSON.parse(str(v)); } catch { continue; }
    const list = j && j.items ? Object.values(j.items) : Array.isArray(j) ? j : [];
    for (const it of list) { if (!it || !it._id) continue; seen++; const at = Date.parse(it._mtime || it._ctime || 0) || 0, cur = items.get(it._id); if (!cur || at >= cur.at) items.set(it._id, { id: String(it._id), type: String(it.type || 'movie'), name: String(it.name || ''), poster: typeof it.poster === 'string' ? it.poster : '', at, removed: !!it.removed, temp: !!it.temp }); }
  }
  const out = [...items.values()].filter(i => !i.removed && !i.temp && i.name).sort((a, b) => b.at - a.at).map(({ removed, temp, ...i }) => i);
  if (!memo || memo.items.length !== out.length) log('Stremio library:', rows ? `${out.length} titles (of ${seen} entries) from ${from || 'nowhere'}` : 'storage not found (is Stremio 5 installed and opened once?)');
  memo = { t: Date.now(), exe, items: out };
  return out;
}
// pictures (posters, backgrounds, logos): fetched once, then served from disk
const imgBusy = new Map();
const artFile = (key, ext) => path.join(artDir, crypto.createHash('sha1').update(String(key)).digest('hex').slice(0, 20) + (ext || '.jpg'));
async function image(key, urls, ext) {
  if (!artDir || !key) return null; const f = artFile(key, ext);
  try { await fs.promises.access(f); return f; } catch {}
  const list = (Array.isArray(urls) ? urls : [urls]).filter(u => /^https?:\/\//i.test(u || '')); if (!list.length || !fetchBuf) return null;
  if (imgBusy.has(f)) return imgBusy.get(f);
  const p = (async () => { for (const u of list) { try { const b = await fetchBuf(u); if (!b || b.length < 1000) continue; if (!require('./imgcheck').isImageBuf(b)) { log('stremio art', key, 'not a picture from', u); continue; } /* (beta.10: an error page is never kept as the poster) */ await fs.promises.mkdir(artDir, { recursive: true }); await fs.promises.writeFile(f + '.part', b); await fs.promises.rename(f + '.part', f); return f; } catch (e) { log('stremio art', key, e.message); } } return null; })().finally(() => imgBusy.delete(f));
  imgBusy.set(f, p); return p;
}
const imdb = id => /^tt\d+$/.test(String(id));
// the front: the title's large poster (the same art its disc release uses), else the one in your library
function poster(id, url) { return image(id + '|poster-l', [imdb(id) ? `https://images.metahub.space/poster/large/${id}/img` : '', url].filter(Boolean)); }
// Details for the case's back and its insert, from Cinemeta (the catalogue Stremio itself uses): plot, cast, director,
// runtime, rating, and for a show its seasons and episodes. Kept for a month in data\stremio-art.
const metaBusy = new Map();
async function meta(type, id) {
  if (!artDir || !id) return null; const f = artFile(id + '|meta', '.json');
  try { const c = JSON.parse(await fs.promises.readFile(f, 'utf8')); if (Date.now() - c.at < 30 * 864e5) return c.meta; } catch {}
  if (metaBusy.has(f)) return metaBusy.get(f);
  const p = (async () => {
    let m = null; try { const b = await fetchBuf(`https://v3-cinemeta.strem.io/meta/${encodeURIComponent(type === 'series' ? 'series' : 'movie')}/${encodeURIComponent(id)}.json`); m = b && JSON.parse(b.toString('utf8')).meta; } catch (e) { log('stremio meta', id, e.message); }
    if (!m) return null;
    const eps = Array.isArray(m.videos) ? m.videos.filter(v => v && v.season > 0) : [], seasons = {};
    eps.forEach(v => { (seasons[v.season] = seasons[v.season] || []).push({ n: v.episode || v.number || 0, title: String(v.name || v.title || '').slice(0, 80) }); });
    Object.values(seasons).forEach(l => l.sort((a, b) => a.n - b.n));
    const out = { name: m.name || '', year: m.year || m.releaseInfo || '', runtime: m.runtime || '', description: String(m.description || '').slice(0, 1200), genres: (m.genres || m.genre || []).slice(0, 4), cast: (m.cast || []).slice(0, 8), director: (m.director || []).slice(0, 3), writer: (m.writer || []).slice(0, 3), rating: m.imdbRating || '', country: m.country || '', awards: String(m.awards || '').slice(0, 160), poster: m.poster || '', background: m.background || '', logo: m.logo || '', seasons };
    try { await fs.promises.mkdir(artDir, { recursive: true }); await fs.promises.writeFile(f, JSON.stringify({ at: Date.now(), meta: out })); } catch {}
    return out;
  })().finally(() => metaBusy.delete(f));
  metaBusy.set(f, p); return p;
}
// fanart.tv (Settings → Connections, a free personal key): the official disc print for a movie, a Blu-ray one first
async function fanartDisc(id) {
  const key = fanartKey(); if (!key || !imdb(id)) return null;
  const f = artFile(id + '|fanart', '.json'); let j = null;
  try { const c = JSON.parse(await fs.promises.readFile(f, 'utf8')); if (Date.now() - c.at < (c.j ? 30 : 7) * 864e5) j = c; } catch {}
  // only a real answer is remembered: "no art" (404) for a week. Offline, a bad or missing key (401/403 throw in
  // fetchBuf) or a garbled reply are not, or the movie went without its disc for a week after the key was fixed
  if (!j) { let r; try { const b = await fetchBuf(`https://webservice.fanart.tv/v3/movies/${encodeURIComponent(id)}?api_key=${encodeURIComponent(key)}`); r = b ? JSON.parse(b.toString('utf8')) : null; } catch (e) { log('fanart.tv', id, e.message); return null; }
    j = { at: Date.now(), j: r && !r.status ? r : null }; try { await fs.promises.mkdir(artDir, { recursive: true }); await fs.promises.writeFile(f, JSON.stringify(j)); } catch {} }
  const discs = (j.j && j.j.moviedisc) || []; if (!discs.length) return null;
  const rank = d => (d.disc_type === 'bluray' ? 0 : d.disc_type === '3d' ? 2 : 1) * 10 + (d.lang === 'en' ? 0 : d.lang === '00' || !d.lang ? 1 : 3) - Math.min(5, (+d.likes || 0) / 10);
  const best = discs.slice().sort((a, b) => rank(a) - rank(b))[0];
  return image(id + '|disc-' + (best.id || ''), [best.url], '.png');
}
// the meta with its pictures saved locally: { ...meta, files: { background, logo, disc } }
async function details(type, id) {
  const m = await meta(type, id); if (!m) return null;
  const [bg, logo, disc] = await Promise.all([image(id + '|bg', [imdb(id) ? `https://images.metahub.space/background/medium/${id}/img` : '', m.background].filter(Boolean)), image(id + '|logo', [m.logo, imdb(id) ? `https://images.metahub.space/logo/medium/${id}/img` : ''].filter(Boolean), '.png'), type === 'series' ? null : fanartDisc(id).catch(() => null)]);
  return Object.assign({}, m, { files: { background: bg, logo, disc } });
}
module.exports = { init, library, poster, details, _test: { unsnappy, readLevelDb, str, meta } };
