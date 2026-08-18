@echo off
setlocal
set "ROOT=%~dp0"
set "SHARED_DIR=%ROOT%shared"
cd /d "%ROOT%"
echo [UpWeb] Launching...
call npm run electron:dev
endlocal
