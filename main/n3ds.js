// 3DS .cia files on the shelf. A .cia is an installer, not something Azahar boots: Azahar asks to install it first.
// So the first time you play one, Boxshelf installs it into Azahar's own SD card folder the same way Azahar does
// (the title's TMD as 00000000.tmd and each content as <content id>.app) and then boots the installed game; after
// that it boots straight away. Only unencrypted .cia files can be installed like this (Azahar has the same rule).
const fs = require('fs');
const path = require('path');

const ZERO = '00000000000000000000000000000000';
const align = (n, a = 64) => Math.ceil(n / a) * a;
const SIG = { 0x10000: 0x240, 0x10001: 0x140, 0x10002: 0x80, 0x10003: 0x240, 0x10004: 0x140, 0x10005: 0x80 };

async function readAt(fd, pos, len) { const b = Buffer.alloc(len); const { bytesRead } = await fd.read(b, 0, len, pos); return b.subarray(0, bytesRead); }

// the CIA's layout and its TMD (title id, contents)
async function parse(file) {
  const fd = await fs.promises.open(file, 'r');
  try {
    const h = await readAt(fd, 0, 0x2020); if (h.length < 0x2020) throw new Error('not a CIA');
    const hdr = h.readUInt32LE(0), cert = h.readUInt32LE(8), tik = h.readUInt32LE(12), tmdSize = h.readUInt32LE(16);
    if (hdr !== 0x2020 || tmdSize < 0xC4 || tmdSize > 0x100000) throw new Error('not a CIA');
    const present = i => (h[0x20 + (i >> 3)] & (0x80 >> (i & 7))) !== 0;
    const tmdAt = align(align(align(hdr) + cert) + tik), contentAt = align(tmdAt + tmdSize);
    const tmd = await readAt(fd, tmdAt, tmdSize);
    const sig = SIG[tmd.readUInt32BE(0)]; if (!sig) throw new Error('unknown TMD signature');
    const body = sig; // the header follows the signature block (type + signature + padding)
    const titleId = tmd.readBigUInt64BE(body + 0x4C), count = tmd.readUInt16BE(body + 0x9E);
    const chunks = []; let at = contentAt;
    for (let i = 0; i < count; i++) {
      const o = body + 0xC4 + 64 * 0x24 + i * 0x30; if (o + 0x30 > tmd.length) throw new Error('short TMD');
      const c = { id: tmd.readUInt32BE(o), index: tmd.readUInt16BE(o + 4), type: tmd.readUInt16BE(o + 6), size: Number(tmd.readBigUInt64BE(o + 8)), present: present(i) };
      c.at = at; if (c.present) at += c.size; chunks.push(c);
    }
    return { titleId, tmd, chunks };
  } finally { await fd.close(); }
}

// Azahar's user folder: a "user" folder next to azahar.exe (portable), otherwise %APPDATA%\Azahar; its SD card can be moved in its settings
// Citra and Lime3DS (Azahar's predecessors) keep the same layout under their own names
const emuName = exe => /citra/i.test(path.basename(exe || '')) ? 'Citra' : /lime3ds/i.test(path.basename(exe || '')) ? 'Lime3DS' : 'Azahar';
function sdmcDir(exe) {
  if (process.platform === 'linux') return sdmcDirLinux(exe);
  let user = exe ? path.join(path.dirname(exe), 'user') : null;
  try { if (!user || !fs.statSync(user).isDirectory()) user = null; } catch { user = null; }
  if (!user) user = path.join(process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming'), emuName(exe));
  try {
    const ini = fs.readFileSync(path.join(user, 'config', 'qt-config.ini'), 'utf8');
    const custom = /^use_custom_storage\s*=\s*true\s*$/im.test(ini), m = /^sdmc_directory\s*=\s*(.+?)\s*$/im.exec(ini);
    if (custom && m && m[1] && !/^@/.test(m[1])) return path.resolve(m[1].replace(/\//g, path.sep));
  } catch {}
  return path.join(user, 'sdmc');
}

// (Linux) Azahar keeps its data in ~/.local/share/azahar-emu (the Flatpak: ~/.var/app/org.azahar_emu.Azahar/data/…) and
// its settings in ~/.config/azahar-emu; Citra and Lime3DS the same with their own names. Azahar has to have run once.
function sdmcDirLinux(exe) {
  const home = require('os').homedir(), name = emuName(exe).toLowerCase() + '-emu';
  const flat = path.join(home, '.var', 'app', 'org.azahar_emu.Azahar');
  const pairs = [[path.join(home, '.local', 'share', name), path.join(home, '.config', name)], [path.join(flat, 'data', name), path.join(flat, 'config', name)]];
  const hit = pairs.find(([d]) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
  if (!hit) throw new Error(`Open ${emuName(exe)} once on its own first (it makes its folders then), then press Play again.`);
  try {
    const ini = fs.readFileSync(path.join(hit[1], 'qt-config.ini'), 'utf8');
    const custom = /^use_custom_storage\s*=\s*true\s*$/im.test(ini), m = /^sdmc_directory\s*=\s*(.+?)\s*$/im.exec(ini);
    if (custom && m && m[1] && !/^@/.test(m[1])) return path.resolve(m[1]);
  } catch {}
  return path.join(hit[0], 'sdmc');
}
function contentDir(sdmc, info) {
  const hi = (info.titleId >> 32n).toString(16).padStart(8, '0'), lo = (info.titleId & 0xffffffffn).toString(16).padStart(8, '0');
  let dir = path.join(sdmc, 'Nintendo 3DS', ZERO, ZERO, 'title', hi, lo, 'content');
  if (info.chunks.length > 1 && (info.chunks[1].type & 0x4000)) dir = path.join(dir, '00000000'); // DLC: Azahar keeps those one folder down
  return dir;
}
const appName = c => c.id.toString(16).padStart(8, '0') + '.app';

// copy one content out of the CIA, yielding now and then so the app stays smooth
async function copyRange(src, dst, at, size, onBytes) {
  const tmp = dst + '.part';
  // pipeline: both streams are closed when either fails (no open handle on the half-written file), and that file goes
  try {
    let n = 0; const r = fs.createReadStream(src, { start: at, end: at + size - 1, highWaterMark: 4 << 20 });
    r.on('data', d => { n += d.length; onBytes(d.length); });
    await require('stream/promises').pipeline(r, fs.createWriteStream(tmp));
    // a .cia cut short (an unfinished download) ends early without an error: a short content would be "installed", fail
    // to boot, and be copied again on every launch
    if (n !== size) throw new Error('This .cia is incomplete (the file ends early; it may not have finished downloading).');
    await fs.promises.rename(tmp, dst);
  } catch (e) { await fs.promises.unlink(tmp).catch(() => {}); if (e && e.code === 'ENOSPC') throw new Error('There isn\'t enough free space on the drive to install this game.'); throw e; }
}

// The file Azahar should boot for this game: the game itself, or for a .cia the installed copy (installed first if needed)
async function bootFile(file, exe, onStatus = () => {}) {
  if (!/\.cia$/i.test(file)) return file;
  const info = await parse(file);
  const E = emuName(exe), keys = E !== 'Azahar'; // Citra / Lime3DS can run encrypted games themselves when you've given them your 3DS's keys
  if (info.chunks.some(c => c.present && (c.type & 1))) throw new Error(keys ? `This .cia is encrypted: install it once inside ${E} (File → Install CIA), then play it from here.` : 'This .cia is encrypted, so Azahar can\'t use it. Use a decrypted copy of the game.');
  const main = info.chunks.find(c => c.index === 0) || info.chunks[0]; if (!main || !main.present) throw new Error('This .cia has no game inside (it may be an update or DLC: install it inside Azahar).');
  // the game inside can still be encrypted even when the .cia around it isn't (Azahar's log then says "Blocked unauthorized
  // encrypted CIA installation"): NCCH header flags, byte 7 bit 0x4 = no encryption
  { const fd = await fs.promises.open(file, 'r'); let n; try { n = await readAt(fd, main.at, 0x200); } finally { await fd.close(); }
    if (n.length < 0x200 || n.toString('latin1', 0x100, 0x104) !== 'NCCH') throw new Error('This .cia doesn\'t look like a 3DS game Azahar can use.');
    if (!(n[0x18F] & 0x4) && !keys) throw new Error('This game is still encrypted inside its .cia, so Azahar can\'t install it. Use a decrypted copy of the game.'); }
  const dir = contentDir(sdmcDir(exe), info), boot = path.join(dir, appName(main));
  const have = async c => { try { return (await fs.promises.stat(path.join(dir, appName(c)))).size === c.size; } catch { return false; } };
  let done = (await fs.promises.readdir(dir).catch(() => [])).some(n => /\.tmd$/i.test(n)); if (done) for (const c of info.chunks) if (c.present && !(await have(c))) { done = false; break; }
  if (done) return boot;
  await fs.promises.mkdir(dir, { recursive: true });
  const todo = info.chunks.filter(c => c.present), total = todo.reduce((a, c) => a + c.size, 0) || 1; let got = 0, shown = -1;
  onStatus(`Installing into ${E} · 0%`);
  for (const c of todo) {
    if (await have(c)) { got += c.size; continue; }
    await copyRange(file, path.join(dir, appName(c)), c.at, c.size, n => { got += n; const p = Math.floor(got / total * 100); if (p !== shown) { shown = p; onStatus(`Installing into ${E} · ${p}%`); } });
  }
  // written last: an interrupted install isn't taken as a finished one (and through a temp name, so a cut-off .tmd isn't either)
  const tmd = path.join(dir, '00000000.tmd'); try { await fs.promises.writeFile(tmd + '.part', info.tmd); await fs.promises.rename(tmd + '.part', tmd); } catch (e) { await fs.promises.unlink(tmd + '.part').catch(() => {}); throw e; }
  onStatus(`Starting in ${E}`);
  return boot;
}

module.exports = { bootFile, _test: { parse, sdmcDir, contentDir } };
