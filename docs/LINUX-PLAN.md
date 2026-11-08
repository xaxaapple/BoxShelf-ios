# Boxshelf for Linux / Steam Deck: plan (phases 1-2 in progress)

Status (2026-11-05): phases 1 and 2 are built and tested on GitHub's Ubuntu machines (workflow "Linux build":
linux/ci/detect-test.js, linux/ci/app-test.js on a virtual screen). Not tried on a real Steam Deck yet. Done:
AppImage target; data folder ~/Boxshelf (or beside the AppImage when a data folder is there); the platform report
(main/linux.js, preload.js); Linux emulator tables (installed, Flatpak launchers, AppImage patterns); EmuDeck /
RetroDECK / SD card ROM folders; Steam's Linux folders; RetroArch .so cores; zip unpacking without PowerShell;
process-group quit; Boxshelf hides during a game; Azahar's Linux folders for .cia installs. Not yet: phase 3 (Home menu /
quit combo during a game), phase 4, and the emulators' settings tweaks (Windows only for now).

Goal: the same Electron app as an AppImage that runs on desktop Linux and on the Steam Deck, both in Desktop Mode
and added to Steam as a non-Steam game (Gaming Mode, under gamescope). Windows behaviour must not change: every Linux
piece is a new module or a `process.platform === 'linux'` branch.

## What the survey found (main side)
- 16 `process.platform` checks today, all `'win32'`; only two non-Windows paths exist (SIGTERM/SIGKILL on quit, `zip`
  for the problem report). Everything else Windows-only is ungated and would just fail on Linux.
- No shipped binaries: the native helpers (padwatch, wiimote, exe icons) are C# compiled through PowerShell.
- The renderer is already portable; preload.js reports `os: 'windows'` with every capability on.
- The update check only opens the release page (no asset name to match), so Linux can share the beta repo.

## Phases (one at a time, each with device-test checks and a Windows no-change check)

### Phase 1: it starts and shows your library (small)
- package.json: `build.linux` AppImage target (+ icon, category Game). A "Linux build" GitHub workflow that builds the
  AppImage on ubuntu-latest and uploads it as an artifact (no Windows changes).
- Data folder: inside an AppImage the app folder is read-only, so use `$APPIMAGE`'s folder when writable (portable,
  like Windows), else `~/.local/share/Boxshelf`.
- preload.js: a real Linux platform report (`os: 'linux'`, capabilities off for autostart, power, Wii remote, Kyty).
- Steam on Linux: `~/.steam/steam`, `~/.local/share/Steam`, Flatpak `~/.var/app/com.valvesoftware.Steam/...`; launch with
  `steam://rungameid` (already works through xdg-open).
- Archives: use `unzip` / `bsdtar` when found, else a small JS unzip (LaunchBox metadata, models, comics).

### Phase 2: finds and starts emulators (medium)
- A Linux table beside systems.js: native names (`retroarch`, `dolphin-emu`, `duckstation-qt`, `pcsx2-qt`, `ppsspp`,
  `melonDS`, `azahar`, `cemu`, `rpcs3`, `flycast`, `mgba-qt`…), AppImages in `~/Applications` / `~/Emulation`, and
  Flatpak ids (`org.libretro.RetroArch`, `org.DolphinEmu.dolphin-emu`, `org.duckstation.DuckStation`…).
- launcher.js: an emulator can be `flatpak run <id>`; quit kills the whole process group (spawn detached + `kill(-pid)`).
- RetroArch cores are `.so` in `~/.config/retroarch/cores` (or the Flatpak's folder).
- EmuDeck / RetroDECK layouts: ROMs in `~/Emulation/roms/<system>` or `~/retrodeck/roms/<system>` found automatically.
- Emulator settings files (Dolphin hotkey, Eden/PCSX2/RPCS3 prompts): XDG and Flatpak folders.

### Phase 3: the controller while a game runs (largest)
- Replace padwatch on Linux with a small helper reading `/dev/input` (evdev) for the quit combo and Guide → Home menu.
  On the Deck in Gaming Mode, Steam owns the Guide button: use the quit combo and Steam's own menu, and test there.
- Window layering: Desktop Mode (X11/KDE) can raise the shelf and the Home overlay; Gaming Mode stacks windows itself,
  so the shelf hides while a game runs and comes back when it quits (no overlay over the game at first).
- Emulator hotkeys (save state etc.) through each emulator's own hotkeys where possible; uinput later if needed.

### Phase 4: polish
- Power actions (`systemctl suspend / reboot / poweroff`), autostart (`~/.config/autostart` .desktop file), the
  problem report zip in JS, Heroic (Epic/GOG on Linux) as a PC source, file pickers without the `.exe` filter.

## Not on Linux (hidden there)
- Kyty (PS5, Windows only), Xenia, Stremio's WebView2 sign-in, the DolphinBar Wii remote reader, exe icons.

## How it's tested
- The device test gets a Linux-platform pass (preload report, Settings rows hidden, paths), run in CI on ubuntu.
- The real check is on hardware: a tester on a Steam Deck in both modes.
