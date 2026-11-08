@echo off
cd /d "%~dp0"
echo Building a portable Boxshelf.exe (first time downloads the packager, a few minutes)...
if not exist node_modules call npm install
call npm run dist
echo.
echo Done. Your exe is in the dist folder. Copy Boxshelf.exe next to this file so it finds Dolphin, ROMS and themes.
pause
