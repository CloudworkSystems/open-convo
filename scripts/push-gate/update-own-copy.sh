#!/bin/sh
# Brings the gate's own copy of open-convo up to the latest main, forward
# only, with hooks off and no settings read from the user's git
# configuration. The repo is public, so this needs no sign-in.
# Usage: update-own-copy.sh <folder of the gate's own copy>
set -eu
copy="${1:?name the folder that holds the copy}"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0
exec git -C "$copy" -c core.hooksPath=/dev/null -c credential.helper= \
  pull -q --ff-only https://github.com/CloudworkSystems/open-convo.git main
