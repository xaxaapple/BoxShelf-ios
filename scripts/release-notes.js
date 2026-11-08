// Prints a version's notes (renderer/whatsnew.js, the same ones the app shows) as Markdown for its GitHub release, so the
// release page, the update card's highlights and Settings → What's new always say the same thing.
//   node scripts/release-notes.js            the newest version
//   node scripts/release-notes.js 1.82.0-beta.7
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const box = { window: {} }; vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'whatsnew.js'), 'utf8'), box);
const all = box.window.BS_WHATSNEW || [], want = process.argv[2];
const e = want ? all.find(x => x.version === want || x.android === want) : all[0];
if (!e) { console.error(`No notes for ${want || 'any version'} in renderer/whatsnew.js`); process.exit(1); }
// the highlights come first as bullets: the update card shows the first three of them
const out = [`## ${e.title}`, '', ...e.highlights.map(h => `- ${h}`), ''];
if (e.platforms && e.platforms.length) { out.push('### Where it works', ''); for (const p of e.platforms) out.push(`- ${p}`); out.push(''); }
for (const s of e.sections || []) { out.push(`### ${s.h}`, ''); for (const [h, more] of s.items) out.push(`- **${h}**: ${more}`); out.push(''); }
process.stdout.write(out.join('\n'));
