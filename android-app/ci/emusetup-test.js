// (beta.7) "Set up for me" (main/emusetup.js) on pretend emulator folders: what it writes, what it leaves alone, Undo.
// node ci/emusetup-test.js   (no Electron needed; Windows-style layouts are made in a temp folder on any OS)
const fs = require('fs'), path = require('path'), os = require('os');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-emusetup-'));
process.env.APPDATA = path.join(root, 'Roaming'); process.env.LOCALAPPDATA = path.join(root, 'Local'); process.env.USERPROFILE = path.join(root, 'home');
const S = require('../../main/emusetup');
const data = path.join(root, 'data'); fs.mkdirSync(data, { recursive: true });
S.init({ dataDir: data, appRoot: root, log: () => {} });
let fails = 0; const ok = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m); if (!c) fails++; };
const put = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); return f; };
const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };

// RetroArch: a fresh one (no retroarch.cfg yet): the file is started; Undo removes it again
const ra = put(path.join(root, 'RetroArch', 'retroarch.exe'), 'x');
let r = S.apply(ra, {}, { graphics: 'balanced' });
const raCfg = path.join(root, 'RetroArch', 'retroarch.cfg'), t1 = read(raCfg) || '';
ok(r.ok && /confirm_quit = "false"/.test(t1) && /quit_press_twice = "false"/.test(t1), 'RetroArch: no quit question (both key names)');
ok(/input_save_state = "f2"/.test(t1) && /input_load_state = "f4"/.test(t1), 'RetroArch: Home menu save / load keys');
ok(new RegExp('system_directory = "' + path.join(root, 'BIOS').replace(/\\/g, '\\\\') + '"').test(t1) && fs.existsSync(path.join(root, 'BIOS')), 'RetroArch: shared BIOS folder made and used (its own system folder was empty)');
ok(!/savestate_auto_save/.test(t1), 'RetroArch: "resume where you left off" stays off unless chosen');
r = S.apply(ra, { resume: true }); ok(/savestate_auto_load = "true"/.test(read(raCfg)), 'RetroArch: resume when switched on');
ok(S.status(ra).done && S.status(ra).done.groups.includes('resume'), 'status remembers what was set up');
S.undo(ra); ok(!fs.existsSync(raCfg) && !S.status(ra).done, 'RetroArch Undo: the file Boxshelf started is gone again');

// RetroArch with its own settings and BIOS files: the user's lines stay, the BIOS folder isn't moved
const ra2 = put(path.join(root, 'RA2', 'retroarch.exe'), 'x'); const cfg2 = put(path.join(root, 'RA2', 'retroarch.cfg'), 'video_driver = "vulkan"\r\nconfirm_quit = "true"\r\n');
put(path.join(root, 'RA2', 'system', 'scph5501.bin'), 'bios');
r = S.apply(ra2, {}); const t2 = read(cfg2);
ok(/video_driver = "vulkan"/.test(t2) && /confirm_quit = "false"/.test(t2) && t2.includes('\r\n'), 'RetroArch: your other settings and line endings kept');
ok(!/system_directory/.test(t2) && r.skipped.some(s => s.group === 'bios'), 'RetroArch: a system folder with BIOS files in it is left as it is');
S.undo(ra2); ok(read(cfg2) === 'video_driver = "vulkan"\r\nconfirm_quit = "true"\r\n' && !fs.existsSync(cfg2 + '.boxshelf-bak'), 'RetroArch Undo: your file back exactly');

// DuckStation, portable, keyboard-only: pad mapped, hotkeys, graphics; a second run changes nothing
const duck = put(path.join(root, 'Duck', 'duckstation-qt-x64-ReleaseLTCG.exe'), 'x'); put(path.join(root, 'Duck', 'portable.txt'), '');
const duckIni = put(path.join(root, 'Duck', 'settings.ini'), '[Main]\nConfirmPowerOff = true\n\n[Pad1]\nType = AnalogController\nCross = Keyboard/X\n');
r = S.apply(duck, {}, { graphics: 'pretty' }); let d = read(duckIni);
ok(/ConfirmPowerOff = false/.test(d) && /Cross = SDL-0\/A/.test(d) && /L2 = SDL-0\/\+LeftTrigger/.test(d) && !/Analog = /.test(d), 'DuckStation: pad 1 mapped (no Analog on the Home button)');
ok(/SaveSelectedSaveState = Keyboard\/F2/.test(d) && /LoadSelectedSaveState = Keyboard\/F1/.test(d) && /ResolutionScale = 4/.test(d), 'DuckStation: Home menu keys and the Pretty preset');
const before = read(duckIni); S.apply(duck, {}, { graphics: 'pretty' }); ok(read(duckIni) === before, 'DuckStation: setting up again changes nothing');
S.undo(duck);
// a pad you mapped yourself is kept
put(duckIni, '[Pad1]\nType = AnalogController\nCross = SDL-0/B\n');
r = S.apply(duck, { graphics: false }); ok(/Cross = SDL-0\/B/.test(read(duckIni)) && r.skipped.some(s => s.group === 'controller'), 'DuckStation: your own controller mapping is kept');
ok(!/ResolutionScale/.test(read(duckIni)), 'a switched-off group (Graphics) is not touched');
S.undo(duck);

// PCSX2 (portable): BIOS only once a PS2 BIOS is in the shared folder; the BIOS file is chosen too
const pcsx2 = put(path.join(root, 'PCSX2', 'pcsx2-qt.exe'), 'x'); put(path.join(root, 'PCSX2', 'portable.ini'), '');
const pIni = put(path.join(root, 'PCSX2', 'inis', 'PCSX2.ini'), '[UI]\nConfirmShutdown = true\n');
r = S.apply(pcsx2, {}); ok(!/\[Folders\]/.test(read(pIni)) && r.skipped.some(s => s.group === 'bios' && /no PS2 BIOS/.test(s.why)), 'PCSX2: no BIOS folder change without a PS2 BIOS to use');
ok(/ConfirmShutdown = false/.test(read(pIni)) && /SaveStateToSlot = Keyboard\/F1/.test(read(pIni)) && /Type = DualShock2/.test(read(pIni)), 'PCSX2: quit, hotkeys, pad');
put(path.join(root, 'BIOS', 'SCPH-70012_BIOS_V12_USA_200.BIN'), 'b');
put(path.join(root, 'BIOS', 'scph70012.bin'), 'b');
r = S.apply(pcsx2, {}); ok(/\[Folders\][\s\S]*Bios = /.test(read(pIni)) && /\[Filenames\][\s\S]*BIOS = scph/i.test(read(pIni)), 'PCSX2: BIOS folder and file set once one is there');
S.undo(pcsx2); ok(read(pIni) === '[UI]\nConfirmShutdown = true\n', 'PCSX2 Undo: file back as it was');

// Not opened yet / not supported
const dol = put(path.join(root, 'Dolphin', 'Dolphin.exe'), 'x'); put(path.join(root, 'Dolphin', 'portable.txt'), '');
ok(!S.apply(dol, {}).ok && /once/.test(S.apply(dol, {}).why), 'Dolphin not opened yet: says to open it once');
put(path.join(root, 'Dolphin', 'User', 'Config', 'Dolphin.ini'), '[Core]\n');
r = S.apply(dol, {}, { graphics: 'fast' }); const pad = read(path.join(root, 'Dolphin', 'User', 'Config', 'GCPadNew.ini')) || '';
ok(r.ok && /\[GCPad1\]/.test(pad) && /Device = XInput\/0\/Gamepad/.test(pad) && /InternalResolution = 1/.test(read(path.join(root, 'Dolphin', 'User', 'Config', 'GFX.ini')) || ''), 'Dolphin: GameCube pad 1 and graphics');
S.undo(dol); ok(!fs.existsSync(path.join(root, 'Dolphin', 'User', 'Config', 'GCPadNew.ini')) && read(path.join(root, 'Dolphin', 'User', 'Config', 'Dolphin.ini')) === '[Core]\n', 'Dolphin Undo');
ok(!S.status(path.join(root, 'x', 'cemu.exe')).supported, 'an emulator it can\'t set up yet says so');
ok(S.presetFor({ gpuDevice: [{ vendorId: 0x10de, active: true }] }) === 'pretty' && S.presetFor({ gpuDevice: [{ vendorId: 0x8086 }] }) === 'fast', 'graphics preset picked from the graphics card');

fs.rmSync(root, { recursive: true, force: true });
console.log(fails ? `emulator setup test: ${fails} failed` : 'emulator setup test: all good');
process.exit(fails ? 1 : 0);
