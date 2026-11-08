// Emulator settings: small, safe tweaks so the controller quit combo closes them without a dialog (only run right before
// a launch: the emulator rewrites its config when it exits, keeping what we set), putting the user's own files back
// (Settings → Restore emulator settings), the real Xenia exe behind Xenia Manager, and where each emulator keeps its
// settings (shared with raemu's RetroAchievements check).
const fs = require('fs');
const path = require('path');
const os = require('os');

let log = () => {};
function init(logger) { if (logger) log = logger; }

// Eden / yuzu: "Are you sure you want to stop the emulation?" when the window is asked to close.
// qt-config.ini lives in user\config next to the exe (portable) or in %APPDATA%\<name>\config. The forks each keep
// their own folder: the one named like the exe is looked at first, so Citron doesn't get (only) Eden's file tweaked.
const EDEN_FORKS = ['eden', 'yuzu', 'citron', 'sudachi', 'suyu'], EDEN_RE = /eden|yuzu|sudachi|citron|suyu|eglantine/i; // (Eglantine, the Switch 2 fork, keeps Eden's own settings folder)
function edenInis(exe) {
  const c = [path.join(path.dirname(exe || ''), 'user', 'config', 'qt-config.ini')], n0 = path.basename(exe || '').toLowerCase();
  const names = [...EDEN_FORKS.filter(n => n0.includes(n)), ...EDEN_FORKS.filter(n => !n0.includes(n))];
  if (process.env.APPDATA) for (const n of names) c.push(path.join(process.env.APPDATA, n, 'config', 'qt-config.ini'));
  return c;
}
function edenIni(exe) {
  return edenInis(exe).find(f => { try { return fs.statSync(f).isFile(); } catch { return false; } }) || null;
}
// Read an ini for editing: { src, bom, isNew }, or null when it must be left alone. Only ENOENT means "no file yet": a
// locked or cloud-only file read as empty would be overwritten with our one key. UTF-16 / binary files are never touched.
function readIni(f, label, readOnly) { // readOnly (beta.10): only looked at, never written back (bytes that aren't UTF-8 are fine then)
  let buf; try { buf = fs.readFileSync(f); } catch (e) { if (e.code === 'ENOENT') return { src: '', bom: '', isNew: true }; log(label || 'Config', 'could not read', f, '(' + (e.code || e.message) + '), left alone'); return null; }
  if (buf.length >= 2 && ((buf[0] === 0xFF && buf[1] === 0xFE) || (buf[0] === 0xFE && buf[1] === 0xFF))) { log(label || 'Config', f, 'is UTF-16, left alone'); return null; }
  if (buf.includes(0)) { log(label || 'Config', f, 'has NUL bytes (not a text ini), left alone'); return null; }
  let src = buf.toString('utf8'), bom = '';
  // (beta.10) not UTF-8 (an ANSI accented path, "C:\Jeux\Éditions"): decoded, those bytes became U+FFFD and writing the file
  // back would have broken the emulator's own setting
  if (!readOnly && !Buffer.from(src, 'utf8').equals(buf)) { log(label || 'Config', f, 'is not UTF-8 text, left alone'); return null; }
  if (src.charCodeAt(0) === 0xFEFF) { bom = '\uFEFF'; src = src.slice(1); } // kept aside so section matching sees "[UI]", put back on write
  return { src, bom, isNew: false };
}
// One-time backup of the user's own file (never refreshed, so it stays the pre-Boxshelf version), then temp + rename:
// never a half-written config. No backup -> no write.
function writeIni(f, text, ini) {
  if (!ini.isNew) { const bak = f + '.boxshelf-bak'; if (!fs.existsSync(bak)) fs.copyFileSync(f, bak); }
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp'; try { fs.writeFileSync(tmp, ini.bom + text); fs.renameSync(tmp, f); } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
}
function quietEden(exe) {
  const f = edenIni(exe); if (!f) return false;
  try {
    const ini = readIni(f, 'Eden:'); if (!ini || ini.isNew) return false; const src = ini.src;
    const want = { 'confirmClose': 'false', 'confirmClose\\default': 'false', 'confirmStop': '2', 'confirmStop\\default': 'false' };
    const lines = src.split(/\r?\n/); const nl = src.includes('\r\n') ? '\r\n' : '\n';
    let sec = '', uiAt = -1, changed = false; const seen = new Set();
    for (let i = 0; i < lines.length; i++) {
      const m = /^\[(.+)\]\s*$/.exec(lines[i]); if (m) { sec = m[1]; if (sec === 'UI') uiAt = i; continue; }
      if (sec !== 'UI') continue;
      const k = lines[i].split('=')[0].trim();
      if (want[k] !== undefined) { seen.add(k); const v = `${k}=${want[k]}`; if (lines[i] !== v) { lines[i] = v; changed = true; } }
    }
    const missing = Object.keys(want).filter(k => !seen.has(k)).map(k => `${k}=${want[k]}`);
    if (missing.length) { changed = true; if (uiAt < 0) lines.push('[UI]', ...missing); else lines.splice(uiAt + 1, 0, ...missing); }
    if (changed) { writeIni(f, lines.join(nl), ini); log('Eden: close confirmations turned off in', f); }
    return true;
  } catch (e) { log('Eden config tweak failed', e.message); return false; }
}

// Xenia Manager is a launcher around Xenia: it can't take a game on its command line. When it (or any
// non-Xenia exe in a Xenia folder) is selected, find the real emulator next to it: Canary first.
function findXenia(exe) {
  const roots = [path.dirname(exe), path.join(path.dirname(exe), 'Emulators')];
  const prefer = ['xenia_canary.exe', 'xenia.exe', 'xenia_canary_mousehook.exe', 'xenia_canary_netplay.exe'];
  const found = [];
  const walk = (d, depth) => { let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) { const f = path.join(d, e.name); if (e.isDirectory()) { if (depth > 0 && !/^(cache|content|patches|config|logs?)/i.test(e.name)) walk(f, depth - 1); } else if (/^xenia.*\.exe$/i.test(e.name) && !/manager/i.test(e.name)) found.push(f); } };
  for (const r of roots) walk(r, 2);
  found.sort((a, b) => { const ia = prefer.indexOf(path.basename(a).toLowerCase()), ib = prefer.indexOf(path.basename(b).toLowerCase()); return (ia < 0 ? 9 : ia) - (ib < 0 ? 9 : ib); });
  return found[0] || null;
}
// The exe to actually run for a system (may differ from the configured one); returns { exe, changed }
function resolveExe(systemId, exe) {
  try {
    if (systemId === 'x360' && exe && !/^xenia(_canary)?(_mousehook|_netplay)?\.exe$/i.test(path.basename(exe))) {
      const real = findXenia(exe); if (real) { log('Xenia: running', real, 'instead of', path.basename(exe)); return { exe: real, changed: true }; }
    }
  } catch {}
  return { exe, changed: false };
}
// Set keys in one [section] of an ini (Dolphin style "Key = Value"); one-time backup, atomic write. Returns true if changed.
function setIni(f, section, want, label) {
  const ini = readIni(f, label); if (!ini) return false; const src = ini.src;
  const nl = src.includes('\r\n') ? '\r\n' : '\n', lines = src ? src.split(/\r?\n/) : [];
  let sec = '', at = -1, changed = false; const seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    const m = /^\[(.+)\]\s*$/.exec(lines[i]); if (m) { sec = m[1]; if (sec === section) at = i; continue; }
    if (sec !== section) continue;
    const k = lines[i].split('=')[0].trim();
    if (want[k] !== undefined) { seen.add(k); if (lines[i].split('=').slice(1).join('=').trim() !== want[k]) { lines[i] = `${k} = ${want[k]}`; changed = true; } }
  }
  const missing = Object.keys(want).filter(k => !seen.has(k)).map(k => `${k} = ${want[k]}`);
  if (missing.length) { changed = true; if (at < 0) { if (lines.length && lines[lines.length - 1] !== '') lines.push(''); lines.push(`[${section}]`, ...missing); } else lines.splice(at + 1, 0, ...missing); }
  if (!changed) return false;
  writeIni(f, lines.join(nl) + (lines[lines.length - 1] === '' ? '' : nl), ini);
  log(label || 'Config', 'updated', f, JSON.stringify(want)); return true;
}
// The user's Documents folder(s): the usual one, and the OneDrive one Windows moves it to when OneDrive backs it up.
// env: for tests (raemu passes its own)
function docsDirs(env = process.env) { const home = env.USERPROFILE || os.homedir(); return [path.join(home, 'Documents'), path.join(home, 'OneDrive', 'Documents')]; }
// Dolphin's user folder, the way Dolphin itself picks it: portable.txt next to the exe, else Documents\Dolphin Emulator
// if it already exists (older installs), else %APPDATA%\Dolphin Emulator
function dolphinUserDirs(exe, env = process.env) {
  const dir = path.dirname(exe || '');
  if (exe && fs.existsSync(path.join(dir, 'portable.txt'))) return [path.join(dir, 'User')];
  const appdata = env.APPDATA || path.join(env.USERPROFILE || os.homedir(), 'AppData', 'Roaming');
  return [...docsDirs(env).map(d => path.join(d, 'Dolphin Emulator')), path.join(appdata, 'Dolphin Emulator')];
}
// PCSX2 asks "Are you sure you want to shut down the virtual machine?" when its window is closed: Quit then waited
// behind that dialog until the 2.5 s force-close. inis\PCSX2.ini is next to the exe (portable: only there) or in
// Documents\PCSX2. every: the Documents ones too even when portable (restoring backups made before it was).
function pcsx2Inis(exe, env = process.env, every = false) {
  const dir = path.dirname(exe || ''), c = [];
  if (exe && ['portable.ini', 'portable.txt'].some(f => fs.existsSync(path.join(dir, f)))) { c.push(path.join(dir, 'inis', 'PCSX2.ini')); if (!every) return c; }
  for (const d of docsDirs(env)) c.push(path.join(d, 'PCSX2', 'inis', 'PCSX2.ini'));
  return c;
}
function pcsx2Ini(exe) {
  return pcsx2Inis(exe).find(f => { try { return fs.statSync(f).isFile(); } catch { return false; } }) || null;
}
function pcsx2NoConfirm(exe) {
  const f = pcsx2Ini(exe); if (!f) { log('PCSX2: settings file not found'); return false; }
  try { setIni(f, 'UI', { ConfirmShutdown: 'false' }, 'PCSX2: no "shut down?" question (so Quit closes it cleanly)'); return true; }
  catch (e) { log('PCSX2 config tweak failed', e.message); return false; }
}
// RPCS3: "Exit game?" box when its window is closed (GuiConfigs\CurrentSettings.ini, key=value style)
const rpcs3Ini = exe => path.join(path.dirname(exe || ''), 'GuiConfigs', 'CurrentSettings.ini');
function rpcs3NoConfirm(exe) {
  const f = rpcs3Ini(exe); if (!fs.existsSync(f)) return false;
  try {
    const ini = readIni(f, 'RPCS3:'); if (!ini || ini.isNew) return false; const src = ini.src; let changed = false; const nl = src.includes('\r\n') ? '\r\n' : '\n';
    const lines = src.split(/\r?\n/); let sec = '', at = -1, seen = false;
    for (let i = 0; i < lines.length; i++) { const m = /^\[(.+)\]\s*$/.exec(lines[i]); if (m) { sec = m[1]; if (sec === 'Meta') at = i; continue; }
      if (sec === 'Meta' && /^confirmationBoxExitGame\s*=/.test(lines[i])) { seen = true; if (lines[i] !== 'confirmationBoxExitGame=false') { lines[i] = 'confirmationBoxExitGame=false'; changed = true; } } }
    if (!seen) { changed = true; if (at < 0) lines.push('[Meta]', 'confirmationBoxExitGame=false'); else lines.splice(at + 1, 0, 'confirmationBoxExitGame=false'); }
    if (!changed) return true;
    writeIni(f, lines.join(nl), ini); log('RPCS3: exit confirmation turned off in', f); return true;
  } catch (e) { log('RPCS3 config tweak failed', e.message); return false; }
}
// Dolphin's Stop hotkey listens to one device (its "Hotkeys" controller, usually the Xbox pad). A Wii game played with
// another controller (a Switch Pro for its gyro, set up as Wii Remote 1) then had no way back to the shelf: Boxshelf's
// own quit combo only hears Xbox-style (XInput) pads. So the quit combo is added to Dolphin's Stop for every other
// controller its Wii Remote / GameCube settings use, as fully named inputs (`Device:Input`). Only ever added to.
const DOLPHIN_COMBO = { 'l3+r3': ['Thumb L', 'Thumb R'], 'start+back': ['Start', 'Back'], 'lb+rb+start': ['Shoulder L', 'Shoulder R', 'Start'], 'back+b': ['Back', 'Button E'] };
function dolphinQuitPads(exe, combo) {
  const inputs = DOLPHIN_COMBO[combo]; if (!inputs) return false;
  const dirs = dolphinUserDirs(exe).filter(d => fs.existsSync(path.join(d, 'Config')));
  const pick = dirs.find(d => fs.existsSync(path.join(d, 'Config', 'WiimoteNew.ini')) || fs.existsSync(path.join(d, 'Config', 'GCPadNew.ini'))); if (!pick) return false;
  // no Hotkeys.ini yet (hotkeys never changed in Dolphin): left alone. Dolphin only uses its default hotkeys while the file
  // is missing; a new one holding just Stop would blank all the others (F10 pause, Shift+F1 save… the Home menu's keys)
  const cfgDir = path.join(pick, 'Config'), hot = readIni(path.join(cfgDir, 'Hotkeys.ini'), 'Dolphin'); if (!hot || hot.isNew) return false;
  const hotDev = (/^\s*Device\s*=\s*(.+?)\s*$/m.exec(hot.src) || [])[1] || '';
  const stop = (/^\s*General\/Stop\s*=\s*(.*?)\s*$/m.exec(hot.src) || [])[1] || '';
  const devs = new Set();
  for (const n of ['WiimoteNew.ini', 'GCPadNew.ini']) { const ini = readIni(path.join(cfgDir, n), 'Dolphin', true); if (!ini) continue; for (const m of ini.src.matchAll(/^\s*Device\s*=\s*(.+?)\s*$/gm)) devs.add(m[1]); }
  const padOk = d => d && d !== hotDev && !/keyboard|mouse|^Android|^Bluetooth|^XInput2?\//i.test(d) && !d.includes('`');
  // Dolphin names the east face button per backend: SDL "Button E", XInput / Windows.Gaming.Input "Button B"
  const name = (d, i) => i === 'Button E' && !/^SDL\//i.test(d) ? 'Button B' : i;
  // (beta.10) Boxshelf's own terms ("(`<pad>:<input>`&…)": one such pad, exactly one quit combo's inputs) are rebuilt on every
  // apply: a pad already there was skipped before, so a changed combo never reached it. The user's own terms stay as they are
  const terms = s => { const out = []; let d = 0, q = false, cur = ''; for (const ch of s) { if (ch === '`') q = !q; else if (!q && ch === '(') d++; else if (!q && ch === ')') d--; if (!q && !d && ch === '|') { out.push(cur.trim()); cur = ''; } else cur += ch; } if (cur.trim()) out.push(cur.trim()); return out.filter(Boolean); };
  const isOwn = t => { const m = /^\(((?:`[^`]+`&)*`[^`]+`)\)$/.exec(t); if (!m) return false; const ins = m[1].split('&').map(x => x.slice(1, -1)), at = ins[0].lastIndexOf(':'), dev = at > 0 ? ins[0].slice(0, at) : '';
    if (!padOk(dev) || !ins.every(x => x.startsWith(dev + ':'))) return false; const got = ins.map(x => x.slice(dev.length + 1)).join('&');
    return Object.values(DOLPHIN_COMBO).some(l => l.map(i => name(dev, i)).join('&') === got); };
  const wrapped = b => { if (b[0] !== '(') return false; let d = 0, q = false; for (let i = 0; i < b.length; i++) { const c = b[i]; if (c === '`') q = !q; else if (!q && c === '(') d++; else if (!q && c === ')' && --d === 0) return i === b.length - 1; } return false; };
  // (beta.10) the main pad's term Boxshelf writes when Stop was empty ("(`Back`&`Button B`)": no device, exactly one quit combo's
  // inputs as the Hotkeys device names them) is its own too when it's the only other term beside its pad terms: kept as the
  // user's, a changed combo never reached the main pad and the old one still stopped the game
  const isBase = t => { const m = /^\(((?:`[^`]+`&)*`[^`]+`)\)$/.exec(t); if (!m) return false; const ins = m[1].split('&').map(x => x.slice(1, -1)); if (ins.some(x => x.includes(':'))) return false;
    return Object.values(DOLPHIN_COMBO).some(l => l.map(i => name(hotDev, i)).join('&') === ins.join('&')); };
  const all = terms(stop), mine = all.filter(isOwn), rest = all.filter(t => !isOwn(t)), user = mine.length && rest.length === 1 && isBase(rest[0]) ? [] : rest;
  const extra = [...devs].filter(padOk);
  if (!extra.length && !mine.length) return false;
  const parts = extra.map(d => inputs.map(i => '`' + d + ':' + name(d, i) + '`').join('&'));
  const base = user.length > 1 ? '(' + user.join(' | ') + ')' : user[0] || inputs.map(i => '`' + name(hotDev, i) + '`').join('&');
  const next = [(base.includes('|') || base.includes('&')) && !wrapped(base) ? '(' + base + ')' : base, ...parts.map(p => '(' + p + ')')].join(' | ');
  setIni(path.join(cfgDir, 'Hotkeys.ini'), 'Hotkeys', { 'General/Stop': next }, 'Dolphin: quit combo also stops the game from ' + extra.join(', '));
  return true;
}
function beforeLaunch(systemId, exe, opts = {}) {
  // (Linux: these tweaks look for the emulators' Windows settings folders, next to the program or in %APPDATA%; beside a
  // Flatpak launcher or in /usr/bin that would only make stray folders. Skipped there for now.)
  if (process.platform === 'linux') return;
  try { if ((systemId === 'gc' || systemId === 'wii') && /dolphin/i.test(path.basename(exe || '')) && opts.quitCombo) dolphinQuitPads(exe, opts.quitCombo); } catch (e) { log('Dolphin quit combo tweak failed', e.message); }
  // (Switch 2: every build is an Eden fork, whatever it calls its program: lichii.exe, orchid.exe…)
  try { if ((systemId === 'sw' && EDEN_RE.test(path.basename(exe || ''))) || systemId === 'sw2') quietEden(exe); } catch {}
  // Dolphin: nothing written any more, launchArgs() passes the same two settings for this session only
  try { if (/pcsx2/i.test(path.basename(exe || ''))) pcsx2NoConfirm(exe); } catch {}
  try { if (/rpcs3/i.test(path.basename(exe || ''))) rpcs3NoConfirm(exe); } catch {}
}
const isDolphin = (systemId, exe) => (systemId === 'gc' || systemId === 'wii') && /dolphin/i.test(path.basename(exe || ''));
// Extra command-line args for this launch. Dolphin takes any setting as -C System.Section.Key=Value for the session only,
// so its ini files stay as the user left them (no "stop emulation?" question, borderless so the Home menu can show).
// The other emulators have no such switch and keep the ini tweak in beforeLaunch.
function launchArgs(systemId, exe) {
  return isDolphin(systemId, exe) ? ['-C', 'Dolphin.Interface.ConfirmStop=False', '-C', 'Graphics.Settings.BorderlessFullscreen=True'] : [];
}
// Put back every .boxshelf-bak this module made (the user's file from before the first tweak) and drop the backup, so a
// later tweak backs up the file as it is then. exeBySystem: { gc: exe, ps2: exe, ... } (or { gc: { emulator } }).
// Looks in the same places the tweaks use; returns the files restored.
function restoreBackups(exeBySystem) {
  const files = new Set();
  for (const [sys, v] of Object.entries(exeBySystem || {})) {
    const exe = typeof v === 'string' ? v : v && v.emulator; if (!exe) continue; const name = path.basename(exe);
    if (sys === 'gc' || sys === 'wii' || /dolphin/i.test(name)) for (const d of dolphinUserDirs(exe)) for (const n of ['GFX.ini', 'Dolphin.ini', 'Hotkeys.ini']) files.add(path.join(d, 'Config', n)); // Hotkeys.ini: the quit combo for every pad (GFX / Dolphin.ini: backups from older versions, which tweaked those)
    if (sys === 'sw' || sys === 'sw2' || EDEN_RE.test(name)) edenInis(exe).forEach(f => files.add(f));
    if (/pcsx2/i.test(name)) pcsx2Inis(exe, process.env, true).forEach(f => files.add(f));
    if (/rpcs3/i.test(name)) files.add(rpcs3Ini(exe));
  }
  const done = [];
  for (const f of files) {
    const bak = f + '.boxshelf-bak'; if (!fs.existsSync(bak)) continue;
    const tmp = f + '.tmp';
    try { fs.copyFileSync(bak, tmp); fs.renameSync(tmp, f); fs.unlinkSync(bak); done.push(f); log('Settings restored from', bak); }
    catch (e) { try { fs.unlinkSync(tmp); } catch {} log('Could not restore', f, e.message); }
  }
  return done;
}

module.exports = { init, beforeLaunch, dolphinQuitPads, launchArgs, restoreBackups, quietEden, resolveExe, findXenia, setIni, pcsx2NoConfirm, rpcs3NoConfirm, dolphinUserDirs, pcsx2Inis, docsDirs };
