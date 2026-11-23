@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 or later is required. Install Node.js and reopen this script.
  pause
  exit /b 1
)
node -e "if (+process.versions.node.split('.')[0] < 22) process.exit(1)"
if errorlevel 1 (
  echo Node.js 22 or later is required.
  pause
  exit /b 1
)
node analyzer/server.mjs "%~1"
if errorlevel 1 pause

