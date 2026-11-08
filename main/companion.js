// Phone companion: a small web server on this PC's home network so a phone on the same Wi-Fi can browse the library,
// start a game on the TV, read its manual, and work as a remote (d-pad, face buttons) and keyboard.
// Off until switched on in Settings → Phone companion. Plain Node http, no frameworks; the pairing QR code is drawn here
// (a tiny encoder below), nothing is fetched from the internet.
// Safety: it listens on the home-network address only and answers private-range addresses only; every API call needs the
// long random token a phone gets when it pairs with the 6-digit PIN (5 wrong PINs lock pairing for 10 minutes); tokens
// are stored only as hashes; pictures and manual pages go out under random ids, never file paths; the log records
// pairing events but never a PIN or token.
'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const url = require('url');

const DEFAULT_PORT = 8730, MAX_PHONES = 12, PIN_TRIES = 5, LOCK_MS = 10 * 60e3, COOKIE = 'bs_phone';
const BUTTONS = new Set(['up', 'down', 'left', 'right', 'a', 'b', 'x', 'y', 'lb', 'rb', 'start', 'view', 'home']);
const KEYS = new Set(['Backspace', 'Enter', 'Escape']);
const THUMB_H = [180, 360, 480, 720, 1080, 1600]; // the heights the phone's page asks for (/img/…?h=)
const IMG_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', avif: 'image/avif' }; // (no SVG: it could carry script on this origin)

let D = { log: () => {} }; // what main.js hands over (see init)
let store = { enabled: false, port: DEFAULT_PORT, phones: [] }, storeFile = null;
let server = null, bound = null, startErr = '', note = '', pin = '', bad = 0, lockUntil = 0, locks = 0, netT = null, starting = null, triedIp = null;
const sockets = new Set();

/* ---------- the pairing QR code: byte mode, error correction M, versions 1–10 (up to 213 bytes: a URL needs ~40) ---------- */
const FA = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], QR_ECC = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26], QR_BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const gfMul = (x, y) => { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11D); z ^= ((y >>> i) & 1) * x; } return z & 0xFF; };
function rsDivisor(n) { const r = new Array(n).fill(0); r[n - 1] = 1; let root = 1; for (let i = 0; i < n; i++) { for (let j = 0; j < n; j++) { r[j] = gfMul(r[j], root); if (j + 1 < n) r[j] ^= r[j + 1]; } root = gfMul(root, 2); } return r; }
function rsRemainder(data, div) { const r = div.map(() => 0); for (const b of data) { const f = b ^ r.shift(); r.push(0); div.forEach((c, i) => { r[i] ^= gfMul(c, f); }); } return r; }
const rawModules = v => { let r = (16 * v + 128) * v + 64; if (v >= 2) { const n = Math.floor(v / 7) + 2; r -= (25 * n - 10) * n - 55; if (v >= 7) r -= 36; } return r; };
const dataCodewords = v => Math.floor(rawModules(v) / 8) - QR_ECC[v] * QR_BLOCKS[v];
function alignPos(v) { if (v === 1) return []; const n = Math.floor(v / 7) + 2, step = Math.ceil((v * 4 + 4) / (n * 2 - 2)) * 2, r = [6]; for (let p = v * 4 + 10; r.length < n; p -= step) r.splice(1, 0, p); return r; }
function qrMatrix(text) {
  const bytes = [...Buffer.from(String(text), 'utf8')];
  let v = 1; while (v <= 10 && 4 + (v < 10 ? 8 : 16) + bytes.length * 8 > dataCodewords(v) * 8) v++;
  if (v > 10) throw new Error('Too long for a QR code.');
  const bits = [], put = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(4, 4); put(bytes.length, v < 10 ? 8 : 16); bytes.forEach(b => put(b, 8));
  const cap = dataCodewords(v) * 8; put(0, Math.min(4, cap - bits.length)); put(0, (8 - bits.length % 8) % 8);
  for (let pad = 0xEC; bits.length < cap; pad ^= 0xEC ^ 0x11) put(pad, 8);
  const data = []; for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  // error correction per block, then interleaved
  const nb = QR_BLOCKS[v], ecl = QR_ECC[v], raw = Math.floor(rawModules(v) / 8), nShort = nb - raw % nb, shortLen = Math.floor(raw / nb), div = rsDivisor(ecl), blocks = [];
  for (let i = 0, k = 0; i < nb; i++) { const d = data.slice(k, k + shortLen - ecl + (i < nShort ? 0 : 1)); k += d.length; const e = rsRemainder(d, div); if (i < nShort) d.push(0); blocks.push(d.concat(e)); }
  const cw = []; for (let i = 0; i < blocks[0].length; i++) blocks.forEach((b, j) => { if (i !== shortLen - ecl || j >= nShort) cw.push(b[i]); });
  const size = v * 4 + 17, M = [...Array(size)].map(() => new Array(size).fill(false)), F = [...Array(size)].map(() => new Array(size).fill(false));
  const set = (x, y, d) => { M[y][x] = !!d; F[y][x] = true; };
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const x = cx + dx, y = cy + dy, dist = Math.max(Math.abs(dx), Math.abs(dy)); if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, dist !== 2 && dist !== 4); }
  const ap = alignPos(v), na = ap.length;
  for (let i = 0; i < na; i++) for (let j = 0; j < na; j++) { if ((i === 0 && j === 0) || (i === 0 && j === na - 1) || (i === na - 1 && j === 0)) continue; for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ap[i] + dx, ap[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1); }
  const format = mask => { const d = (0 << 3) | mask; let r = d; for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537); const b = ((d << 10) | r) ^ 0x5412, bit = i => (b >>> i) & 1; // ECC level M = 0
    for (let i = 0; i <= 5; i++) set(8, i, bit(i)); set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8)); for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i)); for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i)); set(8, size - 8, true); };
  format(0);
  if (v >= 7) { let r = v; for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1F25); const b = (v << 12) | r; for (let i = 0; i < 18; i++) { const c = (b >>> i) & 1, a = size - 11 + i % 3, k = Math.floor(i / 3); set(a, k, c); set(k, a, c); } }
  let i = 0; for (let right = size - 1; right >= 1; right -= 2) { if (right === 6) right = 5; for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) { const x = right - j, y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert; if (!F[y][x] && i < cw.length * 8) { M[y][x] = ((cw[i >>> 3] >>> (7 - (i & 7))) & 1) === 1; i++; } } }
  const MASKS = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, x => x % 3 === 0, (x, y) => (x + y) % 3 === 0, (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => x * y % 2 + x * y % 3 === 0, (x, y) => (x * y % 2 + x * y % 3) % 2 === 0, (x, y) => ((x + y) % 2 + x * y % 3) % 2 === 0];
  const apply = m => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!F[y][x] && MASKS[m](x, y)) M[y][x] = !M[y][x]; };
  // the mask with the fewest long runs / 2×2 blocks / imbalance (a simplified penalty: any mask scans, this picks a clean one)
  const penalty = () => { let p = 0, dark = 0; for (let y = 0; y < size; y++) { let rx = 1, ry = 1; for (let x = 0; x < size; x++) { if (M[y][x]) dark++;
    if (x > 0) { if (M[y][x] === M[y][x - 1]) { rx++; if (rx === 5) p += 3; else if (rx > 5) p++; } else rx = 1; if (M[x][y] === M[x - 1][y]) { ry++; if (ry === 5) p += 3; else if (ry > 5) p++; } else ry = 1; }
    if (x > 0 && y > 0 && M[y][x] === M[y][x - 1] && M[y][x] === M[y - 1][x] && M[y][x] === M[y - 1][x - 1]) p += 3; } }
    // finder-like stretches (dark-light-dark×3-light-dark next to four light): they confuse scanners
    const fp = (get) => { let k = 0; for (let a = 0; a < size; a++) for (let b = 0; b + 10 < size; b++) { let s1 = true, s2 = true; for (let t = 0; t < 11; t++) { const m = get(a, b + t); if (m !== !!FA[t]) s1 = false; if (m !== !!FA[10 - t]) s2 = false; if (!s1 && !s2) break; } if (s1) k++; if (s2) k++; } return k; };
    p += 40 * (fp((a, b) => M[a][b]) + fp((a, b) => M[b][a]));
    return p + Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10; };
  let best = 0, bp = Infinity; for (let m = 0; m < 8; m++) { apply(m); format(m); const p = penalty(); if (p < bp) { bp = p; best = m; } apply(m); }
  apply(best); format(best); return M;
}
function qrSvg(text) { const M = qrMatrix(text), n = M.length, q = 4; let d = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (M[y][x]) d += `M${x + q} ${y + q}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + q * 2} ${n + q * 2}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`; }

/* ---------- addresses ---------- */
// private ranges only: 10/8, 172.16/12, 192.168/16, link-local fe80::/10, loopback (::1, 127/8); IPv4 seen through IPv6 (::ffff:a.b.c.d) counts as IPv4
function isPrivate(addr) {
  let a = String(addr || '').toLowerCase().replace(/%.*$/, ''); const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a); if (m) a = m[1];
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (v4) { const [o1, o2] = [+v4[1], +v4[2]]; if ([1, 2, 3, 4].some(i => +v4[i] > 255)) return false; return o1 === 10 || (o1 === 172 && o2 >= 16 && o2 <= 31) || (o1 === 192 && o2 === 168) || o1 === 127; }
  if (a === '::1') return true;
  return /^fe[89ab][0-9a-f]:/.test(a); // fe80::/10
}
// the PC's address on the home network: a private IPv4 on a real adapter (virtual ones for VMs, WSL or VPNs left out)
const VIRTUAL = /vethernet|virtualbox|vmware|hyper-v|wsl|docker|vbox|loopback|tailscale|zerotier|hamachi|vpn|tap-|tun|npcap/i;
function lanAddress(ifs) {
  let L = []; try { ifs = ifs || os.networkInterfaces(); } catch { ifs = {}; }
  for (const [name, list] of Object.entries(ifs || {})) for (const x of list || []) if (x && (x.family === 'IPv4' || x.family === 4) && !x.internal && isPrivate(x.address) && !/^127\./.test(x.address) && !/^169\.254\./.test(x.address)) L.push({ name, ip: x.address });
  const rank = e => (VIRTUAL.test(e.name) ? 10 : 0) + (/^192\.168\./.test(e.ip) ? 0 : /^10\./.test(e.ip) ? 1 : 2) + (/wi-?fi|wlan|ethernet|^eth|^en/i.test(e.name) ? 0 : 1);
  L.sort((a, b) => rank(a) - rank(b)); return L[0] ? L[0].ip : null;
}

/* ---------- stored state (pairings live here, not in the settings file: backups never carry them) ---------- */
function load() { try { const j = JSON.parse(fs.readFileSync(storeFile, 'utf8')); store = { enabled: !!j.enabled, port: validPort(j.port) || DEFAULT_PORT, phones: Array.isArray(j.phones) ? j.phones.filter(p => p && typeof p.hash === 'string' && /^[0-9a-f]{64}$/.test(p.hash)).slice(-MAX_PHONES) : [] }; } catch { store = { enabled: false, port: DEFAULT_PORT, phones: [] }; } }
let saveT = null;
function save(now) { clearTimeout(saveT); saveT = null; if (!now) { saveT = setTimeout(() => save(true), 1500); if (saveT.unref) saveT.unref(); return; } if (!storeFile) return;
  const tmp = storeFile + '.' + process.pid + '.tmp'; try { fs.mkdirSync(path.dirname(storeFile), { recursive: true }); fs.writeFileSync(tmp, JSON.stringify(store)); fs.renameSync(tmp, storeFile); } catch (e) { try { fs.unlinkSync(tmp); } catch {} D.log('Phone companion: could not save', e.message); } }
const validPort = p => { p = Math.round(+p); return p >= 1024 && p <= 65535 ? p : 0; };
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
function newPin() { pin = String(crypto.randomInt(0, 1e6)).padStart(6, '0'); }
function phoneFor(req) {
  const c = String(req.headers.cookie || '').split(/;\s*/).map(x => x.split('=')).find(x => x[0] === COOKIE); const t = c && c.slice(1).join('=');
  if (!t || t.length < 20 || t.length > 200) return null; const h = Buffer.from(sha(t), 'hex');
  return store.phones.find(p => { const b = Buffer.from(p.hash, 'hex'); return b.length === h.length && crypto.timingSafeEqual(b, h); }) || null;
}
function phoneName(given, ua) { const g = String(given || '').replace(/[^\p{L}\p{N} '’()._-]/gu, '').trim().slice(0, 40); if (g) return g; ua = String(ua || '');
  return /iPad/.test(ua) ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : /Android/.test(ua) ? ((/;\s*([^;)]+?)\s+Build\//.exec(ua) || [])[1] || 'Android phone').slice(0, 40) : 'Phone'; }

/* ---------- random ids for everything the phone may ask for (game ids and pictures carry file paths) ---------- */
const secret = crypto.randomBytes(16); // new every run: yesterday's ids lead nowhere
const oid = (k, s) => k + crypto.createHmac('sha256', secret).update(k + '\0' + s).digest('base64url').slice(0, 22);
let files = new Map(), games = new Map(), libSrc = null, libHidden = '', libJson = null;
function fileOf(u) { u = String(u || ''); try { if (u.startsWith('bsfile://local/')) return decodeURIComponent(u.slice(15).split('?')[0]); if (u.startsWith('file:')) return url.fileURLToPath(u.split('?')[0]); } catch {} return null; }
function imgId(u) { const f = fileOf(u); if (!f || !IMG_EXT[path.extname(f).slice(1).toLowerCase()]) return null; const id = oid('i', f); files.set(id, f); return id; }
function library() {
  let src = null; try { src = D.library ? D.library() : null; } catch {} if (!Array.isArray(src)) src = [];
  let hid = []; try { hid = (D.hidden && D.hidden()) || []; } catch {} const hk = hid.join('\n');
  if (src === libSrc && hk === libHidden && libJson) return libJson;
  const hs = new Set(hid), nf = new Map(), ng = new Map(); files = nf; games = ng; // rebuilt from this library only: nothing else can be named
  const shelves = [];
  for (const s of src) { if (!s || !Array.isArray(s.games) || s.kind === 'home') continue; const L = [];
    for (const g of s.games) { if (!g || hs.has(g.id) || !['rom', 'steam', 'app'].includes(g.kind)) continue; const id = oid('g', s.id + '\0' + g.id); ng.set(id, { s, g });
      const a = g.art || {}; L.push({ id, t: String(g.title || ''), c: imgId(a.front) || imgId(a.icon) || null, m: Array.isArray(a.manual) && a.manual.length ? 1 : 0, k: g.kind === 'rom' ? undefined : g.kind }); }
    if (L.length) shelves.push({ id: String(s.id), name: String(s.name || s.id), kind: s.kind, games: L }); }
  libSrc = src; libHidden = hk; libJson = { shelves }; return libJson;
}
const gameById = id => { library(); return games.get(String(id || '')) || null; };
const pick = (o, keys) => { const r = {}; for (const k of keys) if (o && o[k] != null && o[k] !== '') r[k] = o[k]; return r; };
function gameView(e) { const { s, g } = e, a = g.art || {}, info = g.info || {};
  return { id: oid('g', s.id + '\0' + g.id), t: g.title, shelf: s.name, shelfId: s.id, kind: g.kind, region: g.region || undefined, size: g.sizeBytes || undefined,
    cover: imgId(a.front) || imgId(a.icon), hero: imgId(a.hero), back: imgId(a.back),
    manual: (Array.isArray(a.manual) ? a.manual : []).map(imgId).filter(Boolean), manualPdf: !!a.manualPdf && !(a.manual || []).length,
    info: pick(info, ['overview', 'release', 'year', 'dev', 'pub', 'genres', 'players', 'coop', 'rating', 'esrb']), ra: g.kind === 'rom' && !!(D.raFor && D.raFor(s.id)) }; }
function titleOfRunning() { let r = null; try { r = D.running && D.running(); } catch {} if (!r) return null; library();
  for (const { s, g } of games.values()) if (r.id && (g.id === r.id || s.id + ':' + g.file === r.id || 'steam-' + g.appid === r.id)) return { title: g.title, kind: r.kind || g.kind };
  return { title: r.title || '', kind: r.kind || '' }; }

/* ---------- the web server ---------- */
const STATIC = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/app.css': ['app.css', 'text/css; charset=utf-8'], '/icon.svg': ['icon.svg', 'image/svg+xml'], '/manifest.json': ['manifest.json', 'application/manifest+json'] };
const FONTS = { '/font/lexend-400.woff2': 'lexend-latin-400-normal.woff2', '/font/lexend-600.woff2': 'lexend-latin-600-normal.woff2', '/font/lexend-800.woff2': 'lexend-latin-800-normal.woff2' };
const staticCache = new Map();
const HEAD = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Cross-Origin-Resource-Policy': 'same-origin' };
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
function send(res, code, body, type, extra) { if (res.headersSent) return; const b = Buffer.isBuffer(body) ? body : Buffer.from(String(body)); res.writeHead(code, { ...HEAD, 'Content-Type': type, 'Content-Length': b.length, ...(extra || {}) }); res.end(b); }
const json = (res, code, obj, extra) => send(res, code, JSON.stringify(obj), 'application/json; charset=utf-8', { 'Cache-Control': 'no-store', ...(extra || {}) });
// a few requests a second per address is plenty for a remote; bursts allowed (opening the library loads many covers)
const buckets = new Map();
function allow(ip, cost) { const now = Date.now(); let b = buckets.get(ip); if (!b) { if (buckets.size > 256) buckets.clear(); b = { t: now, n: 200 }; buckets.set(ip, b); }
  b.n = Math.min(200, b.n + (now - b.t) * 0.06); b.t = now; if (b.n < cost) return false; b.n -= cost; return true; } // 60 a second, 200 at once
function body(req, max) { return new Promise((resolve, reject) => { const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase(); if (ct !== 'application/json') return reject(Object.assign(new Error('JSON only'), { code: 415 }));
  let n = 0; const parts = []; req.on('data', c => { n += c.length; if (n > max) { reject(Object.assign(new Error('Too big'), { code: 413 })); req.destroy(); } else parts.push(c); });
  req.on('end', () => { try { const o = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'); resolve(o && typeof o === 'object' && !Array.isArray(o) ? o : {}); } catch { reject(Object.assign(new Error('Bad JSON'), { code: 400 })); } }); req.on('error', reject); }); }
const wait = ms => new Promise(r => setTimeout(r, ms));
function glyphs() { let g = {}; try { g = (D.glyphs && D.glyphs()) || {}; } catch {} return { style: ['ps', 'nintendo'].includes(g.style) ? g.style : 'xbox', swap: !!g.swap }; }

async function handle(req, res) {
  const ip = req.socket.remoteAddress;
  if (!isPrivate(ip)) { req.socket.destroy(); return; } // not from the home network: no answer at all
  const u = new URL(req.url || '/', 'http://x'), p = u.pathname, api = p.startsWith('/api/');
  if (!allow(ip, p.startsWith('/img/') ? 0.5 : 1)) return json(res, 429, { error: 'Slow down a little.' }, { 'Retry-After': '2' });
  // an address typed as numbers only (what the QR code and Settings show): a web page under some other name can't reach here by renaming itself to this PC (DNS rebinding)
  const host = String(req.headers.host || '');
  if (!/^(\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:.%]+\])(:\d+)?$/i.test(host)) return json(res, 421, { error: 'Use the address shown in Boxshelf.' });
  if (req.method === 'POST') { const o = req.headers.origin; if (o && o !== 'http://' + host) return json(res, 403, { error: 'Wrong origin.' }); }
  if (req.method === 'GET' && (STATIC[p] || FONTS[p])) return serveStatic(res, p);
  if (req.method === 'POST' && p === '/api/pair') return pair(req, res, ip);
  if (!api && !p.startsWith('/img/')) return json(res, 404, { error: 'Not found.' });
  const phone = phoneFor(req); if (!phone) return json(res, 401, { error: 'Pair this phone first.' });
  if (Date.now() - (phone.seen || 0) > 10 * 60e3) { phone.seen = Date.now(); save(); }
  try {
    if (req.method === 'GET') {
      if (p.startsWith('/img/')) return serveImg(res, p.slice(5), u.searchParams.get('h'));
      if (p === '/api/me') return json(res, 200, { name: phone.name, version: D.version || '' });
      if (p === '/api/status') return json(res, 200, { running: titleOfRunning(), glyphs: glyphs(), homeMenu: !D.homeMenu || D.homeMenu() !== false });
      if (p === '/api/library') return json(res, 200, { ...library(), glyphs: glyphs() });
      if (p === '/api/game') { const e = gameById(u.searchParams.get('id')); return e ? json(res, 200, gameView(e)) : json(res, 404, { error: 'That game is gone. Pull to refresh.' }); }
      if (p === '/api/ach') { const e = gameById(u.searchParams.get('id')); if (!e || e.g.kind !== 'rom' || !D.achievements) return json(res, 200, { ach: null });
        let t; const r = await Promise.race([Promise.resolve().then(() => D.achievements(e.s.id, e.g.title)).catch(() => null), new Promise(ok => { t = setTimeout(() => ok(null), 6000); })]).finally(() => clearTimeout(t));
        const n = v => Math.max(0, Math.round(+v || 0)); // numbers only: the phone puts these into its page
        return json(res, 200, { ach: r && n(r.total) ? { earned: n(r.earned), total: n(r.total), points: n(r.points), pointsEarned: n(r.pointsEarned), mastered: !!r.mastered } : null }); }
      return json(res, 404, { error: 'Not found.' });
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'Not allowed.' });
    const o = await body(req, 4096);
    if (p === '/api/input') { const b = String(o.b || ''); if (!BUTTONS.has(b)) return json(res, 400, { error: 'Unknown button.' }); D.input && D.input({ b, d: !!o.d }); return json(res, 200, { ok: true }); }
    if (p === '/api/text') { if (typeof o.key === 'string') { if (!KEYS.has(o.key)) return json(res, 400, { error: 'Unknown key.' }); D.input && D.input({ key: o.key }); return json(res, 200, { ok: true }); }
      const t = String(o.text == null ? '' : o.text).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200); if (!t) return json(res, 400, { error: 'Nothing to type.' }); D.input && D.input({ text: t }); return json(res, 200, { ok: true }); }
    if (p === '/api/play') return play(res, o, phone);
    if (p === '/api/quit') { const r = titleOfRunning(); if (!r) return json(res, 200, { ok: true, running: null }); D.log('Phone companion: a phone asked to quit', r.title || 'the game'); await D.quit(); return json(res, 200, { ok: true }); }
    if (p === '/api/unpair') { forget(phone.id, 'unpaired itself'); return json(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict` }); }
    return json(res, 404, { error: 'Not found.' });
  } catch (e) { const c4 = typeof e.code === 'number' && e.code >= 400 && e.code < 500; return json(res, c4 ? e.code : 500, { error: c4 ? e.message : 'Something went wrong.' }); } // only our own 4xx messages go out: a file error's text ('ENOENT', …) carries a path
}
async function play(res, o, phone) {
  const e = gameById(o.id); if (!e) return json(res, 404, { error: 'That game is gone. Pull to refresh.' });
  let r = titleOfRunning();
  if (r && !o.quit) return json(res, 409, { running: r }); // the phone asks "Quit <game>?" and comes back with quit: true
  if (r) { D.log('Phone companion: a phone quit', r.title || 'the game', 'to play', e.g.title); await D.quit(); for (let i = 0; i < 60 && titleOfRunning(); i++) await wait(250); if (titleOfRunning()) return json(res, 409, { running: titleOfRunning(), stuck: true }); }
  D.log('Phone companion: a phone started', e.g.title);
  const ok = await D.play({ shelf: e.s.id, id: e.g.id, title: e.g.title }); return json(res, ok === false ? 503 : 200, ok === false ? { error: 'Boxshelf is busy. Try again in a moment.' } : { ok: true });
}
function serveStatic(res, p) {
  const font = FONTS[p], key = font ? 'f:' + font : p; let c = staticCache.get(key);
  if (!c) { try { const f = font ? path.join(D.fontDir || '', font) : path.join(D.webDir || '', STATIC[p][0]); c = { b: fs.readFileSync(f), t: font ? 'font/woff2' : STATIC[p][1] }; if (!D.dev) staticCache.set(key, c); } catch { return json(res, 404, { error: 'Not found.' }); } }
  send(res, 200, c.b, c.t, { 'Cache-Control': font ? 'max-age=604800' : 'no-cache', ...(p === '/' ? { 'Content-Security-Policy': CSP } : {}) });
}
async function serveImg(res, id, h) {
  const f = files.get(String(id)); if (!f) return json(res, 404, { error: 'Not found.' });
  const type = IMG_EXT[path.extname(f).slice(1).toLowerCase()]; if (!type) return json(res, 404, { error: 'Not found.' });
  let st; try { st = await fs.promises.stat(f); if (!st.isFile()) throw 0; } catch { return json(res, 404, { error: 'Not found.' }); }
  // the height snaps to a few sizes: every other number would be one more decode and one more file in data\thumbs per picture
  const cache = { 'Cache-Control': 'private, max-age=86400' }, h0 = Math.round(+h || 0), H = h0 >= 64 ? THUMB_H.find(x => x >= h0) || THUMB_H[THUMB_H.length - 1] : 0;
  if (H && D.thumb) { const b = await Promise.resolve(D.thumb(f, st, H)).catch(() => null); if (b && b.length) return send(res, 200, b, 'image/jpeg', cache); } // the shelf's own cached thumbnails: a phone doesn't need a 4 MB scan for a 300 px tile
  if (st.size > 40 * 1024 * 1024) return json(res, 413, { error: 'Too big.' });
  res.writeHead(200, { ...HEAD, 'Content-Type': type, 'Content-Length': st.size, ...cache }); require('stream').pipeline(fs.createReadStream(f), res, () => {}); // (beta.8: a phone that drops the request closes the file too)
}
async function pair(req, res, ip) {
  let o; try { o = await body(req, 1024); } catch (e) { return json(res, e.code || 400, { error: e.message }); }
  const now = Date.now(); if (now < lockUntil) return json(res, 429, { error: 'Too many wrong PINs. Try again in a few minutes.', retry: Math.ceil((lockUntil - now) / 1000) });
  const given = Buffer.from(String(o.pin == null ? '' : o.pin).replace(/\D/g, '').slice(0, 6).padEnd(6, 'x')), want = Buffer.from(pin.padEnd(6, '-'));
  if (!pin || !crypto.timingSafeEqual(given, want)) {
    bad++; const left = PIN_TRIES - bad; D.log('Phone companion: wrong PIN', `(${bad} of ${PIN_TRIES})`);
    // each lockout in a row lasts twice as long (10 min up to about 5 h): someone guessing on the Wi-Fi gets ~5 tries an
    // hour instead of 30; a pairing, or New PIN on the TV (you're there), starts again from 10 minutes
    if (left <= 0) { bad = 0; const ms = LOCK_MS * 2 ** Math.min(locks++, 5), min = Math.round(ms / 60e3); lockUntil = now + ms; D.log('Phone companion: pairing locked for', min, 'minutes after', PIN_TRIES, 'wrong PINs'); changed(); return json(res, 429, { error: `Too many wrong PINs. Pairing is locked for ${min} minutes.`, retry: ms / 1000 }); }
    return json(res, 403, { error: `That PIN isn't right. ${left} ${left === 1 ? 'try' : 'tries'} left.` });
  }
  bad = 0; locks = 0; const token =crypto.randomBytes(32).toString('base64url'), phone = { id: crypto.randomBytes(6).toString('hex'), name: phoneName(o.name, req.headers['user-agent']), hash: sha(token), added: now, seen: now };
  store.phones.push(phone); while (store.phones.length > MAX_PHONES) store.phones.shift(); save(true);
  newPin(); // a PIN pairs one phone: someone who saw it over your shoulder can't use it again
  D.log('Phone companion: a phone paired'); changed(); // (beta.10: its name and address stay out of the log, which goes into problem reports)
  return json(res, 200, { ok: true, name: phone.name }, { 'Set-Cookie': `${COOKIE}=${token}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict` });
}

/* ---------- start / stop ---------- */
function listenOn(ip, port) { return new Promise((resolve, reject) => {
  const s = http.createServer((req, res) => { handle(req, res).catch(() => { try { json(res, 500, { error: 'Something went wrong.' }); } catch {} }); });
  s.headersTimeout = 10000; s.requestTimeout = 15000; s.keepAliveTimeout = 5000; s.maxConnections = 64; s.maxHeadersCount = 40;
  s.on('connection', c => { if (!isPrivate(c.remoteAddress)) { c.destroy(); return; } sockets.add(c); c.on('close', () => sockets.delete(c)); });
  s.once('error', reject); s.listen({ host: ip, port, exclusive: true }, () => { s.removeListener('error', reject); s.on('error', e => D.log('Phone companion:', e.message)); resolve(s); }); }); }
async function start() {
  if (starting) return starting;
  starting = (async () => { await stopServer(); startErr = ''; note = '';
    const ip = D.lanAddress ? D.lanAddress() : lanAddress(); triedIp = ip;
    // the router can hand this PC a new address (or it moves to another network): follow it. Set up before anything can return early: with no address at all at start (Wi-Fi
    // not connected yet at login) it must still notice the network arriving
    clearInterval(netT); netT = setInterval(() => { const now = D.lanAddress ? D.lanAddress() : lanAddress(); if (store.enabled && !starting && now !== triedIp) { /* (compared with the address last tried: with every port busy it used to "restart" every 30 s) */ D.log('Phone companion: network address changed, restarting'); start().then(changed); } }, 30000); if (netT.unref) netT.unref();
    if (!ip) { startErr = 'No home network found. Connect this PC to your router (Wi-Fi or cable).'; D.log('Phone companion: no home network address'); return; }
    const want = store.port || DEFAULT_PORT;
    for (let port = want; port < want + 10 && port <= 65535; port++) {
      try { server = await listenOn(ip, port); bound = { ip, port }; if (port !== want) note = `Port ${want} is used by another program, so ${port} is used instead.`; newPin(); bad = 0; D.log('Phone companion: on, port', port); break; }
      catch (e) { if (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') { startErr = `Couldn't start: ${e.message}`; D.log('Phone companion:', e.message); break; } }
    }
    if (!server && !startErr) startErr = `Ports ${want}–${want + 9} are all in use. Choose another port.`;
  })().finally(() => { starting = null; });
  await starting; changed();
}
function stopServer() { const s = server; server = null; bound = null; pin = ''; if (!s) return Promise.resolve();
  return new Promise(r => { s.close(() => r()); try { s.closeAllConnections(); } catch {} for (const c of sockets) { try { c.destroy(); } catch {} } sockets.clear(); setTimeout(r, 1000); }); }
// a start still under way finishes first (switched on, then straight off again: its server must not come up after the stop);
// a pending "last seen" save is written now (quitting)
async function stop() { if (starting) await starting.catch(() => {}); clearInterval(netT); netT = null; await stopServer(); if (saveT) save(true); }

/* ---------- what main.js calls ---------- */
let changedT = null;
function changed() { clearTimeout(changedT); changedT = setTimeout(() => { try { D.changed && D.changed(state()); } catch {} }, 30); }
// deps: log, dataDir, webDir, fontDir, version, library(), hidden(), glyphs(), running(), play(), quit(), input(), thumb(), achievements(), raFor(), homeMenu(), changed()
function init(deps) { D = Object.assign({ log: () => {} }, deps || {}); storeFile = path.join(D.dataDir || os.tmpdir(), 'companion.json'); load(); if (store.enabled) start().catch(e => D.log('Phone companion:', e.message)); }
function state() {
  const on = !!(server && bound), base = on ? `http://${bound.ip}:${bound.port}` : '', lock = Math.max(0, lockUntil - Date.now());
  let qr = ''; if (on && pin) { try { qr = qrSvg(`${base}/#pin=${pin}`); } catch {} }
  return { enabled: store.enabled, on, starting: !!starting, url: base, port: on ? bound.port : store.port, wantPort: store.port, pin: on ? pin : '', qr, error: startErr, note, locked: lock ? Math.ceil(lock / 60000) : 0,
    phones: store.phones.map(p => ({ id: p.id, name: p.name, added: p.added, seen: p.seen })) };
}
async function set(o) { o = o || {}; let restart = false;
  if (o.port != null) { const p = validPort(o.port); if (!p) throw new Error('Choose a port from 1024 to 65535.'); if (p !== store.port) { store.port = p; restart = true; } }
  if (o.enabled != null && !!o.enabled !== store.enabled) { store.enabled = !!o.enabled; restart = true; D.log('Phone companion:', store.enabled ? 'switched on' : 'switched off'); }
  save(true);
  if (restart) { if (store.enabled) await start(); else { await stop(); startErr = ''; note = ''; changed(); } }
  return state();
}
function forget(id, why) {
  if (id === 'all') { const n = store.phones.length; store.phones = []; D.log('Phone companion: forgot all phones', `(${n})`); }
  else { const p = store.phones.find(x => x.id === id); if (!p) return state(); store.phones = store.phones.filter(x => x !== p); D.log('Phone companion:', why || 'forgot', 'a phone'); }
  save(true); changed(); return state();
}
function renewPin() { if (server) { newPin(); bad = 0; locks = 0; lockUntil = 0; /* asked for on the TV itself: a lockout from wrong guesses ends with the old PIN */ D.log('Phone companion: new PIN'); changed(); } return state(); }

module.exports = { init, start, stop, set, state, forget, renewPin, isPrivate, lanAddress, qrMatrix, qrSvg, _test: { handle, phoneName, fileOf, library, pinNow: () => pin, bound: () => bound } };
