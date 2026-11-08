// (beta.8) Console trailers: a short clip of a game's YouTube trailer, saved as a file so it plays like a Steam clip (behind
// the shelf and behind the case in Details), the way Playnite's trailer add-on does it.
//   - The helper is yt-dlp (free, Unlicense), fetched once into data\tools when you switch Console trailers on, and
//     checked against the SHA-256 list yt-dlp publishes with every release. It only finds the video's 720p (else 480p) stream.
//   - The clip: YouTube serves that stream as fragmented MP4 with an index (sidx) of its fragments. Boxshelf reads the
//     index, fetches only the bytes of the first ~20 seconds, and joins the header and those fragments into one small
//     silent MP4, exactly the shape of the Steam clips (no video converter needed).
//   - Kept in data\previews\youtube\<video id>.hd.mp4 (beta.9; <id>.mp4 = an older 480p one); the Steam and YouTube clips share one 400 MB limit (previews.trim).
//     A video with no usable stream is asked again after three days. One clip is made at a time.
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execFile } = require('child_process');

let log = () => {}, dataDir = '';
function init(o) { log = o.log || log; dataDir = o.dataDir || ''; }
let force = false; // (the device test runs the clip flow on Linux with a pretend helper)
const supported = () => force || process.platform === 'win32';
const helperPath = () => path.join(dataDir, 'tools', 'yt-dlp.exe');
const clipDir = () => path.join(dataDir, 'previews', 'youtube');
const isFile = f => { try { return fs.statSync(f).isFile(); } catch { return false; } };
const okId = id => /^[\w-]{6,20}$/.test(String(id || ''));
const SECONDS = 20, MAX_BYTES = 12 << 20;
const HELPER_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/';

// ---------- downloads ----------
// one HTTPS request, redirects followed; to a Buffer (cap bytes) or, with dest, to a file (onPct 0-100)
function fetch(url, o = {}, hops = 0) {
  return new Promise((resolve, reject) => {
    const u = new URL(url); if (u.protocol !== 'https:') return reject(new Error('not https'));
    const req = https.get(u, { headers: { 'User-Agent': 'Boxshelf', ...(o.headers || {}) } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops < 6) { res.resume(); return resolve(fetch(new URL(res.headers.location, url).toString(), o, hops + 1)); }
      if (res.statusCode !== 200 && res.statusCode !== 206) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const total = +res.headers['content-length'] || 0; let got = 0, last = -1;
      if (o.dest) { // (pipeline: an error on either side closes both and the part file goes)
        res.on('data', c => { got += c.length; const p = total ? Math.floor(got / total * 100) : 0; if (o.onPct && p !== last) { last = p; o.onPct(p); } });
        require('stream').pipeline(res, fs.createWriteStream(o.dest), e => { if (e) { try { fs.unlinkSync(o.dest); } catch {} reject(e); } else resolve(got); }); return;
      }
      const parts = []; res.on('data', c => { got += c.length; if (got > (o.cap || MAX_BYTES)) { req.destroy(new Error('too big')); return; } parts.push(c); });
      res.on('end', () => resolve(Buffer.concat(parts))); res.on('error', reject);
    });
    req.on('error', reject); req.setTimeout(o.timeout || 30000, () => req.destroy(new Error('timed out')));
  });
}

// ---------- the helper ----------
let helperFlight = null;
function helperState() { const f = helperPath(); try { const s = fs.statSync(f); return { have: s.size > 1e6, at: s.mtimeMs }; } catch { return { have: false, at: 0 }; } }
// fetches yt-dlp.exe once; true when it's there and its checksum matched
function getHelper(onPct) {
  if (!supported()) return Promise.resolve(false);
  if (helperState().have) return Promise.resolve(true);
  if (helperFlight) return helperFlight;
  helperFlight = (async () => {
    const f = helperPath(), part = f + '.part'; fs.mkdirSync(path.dirname(f), { recursive: true });
    const sums = (await fetch(HELPER_URL + 'SHA2-256SUMS', { cap: 1 << 20 })).toString('utf8');
    const want = ((/^([a-f0-9]{64})\s+\*?yt-dlp\.exe\s*$/mi.exec(sums) || [])[1] || '').toLowerCase(); if (!want) throw new Error('no checksum for yt-dlp.exe');
    await fetch(HELPER_URL + 'yt-dlp.exe', { dest: part, onPct, timeout: 60000 });
    const got = await new Promise((res, rej) => { const h = crypto.createHash('sha256'); fs.createReadStream(part).on('data', c => h.update(c)).on('end', () => res(h.digest('hex'))).on('error', rej); }); // (streamed: main never blocks on 25 MB)
    if (got !== want) { try { fs.unlinkSync(part); } catch {} throw new Error('checksum did not match'); }
    fs.renameSync(part, f); log('Console trailers: helper ready', Math.round(fs.statSync(f).size / 1e6) + ' MB'); return true;
  })().catch(e => { log('Console trailers: helper download failed:', e.message); return false; }).finally(() => { helperFlight = null; });
  return helperFlight;
}
// runs the helper (tests swap this for a pretend one)
// Every run ignores yt-dlp config files the user may have (their cookies, proxy or sorting must not change this). No JS
// runtime is offered on purpose: with one, YouTube hands out streams that refuse ranged downloads (HTTP 403; tested
// 2026-11-06). A run that times out
// is ended with its whole process tree (yt-dlp.exe starts a child of its own), so nothing is left running.
let run = (args, timeout) => new Promise((resolve, reject) => {
  const p = execFile(helperPath(), ['--ignore-config', ...args], { windowsHide: true, maxBuffer: 32 << 20 }, (e, out, err) => { clearTimeout(t); e ? reject(new Error(timedOut ? 'timed out' : String(err || e.message).trim().split('\n').pop().slice(0, 200))) : resolve(String(out)); });
  let timedOut = false; const t = setTimeout(() => { timedOut = true; try { execFile('taskkill', ['/T', '/F', '/PID', String(p.pid)], { windowsHide: true }, () => {}); } catch {} try { p.kill(); } catch {} }, timeout);
});
// the trailer's 720p (else 480p or smaller) H.264 video stream: { url, headers }. (beta.9: 720p first; YouTube's 480p is
// so compressed that it looked soft stretched behind the shelf, about a quarter of a Steam clip's data per second)
async function streamOf(id) {
  const fmt = ['136', '135', '134', '133', 'bv*[ext=mp4][vcodec^=avc1][height<=720]'].map(f => f + '[protocol=https]').join('/');
  const j = JSON.parse(await run(['--no-warnings', '--no-playlist', '--quiet', '-f', fmt, '-j', '--', 'https://www.youtube.com/watch?v=' + id], 45000));
  if (!j || !j.url || !/^https:\/\/[a-z0-9.-]+\.(googlevideo|youtube)\.com\//i.test(j.url)) throw new Error('no usable stream');
  const h = {}; for (const [k, v] of Object.entries(j.http_headers || {})) if (/^(user-agent|accept|accept-language|origin|referer)$/i.test(k)) h[k] = String(v);
  return { url: j.url, headers: h };
}

// ---------- the clip ----------
// the top-level MP4 boxes in a buffer: [{ type, start, size, head }] (stops at a box that runs past the end)
function boxes(buf) {
  const out = []; let at = 0;
  while (at + 8 <= buf.length) {
    let size = buf.readUInt32BE(at), head = 8; const type = buf.toString('latin1', at + 4, at + 8);
    if (size === 1) { if (at + 16 > buf.length) break; size = Number(buf.readBigUInt64BE(at + 8)); head = 16; }
    if (size < head) break; out.push({ type, start: at, size, head }); at += size; // (size 0, "to the end", stops here too)
  }
  return out;
}
// the fragment index: where the fragments start and how long / big each one is (null for a nested index)
function sidx(buf, box) {
  const h = box.head || 8, b = buf.subarray(box.start, box.start + box.size); if (b.length < h + 24) return null;
  const ver = b[h]; let p = h + 4; const timescale = b.readUInt32BE(p + 4); p += 8;
  let firstOffset; if (ver === 0) { firstOffset = b.readUInt32BE(p + 4); p += 8; } else { firstOffset = Number(b.readBigUInt64BE(p + 8)); p += 16; }
  p += 2; const n = b.readUInt16BE(p); p += 2; const refs = [];
  for (let i = 0; i < n && p + 12 <= b.length; i++, p += 12) { const r = b.readUInt32BE(p); if (r >>> 31) return null; refs.push({ size: r & 0x7fffffff, dur: b.readUInt32BE(p + 4) / (timescale || 1) }); }
  return { first: box.start + box.size + firstOffset, refs };
}
// from the stream's first bytes: the header to keep (everything before the index) and the byte range of ~20 s of fragments
function plan(head, seconds = SECONDS) {
  const bs = boxes(head), ix = bs.find(b => b.type === 'sidx'), moov = bs.find(b => b.type === 'moov');
  if (!ix || !moov || moov.start > ix.start || ix.start + ix.size > head.length) return null;
  const s = sidx(head, ix); if (!s || !s.refs.length) return null;
  let end = s.first, t = 0; for (const r of s.refs) { if (t >= seconds || end - s.first + r.size > MAX_BYTES) break; end += r.size; t += r.dur; }
  if (end === s.first) return null;
  return { headEnd: ix.start, from: s.first, to: end, seconds: Math.round(t) };
}
const ranged = (url, a, b) => url + (url.includes('?') ? '&' : '?') + 'range=' + a + '-' + b;

// ---------- the queue ----------
// One clip is made at a time, newest ask first: the game you're resting on now goes ahead of ones you browsed past. At
// most 3 wait (older ones are dropped), and a job whose game wasn't asked for in the last 30 s is skipped.
// Failures: a video that's gone (removed, private, age-restricted) is asked again after 3 days (.none); any other failure
// waits 10 minutes for that video; no connection pauses all clips for 2 minutes; six failures in a row pause them for 30.
// Three non-network failures in a row: YouTube changed something, so the helper updates itself (between jobs, at most
// once a session and only if it's over a week old).
const QMAX = 3, FRESH = 30e3;
const flights = new Map(), q = [], asked = new Map(), failAt = new Map();
let busy = false, fails = 0, updated = false, wantUpdate = false, pausedTill = 0;
const GONE = /video unavailable|this video is not available|private video|been removed|copyright|confirm your age|members[- ]only|no 480p stream|no usable stream|no fragment index/i;
const OFFLINE = /unable to download|getaddrinfo|ENOTFOUND|ENETUNREACH|ECONNRESET|ECONNREFUSED|EAI_AGAIN|timed out|socket hang up|HTTP 5\d\d/i;
function pump() {
  if (busy) return;
  if (wantUpdate) { wantUpdate = false; busy = true; run(['-U'], 120000).then(() => log('Console trailers: helper updated')).catch(e => log('Console trailers: helper update failed:', e.message)).finally(() => { busy = false; pump(); }); return; }
  if (!q.length) return; busy = true; const job = q.pop(); job.run().finally(() => { busy = false; pump(); });
}
// (beta.9) clips are kept as <id>.hd.mp4 (made from the 720p stream). A 480p one kept from before (<id>.mp4) still plays
// at once (cached) while the 720p one is made in the background, and is removed the next time after that
const hdOf = id => path.join(clipDir(), id + '.hd.mp4'), oldOf = id => path.join(clipDir(), id + '.mp4');
// the clip for one YouTube video: its file, or null (no helper, no usable stream, offline)
function clip(id) {
  if (!supported() || !okId(id)) return Promise.resolve(null);
  const out = hdOf(id), none = path.join(clipDir(), id + '.none'), now = Date.now();
  if (isFile(out)) { try { const t = new Date(); fs.utimesSync(out, t, t); } catch {} return Promise.resolve(out); }
  if (isFile(none)) { try { if (now - fs.statSync(none).mtimeMs < 3 * 864e5) return Promise.resolve(null); } catch {} }
  if (!helperState().have || now < pausedTill || now - (failAt.get(id) || 0) < 10 * 60e3) return Promise.resolve(null);
  asked.set(id, now); if (asked.size > 200) asked.delete(asked.keys().next().value);
  if (flights.has(id)) return flights.get(id);
  const p = new Promise(resolve => {
    q.push({ run: () => (Date.now() - (asked.get(id) || 0) > FRESH ? Promise.resolve(null) : make(id, out, none)).then(resolve, () => resolve(null)), drop: () => resolve(null) });
    while (q.length > QMAX) q.shift().drop();
  });
  flights.set(id, p); p.finally(() => flights.delete(id)); pump(); return p;
}
async function make(id, out, none) {
  try {
    fs.mkdirSync(clipDir(), { recursive: true });
    const st = await streamOf(id);
    let head = await fetch(ranged(st.url, 0, 65535), { headers: st.headers, cap: 1 << 20 }), pl = plan(head);
    if (!pl) { head = await fetch(ranged(st.url, 0, 524287), { headers: st.headers, cap: 2 << 20 }); pl = plan(head); }
    if (!pl) throw new Error('no fragment index (or a nested one) in the first 512 KB');
    const frags = await fetch(ranged(st.url, pl.from, pl.to - 1), { headers: st.headers, cap: MAX_BYTES + (1 << 20), timeout: 60000 });
    if (frags.length !== pl.to - pl.from) throw new Error('short read ' + frags.length + ' of ' + (pl.to - pl.from));
    const tmp = out + '.part'; fs.writeFileSync(tmp, Buffer.concat([head.subarray(0, pl.headEnd), frags])); fs.renameSync(tmp, out);
    fails = 0; failAt.delete(id); require('./previews').trim(); log('Console trailers: clip kept for', id, pl.seconds + ' s', Math.round(fs.statSync(out).size / 1024) + ' KB'); return out;
  } catch (e) {
    const m = String(e && e.message || e); log('Console trailers:', id, 'failed:', m);
    if (GONE.test(m)) { try { fs.writeFileSync(none, m.slice(0, 200)); } catch {} return null; }
    if (OFFLINE.test(m)) { pausedTill = Date.now() + 2 * 60e3; return null; } // (offline: nothing is marked, nothing counts)
    failAt.set(id, Date.now()); fails++;
    if (fails >= 6) { pausedTill = Date.now() + 30 * 60e3; fails = 0; log('Console trailers: paused for 30 minutes after repeated failures'); }
    else if (fails >= 3 && !updated && Date.now() - helperState().at > 7 * 864e5) { updated = true; wantUpdate = true; }
    return null;
  }
}
// a kept clip (marked as just shown, so the 400 MB limit drops the ones not seen for longest)
// (a 480p one from before: shown now, its 720p one made in the background for next time. The 480p file is removed the
// next time the clip is asked for, once the 720p one is there: never while it may still be playing)
function cached(id) { if (!okId(id)) return null; let f = hdOf(id);
  if (isFile(f)) { const old = oldOf(id); if (isFile(old)) { try { fs.unlinkSync(old); } catch {} } }
  else { f = oldOf(id); if (!isFile(f)) return null; clip(id).catch(() => {}); }
  try { const t = new Date(); fs.utimesSync(f, t, t); } catch {} return f; }
function size() { try { return fs.readdirSync(clipDir()).filter(n => n.endsWith('.mp4')).reduce((a, n) => { try { a.n++; a.bytes += fs.statSync(path.join(clipDir(), n)).size; } catch {} return a; }, { n: 0, bytes: 0 }); } catch { return { n: 0, bytes: 0 }; } }
function clear() { try { fs.rmSync(clipDir(), { recursive: true, force: true }); } catch {} }
function status() { const h = helperState(); return { supported: supported(), helper: h.have, getting: !!helperFlight, ...size() }; }

module.exports = { init, supported, status, helperState, getHelper, clip, cached, clear, size, plan, boxes, sidx, _setRun: f => { run = f; }, _fetch: f => { fetch = f; }, _force: v => { force = !!v; }, _reset: () => { failAt.clear(); asked.clear(); fails = 0; pausedTill = 0; updated = false; wantUpdate = false; } };
