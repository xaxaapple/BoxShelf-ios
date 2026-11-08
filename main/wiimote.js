// The Wii remote on the shelf (Windows): runs main/wiimote.cs in a hidden Windows PowerShell (compiled once, cached as a
// DLL in its own folder) and reports what the remote does. A remote paired to a Mayflash DolphinBar in its Dolphin mode
// works as it is; pause() lets go of it before Dolphin starts a game, resume() takes it back after.
//   onState({ buttons, x, y, seen })  x / y: 0..1 of the camera's view, seen: the bar's lights are in view
//   onConnect(true | false)
//   onWatch(buttons)  during a Dolphin game (watch()): the remote's buttons, read alongside Dolphin without sending anything
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

let proc = null, log = () => {}, handlers = {}, cacheDir = '', wantPaused = false, pausedNow = false, pauseWaiters = [], restarts = 0, stopping = false, restartT = null;
const SRC = path.join(__dirname, 'wiimote.cs');
const psq = s => "'" + String(s).replace(/'/g, "''") + "'";

function source() { try { return fs.readFileSync(SRC, 'utf8'); } catch { return ''; } }
function dllPath(src) { return path.join(cacheDir, `wm-${require('crypto').createHash('sha1').update(src).digest('hex').slice(0, 12)}.dll`); }

function start(opts = {}) {
  if (process.platform !== 'win32' || proc) return false;
  log = opts.log || log; handlers = opts; cacheDir = opts.cacheDir || cacheDir; stopping = false;
  const src = source(); if (!src || !cacheDir) return false;
  try { fs.mkdirSync(cacheDir, { recursive: true }); } catch {}
  const dll = dllPath(src), cs = path.join(require('os').tmpdir(), `boxshelf-wm-${process.pid}.cs`);
  // old builds of the reader (in use ones can't be deleted: skipped)
  try { for (const f of fs.readdirSync(cacheDir)) if (f !== path.basename(dll)) { try { fs.unlinkSync(path.join(cacheDir, f)); } catch {} } } catch {}
  try { if (!fs.existsSync(dll)) fs.writeFileSync(cs, src, 'utf8'); } catch (e) { log('wiimote source', e.message); return false; }
  // compiled straight into the cache the first time (the source is read here: inside a packed build PowerShell can't see it)
  const script = `$ErrorActionPreference = 'Stop'
$dll = ${psq(dll)}
if (-not (Test-Path -LiteralPath $dll)) { Add-Type -Path ${psq(cs)} -OutputAssembly $dll -OutputType Library; Remove-Item -LiteralPath ${psq(cs)} -ErrorAction SilentlyContinue }
Add-Type -Path $dll
[WMH]::Run()`;
  try {
    proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) { log('wiimote spawn failed', e.message); proc = null; return false; }
  const me = proc; let buf = '', err = '';
  me.stdout.setEncoding('utf8');
  me.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) onLine(line); } });
  me.stderr.on('data', d => { if (err.length < 2000) err += d; });
  me.on('error', e => log('wiimote helper', e.message));
  me.on('exit', code => {
    if (proc === me) proc = null;
    pausedNow = false; const w = pauseWaiters.splice(0); w.forEach(f => f());
    if (handlers.onConnect) try { handlers.onConnect(false); } catch {}
    if (stopping) return;
    log('wiimote helper ended', code, err.trim().split(/\r?\n/).slice(0, 3).join(' | '));
    // ended on its own (a crash, a failed compile): try again a few times, slower each time
    if (restarts < 4) { const ms = 2000 * Math.pow(2, restarts++); restartT = setTimeout(() => { restartT = null; if (!proc && !stopping) start(handlers); }, ms); }
  });
  if (wantPaused) command('PAUSE');
  return true;
}
function onLine(line) {
  if (line === 'READY') { restarts = 0; log('wiimote: reader running'); return; }
  if (line === 'P 1') { pausedNow = true; const w = pauseWaiters.splice(0); w.forEach(f => f()); return; }
  if (line === 'P 0') { pausedNow = false; return; }
  if (line === 'C 1' || line === 'C 0') { const on = line === 'C 1'; if (on) log('wiimote: remote connected'); if (handlers.onConnect) try { handlers.onConnect(on); } catch {} return; }
  const h = /^H (\d+)$/.exec(line); if (h) { if (handlers.onWatch) try { handlers.onWatch(+h[1]); } catch {} return; }
  const m = /^S (\d+) (-?[\d.]+) (-?[\d.]+) ([01])$/.exec(line);
  if (m && handlers.onState) try { handlers.onState({ buttons: +m[1], x: +m[2], y: +m[3], seen: m[4] === '1' }); } catch {}
}
function command(c) { try { if (proc && proc.stdin.writable) proc.stdin.write(c + '\n'); } catch {} }
// let go of the remote (resolves once it has, or after a second at the latest); Dolphin can then connect to it
function pause() {
  wantPaused = true; if (!proc) return Promise.resolve();
  if (pausedNow) return Promise.resolve();
  command('PAUSE');
  return new Promise(res => { let done = false; const fin = () => { if (!done) { done = true; res(); } }; pauseWaiters.push(fin); setTimeout(fin, 1000); });
}
function resume() { wantPaused = false; command('RESUME'); if (!proc && handlers.onState && !stopping && !restartT) start(handlers); }
// while paused (a Dolphin game): listen to the remote alongside Dolphin, read-only, for its buttons (onWatch)
function watch() { if (wantPaused) command('WATCH'); }
function rumble(ms) { command('RUMBLE ' + Math.round(ms || 30)); }
function stop() { stopping = true; clearTimeout(restartT); restartT = null; if (proc) { command('QUIT'); const p = proc; setTimeout(() => { try { p.kill(); } catch {} }, 800); proc = null; } }
const isRunning = () => !!proc;

// the remote's buttons (the reader's bits: first byte Left Right Down Up Plus, second 2 1 B A Minus · · Home)
const BTN = { left: 0x0100, right: 0x0200, down: 0x0400, up: 0x0800, plus: 0x1000, two: 0x0001, one: 0x0002, b: 0x0004, a: 0x0008, minus: 0x0010, home: 0x0080 };

module.exports = { start, stop, pause, resume, watch, rumble, isRunning, BTN };
