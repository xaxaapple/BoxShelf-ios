// BFLYT (Wii U / Cafe layout, big-endian): the pane tree with the bits needed to draw a page — pictures, windows
// (frames + content), text boxes (position only; e-manual text comes pre-laid-out in a separate file), user data.
// Layout space: y points up, a pane's translation is relative to its parent's position, its rect hangs off its origin.

function cstr(b, o, max) { let e = o; const end = Math.min(b.length, o + (max || 1e9)); while (e < end && b[e]) e++; return b.toString('latin1', o, e); }
const rgba = (b, o) => [b[o], b[o + 1], b[o + 2], b[o + 3]];

function strTable(b, o) { const n = b.readUInt16BE(o + 8), base = o + 12, out = []; for (let i = 0; i < n; i++) out.push(cstr(b, base + b.readUInt32BE(base + i * 4))); return out; }

function materials(b, o) {
  const n = b.readUInt16BE(o + 8), out = [];
  for (let i = 0; i < n; i++) {
    let m = o + b.readUInt32BE(o + 12 + i * 4);
    const mat = { name: cstr(b, m, 28), black: rgba(b, m + 28), white: rgba(b, m + 32), tex: [] };
    const flags = b.readUInt32BE(m + 36); m += 40;
    const texCount = flags & 3, srtCount = (flags >> 2) & 3;
    for (let k = 0; k < texCount; k++, m += 4) mat.tex.push({ index: b.readUInt16BE(m), wrapS: b[m + 2] & 3, wrapT: b[m + 3] & 3 });
    if (srtCount) mat.srt = { tx: b.readFloatBE(m), ty: b.readFloatBE(m + 4), rot: b.readFloatBE(m + 8), sx: b.readFloatBE(m + 12), sy: b.readFloatBE(m + 16) };
    out.push(mat);
  }
  return out;
}

function uvSets(b, o, count) { const out = []; for (let k = 0; k < count; k++, o += 32) { const f = i => b.readFloatBE(o + i * 4); out.push([[f(0), f(1)], [f(2), f(3)], [f(4), f(5)], [f(6), f(7)]]); } return out; }

function pane(b, o, type) {
  const f = i => b.readFloatBE(o + 0x2C + i * 4);
  const p = { type, name: cstr(b, o + 12, 24), visible: !!(b[o + 8] & 1), origin: b[o + 9], alpha: b[o + 10], x: f(0), y: f(1), rot: f(5), sx: f(6), sy: f(7), w: f(8), h: f(9), children: [] };
  const d = o + 0x54;
  if (type === 'pic') {
    p.colors = [rgba(b, d), rgba(b, d + 4), rgba(b, d + 8), rgba(b, d + 12)];
    p.mat = b.readUInt16BE(d + 16); p.uv = uvSets(b, d + 20, b[d + 18]);
  } else if (type === 'wnd') {
    p.inflate = [b.readFloatBE(d), b.readFloatBE(d + 4), b.readFloatBE(d + 8), b.readFloatBE(d + 12)]; // l r t b
    const frames = b[d + 16], c = o + b.readUInt32BE(d + 20), ft = o + b.readUInt32BE(d + 24);
    p.colors = [rgba(b, c), rgba(b, c + 4), rgba(b, c + 8), rgba(b, c + 12)];
    p.mat = b.readUInt16BE(c + 16); p.uv = uvSets(b, c + 20, b[c + 18]);
    p.frames = []; for (let k = 0; k < frames; k++) { const fo = o + b.readUInt32BE(ft + k * 4); p.frames.push({ mat: b.readUInt16BE(fo), flip: b[fo + 2] }); }
  } else if (type === 'txt') {
    p.textMat = b.readUInt16BE(d + 4);
    const strBytes = b.readUInt16BE(d + 2), to = b.readUInt32BE(d + 16);
    if (strBytes > 2 && o + to + strBytes <= b.length) p.text = Buffer.from(b.subarray(o + to, o + to + strBytes - 2)).swap16().toString('utf16le').replace(/\0+$/, '');
  }
  return p;
}

// user data: [{name, value}] — e-manual pictures name their JPEG here (JpegFileName)
function userData(b, o) {
  const n = b.readUInt16BE(o + 8), out = [];
  for (let i = 0; i < n; i++) {
    const e = o + 12 + i * 12, name = cstr(b, e + b.readUInt32BE(e)), dataOff = b.readUInt32BE(e + 4), len = b.readUInt16BE(e + 8), type = b[e + 10];
    let value = null;
    if (type === 0) value = cstr(b, e + dataOff, len);
    else if (type === 1) { value = []; for (let k = 0; k < len; k++) value.push(b.readInt32BE(e + dataOff + k * 4)); }
    else if (type === 2) { value = []; for (let k = 0; k < len; k++) value.push(b.readFloatBE(e + dataOff + k * 4)); }
    out.push({ name, value });
  }
  return out;
}

function parse(b) {
  if (b.toString('latin1', 0, 4) !== 'FLYT') throw new Error('not a layout');
  const L = { width: 0, height: 0, textures: [], fonts: [], materials: [], root: null };
  let o = b.readUInt16BE(6); const count = b.readUInt16BE(16);
  const stack = []; let last = null, parent = null;
  for (let i = 0; i < count && o + 8 <= b.length; i++) {
    const magic = b.toString('latin1', o, o + 4), size = b.readUInt32BE(o + 4);
    switch (magic) {
      case 'lyt1': L.width = b.readFloatBE(o + 12); L.height = b.readFloatBE(o + 16); break;
      case 'txl1': L.textures = strTable(b, o); break;
      case 'fnl1': L.fonts = strTable(b, o); break;
      case 'mat1': L.materials = materials(b, o); break;
      case 'pan1': case 'pic1': case 'wnd1': case 'txt1': case 'bnd1': case 'prt1': {
        const p = pane(b, o, magic.slice(0, 3));
        if (parent) parent.children.push(p); else if (!L.root) L.root = p;
        last = p; break;
      }
      case 'pas1': stack.push(parent); parent = last; break;
      case 'pae1': parent = stack.pop() || null; break;
      case 'usd1': if (last) last.user = userData(b, o); break;
      default: break;
    }
    o += size;
  }
  return L;
}

module.exports = { parse };
