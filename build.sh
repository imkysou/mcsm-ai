#!/bin/sh

set -e

BASE_PATH=$(pwd)

# BUNDLE=1 makes the panel/daemon webpack configs inline the entire
# dependency tree (including all language packs and mcsmanager-common)
# into a SINGLE self-contained app.js, so the output runs with bare
# `node app.js` - no `npm install` needed on the server.
#
# project structure (single-process mode):
#   production-code/
#   ├── start.sh / start.bat      # one-command startup (panel + embedded daemon)
#   ├── web/                      # MC SM panel (single-process, one port)
#   │   ├── app.js                # self-contained bundle
#   │   └── public/               # built frontend (vue)
#   └── daemon/
#       ├── app.js                # stand-alone daemon (classic split deployment)
#       └── production/
#           └── embedded.js       # embedded daemon loaded by the panel
export BUNDLE=1

npm run preview-build

rm -rf production-code
rm -rf ./daemon/dist ./daemon/production
rm -rf ./panel/dist ./panel/production

echo 'Build daemon...'
cd "${BASE_PATH}/daemon"
npm run build

echo 'Build panel...'
cd "${BASE_PATH}/panel"
npm run build

echo 'Build frontend...'
cd "${BASE_PATH}/frontend"
npm run build

echo 'Collecting files...'
cd "${BASE_PATH}"

mkdir production-code
mkdir production-code/daemon
mkdir production-code/daemon/production
mkdir production-code/web
mkdir production-code/web/public

# --- panel ---
mv "${BASE_PATH}/panel/production/app.js" "${BASE_PATH}/production-code/web"
mv "${BASE_PATH}/panel/production/app.js.map" "${BASE_PATH}/production-code/web"
cp -f "${BASE_PATH}/panel/package.json" "${BASE_PATH}/production-code/web/package.json"
cp -f "${BASE_PATH}/panel/package-lock.json" "${BASE_PATH}/production-code/web/package-lock.json"

# --- frontend (served by the panel from web/public) ---
mv "${BASE_PATH}"/frontend/dist/* "${BASE_PATH}/production-code/web/public"

# --- daemon: stand-alone bundle + embedded bundle for single-process mode ---
mv "${BASE_PATH}/daemon/production/app.js" "${BASE_PATH}/production-code/daemon"
mv "${BASE_PATH}/daemon/production/app.js.map" "${BASE_PATH}/production-code/daemon"
cp -f "${BASE_PATH}/daemon/package.json" "${BASE_PATH}/production-code/daemon/package.json"
cp -f "${BASE_PATH}/daemon/package-lock.json" "${BASE_PATH}/production-code/daemon/package-lock.json"

# The panel resolves the embedded daemon from ../daemon/production/embedded.js
# (relative to its own directory), so it MUST live at this exact path.
mv "${BASE_PATH}/daemon/production/embedded.js" "${BASE_PATH}/production-code/daemon/production/embedded.js"
mv "${BASE_PATH}/daemon/production/embedded.js.map" "${BASE_PATH}/production-code/daemon/production/embedded.js.map"

# per-platform external runtime binaries (PTY / Zip-Tools) if present
if [ -d "${BASE_PATH}/daemon/lib" ]; then
  cp -rf "${BASE_PATH}/daemon/lib" "${BASE_PATH}/production-code/daemon/lib"
fi

# one-command startup script for single-process mode
cat > "${BASE_PATH}/production-code/start.sh" <<'START_EOF'
#!/bin/sh
cd "$(dirname "$0")/web"
exec node --max-old-space-size=8192 --enable-source-maps app.js "$@"
START_EOF
chmod +x "${BASE_PATH}/production-code/start.sh"

# one-command startup for Windows (single-process mode)
cat > "${BASE_PATH}/production-code/start.bat" <<'START_BAT_EOF'
@echo off
cd /d "%~dp0web"
node app.js %*
START_BAT_EOF

rm -rf "${BASE_PATH}/daemon/dist" "${BASE_PATH}/daemon/production"
rm -rf "${BASE_PATH}/panel/dist" "${BASE_PATH}/panel/production"
rm -rf "${BASE_PATH}/frontend/dist"

echo '------------'
echo 'Compilation completed!'
echo 'Output Directory: ./production-code/'
echo 'Single-process start: cd production-code && ./start.sh'
echo '------------'
