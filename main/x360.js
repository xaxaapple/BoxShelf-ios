// Xbox 360: read the title ID out of a game (disc image or default.xex) and turn it into the real title,
// so "DVD.iso" or a misspelled file name still gets the right name, art and info. Names come from the
// Xenia compatibility trackers (via the Xenia Manager database on GitHub), cached for a week in data\.
const fs = require('fs');
const path = require('path');
const https = require('https');

const DB_URLS = [
  'https://raw.githubusercontent.com/xenia-manager/Database/main/data/game-compatibility/canary.json',
  'https://raw.githubusercontent.com/xenia-manager/Database/main/data/game-compatibility/stable.json'
];
const SECTOR = 2048;
const PARTITIONS = [0, 0x2080000, 0xFD90000, 0x18300000]; // extracted / XGD3 / XGD2 / XGD1
const MAGIC = Buffer.from('MICROSOFT*XBOX*MEDIA', 'latin1');

let dataDir = null, log = () => {}, db = null, dbAt = 0, fetching = null, failedAt = 0;
const RETRY_AFTER = 30 * 60e3; // offline: don't hold up every library scan for the refresh; try again in half an hour
const idCache = new Map(); // file -> { id, at }

const unknownLogged = new Set(); // log each unknown title id once per session
function init(dir, logger) { dataDir = dir; if (logger) log = logger; loadDb(); }
function dbFile() { return path.join(dataDir, 'x360-titles.json'); }
function loadDb() {
  try { const j = JSON.parse(fs.readFileSync(dbFile(), 'utf8')); db = j.titles || {}; dbAt = j.at || 0; } catch { db = null; dbAt = 0; }
}
function get(u) {
  return new Promise((resolve, reject) => {
    const req = https.get(u, { headers: { 'User-Agent': 'Boxshelf' } }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let b = ''; res.setEncoding('utf8'); res.on('data', c => b += c); res.on('end', () => resolve(b)); res.on('error', reject);
    });
    req.on('error', reject); req.setTimeout(15000, () => req.destroy(new Error('timed out')));
  });
}
// Make sure the id -> title table is loaded (refreshes weekly, never blocks for more than ~15 s, keeps a stale copy on failure)
async function ensureDb() {
  if (db && Date.now() - dbAt < 7 * 864e5) return db;
  if (fetching) return fetching;
  if (Date.now() - failedAt < RETRY_AFTER) return db || {};
  fetching = (async () => {
    const titles = {};
    for (const u of DB_URLS) {
      try { for (const g of JSON.parse(await get(u))) { const id = String(g.id || '').toUpperCase(); if (id && g.title && !titles[id]) titles[id] = { title: g.title, state: g.state || '' }; } }
      catch (e) { log('x360 title list', path.basename(u), e.message); }
    }
    if (Object.keys(titles).length > 100) { db = titles; dbAt = Date.now(); failedAt = 0; try { fs.writeFileSync(dbFile(), JSON.stringify({ at: dbAt, titles })); } catch {} log('x360 title list:', Object.keys(titles).length, 'games'); }
    else failedAt = Date.now();
    return db || {};
  })().finally(() => { fetching = null; });
  return fetching;
}

function readAt(fd, pos, len) { const b = Buffer.alloc(len); const n = fs.readSync(fd, b, 0, len, pos); return n === len ? b : b.subarray(0, n); }

// Title id from a XEX2 header buffer (the optional headers are plain text even when the image itself is encrypted)
function xexTitleId(buf) {
  if (buf.length < 0x18 || buf.toString('latin1', 0, 4) !== 'XEX2') return null;
  const count = buf.readUInt32BE(0x14); if (count > 256) return null;
  for (let i = 0; i < count; i++) {
    const at = 0x18 + i * 8; if (at + 8 > buf.length) break;
    const key = buf.readUInt32BE(at), val = buf.readUInt32BE(at + 4);
    // execution id: media id, version, base version, title id …
    if (key === 0x00040006) { if (val + 16 > buf.length) return null; return buf.readUInt32BE(val + 12).toString(16).toUpperCase().padStart(8, '0'); }
  }
  return null;
}
// Walk a GDFX directory table and return the entry for `name` (case-insensitive)
function findEntry(fd, base, sector, size, name) {
  const want = name.toLowerCase(); const table = readAt(fd, base + sector * SECTOR, Math.min(size, 256 * 1024));
  let off = 0;
  while (off + 14 <= table.length) {
    if (table.readUInt16LE(off) === 0xFFFF) { off = (Math.floor(off / SECTOR) + 1) * SECTOR; continue; } // padding to the next sector
    const start = table.readUInt32LE(off + 4), fsize = table.readUInt32LE(off + 8), attr = table[off + 12], nlen = table[off + 13];
    if (nlen === 0 || off + 14 + nlen > table.length) break;
    const n = table.toString('latin1', off + 14, off + 14 + nlen);
    if (n.toLowerCase() === want) return { sector: start, size: fsize, dir: !!(attr & 0x10) };
    off += (14 + nlen + 3) & ~3;
  }
  return null;
}
function isoTitleId(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r'); const total = fs.fstatSync(fd).size;
    for (const base of PARTITIONS) {
      if (base + 0x10000 + SECTOR > total) continue;
      const vol = readAt(fd, base + 0x10000, SECTOR);
      if (!vol.subarray(0, 20).equals(MAGIC)) continue;
      const rootSector = vol.readUInt32LE(20), rootSize = vol.readUInt32LE(24);
      const e = findEntry(fd, base, rootSector, rootSize, 'default.xex'); if (!e || e.dir) { log('x360', path.basename(file), 'no default.xex in root (partition', base.toString(16) + ')'); return null; }
      const at = base + e.sector * SECTOR; let head = readAt(fd, at, Math.min(e.size, 0x4000));
      const hsize = head.length >= 12 ? head.readUInt32BE(8) : 0; /* XEX header size: big games can run past 16 KB */
      if (hsize > head.length && hsize <= 0x100000) head = readAt(fd, at, Math.min(e.size, hsize));
      const id = xexTitleId(head);
      if (!id) log('x360', path.basename(file), 'default.xex has no title id (magic', head.toString('latin1', 0, 4).replace(/[^ -~]/g, '?'), 'headers', head.length >= 0x18 ? head.readUInt32BE(0x14) : '-', 'size', hsize + ')');
      return id;
    }
    log('x360', path.basename(file), 'no Xbox volume descriptor found');
  } catch (e) { log('x360 iso read', path.basename(file), e.message); }
  finally { if (fd != null) try { fs.closeSync(fd); } catch {} }
  return null;
}
// (beta.10) Games on Demand, Xbox Live Arcade and indie games: an STFS package ("CON " / "LIVE" / "PIRS"), a file with no
// extension (a 40-character hash) in a folder named after its content type: <title id>\00007000\<hash> (plus a <hash>.data
// folder beside it). Xenia starts the package file itself. Its header says what it is (content type at 0x344), the title id
// (0x360) and the game's name (display name, UTF-16 big-endian, at 0x411; else the title name at 0x1691).
// { titleId, title, type } for a game package; null for anything else (saves, DLC, title updates, themes, demos…)
const STFS_GAME = { 0x00007000: 'god', 0x000D0000: 'arcade', 0x00001000: 'title', 0x02000000: 'indie' };
const isStfsCandidate = file => !path.extname(file) && /^[0-9A-F]{8}$/i.test(path.basename(path.dirname(file))); // (no extension, in a content-type folder)
function stfsInfo(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r'); const h = readAt(fd, 0, 0x1712);
    if (h.length < 0x1712 || !/^(CON |LIVE|PIRS)$/.test(h.toString('latin1', 0, 4))) return null;
    const type = STFS_GAME[h.readUInt32BE(0x344)]; if (!type) return null;
    const titleId = h.readUInt32BE(0x360).toString(16).toUpperCase().padStart(8, '0');
    const u16 = (at, len) => { const b = Buffer.from(h.subarray(at, at + len)); b.swap16(); return b.toString('utf16le').replace(/\0[\s\S]*$/, '').replace(/\s+/g, ' ').trim(); };
    return { titleId, title: u16(0x411, 0x80) || u16(0x1691, 0x80), type };
  } catch { return null; } finally { if (fd != null) try { fs.closeSync(fd); } catch {} }
}
function titleIdOf(file, stfs) { // stfs (beta.10): the package's stfsInfo, already read (the scanner's): not read twice
  const ext = path.extname(file).toLowerCase();
  let st; try { st = fs.statSync(file); } catch { return null; }
  const c = idCache.get(file); if (c && c.at === st.mtimeMs) return c.id;
  let id = null;
  try {
    if (ext === '.xex') { const fd = fs.openSync(file, 'r'); try { let h = readAt(fd, 0, 0x4000); const hs = h.length >= 12 ? h.readUInt32BE(8) : 0; if (hs > h.length && hs <= 0x100000) h = readAt(fd, 0, hs); id = xexTitleId(h); } finally { fs.closeSync(fd); } }
    else if (ext === '.iso') id = isoTitleId(file);
    else if (!ext) { const s = stfs || stfsInfo(file); id = s ? s.titleId : null; } // (beta.10: a Games on Demand / Arcade package)
  } catch {}
  idCache.set(file, { id, at: st.mtimeMs });
  return id;
}
// { titleId, title, compat } for a game file; title/compat only when the id is in the table
function lookup(file, stfs) { // stfs: as titleIdOf
  const titleId = titleIdOf(file, stfs || undefined); if (!titleId) return null;
  const hit = db && db[titleId]; if (!hit && db && Object.keys(db).length && !unknownLogged.has(titleId)) { unknownLogged.add(titleId); log('x360', path.basename(file), 'title id', titleId, 'not in the title list'); }
  return { titleId, title: hit ? hit.title : null, compat: hit ? hit.state : null };
}

// (beta.9) changes whenever the title list is (re)loaded: part of the scanner's key, so kept scans pick up the new titles
const stamp = () => (db ? 1 : 0) + ':' + dbAt;
module.exports = { init, ensureDb, lookup, titleIdOf, xexTitleId, stamp, stfsInfo, isStfsCandidate };
