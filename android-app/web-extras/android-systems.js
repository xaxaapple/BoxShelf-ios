// Android: which systems Boxshelf shows and how each emulator app is started with a game.
// Launch data follows ES-DE's Android rules (es_systems.xml / es_find_rules.xml); newer emulators (Azahar, NetherSX2,
// Eden, Cemu) are also found by name pattern, and their activity is looked up on the device, so forks and renamed
// builds work too.
//
// A launch spec:  activity: [full class names to try, or '*Suffix' to match the end of an activity name]
//                 action / category: intent action and category (omit for none)
//                 data: 'doc' = the game's content:// document (read access is granted to the emulator)
//                       'path' = the plain file path (/storage/emulated/0/…)
//                 extras: { key: value } where value is '$DOC', '$PATH', '$CORE', '$CFG', or a literal; {bool:true} for booleans
//                 flags: 'clearTask', 'clearTop'
(function () {
  const VIEW = 'android.intent.action.VIEW', MAIN = 'android.intent.action.MAIN';
  const RA = { id: 'retroarch', name: 'RetroArch', packages: ['com.retroarch.aarch64', 'com.retroarch', 'com.retroarch.ra32'], match: /^com\.retroarch/,
    launch: { activity: ['com.retroarch.browser.retroactivity.RetroActivityFuture'], extras: { ROM: '$PATH', LIBRETRO: '$CORE', CONFIGFILE: '$CFG' } } };
  const E = { // emulator apps, by id
    dolphin: { name: 'Dolphin', packages: ['org.dolphinemu.dolphinemu'], match: /dolphin/i,
      launch: { activity: ['org.dolphinemu.dolphinemu.ui.main.TvMainActivity', '*ui.main.MainActivity'], action: MAIN, category: 'android.intent.category.LEANBACK_LAUNCHER', extras: { AutoStartFile: '$DOC' } },
      variants: { 'org.mm.jr': { action: VIEW, category: null, activity: ['org.dolphinemu.dolphinemu.ui.main.MainActivity'] }, 'org.dolphinemu.mmjr': { action: VIEW, category: null, activity: ['org.dolphinemu.dolphinemu.ui.main.MainActivity'] },
        'org.mm.j': { action: VIEW, category: null, activity: ['org.dolphinemu.dolphinemu.ui.main.MainActivity'] }, 'org.dolphinemu.primehack': { action: VIEW, category: null, activity: ['org.dolphinemu.dolphinemu.ui.main.MainActivity'] } } },
    cemu: { name: 'Cemu', packages: ['info.cemu.cemu', 'info.cemu.cemu.debug'], match: /cemu/i, launch: { activity: ['*emulation.EmulationActivity', '*EmulationActivity'], data: 'doc' } },
    eden: { name: 'Eden', packages: ['dev.eden.eden_emulator', 'org.citron.citron_emu', 'org.sudachi.sudachi_emu', 'org.yuzu.yuzu_emu', 'org.uzuy.uzuy_emu'], match: /eden|citron|sudachi|yuzu|uzuy|sumi|lemon|suyu/i,
      launch: { activity: ['*activities.EmulationActivity'], action: 'android.nfc.action.TECH_DISCOVERED', data: 'doc' } },
    ppsspp: { name: 'PPSSPP', packages: ['org.ppsspp.ppssppgold', 'org.ppsspp.ppsspp'], match: /ppsspp/i, launch: { activity: ['org.ppsspp.ppsspp.PpssppActivity'], action: VIEW, category: 'android.intent.category.DEFAULT', data: 'doc' } },
    nethersx2: { name: 'NetherSX2', packages: ['xyz.aethersx2.android', 'xyz.aethersx2.custom'], match: /aethersx2|nethersx2/i,
      launch: { activity: ['xyz.aethersx2.android.EmulationActivity', '*EmulationActivity'], action: MAIN, extras: { bootPath: '$DOC' }, flags: ['clearTask', 'clearTop'] } },
    // (beta.10) ARMSX2 (armsx2.org, PCSX2 for ARM): its main screen takes the game as a VIEW content:// document (its manifest's
    // .Main and the .MainActivity alias); an older build with neither gets its own start screen, still with the game
    armsx2: { name: 'ARMSX2', packages: ['come.nanodata.armsx2'], match: /armsx2/i, launch: { activity: ['*.MainActivity', '*.Main'], action: VIEW, data: 'doc', flags: ['clearTop'] } },
    play: { name: 'Play!', packages: ['com.virtualapplications.play'], launch: { activity: ['com.virtualapplications.play.MainActivity'], action: VIEW, data: 'doc' } },
    azahar: { name: 'Azahar', packages: ['org.azahar_emu.azahar', 'io.github.lime3ds.android', 'org.citra.citra_emu', 'io.github.mandarine3ds.mandarine', 'org.cytrus.cytrus_emu'], match: /azahar|lime3ds|citra|mandarine|cytrus|borked3ds/i,
      launch: { activity: ['*activities.EmulationActivity', '*EmulationActivity'], data: 'doc', flags: ['clearTask', 'clearTop'] } },
    melonds: { name: 'melonDS', packages: ['me.magnum.melonds', 'me.magnum.melonds.nightly'], match: /melonds/i,
      launch: { activity: ['me.magnum.melonds.ui.emulator.EmulatorActivity'], action: 'me.magnum.melonds.LAUNCH_ROM', extras: { uri: '$DOC' } },
      variants: { 'me.magnum.melonds.nightly': { action: 'me.magnum.melonds.nightly.LAUNCH_ROM' } } },
    drastic: { name: 'DraStic', packages: ['com.dsemu.drastic'], launch: { activity: ['com.dsemu.drastic.DraSticActivity'], data: 'doc', flags: ['clearTask', 'clearTop'] } },
    m64plus: { name: 'M64Plus FZ', packages: ['org.mupen64plusae.v3.fzurita.pro', 'org.mupen64plusae.v3.fzurita', 'org.mupen64plusae.v3.fzurita.amazon', 'org.mupen64plusae.v3.alpha'], match: /mupen64plus/i,
      launch: { activity: ['paulscode.android.mupen64plusae.SplashActivity'], action: VIEW, data: 'doc' } },
    duckstation: { name: 'DuckStation', packages: ['com.github.stenzek.duckstation'], launch: { activity: ['com.github.stenzek.duckstation.EmulationActivity'], extras: { resumeState: { bool: false }, bootPath: '$DOC' }, flags: ['clearTask', 'clearTop'] } },
    redream: { name: 'Redream', packages: ['io.recompiled.redream'], launch: { activity: ['io.recompiled.redream.MainActivity'], action: VIEW, data: 'doc' } },
    flycast: { name: 'Flycast', packages: ['com.flycast.emulator'], launch: { activity: ['com.reicast.emulator.MainActivity'], action: VIEW, data: 'doc' } },
    yaba: { name: 'Yaba Sanshiro 2', packages: ['org.devmiyax.yabasanshioro2.pro', 'org.devmiyax.yabasanshioro2'], launch: { activity: ['org.uoyabause.android.Yabause'], action: VIEW, extras: { 'org.uoyabause.android.FileNameUri': '$DOC' }, flags: ['clearTask', 'clearTop'] } },
    saturnemu: { name: 'Saturn.emu', packages: ['com.explusalpha.SaturnEmu'], launch: { activity: ['com.imagine.BaseActivity'], data: 'doc' } },
    mdemu: { name: 'MD.emu', packages: ['com.explusalpha.MdEmu'], launch: { activity: ['com.imagine.BaseActivity'], data: 'doc' } },
    mastergear: { name: 'MasterGear', packages: ['com.fms.mg'], launch: { activity: ['com.fms.emulib.TVActivity'], action: VIEW, data: 'doc', flags: ['clearTask', 'clearTop'] } },
    snes9x: { name: 'Snes9x EX+', packages: ['com.explusalpha.Snes9xPlus'], launch: { activity: ['com.imagine.BaseActivity'], data: 'doc' } },
    nesemu: { name: 'NES.emu', packages: ['com.explusalpha.NesEmu'], launch: { activity: ['com.imagine.BaseActivity'], data: 'doc' } },
    myboy: { name: 'My Boy!', packages: ['com.fastemulator.gba'], launch: { activity: ['com.fastemulator.gba.EmulatorActivity'], action: VIEW, data: 'doc' } },
    gbaemu: { name: 'GBA.emu', packages: ['com.explusalpha.GbaEmu'], launch: { activity: ['com.imagine.BaseActivity'], data: 'doc' } },
    pizzagba: { name: 'Pizza Boy GBA', packages: ['it.dbtecno.pizzaboygbapro', 'it.dbtecno.pizzaboygba'], launch: { activity: ['*.MainActivity'], extras: { rom_uri: '$PATH' }, flags: ['clearTask', 'clearTop'] } },
    myoldboy: { name: 'My OldBoy!', packages: ['com.fastemulator.gbc'], launch: { activity: ['com.fastemulator.gbc.EmulatorActivity'], action: VIEW, data: 'doc' } },
    gbcemu: { name: 'GBC.emu', packages: ['com.explusalpha.GbcEmu'], launch: { activity: ['com.imagine.BaseActivity'], data: 'doc' } },
    pizzagbc: { name: 'Pizza Boy GBC', packages: ['it.dbtecno.pizzaboypro', 'it.dbtecno.pizzaboy'], launch: { activity: ['*.MainActivity'], extras: { rom_uri: '$PATH' }, flags: ['clearTask', 'clearTop'] } },
    pceemu: { name: 'PCE.emu', packages: ['com.PceEmu'], launch: { activity: ['com.imagine.BaseActivity'], data: 'doc' } },
    neoemu: { name: 'NEO.emu', packages: ['com.explusalpha.NeoEmu'], launch: { activity: ['com.imagine.BaseActivity'], data: 'doc' } },
    mame4d: { name: 'MAME4droid', packages: ['com.seleuco.mame4d2024', 'com.seleuco.mame4droid'], launch: { activity: ['com.seleuco.mame4droid.MAME4droid'], action: VIEW, data: 'doc' } },
    retroarch: RA
  };
  for (const [id, e] of Object.entries(E)) e.id = id;
  // shelves: id (matches the shelf looks), name, emulators in order of preference, RetroArch cores (first = default), file types
  const sys = (id, name, emus, cores, exts, extra) => Object.assign({ id, name, emus, cores: cores || [], extensions: exts }, extra || {});
  const SYSTEMS = [
    sys('gc', 'GameCube', ['dolphin'], [], ['rvz', 'iso', 'gcm', 'gcz', 'ciso', 'wia', 'dol', 'elf', 'm3u']),
    sys('wii', 'Wii', ['dolphin'], [], ['rvz', 'iso', 'wbfs', 'wia', 'gcz', 'ciso', 'wad', 'm3u']),
    sys('wiiu', 'Wii U', ['cemu'], [], ['wua', 'wud', 'wux', 'rpx', 'wuhb', 'elf']),
    sys('sw', 'Switch', ['eden'], [], ['nsp', 'xci', 'nca', 'nro', 'nso']),
    sys('n3ds', '3DS', ['azahar'], ['citra'], ['3ds', 'cci', 'cxi', '3dsx', 'app', 'z3dsx', 'zcci', 'zcxi']),
    sys('nds', 'DS', ['melonds', 'drastic', 'retroarch'], ['melondsds', 'melonds', 'desmume'], ['nds', 'zip', '7z']),
    sys('ps2', 'PS2', ['nethersx2', 'armsx2', 'play'], [], ['iso', 'chd', 'bin', 'cso', 'zso', 'gz', 'm3u', 'elf']),
    sys('psp', 'PSP', ['ppsspp', 'retroarch'], ['ppsspp'], ['iso', 'cso', 'chd', 'pbp', 'elf', 'prx']),
    sys('psx', 'PlayStation', ['duckstation', 'retroarch'], ['swanstation', 'pcsx_rearmed', 'mednafen_psx_hw'], ['chd', 'cue', 'm3u', 'pbp', 'iso', 'img', 'ccd', 'mds', 'ecm', 'exe']),
    sys('n64', 'N64', ['m64plus', 'retroarch'], ['mupen64plus_next_gles3', 'parallel_n64'], ['z64', 'n64', 'v64', 'zip', '7z']),
    sys('dreamcast', 'Dreamcast', ['redream', 'flycast', 'retroarch'], ['flycast'], ['chd', 'gdi', 'cdi', 'cue', 'm3u']),
    sys('saturn', 'Saturn', ['yaba', 'saturnemu', 'retroarch'], ['mednafen_saturn', 'yabasanshiro'], ['chd', 'cue', 'm3u', 'iso', 'ccd', 'mds']),
    sys('megadrive', 'Genesis', ['retroarch', 'mdemu'], ['genesis_plus_gx', 'picodrive'], ['md', 'gen', 'bin', 'smd', '32x', 'zip', '7z']),
    sys('mastersystem', 'Master System', ['retroarch', 'mdemu', 'mastergear'], ['genesis_plus_gx', 'gearsystem'], ['sms', 'bin', 'zip', '7z']),
    sys('gamegear', 'Game Gear', ['retroarch', 'mastergear'], ['genesis_plus_gx', 'gearsystem'], ['gg', 'zip', '7z']),
    sys('snes', 'SNES', ['retroarch', 'snes9x'], ['snes9x', 'bsnes'], ['sfc', 'smc', 'bs', 'fig', 'swc', 'zip', '7z']),
    sys('nes', 'NES', ['retroarch', 'nesemu'], ['mesen', 'nestopia', 'fceumm'], ['nes', 'fds', 'unf', 'unif', 'zip', '7z']),
    sys('gba', 'Game Boy Advance', ['retroarch', 'myboy', 'pizzagba', 'gbaemu'], ['mgba', 'vbam', 'gpsp'], ['gba', 'agb', 'zip', '7z']),
    sys('gbc', 'Game Boy Color', ['retroarch', 'myoldboy', 'pizzagbc', 'gbcemu'], ['gambatte', 'sameboy', 'mgba'], ['gbc', 'cgb', 'zip', '7z']),
    sys('gb', 'Game Boy', ['retroarch', 'myoldboy', 'pizzagbc', 'gbcemu'], ['gambatte', 'sameboy', 'mgba'], ['gb', 'dmg', 'sgb', 'zip', '7z']),
    sys('pcengine', 'TurboGrafx-16', ['retroarch', 'pceemu'], ['mednafen_pce_fast', 'mednafen_pce'], ['pce', 'sgx', 'chd', 'cue', 'zip', '7z']),
    sys('neogeo', 'Neo Geo', ['retroarch', 'neoemu', 'mame4d'], ['fbneo', 'geolith'], ['zip', '7z', 'neo']),
    sys('arcade', 'Arcade', ['retroarch', 'mame4d'], ['fbneo', 'mame2003_plus', 'mamearcade'], ['zip', '7z']),
    // (beta.9) the rest of Windows' wave 2, through RetroArch (MD.emu plays Sega CD too)
    sys('segacd', 'Sega CD', ['retroarch', 'mdemu'], ['genesis_plus_gx', 'picodrive'], ['cue', 'chd', 'iso', 'm3u']),
    sys('sega32x', '32X', ['retroarch'], ['picodrive'], ['32x', 'zip', '7z']),
    sys('atari2600', 'Atari 2600', ['retroarch'], ['stella', 'stella2014'], ['a26', 'bin', 'zip', '7z']),
    sys('atarilynx', 'Lynx', ['retroarch'], ['handy', 'mednafen_lynx'], ['lnx', 'zip', '7z']),
    sys('wonderswan', 'WonderSwan', ['retroarch'], ['mednafen_wswan'], ['ws', 'wsc', 'zip', '7z']),
    sys('dos', 'DOS', ['retroarch'], ['dosbox_pure'], ['zip', 'dosz'])
  ];
  // multi-file games: the .bin/.img tracks are listed by the .cue/.gdi/.m3u that points at them, never as boxes of their own
  const COMPANION = { cue: ['bin', 'img', 'wav', 'ape'], gdi: ['bin', 'raw'], m3u: ['cue', 'chd', 'iso', 'gdi', 'cdi', 'bin', 'img', 'pbp'], ccd: ['img', 'sub'], mds: ['mdf'] };
  window.BS_ANDROID = { EMULATORS: E, SYSTEMS, COMPANION };
})();
