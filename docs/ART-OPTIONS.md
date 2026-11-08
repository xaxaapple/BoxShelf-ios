# Full case art: where to get it, and how to store it

## The sources, side by side

| Source | Consoles with full case art | Account? | Quality | Limits | Ease |
|---|---|---|---|---|---|
| **GameTDB** | GameCube, Wii: front, **full wrap** (back + spine + front), disc. (Wii U / 3DS / Switch / DS too, but only by title ID: see below) | No | Very good: clean, HQ versions | None published (be polite: 1–2 at a time) | Easiest. Picks the exact game from the disc ID, so it never matches the wrong game |
| **ScreenScraper** | Almost everything: front, back, spine (`box-2D-side`), full wrap (`box-texture`), disc / cartridge | Yes, a free account. It also wants a *developer* ID per app (see below) | Good. Mixed real scans, some regions missing | Free account: 1 request at a time and a daily quota. A donation raises both | Medium. Matches by file name + size (by hash on the PC). Rate limits apply |
| **LaunchBox Games DB** | Almost everything: front, back, spine, full box, disc, many regions | No | Very good. The biggest set of scans | No API limits, but it's a 110 MB download plus a ~500 MB index | Easy on the PC. **Too heavy for the Thor**, so it's PC only |
| **libretro thumbnails** | Fronts only (no backs or spines) | No | OK. Clean, ~512 px | None | Easiest, but fronts only |
| **SteamGridDB** | Posters only (fan-made, not real boxes) | Free API key | Varies | Generous | Easy, but it isn't case art |

**Title IDs for Wii U / 3DS / Switch:** GameTDB names these by product code. Reading that code needs decrypting or unpacking the game file (NSP/XCI/CIA/WUA), which isn't simple or safe on the Thor, so I skipped it. ScreenScraper covers these consoles by file name instead.

**ScreenScraper developer ID:** apps normally ship their own developer ID, and users only type in their own username and password. Boxshelf has no developer ID yet. The calls are tried without one, but ScreenScraper may refuse them. Asking ScreenScraper for a Boxshelf developer ID (on their forum) is the single biggest step to make it "just work".

## What the Thor does now (0.2.8)
- **GameCube / Wii:** GameTDB front, disc and full cover, with no account. The full cover is cut on the device into back, spine and front.
- **Every other console:** a ScreenScraper account (Settings → Accounts & services) adds backs, spines and discs. Fronts come from libretro when there's no account.
- **Art Studio:** pick any version per part, or use a picture from the device. It's backed by the sources above. It can't use LaunchBox, because that index is PC only.

## Recommendation
1. **Best results, least effort: scrape on the PC, copy to the Thor.** The Windows build has LaunchBox + GameTDB + ScreenScraper, and its Art Studio is the full one. Then copy the games folder (with its art) to the Thor.
2. **Thor on its own:** leave "Fetch box art automatically" and "Full box art" on. GameCube and Wii get full cases with no account. For the rest, add a free ScreenScraper account.
3. Get a ScreenScraper developer ID for Boxshelf. It makes the account path reliable for everyone.

## Should the art storage be restructured?
**A small change, not a rebuild.** Both builds already use the same file names: `<game file name>.png`, `-back`, `-spine`, `-disc`, plus `-full` for the whole wrap on Android. Only the folder name differs. Windows uses `covers\` beside the games, or its own art library folder. Android uses `Boxshelf Art/` beside the games.

- **Done in this build:** Android also reads the Windows `covers` folder beside the games. Art scraped on the PC and copied over with the games is used straight away, with no download. `Boxshelf Art` wins where both folders have a picture.
- **Suggested next (Windows side):** also read `Boxshelf Art/`, and save the whole wrap as `-full` (today the wrap is used to cut the spine and then dropped). Art fetched on the Thor would then show on the PC too.
- **Later, optional:** a small `boxshelf-art.json` in each art folder recording picks and locks per game, so Art Studio choices travel between the PC and the Thor along with the pictures.
- If the user's art library folder is not beside the games, a one-click Windows "Export art for Android" would copy it into `covers/` (or `Boxshelf Art/`) next to the games.
