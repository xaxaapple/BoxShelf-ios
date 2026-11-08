# Boxshelf for Android (AYN Thor) — proof of concept

This folder wraps the shared UI in `../renderer` as an Android app with [Capacitor](https://capacitorjs.com).
`renderer/` stays the single source of truth: never edit `www/`, it's rebuilt from `renderer/` every build.

**Status:** demo data only (`renderer/mock.js`). No ROM scanning or emulator launching yet; this build exists to
measure startup time, frame rate, controller input and memory on the Thor before the real Android adapter is written.

## Getting the APK (nothing to install on the PC)
Every push that touches `renderer/` or `android-app/` builds the APK on GitHub:
repo page → **Actions** → **Android build** → latest run → **Artifacts** → `Boxshelf-thor-debug` (a zip with the APK).
You can also start a build by hand there with **Run workflow**.

## Building locally (optional)
Needs Node 22, JDK 21 and the Android SDK (Android Studio). Then:
```
cd android-app
npm ci
npm run build:debug      # APK: android/app/build/outputs/apk/debug/app-debug.apk
```

## What's Android-specific
- `android/app/src/main/java/io/github/boxshelf/MainActivity.java`: full screen, screen kept on, controller buttons go
  to the page's Gamepad API (so B doesn't close the app), system Back becomes Esc.
- `web-extras/thor-hud.js`: the on-screen test meter, added to `www/` only.
- `web-extras/android-touch.js`: touch gestures. Swipe in from either screen edge to go back (anywhere but the game shelf), or a quick swipe left on screens that don't drag sideways themselves (Details, Settings, quick menu, lists); pinch to zoom in Inspect, the page reader and the museum. Back is sent as the Esc key, like the Android back button. Reads `window.BS_TOUCH` from app.js.
- The Thor's bottom screen: `BottomScreen.java` shows `web-extras/bottom.html` (+ `bottom.js` / `bottom.css`) on the
  second display in a Presentation while Boxshelf is in front (hidden whenever a game runs, so DS / 3DS emulators get
  it). `web-extras/android-bottom.js` sends it the game the shelf settles on and runs its buttons. Open `www/bottom.html`
  in a browser for a demo, or `index.html?fakeNative=1&bottomPreview=1` for the pretend Thor with the bottom page in a
  corner frame. Settings → Display → Bottom screen turns it off.
- `copy-web.js`: copies `renderer/` → `www/` (skips the phone companion page) and adds the meter.
- In the demo, `mock.js` sees `window.Capacitor` and reports `platform.os = 'android'`, which hides Windows-only features
  (see `docs/PLATFORM-API.md`).

### Box art on Android
- After every scan (and so at every start) games without a cover are fetched in the background
  (`web-extras/android-api.js`, "box art" section). Settings → Art & manuals → "Fetch box art automatically" (on by
  default) and "Fetch missing art now" (also retries games nothing was found for; misses are otherwise left alone for 7 days).
- Sources, best first: libretro thumbnails (fronts, matched by file name, then by clean title with Windows' rules from
  `shared/titles.js` + the `norm` of `main/lbindex.js`), GameTDB (GameCube / Wii fronts and discs, by the disc id read
  from the file header), SteamGridDB (only when `config.keys.steamgriddb` holds a key). LaunchBox (Windows' source for
  backs and spines) is a 110 MB download + 500 MB index, so it isn't used on the handheld; nor are manuals yet.
- Where it goes: the original into a **"Boxshelf Art"** folder created inside the games folder the player picked
  (the SAF tree), named like Windows does (`<game file name>.png`, `<game file name>-disc.png`). Picked folders are
  normally one per console, so the files sit directly in it; only when one picked folder serves two or more consoles
  does each get a sub folder named after the console (two consoles' "Tetris (USA)" would clash otherwise). If the folder
  can't be written (read-only permission, removed SD card) the original goes to the app's own `files/art-full/<console>/`.
- What the shelf shows: a ~512 px tall copy in `files/art/<console>/` (JPEG, PNG when it has see-through parts like a
  disc), shown through `Capacitor.convertFileSrc` (`https://localhost/_capacitor_file_/…`, same origin, so the CSP's
  `img-src 'self'` covers it). Found art is remembered in `art.json`, so a restart never downloads again; a re-scan (or a
  fresh install) re-uses whatever is already in "Boxshelf Art" by file name before downloading anything.
- Downloads run in `BoxshelfNativePlugin` (`fetchArt`, `artIndex`, `artList`, `artThumb`, `discId`, `httpText`) on
  two background threads with timeouts, redirects and a Boxshelf User-Agent. The page hands out one or two jobs at a
  time, only while no game is running, the app is in front and the shelf is still (`BS_BUSY`), and new covers are
  swapped onto the cases in view in place (`Shelf.artUpdated`), never by rebuilding the shelf.

Debug builds are signed with a throwaway key that changes per build: uninstall the old one before installing a new one.
