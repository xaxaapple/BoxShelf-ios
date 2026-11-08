// (beta.7) RetroArch cores and BIOS files.
// get(): a console's core downloaded from the libretro buildbot (the same files RetroArch's own Online Updater gets),
//   unpacked into the cores folder RetroArch reads. Windows only (Linux RetroArch builds come with their own updater).
// bios(): the BIOS files a RetroArch core wants for a console, checked against libretro's System.dat fingerprints
//   (libretro-database dat/System.dat, checked 2026-11): good / wrong version / missing.
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const crypto = require('crypto');
const { execFile } = require('child_process');

let log = () => {};
function init(o) { if (o && o.log) log = o.log; }
const isFile = f => { try { return fs.statSync(f).isFile(); } catch { return false; } };

// The folder RetroArch loads cores from: retroarch.cfg's libretro_directory (":" = RetroArch's own folder), else <RetroArch>\cores
function coresDir(exe) {
  const dir = path.dirname(exe);
  for (const f of [path.join(dir, 'retroarch.cfg'), path.join(process.env.APPDATA || '', 'RetroArch', 'retroarch.cfg')]) {
    let t = ''; try { t = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const m = /^\s*libretro_directory\s*=\s*"([^"]*)"/m.exec(t); if (m && m[1] && m[1] !== 'default') return m[1].replace(/^:[\\/]?/, dir + path.sep);
    break;
  }
  return path.join(dir, 'cores');
}
const coreFile = (exe, core) => path.join(coresDir(exe), core + '_libretro.dll');

const URL_BASE = 'https://buildbot.libretro.com/nightly/windows/x86_64/latest/';
function download(url, dest, onPct, hops = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Boxshelf' } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops < 5) { res.resume(); return resolve(download(new URL(res.headers.location, url).toString(), dest, onPct, hops + 1)); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('the download server said ' + res.statusCode)); }
      const total = +res.headers['content-length'] || 0; let got = 0, last = -1;
      res.on('data', c => { got += c.length; const p = total ? Math.floor(got / total * 100) : 0; if (p !== last && onPct) { last = p; onPct(p); } });
      // (beta.8) pipeline: an error on either side closes both (the temp folder can then be removed)
      require('stream').pipeline(res, fs.createWriteStream(dest), e => { clearTimeout(cap); if (e) reject(e); else if (total && got < total) reject(new Error('the download was cut short')); else resolve(); });
    });
    req.on('error', reject); req.setTimeout(60000, () => req.destroy(new Error('the download timed out')));
    const cap = setTimeout(() => req.destroy(new Error('the download took too long')), 5 * 60e3); // (a server trickling forever kept the launch on "Getting core…")
  });
}
const run = (cmd, args) => new Promise((res, rej) => execFile(cmd, args, { windowsHide: true, timeout: 120e3, maxBuffer: 8 << 20 }, (e, out) => e ? rej(e) : res(String(out))));
const flights = new Map();
// Downloads a core; resolves its file. The zip must hold just that one .dll (anything else is refused, nothing is unpacked).
function get(exe, core, onPct) {
  if (process.platform !== 'win32') return Promise.reject(new Error('get it from RetroArch\'s Online Updater'));
  if (!/^[a-z0-9_]+$/i.test(core)) return Promise.reject(new Error('unknown core'));
  const key = core + '|' + exe.toLowerCase(); if (flights.has(key)) return flights.get(key);
  const p = (async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-core-')), zip = path.join(tmp, core + '.zip'), want = core + '_libretro.dll';
    try {
      await download(URL_BASE + want + '.zip', zip, onPct);
      const head = Buffer.alloc(2); const fd = fs.openSync(zip, 'r'); fs.readSync(fd, head, 0, 2, 0); fs.closeSync(fd);
      if (head.toString('latin1') !== 'PK') throw new Error('the download wasn\'t a core');
      const list = (await run('tar', ['-tf', zip])).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      if (list.length !== 1 || list[0] !== want) throw new Error('the download held something other than the core');
      const unpack = path.join(tmp, 'x'); fs.mkdirSync(unpack); await run('tar', ['-xf', zip, '-C', unpack]);
      const got = path.join(unpack, want); if (!isFile(got)) throw new Error('the core wasn\'t in the download');
      const dir = coresDir(exe), dest = path.join(dir, want);
      try { fs.mkdirSync(dir, { recursive: true }); fs.copyFileSync(got, dest + '.part'); fs.renameSync(dest + '.part', dest); }
      catch (e) { try { fs.unlinkSync(dest + '.part'); } catch {} throw new Error(`RetroArch's cores folder can't be written (${e.code || e.message}): use RetroArch's Online Updater instead`); }
      log('RetroArch core downloaded:', want, '→', dir); return dest;
    } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }
  })().finally(() => flights.delete(key));
  flights.set(key, p); return p;
}

// ---------- BIOS ----------
// need: 'one' = any one of these (regions), 'req' = this file, 'opt' = better with it. md5 from libretro's System.dat.
const BIOS = {
  psx: { need: 'one', files: [['scph5501.bin', 'USA', '490f666e1afb15b7362b406ed1cea246'], ['scph5500.bin', 'Japan', '8dd7d5296a650fac7319bce665a6a53c'], ['scph5502.bin', 'Europe', '32736f17079d0b2b7024407c39bd3050']] },
  saturn: { need: 'one', files: [['mpr-17933.bin', 'USA & Europe', '3240872c70984b6cbfda1586cab68dbe'], ['sega_101.bin', 'Japan', '85ec9ca47d8f6807718151cbcca8b964']] },
  segacd: { need: 'one', files: [['bios_CD_U.bin', 'USA', '2efd74e3232ff260e371b99f84024f7f'], ['bios_CD_E.bin', 'Europe', 'e66fa1dc5820d254611fdcdba0662372'], ['bios_CD_J.bin', 'Japan', '278a9397d192149e84e820ac621a8edd']] },
  atarilynx: { need: 'req', files: [['lynxboot.img', '', 'fcd403db69f54290b51035d82f835e7b']] },
  pcengine: { need: 'opt', note: 'only CD games need it', files: [['syscard3.pce', '', '38179df8f4ac870017db21ebcbf53114']] },
  gba: { need: 'opt', note: 'games run without it', files: [['gba_bios.bin', '', 'a860e8c0b6d573d191e4ec7db1b1e4f6']] },
  dreamcast: { need: 'opt', note: 'Flycast runs most games without it', files: [['dc/dc_boot.bin', '', 'e10c53c2f8b90bab96ead2d368858623']] },
  neogeo: { need: 'req', note: 'in the games folder or the BIOS folder', files: [['neogeo.zip', '', null]] }
};
const md5 = f => new Promise(res => { const h = crypto.createHash('md5'); fs.createReadStream(f).on('error', () => res(null)).on('data', c => h.update(c)).on('end', () => res(h.digest('hex'))); });
// The BIOS state for one console, looking in each of `dirs` (first found wins). null: the console needs none.
async function bios(systemId, dirs) {
  const t = BIOS[systemId]; if (!t) return null;
  const files = [];
  for (const [name, region, sum] of t.files) {
    let where = null, state = 'missing';
    for (const d of dirs.filter(Boolean)) {
      const f = path.join(d, ...name.split('/'));
      // (a different capitalisation counts: Windows doesn't mind, and people rename these by hand)
      if (!isFile(f)) continue; where = f;
      if (!sum) { state = 'ok'; break; }
      let size = 0; try { size = fs.statSync(f).size; } catch {}
      state = size > 8 << 20 ? 'wrong' : (await md5(f)) === sum ? 'ok' : 'wrong';
      if (state === 'ok') break;
    }
    files.push({ name, region, state, where });
  }
  const ok = t.need === 'one' ? files.some(f => f.state === 'ok') : t.need === 'req' ? files.every(f => f.state === 'ok') : true;
  return { need: t.need, note: t.note || '', ok, files };
}

module.exports = { init, coresDir, coreFile, get, bios, BIOS };
