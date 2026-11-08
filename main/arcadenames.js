// (beta.7) Arcade and Neo Geo games are zips named by their ROM set ("sf2.zip", "mslug.zip"). FinalBurn Neo's game list
// (its ClrMame Pro XML, published in the FBNeo repository) says what each set is ("Street Fighter II - The World Warrior
// (World 910522)") and which sets are BIOS files (neogeo.zip, pgm.zip: not games). It's read once, streamed straight
// into a small table in the data folder (data/arcade-names.json; the 14 MB list itself is never kept), and the scanner
// names the games from it. Without the table (offline, first run) the set name is shown, as before.
const fs = require('fs');
const path = require('path');
const https = require('https');

const URL_DAT = 'https://raw.githubusercontent.com/libretro/FBNeo/master/dats/FinalBurn%20Neo%20(ClrMame%20Pro%20XML%2C%20Arcade%20only).dat';
const SYSTEMS = new Set(['arcade', 'neogeo']);
let file = '', log = () => {}, table = null, loaded = false, flight = null, failedAt = 0;

function init(dataDir, logger) { file = path.join(dataDir, 'arcade-names.json'); if (logger) log = logger; }
function load() {
  if (loaded) return table; loaded = true;
  try { const t = JSON.parse(fs.readFileSync(file, 'utf8')); if (t && t.names && typeof t.names === 'object') table = t; } catch {}
  return table;
}
const ready = () => !!load();
// set name -> { title, bios }; null when the table isn't there or doesn't know the set
function lookup(set) {
  const t = load(); if (!t) return null; const k = String(set || '').toLowerCase();
  if (t.bios && t.bios.includes(k)) return { title: '', bios: true };
  const d = Object.prototype.hasOwnProperty.call(t.names, k) ? t.names[k] : null;
  return d ? { title: d, bios: false } : null;
}
const unXml = s => s.replace(/&(amp|lt|gt|quot|apos|#(\d+)|#x([0-9a-f]+));/gi, (m, e, d, h) => d ? String.fromCodePoint(+d) : h ? String.fromCodePoint(parseInt(h, 16)) : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[e.toLowerCase()]);

// Streams the list and keeps only names: a line at a time, so the main process never holds or parses 14 MB at once.
function parse(stream) {
  return new Promise((resolve, reject) => {
    const names = {}, bios = []; let cur = null, rest = '', n = 0;
    const line = l => {
      const g = /<game\b([^>]*)>/.exec(l);
      if (g) { const nm = /\bname="([^"]+)"/.exec(g[1]); cur = nm ? nm[1].toLowerCase() : null; if (cur && /\bisbios="yes"/.test(g[1])) { bios.push(cur); cur = null; } } // (its description may follow on the same line)
      if (cur) { const d = /<description>([^<]*)<\/description>/.exec(l); if (d) { names[cur] = unXml(d[1]).trim(); cur = null; n++; } }
    };
    stream.setEncoding('utf8');
    stream.on('data', c => { const parts = (rest + c).split('\n'); rest = parts.pop(); for (const l of parts) line(l); });
    stream.on('end', () => { if (rest) line(rest); n > 100 ? resolve({ v: 1, at: Date.now(), names, bios }) : reject(new Error('arcade list: no games in it')); });
    stream.on('error', reject);
  });
}
function get(url, hops = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Boxshelf' } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops < 5) { res.resume(); return resolve(get(new URL(res.headers.location, url).toString(), hops + 1)); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('arcade list: HTTP ' + res.statusCode)); }
      resolve(res);
    });
    req.on('error', reject); req.setTimeout(60000, () => req.destroy(new Error('arcade list: timed out')));
  });
}
// Fetches the table once (concurrent calls share it; a failure waits 10 minutes before trying again). Resolves true when
// a new table was saved.
function fetchNames() {
  if (ready()) return Promise.resolve(false);
  if (flight) return flight;
  if (failedAt && Date.now() - failedAt < 10 * 60e3) return Promise.resolve(false);
  flight = get(URL_DAT).then(parse).then(t => {
    const tmp = file + '.part'; fs.writeFileSync(tmp, JSON.stringify(t)); fs.renameSync(tmp, file);
    table = t; loaded = true; log('Arcade names:', Object.keys(t.names).length, 'games,', t.bios.length, 'BIOS sets'); return true;
  }).catch(e => { failedAt = Date.now(); log('Arcade names:', e.message); return false; }).finally(() => { flight = null; });
  return flight;
}

module.exports = { init, lookup, ready, fetchNames, parse, SYSTEMS };
