// Beta update notice. Once per start (a little after the window is up), when Settings → About → "Check for new betas"
// is on, asks the public beta page's Releases which version is newest and tells the shelf when it's newer than this
// one. Nothing is downloaded or installed: the notice opens the download page. Offline, or with GitHub busy, it stays
// quiet and the next start tries again.
const https = require('https');

const REPO = 'sassiestrhihno/boxshelf-beta';
const PAGE = `https://github.com/${REPO}`;
const LINKS = { page: PAGE, releases: `${PAGE}/releases`, issues: `${PAGE}/issues/new/choose` };

let log = () => {}, last = null, inflight = null;
function init(logger) { if (logger) log = logger; }

// "1.82.0-beta.1" → { nums: [1, 82, 0], pre: ['beta', 1] }; a release without a pre part is newer than its betas
function parse(v) {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/.exec(String(v || '').trim());
  if (!m) return null;
  return { nums: [+m[1], +(m[2] || 0), +(m[3] || 0)], pre: m[4] ? m[4].split('.').map(x => (/^\d+$/.test(x) ? +x : x)) : [] };
}
// < 0: a is older; 0: the same; > 0: a is newer
function compare(a, b) {
  const x = parse(a), y = parse(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] - y.nums[i];
  if (!x.pre.length || !y.pre.length) return (x.pre.length ? -1 : 0) + (y.pre.length ? 1 : 0);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    if (typeof p === 'number' && typeof q === 'number') return p - q;
    if (typeof p === 'number') return -1;
    if (typeof q === 'number') return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

function getJson(url, version) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': `Boxshelf/${version}`, Accept: 'application/vnd.github+json' } }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`GitHub answered ${res.statusCode}`)); }
      let b = ''; res.setEncoding('utf8');
      res.on('data', c => { b += c; if (b.length > 2e6) req.destroy(new Error('answer too big')); });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch { reject(new Error('unreadable answer')); } });
      res.on('error', reject);
    });
    req.on('error', reject); req.setTimeout(15000, () => req.destroy(new Error('timed out')));
  });
}

// { current, latest, newer, url, notes, checkedAt } or { current, error }
async function check(current, force = false) {
  if (!force && last && Date.now() - last.checkedAt < 6 * 3600e3) return last;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      // the list, not /releases/latest: that one skips pre-releases, and every beta is one
      const list = await getJson(`https://api.github.com/repos/${REPO}/releases?per_page=10`, current);
      const best = (Array.isArray(list) ? list : []).filter(r => r && !r.draft && parse(r.tag_name))
        .sort((p, q) => compare(q.tag_name, p.tag_name))[0];
      const latest = best ? String(best.tag_name).replace(/^v/, '') : null;
      last = { current, latest, newer: !!latest && compare(latest, current) > 0, url: best ? best.html_url : LINKS.releases,
        notes: best && typeof best.body === 'string' ? best.body.slice(0, 2000) : '', checkedAt: Date.now() };
      log('Update check:', latest ? `newest ${latest}${last.newer ? ' (newer)' : ''}` : 'no releases yet');
      return last;
    } catch (e) {
      log('Update check failed:', e.message);
      return { current, error: e.message, checkedAt: Date.now() };
    } finally { inflight = null; }
  })();
  return inflight;
}

module.exports = { init, check, compare, LINKS };
