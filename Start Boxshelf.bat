@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installing Boxshelf the first time. This takes a minute...
  call npm install
)
call npm start
