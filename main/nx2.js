// Switch 2 games for Eglantine (an Eden fork). Most come unpacked: a folder with exefs\main (+ main.npdm) and romfs, or
// the same split as base\ and updates\<version>\ (each update a full copy), or just <version>\ with no base at all.
// Eden-family emulators boot such a game when handed its exefs\main. Packed games are .nsp / .xci / .nup files.
//   - the shelf's file for a game is its base exefs\main (or its only version's), so favourites and history stay put
//     when an update is added
//   - bootFile() swaps in the newest version's exefs\main at launch
//   - the title comes from a known title id, else the folder / file name; the title id from main.npdm
//   - builds(): every Eglantine build in the Switch 2 emulator folders, for the "which build?" choice at Play
const fs = require('fs');
const path = require('path');

const isFile = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const dirs = d => { try { return fs.readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch { return []; } };
const mainOf = d => { const f = path.join(d, 'exefs', 'main'); return isFile(f) && isFile(path.join(d, 'exefs', 'main.npdm')) ? f : null; };
const SKIP = /^(exefs|romfs|updates?|dlc|mods|patches|base)$/i;
const isVer = n => /^\d+$/.test(n);

// the unpacked games under a ROM folder: [base exefs\main, or the only version's]
function find(root, depth = 3, out = []) {
  for (const n of dirs(root)) {
    if (n.startsWith('.')) continue;
    const d = path.join(root, n), own = mainOf(d), base = mainOf(path.join(d, 'base'));
    // no base: a folder of versions (…\Game\131072\exefs\main), the lowest one stands for the game
    const vers = own || base ? [] : dirs(d).filter(isVer).sort((a, b) => +a - +b).map(v => mainOf(path.join(d, v))).filter(Boolean);
    if (own) out.push(own); else if (base) out.push(base); else if (vers.length) out.push(vers[0]);
    else if (depth > 0 && !SKIP.test(n)) find(d, depth - 1, out);
  }
  return out;
}
// the game's folder for a shelf file (…\Game\exefs\main, …\Game\base\exefs\main, …\Game\131072\exefs\main or
// …\Game\updates\131072\exefs\main → …\Game)
function gameRoot(file) {
  let d = path.dirname(path.dirname(String(file || '')));
  if (/^base$/i.test(path.basename(d))) return path.dirname(d);
  if (isVer(path.basename(d))) { d = path.dirname(d); if (/^updates?$/i.test(path.basename(d))) d = path.dirname(d); }
  return d;
}
// the file to boot: the newest full version's exefs\main (updates\<version> or <version> beside base, highest first)
function bootFile(file) {
  if (!/(^|[\\/])exefs[\\/]main$/i.test(String(file || ''))) return file;
  const root = gameRoot(file), list = [];
  for (const d of [path.join(root, 'updates'), root]) for (const n of dirs(d)) if (isVer(n)) list.push([+n, path.join(d, n)]);
  const best = list.sort((a, b) => b[0] - a[0]).map(x => mainOf(x[1])).find(Boolean);
  return best || file;
}
// the program id inside main.npdm (its ACI0 block), e.g. 0400C3F00006E000
function titleId(file) {
  try {
    const b = fs.readFileSync(path.join(path.dirname(String(file)), 'main.npdm'));
    if (b.toString('latin1', 0, 4) !== 'META') return '';
    const aci = b.readUInt32LE(0x70); if (b.toString('latin1', aci, aci + 4) !== 'ACI0') return '';
    return b.readBigUInt64LE(aci + 0x10).toString(16).toUpperCase().padStart(16, '0');
  } catch { return ''; }
}
// a title id in a file or folder name: "[0400A3A01EE4C000]"
const idInName = s => { const m = /\[((?:0100|0400)[0-9A-F]{12})\]/i.exec(String(s || '')); return m ? m[1].toUpperCase() : ''; };
// unpacked games carry no name (that's in the control data, not dumped): known title ids first, so a folder called
// "SR ROM" still shows the real title and its box art can be matched
const KNOWN = {
  '0400C3F00006E000': 'Mario Kart World', '0400380020056000': 'Splatoon Raiders', '040074A01BF12000': 'Donkey Kong Bananza',
  '04007EF01F8AE000': "Fire Emblem: Fortune's Weave", '0400D4201C6EA000': 'Mario Tennis Fever',
  '04008E001F098000': 'Nintendo Switch Sports Resort', '0400A3A01EE4C000': 'Pokémon Pokopia',
  '0100F43008C44000': 'Pokémon Legends: Z-A - Nintendo Switch 2 Edition',
  // (Switch 2 Editions keep their Switch game's id: the folder or file name carries it)
  '010015100B514000': 'Super Mario Bros. Wonder – Nintendo Switch 2 Edition'
};
// known games without a readable id (a .nup carries none in its name): by their tidied name
const KNOWN_NAMES = { 'hyrule warriors age of imprisonment': 'Hyrule Warriors: Age of Imprisonment' };
// a readable name from a folder / file name: dump words go ("base", "[BASE]", "ROM", "unpacked", version / id tags) and
// joined words split ("MarioTennisFever_v1.1.1" → "Mario Tennis Fever")
function tidy(n) {
  n = String(n || '').replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/[_.]v?\d+(\.\d+)+\b/gi, ' ').replace(/[._]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\bSwitch2\b/gi, 'Switch 2') // ("NintendoSwitch2_WelcomeTour")
    .replace(/\b(base|rom|unpacked|extracted|exefs|romfs|nsw2?)\b/gi, ' ').replace(/\bv\d+(\.\d+)*\b/gi, ' ')
    .replace(/\s+/g, ' ').replace(/^[\s-]+|[\s-]+$/g, '').trim();
  return KNOWN_NAMES[n.toLowerCase()] || n;
}
function title(file) {
  const known = KNOWN[titleId(file)] || KNOWN[idInName(path.basename(gameRoot(file)))]; if (known) return known;
  return tidy(path.basename(gameRoot(file))) || path.basename(gameRoot(file));
}
// a packed game (.nsp / .xci / .nup): its id from the name when there is one, a known title, else the tidied name
function fileInfo(file) {
  const base = path.basename(String(file)).replace(/\.[^.]+$/, ''), id = idInName(base);
  return { title: KNOWN[id] || tidy(base) || base, titleId: id };
}
function info(file) { return { title: title(file), titleId: titleId(file), folder: gameRoot(file) }; }

// ---------- the emulator builds ----------
// Every Eglantine build (eglantine.exe, or a fork's renamed program beside eden-cli.exe) under the folders given (they're often kept grouped: "Djihads main fork\<build>", "Mario tennis
// forks\<build>", …). Each gets a readable label from its folders, its date, and whether it opens .nup files (the
// newer builds name the format in their file dialog; reading that takes a moment, so it's remembered per exe + date).
// (remembered between runs in memoFile: reading every build's program again made the first "which build?" lag)
const nupMemo = new Map(); let memoFile = '', memoLoaded = false;
function setMemoFile(f) { memoFile = f; }
function loadMemo() { if (memoLoaded) return; memoLoaded = true; try { const o = JSON.parse(fs.readFileSync(memoFile, 'utf8')); for (const [k, v] of Object.entries(o || {})) if (typeof v === 'boolean') nupMemo.set(k, v); } catch {} }
async function opensNup(exe, st) {
  loadMemo(); const key = exe.toLowerCase() + '|' + Math.round(st.mtimeMs) + '|' + st.size; if (nupMemo.has(key)) return nupMemo.get(key);
  let yes = false; try { const b = await fs.promises.readFile(exe); yes = b.includes('.nup', 0, 'latin1'); } catch {}
  nupMemo.set(key, yes);
  if (memoFile) { const o = {}; for (const [k, v] of [...nupMemo].slice(-200)) o[k] = v; fs.promises.writeFile(memoFile, JSON.stringify(o)).catch(() => {}); }
  return yes;
}
// A build folder: eglantine.exe, or (forks that rename their program: lichii.exe, orchid.exe…) eden-cli.exe beside one
// other program, the biggest that isn't a helper (the command-line tool, the VC++ installer, updaters, uninstallers)
const HELPER_EXE = /^(eden-cli|vc_?redist.*|.*updater.*|.*update\.exe$|unins.*|uninstall.*|crashpad.*|qtwebengineprocess)(\.exe)?$/i;
function buildExe(dir, files) {
  const egl = files.find(e => /^eglantine\.exe$/i.test(e.name)); if (egl) return path.join(dir, egl.name);
  if (!files.some(e => /^eden-cli\.exe$/i.test(e.name))) return null;
  let best = null, size = -1;
  for (const e of files) { if (!/\.exe$/i.test(e.name) || HELPER_EXE.test(e.name)) continue; const p = path.join(dir, e.name); let s = 0; try { s = fs.statSync(p).size; } catch { continue; } if (s > size) { best = p; size = s; } }
  return best;
}
function exesUnder(dir, depth, out) {
  let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  const exe = buildExe(dir, ents.filter(e => e.isFile())); if (exe) out.push(exe);
  for (const e of ents) {
    // (1.82: romfs / exefs / base / updates: an unpacked game's data, when games and builds share a "Switch 2" folder)
    if (e.isDirectory() && depth > 0 && !/^(user|licenses?|plugins|platforms|styles|imageformats|cache|log|sdmc|nand|load|shader|generic|iconengines|networkinformation|tls|translations|romfs|exefs|base|updates?|dlc)$/i.test(e.name)) exesUnder(path.join(dir, e.name), depth - 1, out);
  }
  return out;
}
// "eglantine-windows-x86_64-ec667e25f9ab…" → "ec667e2", "selevet-eglantine-performance-6-windows-x86_64" → "performance 6",
// "PokeDinner-Eglantine-2.1.0" → "PokeDinner 2.1.0", "eglantine-v0.6.0-windows-x86_64mariotennis" → "v0.6.0 mariotennis"
function buildName(folder) {
  let n = String(folder || '');
  const hash = /(?:^|[-_])([0-9a-f]{40})$/i.exec(n); if (hash) return hash[1].slice(0, 7);
  n = n.replace(/windows?|win64|x86_64|x64/gi, ' ').replace(/\b(selevet|eglantine)\b/gi, ' ').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return n ? (/^[a-z]{3,}\b/.test(n) ? n.charAt(0).toUpperCase() + n.slice(1) : n) : 'Eglantine'; // ("lichii pgo" → "Lichii pgo"; "v0.6.0 …" stays)
}
const GROUP_WORDS = /\b(forks?|builds?)\b/gi;
// (1.82) one build outside the build folders (a game's own choice, the shelf's own build), described like the others
async function buildOf(exe, hint) {
  let st; try { st = fs.statSync(exe); } catch { return null; }
  const name = buildName(path.basename(path.dirname(exe)));
  return { exe, group: '', name, label: hint ? `${hint} · ${name}` : name, date: Math.round(st.mtimeMs), nup: await opensNup(exe, st) };
}
// (1.82) the list is kept for 30 s: Play asks for it (the build picker), then the launch asks again, and Settings → Switch 2
// on every visit; each walk reads up to four folders deep on the main thread. Each caller gets its own copy (one sorts it).
const buildsCache = { key: '', at: 0, p: null };
async function builds(roots) {
  const key = (roots || []).map(r => String(r).toLowerCase()).join('|');
  if (!buildsCache.p || buildsCache.key !== key || Date.now() - buildsCache.at > 30000) {
    buildsCache.key = key; buildsCache.at = Date.now();
    buildsCache.p = buildsNow(roots || []).catch(e => { buildsCache.p = null; throw e; });
  }
  return (await buildsCache.p).slice();
}
async function buildsNow(roots) {
  const seen = new Set(), list = [];
  for (const r of roots) for (const exe of exesUnder(r, 4, [])) {
    const k = exe.toLowerCase(); if (seen.has(k)) continue; seen.add(k);
    let st; try { st = fs.statSync(exe); } catch { continue; }
    const rel = path.relative(r, path.dirname(exe)).split(path.sep).filter(Boolean);
    // the group: the first folder under the root when the build sits deeper ("Mario tennis forks"); the build: the
    // innermost folder that isn't just a repeat of its parent's name
    const group = rel.length > 1 ? rel[0].replace(GROUP_WORDS, '').replace(/\s+/g, ' ').trim() : '';
    let leaf = rel[rel.length - 1] || path.basename(path.dirname(exe));
    if (rel.length > 1 && rel[rel.length - 2].toLowerCase().startsWith(leaf.toLowerCase())) leaf = rel[rel.length - 2];
    const name = buildName(leaf);
    list.push({ exe, group, name, label: group && !name.toLowerCase().includes(group.toLowerCase()) ? `${group} · ${name}` : name, date: Math.round(st.mtimeMs), nup: await opensNup(exe, st) });
  }
  return list.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }) || b.date - a.date);
}

module.exports = { find, bootFile, titleId, title, gameRoot, info, fileInfo, tidy, builds, buildOf, setMemoFile };
