# Boxshelf on the Steam Deck

Boxshelf's Linux build runs on the Steam Deck. It's experimental: tell us how it goes.

## Setup (once, in Desktop Mode)

1. Download `Boxshelf-…-linux.AppImage` and move it to `/home/deck/Applications`.
2. Right-click it, then Properties → Permissions → tick "Is executable".
3. Start it. Boxshelf finds EmuDeck's (and RetroDECK's) emulators and your ROMs by itself.
4. Boxshelf offers to **add itself to Steam**. Say yes: Steam closes and opens again while it's added. If you said "Not now", do it later in Settings → System → Add Boxshelf to Steam.

## Playing (Game Mode)

Start Boxshelf from your Library, under **Non-Steam**. Started from Steam, your controller works as a gamepad in every game Boxshelf starts.

- **Leaving a game:** hold **Select + Start** for a moment. Boxshelf closes the game, whatever the emulator, and you're back on the shelf. (Your emulator's own quit hotkey works too. Boxshelf's Home menu on the Guide button is Windows-only for now.)
- **Why not Desktop Mode?** There, programs not started by Steam get the Deck's keyboard-and-mouse layout: **B is the Esc key**, and most emulators quit their game on Esc.

## If Boxshelf doesn't start in Game Mode

Boxshelf adds the options Steam needs by itself (`--no-sandbox`, and X11 in Game Mode). If it still shows a black screen or closes at once:

1. In Game Mode: Boxshelf's page → ⚙ → Properties → Launch Options. Enter: `--no-sandbox --ozone-platform=x11`
2. Still nothing? Send us `~/Boxshelf/data/boxshelf.log` (its "Linux start:" line shows what Boxshelf saw).

## Emulators Boxshelf looks for

- RetroArch: native, Flatpak, AppImage or Steam's.
- Dolphin, Cemu, PCSX2, RPCS3, DuckStation, PPSSPP, Azahar / Lime3DS, melonDS, RMG, mGBA, Flycast, shadPS4.
- Switch: Eden, Citron or Ryujinx.

They're searched for in `~/Applications`, Flatpak and the usual system folders. ROMs: `~/Emulation/roms`, `~/retrodeck/roms` and SD cards.
