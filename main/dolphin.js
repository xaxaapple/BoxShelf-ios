// Finds Dolphin's user folder and any GameCube startup files (IPL.bin) in it.
// Dolphin plays the GameCube startup sequence when it finds
//   <Dolphin user folder>\GC\<USA|EUR|JAP>\IPL.bin
// and "Skip Main Menu" is off (Boxshelf turns that off per launch).
const path = require('path');
const fs = require('fs');
const { isFile, isDir } = require('./paths');

const REGIONS = ['USA', 'EUR', 'JAP'];

// In the order Dolphin itself picks its user folder: portable (portable.txt next to Dolphin.exe) keeps its data in .\User,
// else Documents\Dolphin Emulator when it exists (older installs keep using it), else %APPDATA%\Dolphin Emulator. AppData
// came first here, so "Open the folder" made a GC\USA folder there that a Documents-based Dolphin never looks in.
// (A User folder without portable.txt isn't used by Dolphin: still searched for an IPL.bin, last.)
// (the same list emucfg tweaks and raemu reads settings from, so the three never disagree about where Dolphin lives)
function userDirs(dolphinExe) {
  const base = dolphinExe ? path.dirname(dolphinExe) : '';
  const used = require('./emucfg').dolphinUserDirs(dolphinExe); // the folders Dolphin may really be using (the last one is what a new install makes)
  const dirs = [...used, ...require('./emucfg').dolphinUserDirs('')]; // portable: an IPL.bin left in Documents / AppData is still found
  if (base && isDir(path.join(base, 'User'))) dirs.push(path.join(base, 'User'));
  const all = [...new Set(dirs)]; all.used = used; return all;
}

function findIpl(dolphinExe) {
  const dirs = userDirs(dolphinExe);
  const found = [];
  for (const d of dirs) for (const r of REGIONS) {
    const f = path.join(d, 'GC', r, 'IPL.bin');
    if (isFile(f)) found.push({ region: r, file: f });
  }
  // Where a new IPL.bin should go: the folder Dolphin uses (portable, else the first that exists, else where a fresh install
  // will put it: AppData)
  const used = dirs.used || dirs, home = used.find(isDir) || used[used.length - 1];
  return { found, userDir: home, usaFolder: path.join(home, 'GC', 'USA') };
}

function ensureIplFolder(dolphinExe, region = 'USA') {
  const { userDir } = findIpl(dolphinExe);
  const dir = path.join(userDir, 'GC', REGIONS.includes(region) ? region : 'USA');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = { findIpl, ensureIplFolder };
