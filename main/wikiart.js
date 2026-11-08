// Box art from the Super Mario Wiki (mariowiki.com, a MediaWiki): official box scans of Nintendo's own games for every
// region, uploaded as "<Game> NA box art.jpg", "<Game> Box EUR.png", "<Game> EUR back.jpg"… The automatic art check
// asks it only when no other source had the part, on the Switch 2 shelf (its boxes are there months before the art
// databases have them). Found through the wiki's own search API, matched by the file name starting with
// the game's name; answers are cached for a week (data\boxart-cache\wikiart.json), one request at a time.
const fs = require('fs');
const path = require('path');
const { net } = require('electron');

const API = 'https://www.mariowiki.com/api.php';
// Switch 2 only: a file name can't say which console its box is for, and older consoles share titles with their
// re-releases ("Super Mario Galaxy" would find the Wii box for the Switch one). Switch 2 is where the databases lag.
const SYS = new Set(['sw2']);
const TTL = 7 * 864e5, TIMEOUT = 10000;
const UA = `Boxshelf/${(() => { try { return require('../package.json').version; } catch { return '0'; } })()} (box art for a personal game launcher)`;
let file = null, cache = null, saveT = null, log = () => {}, norm = s => String(s || '').toLowerCase(), chain = Promise.resolve();
function init(o) { file = o.dir ? path.join(o.dir, 'wikiart.json') : null; log = o.log || log; norm = o.norm || norm; cache = null; }
const has = sysId => SYS.has(sysId);

const CACHE_V = 2; // (1: kept only the files that passed the rules of the day)
function cacheGet() { if (cache) return cache; try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j && j.v === CACHE_V && j.q) cache = j; } catch {} return cache || (cache = { v: CACHE_V, q: {} }); }
function cacheSave() { if (!file) return; clearTimeout(saveT); saveT = setTimeout(() => { const c = cacheGet(), now = Date.now(); for (const [k, v] of Object.entries(c.q)) if (now - v[0] > TTL) delete c.q[k]; fs.promises.writeFile(file, JSON.stringify(c)).catch(() => {}); }, 1500); if (saveT.unref) saveT.unref(); }

// every image file whose name has these words, with its address: [{ name, url, w, h }] (one request at a time)
function search(words) {
  const run = async () => {
    const c = cacheGet(), k = norm(words), hit = c.q[k];
    if (hit && Date.now() - hit[0] < TTL) return hit[1];
    const q = new URLSearchParams({ action: 'query', format: 'json', generator: 'search', gsrnamespace: '6', gsrlimit: '50', gsrsearch: `intitle:"${String(words).replace(/"/g, '')}"`, prop: 'imageinfo', iiprop: 'url|size|mime' });
    const list = [];
    const r = await net.fetch(API + '?' + q, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT) });
    if (!r.ok) throw new Error('Mario Wiki answered ' + r.status);
    const j = await r.json();
    for (const p of Object.values((j && j.query && j.query.pages) || {})) {
      const ii = p && p.imageinfo && p.imageinfo[0]; if (!ii || typeof ii.url !== 'string') continue;
      list.push({ name: String(p.title || '').replace(/^File:/, '').slice(0, 300), url: ii.url.slice(0, 600), mime: String(ii.mime || ''), w: +ii.width || 0, h: +ii.height || 0 });
    }
    c.q[k] = [Date.now(), list]; cacheSave(); return list; // the whole answer: what's usable is decided when it's read
  };
  const p = chain.then(run, run); chain = p.catch(() => {}); return p.then(l => l.filter(usable));
}
// an image the wiki serves from its own hosts (the type, when the answer leaves it out, from the extension)
const usable = f => !!f && (f.mime ? /^image\/(jpeg|png|webp)$/.test(f.mime) : /\.(jpe?g|png|webp)$/i.test(f.url || ''))
  && /^https:\/\/([a-z0-9-]+\.)*(mariowiki\.com|mario\.wiki\.gallery)\/[^\s"<>]+$/i.test(f.url || '');
// words a box scan's file name may carry after the game's name: region codes and box words
const ALLOW = new Set(('na us usa ca can canada north america uk usk eur eu europe european au aus australia nz pal jp jpn japan japanese kr kor korea ' +
  'south korean tw taiwan hk hong kong sg singapore th thailand za africa sa sau saudi arabia ae uae br brazil mx mex mexico de germany fr france ' +
  'es spain it italy nl netherlands dutch pt portugal se sweden dk no fi ru russia cn chn china asia latam sca scandinavia nordic ' +
  'box boxart art cover front back final release standard physical version packaging alt alternate nsw ns2 switch nintendo').split(' '));
// region words in the file names → how much we want them (North America first, then English PAL, then the rest)
const regionScore = (n, want) => {
  const us = /\b(na|us|usa|ca|canada|north america)\b/i.test(n), en = /\b(uk|usk|eur|europe|au|aus|australia|pal|nz)\b/i.test(n), jp = /\b(jp|jpn|japan)\b/i.test(n);
  if (want === 'jpn') return jp ? 3 : us ? 2 : en ? 1 : 0;
  if (want === 'eur') return en ? 3 : us ? 2 : jp ? 0 : 1;
  return us ? 3 : en ? 2 : jp ? 0 : 1;
};
// The best file for a game's front or back, or null. names: its names, most specific first (covers.lookupNames); the
// file's name must start with one of them. region: 'usa' | 'eur' | 'jpn' | ''.
async function find(sysId, names, part, region) {
  if (!has(sysId) || (part !== 'front' && part !== 'back')) return null;
  // (Switch 2: its own name only; without "Nintendo Switch 2 Edition" it would find the Switch game's box)
  for (const name of (names || []).slice(0, sysId === 'sw2' ? 1 : 2)) {
    const want = norm(name); if (want.split(' ').length < 2 && want.length < 6) continue; // one short word finds every file
    let list; try { list = await search(name); } catch (e) { log('Mario Wiki:', e.message); return null; }
    const ok = list.filter(f => {
      const n = norm(f.name.replace(/\.[a-z]+$/i, ''));
      if (!n.startsWith(want)) return false;
      const rest = n.slice(want.length);
      if (!/\b(box|boxart|cover|packaging)\b/.test(n) && !/\bback\b/.test(rest)) return false;
      if (/\b(pre ?release|prerelease|prototype|mock ?up|concept|sticker|standee|wallpaper|logo|icon|guide)\b/.test(n)) return false;
      // after the name only region codes and box words, so "Paper Mario" never takes "Paper Mario The Thousand-Year Door
      // box art"; other words only after a "+" (a bundle's add-on: "… Switch 2 Edition + Meetup in Bellabel Park")
      const extra = rest.split(' ').filter(w => w && !ALLOW.has(w));
      if (extra.some(w => /^(\d+|ii|iii|iv)$/.test(w))) return false; // "Wonder 2"
      if (extra.length && !/\+/.test(f.name)) return false;
      const back = /\bback\b/.test(rest); if ((part === 'back') !== back) return false;
      return f.h >= 300 && f.h >= f.w * 1.1; // a box is portrait, and big enough to use
    });
    if (!ok.length) continue;
    ok.sort((a, b) => (regionScore(b.name, region) - regionScore(a.name, region)) || (b.h - a.h));
    return { url: ok[0].url, name: ok[0].name, ext: (/\.(png|jpe?g|webp)$/i.exec(ok[0].url) || ['', 'jpg'])[1].toLowerCase().replace('jpeg', 'jpg') };
  }
  return null;
}
module.exports = { init, has, find, _t: { regionScore } };
