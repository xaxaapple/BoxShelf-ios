@echo off
REM Copies the Android build recipe to where GitHub looks for it (.github\workflows). Safe to run more than once.
cd /d "%~dp0..\.."
if not exist ".github\workflows" mkdir ".github\workflows"
copy /Y "android-app\ci\android.yml" ".github\workflows\android.yml" >nul
if exist ".github\workflows\android.yml" (echo Done: .github\workflows\android.yml is in place. Commit and push in GitHub Desktop.) else (echo Something went wrong - the file was not copied.)
pause
