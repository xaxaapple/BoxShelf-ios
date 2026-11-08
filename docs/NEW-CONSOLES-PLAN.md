# New consoles on Windows: research and plan (2026-11)

Beta feedback's biggest ask: "not enough emulator options" (PS1, GBA, Dreamcast…). This collects what three research
passes found and what Boxshelf already has, so building it is wiring rather than starting over.

**Status marks:** ✔ confirmed from a source · ? not confirmed (memory or a single weak source): check before shipping
(an emulator's `--help`, a measured case or cartridge).

## What already exists

- `renderer/systems-extra.js` (loaded on Windows and Android) already gives 16 extra shelves a case look (STYLE) and
  media (MEDIA): nes, snes, n64, gb, gbc, gba, nds, psx, dreamcast, saturn, megadrive, mastersystem, gamegear,
  pcengine, neogeo, arcade. Cardboard boxes, jewel cases and Sega clamshells have their own shapes; every cartridge is
  the same generic cart (`kind:'cart', size .4–.55, drive:'slot'`), every disc a top loader.
- Android (`android-app/web-extras/android-systems.js`) already runs 23 systems with emulator apps (DuckStation,
  M64Plus FZ, Redream, Yaba Sanshiro 2, melonDS, RetroArch…).
- Missing on Windows: `main/systems.js` CONSOLES entries (emulator, exe names, folders, extensions, launch arguments),
  detection (`main/detect.js`), box art platform names (`main/covers.js`), and a RetroArch backend.

## Recommended Windows emulators

| Shelf | Standalone (exe, launch) | RetroArch core | BIOS |
|---|---|---|---|
| PlayStation (psx) | DuckStation `duckstation-qt-x64-ReleaseLTCG.exe -fullscreen -batch -nogui -- "{rom}"` ✔ | `swanstation` / `mednafen_psx_hw` ? | yes (scph*.bin ?) |
| Dreamcast | Flycast (flyinghead) — fullscreen flag ? | `flycast` ? | optional (HLE) ? |
| Saturn | Ymir `ymir-sdl3 -f <disc>` ✔ (IPL ROM in `roms\ipl`) · Mednafen ✔ | `mednafen_saturn` ? | yes (sega_101.bin, mpr-17933.bin ✔) |
| NES / SNES / GB / GBC / GBA | Mesen2 `Mesen.exe --fullscreen "{rom}"` ? · Snes9x `-fullscreen` ? · mGBA (mgba.io) ✔ | `mesen`, `snes9x`, `gambatte`, `mgba` ? | no |
| N64 | Rosalie's Mupen GUI, simple64, ares, Project64 — args not researched | `mupen64plus_next` ? | no |
| DS | melonDS 1.1 (melonds.kuribo64.net) ✔ — args ? | `melondsds` ? | optional |
| Mega Drive / Master System / Game Gear | BlastEm `blastem.exe -f "{rom}"` ✔ (Mega Drive only) | `genesis_plus_gx` ? | Sega CD only |
| PC Engine / Neo Geo / Arcade | through RetroArch | `mednafen_pce_fast` ✔, `fbneo` ?, `mame` ? | Neo Geo, CD systems |

**RetroArch backend** (many users asked for it): `retroarch.exe -f -L "<install>\cores\<core>_libretro.dll" "{rom}"` ✔
(flags `-L`, `-f`, `--config`, `--appendconfig` ✔). One RetroArch install covers every shelf with a core per console;
`--appendconfig` sets fullscreen/quit behaviour without touching the user's own config. Detect: the configured folder,
`C:\RetroArch-Win64`, Steam app 1118310 (`steamapps\common\RetroArch`) ?. Cores are missing until downloaded in
RetroArch's Online Updater: check `cores\` and say so. Quit cleanly (WM_CLOSE / network `QUIT` ?), never kill (save RAM).

## Formats and art

- Extensions ?: NES `.nes`, SNES `.sfc .smc`, N64 `.z64 .n64 .v64`, GB `.gb`, GBC `.gbc`, GBA `.gba`, DS `.nds`,
  MD `.md .gen .smd .bin`, SMS `.sms`, GG `.gg`, PS1/Saturn/SegaCD `.cue .chd .iso .m3u` (one shelf entry per `.m3u`,
  its discs hidden), Dreamcast `.gdi .cdi .chd`. `.zip`/`.7z` common on cartridge systems.
- libretro-thumbnails folders: `Nintendo - Nintendo Entertainment System`, `Nintendo - Super Nintendo Entertainment
  System`, `Nintendo - Nintendo 64`, `Nintendo - Game Boy`, `Nintendo - Game Boy Color`, `Nintendo - Game Boy Advance`,
  `Nintendo - Nintendo DS` ✔ · `Sony - PlayStation`, `Sega - Dreamcast` ✔ · `Sega - Saturn`, `Sega - Mega Drive -
  Genesis`, `Sega - Master System - Mark III`, `Sega - Game Gear` ?. Fronts only: backs, spines and discs are
  Boxshelf-made (as for PC games today).

## Physical sizes (for refining the cases and cartridges)

- ✔ Game Boy / GBC cart 65.5 × 57 × 7.5 mm · GBA cart 35 × 57 × 7.5 mm · NES cart ~133 × 120 × 17 mm · CD jewel case
  142 × 125 × 10 mm (PAL PlayStation cases 18 mm deep).
- ? SNES cart (PAL) 127.75 × 87 mm · N64 cart 76.6 × 116 × 18.5 mm · SMS cart 69 × 108 × 16 mm · DS card ~33 × 35 × 3.8 mm.
- Not found: retail box sizes (NES/SNES/N64 cardboard, Saturn and Sega CD long boxes, Dreamcast DVD-style cases).
  Measure real ones or use a collector's spec sheet.
- Loading ?: NES front flap (push down), Famicom/SNES/N64 top slot, GB rear slot label-out, GBA top slot, PS1/Saturn/
  Dreamcast top lid.

## Proposed order

1. **Wave 1, wiring the shelves that already have cases:** PS1 (DuckStation), GBA + GB/GBC (mGBA), SNES + NES (Mesen2 /
   Snes9x), N64, DS (melonDS), Dreamcast (Flycast), Mega Drive / SMS / Game Gear, plus RetroArch as an option for every
   shelf. Each: a CONSOLES entry, detection, art platform names, a device-test check.
2. **Wave 2, accuracy:** a cartridge shape per system (NES tall grey, SNES, N64, GB/GBC/GBA with their colours,
   DS card), cardboard boxes that open like card (flaps, no tray), region case variants (NA Saturn long box, EU PS1).
3. **Wave 3:** Saturn, Sega CD, PC Engine CD, Neo Geo, Arcade (BIOS-heavy, niche).

Risks: BIOS files (setup must say which and where), multi-disc `.m3u`, `.cue` pointing at a missing `.bin`, unconfirmed
launch arguments (check each emulator's `--help` before shipping), heavier emulators on the Thor.
