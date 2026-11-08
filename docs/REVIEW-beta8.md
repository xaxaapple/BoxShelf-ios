# Boxshelf full review (beta.8, 2026-11-06)

Six independent reviews covered the main process, the shelf (app.js), the museum, Settings and setup, the Android build
(web extras and Java), and the new console trailers. Every finding below was checked against the code before
anything was changed. Nothing that changes how Boxshelf looks or moves was touched, apart from removing glitches.

## Fixed in beta.8

### Console trailers (new code)
- **Going offline** marked every game "no trailer" for 3 days. The "video is gone" pattern matched the word "age" inside "webpage". Network failures now mark nothing; clips pause for 2 minutes.
- **The game you're on comes first:** clips were made in the order asked, so after browsing quickly the game you were on waited behind ones you'd passed. Now newest first, at most 3 waiting, and any game you left over 30 s ago is skipped.
- **The 400 MB limit:** it dropped the clips you watch most, because playing a kept clip didn't count as "seen". Fixed.
- **Failing videos:** one that keeps failing is left for 10 minutes instead of being retried on every rest. After 6 failures in a row, clips pause for 30 minutes.
- **The helper (yt-dlp):**
  - It ignores any yt-dlp config files on the PC, so someone's cookies or proxy settings can't change it.
  - A run that times out is ended with its whole process tree.
  - Its self-update only runs between clips.
  - Downloading it can't leave half a file behind.
  - Its checksum is computed without freezing the app.
- **Tested for real:** offering yt-dlp a JavaScript runtime (Node or Deno) made YouTube hand out streams that refuse downloads (HTTP 403), so Boxshelf deliberately doesn't.
- Smaller fixes:
  - A clip header with an unusual layout is read correctly.
  - The shelf no longer lists the clip folder on every rest.
  - Settings can't loop if the status check fails.

### Settings and the main process
- **Your changes undone by a later save:** a rename (Details → Rename) could be undone by changing any other setting during the same visit, and a finished "Set up for me" could come back and re-apply over your own emulator settings. Main now keeps its own copy of each game's name and emulator, Set up for me's waiting list and Switch 2's last build, the way it already kept box-art choices.
- **Picking an emulator** for one game no longer wipes that game's custom name.
- **Switch 2:** a locked settings file (antivirus) no longer stops a launch just to remember the last build.
- **Two quick "Open emulator" presses** can't race any more and rewrite Dolphin's settings while it starts.
- **Covers:** a page that isn't a picture (a Wi-Fi sign-in page, a server error page) is never saved as a cover. It used to stay broken for good, because art that's already there is never fetched again.
- **RetroArch core download:** it closes cleanly on errors, and "Getting core…" can't hang forever (5-minute limit).
- **Phone companion:** cover files are closed when the phone drops a request.
- **Start with Windows:** a folder path with a curly apostrophe (’) broke the startup shortcut.
- **Settings navigation:**
  - Focus never lands on nothing after the last row of a list goes (unhiding the last hidden game, deleting the last collection).
  - B closes the "Learn more" card first, and only that.
  - Start closes Settings from search too, as everywhere else.
  - A failed save is tried again with the next change instead of being dropped.
  - Collection rows and Add games rows no longer hold the previous visit's settings: deleting or renaming a collection after reopening Settings silently did nothing.

### The shelf and the museum
- **Holds** (A on the disc in Inspect, a held Restart / Shut down, the museum's hold) end, unfinished, if the touch is cancelled or Boxshelf loses focus. A pulled-down notification shade or Alt-Tab mid-hold could start a game or restart the PC.
- **Clicking a side case** no longer moves the shelf behind a note card, Sort, Achievements or Customize.
- **Note cards** (What's new, updates, the trailer helper) wait for the quick menu to close instead of opening on top of it.
- **Non-standard controllers** whose triggers rest at -1 no longer look "held" forever. That used to swallow every press after Settings closed, and the screen never dimmed.
- **The museum's idle camera drift** eases out when you touch the controls, instead of jumping sideways in one frame.
- **Museum memory:** leaving the museum frees its full-screen drawing buffers, about 70 MB on the Thor and about 300 MB on a 4K TV.

### Android (needs your test on the Thor)
- **Taps after a flick:** the first tap after a backup click could swallow the next real tap within 0.7 s. Now only a late click at the same spot as the backup is swallowed.
  - My first attempt (clearing the guard on every new touch) let some taps act twice. The device test caught it, and it was replaced.
- **The pixel-ratio fix** (android-early.js) re-read the window size on every use, which could force a layout mid-slide (cover thumbnails ask for it per case). It's now worked out once per window size.
- **Tried and reverted:**
  - Delaying the library save until the shelf is still: a save delayed like that was lost if the app closed or reloaded right after a scan.
  - Delaying the startup library comparison: that moved the shelf rebuild to an unexpected later moment.
  - The original small stutter after start-up stays open. A safer fix is for the Android scan to say "nothing changed" when the files are the same, so the comparison and the save are skipped entirely.
- **Saving settings files (Java):** if both renames failed, the old settings file was already deleted. Now it's moved aside and put back, and the save reports the failure.
- **The folder picker (Java):** a phone whose picker hands back a plain file link no longer leaves the setup wizard waiting forever.
- Video previews isn't offered in Android's Settings yet (it isn't on Android).

## Not changed yet (your call; bigger or needs testing on a device)

Most valuable first.

1. **Touch scrolling in Settings (Thor):** long Settings pages can only be scrolled with the controller, or by tapping the bottom row (which also changes it). It needs a vertical drag, tested on the device.
2. **"Learn more" (X) on the Thor:** the hint shows, but the card is hidden on Android, so nothing appears. Either show the extra text under the row or drop the hint.
3. **Up/Down on the theme tiles** changes and saves the theme as you pass over it. That's the one place where moving changes a setting.
4. **Flipping a case with no back art** builds its back picture on the main thread (10-90 ms, a hitch on the first flip of each game). Fix: build it in the background, as fronts already are.
5. **Details screenshots** load at full size for the small strip and the backdrop. Fix: use the existing thumbnail sizes (no visible change).
6. **Settings rebuilds its rows 4-5 times per button press**, and search rebuilds everything on each key. Caching would make Settings snappier on the Thor.
7. **Every settings save** writes and fsyncs the whole file on the main thread. On a slow disk it can stall for tens of milliseconds. Fix: an async writer.
8. **Android saving and art (Java):** file writes run on the plugin's single thread, art saving lists the whole "Boxshelf Art" folder for every picture (slow with thousands of games), and thread pools aren't shut down when the app closes. Worth a careful pass with a device in hand.
9. **The bottom screen** acts on the top screen's game if you tap it in the half second before it updates. That's arguably right (it's the game you're looking at), so it's left as is.
10. Smaller items:
    - Hold progress bars use `width` instead of a transform.
    - With no controller connected, the controller poll still runs every frame.
    - A few 1-15 s timers keep running on the Thor while idle.
    - Two museum movie-art caches never shrink.
    - The ROM folder watcher isn't retried if a drive is plugged in later.

## Checked and fine
- **File serving:** bsfile:// blocks path tricks.
- **Launching:** no shell is involved.
- **Phone companion:** its security checks are sound.
- **Android plugin calls:** every native call is answered exactly once, and the version checks are right for Android 7.
- **Leaks:** the object URLs for covers and booklets are released, and the cover caches are capped.
- **Museum:**
  - Nothing reads pixels back from the graphics card.
  - Its loop stops when it's closed.
  - It recovers if the graphics context is lost.
