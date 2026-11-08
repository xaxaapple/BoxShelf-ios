# Boxshelf platform API (`window.boxshelf`)

The renderer (everything in `renderer/`) never touches the OS. It talks to one object, `window.boxshelf`,
defined in `preload.js` (Electron, Windows). `renderer/mock.js` provides the same object with demo data so the
UI runs in a plain browser. **That object is the seam for Android:** an Android build (Capacitor) supplies its
own `window.boxshelf` backed by a Kotlin plugin, and the renderer stays shared.

Two smaller bridges exist: `window.home` (`preload-home.js`, the in-game Home overlay) and `window.wum`
(`preload-wum.js`, hidden Wii U manual renderer).

Conventions: `call()` methods return a Promise and throw on `{ ok:false }`. `on…` methods subscribe to events
pushed from the platform side (newer ones return an unsubscribe function).

Snapshot: v1.74.0, 141 methods.

## Legend
- **Shared**: pure logic or network calls; the same JS can run on Android (move it out of `main/` into a
  shared `core/` that doesn't depend on Electron or Windows).
- **Adapt**: same job, different Android mechanism (Storage Access Framework, intents, Android settings).
- **Windows-only**: no Android equivalent. Hide the UI on Android (`platform.caps`).

## Config, logging, app
| Methods | Android |
|---|---|
| getConfig, saveConfig, backupSettings, restoreSettings | Adapt: app-private storage; keys sealed with Android Keystore instead of DPAPI |
| log, uiBusy, reportProblem | Adapt (logcat + app log file) |
| openExternal, openTrailer | Adapt: system browser intent / in-app WebView |
| openAppFolder, openThemeFolder, openSongsFolder, openLibraryFolder, openIplFolder | Adapt: open folder in Files app, or hide |
| toggleFullscreen, winMode, onUiScale | Adapt: immersive mode always on; winMode Windows-only |
| quit, power | Adapt: quit = go to background (as Home app it never quits); power Windows-only (Android owns sleep/shutdown) |
| getAutostart, setAutostart | Adapt: "set as Home app" (CATEGORY_HOME) replaces autostart |
| listDisplays, moveToDisplay | Adapt: **Thor bottom screen** (Android Presentation / secondary display) |
| apiStatus, testApi, onApiStatus | Shared |

## Library and launching
| Methods | Android |
|---|---|
| detect | Adapt: find installed emulator packages (PackageManager) instead of .exe files |
| scan, scanIfChanged, cachedLibrary, library, onLibraryChanged, checkPaths, pathForFile, pick | Adapt: SAF folder picks + cached index (SAF is slow; never rescan on every start) |
| launchGame, onLaunchStatus, launchEmulator, gameEmulator, onExited, onRunReady, onRunQuitting, onRunAside | Adapt: **per-emulator intent profiles** (Dolphin, PPSSPP, Azahar, NetherSX2/AetherSX2, Eden, RetroArch…); "exited" = app resumed |
| launchApp, launchSteam | Adapt: launch Android apps by package; Steam Windows-only |
| restoreEmuSettings | Windows-only (Android emulator configs are app-private) |
| findIpl | Windows-only for now (Dolphin Android has its own folders) |
| homeMeta, shelfInfo, shelfMenuKey, onShelfMenu, openShelfMenu, onShelfMenuRequest | Adapt: in-game overlay isn't possible on Android; shelf menu itself is Shared |

## Art, manuals, reading
| Methods | Android |
|---|---|
| downloadCovers, cancelCovers, artCoverage, onCoversProgress, chooseArt | Shared logic (network + matching); file writes go through the storage adapter |
| artStudio … onArtJob (art*) | Shared logic; heavy image work may need to move off the UI thread |
| findManuals, cancelManuals, recentManuals, downloadManuals, rejectManual, manualCoverage | Shared |
| manualStudio … onManualJob (manual*) | Shared |
| libraryCover, libraryPages | Shared |
| archiveSearch, archiveCheck, archiveDownload, archiveCancel, onArchiveProgress | Shared |
| readingWhere, readingOld, readingImport, readingImportStop, onReadingImport | Adapt (SAF) |
| themes, setTheme, removeTheme, findLogos, useLogo, restoreLogo, saveConsoleFit | Shared logic + storage adapter |
| findModel, onModelInstalled, saveOptimizedModel | Adapt: "watch Downloads" doesn't work on Android, so use a file picker instead |

## Online services
| Methods | Android |
|---|---|
| raProgress, raShelf, raProfile, raEnabled, onRaUnlocks, raEmulators | Shared (RA web API); raEmulators (auto-config) Windows-only |
| stremioLibrary, stremioPoster, stremioDetails | Shared (Stremio/Nuvio exist on Android) |
| tvScan, tvList, tvAdFor, tvLocal, onTvFound | Shared |

## Media and history
| Methods | Android |
|---|---|
| songs, songRead | Adapt (SAF) |
| history, historyTouch, clearHistory, onHistoryChanged | Shared |

## Phone companion
| Methods | Android |
|---|---|
| companionState, companionSet, companionForget, companionPin, onCompanionState, onCompanionInput | Windows side stays the server. On the Thor, the reverse is the plan: **pull art/manuals/history from the PC** over LAN. |

## In-game Home menu (`window.home`, padwatch)
Windows-only. Android doesn't let an app read the controller while another app is in front; users get each
emulator's own menu instead.

## Files that use `bsfile://`
Images and pages are served to the renderer via the custom `bsfile://` scheme (`main.js`, `protocol.handle`).
On Android, Capacitor serves local files via its own scheme; keep every image URL going through one helper
so the scheme can change in one place.

## Order of work (from the roadmap)
1. Add `platform` info to the API (`{ os, caps }`) so the UI can hide Windows-only features.
2. Move the shared logic out of `main/` into `core/`, leaving `main/` as the Windows adapter.
3. Capacitor shell + `mock.js` on the Thor → performance checkpoint (Snapdragon 865 at 60 fps, cold start).
4. Android adapter: config, SAF scan, intent launch for the first systems.
