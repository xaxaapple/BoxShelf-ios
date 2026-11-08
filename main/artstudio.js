// Art Studio: every version of a game's box art the sources know (LaunchBox, libretro, GameTDB, the picture in use and the
// ones replaced before it), ranked by "looks" (authentic, HD, a region, special edition), applied safely (new file first,
// the old one moved to replaced\, never deleted), with a style per console and per-game part locks auto-fetch respects.
// main.js wires the IPC and hands in env (settings, scanning, the window); everything here validates what the screen sends.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const covers = require('./covers');
const paths = require('./paths');
const steamgrid = require('./steamgrid');
const screenscraper = require('./screenscraper');
const { ART, defaultArtStyle, cleanArtStyle } = require('./config');

const { PARTS, LOOKS, PRESETS, REGIONS } = ART;
const SUFFIX = { front: '', back: '-back', spine: '-spine', disc: '-disc' };
const CACHE_CAP = 300 * 1024 * 1024; // data\art-cand: downloaded candidates (the picker's thumbnails come from these), oldest-used go first
const CACHE_DAYS = 45;
const LIST_MAX = 300; // candidate lists remembered (per game + part): a key the screen sends must be one of these
const sha = s => crypto.createHash('sha1').update(String(s)).digest('hex');
const yieldNow = () => new Promise(r => setImmediate(r));

// ---------- styles and looks (pure) ----------
function styleFor(cfg, sysId) { const base = defaultArtStyle(cfg && cfg.ui), s = cfg && cfg.art && cfg.art.styles && cfg.art.styles[sysId]; return s ? cleanArtStyle(s, base) : base; }
const normLook = (l, style) => l === 'region' ? 'region:' + style.region : LOOKS.includes(l) ? l : null;
// the look one part follows under a style: 'mix' uses only its parts map (a part not set = authentic); the other presets
// apply to every part
function lookFor(style, part) {
  if (!style) return 'authentic';
  if (style.preset === 'mix') return normLook(style.parts && style.parts[part], style) || 'authentic';
  if (style.preset === 'sets') return style.setsHd ? 'hd' : 'region:' + (REGIONS.includes(style.region) ? style.region : 'usa'); // a part no complete set covers
  return style.preset === 'region' ? 'region:' + (REGIONS.includes(style.region) ? style.region : 'usa') : LOOKS.includes(style.preset) ? style.preset : 'authentic';
}
// a game's own region from its file name tags ("(USA)", "(Europe)", "(Japan)")
function gameRegion(game) {
  const r = String((game && game.region) || '');
  return /usa|canada|america/i.test(r) ? 'usa' : /japan/i.test(r) ? 'jpn' : /europe|uk|germany|france|spain|italy|australia|netherlands|sweden|scandinavia/i.test(r) ? 'eur' : '';
}
// authentic = the release of the copy you own (its region), unless an explicit old region choice said otherwise
const prefRegion = (style, game) => (style.regionFirst ? '' : gameRegion(game)) || style.region || 'usa';
function regionForLook(style, look, game) { const m = /^region:(usa|eur|jpn)$/.exec(look || ''); return m ? m[1] : look === 'authentic' ? prefRegion(style, game) : (style.region || 'usa'); }
// what decides a part's choice: two styles with the same signature pick the same picture (a re-pick can skip it)
const lookSig = (style, part, game) => { const l = lookFor(style, part); return (style.preset === 'sets' ? 'set:' : '') + l + (l === 'authentic' ? '|' + prefRegion(style, game) + (style.sharper ? '+' : '') : l === 'special' || l === 'hd' ? '|' + prefRegion(style, game) : ''); };

// ---------- ranking ----------
// longest side in pixels: known once downloaded, otherwise what each source usually has
function est(c) {
  if (c.w && c.h) return Math.max(c.w, c.h);
  if (c.kind === 'hd') return 1400;
  if (c.source === 'launchbox') return c.cut ? 1900 : c.kind === 'scan' ? 1200 : 1000;
  return c.source === 'libretro' ? 500 : c.source === 'gametdb' ? (c.cut ? 1000 : 500) : 600;
}
const regPts = (c, want, hit, miss) => c.region === want ? hit : c.region === 'world' || !c.region ? miss : 0;
// SteamGridDB posters are community-made, not a release's box: never an authentic, region or special-edition pick (they stay
// in the list for Pick exact, and HD may choose one on its size)
const SG_OFF = 100;
const isSg = c => c.source === 'steamgriddb';
function authenticPts(c, pref, sharp) {
  if (isSg(c)) return -SG_OFF + (c.rank ? -Math.min(c.rank, 40) / 10 : 0);
  const ed = c.edition === 'original' ? 30 : c.edition === 'special' ? 12 : c.edition === 'reprint' ? 0 : 20;
  const kind = c.fan ? -15 : c.kind === 'clean' ? 4 : 8;
  // sharper on: a bigger scan of the same kind wins the tie; off: libretro's covers (named like the files) first, as before
  return ed + regPts(c, pref, 20, 10) + kind + (c.exact ? 6 : 0) + (sharp ? Math.min(12, est(c) / 150) : c.source === 'libretro' ? 3 : 0) + (c.inUse ? 2 : 0);
}
// (a SteamGridDB poster: its real size, plus a little for SteamGridDB's own order, so its best-voted one leads its others)
const hdPts = (c, pref) => est(c) / 40 + regPts(c, pref, 3, 1) + (c.edition === 'original' ? 2 : 0) - (c.fan ? 5 : 0) + (c.inUse ? 1 : 0) + (isSg(c) ? Math.max(0, 2 - (c.rank || 0) * .2) : 0);
const regionPts = (c, R, sharp) => regPts(c, R, 40, 12) + authenticPts(c, R, sharp) / 4;
const specialPts = (c, pref, sharp) => (isSg(c) ? -SG_OFF : 0) + (c.edition === 'special' ? 50 : c.edition === 'original' ? 20 : 0) + regPts(c, pref, 10, 5) + (c.fan ? -15 : c.kind === 'clean' ? 4 : 8) + (sharp ? est(c) / 300 : 0) + (c.inUse ? 2 : 0);
const r1 = x => Math.round(x * 10) / 10;
// ctx: { style, game, sharp? } → { authentic, hd, region (the style's region), special }
function scores(c, ctx) {
  const st = ctx.style || defaultArtStyle({}), pref = prefRegion(st, ctx.game), sharp = ctx.sharp != null ? ctx.sharp : !!st.sharper;
  return { authentic: r1(authenticPts(c, pref, sharp)), hd: r1(hdPts(c, pref)), region: r1(regionPts(c, st.region || 'usa', sharp)), special: r1(specialPts(c, pref, sharp)) };
}
function rankScore(c, look, ctx) {
  if (c.source === 'made') return -1000; // made from the cover: only when nothing real was found
  const st = ctx.style || defaultArtStyle({}), pref = prefRegion(st, ctx.game), sharp = ctx.sharp != null ? ctx.sharp : !!st.sharper, m = /^region:(usa|eur|jpn)$/.exec(look || '');
  return m ? regionPts(c, m[1], sharp) : look === 'hd' ? hdPts(c, pref) : look === 'special' ? specialPts(c, pref, sharp) : authenticPts(c, pref, sharp);
}
// best first; ties keep the given order (sources come in their own preference order)
function rankList(list, look, ctx) { return list.map((c, i) => ({ c, i, s: rankScore(c, look, ctx) })).sort((a, b) => b.s - a.s || a.i - b.i).map(x => x.c); }

// ---------- state ----------
let env = null, candDir = null, log = () => {};
const lists = new Map(); // "<gameKey>|<part>" → { list:[cand], byKey: Map }
const gamesMemo = new Map(); // systemId → { at, list, byFile }
const jobs = new Map();
const gameChain = new Map(); // one change at a time per game (the picker and a restyle job never write the same files together)
// styles a console's pictures may still be in: a restyle cancelled (by hand, by a newer style, or offline) leaves some games
// in the style before it, so the next one compares against every one of these, not only the last saved style
const stale = new Map(); // systemId → [style]
let REFRESH_MS = 10000; // a long restyle refreshes the shelf this often (not per picture: each refresh is a library rescan)
let jobN = 0, addedBytes = 0, pruning = null, thumbGen = 0;

function init(e) {
  env = e; log = e.log || log; candDir = path.join(e.dataDir, 'art-cand'); provFile = path.join(e.dataDir, 'art-provenance.json'); prov = null;
  try { fs.mkdirSync(candDir, { recursive: true }); } catch {}
  covers.setOnPlaced(recordPlaced); // every picture placed from now on is on record as Boxshelf's (or the user's own pick)
  const t = setTimeout(() => pruneCache().catch(() => {}), e.pruneDelay != null ? e.pruneDelay : 20000); if (t.unref) t.unref(); // cleaned on start, once the busy start-up is over
  // first start of 1.68: note every picture already there (see migrate) once the busy start-up is over
  const m = setTimeout(() => { if (!provGet().at) migrate().catch(x => log('Art provenance: first look failed', x.message)); }, e.migrateDelay != null ? e.migrateDelay : 15000); if (m.unref) m.unref();
}
const cacheDir = () => candDir;
const lockKey = (sysId, file) => sysId + '|' + path.resolve(String(file)).toLowerCase();
const cfg = () => env.getCfg();
// the saved entry: { front: {look,key}, …, all?: {at, sig} } (all = the whole game locked as it is)
function locksOf(sysId, file) { const a = cfg().art; return (a && a.locks && a.locks[lockKey(sysId, file)]) || {}; }
const FROZEN = { look: 'exact', key: 'frozen' };
// what automatic work must leave alone: a locked game's every part (missing ones too), else the parts locked one by one
function effLocks(e) { if (!e || !e.all) return e || {}; const o = {}; for (const p of PARTS) o[p] = e[p] || FROZEN; return o; }
// auto-fetch asks this per game: { front: {look,key}, … } for the parts it must leave alone
const lockedFor = (sysId, file) => effLocks(locksOf(sysId, file));
function setLock(sysId, file, part, val) {
  const a = cfg().art || { styles: {}, locks: {} }, k = lockKey(sysId, file), locks = { ...(a.locks || {}) }, e = { ...(locks[k] || {}) };
  if (val) e[part] = { ...val, at: Date.now() }; else delete e[part];
  if (Object.keys(e).length) locks[k] = e; else delete locks[k];
  env.setArt({ ...a, locks });
}
// many lock changes in one settings save (a whole console's kept pictures would otherwise write config.json per part).
// fn(entries) edits a copy of the locks map: { "<lockKey>": entry }
function editLocks(fn) { const a = cfg().art || { styles: {}, locks: {} }, locks = { ...(a.locks || {}) }; const r = fn(locks); for (const k of Object.keys(locks)) if (!locks[k] || !Object.keys(locks[k]).length) delete locks[k]; env.setArt({ ...a, locks }); return r; }

// ---------- provenance: which pictures Boxshelf wrote ----------
// data\art-provenance.json: { v, at, files: { "<path lower-case>": [origin, bytes, mtime] }, base: { "<path>": [bytes, mtime] } }.
// files = every picture Boxshelf placed since 1.68 (covers.placeArt reports each one). base = the pictures that were already
// there the first time 1.68 started (at = when), whose origin nothing on disk can tell (cover-checks.json keeps only when a
// game was last looked at, the log only counts per run, data\art-cand only the 1.67 picker's downloads). A picture in
// neither was put there by hand after that. The record matches a file only while its size and date are the same: one the
// user overwrote by hand counts as theirs again.
const PROV_V = 1; let prov = null, provFile = null, provT = null, migrating = null, provPruned = 0;
const pk = f => path.resolve(String(f)).toLowerCase();
function provGet() {
  if (prov) return prov;
  try { const j = JSON.parse(fs.readFileSync(provFile, 'utf8')); if (j && j.v === PROV_V && j.files && typeof j.files === 'object' && j.base && typeof j.base === 'object') prov = { v: PROV_V, at: +j.at || 0, files: j.files, base: j.base }; } catch {}
  return prov || (prov = { v: PROV_V, at: 0, files: {}, base: {} });
}
function provSave(now) {
  clearTimeout(provT); const go = () => { provT = null; if (!prov || !provFile) return; const p = prov, n = Object.keys(p.files).length + Object.keys(p.base).length;
    if (n > 80000 && Date.now() - provPruned > 6 * 3600e3) { provPruned = Date.now(); for (const m of [p.files, p.base]) for (const k of Object.keys(m)) if (!paths.isFile(k)) delete m[k]; } // pictures long gone (moved to replaced\, games removed); a check of every file on this thread, so at most every 6 h
    const tmp = provFile + '.tmp'; fs.promises.writeFile(tmp, JSON.stringify(p)).then(() => fs.promises.rename(tmp, provFile)).catch(e => log('Art provenance: could not save', e.message)); };
  if (now) go(); else { provT = setTimeout(go, 1500); if (provT.unref) provT.unref(); }
}
const statOf = f => { try { const st = fs.statSync(f); return st.isFile() ? [st.size, Math.round(st.mtimeMs)] : null; } catch { return null; } };
const sameStat = (r, st) => !!r && !!st && r[0] === st[0] && Math.abs(r[1] - st[1]) <= 2000; // FAT / network drives keep 2 s dates
function record(file, origin) { const st = statOf(file); if (!st) return; const p = provGet(), k = pk(file); p.files[k] = [origin, st[0], st[1]]; delete p.base[k]; provSave(); }
// main.js hands over its back / spine makers: (sysId, title, frontFile) → JPEG Buffer | null
let maker = {}; function setMaker(m) { maker = m || {}; }
function recordPlaced(dest, origin) { record(dest, ['auto', 'studio', 'own', 'restored', 'adopted', 'copied', 'poster'].includes(origin) ? origin : 'auto'); }
// a front the automatic art check took from SteamGridDB because no real box scan existed: the next check replaces it
// with a real scan as soon as one turns up (any other front is left alone)
function isPoster(file) { const st = statOf(file); if (!st) return false; const r = provGet().files[pk(file)]; return !!r && r[0] === 'poster' && sameStat([r[1], r[2]], st); }
// 'boxshelf' (Boxshelf wrote it, or the user let a style manage it), 'own' (a picture the user chose through Boxshelf),
// 'legacy' (there before 1.68, origin unknown), 'hand' (put there by hand since), null (no such file)
function originOf(file) {
  const st = statOf(file); if (!st) return null; const p = provGet(), k = pk(file), r = p.files[k];
  if (r && sameStat([r[1], r[2]], st)) return r[0] === 'own' ? 'own' : 'boxshelf';
  return p.base[k] && sameStat(p.base[k], st) ? 'legacy' : 'hand';
}
// may automatic work (auto-fetch's HD upgrade) replace this file? Only one Boxshelf wrote. explicit: "Download box art now"
// with HD, which the user starts and which says it replaces low-res art, may also upgrade pictures from before 1.68
const mayReplace = (file, explicit) => { const o = originOf(file); return o === 'boxshelf' || (!!explicit && o === 'legacy'); };
// the art library copies pictures from beside the games: a copy is what its original was
function copied(src, dest) { const o = originOf(src); if (o === 'boxshelf' || o === 'own') record(dest, o === 'own' ? 'own' : 'copied'); }
// the user let the shelf style manage these (unlocked a game, released kept pictures, chose Shelf style): from now on they're Boxshelf's
function adopt(files) { let n = 0; for (const f of files) { if (!f || !statOf(f)) continue; const o = originOf(f); if (o === 'boxshelf') continue; record(f, o === 'own' ? 'own' : 'adopted'); n++; } return n; }
// first start of 1.68: every picture already on a shelf goes into base, except the ones byte-identical to a picture the 1.67
// Art Studio downloaded into data\art-cand (those are Boxshelf's for sure). Nothing is locked here: the background auto-fetch
// never replaces a 'legacy' picture (mayReplace); a shelf style change does (the lock rule above startRestyle)
function migrate() {
  if (migrating) return migrating;
  migrating = (async () => {
    const p = provGet(); if (p.at) return p;
    const bySize = new Map(); let names = []; try { names = await fs.promises.readdir(candDir); } catch {}
    for (const n of names) { if (n.startsWith('.')) continue; const f = path.join(candDir, n), st = statOf(f); if (st) { if (!bySize.has(st[0])) bySize.set(st[0], []); bySize.get(st[0]).push(f); } }
    let legacy = 0, mine = 0;
    for (const { def } of env.consoles()) {
      let list = []; try { list = (await gamesFor(def.id, true)).list; } catch { continue; }
      for (let i = 0; i < list.length; i++) { if (i % 40 === 0) await yieldNow(); const g = list[i];
        for (const part of PARTS) { const f = g.art && g.art[part], k = f && pk(f); if (!f || p.files[k]) continue; const st = statOf(f); if (!st) continue;
          const twins = bySize.get(st[0]); let same = false;
          if (twins) { try { const b = await fs.promises.readFile(f); for (const t of twins) { try { if (b.equals(await fs.promises.readFile(t))) { same = true; break; } } catch {} } } catch {} }
          if (same) { p.files[k] = ['studio', st[0], st[1]]; mine++; } else { p.base[k] = st; legacy++; } } }
    }
    p.at = Date.now(); provSave(true); log('Art provenance: first look,', legacy, 'pictures from before (kept if a shelf style would replace them),', mine, 'from the 1.67 Art Studio');
    return p;
  })().finally(() => { migrating = null; });
  return migrating;
}
// the record is ready (the first look done); a cover download waits for it, at most `ms`
async function ready(ms = 20000) { if (provGet().at) return true; let t; const late = new Promise(r => { t = setTimeout(r, ms); }); await Promise.race([migrate().catch(() => {}), late]); clearTimeout(t); return !!provGet().at; }

// ---------- validation ----------
function needObj(a) { if (!a || typeof a !== 'object' || Array.isArray(a)) throw new Error('Bad request.'); return a; }
function sysArg(a) {
  const id = String(needObj(a).systemId || ''), item = env.consoles().find(x => x.def.id === id);
  if (!item) throw new Error('Unknown system.'); return item;
}
function partArg(p) { if (!PARTS.includes(p)) throw new Error('Unknown part.'); return p; }
// a game the scanner finds on that shelf: { sysId, def, sc, game, dir, base, key }
async function gameArg(a) {
  const { def, sc } = sysArg(a); if (typeof a.file !== 'string' || !a.file || a.file.length > 4096) throw new Error('Bad game.');
  const file = env.gameFile(def.id, a.file).file; // inside one of that console's games folders, or it throws
  const want = path.resolve(file).toLowerCase();
  let g = (await gamesFor(def.id)).byFile.get(want);
  if (!g) g = (await gamesFor(def.id, true)).byFile.get(want);
  if (!g) throw new Error('That game is not on this shelf.');
  return { sysId: def.id, def, sc, game: g, dir: paths.artDirFor(sc, g.file), base: paths.artBase(g.file), key: lockKey(def.id, g.file) };
}
async function gamesFor(sysId, fresh) {
  const m = gamesMemo.get(sysId); if (m && !fresh && Date.now() - m.at < 60000) return m;
  const item = env.consoles().find(x => x.def.id === sysId); if (!item) throw new Error('Unknown system.');
  await yieldNow(); const list = (await env.scan(item.def, item.sc, !!fresh)).filter(g => g.kind !== 'app'); // (beta.9: fresh reads the folders again, past the scanner's kept scan; beta.10: env.scan is the async scan)
  const byFile = new Map(list.map(g => [path.resolve(g.file).toLowerCase(), g]));
  const r = { at: Date.now(), list, byFile }; gamesMemo.set(sysId, r); return r;
}
// where a part's picture is now (the scanner's own order: art folders in turn, file name then title)
function findPart(sc, game, part) {
  const names = [...new Set([paths.artBase(game.file), game.title])];
  for (const d of paths.artDirsFor(sc)) for (const n of names) for (const e of covers.ART_EXT) { const f = path.join(d, `${n}${SUFFIX[part]}.${e}`); if (paths.isFile(f)) return f; }
  return null;
}
const artView = game => Object.fromEntries(PARTS.map(p => [p, game.art && game.art[p] ? env.fileUrl(game.art[p]) : null]));

// ---------- the candidate cache (data\art-cand) ----------
const cachePath = c => path.join(candDir, sha(c.url + '|' + (c.cut || '')).slice(0, 24) + c.ext);
function fileInfo(f) { try { const st = fs.statSync(f); if (!st.isFile()) return null; const z = covers.sizeOf(f); return { bytes: st.size, w: z ? z[0] : null, h: z ? z[1] : null }; } catch { return null; } }
const touch = f => { const now = new Date(); fs.promises.utimes(f, now, now).catch(() => {}); }; // "last used" for the cache's clean-up (atime isn't kept on many Windows disks)
let slotsFree = 3; const slotQ = [];
async function slot(fn) { // at most three downloads at once, everything together (the picker, a restyle, a mix)
  if (slotsFree > 0) slotsFree--; else await new Promise(r => slotQ.push(r));
  try { return await fn(); } finally { const n = slotQ.shift(); if (n) n(); else slotsFree++; }
}
// addresses that answered 404 (or not a picture): not offered again for a week (data\art-missing.json). A timeout or a
// server error isn't remembered: those are tried again next time
const MISS_DAYS = 7; let miss = null, missT = null;
function missMap() { if (miss) return miss; miss = new Map(); try { const j = JSON.parse(fs.readFileSync(path.join(env.dataDir, 'art-missing.json'), 'utf8')); const old = Date.now() - MISS_DAYS * 864e5; for (const [u, t] of Object.entries(j || {})) if (+t > old) miss.set(u, +t); } catch {} return miss; }
const isMissing = url => { const t = missMap().get(url); return !!t && Date.now() - t < MISS_DAYS * 864e5; };
function markMissing(url) { const m = missMap(); m.set(url, Date.now()); while (m.size > 20000) m.delete(m.keys().next().value);
  clearTimeout(missT); missT = setTimeout(() => { const f = path.join(env.dataDir, 'art-missing.json'); fs.promises.writeFile(f + '.tmp', JSON.stringify(Object.fromEntries(m))).then(() => fs.promises.rename(f + '.tmp', f)).catch(() => {}); }, 2000); if (missT.unref) missT.unref(); }
// (ScreenScraper media: signed with the account only for the request, inside screenscraper.download)
async function dl(url, dest) { const r = screenscraper.isMedia(url) ? await screenscraper.download(url, dest) : await covers.downloadEx(url, dest); if (r === 'missing') markMissing(url); return r === 'ok'; }
// a candidate as a local file: the cached copy, else downloaded (a spine cut from its wrap). keep=false: a temp file the
// caller removes (a restyle shouldn't push the picker's thumbnails out of the cache). null = not there; throws when offline.
async function fetchCand(c, sysId, keep = true) {
  if (c.file) return paths.isFile(c.file) ? c.file : null;
  const cached = cachePath(c); if (paths.isFile(cached)) { touch(cached); return cached; }
  // the same picture already downloading (the picker's thumbnails and a set, say): wait for that one rather than racing it
  // into the same cache file
  if (keep && inflight.has(cached)) return inflight.get(cached);
  const dest = keep ? cached : path.join(candDir, `.tmp-${process.pid}-${crypto.randomUUID()}${c.ext}`);
  const run = fetchCand0(c, sysId, keep, dest); if (!keep) return run;
  inflight.set(cached, run); run.finally(() => inflight.delete(cached)).catch(() => {}); return run;
}
const inflight = new Map(); // cache file → its download
function fetchCand0(c, sysId, keep, dest) {
  return slot(async () => {
    if (c.made) { const buf = c.madeKind ? (maker[c.madeKind] ? await maker[c.madeKind](sysId, c.madeTitle, c.made) : null) : await covers.makeCart(c.made, sysId); if (!buf) return null; await fs.promises.writeFile(dest + '.part', buf); await fs.promises.rename(dest + '.part', dest); }
    else if (!c.cut) { if (!await dl(c.url, dest)) return null; }
    else {
      const raw = path.join(candDir, `.raw-${process.pid}-${crypto.randomUUID()}${c.src || '.jpg'}`);
      try { if (!await dl(c.url, raw)) return null; const buf = c.cut === 'back' ? await covers.cutBack(raw, sysId) : await covers.cutSpine(raw, sysId); if (!buf) return null; // (cut 'back': GameTDB full covers, 1.71)
        await fs.promises.writeFile(dest + '.part', buf); await fs.promises.rename(dest + '.part', dest); }
      finally { fs.promises.unlink(raw).catch(() => {}); fs.promises.unlink(dest + '.part').catch(() => {}); }
    }
    const inf = fileInfo(dest);
    if (!inf || (!inf.w && c.ext !== '.webp')) { fs.promises.unlink(dest).catch(() => {}); return null; } // an error page, not a picture
    if (keep) { addedBytes += inf.bytes; if (addedBytes > 32 * 1024 * 1024) { addedBytes = 0; pruneCache().catch(() => {}); } }
    return dest;
  });
}
// oldest-used first beyond the cap, anything unused for CACHE_DAYS, and temp leftovers from a crash
function pruneCache(cap = CACHE_CAP) {
  if (pruning) return pruning;
  pruning = (async () => {
    let names = []; try { names = await fs.promises.readdir(candDir); } catch { return 0; }
    const list = [], old = Date.now() - CACHE_DAYS * 864e5; let gone = 0;
    for (const n of names) { const f = path.join(candDir, n); let st; try { st = await fs.promises.stat(f); } catch { continue; } if (!st.isFile()) continue;
      if (/^\.(tmp|raw)-|\.part$/.test(n)) { if (Date.now() - st.mtimeMs > 3600e3) { await fs.promises.unlink(f).catch(() => {}); gone++; } continue; }
      list.push({ f, t: st.mtimeMs, s: st.size }); }
    list.sort((a, b) => b.t - a.t); let total = 0;
    for (const x of list) { total += x.s; if (x.t < old || total > cap) { try { await fs.promises.unlink(x.f); gone++; } catch {} } }
    if (gone) log('Art Studio: cleared', gone, 'cached pictures');
    return gone;
  })().finally(() => { pruning = null; });
  return pruning;
}

// ---------- candidate lists ----------
const sameImage = (a, b) => { const x = typeof a === 'string' ? fileInfo(a) : a, y = typeof b === 'string' ? fileInfo(b) : b; return !!x && !!y && x.bytes === y.bytes && x.w === y.w && x.h === y.h; };
const dateWord = st => { const m = /^(\d{4})-(\d\d)-(\d\d)/.exec(st); if (!m) return ''; return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); };
function localCand(file, source, extra) {
  const inf = fileInfo(file) || {};
  return { key: (source === 'current' ? 'c' : 'e') + sha(path.resolve(file).toLowerCase()).slice(0, 15), source, file, ext: path.extname(file).toLowerCase(), region: '', edition: 'original', kind: 'scan', w: inf.w || null, h: inf.h || null, bytes: inf.bytes || 0, inUse: source === 'current', ...extra };
}
// builds (or reuses) the server's list for one game + part: the only keys art:use accepts, the only addresses ever fetched
async function listFor(g, part, opts = {}) {
  const lk = g.key + '|' + part, have = lists.get(lk);
  if (have && !opts.fresh) { lists.delete(lk); lists.set(lk, have); return have; } // most recently used last (the map is the LRU)
  const style = styleFor(cfg(), g.sysId);
  const [remote, sg, ss] = await Promise.all([covers.candidates(g.sysId, g.game, part, { region: style.region, lrWait: opts.lrWait }), sgCands(g, part, opts), ssCands(g, part, opts)]);
  remote.push(...sg, ...ss);
  const list = [];
  const cur = g.game.art && g.game.art[part];
  if (cur && paths.isFile(cur)) list.push(localCand(cur, 'current', { label: 'Current' }));
  for (const c of remote) {
    if (isMissing(c.url)) continue; // a 404 this week: not offered
    const k = 'r' + sha(c.url + '|' + (c.cut || '')).slice(0, 15), inf = fileInfo(cachePath(c)); if (inf) touch(cachePath(c)); // shown again: recently used
    list.push({ ...c, key: k, w: inf ? inf.w : c.w || null, h: inf ? inf.h : c.h || null, bytes: inf ? inf.bytes : 0, cached: !!inf, inUse: false }); // (SteamGridDB says its sizes up front)
  }
  // a Switch / 3DS cartridge drawn from the game's own front cover (1.73.5): always offered, ranked last, so a game that no
  // source has a cartridge photo of still gets one (its address names the cover and its date: a new cover makes a new one)
  const front = g.game.art && g.game.art.front;
  if (part === 'disc' && covers.CART_SYS.has(g.sysId) && front && paths.isFile(front)) {
    let st = null; try { st = fs.statSync(front); } catch {}
    if (st) { const c = { url: 'made:cart:' + sha(path.resolve(front).toLowerCase() + '|' + st.size + '|' + Math.round(st.mtimeMs)).slice(0, 24), made: front, ext: '.png', source: 'made', type: 'cart', region: '', edition: 'original', kind: 'clean', label: 'Cartridge made from the cover' };
      const inf = fileInfo(cachePath(c)); list.push({ ...c, key: 'r' + sha(c.url).slice(0, 15), w: inf ? inf.w : null, h: inf ? inf.h : null, bytes: inf ? inf.bytes : 0, cached: !!inf, inUse: false }); }
  }
  // a back and a spine Boxshelf makes itself (main.js renderBack / renderSpine: the console's style, the game's own
  // artwork, screenshots and logo), offered for every game whatever the sources have, ranked after every real scan
  if ((part === 'back' || part === 'spine') && maker[part] && front && paths.isFile(front)) {
    let st = null; try { st = fs.statSync(front); } catch {}
    if (st) { const title = String(g.game.title || ''), c = { url: `made:${part}:` + sha(path.resolve(front).toLowerCase() + '|' + st.size + '|' + Math.round(st.mtimeMs) + '|' + title).slice(0, 24), made: front, madeKind: part, madeTitle: title, ext: '.jpg', source: 'made', type: part, region: '', edition: 'original', kind: 'clean', label: part === 'back' ? 'Back made by Boxshelf' : 'Spine made by Boxshelf' };
      const inf = fileInfo(cachePath(c)); list.push({ ...c, key: 'r' + sha(c.url).slice(0, 15), w: inf ? inf.w : null, h: inf ? inf.h : null, bytes: inf ? inf.bytes : 0, cached: !!inf, inUse: false }); }
  }
  const dirs = [...new Set([g.dir, cur ? path.dirname(cur) : null].filter(Boolean))];
  for (const d of dirs) for (const r of covers.replacedFor(d, g.base, SUFFIX[part]).slice(0, 12)) list.push(localCand(r.file, 'earlier', { inUse: false, label: 'Earlier' + (dateWord(r.stamp) ? ' · ' + dateWord(r.stamp) : '') }));
  dedupe(list);
  const entry = { list, byKey: new Map(list.map(c => [c.key, c])), g };
  lists.set(lk, entry); while (lists.size > LIST_MAX) lists.delete(lists.keys().next().value);
  return entry;
}
// SteamGridDB posters for the Front (only with the user's key; Settings → Accounts & services). opts.sgdb false: not asked
// (a restyle to a look that never picks them). The picker waits a few seconds at most: a slower answer is still cached for
// the next time the part opens.
async function sgCands(g, part, opts) {
  if (part !== 'front' || opts.sgdb === false || !steamgrid.enabled()) return [];
  const match = (list, game, exact) => covers.matchTitle(list.map(x => ({ ...x, n: covers.norm(x.name) })), game.title, undefined, !!exact);
  let t; const late = new Promise(r => { t = setTimeout(() => r([]), opts.sgWait || 3500); });
  const got = await Promise.race([steamgrid.posters({ ...g.game, names: covers.lookupNames(g.game && g.game.title) }, match), late]); clearTimeout(t);
  return got.map(p => {
    const hd = Math.max(p.w, p.h) >= covers.HD_MIN.front;
    return { url: p.url, thumbUrl: p.thumbUrl, ext: p.ext, source: 'steamgriddb', type: 'grid', region: '', edition: 'original', kind: hd ? 'hd' : 'clean', w: p.w, h: p.h, rank: p.rank, apiSize: true,
      label: ['SteamGridDB', p.styleName, p.author ? 'by ' + p.author : ''].filter(Boolean).join(' · ') };
  });
}
// ScreenScraper (1.71; only with the user's account): real box scans by region for every part, matched by the ROM. A restyle job
// (opts.job) uses only lookups already cached, so a whole console's restyle never spends the account's daily quota; the picker
// asks, and waits a few seconds at most (a slower answer is cached for the next time)
async function ssCands(g, part, opts) {
  if (opts.ss === false || !screenscraper.configured()) return [];
  const match = (list, game) => covers.matchName(list.map(x => ({ ...x, n: covers.norm(x.name) })), game.title);
  let t; const late = new Promise(r => { t = setTimeout(() => r([]), opts.ssWait || 4000); });
  const got = await Promise.race([screenscraper.candidates(g.sysId, g.game, part, { cacheOnly: !!opts.ssCacheOnly, match, discId: covers.discId, canCut: covers.canCut ? covers.canCut() : true }), late]); clearTimeout(t);
  return got;
}
// identical pictures (same bytes + same size) show once: the one in use is the downloaded copy it matches
function dedupe(list) {
  const cur = list.find(c => c.source === 'current');
  for (let i = 0; i < list.length; i++) { const c = list[i]; if (c.dup || !c.bytes) continue;
    for (let j = i + 1; j < list.length; j++) { const d = list[j]; if (d.dup || !d.bytes || !sameImage(c, d)) continue;
      if (c === cur) { d.inUse = true; c.dup = d.key; break; } else d.dup = c.key; } }
  return list;
}
// a SteamGridDB poster's small preview (its API gives one): the picker shows that rather than downloading every full poster
const thumbPath = c => c.thumbUrl ? cachePath({ url: c.thumbUrl, ext: /\.png(\?|$)/i.test(c.thumbUrl) ? '.png' : /\.webp(\?|$)/i.test(c.thumbUrl) ? '.webp' : '.jpg' }) : null;
function thumbOf(c) { let f = c.file || (c.cached || c.w || c.bytes ? cachePath(c) : null); if ((!f || !paths.isFile(f)) && c.thumbUrl) f = thumbPath(c); if (!f || !paths.isFile(f)) return null; const u = env.fileUrl(f); return u + (u.includes('?') ? '&' : '?') + 't=360'; }
// the preview into the cache (the same three download slots): the file, or null
async function fetchThumb(c) {
  const dest = thumbPath(c); if (paths.isFile(dest)) { touch(dest); return dest; }
  return slot(async () => { if (!await dl(c.thumbUrl, dest)) return null; const inf = fileInfo(dest); if (!inf || (!inf.w && !dest.endsWith('.webp'))) { fs.promises.unlink(dest).catch(() => {}); return null; } if (inf) addedBytes += inf.bytes; return dest; });
}
function pub(c, g) {
  const ctx = { style: styleFor(cfg(), g.sysId), game: g.game };
  return { key: c.key, source: c.source, region: c.region || '', edition: c.edition || 'original', kind: c.kind || 'scan', label: c.label || '', w: c.w || null, h: c.h || null, thumb: thumbOf(c), inUse: !!c.inUse, score: scores(c, ctx) };
}
// downloads the list's pictures in the background (three at a time, the newest request first) and tells the screen as
// each arrives; a newer request makes an older one stop after the downloads already under way
function warm(entry, part) {
  const gen = ++thumbGen, g = entry.g, todo = entry.list.filter(c => !c.file && !c.cached && !c.failed && !c.thumbFailed && !(c.thumbUrl && paths.isFile(thumbPath(c))));
  const send = (c, extra) => env.send('art:cand', { systemId: g.sysId, file: g.game.file, part, key: c.key, thumb: thumbOf(c), w: c.w || null, h: c.h || null, inUse: !!c.inUse, score: scores(c, { style: styleFor(cfg(), g.sysId), game: g.game }), ...extra });
  return covers.pool(todo, 3, async c => {
    // a newer request took over the downloads: say this one isn't coming (the screen mustn't wait for it); it isn't marked
    // failed here, so the next request for this part tries it again
    if (gen !== thumbGen) { send(c, { failed: true, cancelled: true }); return; } let f = null;
    if (c.thumbUrl) { // SteamGridDB: its preview only (the size is known); the full poster is fetched when it's used
      try { f = await fetchThumb(c); } catch (e) { log('Art Studio: candidate', e.message); }
      if (!f) { c.thumbFailed = true; send(c, { failed: true }); } else send(c, {}); return; } // (a missing preview doesn't stop the poster itself being used)
    try { f = await fetchCand(c, g.sysId, true); } catch (e) { log('Art Studio: candidate', e.message); }
    if (!f) { c.failed = true; send(c, { failed: true }); return; }
    const inf = fileInfo(f) || {}; Object.assign(c, { w: inf.w || null, h: inf.h || null, bytes: inf.bytes || 0, cached: true });
    const before = entry.list.filter(x => x.dup).map(x => x.key); dedupe(entry.list);
    for (const x of entry.list) if (x !== c && x.dup && !before.includes(x.key)) send(x, { dup: x.dup }); // the current file turned out to be this one
    send(c, c.dup ? { dup: c.dup } : c.guess ? { cand: pub(c, g) } : {});
  }).catch(e => log('Art Studio: thumbnails', e.message));
}

// ---------- applying ----------
function withGame(k, fn) { const prev = gameChain.get(k) || Promise.resolve(); const run = prev.catch(() => {}).then(fn); const tail = run.catch(() => {}); gameChain.set(k, tail); tail.then(() => { if (gameChain.get(k) === tail) gameChain.delete(k); }); return run; }
const incoming = (g, part, ext) => path.join(g.dir, `${g.base}${SUFFIX[part]}.incoming-${crypto.randomUUID().slice(0, 8)}${ext}`);
// (any change to a game's pictures ends its Undo set: that Undo would put back the wrong ones; useSet records its own afterwards)
async function placed(g, part, dest) { env.placed(dest); g.game.art = { ...(g.game.art || {}), [part]: findPart(g.sc, g.game, part) || dest }; lists.delete(g.key + '|' + part); lastSet.delete(g.key); }
// a picture from replaced\ back in use (the one in use goes to replaced\ in its turn)
async function restore(g, part, file) {
  const ext = path.extname(file).toLowerCase(); await fs.promises.mkdir(g.dir, { recursive: true });
  const inc = incoming(g, part, ext);
  try { await fs.promises.rename(file, inc); } catch (e) { if (e.code === 'ENOENT') throw new Error('That earlier picture is no longer there.'); throw e; } // out of replaced\ first: placeArt mustn't see it as an old one
  let r; try { r = await covers.placeArt(g.dir, g.base, SUFFIX[part], inc, ext, 'restored'); } catch (e) { await fs.promises.rename(inc, file).catch(() => {}); throw e; }
  await placed(g, part, r.dest); return true;
}
// puts candidate c in use for this part; false when it's what's there already. src: the file pickBest already fetched;
// keep=false: a download made here doesn't stay in the cache (a restyle shouldn't push the picker's pictures out)
async function apply(g, part, c, keep = true, src = null) {
  if (c.source === 'current') return false;
  if (c.source === 'earlier') return restore(g, part, c.file);
  if (!src) src = await fetchCand(c, g.sysId, keep); if (!src) throw new Error("That picture couldn't be downloaded.");
  const temp = path.basename(src).startsWith('.tmp-');
  try {
    const cur = g.game.art && g.game.art[part];
    if (cur && paths.isFile(cur) && sameImage(cur, src)) return false; // the same picture: nothing moves
    await fs.promises.mkdir(g.dir, { recursive: true });
    const inc = incoming(g, part, c.ext); await fs.promises.copyFile(src, inc);
    let r; try { r = await covers.placeArt(g.dir, g.base, SUFFIX[part], inc, c.ext, 'studio'); } catch (e) { await fs.promises.unlink(inc).catch(() => {}); throw e; }
    await placed(g, part, r.dest); log('Art Studio:', g.sysId, path.basename(g.game.file), part, '<-', c.source, c.label || ''); return true;
  } finally { if (temp) fs.promises.unlink(src).catch(() => {}); }
}
// the best picture for a look that can actually be had → { c, src } (src: its local file; a temp one with keep=false that
// apply() removes), or null. The one in use wins when it ranks first. HD looks at real sizes before choosing.
async function pickBest(g, part, look, opts = {}) {
  const entry = await listFor(g, part, { fresh: opts.fresh, lrWait: opts.lrWait, sgdb: look === 'hd', sgWait: opts.job ? 15000 : 6000, ssCacheOnly: !!opts.job, ssWait: opts.job ? 2000 : 6000 }), style = styleFor(cfg(), g.sysId);
  const ctx = { style, game: g.game, sharp: look === 'hd' || (!!style.sharper && look === 'authentic') };
  // only HD may choose a SteamGridDB poster (Authentic, a region or Special must be a real release's box)
  let order = rankList(entry.list.filter(c => c.source !== 'earlier' && !c.failed && !(c.dup && c.source === 'current') && (look === 'hd' || c.source !== 'steamgriddb')), look, ctx);
  const stop = () => !!(opts.job && opts.job.c);
  if (look === 'hd') { // sizes are guesses until downloaded: fetch the likeliest few, then rank on what they really are
    for (const c of order.filter(c => !c.file && !c.cached && !c.apiSize).slice(0, 4)) { if (stop()) return null; try { const f = await fetchCand(c, g.sysId, true); if (f) Object.assign(c, fileInfo(f) || {}, { cached: true }); else c.failed = true; } catch (e) { if (opts.onNetErr) opts.onNetErr(e); } }
    order = rankList(order.filter(c => !c.failed), look, ctx);
  }
  for (const c of order) {
    if (stop()) return null;
    if (c.source === 'current') return { c, src: c.file };
    try { const f = await fetchCand(c, g.sysId, opts.keep !== false); if (f) { if (!path.basename(f).startsWith('.tmp-')) c.cached = true; return { c, src: f }; } c.failed = true; }
    catch (e) { if (opts.onNetErr) opts.onNetErr(e); }
  }
  return null;
}

// ---------- matching sets (1.72): a front, back, spine and disc that belong together ----------
// Built from the same four candidate lists the picker shows (the only keys and addresses ever used). A set is per region and
// source family (all four from LaunchBox, or GameTDB, or ScreenScraper), plus "best of each source" per region and an HD set;
// complete sets only (every part found). Back and spine cut from the same full scan read as one box and come first.
const SET_SOURCES = { launchbox: 'LaunchBox scans', gametdb: 'GameTDB', screenscraper: 'ScreenScraper scans' };
const REG_NAME = { usa: 'USA', eur: 'Europe', jpn: 'Japan' };
const setsMemo = new Map(); // gameKey → [{ id, parts: { part: cand } }] (the only sets art:useSet accepts)
const lastSet = new Map(); // gameKey → { changed: [part], had: { part: bool }, prev: lock entry } (Undo set)
// a real release's picture that can be had: not the one in use, an earlier one, a SteamGridDB poster, fan art, or a guess not yet seen
const setUsable = c => !['current', 'earlier', 'steamgriddb'].includes(c.source) && !c.failed && !c.dup && !c.fan && !(c.guess && !c.cached);
const regOk = (c, R, strict) => c.region === R || (!strict && (!c.region || c.region === 'world'));
function buildSets(g, L) { // L: { part: [cand] }
  const style = styleFor(cfg(), g.sysId), ctx = { style, game: g.game, sharp: true }, out = [], seen = new Set();
  const best = (p, look, pred, parts) => {
    let pool = L[p].filter(c => setUsable(c) && pred(c)); if (!pool.length) return null;
    // the spine from the same full scan as the back (one wrap, cut twice), when there is one
    if (p === 'spine' && parts.back && parts.back.cut) { const same = pool.filter(c => c.cut && c.url === parts.back.url); if (same.length) pool = same; }
    return rankList(pool, look, ctx)[0];
  };
  const add = (id, label, R, src, hd, look, pred) => {
    const parts = {}; for (const p of PARTS) { const c = best(p, look, x => pred(x, p), parts); if (!c) return; parts[p] = c; }
    const sig = PARTS.map(p => parts[p].key).join('|'); if (seen.has(sig) && !hd) return; seen.add(sig); // (the HD set stays even when a region set has the same four: it's what the HD shelf style asks for)
    out.push({ id, label: label + ' · complete', region: R || '', source: src, hd: !!hd, same: !!(parts.back.cut && parts.spine.cut && parts.back.url === parts.spine.url), parts });
  };
  const own = gameRegion(g.game), regs = ['usa', 'eur', 'jpn'].sort((a, b) => (b === own) - (a === own)); // the copy you own first
  for (const R of regs) {
    for (const src of Object.keys(SET_SOURCES)) add(`${R}-${src}`, `${REG_NAME[R]} · ${SET_SOURCES[src]}`, R, src, false, 'region:' + R, (c, p) => c.source === src && regOk(c, R, p !== 'disc'));
    add(`${R}-mixed`, `${REG_NAME[R]} · best of each source`, R, 'mixed', false, 'region:' + R, (c, p) => regOk(c, R, p !== 'disc'));
  }
  add('hd', 'HD', '', 'mixed', true, 'hd', () => true);
  return out.sort((a, b) => (b.source !== 'mixed') - (a.source !== 'mixed') || b.same - a.same); // (stable: regions keep their order)
}
const setView = (s, g) => ({ id: s.id, label: s.label, region: s.region, source: s.source, hd: s.hd, same: s.same, parts: Object.fromEntries(PARTS.map(p => [p, pub(s.parts[p], g)])) });
async function setsOf(g, opts = {}) {
  const ents = await Promise.all(PARTS.map(p => listFor(g, p, { fresh: !!opts.fresh, lrWait: opts.lrWait || 3000, sgdb: false, ssCacheOnly: !!opts.job, ssWait: opts.job ? 2000 : 4000 })));
  const sets = buildSets(g, Object.fromEntries(PARTS.map((p, i) => [p, ents[i].list]))); setsMemo.set(g.key, sets); while (setsMemo.size > 200) setsMemo.delete(setsMemo.keys().next().value);
  return sets;
}
// art:sets { systemId, file } → { sets: [{ id, label, region, source, hd, same, parts: { part: card } }] }. The mini previews
// arrive as art:cand events (part + key), downloaded three at a time like the picker's thumbnails
async function sets(a) {
  const g = await gameArg(a), list = await setsOf(g, { fresh: true });
  const todo = [], seen = new Set(); for (const s of list) for (const p of PARTS) { const c = s.parts[p]; if (!c.cached && !c.file && !seen.has(c.key)) { seen.add(c.key); todo.push([p, c]); } }
  setImmediate(() => covers.pool(todo, 3, async ([p, c]) => { let f = null; try { f = await fetchCand(c, g.sysId, true); } catch {} if (!f) { c.failed = true; env.send('art:cand', { systemId: g.sysId, file: g.game.file, part: p, key: c.key, failed: true, set: true }); return; }
    const inf = fileInfo(f) || {}; Object.assign(c, { w: inf.w || null, h: inf.h || null, bytes: inf.bytes || 0, cached: true }); env.send('art:cand', { systemId: g.sysId, file: g.game.file, part: p, key: c.key, thumb: thumbOf(c), w: c.w, h: c.h, set: true }); }).catch(() => {}));
  return { sets: list.map(s => setView(s, g)) };
}
// the parts a set changed, as they were before it: the newest picture in replaced\ back for a part that had one; for a part that
// had none (or whose old picture isn't in replaced\, e.g. it sat in another art folder) the set's picture moves to replaced\
async function revertParts(g, changed, had) {
  for (const p of changed) {
    const cur = g.game.art && g.game.art[p], dirs = [...new Set([g.dir, cur ? path.dirname(cur) : null].filter(Boolean))];
    const last = had[p] ? dirs.flatMap(d => covers.replacedFor(d, g.base, SUFFIX[p])).sort((x, y) => (y.stamp > x.stamp ? 1 : y.stamp < x.stamp ? -1 : 0))[0] : null;
    if (last) { await restore(g, p, last.file); continue; }
    if (!cur || !paths.isFile(cur)) continue;
    const rd = path.join(path.dirname(cur), covers.REPLACED), st = new Date().toISOString().slice(0, 23).replace(/[:T.]/g, '-'), ext = path.extname(cur);
    await fs.promises.mkdir(rd, { recursive: true });
    let to = path.join(rd, `${g.base}${SUFFIX[p]} (${st})${ext}`); for (let i = 2; fs.existsSync(to); i++) to = path.join(rd, `${g.base}${SUFFIX[p]} (${st}-${i})${ext}`); // never over an earlier one
    await fs.promises.rename(cur, to);
    env.placed(cur); g.game.art = { ...(g.game.art || {}), [p]: findPart(g.sc, g.game, p) }; lists.delete(g.key + '|' + p);
  }
}
// puts a whole set in use: every picture downloaded first (nothing changes if one can't be had), then each part through the safe
// write path (old pictures to replaced\), each part locked as the user's pick; one Undo set puts all four back
async function applySet(g, set, lockIt) {
  const srcs = await Promise.all(PARTS.map(p => fetchCand(set.parts[p], g.sysId, true).catch(() => null)));
  const miss = PARTS.filter((p, i) => !srcs[i]); if (miss.length) throw new Error(`The ${miss.join(' and ')} of that set couldn't be downloaded. Nothing was changed.`);
  const had = {}, changed = [], prev = { ...locksOf(g.sysId, g.game.file) };
  for (const p of PARTS) had[p] = !!(g.game.art && g.game.art[p] && paths.isFile(g.game.art[p]));
  // all four or none: a part that fails to go in (disk full, a file held open) puts the ones already in back
  try { for (let i = 0; i < PARTS.length; i++) { const p = PARTS[i]; if (await apply(g, p, set.parts[p], true, srcs[i])) changed.push(p); } }
  catch (e) { await revertParts(g, changed, had).catch(x => log('Art Studio sets: could not put back', x.message)); throw new Error(`That set couldn't be put in (${e.message}). Nothing was changed.`); }
  if (lockIt) editLocks(L => { const e = { ...(L[g.key] || {}) }; for (const p of PARTS) e[p] = { look: 'exact', key: set.parts[p].key, at: Date.now() }; L[g.key] = e; }); // (your picks: not locks, see the rule above startRestyle)
  return { changed, had, prev };
}
async function useSet(a) {
  const g = await gameArg(a), id = String(needObj(a).setId || ''); if (!/^[a-z0-9-]{1,40}$/.test(id)) throw new Error('Bad set.');
  let set = (setsMemo.get(g.key) || []).find(s => s.id === id); if (!set) set = (await setsOf(g)).find(s => s.id === id);
  if (!set) throw new Error('That set is no longer offered. Open the sets again.');
  const r = await withGame(g.key, () => applySet(g, set, true));
  lastSet.set(g.key, r); while (lastSet.size > 200) lastSet.delete(lastSet.keys().next().value);
  env.changed({ artStudio: r.changed.length || 1 }); return { art: artView(g.game), lock: lockView(locksOf(g.sysId, g.game.file)), changed: r.changed };
}
// Undo set: the four parts as they were before it (pictures from replaced\, a part that was missing goes to replaced\ too) and
// the locks as they were
async function undoSet(a) {
  const g = await gameArg(a), m = lastSet.get(g.key); if (!m) throw new Error('Nothing to undo');
  await withGame(g.key, async () => {
    await revertParts(g, m.changed, m.had);
    // the parts' picks as they were; a game lock set since the set went in stays
    editLocks(L => { const e = { ...(L[g.key] || {}) }; for (const p of PARTS) { if (m.prev[p]) e[p] = m.prev[p]; else delete e[p]; } L[g.key] = e; });
  });
  lastSet.delete(g.key); env.changed({ artStudio: 1 }); return { art: artView(g.game), lock: lockView(locksOf(g.sysId, g.game.file)) };
}

// ---------- jobs (a shelf style changed: re-pick its unlocked parts) ----------
function jobView(j) { return { id: j.id, systemId: j.sysId, label: j.label, done: j.done, total: j.total, state: j.state, msg: j.msg || '', kept: j.kept || 0, ...(j.sets ? { sets: { ...j.sets } } : {}) }; }
function emitJob(j, force) { const now = Date.now(); if (!force && now - (j.sent || 0) < 250) return; j.sent = now; env.send('art:job', jobView(j)); }
function busy() { for (const j of jobs.values()) if (j.state === 'run') return true; return false; }
function cancelJob(id) { const j = jobs.get(String(id || '')); if (!j) return false; j.c = true; return true; }
const sigKey = s => JSON.stringify([s.preset, s.region, s.parts, !!s.sharper, !!s.regionFirst]);
const waitCovers = async j => { while (env.coversBusy && env.coversBusy() && !j.c) await new Promise(r => setTimeout(r, 1000)); }; // a cover download writes the same files: after it
// THE LOCK RULE (1.73, the owner's): only "Lock this game" protects a game from a shelf style change. A style change (any
// preset) re-picks every part of every unlocked game, your picks too (they were picks, not locks: Use, a set, My picture…,
// Undo). A pick only keeps the *background* auto-fetch off a part (lockedFor), and only until the next style change, which
// clears it. Pictures from before 1.68 (unknown origin) work the same way: the background never replaces them (mayReplace),
// a style change does. Replaced pictures go to replaced\ and Undo brings them back, as always.
// force: "<lockKey>|<part>" re-picked even where the style didn't change
function startRestyle(def, before, after, force) {
  // a newer style for the same console replaces the run: the old one stops (after its in-flight downloads) and this one
  // starts once it has, comparing against every style the shelf may still partly show (a double-click on the same style
  // must not cancel the first job and then find "nothing to change")
  const prev = [...jobs.values()].filter(x => x.sysId === def.id && x.state === 'run'); for (const x of prev) x.c = true;
  const bases = [...(stale.get(def.id) || []), before].filter((s, i, a) => a.findIndex(t => sigKey(t) === sigKey(s)) === i).slice(-6);
  stale.set(def.id, bases);
  const j = { id: 'art' + (++jobN), sysId: def.id, label: `Restyling ${def.name}`, done: 0, total: 0, state: 'run', msg: '', c: false };
  jobs.set(j.id, j); for (const [k, x] of jobs) if (x.state !== 'run' && jobs.size > 20) jobs.delete(k);
  const t0 = Date.now(); // a pick made after the style change (while this job runs) wins over it
  const lockedNow = (file, part) => { const e = locksOf(def.id, file); return !!e.all || !!(e[part] && (e[part].at || 0) > t0); };
  const clearPicks = file => { const k = lockKey(def.id, file); editLocks(L => { const e = L[k]; if (!e || e.all) return; const x = { ...e }; for (const p of PARTS) if (x[p] && !((x[p].at || 0) > t0)) delete x[p]; L[k] = x; }); };
  j.promise = (async () => {
    let changed = 0, failed = 0, notFound = 0, netErr = 0, okNet = 0, pinged = 0, lastPing = Date.now(); j.kept = 0; j.locked = 0;
    // the shelf and museum see a long restyle's pictures as they come (one refresh per REFRESH_MS at most), not only at the end
    const ping = () => { if (changed > pinged && Date.now() - lastPing >= REFRESH_MS) { env.changed({ artStudio: changed - pinged }); pinged = changed; lastPing = Date.now(); } };
    try {
      emitJob(j, true);
      await Promise.all(prev.map(x => x.promise && x.promise.catch(() => {})));
      await waitCovers(j);
      const { list } = await gamesFor(def.id, true);
      if (j.c) throw Object.assign(new Error('cancelled'), { quiet: true });
      j.locked = list.filter(game => locksOf(def.id, game.file).all).length; // locked games: never touched
      const work = [], setsMode = after.preset === 'sets'; j.sets = setsMode ? { full: 0, partial: 0, skipped: 0 } : null;
      // Complete sets: a locked game is never touched (counted as skipped); every other game gets its set, its earlier picks
      // replaced (the lock rule above), except a pick made while this job runs
      if (setsMode) for (const game of list) { const e = locksOf(def.id, game.file); if (e.all) j.sets.skipped++; else work.push({ game, parts: PARTS.slice(), set: true }); }
      else for (const game of list) { const e = locksOf(def.id, game.file), lk = lockKey(def.id, game.file); if (e.all) continue; const parts = PARTS.filter(p => !!e[p] || ((force && force.has(lk + '|' + p)) || bases.some(b => lookSig(b, p, game) !== lookSig(after, p, game)) || !(game.art && game.art[p]))); if (parts.length) work.push({ game, parts }); }
      j.total = work.length; emitJob(j, true);
      await covers.pool(work, 2, async w => {
        if (j.c) return;
        if (env.idle) await env.idle(); await waitCovers(j); await yieldNow(); if (j.c) return; // never while a game runs or a cover download writes; a breath between games for the shelf
        if (netErr >= 6 && !okNet) { j.c = true; j.offline = true; return; } // nothing reachable: stop instead of trying every game
        const item = env.consoles().find(x => x.def.id === def.id); if (!item) { j.c = true; return; } // its games folders were removed meanwhile
        const g = { sysId: def.id, def, sc: item.sc, game: w.game, dir: paths.artDirFor(item.sc, w.game.file), base: paths.artBase(w.game.file), key: lockKey(def.id, w.game.file) };
        if (!w.set) await withGame(g.key, async () => { if (!locksOf(def.id, w.game.file).all) clearPicks(w.game.file); }); // the style change replaces earlier picks
        if (w.set) { // the whole set where there is one (cached ScreenScraper lookups only: a job never spends the daily quota)
          let done = false;
          try { await withGame(g.key, async () => {
            const e = locksOf(def.id, w.game.file); if (j.c || e.all || PARTS.some(p => e[p] && (e[p].at || 0) > t0)) { done = 'skip'; return; } // locked, or a pick made while the job ran
            clearPicks(w.game.file); // earlier picks give way to the new style
            const all = await setsOf(g, { fresh: true, job: true, lrWait: 20000 }), set = all.find(x => after.setsHd ? x.hd : x.region === after.region && !x.hd);
            if (set) { try { const r = await applySet(g, set, false); changed += r.changed.length; okNet++; j.sets.full++; done = true; } catch (err) { log('Art Studio sets', path.basename(w.game.file), err.message); } }
          }); } catch (e) { log('Art Studio sets', e.message); }
          if (done === 'skip') { j.sets.skipped++; j.done++; emitJob(j); return; }
          if (done) { j.done++; emitJob(j); ping(); return; }
          w.partial = true; // no complete set: the shelf style's look for each part, as a normal restyle
        }
        for (const part of w.parts) {
          if (j.c) break; if (lockedNow(w.game.file, part)) continue; // locked while the job ran
          try {
            await withGame(g.key, async () => {
              if (j.c || lockedNow(w.game.file, part)) return; // a Use / mix / undo queued ahead of this one on the same game won
              const b = await pickBest(g, part, lookFor(after, part), { keep: false, job: j, fresh: true, lrWait: 20000, onNetErr: () => { netErr++; } });
              if (!b) { notFound++; return; } okNet++;
              if (j.c || lockedNow(w.game.file, part)) { if (path.basename(b.src).startsWith('.tmp-')) fs.promises.unlink(b.src).catch(() => {}); return; }
              if (await apply(g, part, b.c, false, b.src)) changed++;
            });
          } catch (e) { failed++; log('Art Studio restyle', path.basename(w.game.file), part, e.message); }
        }
        if (w.partial) j.sets.partial++;
        j.done++; emitJob(j); ping();
      });
      j.state = j.offline ? 'error' : j.c ? 'cancelled' : 'done';
      // (1.80) the whole story: what changed, what wasn't found anywhere, what failed to download (it used to say "Nothing
      // needed changing" after a run of failed downloads)
      const extra = [notFound ? `${notFound} not found` : '', failed ? `${failed} failed` : '', netErr ? `${netErr} connection error${netErr === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
      j.msg = j.offline ? "Couldn't reach the art sites. Check the internet connection and try again." : (changed ? `${changed} picture${changed === 1 ? '' : 's'} changed` : !j.total ? 'Nothing to change' : extra ? 'Nothing changed' : 'Nothing needed changing') + (extra && !j.offline ? ' · ' + extra : '');
      if (j.locked && !j.offline && !j.sets) j.msg += ` · ${j.locked} locked game${j.locked === 1 ? '' : 's'} skipped`;
      if (j.sets && !j.offline) j.msg = `${j.sets.full} full set${j.sets.full === 1 ? '' : 's'} · ${j.sets.partial} partly · ${j.sets.skipped} skipped (locked)`;
    } catch (e) { if (e.quiet) { j.state = 'cancelled'; j.msg = ''; } else { j.state = 'error'; j.msg = e.message; log('Art Studio restyle failed', e.message); } }
    // finished with every game: the shelf is all in this style now (unless a newer job already took over)
    if (j.state === 'done' && ![...jobs.values()].some(x => x.sysId === def.id && x !== j && x.state === 'run')) stale.delete(def.id);
    if (changed > pinged) env.changed({ artStudio: changed - pinged });
    emitJob(j, true);
  })();
  return j.id;
}

// ---------- IPC handlers (main.js: handle('art:…', a => artstudio.x(a))) ----------
async function studio() {
  const c = cfg(), out = [];
  for (const { def } of env.consoles()) {
    let total = env.count ? env.count(def.id) : null; if (total == null) { try { total = (await gamesFor(def.id)).list.length; } catch { total = 0; } }
    const pre = def.id + '|'; let locked = 0, frozen = 0, kept = 0; for (const [k, e] of Object.entries((c.art && c.art.locks) || {})) if (k.startsWith(pre)) { locked++; if (e.all) frozen++; for (const p of PARTS) if (e[p] && e[p].key === 'kept') kept++; }
    // the restyle running on it (a renderer reload shows its progress again); a job being replaced by a newer one isn't listed
    const rj = [...jobs.values()].filter(j => j.sysId === def.id && j.state === 'run' && !j.c).pop();
    // (1.80) the games with no front cover at all: Settings shows the count on the console's row and in the Box art summary
    let noCover = null; try { const { list } = await gamesFor(def.id); noCover = list.filter(g => !(g.art && g.art.front)).length; if (total == null || !total) total = list.length; } catch {}
    out.push({ id: def.id, name: def.name, total, noCover, style: styleFor(c, def.id), locked, frozen, kept, job: rj ? { jobId: rj.id, label: rj.label, done: rj.done, total: rj.total } : null });
  }
  return { consoles: out, looks: LOOKS.slice(), presets: PRESETS.slice(), index: covers.indexState() };
}
async function games(a) {
  const { def } = sysArg(a), { list } = await gamesFor(def.id), out = []; // the 60 s memo (cleared by every library scan, kept current by every change made here)
  for (let i = 0; i < list.length; i++) {
    if (i && i % 8 === 0) await yieldNow(); // header reads only (one file each), but a big shelf shouldn't hold everything up in one go (beta.9: every 8 games, was 40: up to 200 picture reads at a time held up the Studio's opening)
    const g = list[i], locks = locksOf(def.id, g.file), art = {}, low = {}, lock = {};
    for (const p of PARTS) { const f = g.art && g.art[p]; art[p] = f ? env.fileUrl(f) : null; low[p] = !!f && covers.isLow(f, p); lock[p] = locks[p] ? { look: locks[p].look, ...(locks[p].key ? { key: locks[p].key } : {}) } : null; }
    out.push({ file: g.file, title: g.title, region: g.region || '', art, low, lock, frozen: !!locks.all }); // frozen: the whole game locked as it is
  }
  return out;
}
function setStyle(a) {
  const { def } = sysArg(a); if (!a.style || typeof a.style !== 'object' || Array.isArray(a.style)) throw new Error('Bad style.');
  const c = cfg(), before = styleFor(c, def.id), next = cleanArtStyle(a.style, before);
  // fields the screen doesn't know about (sharper, regionFirst) carry over unless it sent them
  if (typeof a.style.sharper !== 'boolean' && typeof before.sharper === 'boolean') next.sharper = before.sharper;
  const art = c.art || { styles: {}, locks: {} }; env.setArt({ ...art, styles: { ...(art.styles || {}), [def.id]: next } });
  lists.clear(); // scores depend on the style
  return { jobId: startRestyle(def, before, next), style: next };
}
async function cands(a) {
  const g = await gameArg(a), part = partArg(a.part), entry = await listFor(g, part, { fresh: true, lrWait: 3000 }); // libretro's weekly list: not worth more than a moment's wait here
  setImmediate(() => warm(entry, part));
  // a guessed address (GameTDB, another region) is listed once it has really downloaded; until then the screen hears of it only
  // through art:cand (with the whole card) when it arrives, and never if it doesn't
  return { list: entry.list.filter(c => !c.dup && !(c.guess && !c.cached && !c.inUse)).map(c => pub(c, g)), index: covers.indexState() };
}
async function keyed(g, part, key) {
  if (typeof key !== 'string' || !/^[a-z0-9]{4,64}$/.test(key)) throw new Error('Bad choice.');
  let e = lists.get(g.key + '|' + part); let c = e && e.byKey.get(key);
  if (!c) { e = await listFor(g, part, { fresh: true }); c = e.byKey.get(key); } // a list from before a restart: the same keys come back
  if (!c) throw new Error('That picture is no longer offered. Open the list again.');
  return c;
}
async function use(a) {
  const g = await gameArg(a), part = partArg(a.part), c = await keyed(g, part, a.key);
  // the lock is set inside the game's turn: a restyle step queued behind this one must already see it
  await withGame(g.key, async () => { await apply(g, part, c, true); setLock(g.sysId, g.game.file, part, { look: 'exact', key: c.key }); });
  env.changed({ artStudio: 1 }); return { art: artView(g.game) };
}
async function mix(a) {
  const g = await gameArg(a), part = partArg(a.part), look = a.look;
  if (look !== 'shelf' && !LOOKS.includes(look)) throw new Error('Unknown look.');
  if (look === 'shelf') {
    setLock(g.sysId, g.game.file, part, null); // back to the shelf's style, then whatever it picks (if anything can be had)
    adopt([g.game.art && g.game.art[part]]); // the user handed this part to the style: a picture kept from before is the style's to replace from now on
    let c = null; try { c = await withGame(g.key, async () => { const b = await pickBest(g, part, lookFor(styleFor(cfg(), g.sysId), part), { fresh: true }); if (b) await apply(g, part, b.c, true, b.src); return b && b.c; }); } catch (e) { log('Art Studio: shelf pick', e.message); }
    env.changed({ artStudio: 1 }); return { art: artView(g.game), key: c ? c.key : null };
  }
  const c = await withGame(g.key, async () => {
    const b = await pickBest(g, part, look, { fresh: true }); if (!b) throw new Error("No picture for that look could be downloaded. Check the internet connection, or pick one yourself.");
    await apply(g, part, b.c, true, b.src);
    setLock(g.sysId, g.game.file, part, { look, key: b.c.key }); // locked only once it worked: a failed try leaves the part following the shelf
    return b.c;
  });
  env.changed({ artStudio: 1 }); return { art: artView(g.game), key: c.key };
}
async function undo(a) {
  const g = await gameArg(a), part = partArg(a.part);
  await withGame(g.key, async () => {
    const cur = g.game.art && g.game.art[part], dirs = [...new Set([g.dir, cur ? path.dirname(cur) : null].filter(Boolean))];
    const last = dirs.flatMap(d => covers.replacedFor(d, g.base, SUFFIX[part])).sort((x, y) => (y.stamp > x.stamp ? 1 : y.stamp < x.stamp ? -1 : 0))[0];
    if (!last) throw new Error('Nothing to undo');
    await restore(g, part, last.file);
    setLock(g.sysId, g.game.file, part, { look: 'exact' }); // a picture put back by hand stays until changed by hand
  });
  env.changed({ artStudio: 1 }); return { art: artView(g.game) };
}
// ---------- the whole game locked as it is (Y on the games grid, the switch on its mix) ----------
// lock: every part stays exactly as it is now, missing ones included; auto-fetch, HD upgrades, shelf styles and restyles skip
// the game. Hand-made changes (a look, Pick exact, your own picture, Undo) still work on a locked game.
// unlock: back on the shelf style. Only parts that differ from it are re-picked, in the background ('art:job' kind 'game'):
// a part that followed the shelf when locked and whose look the style still gives keeps its picture (nothing downloaded),
// a part locked to a look the style also gives the same. Your own pictures stay yours (their part lock stays).
const OWN_KEYS = new Set(['own', 'chosen']);
async function lockGame(a) {
  const g = await gameArg(a), want = !!needObj(a).lock, style = styleFor(cfg(), g.sysId);
  if (want) {
    await withGame(g.key, async () => { editLocks(L => { const e = { ...(L[g.key] || {}) }; if (e.all) return; const sig = {}; for (const p of PARTS) if (!e[p]) sig[p] = lookSig(style, p, g.game); e.all = { at: Date.now(), sig }; L[g.key] = e; }); });
    env.changed({ artStudio: 0 }); return { frozen: true, lock: lockView(locksOf(g.sysId, g.game.file)), art: artView(g.game), repick: 0 };
  }
  // unlocking (1.73): only the game lock goes. Your picks stay as they are (a later shelf style change replaces them, as it does
  // for every unlocked game); a part that followed the shelf is re-picked only if the style changed while the game was locked
  let todo = [], kept = [];
  await withGame(g.key, async () => {
    const e = locksOf(g.sysId, g.game.file), sig = (e.all && e.all.sig) || {};
    for (const p of PARTS) {
      if (e[p]) { kept.push(p); continue; }
      const have = g.game.art && g.game.art[p] && paths.isFile(g.game.art[p]);
      if (!have || (e.all && sig[p] && sig[p] !== lookSig(style, p, g.game))) todo.push(p);
    }
    editLocks(L => { const x = { ...(L[g.key] || {}) }; delete x.all; L[g.key] = x; });
  });
  const jobId = todo.length ? repickGame(g, todo) : null;
  env.changed({ artStudio: 0 }); return { frozen: false, lock: lockView(locksOf(g.sysId, g.game.file)), art: artView(g.game), repick: todo.length, jobId, ownKept: [] };
}
const lockView = e => Object.fromEntries(PARTS.map(p => [p, e[p] ? { look: e[p].look, ...(e[p].key ? { key: e[p].key } : {}) } : null]));
// a game's parts re-picked by the shelf style in the background; each step in the game's turn, never while a game runs
function repickGame(g, parts) {
  const j = { id: 'g' + (++jobN), kind: 'game', sysId: g.sysId, file: g.game.file, label: 'Back to the shelf style', done: 0, total: parts.length, state: 'run', msg: '', c: false };
  const send = () => env.send('art:job', { id: j.id, kind: 'game', systemId: j.sysId, file: j.file, parts, label: j.label, done: j.done, total: j.total, state: j.state, msg: j.msg });
  j.promise = (async () => {
    send(); let changed = 0, failed = 0;
    for (const part of parts) {
      if (env.idle) await env.idle(); await waitCovers(j);
      try {
        await withGame(g.key, async () => {
          if (effLocks(locksOf(g.sysId, g.game.file))[part]) return; // locked again meanwhile: leave it
          const b = await pickBest(g, part, lookFor(styleFor(cfg(), g.sysId), part), { fresh: true, keep: false, lrWait: 20000 });
          if (!b) { failed++; return; }
          if (effLocks(locksOf(g.sysId, g.game.file))[part]) { if (path.basename(b.src).startsWith('.tmp-')) fs.promises.unlink(b.src).catch(() => {}); return; }
          if (await apply(g, part, b.c, false, b.src)) changed++;
        });
      } catch (e) { failed++; log('Art Studio: back to shelf', path.basename(g.game.file), part, e.message); }
      j.done++; send();
    }
    j.state = 'done'; j.msg = changed ? `${changed} part${changed === 1 ? '' : 's'} re-picked` : failed ? "Couldn't fetch new pictures: the ones there stay" : 'Nothing needed changing';
    if (changed) env.changed({ artStudio: changed }); send();
  })().catch(e => { j.state = 'error'; j.msg = e.message; send(); });
  return j.id;
}

// ---------- your own picture for one part ----------
// main opens the file picker (env.pickImage → a path, or null); the screen never sends a path. The file is copied, never
// moved, checked (a real PNG / JPEG / WebP by its bytes, not its name; size; dimensions), placed through placeArt (the old
// picture to replaced\, so Undo brings it back) and the part locked. cut: a full-box image (back | spine | front) for the
// spine, cut with the same spine cutter the downloads use.
const OWN_MAX = 40 * 1024 * 1024;
function imageInfo(buf) {
  if (buf.length >= 24 && buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return { ext: '.png', w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf.length >= 4 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return { ext: '.jpg', w: null, h: null }; // size from covers.sizeOf (it walks the segments)
  if (buf.length >= 30 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    const k = buf.toString('latin1', 12, 16);
    if (k === 'VP8X') return { ext: '.webp', w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
    if (k === 'VP8 ' && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) return { ext: '.webp', w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    if (k === 'VP8L' && buf[20] === 0x2f) { const b = buf.readUInt32LE(21); return { ext: '.webp', w: 1 + (b & 0x3fff), h: 1 + ((b >> 14) & 0x3fff) }; }
    return null;
  }
  return null;
}
// the copy, checked: { ext, w, h } or throws a sentence for the screen
async function checkImage(file, part, cut) {
  let fd, head = Buffer.alloc(64), n = 0; try { fd = await fs.promises.open(file, 'r'); n = (await fd.read(head, 0, 64, 0)).bytesRead; } finally { if (fd) await fd.close().catch(() => {}); }
  const inf = imageInfo(head.subarray(0, n)); if (!inf) throw new Error('That file isn\'t a PNG, JPEG or WebP picture.');
  if (inf.ext === '.jpg') { const z = covers.sizeOf(file); if (!z) throw new Error('That JPEG picture couldn\'t be read.'); inf.w = z[0]; inf.h = z[1]; }
  const lo = Math.min(inf.w, inf.h), hi = Math.max(inf.w, inf.h);
  if (!(lo >= (part === 'spine' && !cut ? 12 : 64)) || !(hi >= 120)) throw new Error(`That picture is too small (${inf.w} × ${inf.h}).`);
  if (hi > 20000 || inf.w * inf.h > 200e6) throw new Error(`That picture is too big (${inf.w} × ${inf.h}).`);
  if (cut && inf.w < inf.h * 1.2) throw new Error('For a spine cut, pick a picture of the whole box opened flat: back, spine and front side by side.');
  return inf;
}
async function own(a) {
  const g = await gameArg(a), part = partArg(a.part), cut = !!a.cut && part === 'spine';
  if (!env.pickImage) throw new Error('Not available here.');
  const PL = { front: 'front cover', back: 'back cover', spine: 'spine', disc: 'disc' }[part];
  const src = await env.pickImage({ title: cut ? `A picture of the whole box to cut the spine from: ${g.game.title}` : `Your own ${PL} for ${g.game.title}` });
  if (!src) return { canceled: true };
  let st; try { st = await fs.promises.stat(src); } catch { throw new Error('That file can\'t be opened.'); }
  if (!st.isFile()) throw new Error('Pick a picture file.'); if (st.size > OWN_MAX) throw new Error('That picture is over 40 MB. Pick a smaller one.'); if (st.size < 200) throw new Error('That file is empty or damaged.');
  const cur = g.game.art && g.game.art[part];
  await withGame(g.key, async () => {
    await fs.promises.mkdir(g.dir, { recursive: true });
    // the picture already in use, picked again: nothing to copy, it's just yours now
    if (!cut && cur && pk(cur) === pk(src)) { await checkImage(src, part, false); record(cur, 'own'); setLock(g.sysId, g.game.file, part, { look: 'exact', key: 'own' }); return; }
    const tmp = path.join(candDir, `.tmp-own-${process.pid}-${crypto.randomUUID()}${path.extname(src).slice(0, 6).toLowerCase() || '.img'}`);
    let inc = null;
    try {
      await fs.promises.copyFile(src, tmp); // a copy: the user's file stays where it is, untouched
      const inf = await checkImage(tmp, part, cut); let ext = inf.ext;
      inc = incoming(g, part, cut ? '.jpg' : ext);
      if (cut) { const buf = await covers.cutSpine(tmp, g.sysId); if (!buf) throw new Error('No spine could be cut from that picture. Pick a picture of the whole box opened flat (back, spine and front).'); await fs.promises.writeFile(inc, buf); ext = '.jpg'; }
      else await fs.promises.copyFile(tmp, inc);
      const r = await covers.placeArt(g.dir, g.base, SUFFIX[part], inc, ext, 'own'); inc = null; await placed(g, part, r.dest);
      setLock(g.sysId, g.game.file, part, { look: 'exact', key: 'own' }); // locked before the turn ends: a queued restyle step sees it
      log('Art Studio:', g.sysId, path.basename(g.game.file), part, '<- your own picture', cut ? '(spine cut from a full box)' : '');
    } finally { await fs.promises.unlink(tmp).catch(() => {}); if (inc) await fs.promises.unlink(inc).catch(() => {}); } // awaited: nothing left behind once the call returns
  });
  env.changed({ artStudio: 1 }); return { art: artView(g.game), lock: { look: 'exact', key: 'own' } };
}

// ---------- kept pictures: let the shelf style have them ----------
// a console's 'kept' locks (pictures from before 1.68 or put there by hand) are lifted, those pictures become the style's,
// and a restyle re-picks them (each one replaced only when the style's choice differs; the old ones go to replaced\)
async function release(a) {
  const { def } = sysArg(a), pre = def.id + '|', force = new Set(), files = [];
  const c = cfg(), L = (c.art && c.art.locks) || {};
  for (const [k, e] of Object.entries(L)) { if (!k.startsWith(pre)) continue; for (const p of PARTS) if (e[p] && e[p].key === 'kept') force.add(k + '|' + p); }
  if (!force.size) return { released: 0, jobId: null };
  editLocks(M => { for (const kp of force) { const i = kp.lastIndexOf('|'), k = kp.slice(0, i), p = kp.slice(i + 1); if (M[k]) { const e = { ...M[k] }; delete e[p]; M[k] = e; } } });
  let list = []; try { list = (await gamesFor(def.id, true)).list; } catch {}
  for (const g of list) { const k = lockKey(def.id, g.file); for (const p of PARTS) if (force.has(k + '|' + p) && g.art && g.art[p]) files.push(g.art[p]); }
  adopt(files); // the style's now: the restyle's own "keep what may be the user's" step mustn't lock them again
  const style = styleFor(cfg(), def.id); lists.clear();
  return { released: force.size, jobId: startRestyle(def, style, style, force) };
}

// main.js's quick-menu Box art (art:choose) takes the same per-game turn as the Studio and the restyle job
const serial = (sysId, file, fn) => withGame(lockKey(sysId, file), fn);
function cancel(a) { return { ok: cancelJob(needObj(a).jobId) }; }
function forget(sysId) { if (sysId) gamesMemo.delete(sysId); else gamesMemo.clear(); lists.clear(); } // games folders or art changed elsewhere

module.exports = { init, studio, games, setStyle, cands, use, mix, undo, sets, useSet, undoSet, cancel, busy, forget, lockedFor, serial, lockGame, own, release, mayReplace, isPoster, setMaker, copied, ready, originOf, migrate, styleFor, lookFor, regionForLook, rankList, rankScore, scores, gameRegion, lockKey, pruneCache, cacheDir, PARTS, LOOKS,
  _t: { imageInfo, effLocks, provGet, lists, jobs, dedupe, fetchCand, pickBest, listFor, gamesMemo, stale, withGame, refreshEvery: ms => { REFRESH_MS = ms; } } };
