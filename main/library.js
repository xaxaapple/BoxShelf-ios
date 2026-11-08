// Your magazines and strategy guides for the museum's reading corner.
//   <reading folder>\Magazines\   and   <reading folder>\Guides\   (Settings → Magazines & guides; beside Boxshelf by default)
// Each issue / guide is a PDF, a comic archive (.cbz / .cbr / .zip of page images) or a folder of page images.
// Sub-folders group them ("Magazines\Nintendo Power\Issue 001.pdf" → series "Nintendo Power").
// Covers (page 1) and the pages of archives are made once and kept in data\library\.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { readingRoot } = require('./paths');

const KINDS = { magazine: 'Magazines', guide: 'Guides' };
const IMG = /\.(jpe?g|png|webp|gif)$/i, ARCH = /\.(cbz|cbr|zip|cb7|7z|rar)$/i, PDF = /\.pdf$/i;
const MAX_ITEMS = 2000, MAX_DEPTH = 3;

let cacheRoot = null; // set by main: <userData>\library
function setCacheRoot(p) { cacheRoot = p; pruneSoon(); } // (beta.10: at startup only the size cap applies, orphans wait for a listing)
const cacheDir = () => cacheRoot;
function folder(kind) { if (!KINDS[kind]) throw new Error('Unknown library kind.'); return path.join(readingRoot(), KINDS[kind]); }
function roots() { return [folder('magazine'), folder('guide'), cacheRoot].filter(Boolean); }

const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
const idOf = p => crypto.createHash('sha1').update(path.resolve(p).toLowerCase()).digest('hex').slice(0, 16);
// "Nintendo_Power_Issue_042_(1992-11).pdf" → "Nintendo Power Issue 042 (1992-11)"
const titleOf = n => n.replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[_.]+/g, ' ').replace(/\s+/g, ' ').trim();
const imagesIn = dir => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile() && IMG.test(e.name)).map(e => e.name).sort(natural); } catch { return []; } };

// all items, both kinds; quick (directory listings only)
function scan() {
  const out = [];
  for (const kind of Object.keys(KINDS)) {
    const root = folder(kind);
    try { fs.mkdirSync(root, { recursive: true }); } catch {}
    const walk = (dir, depth, series) => {
      let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      ents.sort((a, b) => natural(a.name, b.name));
      for (const e of ents) {
        if (out.length >= MAX_ITEMS) return;
        if (e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        let st; try { st = fs.statSync(full); } catch { continue; }
        if (e.isDirectory()) {
          // a folder of page images is one issue; any other folder is a series (walked into)
          const imgs = imagesIn(full);
          if (imgs.length >= 2) out.push({ id: idOf(full), kind, type: 'dir', title: titleOf(e.name), series, path: full, mtime: Math.floor(st.mtimeMs), pages: imgs.length });
          else if (depth < MAX_DEPTH) walk(full, depth + 1, series ? series + ' · ' + titleOf(e.name) : titleOf(e.name));
        } else if (PDF.test(e.name) || ARCH.test(e.name)) {
          out.push({ id: idOf(full), kind, type: PDF.test(e.name) ? 'pdf' : 'arch', title: titleOf(e.name), series, path: full, mtime: Math.floor(st.mtimeMs), size: st.size });
        }
      }
    };
    walk(root, 0, '');
  }
  return out;
}

let last = new Map(), listed = false; // id -> item, from the last scan (the renderer only ever names items by id)
function list() { const items = scan(); last = new Map(items.map(i => [i.id, i])); listed = true; pruneSoon(); return items; }
function get(id) { const it = last.get(String(id)); if (!it) throw new Error('Not in the library.'); return it; }

const run = (cmd, args, opts = {}) => new Promise((res, rej) => execFile(cmd, args, { windowsHide: true, timeout: 120e3, maxBuffer: 16 << 20, ...opts }, (err, out) => err ? rej(err) : res(String(out))));
// an archive's pages: unpacked once into data\library\<id>-<mtime>\ (tar on Windows reads zip, rar and 7z)
const unpacking = new Map();
// at most two archives unpack at once (a reading corner full of covers would otherwise start dozens of tar runs)
let tarBusy = 0; const tarQ = [];
async function tarSlot(fn) { if (tarBusy >= 2) await new Promise(r => tarQ.push(r)); else tarBusy++; try { return await fn(); } finally { const n = tarQ.shift(); if (n) n(); else tarBusy--; } }
// image entries only, never a path that climbs out of the folder, and never a name starting with '-' (tar would read it as
// one of its own options, e.g. --use-compress-program, since the names go on its command line)
const safeImg = n => IMG.test(n) && !/^[-@]/.test(n) && !/(^|[\\/])\.\.([\\/]|$)/.test(n) && !path.isAbsolute(n) && !/^[a-z]:/i.test(n) && !/__MACOSX/i.test(n);
// (Linux: GNU tar reads none of these; bsdtar, SteamOS has it, reads them all; without it a .cbz still opens through
// unzip / Python, main/linux.js)
const TAR = process.platform === 'linux' ? 'bsdtar' : 'tar';
const archNames = async it => {
  try { return (await run(TAR, ['-tf', it.path])).split(/\r?\n/).map(s => s.trim()).filter(safeImg); }
  catch (e) { const l = process.platform === 'linux' && require('./linux').zipList(it.path); if (l) return l.map(s => s.trim()).filter(safeImg); throw e; }
};
// many names don't fit Windows' 32,767-character command line (ENAMETOOLONG): hand them to tar in a list file then
async function extract(it, out, names) {
  if (process.platform === 'linux') { try { await run(TAR, ['-xf', it.path, '-C', out, ...names]); return; } catch (e) { if (await require('./linux').unzipAsync(it.path, out)) return; throw e; } }
  if (names.reduce((a, n) => a + n.length + 3, 0) < 20000) return run('tar', ['-xf', it.path, '-C', out, ...names]);
  const list = path.join(out, '.names.txt'); fs.writeFileSync(list, names.join('\n') + '\n');
  try { await run('tar', ['-xf', it.path, '-C', out, '-T', list]); } finally { try { fs.unlinkSync(list); } catch {} }
}
async function unpack(it) {
  if (!cacheRoot) throw new Error('No cache folder.');
  const out = path.join(cacheRoot, `${it.id}-${it.mtime}`);
  const done = path.join(out, '.done');
  if (fs.existsSync(done)) { touch(out); return out; }
  if (unpacking.has(out)) return unpacking.get(out);
  const p = tarSlot(async () => {
    fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
    const names = await archNames(it); // list first
    if (!names.length) throw new Error('No page images inside.');
    await extract(it, out, names.slice(0, 1500));
    fs.writeFileSync(done, '');
    // old unpacks of the same item (it changed since)
    try { for (const d of fs.readdirSync(cacheRoot)) if (d.startsWith(it.id + '-') && d !== path.basename(out)) fs.rmSync(path.join(cacheRoot, d), { recursive: true, force: true }); } catch {}
    pruneSoon(); // (beta.10: the cache stays under its cap)
    return out;
  });
  unpacking.set(out, p); p.finally(() => unpacking.delete(out)).catch(() => {});
  return p;
}
function imagesUnder(dir) {
  const found = [];
  const walk = (d, depth) => { let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of ents) { const f = path.join(d, e.name); if (e.isDirectory() && depth < 4) walk(f, depth + 1); else if (e.isFile() && IMG.test(e.name)) found.push(f); } };
  walk(dir, 0);
  return found.sort((a, b) => natural(path.relative(dir, a), path.relative(dir, b)));
}

// what the reader opens: a PDF (pages drawn on the fly by pdf.js) or a list of page image files
async function pages(id) {
  const it = get(id);
  if (it.type === 'pdf') return { type: 'pdf', file: it.path };
  if (it.type === 'dir') return { type: 'images', files: imagesIn(it.path).map(n => path.join(it.path, n)) };
  return { type: 'images', files: imagesUnder(await unpack(it)) };
}

// where a PDF's cover is kept: a download saves the Internet Archive's own picture of page 1 here, so a big PDF never has
// to be opened just for its cover (null without a cache folder)
function coverPath(file, back) { if (!cacheRoot) return null; let st; try { st = fs.statSync(file); } catch { return null; } return path.join(cacheRoot, 'covers', `${idOf(file)}-${Math.floor(st.mtimeMs)}${back ? '-back' : ''}.jpg`); }
// the cover: page 1, at most 900 px tall, kept as data\library\covers\<id>-<mtime>.jpg. pdfPage(file) → JPEG Buffer
// side 'back': the last page (the back cover), for when you pick it up. pdfPage(file, last) → JPEG Buffer
async function cover(id, pdfPage, side) {
  const it = get(id), back = side === 'back';
  if (it.type === 'dir') { const l = imagesIn(it.path), f = back ? l[l.length - 1] : l[0]; return f ? path.join(it.path, f) : null; }
  if (it.type === 'arch') {
    // already unpacked (it was read): use that; otherwise take out just the one page instead of the whole archive
    if (!cacheRoot || fs.existsSync(path.join(cacheRoot, `${it.id}-${it.mtime}`, '.done'))) { const p = await pages(id); return (back ? p.files[p.files.length - 1] : p.files[0]) || null; }
    const cdir = path.join(cacheRoot, 'covers', `${it.id}-${it.mtime}${back ? '-back' : ''}`), have = () => fs.existsSync(path.join(cdir, '.done')) ? imagesUnder(cdir)[0] || null : null;
    { const h = have(); if (h) { touch(cdir); return h; } }
    const key = cdir; if (unpacking.has(key)) return unpacking.get(key);
    const p = tarSlot(async () => {
      if (have()) return have();
      const names = (await archNames(it)).sort((a, b) => natural(a.replace(/\\/g, '/'), b.replace(/\\/g, '/')));
      if (!names.length) return null;
      fs.rmSync(cdir, { recursive: true, force: true }); fs.mkdirSync(cdir, { recursive: true });
      await extract(it, cdir, [back ? names[names.length - 1] : names[0]]);
      fs.writeFileSync(path.join(cdir, '.done'), '');
      return imagesUnder(cdir)[0] || null;
    });
    unpacking.set(key, p); p.finally(() => unpacking.delete(key)).catch(() => {});
    return p;
  }
  if (!cacheRoot) return null;
  const dir = path.join(cacheRoot, 'covers'), out = path.join(dir, `${it.id}-${it.mtime}${back ? '-back' : ''}.jpg`);
  if (fs.existsSync(out)) { touch(out); return out; }
  const b = await pdfPage(it.path, back); if (!b || !b.length) return null;
  // temp + rename: the cover is reused whenever the file exists, so a cut-off write would have stayed broken
  fs.mkdirSync(dir, { recursive: true }); const tmp = `${out}.${process.pid}.tmp`; try { fs.writeFileSync(tmp, b); fs.renameSync(tmp, out); } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
  return out;
}

// (beta.10) data\library never grows for ever: the unpacked archives and covers of items no longer in the reading folders
// go, and the rest stays under CAP_BYTES, the least recently read going first (a read or a cover shown touches its date).
// Async (fs.promises), a while after a listing or an unpack; anything used in the last RECENT ms, or unpacking, is kept.
const CAP_BYTES = 2 * 1024 ** 3, RECENT = 2 * 3600e3, CACHED = /^[0-9a-f]{16}-\d+(-back)?(\.jpg)?$/;
const touch = p => { const now = new Date(); fs.promises.utimes(p, now, now).catch(() => {}); };
let pruneT = null, pruning = false;
function pruneSoon() { if (!cacheRoot) return; clearTimeout(pruneT); pruneT = setTimeout(() => { prune().catch(() => {}); }, 30000); if (pruneT.unref) pruneT.unref(); }
async function du(p) { let st; try { st = await fs.promises.lstat(p); } catch { return 0; } if (!st.isDirectory()) return st.size; let n = 0, ents = []; try { ents = await fs.promises.readdir(p); } catch {} for (const e of ents) n += await du(path.join(p, e)); return n; }
async function prune() {
  if (!cacheRoot || pruning) return; pruning = true;
  try {
    // orphans only from a listing that found something (a reading folder on a drive that's away lists nothing) and wasn't cut at MAX_ITEMS
    const ids = listed && last.size && last.size < MAX_ITEMS ? new Set(last.keys()) : null, ents = [], now = Date.now();
    for (const dir of [cacheRoot, path.join(cacheRoot, 'covers')]) {
      let ns = []; try { ns = await fs.promises.readdir(dir); } catch { continue; }
      for (const n of ns) { const p = path.join(dir, n); if (!CACHED.test(n) || unpacking.has(p)) continue; let st; try { st = await fs.promises.stat(p); } catch { continue; } ents.push({ p, id: n.slice(0, 16), t: st.mtimeMs, size: 0 }); }
    }
    const keep = [];
    for (const e of ents) { if (ids && !ids.has(e.id) && now - e.t > RECENT) await fs.promises.rm(e.p, { recursive: true, force: true }).catch(() => {}); else keep.push(e); }
    let total = 0; for (const e of keep) { e.size = await du(e.p); total += e.size; }
    if (total <= CAP_BYTES) return;
    keep.sort((a, b) => a.t - b.t);
    for (const e of keep) { if (total <= CAP_BYTES) break; if (now - e.t < RECENT || unpacking.has(e.p)) continue; await fs.promises.rm(e.p, { recursive: true, force: true }).then(() => { total -= e.size; }, () => {}); }
  } finally { pruning = false; }
}

module.exports = { setCacheRoot, cacheDir, coverPath, folder, roots, list, get, pages, cover, scan, prune };
