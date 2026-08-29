@echo off
REM ===========================================================================
REM MCSM-AI build script (Windows). Produces ./production-code/
REM
REM   production-code/
REM   - start.bat            one-command startup (single-process mode)
REM   - web/                 panel + built frontend in public/
REM   - daemon/              stand-alone daemon (classic split deployment)
REM   - daemon/production/   embedded.js (loaded by the panel in single-process mode)
REM
REM BUNDLE=1 inlines all deps + language packs into a single app.js, so the
REM output runs with bare `node app.js` - no npm install needed at runtime.
set BUNDLE=1

call npm run preview-build

rd /s /q "production-code"
rd /s /q ".\daemon\dist"
rd /s /q ".\daemon\production"
rd /s /q ".\panel\dist"
rd /s /q ".\panel\production"

echo Build daemon...
cd daemon
call npm run build

echo Build panel...
cd ..
cd panel
call npm run build

echo Build frontend...
cd ..
cd frontend
call npm run build

echo Collecting files...
cd ..

mkdir "production-code"
mkdir "production-code\daemon"
mkdir "production-code\daemon\production"
mkdir "production-code\web"
mkdir "production-code\web\public"

REM --- panel ---
copy ".\panel\production\app.js" ".\production-code\web\app.js"
copy ".\panel\production\app.js.map" ".\production-code\web\app.js.map"
copy ".\panel\package.json" ".\production-code\web\package.json"
copy ".\panel\package-lock.json" ".\production-code\web\package-lock.json"

REM --- frontend (served from web/public) ---
xcopy ".\frontend\dist" ".\production-code\web\public" /E /I /H /Y >nul

REM --- daemon: stand-alone + embedded bundle ---
copy ".\daemon\production\app.js" ".\production-code\daemon\app.js"
copy ".\daemon\production\app.js.map" ".\production-code\daemon\app.js.map"
copy ".\daemon\package.json" ".\production-code\daemon\package.json"
copy ".\daemon\package-lock.json" ".\production-code\daemon\package-lock.json"

REM The panel resolves the embedded daemon from ../daemon/production/embedded.js
copy ".\daemon\production\embedded.js" ".\production-code\daemon\production\embedded.js"
copy ".\daemon\production\embedded.js.map" ".\production-code\daemon\production\embedded.js.map"

REM per-platform external runtime binaries (PTY / Zip-Tools) if present
if exist ".\daemon\lib" xcopy ".\daemon\lib" ".\production-code\daemon\lib" /E /I /H /Y >nul

REM --- final cleanup ---
rd /s /q ".\daemon\production"
rd /s /q ".\panel\production"
rd /s /q ".\daemon\dist"
rd /s /q ".\panel\dist"
rd /s /q ".\frontend\dist"

REM --- one-command startup (single-process) ---
(
  echo @echo off
  echo cd /d "%%~dp0web"
  echo node --max-old-space-size=8192 --enable-source-maps app.js %%*
) > ".\production-code\start.bat"

echo.
echo Compilation completed!
echo Output Directory: ./production-code/
echo Single-process start: cd production-code and run start.bat
echo.
pause