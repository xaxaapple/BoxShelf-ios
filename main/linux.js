// Linux / Steam Deck only. Everything here is used behind process.platform === 'linux' checks; Windows never calls it.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const isLinux = process.platform === 'linux';

// Boxshelf's own folder (data\, Custom themes\, Songs\ …). An AppImage runs from a read-only mount that's gone after it
// closes, so the folder beside the .AppImage is used only when it already has a "data" folder (a portable setup);
// otherwise ~/Boxshelf. A plain `electron .` (development) keeps its project folder.
function appRoot(isPackaged, devDir) {
  if (!isPackaged) return devDir;
  const img = process.env.APPIMAGE;
  if (img) { const beside = path.dirname(img); try { if (fs.statSync(path.join(beside, 'data')).isDirectory()) return beside; } catch {} }
  const home = path.join(os.homedir(), 'Boxshelf');
  try { fs.mkdirSync(home, { recursive: true }); } catch {}
  return home;
}

// RetroArch on Linux: the program itself, its Flatpak launcher, or an AppImage
const isRetroArch = exe => /^(retroarch|org\.libretro\.retroarch|retroarch.*\.appimage)$/i.test(path.basename(String(exe || '')));
// its cores (<core>_libretro.so): the folder its settings name, its usual config folders (native, Flatpak), the distro's
// packaged cores, and a cores folder beside the program (Steam's RetroArch)
function retroCore(exe, core) {
  const home = os.homedir(), dir = path.dirname(String(exe || ''));
  const cfgDirs = [path.join(home, '.config', 'retroarch'), path.join(home, '.var', 'app', 'org.libretro.RetroArch', 'config', 'retroarch'), dir];
  const dirs = [];
  for (const c of cfgDirs) {
    let t = ''; try { t = fs.readFileSync(path.join(c, 'retroarch.cfg'), 'utf8'); } catch { continue; }
    const m = /^\s*libretro_directory\s*=\s*"([^"]*)"/m.exec(t);
    if (m && m[1] && m[1] !== 'default') dirs.push(m[1].replace(/^~(?=\/|$)/, home).replace(/^:\/?/, dir + '/'));
  }
  dirs.push(...cfgDirs.slice(0, 2).map(c => path.join(c, 'cores')), path.join(dir, 'cores'), '/usr/lib/libretro', '/usr/lib/x86_64-linux-gnu/libretro', '/usr/lib64/libretro');
  for (const d of dirs) { const f = path.join(d, core + '_libretro.so'); try { if (fs.statSync(f).isFile()) return f; } catch {} }
  return null;
}

// Unpack a .zip (LaunchBox's Metadata.zip, a console model): bsdtar (SteamOS has it), unzip, or Python's zipfile (almost
// every distro has one of them). Returns true when one worked.
function unzip(file, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const tries = [['bsdtar', ['-xf', file, '-C', dest]], ['unzip', ['-o', '-q', file, '-d', dest]], ['python3', ['-m', 'zipfile', '-e', file, dest]]];
  for (const [cmd, args] of tries) { const r = spawnSync(cmd, args, { stdio: 'ignore', timeout: 10 * 60e3 }); if (!r.error && r.status === 0) return true; }
  return false;
}
// the same without blocking (LaunchBox's 110 MB Metadata.zip): resolves true / false; member: just that one file
function unzipAsync(file, dest, member, signal) {
  const { execFile } = require('child_process');
  try { fs.mkdirSync(dest, { recursive: true }); } catch {}
  const m = member ? [member] : [];
  const tries = [['bsdtar', ['-xf', file, '-C', dest, ...m]], ['unzip', ['-o', '-q', file, ...m, '-d', dest]],
    ['python3', ['-c', 'import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);(z.extract(sys.argv[3],sys.argv[2]) if len(sys.argv)>3 else z.extractall(sys.argv[2]))', file, dest, ...m]]];
  return new Promise(resolve => {
    const next = i => { if (i >= tries.length || (signal && signal.aborted)) return resolve(false);
      execFile(tries[i][0], tries[i][1], { timeout: 10 * 60e3, ...(signal ? { signal } : {}) }, err => err ? next(i + 1) : resolve(true)); };
    next(0);
  });
}
// list a .zip's entries (comics: the page order)
function zipList(file) {
  const tries = [['bsdtar', ['-tf', file]], ['unzip', ['-Z1', file]], ['python3', ['-c', 'import sys,zipfile;print("\\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))', file]]];
  for (const [cmd, args] of tries) { const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 60e3, maxBuffer: 64e6 }); if (!r.error && r.status === 0) return String(r.stdout).split(/\r?\n/).filter(Boolean); }
  return null;
}

module.exports = { isLinux, appRoot, isRetroArch, retroCore, unzip, unzipAsync, zipList };
