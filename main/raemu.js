'use strict';
// Per console: will RetroAchievements actually work in its emulator? Reads each emulator's own
// settings (portable folder first, then the usual Windows places). Never returns tokens.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const emucfg = require('./emucfg'); // where each emulator keeps its settings: one answer for the tweaks and this check

const exists = p => fsp.access(p).then(() => true, () => false);
async function readText(p) { try { return (await fsp.readFile(p, 'utf8')).replace(/^﻿/, ''); } catch { return null; } }

// { section(lowercase): { key(lowercase): value } }
function parseIni(text) {
  const out = {}; let cur = out[''] = {};
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line[0] === ';' || line[0] === '#') continue;
    const sec = /^\[(.+)\]$/.exec(line); if (sec) { cur = out[sec[1].trim().toLowerCase()] = out[sec[1].trim().toLowerCase()] || {}; continue; }
    const i = line.indexOf('='); if (i < 1) continue;
    cur[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}
const truthy = v => /^(true|1|yes|on)$/i.test(String(v == null ? '' : v).trim());

async function firstExisting(list) { for (const p of list) if (p && await exists(p)) return p; return null; }

// (Documents may be the OneDrive one: Windows moves it there when OneDrive backs it up)
async function dolphinIni(exe, env) {
  return firstExisting(emucfg.dolphinUserDirs(exe, env).map(r => path.join(r, 'Config', 'RetroAchievements.ini')));
}
async function checkDolphin(exe, env) {
  const f = await dolphinIni(exe, env); if (!f) return { state: 'unknown', user: '', detail: 'Dolphin settings not found (run Dolphin once)' };
  const a = parseIni(await readText(f)).achievements || {};
  const extra = truthy(a.hardcoreenabled) ? 'Hardcore mode on' : '';
  if (!truthy(a.enabled)) return { state: 'off', user: a.username || '', detail: 'Achievements are turned off in Dolphin' };
  if (!a.apitoken) return { state: 'signed-out', user: a.username || '', detail: 'Not signed in to RetroAchievements in Dolphin' };
  return { state: 'ok', user: a.username || '', detail: extra };
}

async function ppssppSystem(exe, env) {
  const dir = path.dirname(exe);
  const cands = [path.join(dir, 'memstick')];
  const inst = await readText(path.join(dir, 'installed.txt'));
  if (inst && inst.trim()) cands.push(inst.split(/\r?\n/)[0].trim());
  for (const d of emucfg.docsDirs(env)) cands.push(path.join(d, 'PPSSPP'));
  for (const m of cands) { const sys = path.join(m, 'PSP', 'SYSTEM'); if (await exists(path.join(sys, 'ppsspp.ini'))) return sys; }
  return null;
}
async function checkPpsspp(exe, env) {
  const sys = await ppssppSystem(exe, env); if (!sys) return { state: 'unknown', user: '', detail: 'PPSSPP settings not found (run PPSSPP once)' };
  const a = parseIni(await readText(path.join(sys, 'ppsspp.ini'))).achievements || {};
  const user = a.achievementsusername || '';
  if (!truthy(a.achievementsenable)) return { state: 'off', user, detail: 'Achievements are turned off in PPSSPP' };
  if (!(await exists(path.join(sys, 'ppsspp_retroachievements.dat')))) return { state: 'signed-out', user, detail: 'Not signed in to RetroAchievements in PPSSPP' };
  return { state: 'ok', user, detail: truthy(a.achievementschallengemode) ? 'Hardcore mode on' : '' };
}

async function pcsx2Ini(exe, env) {
  return firstExisting(emucfg.pcsx2Inis(exe, env));
}
async function checkPcsx2(exe, env) {
  const f = await pcsx2Ini(exe, env); if (!f) return { state: 'unknown', user: '', detail: 'PCSX2 settings not found (run PCSX2 once)' };
  const a = parseIni(await readText(f)).achievements || {};
  if (!truthy(a.enabled)) return { state: 'off', user: a.username || '', detail: 'Achievements are turned off in PCSX2' };
  if (!a.token) return { state: 'signed-out', user: a.username || '', detail: 'Not signed in to RetroAchievements in PCSX2' };
  return { state: 'ok', user: a.username || '', detail: truthy(a.challengemode) ? 'Hardcore mode on' : '' };
}

const EMU = { Dolphin: checkDolphin, PPSSPP: checkPpsspp, PCSX2: checkPcsx2 };
const SYSTEMS = [['gc', 'Dolphin'], ['wii', 'Dolphin'], ['psp', 'PPSSPP'], ['ps2', 'PCSX2']];

// cfg: the app config; supported: RA console ids (main/ra.js CONSOLE_ID); env: for tests
async function check(cfg, supported, env = process.env) {
  const raUser = String((cfg && cfg.ra && cfg.ra.user) || '').trim();
  const memo = new Map(); // gc and wii often share one Dolphin
  return Promise.all(SYSTEMS.map(async ([system, emulator]) => {
    const base = { system, emulator };
    if (!supported[system]) return { ...base, state: 'unsupported', user: '', detail: system === 'wii' ? 'Few Wii games have achievement sets yet' : 'RetroAchievements does not cover this console' };
    const exe = String((cfg && cfg.systems && cfg.systems[system] && cfg.systems[system].emulator) || '').trim();
    if (!exe) return { ...base, state: 'no-emulator', user: '', detail: `No ${emulator} set up for this console` };
    const key = emulator + '|' + path.resolve(exe);
    if (!memo.has(key)) memo.set(key, EMU[emulator](exe, env).catch(() => ({ state: 'unknown', user: '', detail: `Could not read ${emulator} settings` })));
    const r = { ...base, ...(await memo.get(key)) };
    if (r.state === 'ok' && raUser && r.user && r.user.toLowerCase() !== raUser.toLowerCase())
      return { ...r, state: 'other-user', detail: `${emulator} is signed in as ${r.user}, not ${raUser}` };
    return r;
  }));
}

module.exports = { check, parseIni };
