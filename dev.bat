@echo off
title Service Pro Dev Launcher
:: Everything below is relative to this script, so a second checkout (see
:: SANDBOX.md) runs its own code, its own database and its own ports purely
:: from its own server\.env — no separate launcher needed.
echo ============================================
echo   SERVICE PRO — %~dp0
echo ============================================
echo.

:: 1. Make sure Docker containers are running (Postgres + Redis)
echo [1/3] Starting Docker (Postgres + Redis)...
cd /d "%~dp0"
docker compose up -d
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Docker failed to start. Is Docker Desktop running?
    pause
    exit /b 1
)
echo      Docker OK
echo.

:: 2. Start the API server in a new window
echo [2/3] Starting API server...
start "Service Pro API" /D "%~dp0server" cmd /k "npm run dev"

:: Give the API a moment to boot before Vite tries to proxy to it
timeout /t 3 /nobreak >nul

:: 3. Start the Vite dev server in a new window
echo [3/3] Starting Vite (React PWA)...
start "Service Pro Vite" /D "%~dp0client" cmd /k "npm run dev"

:: Report the ports this checkout actually uses rather than assuming the
:: defaults — a second checkout runs on its own.
set API_PORT=3001
for /f "tokens=2 delims==" %%p in ('findstr /R "^PORT=" "%~dp0server\.env" 2^>nul') do set API_PORT=%%p
set WEB_PORT=5173
for /f "tokens=2 delims==" %%p in ('findstr /R "^PORT=" "%~dp0client\.env.local" 2^>nul') do set WEB_PORT=%%p

echo.
echo ============================================
echo   ALL RUNNING - windows:
echo     "Service Pro API"  = Express server (:%API_PORT%)
echo     "Service Pro Vite" = React dev server (:%WEB_PORT%)
echo ============================================
echo.
echo   iPad/LAN access: http://YOUR_IP:%WEB_PORT%
echo   Close this window whenever. The others keep running.
echo.
pause
