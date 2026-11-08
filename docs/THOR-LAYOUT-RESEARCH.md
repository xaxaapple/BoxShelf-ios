# Layout research for the Thor (2026-10-24)

What the best Thor launchers, front-end themes and console UIs do, and what Boxshelf takes from it. Sources at the end.

## What others do well
| Product / theme | Standout technique |
|---|---|
| Cocoon (Thor) | "Now Playing" on the second screen during a game; short per-game jingles on hover; a bottom-screen keyboard. Its own guide: a cluttered second panel is worse than a blank one. |
| Loki (Thor) | Screens have roles, not positions (the user picks which one is the grid); the idle screen becomes a game panel while playing, not a remote. |
| Konsoru (Thor) | Separate looks per console; a guide hub on the bottom screen; the bottom screen dims to 10% during the boot video. |
| ES-DE + Companion | Second-screen widgets; while a game runs the second screen is On / Dim / Off / Manual / Guide, set per system; covers swap instantly, only backdrops fade. |
| 3DS HOME | The top shows the selected title's banner plus a sound clip of 3 s or less; HOME during a game opens on the bottom screen. |
| Wii U | TV and GamePad have different jobs; one button swaps them. |
| PSP / PS3 XMB | The background takes the highlighted game's art; colour follows the month, brightness the time of day. |
| Art Book Next, Canvas (ES-DE) | One typeface, artwork tinted to the scheme; colour schemes named after hardware; a "help off" variant; warnings that animated wallpapers cost VRAM. |

## Techniques for Boxshelf
1. The settled game takes over the backdrop: its art, darkened and blurred **in advance** (a small baked image), cross-faded once.
2. Ambient colour from the art: the main colour worked out natively when art is saved, stored with the record, used for the rim light, the highlight bar and the bottom screen's backdrop (no GPU readback).
3. One menu layout, console paint: the highlight colour, click sound and button glyphs follow the shelf you're on (PlayStation ✕○△□, Nintendo A/B).
4. A case "jingle": about 400 ms after the shelf settles, the case's console-true gesture and sound (or a user's 3 s clip); never while sliding.
5. A solid highlight bar, one short slide, no glow (done in 0.3.4).
6. Short labels; at most one line of help, only for the focused row (done in 0.3.4); on the Thor, help and previews on the bottom screen.
7. Real button glyphs in a fixed footer, only for actions that work right now.
8. The game's clear logo as the title in Inspect and Details, with one glint on focus.
9. Covers swap instantly, only big backdrops fade (fits artSwapQueue).
10. Time-of-day lighting in the museum (a preset change on the hour, never per frame).
11. A still alternative for every motion effect, the default at the Handheld level.
12. HOME opens the quick menu on the bottom screen as big tiles (the top dims).
13. A "Swap screens" shortcut (shelf on the bottom, case on top) for playing flat.
14. During a game, per system: On / Dim / Off / Manual / Now Playing (DS and 3DS default Off).
15. Dim the bottom screen during boot and launch.
16. The keyboard on the bottom screen, the text on the top.

## The bottom screen per mode
- Shelf: the case (as now), up to six shortcuts, and a strip of spines to drag through a big list fast.
- Inspect: the back cover large and readable, with tabs Back / Details / Trophies / Manual.
- Manual: page thumbnails to scrub, and a hold-to-zoom magnifier.
- Museum: a floor plan with "you are here" (tap to walk there) and the exhibit placard of the console you face; no live 3D down there.
- Settings: the focused row's live preview and its one line of help.
- Quick menu: big tiles.
- While a game runs: Off / Manual (the game's own manual, turned by touch) / Now Playing (the open, empty case, session time; dims after 10 s; minute updates only).

## Boxshelf's own signatures
1. **Hands and room:** the bottom screen is always what you hold (case, disc, manual), the top is the room (shelf, museum, TV).
2. **The case is the jingle.**
3. **Console paint, one grammar.**
4. **Placards, not cards:** museum exhibit labels, spine-label rows, a price/rental-style sticker for play time or "New".
5. **Light from the art and the clock.**
6. **The manual as a second screen** while playing.
7. **Disc continuity:** launching takes the disc out on the bottom screen; quitting puts it back.

## Pitfalls on a 6" handheld
No live glass or blur; no video on the bottom screen, nor at the Handheld level by default; OLED burn-in (dim or shift static panels); the bottom screen still when idle (heat, battery); never steal controller focus to the bottom screen; big touch targets (about 150 px on the bottom screen); no badges or social clutter; don't become a 3DS clone; no thin grey-on-grey text; never animate both screens at once.

## Sources
Cocoon: https://retrohandhelds.gg/cocoon-shell-beta-2-1-brings-big-upgrades-to-dual-screen-handhelds/ · https://heldgames.com/guides/cocoon-setup-guide ·
Loki: https://github.com/Prof-Mags/Thor-Launcher · Konsoru: https://retrohandhelds.gg/konsoru-the-thor-focused-launcher-drops-v0-6-0/ ·
ES-DE Companion: https://github.com/RobZombie9043/es-de-companion/blob/master/USERGUIDE.md · ES-DE changelog: https://gitlab.com/es-de/emulationstation-de/-/raw/master/CHANGELOG.md ·
iiSU: https://heldgames.com/guides/iisu-setup-guide · Art Book Next: https://github.com/anthonycaccese/art-book-next-es-de · Canvas: https://github.com/Siddy212/canvas-es-de ·
Thor: https://retrohandhelds.gg/ayn-thor-setup-guide/ · https://gardinerbryant.com/ayn-thor-the-modern-dual-screen-revival/ ·
Console UIs: https://en.wikipedia.org/wiki/Nintendo_3DS_system_software · https://en.wikipedia.org/wiki/Wii_U_system_software · https://en.wikipedia.org/wiki/XrossMediaBar
