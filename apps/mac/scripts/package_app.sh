#!/usr/bin/env bash
# Build and assemble "True Convo.app" in dist/.
#
#   scripts/package_app.sh            build dist/True Convo.app (ad-hoc signed)
#   scripts/package_app.sh --install  also swap it into ~/Applications
#
# Desk window (invented data): set TRUE_CONVO_WITH_DESK=1 to bundle the Desk,
# built offline from this checkout's clean apps/desk (it refuses local
# changes, untracked files or a missing node_modules, and never fetches
# anything). The build writes only into a fresh private temporary folder made
# by this script; apps/desk or an old apps/desk/native-dist that is a symbolic
# link, or not a plain folder of this user's, is refused before anything is
# built. Without it the app has no Desk and its menu item says so. A Desk
# build is a Test Account trial build: the script refuses to combine it with
# --install or TRUE_CONVO_SIGN_IDENTITY.
#
# Every build (with or without the Desk) deletes the old app in dist/ and
# assembles the new one there, so dist, and the app folders it replaces, must
# be plain folders of this user's (or not there yet), never links. Otherwise
# it refuses before anything is built: a dist link would send the delete and
# the new build to wherever the link points, such as ~/Applications.
#
# Signing: ad-hoc by default. To sign a copy that stays on this Mac with a
# Developer ID, set TRUE_CONVO_SIGN_IDENTITY to the certificate's SHA-1
# fingerprint (see `security find-identity -v -p codesigning`). Choosing by
# fingerprint matters because two certificates on this Mac share one name.
# This script never notarizes, uploads, or publishes anything.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="True Convo"
EXECUTABLE_NAME="True Convo"
BUNDLE_ID="com.trueconvo.voice-cursor"
APP_DIR="${ROOT_DIR}/dist/${APP_NAME}.app"
CONTENTS_DIR="${APP_DIR}/Contents"
MACOS_DIR="${CONTENTS_DIR}/MacOS"
RESOURCES_DIR="${CONTENTS_DIR}/Resources"
INFO_PLIST="${ROOT_DIR}/Packaging/Info.plist"
BINARY_SRC="${ROOT_DIR}/.build/release/VoiceCursorMac"
ICONSET_DIR="${ROOT_DIR}/Packaging/AppIcon.iconset"
ICON_SRC="${ROOT_DIR}/Packaging/AppIcon.icns"
TRUE_CONVO_ICON_SRC="${ROOT_DIR}/Packaging/TrueConvoIcon.png"
SIGN_IDENTITY="${TRUE_CONVO_SIGN_IDENTITY:--}"
INSTALL_DIR="${TRUE_CONVO_INSTALL_DIR:-${HOME}/Applications}"
DESK_DIR="$(cd "${ROOT_DIR}/.." && pwd -P)/desk"
DESK_MANIFEST_TOOL="${ROOT_DIR}/.build/release/DeskBundleManifest"
WITH_DESK="${TRUE_CONVO_WITH_DESK:-0}"

INSTALL=0
for arg in "$@"; do
  case "${arg}" in
    --install) INSTALL=1 ;;
    *) echo "Unknown option: ${arg}" >&2; exit 2 ;;
  esac
done

if [[ "${WITH_DESK}" == "1" ]] && [[ "${INSTALL}" -eq 1 || "${SIGN_IDENTITY}" != "-" ]]; then
  echo "Desk: a Desk build is for the Test Account trial only. It is never installed in ~/Applications or signed with a Developer ID; run it without --install and without TRUE_CONVO_SIGN_IDENTITY." >&2
  exit 2
fi

# Refuses (exit 1) unless the path is absent or a plain folder of this user's.
# A link is refused even if it points at a folder: nothing is built, deleted or
# written through a link. Arguments: message prefix, path, name to show.
refuse_unless_plain_folder() {
  local prefix="$1" path="$2" name="$3"
  if [[ -L "${path}" ]]; then
    echo "${prefix}${name} is a symbolic link; refusing to build through it. Nothing was built or changed." >&2
    exit 1
  fi
  if [[ -e "${path}" ]] && { [[ ! -d "${path}" ]] || [[ "$(stat -f %u "${path}")" != "$(id -u)" ]]; }; then
    echo "${prefix}${name} is not a plain folder of yours; refusing to build. Nothing was built or changed." >&2
    exit 1
  fi
}

# Checks where the app is assembled, before anything is built and again right
# before the old app is deleted: dist and the app folders it replaces.
output_preflight() {
  local name
  refuse_unless_plain_folder "" "${ROOT_DIR}/dist" "dist"
  for name in "${APP_NAME}.app" "Convo Cursor.app" "Voice Cursor.app"; do
    refuse_unless_plain_folder "" "${ROOT_DIR}/dist/${name}" "dist/${name}"
  done
}

# Checks the Desk source before anything is built, and again right before the
# Desk build. apps/desk and an old apps/desk/native-dist must be plain folders
# of this user's, never links: the build is never pointed through a link.
desk_preflight() {
  refuse_unless_plain_folder "Desk: " "${DESK_DIR}" "apps/desk"
  refuse_unless_plain_folder "Desk: " "${DESK_DIR}/native-dist" "apps/desk/native-dist"
  if [[ ! -d "${DESK_DIR}" ]]; then
    echo "Desk: apps/desk is missing; nothing to build." >&2
    exit 1
  fi
  if [[ -n "$(git -C "${DESK_DIR}" status --porcelain --untracked-files=all -- .)" ]]; then
    echo "Desk: apps/desk has local changes; refusing to bundle them. Save or set them aside first." >&2
    exit 1
  fi
  if [[ ! -d "${DESK_DIR}/node_modules" ]]; then
    echo "Desk: apps/desk/node_modules is missing. This script never fetches; installing it needs the network and Patrick's OK." >&2
    exit 1
  fi
}

output_preflight
if [[ "${WITH_DESK}" == "1" ]]; then
  desk_preflight
fi

if [[ "${SIGN_IDENTITY}" != "-" ]]; then
  if [[ ! "${SIGN_IDENTITY}" =~ ^[0-9A-Fa-f]{40}$ ]]; then
    echo "TRUE_CONVO_SIGN_IDENTITY must be a 40-character SHA-1 fingerprint." >&2
    exit 2
  fi
  if ! security find-identity -v -p codesigning 2>/dev/null | grep -i "${SIGN_IDENTITY}" | grep -q '"Developer ID Application:'; then
    echo "No valid Developer ID Application certificate with fingerprint ${SIGN_IDENTITY} on this Mac." >&2
    exit 2
  fi
fi

echo "Building release binary (low priority, 2 jobs)..."
nice -n 10 swift build -c release -j 2 --package-path "${ROOT_DIR}"

echo "Generating app icon..."
swift "${ROOT_DIR}/scripts/generate_app_icon.swift" "${ICONSET_DIR}" "${TRUE_CONVO_ICON_SRC}" >/dev/null
iconutil -c icns "${ICONSET_DIR}" -o "${ICON_SRC}"

echo "Assembling ${APP_DIR}..."
output_preflight
rm -rf "${APP_DIR}" "${ROOT_DIR}/dist/Convo Cursor.app" "${ROOT_DIR}/dist/Voice Cursor.app"
mkdir -p "${MACOS_DIR}" "${RESOURCES_DIR}"
cp "${BINARY_SRC}" "${MACOS_DIR}/${EXECUTABLE_NAME}"
cp "${INFO_PLIST}" "${CONTENTS_DIR}/Info.plist"
cp "${ICON_SRC}" "${RESOURCES_DIR}/AppIcon.icns"
cp "${TRUE_CONVO_ICON_SRC}" "${RESOURCES_DIR}/TrueConvoIcon.png"
chmod 755 "${MACOS_DIR}/${EXECUTABLE_NAME}"
plutil -lint "${CONTENTS_DIR}/Info.plist"

if [[ "${WITH_DESK}" == "1" ]]; then
  echo "Desk: building the invented-data Desk from apps/desk (offline)..."
  desk_preflight
  # A fresh private folder of this run's own, named explicitly to the build,
  # so the build never empties or writes into apps/desk/native-dist.
  DESK_TMP_ROOT="${TMPDIR:-/tmp}"
  DESK_BUILD_OUT="$(mktemp -d "${DESK_TMP_ROOT%/}/true-convo-desk-build.XXXXXXXX")"
  trap 'rm -rf "${DESK_BUILD_OUT}"' EXIT
  chmod 700 "${DESK_BUILD_OUT}"
  (cd "${DESK_DIR}" && npm_config_offline=true npm run build:native-proof -- --outDir "${DESK_BUILD_OUT}")
  # The output folder itself (-mindepth 0) as well as everything in it.
  if [[ -L "${DESK_BUILD_OUT}" || ! -d "${DESK_BUILD_OUT}" || "$(stat -f %u "${DESK_BUILD_OUT}")" != "$(id -u)" ]] \
    || [[ -n "$(find "${DESK_BUILD_OUT}" -mindepth 0 \( -type l -o -name '.*' \) -print)" ]]; then
    echo "Desk: the build output is or holds a symbolic link or hidden file; refusing to bundle it." >&2
    exit 1
  fi
  ditto --norsrc --noextattr --noqtn "${DESK_BUILD_OUT}" "${RESOURCES_DIR}/Desk"
  "${DESK_MANIFEST_TOOL}" write "${RESOURCES_DIR}/Desk" "${RESOURCES_DIR}/desk-manifest.json"
  "${DESK_MANIFEST_TOOL}" --verify "${RESOURCES_DIR}/Desk" "${RESOURCES_DIR}/desk-manifest.json"
  DESK_COMMIT="$(git -C "${DESK_DIR}" rev-parse HEAD)"
  /usr/libexec/PlistBuddy -c "Add :TCDeskSourceCommit string ${DESK_COMMIT}" "${CONTENTS_DIR}/Info.plist"
  plutil -lint "${CONTENTS_DIR}/Info.plist"
  echo "Desk: included (source commit ${DESK_COMMIT})"
else
  echo "Desk: not included"
fi

if [[ "${SIGN_IDENTITY}" == "-" ]]; then
  echo "Signing ad-hoc (this Mac only)..."
else
  echo "Signing for this Mac with Developer ID certificate ${SIGN_IDENTITY:0:8}..."
fi
codesign --force --deep --timestamp=none --sign "${SIGN_IDENTITY}" "${APP_DIR}"
codesign --verify --deep --strict "${APP_DIR}"
if [[ "${WITH_DESK}" == "1" ]]; then
  "${DESK_MANIFEST_TOOL}" --verify "${RESOURCES_DIR}/Desk" "${RESOURCES_DIR}/desk-manifest.json"
fi
echo "Packaged ${APP_DIR}"

if [[ "${INSTALL}" -eq 0 ]]; then
  exit 0
fi

# --install: quit the running copy, back up any installed copy, install this one.
# If any install step fails, only what this run changed is undone: the new copy
# is removed only if this run started creating it, and only apps this run
# actually moved into the backup folder are moved back. An installed app that
# was never moved is never touched.
BACKUP_DIR="${ROOT_DIR}/dist/install-backups/$(date +%Y%m%d-%H%M%S)"
[[ -d "${APP_DIR}" ]] || { echo "No packaged app at ${APP_DIR}; nothing installed." >&2; exit 1; }

MOVED_TO_BACKUP=()   # names of apps this run moved into BACKUP_DIR
MOVING_NOW=""        # the app being moved right now, if a move is in progress
CREATED_NEW_COPY=0   # 1 once this run starts copying the new app into INSTALL_DIR

restore_after_failed_install() {
  local status=$?
  trap - ERR
  set +e
  echo "Install failed; undoing only what this run changed..." >&2
  if [[ "${CREATED_NEW_COPY}" -eq 1 ]]; then
    rm -rf "${INSTALL_DIR}/${APP_NAME}.app"
    echo "Removed the new copy at ${INSTALL_DIR}/${APP_NAME}.app." >&2
  fi
  if [[ -n "${MOVING_NOW}" && -e "${BACKUP_DIR}/${MOVING_NOW}" ]]; then
    echo "Moving ${MOVING_NOW} failed partway. Nothing was deleted; check ${INSTALL_DIR}/${MOVING_NOW} and the partial copy at ${BACKUP_DIR}/${MOVING_NOW}." >&2
  fi
  local name
  for name in "${MOVED_TO_BACKUP[@]+"${MOVED_TO_BACKUP[@]}"}"; do
    if [[ -e "${INSTALL_DIR}/${name}" ]]; then
      if [[ -e "${BACKUP_DIR}/${name}" ]]; then
        echo "Did not move ${name} back: something is already at ${INSTALL_DIR}/${name}. The backup is kept at ${BACKUP_DIR}/${name}." >&2
      else
        echo "Left ${INSTALL_DIR}/${name} where it is." >&2
      fi
    elif mv "${BACKUP_DIR}/${name}" "${INSTALL_DIR}/${name}"; then
      echo "Restored ${INSTALL_DIR}/${name}. Open it to keep dictating." >&2
    else
      echo "Could not move ${name} back. It is safe at ${BACKUP_DIR}/${name}." >&2
    fi
  done
  exit "${status}"
}
running_pids() { pgrep -x "VoiceCursorMac" || true; pgrep -x "${EXECUTABLE_NAME}" || true; }

if [[ -n "$(running_pids)" ]]; then
  echo "Quitting the running dictation app..."
  pkill -TERM -x "VoiceCursorMac" || true
  pkill -TERM -x "${EXECUTABLE_NAME}" || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [[ -z "$(running_pids)" ]] && break
    sleep 1
  done
  if [[ -n "$(running_pids)" ]]; then
    echo "The running app did not quit. Quit it from its menu, then run this again." >&2
    exit 1
  fi
fi

mkdir -p "${INSTALL_DIR}"
trap restore_after_failed_install ERR
for old in "Convo Cursor.app" "Voice Cursor.app" "${APP_NAME}.app"; do
  if [[ -e "${INSTALL_DIR}/${old}" ]]; then
    mkdir -p "${BACKUP_DIR}"
    MOVING_NOW="${old}"
    mv "${INSTALL_DIR}/${old}" "${BACKUP_DIR}/${old}"
    MOVED_TO_BACKUP+=("${old}")
    MOVING_NOW=""
    echo "Backed up ${INSTALL_DIR}/${old} to ${BACKUP_DIR}/"
  fi
done

if [[ -e "${INSTALL_DIR}/${APP_NAME}.app" ]]; then
  echo "${INSTALL_DIR}/${APP_NAME}.app is still there after the backup step; refusing to copy over it." >&2
  false
fi
CREATED_NEW_COPY=1
ditto "${APP_DIR}" "${INSTALL_DIR}/${APP_NAME}.app"
codesign --verify --deep --strict "${INSTALL_DIR}/${APP_NAME}.app"
open "${INSTALL_DIR}/${APP_NAME}.app"
trap - ERR
echo "Installed and opened ${INSTALL_DIR}/${APP_NAME}.app (bundle id ${BUNDLE_ID})."
if [[ -d "${BACKUP_DIR}" ]]; then
  echo "To go back: quit True Convo, then move the app in ${BACKUP_DIR} back to ${INSTALL_DIR} and open it."
fi
