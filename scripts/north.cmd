@echo off
REM Launch North Command Center and open it in the default browser.
REM Double-click this file, or pin it to the taskbar.

setlocal
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found on PATH. Install Node 20 or newer, then run this again.
  pause
  exit /b 1
)

echo Starting North Command Center...
start "" http://127.0.0.1:4300
node server\index.js

REM If the server exits, keep the window open so the error stays readable.
if errorlevel 1 pause
endlocal
