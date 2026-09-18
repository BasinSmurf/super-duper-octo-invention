@echo off
setlocal
title Sync Prod DB to Sandbox
cd /d "%~dp0"

set DUMP_FILE=%TEMP%\sundog-prod-dump.sql
set PROD_HOST=sundog@servpro
set PROD_CONTAINER=servicepro-postgres
set PROD_DB=servicepro
set PROD_USER=servicepro
set SB_CONTAINER=sundog-postgres-sandbox
set SB_DB=sandbox
set SB_USER=sandbox
set SB_URL=postgresql://sandbox:sandbox_dev@127.0.0.1:5435/sandbox?schema=public

echo ============================================
echo   SYNC PRODUCTION DATABASE TO SANDBOX
echo ============================================
echo.
echo   Reads production (pg_dump over SSH, read-only)
echo   and REPLACES the local sandbox database.
echo.
echo   Source: %PROD_HOST% / servicepro
echo   Target: localhost:5435 / sandbox
echo.
echo   The sandbox database is named explicitly, so this is safe to run
echo   from either checkout. The dev database on :5432 is never touched.
echo   See SANDBOX.md.
echo.
echo   Press Ctrl+C to abort, or...
pause
echo.

:: 1. Sandbox containers first — nothing else works without them
echo [1/6] Starting sandbox containers...
docker compose -f docker-compose.sandbox.yml up -d
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Docker failed to start. Is Docker Desktop running?
    goto :fail
)
:: Wait for the healthcheck rather than a blind timeout
set /a WAITED=0
:waitdb
docker exec %SB_CONTAINER% pg_isready -U %SB_USER% >nul 2>&1
if %ERRORLEVEL% EQU 0 goto :dbready
set /a WAITED+=2
if %WAITED% GEQ 60 (
    echo ERROR: sandbox Postgres never became ready ^(60s^).
    goto :fail
)
timeout /t 2 /nobreak >nul
goto :waitdb
:dbready
echo       Sandbox Postgres ready on :5435
echo.

:: 2. Dump production. Read-only on prod, but it is still prod I/O on a
::    2-core box — do not run this during a busy shift.
echo [2/6] Dumping production database...
ssh %PROD_HOST% "docker exec %PROD_CONTAINER% pg_dump -U %PROD_USER% --clean --if-exists --no-owner --no-privileges %PROD_DB%" > "%DUMP_FILE%"
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Failed to dump prod database. Check the SSH connection.
    goto :fail
)
for %%A in ("%DUMP_FILE%") do set DUMP_SIZE=%%~zA
echo       %DUMP_SIZE% bytes -^> %DUMP_FILE%
:: A dump this small means pg_dump errored and wrote only a header
if %DUMP_SIZE% LSS 1000000 (
    echo ERROR: dump is implausibly small ^(%DUMP_SIZE% bytes^). Aborting before
    echo        it overwrites the sandbox with nothing. Inspect %DUMP_FILE%.
    goto :fail
)
echo.

:: 3. Restore. --clean in the dump drops the old objects on the way in.
echo [3/6] Restoring into sandbox...
docker exec -i %SB_CONTAINER% psql -U %SB_USER% -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='%SB_DB%' AND pid <> pg_backend_pid();" >nul 2>&1
docker exec -i %SB_CONTAINER% psql -U %SB_USER% -d %SB_DB% -q < "%DUMP_FILE%" > "%TEMP%\sundog-restore.log" 2>&1
:: psql exits 0 even with per-statement errors, so verify the schema landed
for /f %%C in ('docker exec %SB_CONTAINER% psql -U %SB_USER% -d %SB_DB% -tAc "select count(*) from information_schema.tables where table_schema='public'"') do set TBLCOUNT=%%C
if %TBLCOUNT% LSS 50 (
    echo ERROR: only %TBLCOUNT% tables after restore — expected 80+.
    echo        See %TEMP%\sundog-restore.log
    goto :fail
)
echo       %TBLCOUNT% tables restored
echo.

:: 4. Apply any migrations newer than prod's. Normally reports "No pending
::    migrations to apply" — prod runs master, so the dump already carries
::    every migration in the repo. Anything applied here is work that merged
::    after prod's last deploy.
echo [4/6] Applying pending migrations...
pushd server
set DATABASE_URL=%SB_URL%
call npx prisma migrate deploy
if %ERRORLEVEL% NEQ 0 (
    echo WARNING: migrate deploy reported a problem. Check the output above.
)
popd
echo.

:: 5. Cut the outbound wires before the app ever boots against this data.
::    See scripts\sandbox-sanitize.sql for what and why.
echo [5/6] Neutralising queued outbound work...
docker exec -i %SB_CONTAINER% psql -U %SB_USER% -d %SB_DB% -v ON_ERROR_STOP=1 < scripts\sandbox-sanitize.sql
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: sanitise step failed. Do NOT start the sandbox against this
    echo        database — it still has production work queued up.
    goto :fail
)
echo.

:: 6. Show what came across
echo [6/6] Verifying...
docker exec %SB_CONTAINER% psql -U %SB_USER% -d %SB_DB% -c "SELECT 'companies' AS tbl, count(*) FROM companies UNION ALL SELECT 'tickets', count(*) FROM service_tickets UNION ALL SELECT 'equipment', count(*) FROM serialized_equipment UNION ALL SELECT 'products', count(*) FROM products UNION ALL SELECT 'invoices', count(*) FROM invoices UNION ALL SELECT 'wells', count(*) FROM wells;"
echo.

del "%DUMP_FILE%" >nul 2>&1

echo ============================================
echo   DONE — sandbox now holds a copy of prod
echo ============================================
echo.
echo   Next: sandbox.bat
echo.
echo   Confirm which QuickBooks it is bound to before pushing anything:
echo     http://127.0.0.1:3002/api/qbwc/test   ^(identity block^)
echo.
pause
endlocal
exit /b 0

:fail
echo.
echo ============================================
echo   ABORTED - sandbox left as it was
echo ============================================
pause
endlocal
exit /b 1
