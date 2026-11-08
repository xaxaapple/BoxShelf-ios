// Manual scans uploaded as two-page spreads (the outside of the booklet = back cover | front cover, inside = left | right)
// are cut into single pages: the front cover comes first, the back cover moves to the end, inside spreads become two pages.
// Image sizes come from the file headers, so checking a manual that's already fine costs a few tiny reads.
const fs = require('fs');
const path = require('path');

const SPREAD = 1.25, SPREAD_MAX = 1.62; /* a booklet page is ~0.7 wide:tall, a spread ~1.4; 16:9 screens-as-pages (1.78) are left alone */
const SPREAD_MIN_W = 1100; /* (beta.9) narrower than this, a wide page is a screen capture, not a booklet scanned open */

// [width, height] from the header, or null. A small read first (4 KB, one buffer reused); only a JPEG whose frame
// header sits further in (big EXIF / ICC blocks before it) gets a second, 64 KB look
const HEAD = Buffer.alloc(4096);
function jpegSize(h) {
  for (let o = 2; o + 9 < h.length;) { if (h[o] !== 0xFF) { o++; continue; } const m = h[o + 1]; if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { o += 2; continue; } const len = h.readUInt16BE(o + 2); if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return [h.readUInt16BE(o + 7), h.readUInt16BE(o + 5)]; o += 2 + len; }
  return null;
}
function sizeOf(file) {
  let fd; try {
    fd = fs.openSync(file, 'r'); const n = fs.readSync(fd, HEAD, 0, HEAD.length, 0); let h = HEAD.subarray(0, n);
    if (n >= 24 && h[0] === 0x89 && h.toString('latin1', 1, 4) === 'PNG') return [h.readUInt32BE(16), h.readUInt32BE(20)];
    if (h[0] === 0xFF && h[1] === 0xD8) {
      const z = jpegSize(h); if (z || n < HEAD.length) return z;
      const b = Buffer.alloc(65536); h = b.subarray(0, fs.readSync(fd, b, 0, b.length, 0)); return jpegSize(h);
    }
  } catch {} finally { if (fd != null) try { fs.closeSync(fd); } catch {} }
  return null;
}
// (beta.10) the same, with fs.promises (the shelf's cover thumbnails and the art download's checks: art on a NAS)
async function sizeOfAsync(file) {
  let fh; try {
    fh = await fs.promises.open(file, 'r'); const b = Buffer.alloc(4096), n = (await fh.read(b, 0, b.length, 0)).bytesRead; let h = b.subarray(0, n);
    if (n >= 24 && h[0] === 0x89 && h.toString('latin1', 1, 4) === 'PNG') return [h.readUInt32BE(16), h.readUInt32BE(20)];
    if (h[0] === 0xFF && h[1] === 0xD8) {
      const z = jpegSize(h); if (z || n < b.length) return z;
      const b2 = Buffer.alloc(65536); h = b2.subarray(0, (await fh.read(b2, 0, b2.length, 0)).bytesRead); return jpegSize(h);
    }
  } catch {} finally { if (fh) await fh.close().catch(() => {}); }
  return null;
}
const isSpread = s => !!s && s[0] > s[1] * SPREAD && s[0] < s[1] * SPREAD_MAX;

// crop(file, 'left'|'right') -> JPEG Buffer (Electron's nativeImage in the app)
// opts.scan: pages known to be booklet scans (from a scan collection): any landscape page up to SPREAD_MAX is a
// spread, GameCube's squarish booklets (spread ~1.18) included, even when every page is one
async function splitManual(dir, base, crop, opts = {}) {
  const spread = opts.scan ? (z => !!z && z[0] > z[1] * 1.05 && z[0] < z[1] * SPREAD_MAX) : isSpread;
  const pre = (base + '-manual-').toLowerCase();
  const ls = opts.ls || require('./dircache').fresh; // opts.ls: a run's shared folder listings (one listing per folder, not per game)
  const files = ls.names(dir).filter(f => f.toLowerCase().startsWith(pre) && /-manual-\d+\.(jpe?g|png)$/i.test(f)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!files.length) return 0;
  const sizes = files.map(f => sizeOf(path.join(dir, f)));
  if (!sizes.some(spread)) return 0;
  // a booklet that is landscape on every page (a digital manual laid out sideways) is left as it is
  if (!opts.scan && !sizes.some(z => z && z[1] >= z[0]) && sizes.every(z => z && Math.abs(z[0] / z[1] - sizes[0][0] / sizes[0][1]) < .02) && files.length > 2) return 0;
  // (beta.9) a manual from anywhere but a scan collection is cut only when it really is a booklet scanned open: wide pages
  // big enough to be a scan (a 320x240 or 640x480 screen from a digital manual isn't), and most of its pages that way. A
  // single wide page among upright ones (a box wrap or a poster in a "cover and manual" upload) stays whole.
  if (opts.minW && sizes.filter(spread).some(z => z[0] < opts.minW)) return 0; // (beta.9: Repair: never screens of a digital manual)
  if (!opts.scan) {
    const wide = sizes.filter(spread);
    if (wide.some(z => z[0] < SPREAD_MIN_W)) return 0;
    if (wide.length * 2 < sizes.filter(Boolean).length) return 0;
  }
  const front = [], back = []; let cut = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i], full = path.join(dir, f), ext = path.extname(f).toLowerCase() === '.png' ? '.png' : '.jpg';
    if (!spread(sizes[i])) { front.push({ file: full, ext }); continue; }
    const L = { buf: await crop(full, 'left'), ext: '.jpg' }, R = { buf: await crop(full, 'right'), ext: '.jpg' };
    if (!L.buf || !R.buf) { front.push({ file: full, ext }); continue; }
    cut++;
    if (i === 0) { front.push(R); back.push(L); } /* outside: front cover first, back cover last */
    else front.push(L, R);
  }
  if (!cut) return 0;
  const pages = [...front, ...back];
  // New pages go under temporary names first; the originals then move to covers\.manual-originals\<game>\<time>\ (a
  // re-split never overwrites an older backup; put them back to undo), or to a holding folder dropped at the end when
  // opts.discard. Any failure puts the manual back exactly as it was: an original is never deleted.
  const tmp = [], moved = [], placed = [];
  ls.forget(dir); // the folder changes from here on (also when it fails half-way)
  const hold = opts.discard ? path.join(dir, `.${base}-split-old`) : backupDir(dir, base);
  try {
    for (let i = 0; i < pages.length; i++) { const p = pages[i], t = path.join(dir, `.${base}-split-${i}${p.ext}`); tmp.push(t); await fs.promises.writeFile(t, p.buf || await fs.promises.readFile(p.file)); await new Promise(r => setImmediate(r)); } // one at a time, letting the app breathe
    if (opts.discard) fs.mkdirSync(hold, { recursive: true });
    for (const f of files) { fs.renameSync(path.join(dir, f), path.join(hold, f)); moved.push(f); } // rename only: a copy+delete could half-succeed
    tmp.forEach((t, i) => { const d = path.join(dir, `${base}-manual-${String(i + 1).padStart(2, '0')}${pages[i].ext}`); fs.renameSync(t, d); placed.push(d); });
  } catch (e) {
    for (const d of placed) { try { fs.unlinkSync(d); } catch {} }
    for (const f of moved) { try { fs.renameSync(path.join(hold, f), path.join(dir, f)); } catch {} }
    for (const t of tmp) { try { fs.unlinkSync(t); } catch {} }
    try { fs.rmdirSync(hold); if (!opts.discard) fs.rmdirSync(path.dirname(hold)); } catch {} // only when empty: an original that could not go back stays in it
    throw e;
  }
  if (opts.discard) { try { fs.rmSync(hold, { recursive: true, force: true }); } catch {} }
  return pages.length;
}

// A new, empty covers\.manual-originals\<game>\<time>\ for pages about to be replaced: never one that already holds a backup
function backupDir(dir, base) {
  const root = path.join(dir, '.manual-originals', base), stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
  fs.mkdirSync(root, { recursive: true });
  for (let i = 0; ; i++) {
    const d = path.join(root, i ? `${stamp}-${i}` : stamp);
    try { fs.mkdirSync(d); return d; } catch (e) { if (e.code !== 'EEXIST' || i > 99) throw e; }
  }
}

function medianWidth(dir, base) {
  const pre = (base + '-manual-').toLowerCase(); let w = [];
  try { w = fs.readdirSync(dir).filter(f => f.toLowerCase().startsWith(pre) && /\.(jpe?g|png)$/i.test(f)).map(f => (sizeOf(path.join(dir, f)) || [0])[0]).filter(Boolean).sort((a, b) => a - b); } catch {}
  return w.length ? w[w.length >> 1] : 0;
}
module.exports = { sizeOf, sizeOfAsync, isSpread, splitManual, medianWidth, backupDir };
