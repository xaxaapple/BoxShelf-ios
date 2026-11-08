// GameTDB (gametdb.com) for Switch and 3DS: which GameTDB id a game is, by its title. GameTDB keeps a full cover scan
// (back | spine | front) for most boxed games, and the automatic art check cuts a real spine and back out of it when
// no other source has one. (GameCube / Wii discs carry their GameTDB id in their header: covers.discId does those.)
// The database (Switch ~4 MB, 3DS ~6 MB zipped) is fetched at most once a week; only the boxed games' ids, titles and
// regions are kept (data\boxart-cache\gametdb-<console>.json). Switch 2 isn't on GameTDB yet.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DB = { sw: { zip: 'https://www.gametdb.com/switchtdb.zip', art: 'switch', types: /^Switch$/ }, n3ds: { zip: 'https://www.gametdb.com/3dstdb.zip', art: '3ds', types: /^(3DS|New3DS)$/ } };
const WEEK = 7 * 864e5, V = 1;
// a GameTDB region → the art regions its scans are filed under, best first
const REG = { 'NTSC-U': ['US'], 'PAL': ['EN', 'AU', 'FR', 'DE', 'ES', 'IT', 'NL'], 'NTSC-J': ['JA'], 'KOR': ['KO'], 'ALL': ['US', 'EN'] };

let dir = null, log = () => {}, download = null, norm = s => String(s || '').toLowerCase();
const mem = new Map(), flight = new Map();
function init(o) { dir = o.dir; log = o.log || log; download = o.download; norm = o.norm || norm; }
const has = sysId => !!DB[sysId];

// the one .xml inside the zip (stored or deflated), or null
function xmlOf(buf) {
  let eocd = -1; for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return null;
  let o = buf.readUInt32LE(eocd + 16);
  for (let i = 0, n = buf.readUInt16LE(eocd + 10); i < n && o + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(o) !== 0x02014b50) break;
    const method = buf.readUInt16LE(o + 10), csize = buf.readUInt32LE(o + 20), nlen = buf.readUInt16LE(o + 28), xlen = buf.readUInt16LE(o + 30), clen = buf.readUInt16LE(o + 32), loc = buf.readUInt32LE(o + 42);
    const name = buf.toString('utf8', o + 46, o + 46 + nlen); o += 46 + nlen + xlen + clen;
    if (!/\.xml$/i.test(name) || loc + 30 > buf.length) continue;
    const start = loc + 30 + buf.readUInt16LE(loc + 26) + buf.readUInt16LE(loc + 28), raw = buf.subarray(start, start + csize);
    return (method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw, { maxOutputLength: 256 << 20 }) : Buffer.alloc(0)).toString('utf8');
  }
  return null;
}
// { "<normalised English title>": [[id, region], …] } for the boxed games
function parse(xml, types) {
  const map = Object.create(null); let n = 0;
  const re = /<game name="[^"]*">([\s\S]*?)<\/game>/g; let m;
  while ((m = re.exec(xml))) {
    const b = m[1], type = (/<type>([^<]*)<\/type>/.exec(b) || [])[1] || '';
    if (!types.test(type)) continue;
    const id = (/<id>([A-Z0-9]{4,6})<\/id>/.exec(b) || [])[1]; if (!id) continue;
    const region = (/<region>([^<]*)<\/region>/.exec(b) || [])[1] || 'ALL';
    const en = /<locale lang="EN">\s*<title>([^<]*)<\/title>/.exec(b); if (!en) continue;
    const t = en[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    const k = norm(t); if (!k) continue;
    (map[k] || (map[k] = [])).push([id, region]); n++;
  }
  return { map, n };
}
function file(sysId) { return dir ? path.join(dir, `gametdb-${sysId}.json`) : null; }
// the console's title map, fetched when missing or a week old (an old one is still used if the fetch fails)
function index(sysId) { if (flight.has(sysId)) return flight.get(sysId); const p = index0(sysId).finally(() => flight.delete(sysId)); flight.set(sysId, p); return p; }
async function index0(sysId) {
  const db = DB[sysId]; if (!db || !dir) return null;
  let cur = mem.get(sysId);
  if (!cur) { try { const j = JSON.parse(fs.readFileSync(file(sysId), 'utf8')); if (j && j.v === V && j.map) cur = j; } catch {} if (cur) mem.set(sysId, cur); }
  if (cur && Date.now() - cur.at < WEEK) return cur.map;
  if (cur && cur.tried && Date.now() - cur.tried < 864e5) return cur.map; // a failed fetch: tried again tomorrow
  const tmp = path.join(dir, `.gametdb-${sysId}-${process.pid}.zip`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (!await download(db.zip, tmp)) throw new Error('download failed');
    const xml = xmlOf(fs.readFileSync(tmp)); if (!xml) throw new Error('no database in the zip');
    const { map, n } = parse(xml, db.types); if (n < 100) throw new Error('only ' + n + ' games read');
    cur = { v: V, at: Date.now(), map }; mem.set(sysId, cur);
    fs.promises.writeFile(file(sysId), JSON.stringify(cur)).catch(() => {});
    log('GameTDB:', sysId, n, 'boxed games');
    return map;
  } catch (e) {
    log('GameTDB', sysId, e.message);
    if (cur) { cur.tried = Date.now(); return cur.map; }
    mem.set(sysId, { v: V, at: 0, tried: Date.now(), map: {} }); return {};
  } finally { fs.promises.unlink(tmp).catch(() => {}); }
}
// The full-cover addresses for a game, best first: [{ url, id, region }]. names: the game's names (covers.lookupNames),
// matched exactly. prefer: the art regions chosen in Settings ('US', 'EN', 'JA'…), first where that release exists.
async function fullCovers(sysId, names, prefer = []) {
  const db = DB[sysId]; if (!db) return [];
  const map = await index(sysId); if (!map) return [];
  let hits = []; for (const t of names || []) { hits = map[norm(t)] || []; if (hits.length) break; }
  const out = [], seen = new Set();
  for (const [id, region] of hits) {
    const own = REG[region] || REG.ALL;
    for (const r of [...prefer.filter(x => own.includes(x)), ...own]) for (const k of ['coverfullHQ', 'coverfull']) {
      const url = `https://art.gametdb.com/${db.art}/${k}/${r}/${id}.jpg`; if (seen.has(url)) continue; seen.add(url); out.push({ url, id, region: r, kind: k });
    }
  }
  return out.slice(0, 8);
}
module.exports = { init, has, index, fullCovers, _t: { parse, xmlOf } };
