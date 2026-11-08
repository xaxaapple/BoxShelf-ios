// Read single files out of a ZArchive (.wua, Cemu's Wii U format) without unpacking the whole thing.
// Format (github.com/Exzap/ZArchive): big-endian; a 144-byte footer at the end points at the sections: zstd-compressed
// data in 64 KiB blocks, offset records (a 64-bit base + 16 sizes per record), a name table and a flat file tree.
const fs = require('fs');
const zlib = require('zlib');

const BLOCK = 64 * 1024, PER_RECORD = 16, FOOTER = 144, MAGIC = 0x169f52d6;
// the archive is untrusted: a declared size is only believed up to these (real manuals/icons are a few MB; the
// tables of a 30 GB game are ~2 MB), so a bad header gets a clear error instead of a multi-GB allocation
const MAX_FILE = 256 << 20, MAX_TABLE = 64 << 20;

function readAt(fd, pos, len) { const b = Buffer.alloc(len); let got = 0; while (got < len) { const n = fs.readSync(fd, b, got, len - got, pos + got); if (!n) break; got += n; } return got === len ? b : b.subarray(0, got); }
const u64 = (b, o) => Number(b.readBigUInt64BE(o));

function open(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size; if (size < FOOTER) throw new Error('too small');
    const f = readAt(fd, size - FOOTER, FOOTER);
    if (f.readUInt32BE(FOOTER - 4) !== MAGIC) throw new Error('not a ZArchive');
    const sec = i => ({ offset: u64(f, i * 16), size: u64(f, i * 16 + 8) });
    const data = sec(0), recs = sec(1), names = sec(2), tree = sec(3);
    for (const s of [data, recs, names, tree]) if (s.offset + s.size > size) throw new Error('bad section');
    for (const s of [recs, names, tree]) if (s.size > MAX_TABLE) throw new Error('ZArchive table too large (' + s.size + ' bytes)');
    const recBuf = readAt(fd, recs.offset, recs.size), nameBuf = readAt(fd, names.offset, names.size), treeBuf = readAt(fd, tree.offset, tree.size);
    const records = []; for (let o = 0; o + 40 <= recBuf.length; o += 40) { const sizes = []; for (let i = 0; i < PER_RECORD; i++) sizes.push(recBuf.readUInt16BE(o + 8 + i * 2)); records.push({ base: u64(recBuf, o), sizes }); }
    const nodes = []; for (let o = 0; o + 16 <= treeBuf.length; o += 16) { const a = treeBuf.readUInt32BE(o), b = treeBuf.readUInt32BE(o + 4), c = treeBuf.readUInt32BE(o + 8), d = treeBuf.readUInt32BE(o + 12);
      nodes.push(a & 0x80000000 ? { file: true, nameOff: a & 0x7FFFFFFF, offset: b + (d & 0xFFFF) * 2 ** 32, size: c + ((d >>> 16) & 0xFFFF) * 2 ** 32 } : { file: false, nameOff: a & 0x7FFFFFFF, start: b, count: c }); }
    const name = off => { if (off === 0x7FFFFFFF || off >= nameBuf.length) return ''; let len = nameBuf[off] & 0x7F, p = off + 1; if (nameBuf[off] & 0x80) { len |= nameBuf[off + 1] << 7; p = off + 2; } return nameBuf.toString('latin1', p, p + len); };
    const cache = new Map();
    function block(i) {
      if (cache.has(i)) return cache.get(i);
      const r = records[Math.floor(i / PER_RECORD)]; if (!r) throw new Error('block out of range');
      let off = r.base; const sub = i % PER_RECORD; for (let k = 0; k < sub; k++) off += r.sizes[k] + 1;
      const csize = r.sizes[sub] + 1, raw = readAt(fd, data.offset + off, csize);
      let out; try { out = csize === BLOCK ? raw : zlib.zstdDecompressSync(raw, { maxOutputLength: BLOCK }); } // a block never unpacks past 64 KiB
      catch (e) { throw new Error(e && e.code === 'ERR_BUFFER_TOO_LARGE' ? `ZArchive block ${i} unpacks past ${BLOCK} bytes` : `ZArchive block ${i}: ${e.message}`); }
      if (cache.size > 64) cache.delete(cache.keys().next().value); cache.set(i, out); return out;
    }
    function read(node) {
      if (!(node.size >= 0) || node.size > MAX_FILE) throw new Error(`ZArchive file too large to read (${node.size} bytes, limit ${MAX_FILE})`);
      const out = Buffer.alloc(node.size); let pos = node.offset, w = 0;
      while (w < node.size) { const bi = Math.floor(pos / BLOCK), bo = pos % BLOCK, b = block(bi), n = Math.min(node.size - w, BLOCK - bo); b.copy(out, w, bo, bo + n); w += n; pos += n; }
      return out;
    }
    function children(dirNode) { const out = []; for (let i = 0; i < dirNode.count; i++) { const n = nodes[dirNode.start + i]; if (n) out.push({ ...n, name: name(n.nameOff) }); } return out; }
    // path like "0005000010101a00_v0/meta/Manual.bfma" (case-insensitive)
    function lookup(p) { let cur = nodes[0]; for (const part of p.split('/').filter(Boolean)) { if (!cur || cur.file) return null; cur = children(cur).find(c => c.name.toLowerCase() === part.toLowerCase()) || null; } return cur; }
    return { root: () => children(nodes[0]), children, lookup, read, close: () => { try { fs.closeSync(fd); } catch {} } };
  } catch (e) { try { fs.closeSync(fd); } catch {} throw e; }
}

module.exports = { open };
