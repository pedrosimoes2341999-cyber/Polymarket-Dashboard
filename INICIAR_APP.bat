@echo off
title Polymarket CS2 Combo Tracker ONLINE v5
cd /d "%~dp0"

set APP_USER=admin
set APP_PASSWORD=admin
set SESSION_SECRET=local-dev-secret
set DATA_DIR=%~dp0data

if not exist "%~dp0data" mkdir "%~dp0data"

echo A iniciar a app...
start "" http://localhost:8787
node --no-warnings server.js

pause
