#!/bin/bash
# Double-click in Finder to run the Open Convo Desk on this Mac.
# Open http://127.0.0.1:4183 in Codex's inline browser or any browser.
# Close this window (or press Control-C) to stop it.
cd "$(dirname "$0")" || exit 1
echo "Getting the latest version from GitHub..."
git pull --ff-only || echo "Could not update automatically; starting the version already here."
cd apps/desk || exit 1
if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js is not installed, so the Desk cannot start."
  echo "Install it from https://nodejs.org, then double-click this file again."
  read -r -p "Press Return to close."
  exit 1
fi
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules ]; then
  echo "Installing the Desk's parts (first run only)..."
  npm ci --no-audit --no-fund || { read -r -p "Install failed. Press Return to close."; exit 1; }
fi
echo
echo "Open Convo Desk: http://127.0.0.1:4183"
echo "It updates by itself when the code changes. Close this window to stop it."
echo
npx vite --host 127.0.0.1 --port 4183 --strictPort
