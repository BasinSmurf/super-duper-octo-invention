@echo off
REM ─────────────────────────────────────────────
REM Import DoForms tickets into prod Sundog DB
REM
REM Run from repo root: import-to-prod.bat
REM
REM Steps:
REM   1. Generates import-doforms.sql from JSON files (locally)
REM   2. SCPs it to the prod box
REM   3. SSHs in and pipes it into the Postgres container
REM ─────────────────────────────────────────────

REM ── CONFIGURE THESE ──────────────────────────
set PROD_HOST=user@your-prod-host
set PROD_DIR=/tmp
set PG_CONTAINER=servicepro-postgres
set PG_USER=sundog
set PG_DB=sundog
REM ─────────────────────────────────────────────

echo.
echo === Sundog DoForms Import ===
echo.

echo [1/3] Generating SQL from JSON files...
node preload\generate-import-sql.js
if %ERRORLEVEL% neq 0 (
    echo ERROR: SQL generation failed.
    exit /b 1
)
echo.

echo [2/3] Copying SQL to prod box...
scp preload\import-doforms.sql %PROD_HOST%:%PROD_DIR%/import-doforms.sql
if %ERRORLEVEL% neq 0 (
    echo ERROR: SCP failed. Check PROD_HOST setting.
    exit /b 1
)
echo.

echo [3/3] Running SQL on prod Postgres...
ssh %PROD_HOST% "docker exec -i %PG_CONTAINER% psql -U %PG_USER% -d %PG_DB% < %PROD_DIR%/import-doforms.sql && rm %PROD_DIR%/import-doforms.sql"
echo.

echo === Done ===
