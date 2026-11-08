// Starts emulators, Steam games and media apps, and reports when they close.
const { spawn } = require('child_process');
const path = require('path');
const { shell } = require('electron');
const { isFile, expand } = require('./paths');

let running = null;

// Split an options string like  -b -e "{rom}"  into arguments, filling in {rom}.
function buildArgs(template, rom) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(template || ''))) out.push((m[1] !== undefined ? m[1] : m[2]).replace(/\{rom\}/g, () => rom || '')); // a function: a path like Ca$$h\game.iso must not be read as a replacement pattern
  return out.filter(a => a !== '');
}

function start(exe, args, onExit, env) { // env: the emulator's own environment (PS5: the KytyJets preset); else Boxshelf's
  exe = exe && expand(String(exe).trim().replace(/^"(.*)"$/, '$1')); // same rules as the Settings check: %VAR%, {app}, pasted "quotes"
  if (!exe || !isFile(exe)) throw new Error(`Can't find ${exe || 'the program'}. Check its path in Settings.`);
  if (running) throw new Error(busyMessage());
  // detached: on Windows a normal child sits in Node's kill-on-close job object, so a Boxshelf crash or update restart
  // would take the emulator (and its unsaved game) with it. Not unref'd: the 'exit' event must still reach us.
  const child = spawn(exe, args, Object.assign({ cwd: path.dirname(exe), windowsHide: false, stdio: 'ignore', detached: true }, env ? { env } : {}));
  running = child; child.bsName = path.basename(exe, path.extname(exe)); // (beta.10) its program name, never the path: the "already running" message names it
  const started = Date.now(); let done = false, spawned = false;
  const finish = info => { if (done) return; done = true; running = null; onExit({ ...info, ms: Date.now() - started }); };
  child.on('spawn', () => { spawned = true; });
  // failedToStart: the program never ran (EACCES, a bad exe, blocked by antivirus), so it wasn't a play
  child.on('error', err => finish({ code: -1, error: err.message, failedToStart: !spawned }));
  child.on('exit', code => finish({ code }));
  return { pid: child.pid, args };
}

function launchGame(sysCfg, rom, onExit, extraArgs = [], env = null) {
  return start(sysCfg.emulator, [...extraArgs, ...buildArgs(sysCfg.gameArgs, rom)], onExit, env);
}

function launchEmulator(sysCfg, onExit) {
  return start(sysCfg.emulator, buildArgs(sysCfg.emulatorArgs, ''), onExit);
}

function launchApp(exe, onExit, args) { return start(exe, Array.isArray(args) ? args : [], onExit); }

function launchSteam(appid) {
  if (!/^\d+$/.test(String(appid))) throw new Error('Unknown Steam game.');
  return shell.openExternal(`steam://rungameid/${appid}`);
}

function isRunning() { return !!running; }
// (beta.10) what's running, by name (a game's title once main.js gives it one, else the program's name; no folders)
function runningName() { return running ? String(running.bsName || '').trim().slice(0, 120) : ''; }
function setRunningName(n) { if (running && n) running.bsName = String(n); }
function busyMessage() { const n = runningName(); return n ? `${n} is already running. Close it first.` : 'Something is already running. Close it first.'; }
function stopRunning() { if (running) { try { running.kill(); } catch {} } }
// a helper spawn (taskkill) that can't be found or started must not become an uncaught 'error' event
function quiet(cmd, args) { try { const c = spawn(cmd, args, { windowsHide: true, stdio: 'ignore' }); c.on('error', () => {}); return c; } catch { return null; } }
let forceTimer = null;
// Ask the emulator to close like a click on its X (saves, settings and Dolphin's batch mode all behave),
// and force it if it's still there forceAfterMs later: Cemu, RPCS3 and Xenia can take several seconds to flush saves
// and shader caches, so the default is a generous 8 s. onForce(pid) is called if the force kill was needed.
// Returns false when nothing is running, else true (same as before).
function closeRunning(forceAfterMs = 8000, onForce) {
  if (!running) return false;
  const pid = running.pid, child = running;
  if (process.platform === 'win32') quiet('taskkill', ['/PID', String(pid)]);
  // (Linux: the whole process group, which detached started: a Flatpak's launcher, an AppImage's runtime and the emulator
  // itself all get the request, not just the first process)
  else { try { process.kill(-pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} } }
  if (!forceTimer) { // pressed again while waiting: ask again, but keep the first deadline
    const ms = Number.isFinite(+forceAfterMs) && +forceAfterMs >= 0 ? +forceAfterMs : 8000;
    forceTimer = setTimeout(() => {
      forceTimer = null;
      if (running !== child || child.exitCode !== null || child.signalCode !== null) return;
      // a "really quit?" dialog (or anything else) is holding it open: end the whole tree
      if (process.platform === 'win32') quiet('taskkill', ['/PID', String(pid), '/T', '/F']); else { try { process.kill(-pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} } }
      if (typeof onForce === 'function') { try { onForce(pid); } catch {} }
    }, ms);
    child.once('exit', () => { clearTimeout(forceTimer); forceTimer = null; });
  }
  return true;
}

module.exports = { buildArgs, launchGame, launchEmulator, launchApp, launchSteam, isRunning, runningName, setRunningName, busyMessage, stopRunning, closeRunning };
