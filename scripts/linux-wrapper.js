// electron-builder artifactBuildStarted hook (package.json build.artifactBuildStarted). Only the Linux AppImage is touched:
// Windows builds are left exactly as they are.
//
// (beta.8) Steam Deck: an Electron AppImage started by Steam (a non-Steam game, and above all in Game Mode) needs
// --no-sandbox, and Game Mode's compositor (gamescope) wants Chromium on X11 (Xwayland) rather than Wayland. Other
// Electron launchers tell users to type these into Steam's launch options (Heroic's Steam Deck wiki); Boxshelf adds them
// itself. The program is renamed <name>-bin and <name> becomes this small script, which the AppImage's own AppRun starts:
//   started by Steam (Desktop or Game Mode)  -> --no-sandbox
//   in Game Mode (gamescope)                 -> --ozone-platform=x11
// Started from the desktop it adds nothing (Chromium's sandbox stays on).
// It runs as the AppImage is about to be made: after electron-builder has set the program's fuses (an afterPack hook ran
// before that, and the fuses step then found the script instead of the program).
'use strict';
const fs = require('fs');
const path = require('path');

const SCRIPT = `#!/bin/sh
# Boxshelf (Linux): adds the options Steam and the Steam Deck's Game Mode need, then starts Boxshelf.
# (made by scripts/linux-wrapper.js when the AppImage was built)
here="$(dirname "$(readlink -f "$0")")"
if [ -n "\${SteamGameId}\${SteamClientLaunch}\${SteamEnv}\${SteamGamepadUI}\${SteamAppId}" ]; then
  set -- --no-sandbox "$@"
fi
if [ "\${XDG_CURRENT_DESKTOP}" = "gamescope" ] || [ -n "\${GAMESCOPE_WAYLAND_DISPLAY}" ] || [ -n "\${SteamGamepadUI}" ]; then
  set -- --ozone-platform=x11 "$@"
fi
exec "$here/@BIN@" "$@"
`;
const ARCH = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }; // (electron-builder's Arch numbers)

// dir: the unpacked app (dist/linux-unpacked); name: the program's file name. Returns true when the wrapper was put in.
function wrap(dir, name) {
  const bin = path.join(dir, name), real = path.join(dir, name + '-bin');
  if (!fs.existsSync(bin)) throw new Error('linux-wrapper: the program ' + bin + ' is missing');
  const head = Buffer.alloc(4); const fd = fs.openSync(bin, 'r'); fs.readSync(fd, head, 0, 4, 0); fs.closeSync(fd);
  if (!head.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) { if (fs.existsSync(real)) return false; throw new Error('linux-wrapper: ' + bin + ' is not the program'); } // (already wrapped)
  if (fs.existsSync(real)) fs.rmSync(real);
  fs.renameSync(bin, real);
  fs.writeFileSync(bin, SCRIPT.replace(/@BIN@/g, name + '-bin'), { mode: 0o755 });
  return true;
}

module.exports = async function linuxWrapper(event) {
  if (!event || event.targetPresentableName !== 'AppImage') return;
  const arch = ARCH[event.arch] || 'x64', out = path.dirname(event.file);
  const dir = [path.join(out, arch === 'x64' ? 'linux-unpacked' : `linux-${arch}-unpacked`), path.join(out, 'linux-unpacked')].find(d => fs.existsSync(d));
  if (!dir) throw new Error('linux-wrapper: the unpacked app was not found beside ' + event.file);
  let name = 'boxshelf'; try { name = String(require(path.join(__dirname, '..', 'package.json')).name || name); } catch {}
  if (wrap(dir, name)) console.log('  • linux-wrapper: Steam / Game Mode launch wrapper put in for', name);
};
module.exports.SCRIPT = SCRIPT;
module.exports.wrap = wrap;
