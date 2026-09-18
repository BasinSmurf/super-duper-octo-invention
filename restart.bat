@echo off
title Service Pro Restart
echo ============================================
echo   KILLING OLD PROCESSES...
echo ============================================

:: Kill any existing node processes for our project
:: (tsx watch, vite, etc.)
taskkill /FI "WINDOWTITLE eq Service Pro API" /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq Service Pro Vite" /F >nul 2>&1

:: Also kill by port in case the window titles don't match
for /f "tokens=5" %%p in ('netstat -aon ^| findstr ":3001 " ^| findstr "LISTENING"') do (
    echo Killing process on port 3001 (PID %%p)
    taskkill /PID %%p /F >nul 2>&1
)
for /f "tokens=5" %%p in ('netstat -aon ^| findstr ":5173 " ^| findstr "LISTENING"') do (
    echo Killing process on port 5173 (PID %%p)
    taskkill /PID %%p /F >nul 2>&1
)

timeout /t 2 /nobreak >nul

echo Done. Starting fresh...
echo.

:: Now launch everything fresh
call C:\turdhurdles\Claudius\dev.bat
