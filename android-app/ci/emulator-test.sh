#!/usr/bin/env bash
# Boxshelf device test: runs on GitHub's Android emulator right after the APK is built (see .github/workflows/android.yml).
# Installs the APK fresh, opens Boxshelf, waits, then reads what the page itself reported plus a screenshot. (beta.10) The
# app logs nothing to Android's log ("loggingBehavior": "none"), so the page writes its status, whether the adapter started
# and its first script errors into files/device-test.txt, read here with run-as (debug APK). Console lines are still used
# when a build has logging on. The build fails unless:
#   - the Android adapter says it is active on the device (not the demo), and setup is "not done" (so the wizard shows)
#   - no script errors and no app crash
# Results: the run's Summary page (readable at a glance) and the "device-test" artifact (screen.png, console.txt, logcat.txt).
set -u
APK=$(ls out/*.apk 2>/dev/null | head -1)
OUT=out/device-test; mkdir -p "$OUT"
SUM=${GITHUB_STEP_SUMMARY:-/dev/stdout}
say() { echo "$*"; echo "$*" >> "$SUM"; }

[ -n "$APK" ] || { say "### Device test: FAILED, no APK was built"; exit 1; }
adb wait-for-device
adb uninstall io.github.boxshelf >/dev/null 2>&1 || true   # fresh install, like a new user
if ! adb install -r "$APK" > "$OUT/install.txt" 2>&1; then say "### Device test: FAILED, install refused"; cat "$OUT/install.txt" >> "$SUM"; exit 1; fi
adb logcat -c
adb shell am start -W -n io.github.boxshelf/.MainActivity > "$OUT/start.txt" 2>&1
sleep 45   # the emulator is slow (software graphics); the Thor is far quicker
adb exec-out screencap -p > "$OUT/screen.png" 2>/dev/null || true
adb logcat -d > "$OUT/logcat.txt" 2>/dev/null || true
grep "Capacitor/Console" "$OUT/logcat.txt" | sed -E 's/^.*Capacitor\/Console[^:]*: //' > "$OUT/console.txt" || true
adb shell run-as io.github.boxshelf cat files/device-test.txt 2>/dev/null | tr -d '\r' > "$OUT/status.txt" || true

STATUS=$(grep '^status ' "$OUT/status.txt" | tail -1 | sed -E 's/^status //')
[ -n "$STATUS" ] || STATUS=$(grep -o '\[boxshelf\] status .*' "$OUT/console.txt" | tail -1 | sed -E 's/^\[boxshelf\] status //; s/ - .*$//')
READY=$(grep -c '^ready device' "$OUT/status.txt" || true)
[ "${READY:-0}" -gt 0 ] || READY=$(grep -c 'Android adapter ready (device)' "$OUT/console.txt" || true)
ERRORS=$( { grep '^error ' "$OUT/status.txt" | sed -E 's/^error //'; grep -E ' E Capacitor/Console' "$OUT/logcat.txt" | sed -E 's/^.*Msg: //'; } | grep -v 'net::ERR_' | head -8)
CRASH=$(grep -E 'FATAL EXCEPTION|AndroidRuntime: Process: io.github.boxshelf' "$OUT/logcat.txt" | head -3)

say "### Boxshelf device test (Android emulator, API $(adb shell getprop ro.build.version.sdk | tr -d '\r'))"
say ""
say "| check | result |"
say "|---|---|"
say "| Android adapter | ${STATUS:-no status reported} |"
say "| adapter started on device | $([ "${READY:-0}" -gt 0 ] && echo yes || echo NO) |"
say "| script errors | $([ -z "$ERRORS" ] && echo none || echo "$(echo "$ERRORS" | wc -l)") |"
say "| app crash | $([ -z "$CRASH" ] && echo none || echo YES) |"
if [ -n "$ERRORS" ]; then say ""; say "**Errors:**"; echo "$ERRORS" | while read -r l; do say "- \`${l:0:220}\`"; done; fi
if [ -n "$CRASH" ]; then say ""; say "**Crash:**"; echo "$CRASH" | while read -r l; do say "- \`${l:0:220}\`"; done; fi
say ""; say "**First Boxshelf messages:**"; grep '\[boxshelf\]' "$OUT/console.txt" | sed -E 's/^.*Msg: //' | head -6 | while read -r l; do say "- \`${l:0:200}\`"; done

FAIL=0
case "${STATUS:-}" in active*"setup not done"*) ;; *) FAIL=1 ;; esac
[ "${READY:-0}" -gt 0 ] || FAIL=1
[ -z "$ERRORS" ] || FAIL=1
[ -z "$CRASH" ] || FAIL=1
say ""
if [ $FAIL -eq 0 ]; then say "**PASSED**: the APK below is safe to install."; else say "**FAILED**: no APK is published for this run."; fi
exit $FAIL
