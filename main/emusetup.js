// (beta.7) "Set up for me": Boxshelf sets an emulator up the way the shelf expects, one switch per kind of change.
//   controller  the first pad mapped (only when the emulator is still on keyboard-only controls: a mapping you made is kept)
//   hotkeys     save / load / pause / screenshot on the keys the Home menu presses (main/homemenu.js HOTKEYS)
//   bios        one shared BIOS folder (Boxshelf\BIOS), only when the emulator's own BIOS folder has nothing in it
//   graphics    a resolution preset: fast / balanced / pretty (picked for this PC unless you choose)
//   quit        no "are you sure?" question when the game is closed
//   resume      (RetroArch, off unless chosen) save on quit, carry on where you left off next time
// Every file is backed up once before its first change (<file>.boxshelf-bak, the same backups Settings → Restore emulator
// settings puts back), written whole through a temp file, and listed in data/emu-setup.json so Undo puts exactly those
// back. Fullscreen needs nothing here: every launch already passes each emulator's fullscreen option.
// Setting names checked against each emulator's source (2026-11): DuckStation settings.cpp / hotkeys.cpp, PCSX2
// QtHost.cpp / Pcsx2Config.cpp / Hotkeys.cpp, PPSSPP Config.cpp, RetroArch configuration.c (confirm_quit replaced
// quit_press_twice; both are written so older builds listen too).
const fs = require('fs');
const path = require('path');
const os = require('os');
const emucfg = require('./emucfg');

let log = () => {}, dataDir = '', appRoot = '';
function init(o) { log = o.log || log; dataDir = o.dataDir || ''; appRoot = o.appRoot || ''; }

const GROUPS = ['controller', 'hotkeys', 'bios', 'graphics', 'quit', 'resume'];
const GROUP_NAME = { controller: 'Controller', hotkeys: 'Home menu hotkeys', bios: 'BIOS folder', graphics: 'Graphics', quit: 'No quit questions', resume: 'Resume where you left off' };
const DEFAULT_ON = { controller: true, hotkeys: true, bios: true, graphics: true, quit: true, resume: false };
const isFile = f => { try { return fs.statSync(f).isFile(); } catch { return false; } };
const isDir = f => { try { return fs.statSync(f).isDirectory(); } catch { return false; } };
const firstFile = list => list.find(isFile) || null;
const localAppData = () => process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const appData = () => process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');

function kindOf(exe) {
  const n = path.basename(exe || '').toLowerCase();
  if (/^retroarch/.test(n)) return 'retroarch';
  if (/dolphin/.test(n)) return 'dolphin';
  if (/duckstation/.test(n)) return 'duckstation';
  if (/pcsx2/.test(n)) return 'pcsx2';
  if (/ppsspp/.test(n)) return 'ppsspp';
  return null;
}
const EMU_NAME = { retroarch: 'RetroArch', dolphin: 'Dolphin', duckstation: 'DuckStation', pcsx2: 'PCSX2', ppsspp: 'PPSSPP' };

// ---------- where each one keeps its settings ----------
function raCfg(exe) { const own = path.join(path.dirname(exe), 'retroarch.cfg'), roam = path.join(appData(), 'RetroArch', 'retroarch.cfg'); return isFile(own) ? own : isFile(roam) ? roam : own; } // (a fresh RetroArch makes its own beside the exe)
function dolphinDir(exe) { return emucfg.dolphinUserDirs(exe).find(d => isDir(path.join(d, 'Config'))) || null; }
function duckIni(exe) { const dir = path.dirname(exe); return firstFile([...(isFile(path.join(dir, 'portable.txt')) ? [path.join(dir, 'settings.ini')] : []), path.join(localAppData(), 'DuckStation', 'settings.ini'), ...emucfg.docsDirs().map(d => path.join(d, 'DuckStation', 'settings.ini'))]); }
function pcsx2Ini(exe) { return firstFile(emucfg.pcsx2Inis(exe)); }
function ppssppIni(exe) { const dir = path.dirname(exe); return firstFile([path.join(dir, 'memstick', 'PSP', 'SYSTEM', 'ppsspp.ini'), ...emucfg.docsDirs().map(d => path.join(d, 'PPSSPP', 'PSP', 'SYSTEM', 'ppsspp.ini'))]); }
// The settings file this emulator has (null: it hasn't been opened yet, so there's nothing to set up; RetroArch is the
// exception, it reads a file Boxshelf starts for it)
function mainFile(kind, exe) {
  if (kind === 'retroarch') return raCfg(exe);
  if (kind === 'dolphin') { const d = dolphinDir(exe); return d ? path.join(d, 'Config', 'Dolphin.ini') : null; }
  if (kind === 'duckstation') return duckIni(exe);
  if (kind === 'pcsx2') return pcsx2Ini(exe);
  if (kind === 'ppsspp') return ppssppIni(exe);
  return null;
}

// ---------- reading ----------
function readText(f) { try { return fs.readFileSync(f, 'utf8').replace(/^﻿/, ''); } catch { return ''; } }
function iniGet(text, section, key) {
  let sec = ''; for (const l of text.split(/\r?\n/)) { const m = /^\s*\[(.+)\]\s*$/.exec(l); if (m) { sec = m[1]; continue; } if (sec !== section) continue;
    const i = l.indexOf('='); if (i > 0 && l.slice(0, i).trim() === key) return l.slice(i + 1).trim(); }
  return null;
}
function iniSection(text, section) { const out = {}; let sec = ''; for (const l of text.split(/\r?\n/)) { const m = /^\s*\[(.+)\]\s*$/.exec(l); if (m) { sec = m[1]; continue; } if (sec !== section) continue; const i = l.indexOf('='); if (i > 0) out[l.slice(0, i).trim()] = l.slice(i + 1).trim(); } return out; }
function cfgGet(text, key) { const m = new RegExp('^\\s*' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=\\s*"([^"]*)"', 'm').exec(text); return m ? m[1] : null; }

// ---------- BIOS ----------
const BIOS_EXT = /\.(bin|rom|zip|img|bios)$/i;
const hasBiosFiles = d => { try { return fs.readdirSync(d).some(n => BIOS_EXT.test(n)); } catch { return false; } };
function sharedBiosDir() { return path.join(appRoot || path.dirname(dataDir || '.'), 'BIOS'); }
// the folder each emulator reads its BIOS files from right now
function biosDirOf(kind, exe) {
  try {
    if (kind === 'retroarch') { const v = cfgGet(readText(raCfg(exe)), 'system_directory'); return v && v !== 'default' ? v.replace(/^:[\\/]?/, path.dirname(exe) + path.sep) : path.join(path.dirname(exe), 'system'); }
    if (kind === 'duckstation') { const f = duckIni(exe); if (!f) return null; const v = iniGet(readText(f), 'BIOS', 'SearchDirectory') || 'bios'; return path.isAbsolute(v) ? v : path.join(path.dirname(f), v); }
    if (kind === 'pcsx2') { const f = pcsx2Ini(exe); if (!f) return null; const v = iniGet(readText(f), 'Folders', 'Bios') || 'bios'; return path.isAbsolute(v) ? v : path.join(path.dirname(path.dirname(f)), v); }
  } catch {}
  return null;
}
const PS2_BIOS = /^(scph|ps2|bios).*\.bin$/i;

// ---------- the plan: every change this would make, as { group, file, fmt, section?, key, value, note? } ----------
const SDL = { Up: 'DPadUp', Right: 'DPadRight', Down: 'DPadDown', Left: 'DPadLeft', Triangle: 'Y', Circle: 'B', Cross: 'A', Square: 'X', Select: 'Back', Start: 'Start',
  L1: 'LeftShoulder', R1: 'RightShoulder', L2: '+LeftTrigger', R2: '+RightTrigger', L3: 'LeftStick', R3: 'RightStick',
  LUp: '-LeftY', LDown: '+LeftY', LLeft: '-LeftX', LRight: '+LeftX', RUp: '-RightY', RDown: '+RightY', RLeft: '-RightX', RRight: '+RightX', LargeMotor: 'LargeMotor', SmallMotor: 'SmallMotor' };
// (no "Analog" button: the pad's Guide button is the Home menu's)
const sdlPad = type => Object.assign({ Type: type }, ...Object.entries(SDL).map(([k, v]) => ({ [k]: 'SDL-0/' + v })));
const padIsSet = sec => Object.entries(sec).some(([k, v]) => k !== 'Type' && /SDL-|XInput-|DInput-/i.test(v));
const DOLPHIN_PAD = { Device: 'XInput/0/Gamepad', 'Buttons/A': '`Button A`', 'Buttons/B': '`Button B`', 'Buttons/X': '`Button X`', 'Buttons/Y': '`Button Y`', 'Buttons/Z': '`Shoulder R`', 'Buttons/Start': '`Start`',
  'Main Stick/Up': '`Left Y+`', 'Main Stick/Down': '`Left Y-`', 'Main Stick/Left': '`Left X-`', 'Main Stick/Right': '`Left X+`',
  'C-Stick/Up': '`Right Y+`', 'C-Stick/Down': '`Right Y-`', 'C-Stick/Left': '`Right X-`', 'C-Stick/Right': '`Right X+`',
  'Triggers/L': '`Trigger L`', 'Triggers/R': '`Trigger R`', 'Triggers/L-Analog': '`Trigger L`', 'Triggers/R-Analog': '`Trigger R`',
  'D-Pad/Up': '`Pad N`', 'D-Pad/Down': '`Pad S`', 'D-Pad/Left': '`Pad W`', 'D-Pad/Right': '`Pad E`', 'Rumble/Motor': '`Motor L` | `Motor R`' };
const RES = { dolphin: { fast: '1', balanced: '2', pretty: '3' }, duckstation: { fast: '1', balanced: '2', pretty: '4' }, pcsx2: { fast: '1', balanced: '2', pretty: '3' }, ppsspp: { fast: '1', balanced: '2', pretty: '4' } };

function plan(kind, exe, opts = {}) {
  const out = [], skipped = [], add = (group, file, fmt, section, want, note) => { for (const [key, value] of Object.entries(want)) out.push({ group, file, fmt, section, key, value, note }); };
  const preset = ['fast', 'balanced', 'pretty'].includes(opts.graphics) ? opts.graphics : 'balanced';
  const bios = opts.biosDir || sharedBiosDir();
  const biosFree = d => !d || !hasBiosFiles(d);
  if (kind === 'retroarch') {
    const f = raCfg(exe);
    add('quit', f, 'cfg', null, { confirm_quit: 'false', quit_press_twice: 'false' });
    add('hotkeys', f, 'cfg', null, { input_save_state: 'f2', input_load_state: 'f4', input_screenshot: 'f8' });
    add('controller', f, 'cfg', null, { input_autodetect_enable: 'true' });
    if (biosFree(biosDirOf(kind, exe))) add('bios', f, 'cfg', null, { system_directory: bios }); else skipped.push({ group: 'bios', why: 'its system folder already has BIOS files' });
    add('resume', f, 'cfg', null, { savestate_auto_save: 'true', savestate_auto_load: 'true' });
  } else if (kind === 'dolphin') {
    const d = dolphinDir(exe); if (!d) return { ok: false, why: 'open Dolphin once first', changes: [] };
    const pad = path.join(d, 'Config', 'GCPadNew.ini'), cur = iniSection(readText(pad), 'GCPad1');
    if (!cur.Device || /keyboard/i.test(cur.Device)) { add('controller', pad, 'ini', 'GCPad1', DOLPHIN_PAD); add('controller', path.join(d, 'Config', 'Dolphin.ini'), 'ini', 'Core', { SIDevice0: '6' }); }
    else skipped.push({ group: 'controller', why: 'a controller is already mapped' });
    add('graphics', path.join(d, 'Config', 'GFX.ini'), 'ini', 'Settings', { InternalResolution: RES.dolphin[preset] });
  } else if (kind === 'duckstation') {
    const f = duckIni(exe); if (!f) return { ok: false, why: 'open DuckStation once first', changes: [] };
    const t = readText(f);
    add('quit', f, 'ini', 'Main', { ConfirmPowerOff: 'false' });
    add('hotkeys', f, 'ini', 'Hotkeys', { TogglePause: 'Keyboard/Space', SaveSelectedSaveState: 'Keyboard/F2', LoadSelectedSaveState: 'Keyboard/F1', Screenshot: 'Keyboard/F10' });
    if (!padIsSet(iniSection(t, 'Pad1'))) add('controller', f, 'ini', 'Pad1', sdlPad('AnalogController')); else skipped.push({ group: 'controller', why: 'a controller is already mapped' });
    if (biosFree(biosDirOf(kind, exe))) add('bios', f, 'ini', 'BIOS', { SearchDirectory: bios }); else skipped.push({ group: 'bios', why: 'its BIOS folder already has files' });
    add('graphics', f, 'ini', 'GPU', { ResolutionScale: RES.duckstation[preset] });
  } else if (kind === 'pcsx2') {
    const f = pcsx2Ini(exe); if (!f) return { ok: false, why: 'open PCSX2 once first', changes: [] };
    const t = readText(f);
    add('quit', f, 'ini', 'UI', { ConfirmShutdown: 'false' });
    add('hotkeys', f, 'ini', 'Hotkeys', { TogglePause: 'Keyboard/Space', SaveStateToSlot: 'Keyboard/F1', LoadStateFromSlot: 'Keyboard/F3', Screenshot: 'Keyboard/F8' });
    if (!padIsSet(iniSection(t, 'Pad1'))) add('controller', f, 'ini', 'Pad1', sdlPad('DualShock2')); else skipped.push({ group: 'controller', why: 'a controller is already mapped' });
    // PCSX2 needs one BIOS file chosen, not only a folder: only when the shared folder has a PS2 BIOS in it
    const cur = biosDirOf(kind, exe); let ps2 = null; try { ps2 = fs.readdirSync(bios).find(n => PS2_BIOS.test(n)); } catch {}
    if (!biosFree(cur)) skipped.push({ group: 'bios', why: 'its BIOS folder already has files' });
    else if (!ps2) skipped.push({ group: 'bios', why: 'no PS2 BIOS in the BIOS folder yet' });
    else { add('bios', f, 'ini', 'Folders', { Bios: bios }); add('bios', f, 'ini', 'Filenames', { BIOS: ps2 }); }
    add('graphics', f, 'ini', 'EmuCore/GS', { upscale_multiplier: RES.pcsx2[preset] });
  } else if (kind === 'ppsspp') {
    const f = ppssppIni(exe); if (!f) return { ok: false, why: 'open PPSSPP once first', changes: [] };
    add('graphics', f, 'ini', 'Graphics', { InternalResolution: RES.ppsspp[preset] });
  } else return { ok: false, why: 'not one Boxshelf can set up yet', changes: [] };
  return { ok: true, changes: out, skipped, groups: [...new Set(out.map(c => c.group))] };
}

// ---------- writing ----------
// RetroArch's retroarch.cfg: `key = "value"` lines, no sections. Same safety as emucfg's ini writer.
function setCfg(f, want) {
  let buf = null; try { buf = fs.readFileSync(f); } catch (e) { if (e.code !== 'ENOENT') { log('RetroArch config could not be read, left alone:', e.code || e.message); return false; } }
  if (buf && buf.includes(0)) return false;
  if (buf && !Buffer.from(buf.toString('utf8'), 'utf8').equals(buf)) { log('RetroArch config is not UTF-8 text (an ANSI path?), left alone:', f); return false; } // (beta.10: written back, those bytes would have become U+FFFD)
  const src = buf ? buf.toString('utf8') : '', nl = src.includes('\r\n') ? '\r\n' : '\n', lines = src ? src.split(/\r?\n/) : [], seen = new Set(); let changed = false;
  for (let i = 0; i < lines.length; i++) { const m = /^\s*([A-Za-z0-9_]+)\s*=/.exec(lines[i]); if (!m || want[m[1]] === undefined) continue; seen.add(m[1]); const v = `${m[1]} = "${want[m[1]]}"`; if (lines[i] !== v) { lines[i] = v; changed = true; } }
  for (const k of Object.keys(want)) if (!seen.has(k)) { if (lines.length && lines[lines.length - 1] === '') lines.pop(); lines.push(`${k} = "${want[k]}"`); changed = true; }
  if (!changed) return false;
  if (buf) { const bak = f + '.boxshelf-bak'; if (!fs.existsSync(bak)) fs.copyFileSync(f, bak); }
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp'; try { fs.writeFileSync(tmp, lines.join(nl) + nl); fs.renameSync(tmp, f); } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
  return true;
}

const manifestFile = () => path.join(dataDir, 'emu-setup.json');
function manifest() { try { const m = JSON.parse(fs.readFileSync(manifestFile(), 'utf8')); return m && typeof m === 'object' ? m : {}; } catch { return {}; } }
function saveManifest(m) { try { const f = manifestFile(), tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(m, null, 1)); fs.renameSync(tmp, f); } catch (e) { log('Emulator setup: could not save its list', e.message); } }
const keyOf = (kind, exe) => kind + '|' + path.resolve(exe).toLowerCase();

// Applies the switched-on groups. on: { controller: true, ... } (missing = the default). Returns { ok, applied, skipped, files }.
function apply(exe, on = {}, opts = {}) {
  const kind = kindOf(exe); if (!kind) return { ok: false, why: 'not one Boxshelf can set up yet' };
  if (!isFile(exe)) return { ok: false, why: 'the emulator isn\'t there any more' };
  const p = plan(kind, exe, opts); if (!p.ok) return p;
  const want = g => on[g] !== undefined ? !!on[g] : DEFAULT_ON[g];
  const use = p.changes.filter(c => want(c.group));
  if (opts.biosDir !== '' && use.some(c => c.group === 'bios')) { try { fs.mkdirSync(opts.biosDir || sharedBiosDir(), { recursive: true }); } catch {} }
  const byFile = new Map(); for (const c of use) { const k = c.file + '\0' + (c.section || ''); if (!byFile.has(k)) byFile.set(k, { file: c.file, fmt: c.fmt, section: c.section, want: {} }); byFile.get(k).want[c.key] = c.value; }
  const m = manifest(), key = keyOf(kind, exe), rec = m[key] || { kind, exe, files: [], created: [], groups: [] };
  const done = [];
  for (const { file, fmt, section, want: w } of byFile.values()) {
    const existed = isFile(file);
    try {
      const changed = fmt === 'cfg' ? setCfg(file, w) : emucfg.setIni(file, section, w, EMU_NAME[kind] + ' setup:');
      if (changed) { if (!rec.files.includes(file)) rec.files.push(file); if (!existed && !rec.created.includes(file)) rec.created.push(file); done.push(file); }
    } catch (e) { log(EMU_NAME[kind], 'setup: could not write', file, e.message); return { ok: false, why: `couldn't write ${path.basename(file)} (${e.code || e.message})`, applied: [] }; }
  }
  const groups = [...new Set(use.map(c => c.group))];
  rec.groups = [...new Set([...rec.groups, ...groups])]; rec.at = Date.now(); m[key] = rec; saveManifest(m);
  log(EMU_NAME[kind], 'set up:', groups.join(', ') || 'nothing to change', done.length ? '(' + done.map(f => path.basename(f)).join(', ') + ')' : '');
  return { ok: true, kind, applied: groups, skipped: p.skipped.filter(s => want(s.group)), files: done };
}

// Puts back every file this set up changed (its pre-Boxshelf copy), and removes files it started from nothing.
function undo(exe) {
  const kind = kindOf(exe); const m = manifest(), key = kind && keyOf(kind, exe), rec = key && m[key]; if (!rec) return { ok: true, restored: [] };
  const restored = [];
  for (const f of rec.files) {
    try {
      if (rec.created.includes(f)) { if (isFile(f)) fs.unlinkSync(f); restored.push(f); continue; }
      const bak = f + '.boxshelf-bak'; if (!isFile(bak)) continue;
      const tmp = f + '.tmp'; fs.copyFileSync(bak, tmp); fs.renameSync(tmp, f); fs.unlinkSync(bak); restored.push(f);
    } catch (e) { log('Emulator setup undo:', f, e.message); }
  }
  delete m[key]; saveManifest(m); log(EMU_NAME[kind], 'setup undone:', restored.length, 'file(s) put back');
  return { ok: true, restored };
}

// What the Settings page shows for one emulator
function status(exe) {
  const kind = kindOf(exe); if (!kind) return { supported: false };
  const f = mainFile(kind, exe), rec = manifest()[keyOf(kind, exe)] || null;
  // "used": its settings file is older than two days, so someone has set it up before (the first run leaves those alone)
  let used = false; try { used = !!f && isFile(f) && Date.now() - fs.statSync(f).mtimeMs > 2 * 864e5 && !rec; } catch {}
  const p = plan(kind, exe, {});
  return { supported: true, kind, name: EMU_NAME[kind], ready: kind === 'retroarch' || !!f, file: f, used, done: rec ? { at: rec.at, groups: rec.groups } : null,
    groups: p.groups || [], skipped: p.skipped || [], biosDir: biosDirOf(kind, exe) };
}
// The graphics preset for this PC from its graphics card (the vendor of the GPU Chromium uses)
function presetFor(gpu) {
  const d = gpu && gpu.gpuDevice && (gpu.gpuDevice.find(x => x.active) || gpu.gpuDevice[0]); const v = d && d.vendorId;
  return v === 0x10de ? 'pretty' : v === 0x1002 ? 'balanced' : 'fast'; // NVIDIA / AMD / Intel and the rest
}

module.exports = { init, kindOf, plan, apply, undo, status, presetFor, sharedBiosDir, biosDirOf, mainFile, GROUPS, GROUP_NAME, DEFAULT_ON, EMU_NAME, setCfg };
