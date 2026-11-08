// Your own songs for the Melody sound: MIDI files in <Boxshelf folder>\Songs\ (sub-folders too).
// The renderer reads each file's notes itself; this side only lists the folder and hands over the bytes.
const path = require('path');
const fs = require('fs');
const { appRoot } = require('./paths');

const MAX_FILES = 300, MAX_BYTES = 2 << 20;
const folder = () => path.join(appRoot(), 'Songs');
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

function list() {
  const root = folder(), out = [];
  try { fs.mkdirSync(root, { recursive: true }); } catch {}
  const walk = (dir, depth) => {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    ents.sort((a, b) => natural(a.name, b.name));
    for (const e of ents) {
      if (out.length >= MAX_FILES || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 3) walk(full, depth + 1); }
      else if (/\.(mid|midi)$/i.test(e.name)) out.push({ name: e.name.replace(/\.(mid|midi)$/i, '').replace(/[_]+/g, ' ').trim(), file: path.relative(root, full) });
    }
  };
  walk(root, 0);
  return out;
}
// file is relative to the Songs folder (as list() gives it); never a path outside it
function read(file) {
  const root = folder(), full = path.resolve(root, String(file || ''));
  if (!full.startsWith(root + path.sep) || !/\.(mid|midi)$/i.test(full)) throw new Error('Not a song in the Songs folder.');
  const st = fs.statSync(full); if (st.size > MAX_BYTES) throw new Error('That MIDI file is too big.');
  return fs.readFileSync(full);
}
module.exports = { folder, list, read };
