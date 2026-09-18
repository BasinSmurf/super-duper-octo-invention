@echo off
title Sync Prod DB to Dev
echo ============================================
echo   SYNC PROD DATABASE TO LOCAL DEV
echo ============================================
echo.
echo   This will REPLACE your local dev database
echo   with a fresh copy from production.
echo.
echo   Press Ctrl+C to abort, or...
pause
echo.

set DUMP_FILE=%TEMP%\sundog-prod-dump.sql
set PROD_HOST=sundog@servpro
set PROD_CONTAINER=servicepro-postgres
set PROD_DB=servicepro
set PROD_USER=servicepro
set DEV_CONTAINER=sundog-postgres
set DEV_DB=sundog
set DEV_USER=sundog

:: 1. Dump prod database via SSH
echo [1/4] Dumping production database...
ssh %PROD_HOST% "docker exec %PROD_CONTAINER% pg_dump -U %PROD_USER% --clean --if-exists --no-owner --no-privileges %PROD_DB%" > "%DUMP_FILE%"
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Failed to dump prod database. Check SSH connection.
    pause
    exit /b 1
)
echo       Dump saved to %DUMP_FILE%
for %%A in ("%DUMP_FILE%") do echo       Size: %%~zA bytes
echo.

:: 2. Make sure local Docker is running
echo [2/4] Ensuring local Docker containers are up...
cd /d C:\turdhurdles\Claudius
docker compose up -d postgres
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Docker failed to start. Is Docker Desktop running?
    pause
    exit /b 1
)
:: Wait for postgres to be healthy
timeout /t 3 /nobreak >nul
echo       Local Postgres OK
echo.

:: 3. Drop and recreate the dev database to get a clean slate
echo [3/4] Restoring dump to local dev database...
docker exec -i %DEV_CONTAINER% psql -U %DEV_USER% -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='%DEV_DB%' AND pid <> pg_backend_pid();" >nul 2>&1
docker exec -i %DEV_CONTAINER% psql -U %DEV_USER% -d %DEV_DB% < "%DUMP_FILE%"
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Failed to restore dump. Check output above.
    pause
    exit /b 1
)
echo       Restore complete
echo.

:: 4. Verify
echo [4/4] Verifying...
docker exec %DEV_CONTAINER% psql -U %DEV_USER% -d %DEV_DB% -c "SELECT 'equipment' as tbl, count(*) FROM serialized_equipment UNION ALL SELECT 'tickets', count(*) FROM service_tickets UNION ALL SELECT 'companies', count(*) FROM companies UNION ALL SELECT 'products', count(*) FROM products;"
echo.

:: Cleanup
del "%DUMP_FILE%" >nul 2>&1

echo ============================================
echo   DONE - Local dev DB now matches prod
echo ============================================
echo.
echo   NOTE: Run 'npx prisma migrate deploy' in
echo   server/ if you have newer migrations than prod.
echo.
pause
