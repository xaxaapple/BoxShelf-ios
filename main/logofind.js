// Customize → Logo → Find a logo: a hand-picked list of official console logos on Wikimedia Commons. No search, no account, no API:
// each entry is the file's fixed address on upload.wikimedia.org (SVGs as Commons' own 960px PNG render, a standard size its
// thumbnailer always serves), checked by hand to be the real logo and Public domain / CC0 (no credit needed). If upload.wikimedia.org
// refuses a render, the same path on thumb.wikimedia.org (where Commons now hands out its renders) is tried once.
// Files are cached a week in userData/logo-find/<id>/. Keys are made here; a download takes only a key, never an address from the screen.
const fs = require('fs');
const path = require('path');

const VER = (() => { try { return require('../package.json').version; } catch { return '0'; } })();
const UA = `Boxshelf/${VER} (personal emulator front end for TVs) Electron`;
const TTL = 7 * 864e5, TIMEOUT = 15000, MAX_BYTES = 6 * 1048576;
const HOSTS = ['https://upload.wikimedia.org/wikipedia/commons/', 'https://thumb.wikimedia.org/wikipedia/commons/'];
// per console: [label, licence, path under /wikipedia/commons/] — best first
const CON = {
  gc: [
    ["GameCube wordmark", "Public domain", "thumb/2/29/Nintendo_GameCube_Official_Logo.svg/960px-Nintendo_GameCube_Official_Logo.svg.png"],
    ["GameCube cube symbol", "CC0", "thumb/7/72/Nintendo_GameCube_symbol_logo.svg/960px-Nintendo_GameCube_symbol_logo.svg.png"]
  ],
  wii: [
    ["Wii logo", "Public domain", "thumb/b/bc/Wii.svg/960px-Wii.svg.png"]
  ],
  wiiu: [
    ["Wii U logo", "Public domain", "thumb/7/7e/WiiU.svg/960px-WiiU.svg.png"]
  ],
  sw: [
    ["Switch logo, wide", "Public domain", "a/a0/Nintendo_Switch_logo%2C_horizontal.png"],
    ["Switch logo, stacked", "Public domain", "thumb/5/5d/Nintendo_Switch_Logo.svg/960px-Nintendo_Switch_Logo.svg.png"],
    ["Switch logo, red", "Public domain", "thumb/f/f0/Nintendo_Switch_logo.svg/960px-Nintendo_Switch_logo.svg.png"]
  ],
  n3ds: [
    ["3DS logo", "Public domain", "thumb/8/89/Nintendo_3DS_logo.svg/960px-Nintendo_3DS_logo.svg.png"],
    ["3DS XL logo", "Public domain", "thumb/9/9e/Nintendo_3DS_XL_logo.svg/960px-Nintendo_3DS_XL_logo.svg.png"],
    ["New 3DS logo", "Public domain", "thumb/b/be/New_Nintendo_3DS_logo.svg/960px-New_Nintendo_3DS_logo.svg.png"]
  ],
  ps2: [
    ["PS2 logo", "Public domain", "thumb/7/76/PlayStation_2_logo.svg/960px-PlayStation_2_logo.svg.png"],
    ["PlayStation 2 wordmark", "Public domain", "thumb/8/8a/PlayStation_2_wordmark.svg/960px-PlayStation_2_wordmark.svg.png"]
  ],
  ps3: [
    ["PS3 logo", "Public domain", "thumb/0/05/PlayStation_3_logo_%282009%29.svg/960px-PlayStation_3_logo_%282009%29.svg.png"],
    ["PS3 logo, wide", "Public domain", "thumb/d/d9/PlayStation_3_Logo.svg/960px-PlayStation_3_Logo.svg.png"],
    ["PlayStation 3 launch wordmark", "Public domain", "thumb/a/a3/Logo_of_the_PlayStation_3_%282006%E2%80%932009%29.svg/960px-Logo_of_the_PlayStation_3_%282006%E2%80%932009%29.svg.png"]
  ],
  ps4: [
    ["PS4 logo with symbol", "Public domain", "thumb/8/87/PlayStation_4_logo_and_wordmark.svg/960px-PlayStation_4_logo_and_wordmark.svg.png"],
    ["PS4 logo", "Public domain", "thumb/c/c4/PlayStation_4_-_Logo.svg/960px-PlayStation_4_-_Logo.svg.png"]
  ],
  psp: [
    ["PSP logo", "Public domain", "thumb/0/0e/PSP_Logo.svg/960px-PSP_Logo.svg.png"]
  ],
  x360: [
    ["Xbox 360 logo", "Public domain", "thumb/1/1b/Xbox_360_logo.svg/960px-Xbox_360_logo.svg.png"],
    ["Xbox 360 logo with TM", "Public domain", "thumb/1/18/Xbox_360_wordmark.svg/960px-Xbox_360_wordmark.svg.png"],
    ["Xbox 360 logo, alternate", "Public domain", "thumb/8/85/X_Box_360_logo.svg/960px-X_Box_360_logo.svg.png"]
  ]
};

let log = () => {}, fetchFn = null;
function init(o = {}) { log = o.log || log; fetchFn = o.fetch || null; }
const ids = () => Object.keys(CON);
const doFetch = u => (fetchFn || require('electron').net.fetch)(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(TIMEOUT), cache: 'no-store' });
let active = 0; const waitq = [];
async function limited(fn) { while (active >= 2) await new Promise(r => waitq.push(r)); active++; try { return await fn(); } finally { active--; const n = waitq.shift(); if (n) n(); } }
const items = id => CON[id].map(([label, licence, p], i) => ({ key: 'cm-' + id + '-' + i, source: 'commons', label, licence, by: '', p }));

// { list: [{ key, source, label, licence, by }] } (no addresses: those stay here)
async function list(id) {
  if (!CON[id]) throw new Error('Unknown system.');
  return { list: items(id).map(({ key, source, label, licence, by }) => ({ key, source, label, licence, by })) };
}
const PIC = b => b.length > 64 && ((b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e) || (b[0] === 0xff && b[1] === 0xd8));
// one key (from this console's list only) → { file, ext, source }
async function file(id, key, dir) {
  if (!CON[id] || typeof key !== 'string') throw new Error('Unknown logo.');
  const m = items(id).find(x => x.key === key); if (!m) throw new Error('That logo is no longer offered.');
  const d = path.join(dir, id), f = path.join(d, key.replace(/[^a-z0-9-]/gi, '_') + '.png');
  let have = false; try { const st = fs.statSync(f); have = st.size > 64; if (have && Date.now() - st.mtimeMs < TTL) return { file: f, ext: '.png', source: m.source }; } catch {}
  let last = null;
  for (const h of (m.p.startsWith('thumb/') ? HOSTS : HOSTS.slice(0, 1))) {
    let r; try { r = await limited(() => doFetch(h + m.p)); } catch (e) { last = new Error("Couldn't reach Wikimedia Commons. Check the internet connection and try again."); last.code = 'offline'; continue; }
    if (!r.ok) { last = new Error('Wikimedia Commons answered ' + r.status); if (r.status === 404) last.code = 'missing'; continue; }
    const b = Buffer.from(await r.arrayBuffer()); if (b.length > MAX_BYTES || !PIC(b)) { last = Object.assign(new Error("That file isn't a picture."), { code: 'missing' }); continue; }
    fs.mkdirSync(d, { recursive: true }); await fs.promises.writeFile(f + '.part', b); await fs.promises.rename(f + '.part', f);
    return { file: f, ext: '.png', source: m.source };
  }
  if (have) return { file: f, ext: '.png', source: m.source }; // offline (or refused) a week later: the copy from last time still serves
  log('Find a logo:', id, key, last && last.message); throw last || new Error("Couldn't get that logo.");
}
module.exports = { init, list, file, ids, _t: { CON, items, reset: () => {} } };
