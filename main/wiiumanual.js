// Wii U e-manuals → page images for the manual reader.
// Every Wii U game carries its manual as meta/Manual.bfma: a SARC of zlib-packed SARCs. Per language there are page
// layouts (BFLYT: background, content layers, a text layer, link buttons), pre-laid-out text lines, photos (JPEG);
// textures (BFLIM) are shared. Index.bflyt holds the page titles and chapters.
// This module reads all that and builds a "page model" — positioned drawing ops in page pixels (y down) — which a
// hidden window draws (renderer/wiiu-manual.js) and returns as images, saved as <game>-manual-NN.jpg next to the cover.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const zarchive = require('./zarchive');
const bflyt = require('./bflyt');
const gx2 = require('./gx2');

let dir = null, log = () => {};
const VERSION = (() => { try { return require('../package.json').version; } catch { return '0'; } })();
function init(dataDir, logger) { dir = path.join(dataDir, 'wiiu-manuals'); if (logger) log = logger; }

// SARC: "SARC" header (BOM decides endianness), SFAT node table, SFNT name table, then the data
function sarcList(buf) {
  if (!buf || buf.length < 0x20 || buf.toString('latin1', 0, 4) !== 'SARC') return null;
  const le = buf.readUInt16BE(6) === 0xFFFE, u16 = o => le ? buf.readUInt16LE(o) : buf.readUInt16BE(o), u32 = o => le ? buf.readUInt32LE(o) : buf.readUInt32BE(o);
  const hdr = u16(4), dataOff = u32(12), sfat = hdr;
  if (buf.toString('latin1', sfat, sfat + 4) !== 'SFAT') return null;
  const count = u16(sfat + 6), nodes = sfat + 12, sfnt = nodes + count * 16, names = sfnt + 8;
  const out = [];
  for (let i = 0; i < count; i++) {
    const o = nodes + i * 16, attr = u32(o + 4), start = u32(o + 8), end = u32(o + 12);
    let name = ''; if (attr & 0x01000000) { const no = names + (attr & 0xFFFF) * 4; let e = no; while (e < buf.length && buf[e]) e++; name = buf.toString('utf8', no, e); }
    out.push({ name, data: buf.subarray(dataOff + start, dataOff + end) });
  }
  return out;
}
// untrusted input: no single unpacked part may grow past these (a real .arc is a few MB, a whole e-book well under 100 MB)
const MAX_ARC = 128 << 20, MAX_ENTRY = 64 << 20, MAX_EPUB = 512 << 20;
// the .arc members are zlib-compressed SARCs (some tools leave them raw)
function arc(data) {
  let d = data;
  if (d[0] === 0x78) { try { d = zlib.inflateSync(d, { maxOutputLength: MAX_ARC }); } catch (e) { if (e && e.code === 'ERR_BUFFER_TOO_LARGE') throw new Error(`manual part unpacks past ${MAX_ARC >> 20} MB`); return null; } }
  return sarcList(d);
}
const toMap = list => new Map((list || []).map(e => [e.name.replace(/^.*\//, ''), e.data]));

function fromWua(file) {
  const z = zarchive.open(file);
  try {
    const base = z.root().find(n => !n.file && /^00050000[0-9a-f]{8}/i.test(n.name)) || z.root().find(n => !n.file);
    if (!base) return null; const node = z.lookup(base.name + '/meta/Manual.bfma'); return node && node.file ? z.read(node) : null;
  } finally { z.close(); }
}
function fromFolder(rpx) { const f = path.join(path.dirname(path.dirname(rpx)), 'meta', 'Manual.bfma'); try { return fs.readFileSync(f); } catch { return null; } }

// ---------- text ----------
// textset files: one record per line: u16 1, u16 0, u16 chars, f32 x, y (relative to the text box), size x, size y,
// char spacing (justification), u8 r g b + 5 bytes, then UTF-16BE text
function textLines(b) {
  const out = []; let o = 0;
  while (o + 34 <= b.length && b.readUInt16BE(o) === 1) {
    const n = b.readUInt16BE(o + 4); if (o + 34 + n * 2 > b.length) break;
    out.push({ x: b.readFloatBE(o + 6), y: b.readFloatBE(o + 10), sx: b.readFloatBE(o + 14), sy: b.readFloatBE(o + 18), sp: b.readFloatBE(o + 22), color: [b[o + 26], b[o + 27], b[o + 28]],
      s: Buffer.from(b.subarray(o + 34, o + 34 + n * 2)).swap16().toString('utf16le') });
    o += 34 + n * 2;
  }
  return out;
}
const u16be = b => Buffer.from(b.length % 2 ? b.subarray(0, b.length - 1) : b).swap16().toString('utf16le').replace(/\0+$/, '');

// ---------- layout → ops ----------
const ORIGIN = [0.5, 0, 1]; // centre, left/top, right/bottom
function colorsOf(p) { return p.colors && p.colors.every(c => c.join() === p.colors[0].join()) ? p.colors[0] : p.colors || [255, 255, 255, 255]; }

function flatten(L, ctx, layer) {
  const ops = [];
  const tex = i => L.materials[i];
  function walk(p, px, py, sx, sy, alpha, depth) {
    if (!p.visible) return;
    // position relative to the parent's position point; y up in the layout, y down here
    const wx = px + p.x * sx, wy = py - p.y * sy, ssx = sx * (p.sx || 1), ssy = sy * (p.sy || 1);
    const a = alpha * (p.alpha / 255);
    const w = p.w * ssx, h = p.h * ssy;
    const x = wx - w * ORIGIN[p.origin & 3], y = wy - h * ORIGIN[(p.origin >> 2) & 3];
    const rect = { x, y, w, h };
    if (depth > 0) {
      if (p.type === 'pic') pic(p, rect, a);
      else if (p.type === 'wnd') wnd(p, rect, a);
      else if (p.type === 'txt') ctx.boxes.set(p.name, { x: wx, y: wy, w, h, layer });
    }
    for (const c of p.children) walk(c, wx, wy, ssx, ssy, a, depth + 1);
  }
  function texRef(m, k = 0) {
    const t = m && m.tex[k]; if (!t) return null;
    const name = L.textures[t.index]; if (!name) return null;
    return { key: ctx.useTexture(name), ws: t.wrapS, wt: t.wrapT, name };
  }
  function tintOf(m) { return m && (m.black.some(v => v) || m.white.some(v => v !== 255)) ? [m.black, m.white] : null; }
  function pic(p, r, a) {
    const m = tex(p.mat); let t = texRef(m);
    const jpg = (p.user || []).find(u => u.name === 'JpegFileName' && typeof u.value === 'string');
    if (jpg) { const k = ctx.useJpeg(jpg.value); t = k ? { key: k, ws: 0, wt: 0 } : null; if (!t) return; }
    const uv = p.uv[0] || [[0, 0], [1, 0], [0, 1], [1, 1]];
    if (!t || !t.key) { if (!m || !m.tex.length) ops.push({ k: 'rect', ...r, c: colorsOf(p), a, tint: tintOf(m) }); return; }
    ops.push({ k: 'img', img: t.key, ...r, u0: uv[0][0], v0: uv[0][1], u1: uv[3][0], v1: uv[3][1], ws: t.ws, wt: t.wt, tint: jpg ? null : tintOf(m), c: colorsOf(p), a, photo: !!jpg });
  }
  function wnd(p, r, a) {
    const frames = p.frames.map(f => { const m = tex(f.mat), t = texRef(m); return t && t.key ? { ...t, flip: f.flip, tint: tintOf(m), size: ctx.sizeOf(t.key) } : null; });
    const one = frames.length === 1 && frames[0];
    // frame sizes come from the frame textures: LT, RT, LB, RB
    const F = one ? [one, { ...one, flip: 1 }, { ...one, flip: 2 }, { ...one, flip: 4 }] : frames.length === 4 ? frames : [];
    const sz = i => F[i] && F[i].size ? F[i].size : [0, 0];
    const l = F.length ? sz(0)[0] : 0, t = F.length ? sz(0)[1] : 0, rr = F.length ? sz(1)[0] : 0, b = F.length ? sz(3)[1] : 0;
    const inf = p.inflate || [0, 0, 0, 0];
    const cm = tex(p.mat), cx = r.x + l - inf[0], cy = r.y + t - inf[2], cw = r.w - l - rr + inf[0] + inf[1], ch = r.h - t - b + inf[2] + inf[3];
    if (cw > 0 && ch > 0) {
      const ct = texRef(cm);
      if (ct && ct.key && !/^DummyTexture/i.test(ct.name || '')) ops.push({ k: 'img', img: ct.key, x: cx, y: cy, w: cw, h: ch, u0: 0, v0: 0, u1: 1, v1: 1, ws: ct.ws, wt: ct.wt, tint: tintOf(cm), c: colorsOf(p), a });
      else ops.push({ k: 'rect', x: cx, y: cy, w: cw, h: ch, c: colorsOf(p), a, tint: tintOf(cm) });
    }
    if (!F.length || F.some(f => !f)) return;
    // each frame covers its corner and the edge after it (clamped texture coordinates stretch the edge texels)
    const piece = (f, x, y, w, h, ax, ay) => {
      if (w <= 0 || h <= 0) return;
      const [tw, th] = f.size; let u0 = 0, u1 = w / tw, v0 = 0, v1 = h / th;
      if (ax) { u0 = 1 - w / tw; u1 = 1; } if (ay) { v0 = 1 - h / th; v1 = 1; }
      // texture flips: 1 horizontal, 2 vertical, 4 rotate 180
      if (f.flip === 1 || f.flip === 4) { u0 = 1 - u0; u1 = 1 - u1; }
      if (f.flip === 2 || f.flip === 4) { v0 = 1 - v0; v1 = 1 - v1; }
      ops.push({ k: 'img', img: f.key, x, y, w, h, u0, v0, u1, v1, ws: 0, wt: 0, tint: f.tint, c: [255, 255, 255, 255], a });
    };
    // anchors (which corner of the piece the texture's corner sits on) are in displayed-texture space; flips map back
    piece(F[0], r.x, r.y, r.w - rr, t, 0, 0);
    piece(F[1], r.x + r.w - rr, r.y, rr, r.h - b, 1, 0);
    piece(F[3], r.x + l, r.y + r.h - b, r.w - l, b, 1, 1);
    piece(F[2], r.x, r.y + t, l, r.h - t, 0, 1);
  }
  if (L.root) walk(L.root, 0, 0, 1, 1, 1, 0); // (a damaged layout without one: nothing from this layer, not the whole manual failed)
  return ops;
}

// ---------- the whole manual ----------
const PAGE_MIN = 640, PAGE_TARGET = 1000, PAGE_MAX = 1180;

// choose cut lines between content blocks: never through a picture, frame or line of text when avoidable
function splitPage(height, keep) {
  const iv = keep.filter(([a, b]) => b - a < PAGE_MAX * 0.8).map(([a, b]) => [Math.max(0, a - 6), Math.min(height, b + 6)]).sort((p, q) => p[0] - q[0]);
  const merged = []; for (const [a, b] of iv) { const m = merged[merged.length - 1]; if (m && a <= m[1]) m[1] = Math.max(m[1], b); else merged.push([a, b]); }
  const gaps = []; let prev = 0; for (const [a, b] of merged) { if (a > prev) gaps.push([prev, a]); prev = Math.max(prev, b); } if (prev < height) gaps.push([prev, height]);
  const cuts = []; let s = 0;
  while (height - s > PAGE_MAX) {
    let best = null, bestD = Infinity;
    for (const [a, b] of gaps) { const lo = Math.max(a, s + PAGE_MIN), hi = Math.min(b, s + PAGE_MAX); if (lo > hi) continue; const c = Math.min(hi, Math.max(lo, s + PAGE_TARGET)); const d = Math.abs(c - (s + PAGE_TARGET)); if (d < bestD) { bestD = d; best = c; } }
    const c = Math.round(best == null ? s + PAGE_TARGET : best); cuts.push(c); s = c;
  }
  const out = []; let a = 0; for (const c of cuts) { out.push([a, c]); a = c; } out.push([a, height]);
  // a tiny last piece joins the one before when that still fits
  if (out.length > 1 && out[out.length - 1][1] - out[out.length - 1][0] < 220 && out[out.length - 1][1] - out[out.length - 2][0] <= PAGE_MAX + 120) { const l = out.pop(); out[out.length - 1][1] = l[1]; }
  return out;
}

function build(buf, opts = {}) {
  const top = sarcList(buf); if (!top) throw new Error('not a Wii U manual');
  const files = new Map(top.map(e => [e.name, e.data]));
  const langs = [...new Set(top.map(e => (/^([A-Z]{3}_[a-z]{2})_middle\.arc$/.exec(e.name) || [])[1]).filter(Boolean))];
  const want = opts.lang && langs.includes(opts.lang) ? opts.lang : langs.find(l => /^USA_en$/.test(l)) || langs.find(l => /_en$/.test(l)) || langs[0];
  if (!want) throw new Error('no pages in this manual');
  const get = n => files.has(n) ? toMap(arc(files.get(n))) : new Map();
  const middle = get(`${want}_middle.arc`), textset = get(`${want}_textset.arc`), titles = get(`${want}_text_title.arc`), index = get(`${want}_index.arc`);
  const jpegs = [get(`${want}_jpeg.arc`), get('Common_jpeg.arc')];
  const textures = new Map(); for (const [n] of files) if (/texture\.arc$/i.test(n) && (n.startsWith('Common') || n.startsWith(want))) for (const [k, v] of get(n)) textures.set(k, v);

  const images = {}, sizes = {};
  const useTexture = name => {
    if (images[name]) return name;
    const b = textures.get(name); if (!b) return null;
    try { const t = gx2.readFlim(b); if (!t) return null; images[name] = 'data:image/png;base64,' + gx2.png(t.width, t.height, t.rgba).toString('base64'); sizes[name] = [t.width, t.height]; return name; } catch (e) { log('wiiu manual texture', name, e.message); return null; }
  };
  const useJpeg = name => {
    if (images[name]) return name;
    const alt = name.replace(/\.jpg$/i, '');
    for (const m of jpegs) { const b = m.get(name) || m.get(alt + '.jpg'); if (b) { images[name] = 'data:image/jpeg;base64,' + b.toString('base64'); sizes[name] = jpegSize(b); return name; } }
    return null;
  };

  // Index: titles and chapters
  let idx = null; for (const [, b] of index) { try { idx = bflyt.parse(b); } catch {} break; }
  const pageTitle = {}, chapters = [];
  if (idx && idx.root) for (const p of idx.root.children) {
    let m = /^PageTitle_(\d+)$/.exec(p.name); if (m) { pageTitle[+m[1]] = p.text || ''; continue; }
    m = /^Category_(\d+)$/.exec(p.name);
    if (m) { const valid = (p.user || []).find(u => u.name === 'IsValid'); const ids = (p.user || []).filter(u => /^PageID_/.test(u.name)).map(u => u.value && u.value[0]).filter(v => v != null); chapters.push({ name: p.text || '', valid: !valid || (valid.value && valid.value[0] !== 0), pages: ids }); }
  }

  const ids = [...new Set([...middle.keys()].map(n => (/^Page_(\d+)_middle_/.exec(n) || [])[1]).filter(Boolean))].sort();
  const pages = [];
  for (const id of ids) {
    const num = +id;
    const layerNames = [...middle.keys()].filter(n => n.startsWith(`Page_${id}_middle_`)).map(n => n.slice(`Page_${id}_middle_`.length).replace(/\.bflyt$/, ''));
    const order = ['bg', ...layerNames.filter(n => /^\d+$/.test(n)).sort((a, b) => a - b)];
    const ctx = { boxes: new Map(), useTexture, useJpeg, sizeOf: k => sizes[k] };
    let width = 688, height = 0; const ops = [], keep = [];
    for (const ln of order) {
      const b = middle.get(`Page_${id}_middle_${ln}.bflyt`); if (!b) continue;
      let L; try { L = bflyt.parse(b); } catch (e) { log('wiiu manual layout', id, ln, e.message); continue; }
      width = L.width || width; height = Math.max(height, L.height || 0);
      const o = flatten(L, ctx, ln);
      for (const op of o) { op.layer = ln === 'bg' ? 'bg' : 'c'; ops.push(op); if (ln !== 'bg') keep.push([op.y, op.y + op.h]); }
    }
    // text boxes the content layers don't have come from the info layer (absolute positions)
    const info = middle.get(`Page_${id}_middle_info.bflyt`);
    if (info) { try { const ictx = { boxes: new Map(), useTexture: () => null, useJpeg: () => null, sizeOf: () => null }; flatten(bflyt.parse(info), ictx, 'info'); for (const [k, v] of ictx.boxes) if (!ctx.boxes.has(k)) ctx.boxes.set(k, v); } catch {} }
    const text = [];
    for (const [n, b] of textset) {
      const m = new RegExp(`^Page_${id}_middle_textset_(.+)\\.bin$`).exec(n); if (!m) continue;
      const box = ctx.boxes.get(m[1]); if (!box) continue;
      const lines = textLines(b);
      lines.forEach((l, i) => {
        const y = box.y - l.y; text.push({ box: m[1], bx: box.x, bw: box.w, x: box.x + l.x, y, sx: l.sx, sy: l.sy, sp: l.sp, color: l.color, s: l.s, last: i === lines.length - 1 });
        keep.push([y, y + l.sy]);
      });
    }
    const tt = [0, 1, 2].map(k => titles.get(`Page_${id}_title_text_TextBox_0${k}.bin`)).filter(Boolean).map(u16be);
    const chapter = chapters.find(c => c.valid && c.pages.includes(num));
    pages.push({ id, num, width, height, title: pageTitle[num] || tt[0] || `Page ${num + 1}`, chapter: chapter ? chapter.name : '', ops, text, parts: splitPage(height, keep) });
  }
  // legal/health pages ("Important Information") have no chapter; keep them, but after the game pages
  const ordered = pages.filter(p => p.chapter).concat(pages.filter(p => !p.chapter));
  const toc = chapters.filter(c => c.valid && c.pages.length).map(c => ({ name: c.name, pages: c.pages.map(n => ordered.findIndex(p => p.num === n)).filter(i => i >= 0) }));
  const extra = ordered.map((p, i) => p.chapter ? -1 : i).filter(i => i >= 0); if (extra.length) toc.push({ name: '', pages: extra });
  return { title: opts.title || '', lang: want, width: 688, pages: ordered, toc, images, sizes };
}

function jpegSize(b) {
  for (let o = 2; o + 9 < b.length;) { if (b[o] !== 0xFF) break; const m = b[o + 1], len = b.readUInt16BE(o + 2); if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return [b.readUInt16BE(o + 7), b.readUInt16BE(o + 5)]; o += 2 + len; }
  return [0, 0];
}

// ---------- EPUB e-manuals (Super Mario Maker, Paper Mario Color Splash and other late games) ----------
// The .bfma then holds <lang>_Manual.epub: a zip of XHTML pages, CSS and pictures that the GamePad showed as web pages.
function epubOf(buf) {
  const top = sarcList(buf); if (!top) return null;
  const eps = top.filter(e => /^([A-Z]{3}_[a-z]{2})_Manual\.epub$/.test(e.name)); if (!eps.length) return null;
  const pick = eps.find(e => /^USA_en_/.test(e.name)) || eps.find(e => /_en_/.test(e.name)) || eps[0];
  return { lang: pick.name.slice(0, 6), data: pick.data };
}
// minimal zip reader: central directory, stored or deflated entries, nothing outside `out`
function unzip(buf, out) {
  let eocd = -1; for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('bad e-book (no zip directory)');
  const count = buf.readUInt16LE(eocd + 10); let o = buf.readUInt32LE(eocd + 16), n = 0, bytes = 0;
  const root = path.resolve(out);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(o) !== 0x02014b50) break;
    const method = buf.readUInt16LE(o + 10), csize = buf.readUInt32LE(o + 20), nlen = buf.readUInt16LE(o + 28), xlen = buf.readUInt16LE(o + 30), clen = buf.readUInt16LE(o + 32), loc = buf.readUInt32LE(o + 42);
    const name = buf.toString('utf8', o + 46, o + 46 + nlen); o += 46 + nlen + xlen + clen;
    const dest = path.resolve(root, name); if (!dest.startsWith(root + path.sep) || name.endsWith('/')) continue;
    const start = loc + 30 + buf.readUInt16LE(loc + 26) + buf.readUInt16LE(loc + 28), raw = buf.subarray(start, start + csize);
    let data; try { data = method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY }) : null; }
    catch (e) { if (e && e.code === 'ERR_BUFFER_TOO_LARGE') throw new Error(`e-book file ${name} unpacks past ${MAX_ENTRY >> 20} MB`); throw e; }
    if (!data) continue;
    if ((bytes += data.length) > MAX_EPUB) throw new Error(`e-book unpacks past ${MAX_EPUB >> 20} MB`);
    fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, data); n++;
  }
  return n;
}
// reading order from the package file (skips the nav page)
function epubSpine(root) {
  const c = fs.readFileSync(path.join(root, 'META-INF', 'container.xml'), 'utf8'), m = /full-path="([^"]+)"/.exec(c); if (!m) return [];
  const opfPath = path.join(root, m[1]), opf = fs.readFileSync(opfPath, 'utf8'), items = {};
  for (const t of opf.matchAll(/<item\s[^>]*>/g)) { const id = /\bid="([^"]+)"/.exec(t[0]), h = /\bhref="([^"]+)"/.exec(t[0]); if (id && h && !/properties="[^"]*nav/.test(t[0])) items[id[1]] = decodeURIComponent(h[1]); }
  const base = path.dirname(opfPath);
  return [...opf.matchAll(/<itemref\s[^>]*idref="([^"]+)"[^>]*>/g)].filter(t => !/linear="no"/.test(t[0])).map(t => items[t[1]]).filter(Boolean).map(h => path.resolve(base, h)).filter(f => f.startsWith(path.resolve(root) + path.sep) && fs.existsSync(f));
}

function readBfma(g) { return /\.wua$/i.test(g.file) ? fromWua(g.file) : /\.rpx$/i.test(g.file) ? fromFolder(g.file) : null; }
const safe = s => s.replace(/[<>:"/\\|?*]+/g, '_');

// For each Wii U game without manual pages: read its e-manual, draw the pages, save them for the reader.
// opts: { artDirFor(g) -> folder, baseFor(g) -> file stem, render(model) -> [Buffer jpeg] }
async function collect(games, opts = {}) {
  if (!dir) return;
  const ls = require('./dircache').lister(); // each art folder listed once for the pass, not once per game
  for (const g of games) {
    try {
      const artDir = opts.artDirFor && opts.artDirFor(g), base = opts.baseFor && opts.baseFor(g);
      if (!artDir || !base) continue;
      const pre = (base + '-manual-').toLowerCase();
      const cache = path.join(dir, safe(g.title) + '.bfma'), failed = cache + '.failed', mark = path.join(dir, safe(g.title) + '.made');
      // already has one (or the user picked one). A .bfma kept from before is only a copy of the game's own manual (up to
      // 27 MB): a tiny marker remembers that the pages were made here, and the copy goes
      if (ls.names(artDir).some(f => { const l = f.toLowerCase(); return l.startsWith(pre) && /\.(jpe?g|png|webp)$/.test(l); })) { if (fs.existsSync(cache)) { try { fs.writeFileSync(mark, VERSION); fs.unlinkSync(cache); } catch {} } continue; }
      // a manual that couldn't be converted isn't retried on every launch (only after a Boxshelf update)
      try { if (fs.readFileSync(failed, 'utf8') === VERSION) { try { fs.unlinkSync(cache); } catch {} continue; } } catch {} // not retried: the copy isn't needed (it's read from the game again after an update)
      let buf = null; try { buf = fs.readFileSync(cache); } catch {}
      if (!buf) { buf = readBfma(g); if (!buf) { if (/\.(wua|rpx)$/i.test(g.file)) { try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(failed, VERSION); } catch {} } continue; } /* no e-manual in this game: don't re-read the .wua every launch */ try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(cache + '.part', buf); fs.renameSync(cache + '.part', cache); } catch {} }
      const t0 = Date.now();
      const ep = epubOf(buf); let model = null, imgs, tmp = null;
      if (ep) {
        if (!opts.renderEpub) continue;
        tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'boxshelf-emanual-'));
        try { unzip(ep.data, tmp); const pages = epubSpine(tmp); if (!pages.length) throw new Error('no pages in this e-book');
          model = { lang: ep.lang, pages }; imgs = await opts.renderEpub(tmp, pages); }
        finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }
      } else {
        if (!opts.render) continue; // (checked first: no renderer, no point building the page model)
        model = build(buf, { title: g.title });
        imgs = await opts.render(model);
      }
      if (imgs === null) { // timed out / renderer crashed: not necessarily the manual's fault — retry next time, but give up after 2 tries
        let n = 0; try { n = +(fs.readFileSync(cache + '.tries', 'utf8')) || 0; } catch {}
        try { if (n + 1 >= 2) { fs.writeFileSync(failed, VERSION); fs.unlinkSync(cache + '.tries'); try { fs.unlinkSync(cache); } catch {} } else fs.writeFileSync(cache + '.tries', String(n + 1)); } catch {}
        log('wiiu manual', g.title, 'render interrupted (try', n + 1, 'of 2)'); continue;
      }
      if (!imgs.length) { try { fs.writeFileSync(failed, VERSION); } catch {} log('wiiu manual', g.title, 'no pages drawn'); continue; }
      fs.mkdirSync(artDir, { recursive: true });
      try { fs.unlinkSync(failed); } catch {} try { fs.unlinkSync(cache + '.tries'); } catch {}
      // pages go in under hidden temp names and are renamed only once all of them are written: a write failing half-way
      // (disk full) used to leave the first few pages, which then counted as this game's whole manual for good
      ls.forget(artDir); const tmps = imgs.map((b, i) => path.join(artDir, `.${base}-wum-${process.pid}-${i}.tmp`)), placed = [];
      try { imgs.forEach((b, i) => fs.writeFileSync(tmps[i], b)); tmps.forEach((t, i) => { const d = path.join(artDir, `${base}-manual-${String(i + 1).padStart(2, '0')}.jpg`); fs.renameSync(t, d); placed.push(d); }); }
      catch (e) { for (const f of [...tmps, ...placed]) { try { fs.unlinkSync(f); } catch {} } throw e; }
      try { fs.writeFileSync(mark, VERSION); fs.unlinkSync(cache); } catch {} // the pages are saved: no need to keep the manual's copy
      log('wiiu manual', g.title, model.lang, model.pages.length, ep ? 'e-book pages ->' : 'layouts ->', imgs.length, 'pages in', Date.now() - t0, 'ms');
      if (opts.onDone) opts.onDone(g, imgs.length);
    } catch (e) { log('wiiu manual', g.title, e.message); try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, safe(g.title) + '.bfma.failed'), VERSION); } catch {} }
    await new Promise(r => setImmediate(r));
  }
}

/* true when this game's manual pages were made here from its e-manual (they open on the contents page: no cover) */
function generated(title) { if (!dir) return false; if (fs.existsSync(path.join(dir, safe(title) + '.made'))) return true; const c = path.join(dir, safe(title) + '.bfma'); try { if (!fs.statSync(c).isFile()) return false; } catch { return false; } try { return fs.readFileSync(c + '.failed', 'utf8') !== VERSION; } catch { return true; } } /* a marker left by an older version that couldn't convert it doesn't count */

module.exports = { init, collect, generated, build, sarcList, fromWua, splitPage, textLines, epubOf, unzip, epubSpine };
