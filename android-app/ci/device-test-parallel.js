// The device test's three groups at the same time on this PC (the way GitHub runs them, android.yml):
//   node ci/device-test-parallel.js www <out dir>
// Each group writes its screenshots and log to <out dir>/<group>; the failed checks of every group are listed at the end.
// Exit code 1 = a group failed. (One after another: node ci/web-device-test.js www <out dir>)
'use strict';
const { spawn } = require('child_process'), fs = require('fs'), path = require('path');
const WWW = process.argv[2] || 'www', OUT = path.resolve(process.argv[3] || '../out/device-test');
const GROUPS = ['thor', 'screens', 'windows'], t0 = Date.now();
const runOne = g => new Promise(res => {
  const dir = path.join(OUT, g); fs.mkdirSync(dir, { recursive: true });
  const log = fs.createWriteStream(path.join(dir, 'log.txt'));
  const p = spawn(process.execPath, [path.join(__dirname, 'web-device-test.js'), WWW, dir, '--group=' + g], { cwd: path.join(__dirname, '..'), env: { ...process.env, GITHUB_STEP_SUMMARY: '' } });
  let out = ''; p.stdout.on('data', d => { out += d; log.write(d); }); p.stderr.on('data', d => log.write(d));
  p.on('close', code => { log.end(); const head = (out.match(/### Boxshelf device test[^\n]*/) || ['(no result)'])[0];
    const bad = out.split('\n').filter(l => /^\| ❌/.test(l)); res({ g, code, head, bad, min: ((Date.now() - t0) / 60000).toFixed(1) }); });
});
Promise.all(GROUPS.map(runOne)).then(rs => {
  for (const r of rs) { console.log(`${r.head}  [${r.min} min]`); for (const b of r.bad) console.log('   ' + b.slice(0, 300)); }
  const failed = rs.some(r => r.code !== 0);
  console.log(failed ? 'device test: FAILED' : 'device test: all groups passed', `(${((Date.now() - t0) / 60000).toFixed(1)} min)`);
  process.exit(failed ? 1 : 0);
});
