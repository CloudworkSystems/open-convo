#!/usr/bin/env bash
# Build and assemble "True Convo.app" in dist/.
#
#   scripts/package_app.sh                  build dist/True Convo.app (ad-hoc signed)
#   scripts/package_app.sh --install        also swap it into ~/Applications
#   scripts/package_app.sh --test-identity  build dist/True Convo Test.app instead
#
# Test copy (--test-identity): "True Convo Test.app", bundle id
# com.trueconvo.voice-cursor.test, program "True Convo Test", Services entry
# "Correct With True Convo Test" on port "True Convo Test". The app reads that
# bundle id and keeps its own settings, Keychain items, archive
# (~/.tca-dictate-test) and Desk folder, so it can sit next to the real app in
# the same macOS account. Only the copied Info.plist in dist is changed, never
# Packaging/Info.plist, and the names are read back before signing. It is
# always ad-hoc signed and never installed, quit or opened by this script: it
# refuses --install and TRUE_CONVO_SIGN_IDENTITY, and it deletes and replaces
# only dist/True Convo Test.app. If it stops for any reason after it starts
# making that app and before signing it, it removes the half-made app (and
# nothing else). Without the option, nothing here changes.
#
# The test copy also carries the participant supervisor helper, still
# inactive (contract section 11): it is built in its own scratch folder,
# .build/test-identity (git-ignored), separate from the release build's
# .build/release; it refuses unless the whole checkout is clean (git status
# --porcelain --untracked-files=all, whatever git's own settings say, and no
# tracked file marked assume-unchanged or skip-worktree; ignored files are
# excluded) and records that commit as TCSourceCommit in the copied
# Info.plist; it copies ParticipantSupervisor into Contents/MacOS (0755); the
# bundle may hold no other program file (Mach-O) and no link; it signs the
# helper ad hoc with the identifier
# com.trueconvo.voice-cursor.test.participant-supervisor, then the app
# without --deep (which would re-sign the helper and drop that identifier),
# and checks both signatures and both identifiers (a failing codesign -dv
# read-back counts as a failed check). If signing or a check fails, the
# signed app is removed too.
#
# Desk window (invented data): set TRUE_CONVO_WITH_DESK=1 to bundle the Desk,
# built offline from this checkout's clean apps/desk (it refuses local
# changes, untracked files or a missing node_modules, and never fetches
# anything). The build writes only into a fresh private temporary folder made
# by this script; apps/desk or an old apps/desk/native-dist that is a symbolic
# link, or not a plain folder of this user's, is refused before anything is
# built. Without it the app has no Desk and its menu item says so. To try it
# next to the real app, add --test-identity.
#
# Desk install (step 1, PR 4; the owner approved replacing today's True Convo
# with the Desk build on October 12): a Desk build may be installed with
# --install or signed with TRUE_CONVO_SIGN_IDENTITY. Such a build must come
# from a reviewed commit: the whole checkout must be clean (the same check as
# the test copy) before anything is built and again right before signing, at
# the same commit, which the app records as TCSourceCommit. Otherwise it
# refuses and nothing is signed or installed. Running it is the owner's call
# each time; this script never runs on its own.
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
# The test copy's names. They must match AppIdentity.test in
# Sources/TrueConvoIdentity (a unit test checks these lines).
TEST_APP_NAME="True Convo Test"
TEST_EXECUTABLE_NAME="True Convo Test"
TEST_BUNDLE_ID="com.trueconvo.voice-cursor.test"
TEST_SERVICES_MENU_ITEM="Correct With True Convo Test"
TEST_SERVICES_PORT_NAME="True Convo Test"
# The test copy's own build folder (inside the git-ignored .build) and its
# participant supervisor helper.
TEST_BUILD_DIR="${ROOT_DIR}/.build/test-identity"
SUPERVISOR_NAME="ParticipantSupervisor"
TEST_SUPERVISOR_IDENTIFIER="com.trueconvo.voice-cursor.test.participant-supervisor"
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
TEST_IDENTITY=0
for arg in "$@"; do
  case "${arg}" in
    --install) INSTALL=1 ;;
    --test-identity) TEST_IDENTITY=1 ;;
    *) echo "Unknown option: ${arg}" >&2; exit 2 ;;
  esac
done

if [[ "${TEST_IDENTITY}" -eq 1 ]]; then
  if [[ "${INSTALL}" -eq 1 ]]; then
    echo "Test copy: --test-identity never installs. This script would quit and move apps in ~/Applications; it never does that for the test copy. Nothing was built or changed." >&2
    exit 2
  fi
  if [[ "${SIGN_IDENTITY}" != "-" ]]; then
    echo "Test copy: --test-identity is always ad-hoc signed; run it without TRUE_CONVO_SIGN_IDENTITY. Nothing was built or changed." >&2
    exit 2
  fi
  APP_NAME="${TEST_APP_NAME}"
  EXECUTABLE_NAME="${TEST_EXECUTABLE_NAME}"
  BUNDLE_ID="${TEST_BUNDLE_ID}"
  APP_DIR="${ROOT_DIR}/dist/${APP_NAME}.app"
  CONTENTS_DIR="${APP_DIR}/Contents"
  MACOS_DIR="${CONTENTS_DIR}/MacOS"
  RESOURCES_DIR="${CONTENTS_DIR}/Resources"
  BINARY_SRC="${TEST_BUILD_DIR}/release/VoiceCursorMac"
  DESK_MANIFEST_TOOL="${TEST_BUILD_DIR}/release/DeskBundleManifest"
  SUPERVISOR_SRC="${TEST_BUILD_DIR}/release/${SUPERVISOR_NAME}"
fi

# A Desk build that leaves dist: installed, or signed with a Developer ID.
DESK_INSTALL=0
if [[ "${WITH_DESK}" == "1" && "${TEST_IDENTITY}" -eq 0 ]] && [[ "${INSTALL}" -eq 1 || "${SIGN_IDENTITY}" != "-" ]]; then
  DESK_INSTALL=1
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
# before the old app is deleted: dist and the app folders it replaces. The
# test copy replaces only dist/True Convo Test.app.
output_preflight() {
  local name
  refuse_unless_plain_folder "" "${ROOT_DIR}/dist" "dist"
  if [[ "${TEST_IDENTITY}" -eq 1 ]]; then
    refuse_unless_plain_folder "" "${APP_DIR}" "dist/${APP_NAME}.app"
    return
  fi
  for name in "${APP_NAME}.app" "Convo Cursor.app" "Voice Cursor.app"; do
    refuse_unless_plain_folder "" "${ROOT_DIR}/dist/${name}" "dist/${name}"
  done
}

# Test copy only: gives the copied Info.plist the test copy's names. The
# permission prompts name "True Convo Test" too, so they can be told apart.
apply_test_identity_plist() {
  local plist="$1" key value
  plutil -replace CFBundleIdentifier -string "${TEST_BUNDLE_ID}" "${plist}"
  plutil -replace CFBundleName -string "${TEST_APP_NAME}" "${plist}"
  plutil -replace CFBundleDisplayName -string "${TEST_APP_NAME}" "${plist}"
  plutil -replace CFBundleExecutable -string "${TEST_EXECUTABLE_NAME}" "${plist}"
  plutil -replace NSServices.0.NSMenuItem.default -string "${TEST_SERVICES_MENU_ITEM}" "${plist}"
  plutil -replace NSServices.0.NSPortName -string "${TEST_SERVICES_PORT_NAME}" "${plist}"
  for key in NSMicrophoneUsageDescription NSSpeechRecognitionUsageDescription NSCalendarsFullAccessUsageDescription NSCalendarsUsageDescription; do
    if ! value="$(plutil -extract "${key}" raw -o - "${plist}" 2>/dev/null)"; then
      rm -rf "${APP_DIR}"
      echo "Test copy: ${key} is missing from Info.plist. Removed dist/${APP_NAME}.app; nothing was signed." >&2
      exit 1
    fi
    plutil -replace "${key}" -string "${value/#True Convo /${TEST_APP_NAME} }" "${plist}"
  done
  plutil -insert TCSourceCommit -string "${SOURCE_COMMIT}" "${plist}"
}

# Test copy only: reads every name back, and checks that every permission
# prompt starts with "True Convo Test ". A test-named app carrying the real
# bundle id would share the real app's settings, keys and archive, so any
# mismatch removes dist/True Convo Test.app and stops (exit 1).
verify_test_identity_plist() {
  local plist="$1" pair key expected actual
  for key in NSMicrophoneUsageDescription NSSpeechRecognitionUsageDescription NSCalendarsFullAccessUsageDescription NSCalendarsUsageDescription; do
    actual="$(plutil -extract "${key}" raw -o - "${plist}" 2>/dev/null || true)"
    if [[ "${actual}" != "${TEST_APP_NAME} "* ]]; then
      rm -rf "${APP_DIR}"
      echo "Test copy: ${key} does not start with \"${TEST_APP_NAME} \". Removed dist/${APP_NAME}.app; nothing was signed." >&2
      exit 1
    fi
  done
  for pair in \
    "CFBundleIdentifier=${TEST_BUNDLE_ID}" \
    "CFBundleName=${TEST_APP_NAME}" \
    "CFBundleDisplayName=${TEST_APP_NAME}" \
    "CFBundleExecutable=${TEST_EXECUTABLE_NAME}" \
    "NSServices.0.NSMenuItem.default=${TEST_SERVICES_MENU_ITEM}" \
    "NSServices.0.NSPortName=${TEST_SERVICES_PORT_NAME}" \
    "TCSourceCommit=${SOURCE_COMMIT}"; do
    key="${pair%%=*}"
    expected="${pair#*=}"
    actual="$(plutil -extract "${key}" raw -o - "${plist}" 2>/dev/null || true)"
    if [[ "${actual}" != "${expected}" ]]; then
      rm -rf "${APP_DIR}"
      echo "Test copy: ${key} reads \"${actual}\", not \"${expected}\". Removed dist/${APP_NAME}.app; nothing was signed." >&2
      exit 1
    fi
  done
  if [[ ! -x "${MACOS_DIR}/${TEST_EXECUTABLE_NAME}" ]]; then
    rm -rf "${APP_DIR}"
    echo "Test copy: Contents/MacOS/${TEST_EXECUTABLE_NAME} is missing. Removed dist/${APP_NAME}.app; nothing was signed." >&2
    exit 1
  fi
}

# Test copy only: the exit trap from the moment this run starts making
# dist/True Convo Test.app until it is about to be signed. If the script stops
# in between, for any reason (a failing plutil, cp or Desk step), it removes
# that half-made app and nothing else, so no test-named app with the real
# app's Info.plist is left behind. A Desk build's temporary folder, when there
# is one, is removed as before. From signing until every signature and
# identifier check has passed, a failure removes the signed app the same way,
# so no test copy whose helper failed a check is left behind.
TEST_COPY_UNSIGNED=0
TEST_COPY_SIGNING=0
remove_unsigned_test_copy() {
  local status=$?
  if [[ "${status}" -ne 0 ]] && [[ -e "${APP_DIR}" || -L "${APP_DIR}" ]]; then
    if [[ "${TEST_COPY_UNSIGNED}" -eq 1 ]]; then
      rm -rf "${APP_DIR}"
      echo "Test copy: packaging stopped before signing (exit ${status}). Removed dist/${APP_NAME}.app; nothing was signed." >&2
    elif [[ "${TEST_COPY_SIGNING}" -eq 1 ]]; then
      rm -rf "${APP_DIR}"
      echo "Test copy: packaging stopped while signing or checking the signatures (exit ${status}). Removed dist/${APP_NAME}.app." >&2
    fi
  fi
}

# The test copy and a Desk install, before anything is built and again right
# before signing: the whole checkout must be clean and still at the same
# commit, so TCSourceCommit names the tracked source that was built. Untracked files are
# always listed (--untracked-files=all overrides a status.showUntrackedFiles
# setting), and a tracked file git is told to treat as unchanged
# (assume-unchanged or skip-worktree, which hide its local changes from git
# status) is refused too. Ignored files, such as .build, dist and
# apps/desk/node_modules, are not checked, so the commit does not cover them.
# Arguments: the message prefix ("Test copy: " or "Desk install: "), then what
# to say after the refusal.
SOURCE_COMMIT=""
test_copy_source_check() { source_check "Test copy: " "$1"; }
source_check() {
  local prefix="$1" after="$2" changes listed hidden commit
  if ! changes="$(git --no-optional-locks -C "${ROOT_DIR}" status --porcelain --untracked-files=all --ignore-submodules=none)" \
    || ! listed="$(git --no-optional-locks -C "${ROOT_DIR}" ls-files -v -- ':/')" \
    || ! commit="$(git --no-optional-locks -C "${ROOT_DIR}" rev-parse --verify HEAD)" || [[ -z "${commit}" ]]; then
    echo "${prefix}could not read this checkout's git status; refusing to package. ${after}" >&2
    exit 1
  fi
  if [[ -n "${changes}" ]]; then
    echo "${prefix}the checkout has local changes or untracked files; refusing to package them. Save or set them aside first. ${after}" >&2
    exit 1
  fi
  # git ls-files -v: a lowercase tag is assume-unchanged, S is skip-worktree.
  hidden="$(printf '%s\n' "${listed}" | grep -E '^([a-z]|S) ' || true)"
  if [[ -n "${hidden}" ]]; then
    echo "${prefix}git is told to treat some tracked files as unchanged (assume-unchanged or skip-worktree), so their local changes would not show; refusing to package. Clear those marks first. ${after}" >&2
    exit 1
  fi
  if [[ -n "${SOURCE_COMMIT}" && "${commit}" != "${SOURCE_COMMIT}" ]]; then
    echo "${prefix}the checkout moved from ${SOURCE_COMMIT} to ${commit} while packaging; refusing. ${after}" >&2
    exit 1
  fi
  SOURCE_COMMIT="${commit}"
}

# Test copy only: copies the release ParticipantSupervisor from the test
# copy's build folder into Contents/MacOS (0755).
copy_test_copy_supervisor() {
  if [[ -L "${SUPERVISOR_SRC}" || ! -f "${SUPERVISOR_SRC}" || ! -x "${SUPERVISOR_SRC}" ]]; then
    rm -rf "${APP_DIR}"
    echo "Test copy: ${SUPERVISOR_NAME} is missing from .build/test-identity/release (or is not a plain program file). Removed dist/${APP_NAME}.app; nothing was signed." >&2
    exit 1
  fi
  cp "${SUPERVISOR_SRC}" "${MACOS_DIR}/${SUPERVISOR_NAME}"
  chmod 755 "${MACOS_DIR}/${SUPERVISOR_NAME}"
}

# Test copy only, right before signing: Contents/MacOS holds exactly the
# program and ParticipantSupervisor, nothing in the bundle is a link, and no
# other file anywhere in it is a program file (Mach-O, by its first four
# bytes). Test-only products (ParticipantFakeCLI, ParticipantTestHost,
# ParticipantPausingSupervisor, ParticipantAvailabilityProbe), the
# DeskBundleManifest packaging tool or any other program are refused.
check_test_copy_programs() {
  local found expected path relative magic
  found="$(cd "${MACOS_DIR}" && ls -A | LC_ALL=C sort | tr '\n' '|')"
  expected="$(printf '%s\n' "${TEST_EXECUTABLE_NAME}" "${SUPERVISOR_NAME}" | LC_ALL=C sort | tr '\n' '|')"
  if [[ "${found}" != "${expected}" ]]; then
    rm -rf "${APP_DIR}"
    echo "Test copy: Contents/MacOS holds \"${found}\", not exactly \"${expected}\". Removed dist/${APP_NAME}.app; nothing was signed." >&2
    exit 1
  fi
  if [[ -n "$(find "${APP_DIR}" -type l -print)" ]]; then
    rm -rf "${APP_DIR}"
    echo "Test copy: the app holds a symbolic link. Removed dist/${APP_NAME}.app; nothing was signed." >&2
    exit 1
  fi
  while IFS= read -r -d '' path; do
    magic="$(head -c 4 "${path}" | od -An -tx1 | tr -d ' \n')"
    case "${magic}" in
      feedface|cefaedfe|feedfacf|cffaedfe|cafebabe|bebafeca|cafebabf|bfbafeca)
        relative="${path#"${APP_DIR}/"}"
        if [[ "${relative}" != "Contents/MacOS/${TEST_EXECUTABLE_NAME}" && "${relative}" != "Contents/MacOS/${SUPERVISOR_NAME}" ]]; then
          rm -rf "${APP_DIR}"
          echo "Test copy: ${relative} is a program file (Mach-O); the test copy may hold only Contents/MacOS/${TEST_EXECUTABLE_NAME} and Contents/MacOS/${SUPERVISOR_NAME}. Removed dist/${APP_NAME}.app; nothing was signed." >&2
          exit 1
        fi
        ;;
    esac
  done < <(find "${APP_DIR}" -type f -print0)
}

# Test copy only: ad hoc signs the helper with its own identifier, then the
# app without --deep (--deep would re-sign the helper and replace that
# identifier), verifies both, and reads both identifiers back. A read-back
# whose codesign -dv fails is refused before its output is read, whatever it
# printed (Codex F2-M1): an Identifier line from a failed display is not
# evidence.
sign_test_copy() {
  local helper="${MACOS_DIR}/${SUPERVISOR_NAME}" pair path expected actual display status
  codesign --force --timestamp=none --sign - --identifier "${TEST_SUPERVISOR_IDENTIFIER}" "${helper}"
  codesign --force --timestamp=none --sign - "${APP_DIR}"
  codesign --verify --strict "${helper}"
  codesign --verify --deep --strict "${APP_DIR}"
  for pair in "${helper}=${TEST_SUPERVISOR_IDENTIFIER}" "${APP_DIR}=${TEST_BUNDLE_ID}"; do
    path="${pair%=*}"
    expected="${pair##*=}"
    status=0
    display="$(codesign -dv "${path}" 2>&1)" || status=$?
    if [[ "${status}" -ne 0 ]]; then
      echo "Test copy: could not read the signature of ${path#"${ROOT_DIR}/"} (codesign -dv exited ${status}); refusing." >&2
      exit 1
    fi
    actual="$(printf '%s\n' "${display}" | sed -n 's/^Identifier=//p')"
    if [[ "${actual}" != "${expected}" ]]; then
      echo "Test copy: ${path#"${ROOT_DIR}/"} is signed with identifier \"${actual}\", not \"${expected}\"." >&2
      exit 1
    fi
  done
  echo "Test copy: ${SUPERVISOR_NAME} signed ad hoc as ${TEST_SUPERVISOR_IDENTIFIER} (bundled, still inactive)."
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
    echo "Desk: apps/desk/node_modules is missing. This script never fetches; installing it needs the network and the owner's OK." >&2
    exit 1
  fi
}

output_preflight
if [[ "${WITH_DESK}" == "1" ]]; then
  desk_preflight
fi
if [[ "${TEST_IDENTITY}" -eq 1 ]]; then
  # The build folder is never a link, so the build never writes elsewhere.
  refuse_unless_plain_folder "Test copy: " "${ROOT_DIR}/.build" ".build"
  refuse_unless_plain_folder "Test copy: " "${TEST_BUILD_DIR}" ".build/test-identity"
  test_copy_source_check "Nothing was built or changed."
fi
if [[ "${DESK_INSTALL}" -eq 1 ]]; then
  source_check "Desk install: " "Nothing was built, signed or installed."
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

if [[ "${TEST_IDENTITY}" -eq 1 ]]; then
  echo "Test copy: building release binaries in .build/test-identity (low priority, 2 jobs)..."
  nice -n 10 swift build -c release -j 2 --package-path "${ROOT_DIR}" --scratch-path "${TEST_BUILD_DIR}"
else
  echo "Building release binary (low priority, 2 jobs)..."
  nice -n 10 swift build -c release -j 2 --package-path "${ROOT_DIR}"
fi

echo "Generating app icon..."
swift "${ROOT_DIR}/scripts/generate_app_icon.swift" "${ICONSET_DIR}" "${TRUE_CONVO_ICON_SRC}" >/dev/null
iconutil -c icns "${ICONSET_DIR}" -o "${ICON_SRC}"

echo "Assembling ${APP_DIR}..."
output_preflight
if [[ "${TEST_IDENTITY}" -eq 1 ]]; then
  rm -rf "${APP_DIR}"
  TEST_COPY_UNSIGNED=1
  trap remove_unsigned_test_copy EXIT
else
  rm -rf "${APP_DIR}" "${ROOT_DIR}/dist/Convo Cursor.app" "${ROOT_DIR}/dist/Voice Cursor.app"
fi
mkdir -p "${MACOS_DIR}" "${RESOURCES_DIR}"
cp "${BINARY_SRC}" "${MACOS_DIR}/${EXECUTABLE_NAME}"
cp "${INFO_PLIST}" "${CONTENTS_DIR}/Info.plist"
cp "${ICON_SRC}" "${RESOURCES_DIR}/AppIcon.icns"
cp "${TRUE_CONVO_ICON_SRC}" "${RESOURCES_DIR}/TrueConvoIcon.png"
chmod 755 "${MACOS_DIR}/${EXECUTABLE_NAME}"
if [[ "${TEST_IDENTITY}" -eq 1 ]]; then
  copy_test_copy_supervisor
  echo "Test copy: setting bundle id ${TEST_BUNDLE_ID} and the name \"${TEST_APP_NAME}\" in the copied Info.plist..."
  apply_test_identity_plist "${CONTENTS_DIR}/Info.plist"
  verify_test_identity_plist "${CONTENTS_DIR}/Info.plist"
fi
plutil -lint "${CONTENTS_DIR}/Info.plist"

if [[ "${WITH_DESK}" == "1" ]]; then
  echo "Desk: building the invented-data Desk from apps/desk (offline)..."
  desk_preflight
  # A fresh private folder of this run's own, named explicitly to the build,
  # so the build never empties or writes into apps/desk/native-dist.
  DESK_TMP_ROOT="${TMPDIR:-/tmp}"
  DESK_BUILD_OUT="$(mktemp -d "${DESK_TMP_ROOT%/}/true-convo-desk-build.XXXXXXXX")"
  trap 'rm -rf "${DESK_BUILD_OUT}"' EXIT
  if [[ "${TEST_IDENTITY}" -eq 1 ]]; then
    trap 'remove_unsigned_test_copy; rm -rf "${DESK_BUILD_OUT}"' EXIT
  fi
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
  if [[ "${DESK_INSTALL}" -eq 1 ]]; then
    /usr/libexec/PlistBuddy -c "Add :TCSourceCommit string ${SOURCE_COMMIT}" "${CONTENTS_DIR}/Info.plist"
    plutil -lint "${CONTENTS_DIR}/Info.plist"
    echo "Desk install: source commit ${SOURCE_COMMIT} (TCSourceCommit)."
  fi
else
  echo "Desk: not included"
fi

if [[ "${SIGN_IDENTITY}" == "-" ]]; then
  echo "Signing ad-hoc (this Mac only)..."
else
  echo "Signing for this Mac with Developer ID certificate ${SIGN_IDENTITY:0:8}..."
fi
if [[ "${TEST_IDENTITY}" -eq 1 ]]; then
  verify_test_identity_plist "${CONTENTS_DIR}/Info.plist"
  check_test_copy_programs
  test_copy_source_check "Nothing was signed."
  TEST_COPY_UNSIGNED=0
  TEST_COPY_SIGNING=1
  sign_test_copy
else
  if [[ "${DESK_INSTALL}" -eq 1 ]]; then
    source_check "Desk install: " "Nothing was signed or installed."
  fi
  codesign --force --deep --timestamp=none --sign "${SIGN_IDENTITY}" "${APP_DIR}"
  codesign --verify --deep --strict "${APP_DIR}"
fi
if [[ "${WITH_DESK}" == "1" ]]; then
  "${DESK_MANIFEST_TOOL}" --verify "${RESOURCES_DIR}/Desk" "${RESOURCES_DIR}/desk-manifest.json"
fi
TEST_COPY_SIGNING=0
echo "Packaged ${APP_DIR}"
if [[ "${TEST_IDENTITY}" -eq 1 ]]; then
  echo "Test copy: source commit ${SOURCE_COMMIT} (TCSourceCommit)."
  echo "Test copy: bundle id ${TEST_BUNDLE_ID}, ad-hoc signed. Not installed, not opened. Copy it to ~/Applications/${APP_NAME}.app to try it next to True Convo."
fi

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
