#!/bin/bash
# Double-click in Finder to run the Open Convo Desk on this Mac.
# Open http://127.0.0.1:4183 in Codex's inline browser or any browser.
# Close this window (or press Control-C) to stop it.
cd "$(dirname "$0")" || exit 1
echo "Getting the latest version from GitHub..."
branch=$(git branch --show-current)
if [ "$branch" != "main" ]; then
  if [ -z "$(git status --porcelain)" ]; then
    echo "This folder was on the branch \"$branch\"; switching to main (nothing is lost)."
    git checkout main || echo "Could not switch to main."
  else
    echo
    echo "WARNING: this folder is on the branch \"$branch\", not main, and has unsaved changes,"
    echo "so the Desk below is NOT the latest version. Ask Claude to sort out this folder."
    echo
  fi
fi
if [ "$(git branch --show-current)" = "main" ]; then
  git pull --ff-only origin main || echo "Could not update automatically; starting the version already here."
fi
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
