// (beta.9) Linux / Steam Deck: hold Select + Start for 1.5 s during a game and Boxshelf closes it (closeGame), whatever
// the emulator, configured or not. Windows has the Home menu on the Guide button (padwatch.js, XInput); in Steam's Game
// Mode the Steam button belongs to Steam, so Linux gets this instead.
// It reads the joystick devices (/dev/input/js*: Steam's virtual gamepad shows up as one, with the Xbox layout) only while
// a game is running, and stops when it ends. Each event is 8 bytes: time (ms), value, type (1 button, 2 axis, | 0x80 the
// first "this is how it is now" report), number. Button numbers: Xbox layout Select 6 / Start 7; PlayStation pads 8 / 9.
'use strict';
const fs = require('fs');
const path = require('path');

const HOLD_MS = 1500;
let log = () => {}, dir = '/dev/input', sysDir = '/sys/class/input', force = false;
function init(o) { log = o.log || log; if (o.dir) dir = o.dir; if (o.sysDir) sysDir = o.sysDir; force = !!o.force; }

let on = null; // { onQuit, devs: Map(name -> { fd, down: Set, sel, start }), timer, scan, fired }
function layout(name) {
  let n = ''; try { n = fs.readFileSync(path.join(sysDir, name, 'device', 'name'), 'utf8'); } catch {}
  return /sony|playstation|dualsense|dualshock|wireless controller/i.test(n) ? { sel: 8, start: 9, label: n.trim() } : { sel: 6, start: 7, label: n.trim() || 'gamepad' };
}
function check() {
  if (!on || on.fired) return;
  const held = [...on.devs.values()].some(d => d.down.has(d.sel) && d.down.has(d.start));
  if (held && !on.timer) on.timer = setTimeout(() => { if (!on) return; on.timer = null; if ([...on.devs.values()].some(d => d.down.has(d.sel) && d.down.has(d.start))) { on.fired = true; log('Linux pad: Select + Start held, closing the game'); try { on.onQuit(); } catch (e) { log('Linux pad: quit failed', e.message); } } }, HOLD_MS);
  if (!held && on.timer) { clearTimeout(on.timer); on.timer = null; }
}
// (beta.10) opened non-blocking and read in short polls: a read stream parked a libuv threadpool worker in read() on a silent
// pad for good (destroy() can't cancel it), and after ~4 games all four were stuck and every fs.promises call hung. Here a
// read with nothing waiting returns EAGAIN at once, so no worker is ever held, and closing is immediate. (A net.Socket on
// the fd isn't possible: libuv takes a character device for a file.)
const POLL_MS = 40;
function open(name) {
  if (!on || on.devs.has(name)) return;
  const L = layout(name), d = { ...L, down: new Set(), fd: -1, t: null, reading: false, gone: false, rest: Buffer.alloc(0) };
  try { d.fd = fs.openSync(path.join(dir, name), fs.constants.O_RDONLY | fs.constants.O_NONBLOCK); } catch { return; }
  on.devs.set(name, d); const buf = Buffer.alloc(512);
  const pump = () => { d.t = null; if (d.gone) return shut(d); d.reading = true;
    fs.read(d.fd, buf, 0, buf.length, null, (err, n) => { d.reading = false;
      if (d.gone) return shut(d);
      if (err && err.code !== 'EAGAIN' && err.code !== 'EWOULDBLOCK' && err.code !== 'EINTR') { shut(d); if (on && on.devs.get(name) === d) on.devs.delete(name); return; } // (unplugged: ENODEV; a stale device can't remove the next one's entry)
      if (!err && n > 0) { feed(d, Buffer.from(buf.subarray(0, n))); d.t = setTimeout(pump, 0); return; } // (copied: the buffer is reused; more may be waiting)
      if (!err && n === 0) { shut(d); if (on && on.devs.get(name) === d) on.devs.delete(name); return; }
      d.t = setTimeout(pump, POLL_MS); });
  };
  pump();
}
// stop reading a device and close it (after a read in flight comes back: never closed under it)
function stopDev(d) { d.gone = true; clearTimeout(d.t); d.t = null; if (!d.reading) shut(d); }
function shut(d) { d.gone = true; if (d.fd >= 0) { const fd = d.fd; d.fd = -1; fs.close(fd, () => {}); } }
function feed(d, chunk) { const b = d.rest.length ? Buffer.concat([d.rest, chunk]) : chunk; let i = 0;
  for (; i + 8 <= b.length; i += 8) { const value = b.readInt16LE(i + 4), type = b[i + 6], num = b[i + 7];
    if ((type & 0x7f) !== 1) continue; // buttons only
    if (value) d.down.add(num); else d.down.delete(num);
    if (!(type & 0x80)) check(); } // (the opening "how it is now" report never starts a hold)
  d.rest = b.subarray(i); }
// (tests) events for a pretend pad that stays plugged in
function _feed(name, buf, sysName) { if (!on) return; let d = on.devs.get(name); if (!d) { d = { ...layout(sysName || name), down: new Set(), fd: -1, rest: Buffer.alloc(0) }; on.devs.set(name, d); } feed(d, buf); }
function scan() { if (!on) return; let names = []; try { names = fs.readdirSync(dir).filter(n => /^js\d+$/.test(n)); } catch {} for (const n of names) open(n); }
// a game started: watch the pads until end()
function begin(onQuit) {
  if (process.platform !== 'linux' && !force) return false;
  end(); on = { onQuit, devs: new Map(), timer: null, fired: false, scan: null };
  scan(); on.scan = setInterval(scan, 3000); // (a pad plugged in during the game)
  return true;
}
function end() { if (!on) return; const o = on; on = null; clearTimeout(o.timer); clearInterval(o.scan); for (const d of o.devs.values()) { try { stopDev(d); } catch {} } }
const watching = () => !!on;

module.exports = { init, begin, end, watching, HOLD_MS, _feed };
