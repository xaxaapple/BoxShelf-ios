// (beta.7) Video previews: the clip that plays in Details (and, if chosen, behind the shelf) when you rest on a game.
// Where a game's preview comes from, first found wins:
//   1. a video file you already have: ES-DE / EmuDeck "downloaded_media/<console>/videos", RetroBat / Batocera "videos"
//      beside the games, LaunchBox "Videos\<platform>", your own videos folders (Settings), or "<game>-video.mp4" in your
//      art folder. Matched by the game file's name, then by its title.
//   2. Steam games: the store's own trailer. Steam serves it as 3-second DASH pieces; the first 20 seconds of the 480p
//      video are joined into one small silent MP4 (fragmented MP4 plays as a file) and kept in data\previews\steam
//      (oldest dropped past 400 MB). Fetched when you first rest on the game, never in bulk.
//   3. YouTube: the trailer link the LaunchBox database has for the game. With Console trailers on (beta.8,
//      main/ytclips.js) its first 20 seconds are kept as a clip and play like a Steam clip; until then (or with it off)
//      YouTube's own player plays it in the Media tab (renderer + main.js previewYt).
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

let log = () => {}, dataDir = '', appRoot = '';
function init(o) { log = o.log || log; dataDir = o.dataDir || ''; appRoot = o.appRoot || ''; }
const VID = /\.(mp4|webm|m4v)$/i;
const isDir = d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } };
const isFile = f => { try { return fs.statSync(f).isFile(); } catch { return false; } };
// a title as a plain key: lower case, no (region) / [tags], no punctuation (so "Super Mario 64 (USA)" = "super mario 64")
const key = s => String(s || '').toLowerCase().replace(/\.[a-z0-9]{2,4}$/, '').replace(/\s*[([][^)\]]*[)\]]/g, '').replace(/-(video|01|02|trailer)$/i, '').replace(/[^a-z0-9]+/g, '');

// ---------- folder listings, cached for 10 minutes (a preview lookup never walks the disk twice) ----------
const listing = new Map();
function index(dir) {
  const hit = listing.get(dir); if (hit && Date.now() - hit.at < 10 * 60e3) return hit;
  const exact = new Map(), loose = new Map();
  let names = []; try { names = fs.readdirSync(dir); } catch {}
  for (const n of names) { if (!VID.test(n)) continue; const f = path.join(dir, n), b = n.replace(VID, '').toLowerCase();
    if (!exact.has(b)) exact.set(b, f); const k = key(n); if (k && !loose.has(k)) loose.set(k, f); }
  const v = { at: Date.now(), exact, loose, count: exact.size }; if (listing.size > 400) listing.clear(); listing.set(dir, v); return v;
}
function forget() { listing.clear(); }

// ES-DE's own console folder names where they differ from Boxshelf's
const ESDE = { sw: 'switch', sw2: 'switch2', x360: 'xbox360', megadrive: 'genesis', segacd: 'megacd', pcengine: 'tg16' };
function homes() { const h = process.env.USERPROFILE || process.env.HOME || os.homedir(); return h ? [h] : []; }
// every folder that may hold this console's videos
function dirsFor(def, sc, opts = {}) {
  const names = [...new Set([def.id, ESDE[def.id], ...(def.romFolderNames || [])].filter(Boolean))];
  const out = [];
  const sub = (root, ...p) => out.push(path.join(root, ...p));
  for (const rd of sc.romDirs || []) {
    sub(rd, 'videos'); sub(rd, 'media', 'videos'); sub(rd, 'snap'); // RetroBat / Batocera, a media folder, older snap folders
    const m = /^(.*[\\/]Emulation)[\\/]roms[\\/]([^\\/]+)[\\/]?$/i.exec(rd); if (m) sub(m[1], 'tools', 'downloaded_media', m[2], 'videos'); // EmuDeck
  }
  for (const h of homes()) for (const base of [path.join(h, 'ES-DE', 'downloaded_media'), path.join(h, '.emulationstation', 'downloaded_media')]) for (const n of names) sub(base, n, 'videos');
  if (appRoot) for (const n of names) sub(path.dirname(appRoot), 'ES-DE', 'ES-DE', 'downloaded_media', n, 'videos');
  const lbPlat = opts.launchbox && opts.launchbox[def.id];
  if (lbPlat) for (const r of [...homes().map(h => path.join(h, 'LaunchBox')), 'C:\\LaunchBox', 'D:\\LaunchBox', ...(opts.launchboxRoots || [])]) { sub(r, 'Videos', lbPlat); sub(r, 'Videos', lbPlat, 'Recordings'); sub(r, 'Videos', lbPlat, 'Trailers'); }
  for (const d of opts.dirs || []) { out.push(d); for (const n of names) sub(d, n); if (lbPlat) sub(d, lbPlat); }
  for (const d of opts.artDirs || []) { out.push(d); sub(d, 'videos'); }
  return [...new Set(out.map(d => path.resolve(d)))].filter(isDir);
}
// the video file for one console game, or null. game: { file, title }
function findFile(def, sc, game, opts = {}, dirsKnown) { // dirsKnown (beta.10): dirsFor's answer, worked out once for a whole console
  const base = path.basename(game.file || '').replace(/\.[^.]+$/, '').toLowerCase(), k = key(game.title), kb = key(base);
  const dirs = dirsKnown || dirsFor(def, sc, opts);
  for (const d of dirs) { const ix = index(d); for (const b of [base, base + '-video', base + '-01', (game.title || '').toLowerCase() + '-01']) { const f = ix.exact.get(b); if (f) return f; } }
  for (const d of dirs) { const ix = index(d); const f = ix.loose.get(kb) || ix.loose.get(k); if (f) return f; }
  return null;
}
// how many games of a console have a video (Settings and the first run's "Found previews for N games")
function countFiles(def, sc, games, opts = {}) {
  // (beta.10) the folder list once per console: dirsFor stats ~20 folders, and redoing that per game was ~60,000 statSyncs for 3,000 games
  const dirs = dirsFor(def, sc, opts); let n = 0; for (const g of games) if (g.kind === 'rom' && findFile(def, sc, g, opts, dirs)) n++;
  return n;
}

// ---------- Steam store trailers ----------
const steamDir = () => path.join(dataDir, 'previews', 'steam');
function get(url, hops = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Boxshelf' } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops < 5) { res.resume(); return resolve(get(new URL(res.headers.location, url).toString(), hops + 1)); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const parts = []; let size = 0; res.on('data', c => { size += c.length; if (size > 24 << 20) { req.destroy(new Error('too big')); return; } parts.push(c); });
      res.on('end', () => resolve(Buffer.concat(parts))); res.on('error', reject);
    });
    req.on('error', reject); req.setTimeout(30000, () => req.destroy(new Error('timed out')));
  });
}
// the trailer's DASH manifest: the 480p (else the smallest) H.264 video and its piece names
function dashPlan(mpd, url) {
  const vid = /<AdaptationSet[^>]*contentType="video"[\s\S]*?<\/AdaptationSet>/.exec(mpd); if (!vid) return null;
  const reps = [...vid[0].matchAll(/<Representation\b([^>]*)>([\s\S]*?)<\/Representation>/g)].map(m => ({ id: (/\bid="([^"]+)"/.exec(m[1]) || [])[1], h: +((/\bheight="(\d+)"/.exec(m[1]) || [])[1] || 0), body: m[2] }));
  const pick = reps.find(r => r.h === 480) || reps.sort((a, b) => a.h - b.h)[0]; if (!pick || !pick.id) return null;
  const t = /<SegmentTemplate\b([^>]*)>/.exec(pick.body) || /<SegmentTemplate\b([^>]*)>/.exec(vid[0]); if (!t) return null;
  const a = n => (new RegExp('\\b' + n + '="([^"]+)"').exec(t[1]) || [])[1];
  const init = a('initialization'), media = a('media'), start = +(a('startNumber') || 1), dur = +(a('duration') || 0) / +(a('timescale') || 1);
  if (!init || !media) return null;
  const fill = (s, n) => s.replace(/\$RepresentationID\$/g, pick.id).replace(/\$Number(?:%0(\d+)d)?\$/g, (_, w) => String(n).padStart(+w || 0, '0'));
  const baseUrl = url.replace(/[^/]*$/, ''), q = (/\?[^#]*$/.exec(url) || [''])[0];
  const pieces = Math.max(1, Math.min(10, Math.ceil(20 / (dur || 3)))); // the first ~20 seconds
  return { init: baseUrl + fill(init, 0) + q, media: Array.from({ length: pieces }, (_, i) => baseUrl + fill(media, start + i) + q) };
}
const flights = new Map();
function steamClip(appid) {
  appid = String(appid || ''); if (!/^\d{1,10}$/.test(appid)) return Promise.resolve(null);
  const out = path.join(steamDir(), appid + '.mp4'), none = path.join(steamDir(), appid + '.none');
  if (isFile(out)) { try { const t = new Date(); fs.utimesSync(out, t, t); } catch {} return Promise.resolve(out); }
  if (isFile(none)) { try { if (Date.now() - fs.statSync(none).mtimeMs < 14 * 864e5) return Promise.resolve(null); } catch {} } // (no trailer: asked again in two weeks)
  if (flights.has(appid)) return flights.get(appid);
  const p = (async () => {
    fs.mkdirSync(steamDir(), { recursive: true });
    const j = JSON.parse((await get(`https://store.steampowered.com/api/appdetails?appids=${appid}&filters=movies`)).toString('utf8'));
    const movies = (j && j[appid] && j[appid].success && j[appid].data && j[appid].data.movies) || [];
    const mv = movies.find(m => m.highlight && m.dash_h264) || movies.find(m => m.dash_h264);
    if (!mv) { fs.writeFileSync(none, ''); return null; }
    if (!/^https:\/\/[a-z0-9.-]+\.steamstatic\.com\//i.test(mv.dash_h264)) return null;
    const plan = dashPlan((await get(mv.dash_h264)).toString('utf8'), mv.dash_h264); if (!plan) { fs.writeFileSync(none, ''); return null; }
    const bufs = [await get(plan.init)];
    for (const u of plan.media) { try { bufs.push(await get(u)); } catch (e) { if (bufs.length > 1 && /^HTTP 4(04|10)$/.test(e.message)) break; throw e; } } // (a short trailer simply ends sooner; beta.10: only a piece that isn't there ends it, a dropped connection saves nothing and is tried again)
    const tmp = out + '.part'; fs.writeFileSync(tmp, Buffer.concat(bufs)); fs.renameSync(tmp, out);
    trim(); log('Preview: Steam trailer kept for', appid, Math.round(fs.statSync(out).size / 1024) + ' KB'); return out;
  })().catch(e => { log('Preview: Steam trailer for', appid, 'failed:', e.message); return null; }).finally(() => flights.delete(appid));
  flights.set(appid, p); return p;
}
// keeps the Steam clips and the console trailer clips (main/ytclips.js, data\previews\youtube) under 400 MB together,
// dropping the ones not shown for longest
function trim(limit = 400 << 20) {
  let files = [];
  for (const d of [steamDir(), path.join(dataDir, 'previews', 'youtube')]) { try { files.push(...fs.readdirSync(d).filter(n => n.endsWith('.mp4')).map(n => { const f = path.join(d, n), s = fs.statSync(f); return { f, size: s.size, at: s.mtimeMs }; })); } catch {} }
  if (!files.length) return;
  let total = files.reduce((a, x) => a + x.size, 0); if (total <= limit) return;
  files.sort((a, b) => a.at - b.at); for (const x of files) { if (total <= limit * .8) break; try { fs.unlinkSync(x.f); total -= x.size; } catch {} }
}
function clearSteam() { try { fs.rmSync(steamDir(), { recursive: true, force: true }); } catch {} }
function steamSize() { try { return fs.readdirSync(steamDir()).reduce((a, n) => { try { return a + fs.statSync(path.join(steamDir(), n)).size; } catch { return a; } }, 0); } catch { return 0; } }

// a YouTube video id from a trailer link (LaunchBox gives youtube.com/watch?v= or youtu.be links)
function youtubeId(url) {
  try { const u = new URL(String(url)); if (!/(^|\.)youtube(-nocookie)?\.com$|(^|\.)youtu\.be$/i.test(u.hostname)) return null;
    const id = u.hostname.includes('youtu.be') ? u.pathname.slice(1) : u.searchParams.get('v') || (/\/embed\/([^/?]+)/.exec(u.pathname) || [])[1]; return id && /^[\w-]{6,20}$/.test(id) ? id : null; } catch { return null; }
}

module.exports = { init, findFile, countFiles, dirsFor, steamClip, youtubeId, dashPlan, trim, clearSteam, steamSize, forget, key };
