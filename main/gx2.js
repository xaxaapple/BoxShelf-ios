// Wii U textures (BFLIM, as used by e-manual layouts): undo the GX2 GPU tiling and decode the pixel format to RGBA.
// Tiling follows AMD's AddrLib for the R7xx-class GPU in the Wii U (2 pipes, 4 banks, 256-byte pipe interleave);
// only the modes these files use: 1 linear-aligned, 2 1D-tiled-thin1, 4 2D-tiled-thin1.
const zlib = require('zlib');

const PIPES = 2, BANKS = 4, GROUP_BITS = 8, PIPE_BITS = 1, BANK_BITS = 2;

// BFLIM format code → [name, bits per element, block size]
const FORMATS = {
  0: ['L8', 8, 1], 1: ['A8', 8, 1], 2: ['LA4', 8, 1], 3: ['LA8', 16, 1], 4: ['HILO8', 16, 1], 5: ['RGB565', 16, 1], 6: ['RGBX8', 32, 1],
  7: ['RGB5A1', 16, 1], 8: ['RGBA4', 16, 1], 9: ['RGBA8', 32, 1], 12: ['BC1', 64, 4], 13: ['BC2', 128, 4], 14: ['BC3', 128, 4],
  15: ['BC4L', 64, 4], 16: ['BC4A', 64, 4], 17: ['BC5', 128, 4], 20: ['RGBA8', 32, 1], 21: ['BC1', 64, 4], 22: ['BC2', 128, 4], 23: ['BC3', 128, 4]
};

function pixelIndex(x, y, bpp) {
  let b0, b1, b2, b3, b4, b5;
  if (bpp === 8) { b0 = x & 1; b1 = (x & 2) >> 1; b2 = (x & 4) >> 2; b3 = (y & 2) >> 1; b4 = y & 1; b5 = (y & 4) >> 2; }
  else if (bpp === 16) { b0 = x & 1; b1 = (x & 2) >> 1; b2 = (x & 4) >> 2; b3 = y & 1; b4 = (y & 2) >> 1; b5 = (y & 4) >> 2; }
  else if (bpp === 64) { b0 = x & 1; b1 = y & 1; b2 = (x & 2) >> 1; b3 = (x & 4) >> 2; b4 = (y & 2) >> 1; b5 = (y & 4) >> 2; }
  else if (bpp === 128) { b0 = y & 1; b1 = x & 1; b2 = (x & 2) >> 1; b3 = (x & 4) >> 2; b4 = (y & 2) >> 1; b5 = (y & 4) >> 2; }
  else { b0 = x & 1; b1 = (x & 2) >> 1; b2 = y & 1; b3 = (x & 4) >> 2; b4 = (y & 2) >> 1; b5 = (y & 4) >> 2; } // 32
  return 32 * b5 + 16 * b4 + 8 * b3 + 4 * b2 + 2 * b1 + b0;
}

function addrMicro(x, y, bpp, pitch) {
  const microTileBytes = (64 * bpp) >> 3;
  return ((bpp * pixelIndex(x, y, bpp)) >> 3) + microTileBytes * ((x >> 3) + (y >> 3) * (pitch >> 3));
}

function addrMacro(x, y, bpp, pitch, pipeSwizzle, bankSwizzle) {
  const elemOffset = (bpp * pixelIndex(x, y, bpp)) >> 3;
  let pipe = ((y >> 3) ^ (x >> 3)) & 1;
  let bank = (((y / (16 * PIPES)) | 0) ^ (x >> 3)) & 1 | 2 * ((((y / (8 * PIPES)) | 0) ^ (x >> 4)) & 1);
  let bankPipe = pipe + PIPES * bank;
  const swizzle = pipeSwizzle + PIPES * bankSwizzle;
  bankPipe ^= swizzle; // slice 0, single sample: rotation term is 0
  bankPipe %= PIPES * BANKS; pipe = bankPipe % PIPES; bank = (bankPipe / PIPES) | 0;
  const mtW = 8 * BANKS, mtH = 8 * PIPES, macroTileBytes = (bpp * mtH * mtW + 7) >> 3;
  const macroTileOffset = ((x / mtW | 0) + (pitch / mtW | 0) * (y / mtH | 0)) * macroTileBytes;
  const total = elemOffset + (macroTileOffset >> (BANK_BITS + PIPE_BITS)), groupMask = (1 << GROUP_BITS) - 1;
  const high = (total & ~groupMask) * (1 << (BANK_BITS + PIPE_BITS)), low = total & groupMask;
  return bank * (1 << (PIPE_BITS + GROUP_BITS)) + pipe * (1 << GROUP_BITS) + low + high;
}

// textures come from game files we don't control: e-manual textures are at most 1024-2048 px, so anything past 4096
// is a damaged or hostile header (65535² RGBA would be 16 GB of buffers and minutes of untiling)
const MAX_SIDE = 4096;
const align = (v, a) => Math.ceil(v / a) * a;

// tiled → linear element buffer (elements are pixels, or 4×4 blocks for BCn)
function untile(data, wE, hE, bpp, tileMode, swizzle) {
  if (!(wE > 0 && hE > 0 && wE <= MAX_SIDE && hE <= MAX_SIDE)) throw new Error(`texture size ${wE}×${hE} is out of range`);
  const bytes = bpp >> 3, out = Buffer.alloc(wE * hE * bytes);
  const pipeSwizzle = (swizzle >> 8) & 1, bankSwizzle = (swizzle >> 9) & 3;
  let pitch;
  if (tileMode === 4) pitch = align(wE, Math.max(32, 32 * ((256 / bpp / 8) | 0)));
  else if (tileMode === 2) pitch = align(wE, Math.max(8, (256 / bpp) | 0));
  else pitch = align(wE, Math.max(64, (2048 / bpp) | 0)); // linear aligned
  for (let y = 0; y < hE; y++) for (let x = 0; x < wE; x++) {
    const a = tileMode === 4 ? addrMacro(x, y, bpp, pitch, pipeSwizzle, bankSwizzle) : tileMode === 2 ? addrMicro(x, y, bpp, pitch) : (y * pitch + x) * bytes;
    if (a + bytes <= data.length) data.copy(out, (y * wE + x) * bytes, a, a + bytes);
  }
  return out;
}

// ---- pixel decoders → RGBA8 ----
function rgb565(v) { return [((v >> 11) & 31) * 255 / 31 | 0, ((v >> 5) & 63) * 255 / 63 | 0, (v & 31) * 255 / 31 | 0]; }
function bc1Block(src, o, out, w, bx, by, alphaOK) {
  const c0 = src.readUInt16LE(o), c1 = src.readUInt16LE(o + 2), bits = src.readUInt32LE(o + 4);
  const a = rgb565(c0), b = rgb565(c1), pal = [a.concat(255), b.concat(255)];
  if (c0 > c1 || !alphaOK) { pal.push(a.map((v, i) => (2 * v + b[i]) / 3 | 0).concat(255), a.map((v, i) => (v + 2 * b[i]) / 3 | 0).concat(255)); }
  else { pal.push(a.map((v, i) => (v + b[i]) / 2 | 0).concat(255), [0, 0, 0, 0]); }
  for (let i = 0; i < 16; i++) { const p = pal[(bits >>> (2 * i)) & 3], x = bx + (i & 3), y = by + (i >> 2); const d = (y * w + x) * 4; out[d] = p[0]; out[d + 1] = p[1]; out[d + 2] = p[2]; out[d + 3] = p[3]; }
}
function bc4Block(src, o) {
  const a0 = src[o], a1 = src[o + 1], pal = [a0, a1];
  if (a0 > a1) for (let i = 1; i < 7; i++) pal.push(((7 - i) * a0 + i * a1) / 7 | 0);
  else { for (let i = 1; i < 5; i++) pal.push(((5 - i) * a0 + i * a1) / 5 | 0); pal.push(0, 255); }
  const lo = src.readUInt32LE(o + 2), hi = src.readUInt16LE(o + 6), vals = new Array(16);
  for (let i = 0; i < 16; i++) { const bit = 3 * i; const idx = bit < 30 ? (lo >>> bit) & 7 : bit === 30 ? ((lo >>> 30) | ((hi & 1) << 2)) : (hi >>> (bit - 32)) & 7; vals[i] = pal[idx]; }
  return vals;
}

function decode(fmt, lin, w, h) {
  if (!(w > 0 && h > 0 && w <= MAX_SIDE && h <= MAX_SIDE)) throw new Error(`texture size ${w}×${h} is out of range`);
  const [name, , blk] = FORMATS[fmt] || [];
  const out = Buffer.alloc(w * h * 4);
  if (blk === 4) {
    const bw = Math.ceil(w / 4), bh = Math.ceil(h / 4), W = bw * 4, tmp = Buffer.alloc(W * bh * 4 * 4), es = name === 'BC1' || name === 'BC4L' || name === 'BC4A' ? 8 : 16;
    for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
      const o = (by * bw + bx) * es;
      const put = (i, r, g, b, a) => { const d = ((by * 4 + (i >> 2)) * W + bx * 4 + (i & 3)) * 4; tmp[d] = r; tmp[d + 1] = g; tmp[d + 2] = b; tmp[d + 3] = a; };
      if (name === 'BC1') bc1Block(lin, o, tmp, W, bx * 4, by * 4, true);
      else if (name === 'BC2') { bc1Block(lin, o + 8, tmp, W, bx * 4, by * 4, false); for (let i = 0; i < 16; i++) { const d = ((by * 4 + (i >> 2)) * W + bx * 4 + (i & 3)) * 4; tmp[d + 3] = ((lin[o + (i >> 1)] >> ((i & 1) * 4)) & 15) * 17; } }
      else if (name === 'BC3') { bc1Block(lin, o + 8, tmp, W, bx * 4, by * 4, false); const al = bc4Block(lin, o); for (let i = 0; i < 16; i++) tmp[((by * 4 + (i >> 2)) * W + bx * 4 + (i & 3)) * 4 + 3] = al[i]; }
      else if (name === 'BC4L') { const v = bc4Block(lin, o); for (let i = 0; i < 16; i++) put(i, v[i], v[i], v[i], 255); }
      else if (name === 'BC4A') { const v = bc4Block(lin, o); for (let i = 0; i < 16; i++) put(i, 255, 255, 255, v[i]); }
      else if (name === 'BC5') { const l = bc4Block(lin, o), a = bc4Block(lin, o + 8); for (let i = 0; i < 16; i++) put(i, l[i], l[i], l[i], a[i]); } // layouts use BC5 as luminance + alpha
    }
    for (let y = 0; y < h; y++) tmp.copy(out, y * w * 4, y * W * 4, y * W * 4 + w * 4);
    return out;
  }
  for (let i = 0; i < w * h; i++) {
    const d = i * 4; let r = 0, g = 0, b = 0, a = 255;
    switch (name) {
      case 'RGBA8': case 'RGBX8': r = lin[d]; g = lin[d + 1]; b = lin[d + 2]; a = name === 'RGBA8' ? lin[d + 3] : 255; break;
      case 'L8': r = g = b = lin[i]; break;
      case 'A8': r = g = b = 255; a = lin[i]; break;
      case 'LA4': r = g = b = (lin[i] >> 4) * 17; a = (lin[i] & 15) * 17; break;
      case 'LA8': case 'HILO8': r = g = b = lin[i * 2]; a = lin[i * 2 + 1]; break;
      case 'RGB565': [r, g, b] = rgb565(lin.readUInt16LE(i * 2)); break;
      case 'RGB5A1': { const v = lin.readUInt16LE(i * 2); r = (v & 31) * 255 / 31 | 0; g = ((v >> 5) & 31) * 255 / 31 | 0; b = ((v >> 10) & 31) * 255 / 31 | 0; a = v >> 15 ? 255 : 0; break; }
      case 'RGBA4': { const v = lin.readUInt16LE(i * 2); r = (v & 15) * 17; g = ((v >> 4) & 15) * 17; b = ((v >> 8) & 15) * 17; a = (v >> 12) * 17; break; }
      default: break;
    }
    out[d] = r; out[d + 1] = g; out[d + 2] = b; out[d + 3] = a;
  }
  return out;
}

// BFLIM → { width, height, rgba } (or null when the format isn't one we know)
function readFlim(buf) {
  const n = buf.length; if (n < 0x28 || buf.toString('latin1', n - 0x28, n - 0x24) !== 'FLIM') return null;
  const im = n - 0x14; if (buf.toString('latin1', im, im + 4) !== 'imag') return null;
  const width = buf.readUInt16BE(im + 8), height = buf.readUInt16BE(im + 10), fmt = buf[im + 14], flags = buf[im + 15], size = buf.readUInt32BE(im + 16);
  const f = FORMATS[fmt]; if (!f) return null;
  if (!width || !height || width > MAX_SIDE || height > MAX_SIDE) throw new Error(`texture is ${width}×${height}: bigger than ${MAX_SIDE}×${MAX_SIDE}, not reading it`);
  const [, bpp, blk] = f, tileMode = flags & 0x1F, swizzle = ((flags >> 5) & 7) << 8;
  const wE = Math.ceil(width / blk), hE = Math.ceil(height / blk);
  const lin = untile(buf.subarray(0, size), wE, hE, bpp, tileMode, swizzle);
  return { width, height, rgba: decode(fmt, lin, width, height), format: f[0] };
}

// minimal PNG encoder (RGBA8)
const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(b) { let c = -1; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'latin1'), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, c]); }
function png(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) { raw[y * (width * 4 + 1)] = 0; rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

module.exports = { readFlim, png, untile, decode, FORMATS };
