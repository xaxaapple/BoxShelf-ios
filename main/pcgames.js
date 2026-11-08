// PC games beyond Steam (beta.4): the Epic Games Launcher's installs (on the PC shelf), and on the Custom shelf the apps
// Quiver Launcher installed (recomps, ports; Quiver 3, portable or installed, and Quiver 4) plus any program added by hand
// in Settings → Custom games. Each game is { id, source, title, exe | uri, icon?, appid? }: the screen only ever names a
// game by id, and main starts it from this list (never a path the screen sends).
//   - Epic: its manifests (ProgramData\Epic\EpicGamesLauncher\Data\Manifests\*.item); started through the launcher's own
//     link, so its sign-in, cloud saves and overlay work as usual.
//   - Quiver 3 keeps apps.json + settings.json beside its program (portable) and the games in Apps\<folder>; Quiver 4
//     keeps library.json / installs.json / apps-folder.json in %APPDATA%\com.quiverlauncher.app. Read only, never written.
//   - Covers: an Epic game's title is matched once to a Steam app (the store's search) and Steam's own art is used
//     (steamart.js); only while box art downloads are on. Quiver's and hand-added games aren't matched (a recomp often
//     shares its name with an unrelated Steam game) and keep Boxshelf's made-up case, as does a title with no match.
const fs = require('fs');
const path = require('path');
const https = require('https');

let log = () => {}, dataDir = '';
const isFile = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } };
const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'game';

function init(dir, logger) { dataDir = dir; if (logger) log = logger; }

// ---------- Epic Games ----------
const EPIC_DIR = () => path.join(process.env.ProgramData || 'C:\\ProgramData', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');
function epicGames(dir = EPIC_DIR()) {
  let files = []; try { files = fs.readdirSync(dir).filter(f => /\.item$/i.test(f)); } catch { return []; }
  const out = [], seen = new Set();
  for (const f of files.slice(0, 2000)) {
    const m = readJson(path.join(dir, f)); if (!m || typeof m !== 'object') continue;
    const app = String(m.AppName || ''), title = String(m.DisplayName || '').trim();
    if (!app || !title || m.bIsIncompleteInstall === true || /^UE_/i.test(app)) continue; // half-installed, or the Unreal Engine
    const cats = Array.isArray(m.AppCategories) ? m.AppCategories.map(String) : null;
    if (cats && !cats.includes('games')) continue; // plugins, engine parts, tools
    if (m.InstallLocation && !isDir(m.InstallLocation)) continue; // its folder is gone (a removed drive, a deleted install)
    const id = 'epic-' + slug(app); if (seen.has(id)) continue; seen.add(id);
    const ns = String(m.CatalogNamespace || ''), item = String(m.CatalogItemId || '');
    const uri = 'com.epicgames.launcher://apps/' + (ns && item ? encodeURIComponent(`${ns}:${item}:${app}`) : encodeURIComponent(app)) + '?action=launch&silent=true';
    out.push({ id, source: 'epic', title, uri, exe: m.InstallLocation && m.LaunchExecutable ? path.join(m.InstallLocation, m.LaunchExecutable) : '' });
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

// ---------- (beta.7) more stores on the PC shelf: GOG Galaxy, Ubisoft Connect, EA app, Xbox / Game Pass ----------
// Windows only; read only. Each store's install list, the way the store itself leaves it:
//   - GOG: HKLM\SOFTWARE\WOW6432Node\GOG.com\Games\<id> (gameName, path, exe / launchCommand, dependsOn = a DLC). GOG games
//     have no copy protection: Boxshelf starts the game's own program (Home menu and quit work as for any app).
//   - Ubisoft Connect: HKLM\SOFTWARE\WOW6432Node\Ubisoft\Launcher\Installs\<id>\InstallDir; started through Connect's
//     link uplay://launch/<id>/0 (its sign-in and cloud saves).
//   - EA app: every EA game folder has __Installer\installerdata.xml (its content ids and title); found from the
//     uninstall list and the usual EA Games folders; started through the EA app's link origin2://game/launch?offerIds=….
//   - Xbox / Game Pass: each drive's Xbox games folder (named in <drive>:\.GamingRoot: "RGBX", 4 bytes, then the folder
//     in UTF-16; usually XboxGames), each game's Content\MicrosoftGame.config (its package name, title, program id);
//     started as the Windows app it is (shell:AppsFolder\<package family>!<app id>), the family looked up once and kept.
const { execFile } = require('child_process');
const run = (cmd, args, ms = 20000) => new Promise(res => { try { execFile(cmd, args, { windowsHide: true, timeout: ms, maxBuffer: 64 << 20 }, (err, out) => res(err && !out ? '' : String(out || ''))); } catch { res(''); } });
// `reg query <key> /s` → Map(full key → { value name (lower case): data })
function parseReg(out) {
  const m = new Map(); let cur = null;
  for (const line of String(out).split(/\r?\n/)) {
    if (/^HKEY_/.test(line)) { cur = {}; m.set(line.trim(), cur); continue; }
    const v = /^ {4}(.+?) {4}(REG_\w+)(?: {4}(.*))?$/.exec(line); if (v && cur) cur[v[1].toLowerCase()] = (v[3] || '').trim();
  }
  return m;
}
const regTree = key => process.platform === 'win32' ? run('reg', ['query', key, '/s']).then(parseReg) : Promise.resolve(new Map());
const xmlText = (x, tag) => { const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, 'i').exec(x); return m ? m[1].trim() : ''; };
const unxml = s => String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
const splitCmd = c => { const m = /^\s*"([^"]+)"\s*(.*)$/.exec(String(c || '')) || /^\s*(\S+)\s*(.*)$/.exec(String(c || '')); return m ? { exe: m[1], args: m[2] || '' } : { exe: '', args: '' }; };

async function gogGames() {
  const out = [];
  for (const [k, v] of await regTree('HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games')) {
    const id = (/\\Games\\(\d+)$/i.exec(k) || [])[1]; if (!id || v.dependson) continue; // (dependsOn: a DLC of another game)
    const title = String(v.gamename || v.gametitle || '').trim(), dir = v.path || '';
    if (!title || !dir || !isDir(dir)) continue;
    let { exe, args } = splitCmd(v.launchcommand);
    if (!exe || !isFile(exe)) { exe = v.exe && isFile(v.exe) ? v.exe : mainExe(dir); args = v.launchparam || ''; }
    if (!exe) continue;
    out.push({ id: 'gog-' + id, source: 'gog', title, exe, args: String(args || '').slice(0, 1000) });
  }
  return out;
}
async function ubisoftGames() {
  const out = [];
  for (const [k, v] of await regTree('HKLM\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher\\Installs')) {
    const id = (/\\Installs\\(\d+)$/i.exec(k) || [])[1], dir = String(v.installdir || '').replace(/[\\/]+$/, '').replace(/\//g, '\\');
    if (!id || !dir || !isDir(dir)) continue;
    out.push({ id: 'ubisoft-' + id, source: 'ubisoft', title: path.basename(dir), uri: `uplay://launch/${id}/0`, exe: mainExe(dir) || '' });
  }
  return out;
}
async function eaGames() {
  if (process.platform !== 'win32') return [];
  const dirs = new Set();
  for (const key of ['HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'])
    for (const v of (await regTree(key)).values()) { const d = String(v.installlocation || '').replace(/^"|"$/g, '').replace(/[\\/]+$/, ''); if (d && isFile(path.join(d, '__Installer', 'installerdata.xml'))) dirs.add(path.resolve(d)); }
  for (const pf of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)) { let ents = []; try { ents = fs.readdirSync(path.join(pf, 'EA Games'), { withFileTypes: true }); } catch {} for (const e of ents) if (e.isDirectory()) { const d = path.join(pf, 'EA Games', e.name); if (isFile(path.join(d, '__Installer', 'installerdata.xml'))) dirs.add(path.resolve(d)); } }
  return eaFromDirs([...dirs]);
}
// the games in these EA game folders (each with __Installer\installerdata.xml)
function eaFromDirs(dirs) {
  const out = [], seen = new Set();
  for (const d of dirs) {
    let x = ''; try { x = fs.readFileSync(path.join(d, '__Installer', 'installerdata.xml'), 'utf8'); } catch { continue; }
    const ids = [...x.matchAll(/<contentID>\s*([^<\s]+)\s*<\/contentID>/gi)].map(m => m[1]).slice(0, 20);
    if (!ids.length) continue;
    const en = /<gameTitle\s+locale="en_US"\s*>([^<]+)</i.exec(x), title = unxml(en ? en[1] : xmlText(x, 'gameTitle')) || path.basename(d);
    const id = 'ea-' + slug(ids[0]); if (seen.has(id)) continue; seen.add(id);
    out.push({ id, source: 'ea', title: title.trim(), uri: 'origin2://game/launch?offerIds=' + encodeURIComponent(ids.join(',')) + '&autoDownload=1', exe: mainExe(d) || '' });
  }
  return out;
}
// Xbox: the package families looked up once (data\pc-xbox.json: { "<package name>": "<family>" })
let xboxFam = null; const xboxFile = () => path.join(dataDir, 'pc-xbox.json');
function xboxRoots() {
  const roots = [];
  for (const L of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const drive = L + ':\\'; let rel = null;
    try { const b = fs.readFileSync(drive + '.GamingRoot'); if (b.slice(0, 4).toString('latin1') === 'RGBX') rel = b.slice(8).toString('utf16le').split('\0')[0]; } catch { if (L !== 'C') continue; }
    const dir = rel ? (path.isAbsolute(rel) ? rel : path.join(drive, rel)) : path.join(drive, 'XboxGames');
    if (isDir(dir)) roots.push(dir);
  }
  return roots;
}
async function xboxGames() {
  if (process.platform !== 'win32') return [];
  const found = xboxScan(xboxRoots());
  if (!found.length) return [];
  if (!xboxFam) xboxFam = readJson(xboxFile()) || {};
  const missing = found.filter(f => !(f.name in xboxFam)).map(f => f.name); // ('' = asked, not installed: not asked again)
  if (missing.length) {
    const list = missing.map(n => "'" + n.replace(/'/g, "''") + "'").join(',');
    const outp = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-AppxPackage -Name ${list} | ForEach-Object { $_.Name + '|' + $_.PackageFamilyName }`], 30000);
    for (const n of missing) xboxFam[n] = '';
    for (const line of outp.split(/\r?\n/)) { const [n, fam] = line.trim().split('|'); if (n && fam) xboxFam[n] = fam; }
    try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(xboxFile(), JSON.stringify(xboxFam)); } catch {}
  }
  return found.filter(f => xboxFam[f.name]).map(f => ({ id: 'xbox-' + slug(f.name), source: 'xbox', title: f.title.trim(), shellApp: `${xboxFam[f.name]}!${f.appId}`, exe: '' }));
}
// the games in these Xbox games folders: { name (its package), appId, title, dir }
function xboxScan(roots) {
  const found = [];
  for (const root of roots) {
    let ents = []; try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const cfgF = path.join(root, e.name, 'Content', 'MicrosoftGame.config'); let x = ''; try { x = fs.readFileSync(cfgF, 'utf8'); } catch { continue; } // (GameSave and other parts of the Xbox app have none)
      const name = (/<Identity\s[^>]*\bName="([^"]+)"/i.exec(x) || [])[1], appId = (/<Executable\s[^>]*\bId="([^"]+)"/i.exec(x) || [])[1] || 'Game';
      let title = unxml((/<ShellVisuals\s[^>]*\bDefaultDisplayName="([^"]+)"/i.exec(x) || [])[1] || '');
      if (!title || /^ms-resource:/i.test(title)) title = e.name;
      if (name) found.push({ name, appId, title, dir: path.join(root, e.name) });
    }
  }
  return found;
}
// all four at once; each one that fails is only logged (one store's oddity must not empty the shelf)
async function storeGames(pc = {}) {
  const want = { gog: pc.gog !== false, ubisoft: pc.ubisoft !== false, ea: pc.ea !== false, xbox: pc.xbox !== false };
  const jobs = { gog: gogGames, ubisoft: ubisoftGames, ea: eaGames, xbox: xboxGames }, out = [];
  await Promise.all(Object.keys(jobs).filter(k => want[k]).map(k => jobs[k]().then(l => out.push(...l), e => log('PC library', k, e && e.message))));
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

// ---------- the program in a game's folder ----------
// the biggest .exe that isn't a helper (crash reporters, installers, redistributables, uninstallers, updaters), two
// folders deep at most: recomps ship as one program beside its DLLs, some in a bin\ folder
const HELPER = /^(unins.*|uninstall.*|setup.*|install.*|vc_?redist.*|dxsetup.*|dotnet.*|crash.*|.*crashhandler.*|.*updater.*|update\.exe|unitycrashhandler.*|ue4prereq.*|easyanticheat.*|.*_launcher_setup.*|7z.*|cmd\.exe|notification_helper.*)$/i;
function mainExe(dir, depth = 2) {
  let best = null, size = -1;
  const walk = (d, left) => {
    let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isFile() && /\.exe$/i.test(e.name) && !HELPER.test(e.name)) { let s = 0; try { s = fs.statSync(p).size; } catch { continue; } if (s > size) { best = p; size = s; } }
      else if (e.isDirectory() && left > 0 && !/^(redist|_commonredist|directx|vcredist|support|tools?|mods?|saves?|config|logs?)$/i.test(e.name)) walk(p, left - 1);
    }
  };
  walk(dir, depth); return best;
}

// ---------- Quiver Launcher ----------
// A Quiver folder is one holding apps.json (Quiver 3) or installs.json (Quiver 4). Where it usually is, then the folder
// chosen in Settings (a portable copy can be anywhere)
function quiverStd() {
  const A = process.env.APPDATA || '', L = process.env.LOCALAPPDATA || '';
  return [path.join(A, 'com.quiverlauncher.app'), path.join(L, 'com.quiverlauncher.app'), path.join(A, 'QuiverLauncher'), path.join(L, 'QuiverLauncher'), path.join(L, 'QuiverLauncher', 'current')].filter(Boolean);
}
const isQuiver = d => isFile(path.join(d, 'apps.json')) || isFile(path.join(d, 'installs.json'));
function quiverRoots(chosen) { const r = []; if (chosen) { r.push(chosen); r.push(path.dirname(chosen)); } for (const d of quiverStd()) r.push(d); return [...new Set(r.map(p => path.resolve(p)))].filter(isQuiver); }
// Settings → Find Quiver: a portable copy unzipped into Downloads, the Desktop, Documents or a games folder (four
// folders deep at most; folders that can't hold it are skipped)
function quiverFind() {
  const H = process.env.USERPROFILE || '', L = process.env.LOCALAPPDATA || '';
  const starts = [path.join(H, 'Downloads'), path.join(H, 'Desktop'), path.join(H, 'Documents'), path.join(H, 'OneDrive', 'Desktop'), path.join(H, 'OneDrive', 'Documents'), path.join(L, 'Programs'), 'C:\\Games', 'D:\\Games', 'D:\\', 'E:\\'];
  const SKIP = /^(node_modules|\$recycle\.bin|windows|appdata|system volume information|steamapps|\.git|cache|temp)$/i;
  let found = null, seen = 0;
  const walk = (d, left) => {
    if (found || ++seen > 20000) return;
    let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    if (ents.some(e => e.isFile() && /^quiverlauncher(\.desktop)?\.exe$/i.test(e.name)) && isQuiver(d)) { found = d; return; }
    if (left > 0) for (const e of ents) if (e.isDirectory() && !SKIP.test(e.name)) walk(path.join(d, e.name), left - 1);
  };
  for (const s of starts) { if (found) break; if (isDir(s)) walk(s, 4); }
  return found;
}
function quiver3(root) {
  const j = readJson(path.join(root, 'apps.json')), s = readJson(path.join(root, 'settings.json')) || {};
  const apps = j && Array.isArray(j.apps) ? j.apps : [];
  const appsDir = typeof s.AppsPath === 'string' && s.AppsPath.trim() ? s.AppsPath.trim() : path.join(root, 'Apps');
  const names = s.UserAppDisplayNames && typeof s.UserAppDisplayNames === 'object' ? s.UserAppDisplayNames : {};
  const out = [];
  for (const a of apps.slice(0, 2000)) {
    if (!a || typeof a !== 'object') continue;
    const folder = typeof a.folderName === 'string' ? a.folderName : '';
    const dir = typeof a.installPath === 'string' && a.installPath ? a.installPath : folder ? path.join(appsDir, folder) : '';
    if (!dir || !isDir(dir)) continue; // listed but not installed
    const exe = mainExe(dir); if (!exe) continue;
    const own = names[a.repository] || names[folder] || names[a.name];
    out.push({ key: a.repository || folder, title: String(own || a.name || a.project || folder).trim(), exe, icon: typeof a.appIconUrl === 'string' && /^https:\/\//.test(a.appIconUrl) ? a.appIconUrl : '', tags: Array.isArray(a.tags) ? a.tags.map(String) : [] });
  }
  return out;
}
function quiver4(root) {
  const inst = readJson(path.join(root, 'installs.json')), lib = readJson(path.join(root, 'library.json'));
  const af = readJson(path.join(root, 'apps-folder.json')), appsDir = af && typeof af.path === 'string' && af.path ? af.path : path.join(root, 'apps');
  const items = Array.isArray(lib) ? lib : lib && Array.isArray(lib.items) ? lib.items : lib && typeof lib === 'object' ? Object.values(lib) : [];
  const byId = new Map(items.filter(x => x && x.id).map(x => [String(x.id), x]));
  const entries = Array.isArray(inst) ? inst.map(x => [x && (x.id || x.app), x]) : inst && typeof inst === 'object' ? Object.entries(inst) : [];
  const out = [];
  for (const [id, i] of entries.slice(0, 2000)) {
    if (!i || typeof i !== 'object') continue;
    const dir = typeof i.dir === 'string' && i.dir ? i.dir : typeof i.folder === 'string' && i.folder ? path.join(appsDir, i.folder) : '';
    let exe = typeof i.program === 'string' && i.program ? (path.isAbsolute(i.program) ? i.program : path.join(dir, i.program)) : '';
    if (!exe && Array.isArray(i.executables) && i.executables.length) { const e = String(i.executables[0]); exe = path.isAbsolute(e) ? e : path.join(dir, e); }
    if (!exe || !isFile(exe)) exe = dir && isDir(dir) ? mainExe(dir) : null;
    if (!exe || !/\.exe$/i.test(exe)) continue;
    const it = byId.get(String(id)) || {}, ov = it.overrides || {};
    const title = String(ov.name || (it.custom && it.custom.name) || (it.local && it.local.name) || it.slug || i.folder || path.basename(path.dirname(exe))).trim();
    out.push({ key: String(id), title, exe, icon: typeof ov.cover === 'string' && /^https:\/\//.test(ov.cover) ? ov.cover : '', tags: [] });
  }
  return out;
}
function quiverGames(chosen) {
  const out = [], seen = new Set();
  for (const root of quiverRoots(chosen)) {
    let list = [];
    try { list = isFile(path.join(root, 'installs.json')) ? quiver4(root) : quiver3(root); } catch (e) { log('Quiver read', e.message); }
    for (const g of list) { const id = 'quiver-' + slug(g.key || g.title); if (seen.has(id) || seen.has(g.exe.toLowerCase())) continue; seen.add(id); seen.add(g.exe.toLowerCase()); out.push({ id, source: 'quiver', ...g }); }
  }
  return out;
}

// ---------- games added by hand (cfg.pc.custom: [{ id, title, exe, args }]) ----------
function customGames(list) {
  return (Array.isArray(list) ? list : []).filter(c => c && typeof c.exe === 'string' && c.exe && isFile(c.exe)).slice(0, 500)
    .map(c => ({ id: 'custom-' + slug(c.id || c.title || path.basename(c.exe)), source: 'custom', title: String(c.title || path.basename(c.exe, '.exe')).trim().slice(0, 120), exe: c.exe, args: typeof c.args === 'string' ? c.args.slice(0, 1000) : '', ...(c.shelf === 'pc' ? { shelf: 'pc' } : {}) })); // (beta.10: shelf 'pc' = shown on the PC shelf instead of Custom)
}
// a title from a program's name: "SoH-Ship-of-Harkinian.exe" → "SoH Ship of Harkinian"
const titleFromExe = exe => path.basename(String(exe || ''), path.extname(String(exe || ''))).replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Game';

// ---------- the last lists, for starting a game by id ----------
let last = new Map();
function remember(games) { last = new Map(games.map(g => [g.id, g])); }
const byId = id => last.get(String(id || ''));
const all = () => [...last.values()]; // (beta.9: the batch cover finder)

// ---------- covers: a title → its Steam app, once ----------
// data\pc-steam.json: { "<lower title>": { id: 1234 | 0, at } }; a miss is tried again after a week
let map = null;
const mapFile = () => path.join(dataDir, 'pc-steam.json');
function steamIdOf(title) { if (!map) map = readJson(mapFile()) || {}; const e = map[String(title || '').toLowerCase()]; return e && e.id ? e.id : null; }
const norm = s => String(s || '').toLowerCase().replace(/[™®©]/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();
function getJson(url, ms = 12000) {
  return new Promise(res => {
    const rq = https.get(url, { headers: { 'User-Agent': 'Boxshelf' }, timeout: ms }, r => { if (r.statusCode !== 200) { r.resume(); return res({ err: 'HTTP ' + r.statusCode }); } let b = ''; r.setEncoding('utf8'); r.on('data', c => { b += c; if (b.length > 2e6) rq.destroy(); }); r.on('end', () => { try { res({ data: JSON.parse(b) }); } catch { res({ err: 'bad reply' }); } }); });
    rq.on('timeout', () => rq.destroy(new Error('timeout'))); rq.on('error', e => res({ err: e.message }));
  });
}
// asks the store for the titles not matched yet (at most 40 a run, a pause between); returns how many were matched
async function matchSteam(titles) {
  if (!map) map = readJson(mapFile()) || {};
  const WEEK = 7 * 864e5; let n = 0, asked = 0;
  for (const t of [...new Set(titles.filter(Boolean))]) {
    const k = String(t).toLowerCase(), e = map[k]; if (e && (e.id || Date.now() - e.at < WEEK)) continue;
    if (++asked > 40) break;
    const r = await getJson('https://store.steampowered.com/api/storesearch/?term=' + encodeURIComponent(t) + '&l=english&cc=US');
    if (r.err) { log('PC art: Steam search', r.err); break; } // offline or rate-limited: try again next time
    const items = r.data && Array.isArray(r.data.items) ? r.data.items : [], want = norm(t);
    const hit = items.find(x => norm(x.name) === want) || items.find(x => norm(x.name).startsWith(want + ' ') || want.startsWith(norm(x.name) + ' '));
    map[k] = { id: hit ? +hit.id : 0, at: Date.now() }; if (hit) n++;
    await new Promise(r => setTimeout(r, 400));
  }
  if (asked) { try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(mapFile() + '.tmp', JSON.stringify(map)); fs.renameSync(mapFile() + '.tmp', mapFile()); } catch {} }
  return n;
}

// (beta.9) the cover picker, without any key: Steam games with this name, for their official covers. exact: only the very
// same name, the game's own title ("Quarantine" never offers "Quarantine Zone: The Last Check"); otherwise (a name typed in
// Search by name) Steam's first few answers. Never a soundtrack, artbook, demo, pack or DLC. [{ id, name }] (at most 3); []
// offline. Answers kept for 10 minutes.
const searchMemo = new Map(), NOT_GAME = /\b(soundtrack|ost|artbook|art book|demo|dlc|season pass|expansion pass|wallpapers?|supporter pack|bundle)\b/i; // (not "pack" alone: The Jackbox Party Pack is a game)
async function steamSearch(term, exact) {
  const t = String(term || '').replace(/\s+/g, ' ').trim().slice(0, 120); if (!t) return [];
  const k = t.toLowerCase(), m = searchMemo.get(k);
  let items = m && Date.now() - m.at < 600000 ? m.items : null;
  if (!items) {
    const r = await getJson('https://store.steampowered.com/api/storesearch/?term=' + encodeURIComponent(t) + '&l=english&cc=US', 8000);
    if (r.err) { log('PC cover: Steam search', r.err); return []; }
    items = (r.data && Array.isArray(r.data.items) ? r.data.items : []).filter(x => x && /^\d{1,10}$/.test(String(x.id)) && x.name && x.type !== 'sub' && !NOT_GAME.test(x.name)).map(x => ({ id: String(x.id), name: String(x.name).slice(0, 120) }));
    searchMemo.set(k, { at: Date.now(), items }); while (searchMemo.size > 200) searchMemo.delete(searchMemo.keys().next().value);
  }
  if (!exact) return items.slice(0, 3);
  const want = norm(t); return items.filter(x => norm(x.name) === want).slice(0, 3);
}

module.exports = { init, epicGames, quiverGames, quiverFind, quiverRoots, customGames, titleFromExe, mainExe, remember, byId, all, steamIdOf, matchSteam, steamSearch, EPIC_DIR,
  storeGames, gogGames, ubisoftGames, eaGames, xboxGames, parseReg, xboxRoots, eaFromDirs, xboxScan };
