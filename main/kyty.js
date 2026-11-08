// PS5 through Kyty (the KytyJets fork first): starting a game straight with kyty_emulator.exe, the way Kyty's own
// launcher does, so a game boots with the settings chosen there.
//   - the launcher's settings: the shared settings file %ProgramData%\Kyty\Kyty.ini ([GlobalConfiguration], and the
//     add-ons folder in [Launcher]) turned into kyty_emulator's command-line options. Fullscreen and the hidden cursor
//     are always on here (Boxshelf is a TV front end).
//   - the build's preset: a u59-preset.json beside the emulator (KytyJets) is applied as environment variables, after
//     clearing inherited KYTY_* / TRACY_* ones, as its launcher does.
//   - the game's patch file: _Patches\<title id>.json beside the emulator (its fixes carry their own on / off flags).
// Games are folders with eboot.bin and sce_sys\param.json; the emulator is handed the folder.
const fs = require('fs');
const path = require('path');

const isFile = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

// a Qt settings file: { section: { key: value } } (Qt writes lists as "a, b", quotes some strings, @Invalid() for none)
function readIni(file) {
  const out = {}; let sec = out[''] = {};
  let text = ''; try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line[0] === ';' || line[0] === '#') continue;
    const s = /^\[(.+)\]$/.exec(line); if (s) { sec = out[s[1]] = out[s[1]] || {}; continue; }
    const i = line.indexOf('='); if (i < 0) continue;
    let v = line.slice(i + 1).trim(); if (/^".*"$/.test(v)) v = v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    sec[line.slice(0, i).trim()] = v;
  }
  return out;
}
const iniPath = () => path.join(process.env.ProgramData || 'C:\\ProgramData', 'Kyty', 'Kyty.ini');

// the game folder for a scanned file (…\Game\eboot.bin → …\Game)
function gameDir(file) { const f = String(file || ''); return /(^|[\\/])eboot\.bin$/i.test(f) ? path.dirname(f) : f; }

// sce_sys\param.json: the title (in its default language) and the title id
function readParam(file) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(gameDir(file), 'sce_sys', 'param.json'), 'utf8'));
    const L = j.localizedParameters || {}, lang = L.defaultLanguage || 'en-US';
    const title = (L[lang] && L[lang].titleName) || (L['en-US'] && L['en-US'].titleName) || '';
    return { title: String(title).replace(/\s+/g, ' ').trim(), titleId: String(j.titleId || '').trim(), category: j.applicationCategoryType };
  } catch { return null; }
}
const titleId = file => { const p = readParam(file); return p && /^[A-Z]{4}\d{5}$/.test(p.titleId) ? p.titleId : ''; };

const on = v => /^(true|1|yes|on)$/i.test(String(v || '').trim());
const num = (v, lo, hi) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= lo && n <= hi ? String(n) : null; };

// The options this build of kyty_emulator understands, read from its own help: builds differ (KytyJets U59 takes
// "--skip-notice-screen true", has no --shader-cache, and its --amd-cpu is an Intel compatibility mode), and an option a
// build doesn't know makes it print its help and quit. { name: value spec ('' = a plain switch) }, kept per exe + date.
// (beta.10) asked with execFile, not execFileSync: the probe (up to 8 s) held the whole app up on every PS5 launch. The
// promise is kept, so two launches close together share one probe.
const optsMemo = new Map();
async function optionsOf(exe) {
  if (!/kyty_emulator\.exe$/i.test(String(exe))) return null; // (only the emulator prints its options; the launcher would open its window)
  let key = String(exe); try { key += '|' + (await fs.promises.stat(exe)).mtimeMs; } catch { return null; }
  if (optsMemo.has(key)) return optsMemo.get(key);
  const p = new Promise(resolve => {
    try { const c = require('child_process').execFile(exe, ['--boxshelf-probe'], { cwd: path.dirname(exe), timeout: 8000, windowsHide: true }, (e, stdout, stderr) => resolve(e ? String(stdout || '') + '\n' + String(stderr || '') : '')); /* (the unknown option: help, exit 1) */ if (c.stdin) { c.stdin.on('error', () => {}); c.stdin.end(); } }
    catch { resolve(''); }
  }).then(text => {
    const o = {}; for (const m of text.matchAll(/^\s{2}(--[a-z0-9][a-z0-9-]*)(?:\s+<([^>]*)>)?/gm)) o[m[1]] = m[2] || '';
    return Object.keys(o).length > 5 ? o : null; // (no help text: the build's options can't be known; the safe few are used)
  });
  optsMemo.set(key, p); return p;
}

// the options for one launch: { args (before --game), env } (beta.10: async, see optionsOf)
async function spec(exe, file) {
  const ini = readIni(iniPath()) || {}, g = ini.GlobalConfiguration || {}, L = ini.Launcher || {}, a = [];
  const O = (await optionsOf(exe)) || { '--screen-width': 'num', '--screen-height': 'num', '--fullscreen': '', '--hide-cursor': '', '--addcont-dir': 'dir', '--game-patch': 'json' };
  const has = n => Object.prototype.hasOwnProperty.call(O, n);
  // a value option, a switch, or a yes / no in the form this build wants (true|false, on|off, or the switch alone)
  const val = (n, v) => { if (v != null && v !== '' && has(n) && O[n]) a.push(n, String(v)); };
  const bool = (n, yes) => { if (!has(n)) return; const s = O[n]; if (!s) { if (yes) a.push(n); } else if (/on\|off/.test(s)) a.push(n, yes ? 'on' : 'off'); else a.push(n, yes ? 'true' : 'false'); };
  const res = /^R?(\d{3,5})X(\d{3,5})$/i.exec(g.screen_resolution || '');
  if (res) { val('--screen-width', res[1]); val('--screen-height', res[2]); }
  bool('--fullscreen', true); bool('--hide-cursor', true); if (has('--shader-cache') && !O['--shader-cache']) a.push('--shader-cache');
  if (/^(Fifo|Mailbox|Immediate)$/.test(g.present_mode || '')) val('--present-mode', g.present_mode);
  if (num(g.gpu_index, 0, 15) && g.gpu_index !== '0') val('--gpu', g.gpu_index);
  const user = String(g.user_name || '').trim(); if (user && Buffer.byteLength(user) <= 16) val('--user-name', user);
  val('--user-id', num(g.user_id, 1, 99999999));
  const mic = String(g.audio_input_device || '').trim(); if (mic && mic !== '@Invalid()') val('--mic', mic);
  if (/^#[0-9a-f]{6}$/i.test(g.controller_color || '')) val('--controller-color', g.controller_color);
  val('--controller-volume', num(g.controller_speaker_volume, 0, 100));
  val('--controller-vibration', num(g.controller_vibration_intensity, 0, 100));
  val('--keyboard-player', num(g.controller_keyboard_player, 0, 4));
  val('--audio-master-volume', num(g.audio_master_volume, 0, 200)); val('--audio-main-volume', num(g.audio_main_volume, 0, 200));
  val('--audio-music-volume', num(g.audio_music_volume, 0, 200)); val('--audio-pad-speaker-volume', num(g.audio_pad_speaker_main_volume, 0, 200));
  val('--audio-objects-volume', num(g.audio_objects_volume, 0, 200)); if (g.audio_objects_enabled !== undefined) bool('--audio-objects', on(g.audio_objects_enabled));
  val('--vblank-frequency', num(g.vblank_frequency, 1, 240));
  val('--console-language', num(g.console_language, 0, 29));
  if (/^(None|Size|Performance)$/.test(g.shader_optimization_type || '')) val('--shader-optimization-type', g.shader_optimization_type);
  for (const [k, n] of Object.entries({ hdr_enabled: '--hdr', network_connected: '--network-connected', perf_overlay_enabled: '--perf-overlay', skip_notice_screen: '--skip-notice-screen',
    tessellation_enabled: '--tessellation', readback_linear_images: '--readback-linear-images', readback_tiled_images: '--readback-tiled-images',
    sync_raw_image_buffers: '--sync-raw-image-buffers', red_zone_protection_enabled: '--redzone', gpu_occlusion_accurate: '--gpu-occlusion' }))
    if (g[k] !== undefined && (on(g[k]) || (has(n) && O[n]))) bool(n, on(g[k])); // (a plain switch only when on; a yes / no as set)
  if (g.trophy_enabled !== undefined) { if (has('--trophy-notifications')) bool('--trophy-notifications', on(g.trophy_enabled)); else if (!on(g.trophy_enabled)) bool('--no-trophy-notifications', true); }
  if (!(g.trophy_enabled !== undefined && !on(g.trophy_enabled))) val('--trophy-duration', num(g.trophy_duration_seconds, 5, 10));
  // the AMD / Intel CPU instructions: only when set on or off in the launcher; "auto" leaves it to the build, which knows
  // what it means (KytyJets: an Intel compatibility mode, off on an AMD processor; older builds: AMD patches)
  const amd = String(g.amd_cpu_mode || '').toLowerCase().trim();
  if (on(amd)) bool('--amd-cpu', true); else if (/^(off|false|0|no)$/.test(amd)) bool('--no-amd-cpu', true);
  // add-ons (DLC): the launcher's folder
  const add = String(L.addons_dir || '').trim(); if (add && isDir(add)) val('--addcont-dir', add);
  // the game's patch file beside the emulator
  const id = titleId(file), dir = path.dirname(String(exe || ''));
  if (id) { const p = path.join(dir, '_Patches', id + '.json'); if (isFile(p)) val('--game-patch', p); }
  // the build's preset (KytyJets' u59-preset.json) as environment variables
  let env = null; const preset = path.join(dir, 'u59-preset.json');
  if (isFile(preset)) {
    try {
      const P = JSON.parse(fs.readFileSync(preset, 'utf8')); env = {};
      for (const [k, v] of Object.entries(process.env)) if (!/^(KYTY|TRACY)_/i.test(k)) env[k] = v;
      for (const [k, v] of Object.entries(P || {})) if (/^[A-Z0-9_]+$/.test(k) && (typeof v === 'string' || typeof v === 'number')) env[k] = String(v);
    } catch { env = null; }
  }
  return { args: a, env, dir: gameDir(file) };
}

module.exports = { spec, readParam, titleId, gameDir, readIni };
