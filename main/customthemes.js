// Custom themes (1.76, Windows): a picture behind the shelf, made by the user. Each one is a folder in "Custom themes"
// beside Boxshelf:
//   background.jpg / .png / .webp / .svg   the picture (required; a folder with a single picture uses that one)
//   gc.jpg, ps2.png, …                     optional: a picture for one console's shelf (named after its id)
//   theme.json                             optional: { "name", "accent": "#rrggbb", "shade": 0-0.9, "blur": true/false,
//                                          "glow": 0-1 } (anything missing gets a default; the accent is taken from the
//                                          picture's average colour)
// Only pictures and these few settings: a theme never runs code. Big pictures are scaled once to 2560 px wide and kept
// in a cache (keyed by file, date and size), so the shelf never decodes a 6000 px photo. The first time the folder is
// looked at it's created with three example themes (pictures drawn here as SVG), which show the format.
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');

let ROOT = '', CACHE = '', nativeImage = null, sysIds = new Set(), log = () => {};
function init(o) { ROOT = o.root; CACHE = o.cache; nativeImage = o.nativeImage || null; sysIds = new Set(o.systems || []); if (o.log) log = o.log; }
function root() { return ROOT; }

const PIC = /\.(jpe?g|png|webp|svg)$/i, RASTER = /\.(jpe?g|png)$/i; // (webp: nativeImage can't decode it, served as it is)
const MAX_W = 2560, MAX_THEMES = 60, MAX_JSON = 64 * 1024;
const slug = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const clamp = (v, lo, hi, d) => { const n = +v; return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const isHex = s => typeof s === 'string' && /^#[0-9a-f]{6}$/i.test(s.trim());

// a picture ready for the screen: big JPEG / PNG files scaled once into the cache
const prepMemo = new Map();
function prepared(file) {
  let st; try { st = fs.statSync(file); } catch { return null; }
  if (!RASTER.test(file) || !nativeImage) return file;
  const key = file + '|' + Math.floor(st.mtimeMs) + '|' + st.size; if (prepMemo.has(key)) return prepMemo.get(key);
  let out = file;
  try {
    const img = nativeImage.createFromPath(file), sz = img.isEmpty() ? null : img.getSize();
    if (sz && (sz.width > MAX_W * 1.1 || st.size > 6 * 1024 * 1024)) {
      const dst = path.join(CACHE, crypto.createHash('sha1').update(key).digest('hex').slice(0, 24) + '.jpg');
      if (!fs.existsSync(dst)) { fs.mkdirSync(CACHE, { recursive: true }); const tmp = `${dst}.${process.pid}.tmp`; // (beta.10) temp + rename: a cut-off write was trusted from then on
        try { fs.writeFileSync(tmp, img.resize({ width: Math.min(MAX_W, sz.width), quality: 'good' }).toJPEG(88)); fs.renameSync(tmp, dst); } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; } }
      out = dst;
    }
  } catch (e) { log('Custom theme: could not prepare', path.basename(file), e.message); }
  prepMemo.set(key, out); return out;
}
// the picture's average colour (a 1 x 1 scale of it), for the selection glow and Settings' accent
const accentMemo = new Map();
function accentOf(file) {
  if (!nativeImage || !RASTER.test(file)) return '#6b8cff';
  if (accentMemo.has(file)) return accentMemo.get(file);
  let hex = '#6b8cff';
  try { const b = nativeImage.createFromPath(file).resize({ width: 1, height: 1, quality: 'good' }).toBitmap(); if (b && b.length >= 3) hex = '#' + [b[2], b[1], b[0]].map(v => v.toString(16).padStart(2, '0')).join(''); } catch {}
  accentMemo.set(file, hex); return hex;
}

function readJson(dir) {
  const f = path.join(dir, 'theme.json');
  try { const st = fs.statSync(f); if (st.size > MAX_JSON) return {}; const o = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch { return {}; }
}

function list() {
  ensureExamples();
  let dirs = []; try { dirs = fs.readdirSync(ROOT, { withFileTypes: true }).filter(e => e.isDirectory()).slice(0, MAX_THEMES); } catch { return []; }
  const out = [], seen = new Set();
  for (const d of dirs) {
    const dir = path.join(ROOT, d.name); let files = [];
    try { files = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile() && PIC.test(e.name)).map(e => e.name); } catch { continue; }
    const bgName = files.find(n => /^background\./i.test(n)) || (files.length === 1 ? files[0] : null); if (!bgName) continue;
    const j = readJson(dir); let id = 'custom-' + (slug(d.name) || 'theme'); for (let n = 2; seen.has(id); n++) id = 'custom-' + slug(d.name) + '-' + n; seen.add(id);
    const bg = prepared(path.join(dir, bgName)); if (!bg) continue;
    const sys = {};
    for (const n of files) { const k = n.replace(PIC, '').toLowerCase(); if (n !== bgName && sysIds.has(k)) { const p = prepared(path.join(dir, n)); if (p) sys[k] = p; } }
    out.push({ id, name: (typeof j.name === 'string' && j.name.trim() ? j.name.trim() : d.name).slice(0, 40), folder: d.name, bg, sys,
      accent: isHex(j.accent) ? j.accent.trim().toLowerCase() : accentOf(bg), shade: clamp(j.shade, 0, .9, .35), blur: j.blur === true, glow: clamp(j.glow, 0, 1, .35) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

// "Make a theme from a picture": a new folder named after the picture (or the name given), the picture copied in as
// background.<ext>, and a theme.json to edit later. Returns the new theme's id.
function create(file, name) {
  if (!PIC.test(String(file || ''))) throw new Error('Choose a JPG, PNG, WebP or SVG picture.');
  if (!fs.statSync(file).isFile()) throw new Error('That picture is not there any more.');
  const nm = (String(name || '').trim() || path.basename(file).replace(PIC, '').replace(/[_-]+/g, ' ').trim() || 'My theme').slice(0, 40);
  const base = nm.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim() || 'My theme';
  fs.mkdirSync(ROOT, { recursive: true });
  let folder = base; for (let n = 2; fs.existsSync(path.join(ROOT, folder)); n++) folder = `${base} ${n}`;
  const dir = path.join(ROOT, folder); fs.mkdirSync(dir);
  fs.copyFileSync(file, path.join(dir, 'background' + path.extname(file).toLowerCase()));
  fs.writeFileSync(path.join(dir, 'theme.json'), JSON.stringify({ name: nm, shade: .35, blur: false, glow: .35 }, null, 2));
  log('Custom theme made:', folder);
  return 'custom-' + (slug(folder) || 'theme');
}

// ---------- the examples (written once, when the folder doesn't exist yet) ----------
function seeded(s) { return () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const r1 = n => Math.round(n * 10) / 10;
function hills(rnd, y0, amp, n) { let d = `M0 1080L0 ${r1(y0)}`; for (let i = 1; i <= n; i++) { const x = i * 1920 / n, y = y0 - amp * (.4 + .6 * rnd()); d += `Q${r1(x - 960 / n)} ${r1(y - amp * .5)} ${r1(x)} ${r1(y0 - amp * .2 * rnd())}`; } return d + 'L1920 1080Z'; }
function sunsetHills() {
  const rnd = seeded(11);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" preserveAspectRatio="xMidYMid slice"><defs>` +
    `<linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1b1446"/><stop offset=".45" stop-color="#7a2f6b"/><stop offset=".7" stop-color="#e2694a"/><stop offset="1" stop-color="#ffc277"/></linearGradient>` +
    `<radialGradient id="g" cx=".5" cy=".62" r=".35"><stop offset="0" stop-color="#ffe2a6" stop-opacity=".9"/><stop offset="1" stop-color="#ffb070" stop-opacity="0"/></radialGradient></defs>` +
    `<rect width="1920" height="1080" fill="url(#s)"/><circle cx="960" cy="650" r="420" fill="url(#g)"/><circle cx="960" cy="640" r="120" fill="#ffd89a"/>` +
    `<path d="${hills(rnd, 700, 120, 5)}" fill="#8a3a5e" opacity=".85"/><path d="${hills(rnd, 790, 140, 4)}" fill="#55224a"/><path d="${hills(rnd, 900, 120, 3)}" fill="#2a1030"/></svg>`;
}
function deepSpace() {
  const rnd = seeded(23); let stars = '';
  for (let i = 0; i < 260; i++) { const z = rnd(); stars += `<circle cx="${r1(rnd() * 1920)}" cy="${r1(rnd() * 1080)}" r="${r1(.6 + z * z * 1.8)}" opacity="${r1(.3 + z * .7)}"/>`; }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" preserveAspectRatio="xMidYMid slice"><defs>` +
    `<radialGradient id="n1" cx=".28" cy=".32" r=".45"><stop offset="0" stop-color="#5b2bb8" stop-opacity=".75"/><stop offset="1" stop-color="#5b2bb8" stop-opacity="0"/></radialGradient>` +
    `<radialGradient id="n2" cx=".74" cy=".58" r=".5"><stop offset="0" stop-color="#1f7ad6" stop-opacity=".6"/><stop offset="1" stop-color="#1f7ad6" stop-opacity="0"/></radialGradient>` +
    `<radialGradient id="p" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#ffcf9a"/><stop offset=".55" stop-color="#c0603a"/><stop offset="1" stop-color="#3a1408"/></radialGradient></defs>` +
    `<rect width="1920" height="1080" fill="#05060f"/><rect width="1920" height="1080" fill="url(#n1)"/><rect width="1920" height="1080" fill="url(#n2)"/>` +
    `<g fill="#ffffff">${stars}</g><circle cx="1560" cy="230" r="120" fill="url(#p)"/><ellipse cx="1560" cy="230" rx="210" ry="34" fill="none" stroke="#f2d2b0" stroke-opacity=".45" stroke-width="5" transform="rotate(-14 1560 230)"/></svg>`;
}
function oceanDusk() {
  let waves = '';
  for (let i = 0; i < 14; i++) { const y = 640 + i * 32 + i * i * 1.6, a = 10 + i * 2.2, ph = i * 37; let d = `M0 ${r1(y)}`; for (let x = 0; x <= 1920; x += 120) d += `L${x} ${r1(y + Math.sin((x + ph) / 140) * a)}`; waves += `<path d="${d}" fill="none" stroke="#9fe3ff" stroke-opacity="${r1(.08 + i * .02)}" stroke-width="${r1(1 + i * .25)}"/>`; }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" preserveAspectRatio="xMidYMid slice"><defs>` +
    `<linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#071a2e"/><stop offset=".5" stop-color="#14506a"/><stop offset=".6" stop-color="#2d8a96"/><stop offset=".61" stop-color="#0a3348"/><stop offset="1" stop-color="#03121e"/></linearGradient>` +
    `<radialGradient id="m" cx=".5" cy=".58" r=".3"><stop offset="0" stop-color="#bff3ff" stop-opacity=".55"/><stop offset="1" stop-color="#bff3ff" stop-opacity="0"/></radialGradient></defs>` +
    `<rect width="1920" height="1080" fill="url(#s)"/><ellipse cx="960" cy="640" rx="620" ry="190" fill="url(#m)"/><circle cx="1320" cy="250" r="54" fill="#e8fbff" opacity=".9"/>${waves}</svg>`;
}
const EXAMPLES = [['Sunset Hills', sunsetHills, { accent: '#e2694a', shade: .25, glow: .4 }], ['Deep Space', deepSpace, { accent: '#5b6bff', shade: .2, glow: .35 }], ['Ocean Dusk', oceanDusk, { accent: '#2d8a96', shade: .25, glow: .4 }]];
function ensureExamples() {
  if (!ROOT || fs.existsSync(ROOT)) return;
  try {
    fs.mkdirSync(ROOT, { recursive: true });
    for (const [name, draw, opts] of EXAMPLES) { const dir = path.join(ROOT, name); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'background.svg'), draw()); fs.writeFileSync(path.join(dir, 'theme.json'), JSON.stringify({ name, ...opts, blur: false }, null, 2)); }
    fs.writeFileSync(path.join(ROOT, 'How custom themes work.txt'), [
      'Each folder here is a theme. Put a picture in it named background (.jpg, .png, .webp or .svg).',
      'For one console only, add a picture named after its shelf: gc, wii, wiiu, sw, sw2, ps2, ps3, ps4, ps5, psp, x360, n3ds, pc.',
      'theme.json (optional): {"name": "My theme", "accent": "#6b8cff", "shade": 0.35, "blur": false, "glow": 0.35}',
      '  shade: how much darker the picture is made (0 to 0.9), so the shelf stays easy to read.',
      '  blur: true softens the picture.   glow: how bright the light under the shelf is (0 to 1).',
      'Then in Boxshelf: Settings > Display > Find themes again. Themes are only pictures and settings, never programs.', ''].join('\r\n'));
    log('Custom themes: made the folder with three examples');
  } catch (e) { log('Custom themes: could not make the folder', e.message); }
}

module.exports = { init, root, list, create, ensureExamples, _slug: slug };
