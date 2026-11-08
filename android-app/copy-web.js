// Copies the shared UI (../renderer) into www/ for the Android build. renderer/ stays the single source of truth:
// never edit files in www/, they are overwritten on every build.
const fs = require('fs'), path = require('path');
const src = fs.realpathSync(path.join(__dirname, '..', 'renderer')), dst = process.env.BS_WWW_DIR ? path.resolve(process.env.BS_WWW_DIR) : path.join(__dirname, 'www'); // (iOS build: ios-app/copy-web.js points this at ios-app/www)
const SKIP = new Set(); // everything in renderer/ is used (index.html loads companion/tv-input.js too)
fs.rmSync(dst, { recursive: true, force: true });
fs.cpSync(src, dst, { recursive: true, dereference: true, filter: s => !SKIP.has(path.relative(src, s).split(path.sep)[0]) });
// Android-only extras (the Thor test meter, the bottom screen's page bottom.html / .js / .css) go into www/ only
for (const f of fs.readdirSync(path.join(__dirname, 'web-extras'))) fs.copyFileSync(path.join(__dirname, 'web-extras', f), path.join(dst, f));
const idx = path.join(dst, 'index.html'), html = fs.readFileSync(idx, 'utf8'), tag = '<script src="platform.js"></script>';
if (!html.includes(tag)) throw new Error('index.html has no platform.js tag; is renderer/ up to date?');
// shared logic (title rules) and Capacitor's bridge script, then the Android adapter right after the demo data (mock.js),
// so window.boxshelf is the real thing before platform.js and the app read it
fs.cpSync(path.join(__dirname, '..', 'shared'), path.join(dst, 'shared'), { recursive: true, dereference: true });
fs.copyFileSync(require.resolve('@capacitor/core/dist/capacitor.js', process.env.BS_CAP_RESOLVE_FROM ? { paths: [process.env.BS_CAP_RESOLVE_FROM] } : undefined), path.join(dst, 'capacitor.js'));
const mockTag = '<script src="mock.js"></script>';
if (!html.includes(mockTag)) throw new Error('index.html has no mock.js tag');
const build = require('./package.json').version + (process.env.GITHUB_SHA ? ' (' + process.env.GITHUB_SHA.slice(0, 7) + ')' : ' (local)');
fs.writeFileSync(path.join(dst, 'build-info.js'), `window.BS_BUILD = ${JSON.stringify(build)};\n`);
const androidTags = ['build-info.js', 'capacitor.js', 'shared/titles.js', 'android-systems.js', 'android-api.js', 'android-bottom.js', 'android-studio.js', 'android-wizard.js'].map(f => `<script src="${f}"></script>`).join('\n');
const VIEWPORT = '<meta name="viewport" content="width=device-width,initial-scale=1">';
if (!html.includes(VIEWPORT)) throw new Error('index.html viewport tag changed; update copy-web.js');
// android-early.js (the real pixel ratio for the scaled layout) must run before anything else reads it: right after the CSP tag
const CSP = html.match(/<meta http-equiv="Content-Security-Policy"[^>]*>/);
if (!CSP) throw new Error('index.html has no CSP meta tag; update copy-web.js');
// (beta.9) the Media tab's YouTube trailers play in YouTube's own frame (android-api.js previewYt): only youtube-nocookie.com
const CSP_A = CSP[0].replace(/(content="[^"]*)"/, "$1; frame-src 'self' https://www.youtube-nocookie.com\""); // ('self': the bottom screen's page, which the browser preview and tests show in a frame)
fs.writeFileSync(idx, html.replace(CSP[0], CSP_A + '\n<script src="android-early.js"></script>\n<script src="perf-meter.js"></script>').replace(VIEWPORT, '<meta name="viewport" content="width=1440,user-scalable=no">').replace('</head>', '<link rel="stylesheet" href="android.css">\n<link rel="stylesheet" href="android-studio.css">\n</head>').replace(mockTag, mockTag + '\n' + androidTags).replace(tag, tag + '\n<script src="thor-hud.js"></script>\n<script src="android-touch.js"></script>'));
// (0.3.2) magazines & guides: android-reading.js after the other Android scripts (it builds on android-api.js), its stylesheet last
{ const h = fs.readFileSync(idx, 'utf8'), after = '<script src="android-wizard.js"></script>';
  if (!h.includes(after)) throw new Error('index.html has no android-wizard.js tag; update copy-web.js');
  fs.writeFileSync(idx, h.replace(after, after + '\n<script src="android-reading.js"></script>\n<script src="android-settings.js"></script>').replace('</head>', '<link rel="stylesheet" href="android-reading.css">\n</head>')); } // (0.3.4: android-settings.js, last of the Settings patches)
// (0.3.5) RetroAchievements (android-ra.js): right before android-settings.js, so its Settings patch is in that chain
{ const h = fs.readFileSync(idx, 'utf8'), at = '<script src="android-settings.js"></script>';
  if (!h.includes(at)) throw new Error('index.html has no android-settings.js tag; update copy-web.js');
  fs.writeFileSync(idx, h.replace(at, '<script src="android-ra.js"></script>\n' + at)); }
// (0.3.5) the extra shelf themes moved into renderer/ (themes-extra.js/.css, 1.75): index.html loads them on both platforms
let n = 0; (function count(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? count(path.join(d, e.name)) : n++; })(dst);
console.log(`copied renderer -> www (${n} files)`);
