#!/usr/bin/env bash
# Invented-data checks of how scripts/package_app.sh handles the Desk build
# output (Codex review B1), the dist folder the app is assembled in (review
# F1: a dist link must not send the delete or the build elsewhere), and the
# test copy (--test-identity, "True Convo Test.app"), including its bundled
# participant supervisor helper (F2: the separate .build/test-identity build
# folder, the clean-checkout check, TCSourceCommit, the program-file
# allow-list, and signing the helper with its own identifier before the app,
# never with --deep, refusing a failed identifier read-back, Codex F2-M1).
# Each case runs a copy of the script in its own throwaway
# folder, with stand-ins for swift, npm (which behaves like Vite, emptying
# native-dist through a link when no output folder is named), iconutil,
# codesign (which only logs and models identifiers, never signs), and the
# commands only --install may use (pgrep, pkill, open) and the Keychain lookup
# (security), which only log. It never builds the real app, signs, installs,
# launches or signals anything, uses the network, or touches anything outside
# its temp folder. Every link points at an invented folder inside that temp
# folder. The only real program file used is a copy of /usr/bin/true, which is
# never run.
#
#   scripts/tests/package_app_desk_output_test.sh
#
# SCRIPT_UNDER_TEST may name another copy of package_app.sh (for example an
# older one, to see these cases catch the old behaviour). KEEP=1 keeps the
# temp folder for inspection.
#
# Byte-identity proof: the default (release) runs are also made with the
# script as it was before the test copy existed (BASELINE_REV, read from git,
# or BASELINE_SCRIPT), and the two outputs must match exactly: plain, Desk and
# old-apps builds, --install into an invented Applications folder, and a
# refusal. The Desk-with---install refusal is gone on purpose (step 1, PR 4:
# a Desk build may now be installed from a clean checkout), so it is checked
# on its own below (case 32), not compared. Move BASELINE_REV forward only
# when a change to the default output is intended.
set -euo pipefail
export LC_ALL=C

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_UNDER_TEST="${SCRIPT_UNDER_TEST:-${HERE}/../package_app.sh}"
INFO_PLIST_SRC="${HERE}/../../Packaging/Info.plist"
BASELINE_REV="${BASELINE_REV:-eb073b6}"
INFO_PLIST_SRC_BEFORE="$(shasum -a 256 "${INFO_PLIST_SRC}")"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/package-app-desk-test.XXXXXXXX")"
# The script sees its folder by its real path (/private/var/..., not the
# /var/... link macOS puts in TMPDIR), so the expected paths use it too.
WORK="$(cd "${WORK}" && pwd -P)"
if [[ "${KEEP:-0}" == "1" ]]; then
  echo "Keeping ${WORK}"
else
  trap 'rm -rf "${WORK}"' EXIT
fi
FAILURES=0

ok() { echo "ok - $1"; }
not_ok() { echo "not ok - $1" >&2; FAILURES=$((FAILURES + 1)); }
check() {
  local description="$1"
  shift
  if "$@"; then ok "${description}"; else not_ok "${description}"; fi
}

# --- stand-ins -------------------------------------------------------------
BIN="${WORK}/bin"
mkdir -p "${BIN}"
# STUB_SWIFT_FAIL=1 makes the build fail (exit 75), before any app is made.
# During `swift build` only: STUB_SWIFT_DIRTY names a file the build creates
# (an untracked file appearing while packaging), and STUB_SWIFT_COMMIT names a
# checkout that gets a new invented commit (the checkout moving).
cat > "${BIN}/swift" <<'STUB'
#!/bin/bash
echo "swift $*" >> "${STUB_LOG}"
[[ -z "${STUB_SWIFT_FAIL:-}" ]] || exit 75
if [[ "$1" == "build" ]]; then
  [[ -z "${STUB_SWIFT_DIRTY:-}" ]] || printf 'invented change during the build\n' > "${STUB_SWIFT_DIRTY}"
  if [[ -n "${STUB_SWIFT_COMMIT:-}" ]]; then
    git -C "${STUB_SWIFT_COMMIT}" -c user.name=Invented -c user.email=invented@example.invalid commit -q --allow-empty -m "invented move"
  fi
fi
exit 0
STUB
# Logs every call and never signs. It models only what package_app.sh relies
# on, as the real codesign behaved in a throwaway ad hoc probe with the real
# linker-signed ParticipantSupervisor (Identifier=ParticipantSupervisor,
# flags adhoc,linker-signed): signing records an identifier per path
# (--identifier, else an app's CFBundleIdentifier, else the file name); a
# stand-in build product (a file holding the words "invented linker-signed")
# counts as linker-signed, with its file name as its identifier, until it is
# signed; signing an app with --deep re-signs every other file in its
# Contents/MacOS with that file's default identifier (its name); signing an
# app without --deep accepts a linker-signed file there unchanged, but fails
# ("code object is not signed at all") when another file there is not signed
# at all; -dv prints the identifier on stderr. STUB_CODESIGN_FAIL makes every
# call whose arguments start with those words fail. STUB_CODESIGN_DISPLAY_EXIT
# makes -dv print its usual lines, the right identifier included, and then
# exit with that status (Codex F2-M1); with STUB_CODESIGN_DISPLAY_ONLY set to
# a path, only the -dv of that path does, and every other -dv exits 0. Each
# -dv also notes the identifier it printed and its exit status in
# codesign-display.
cat > "${BIN}/codesign" <<'STUB'
#!/bin/bash
echo "codesign $*" >> "${STUB_LOG}"
state="$(dirname "${STUB_LOG}")/codesign-state"
if [[ -n "${STUB_CODESIGN_FAIL:-}" && "$*" == "${STUB_CODESIGN_FAIL}"* ]]; then
  echo "invented codesign failure" >&2
  exit 1
fi
sign=0; deep=0; display=0; identifier=""; previous=""
for argument in "$@"; do
  case "${argument}" in
    --sign) sign=1 ;;
    --deep) deep=1 ;;
    -dv) display=1 ;;
  esac
  [[ "${previous}" == "--identifier" ]] && identifier="${argument}"
  previous="${argument}"
done
target="${!#}"
recorded() { [[ -f "${state}" ]] && awk -F '\t' -v p="$1" '$1 == p { id = $2 } END { if (id != "") print id }' "${state}"; }
record() { printf '%s\t%s\n' "$1" "$2" >> "${state}"; }
# The identifier a path carries: the recorded one, else the linker's (its name).
current() {
  local id
  id="$(recorded "$1")"
  if [[ -z "${id}" && -f "$1" ]] && grep -qF 'invented linker-signed' "$1"; then id="$(basename "$1")"; fi
  printf '%s' "${id}"
}
if [[ "${sign}" -eq 1 ]]; then
  if [[ -d "${target}" ]]; then
    main="$(/usr/bin/plutil -extract CFBundleExecutable raw -o - "${target}/Contents/Info.plist" 2>/dev/null)"
    for nested in "${target}/Contents/MacOS/"*; do
      [[ -f "${nested}" && "$(basename "${nested}")" != "${main}" ]] || continue
      if [[ "${deep}" -eq 1 ]]; then
        record "${nested}" "$(basename "${nested}")"
      elif [[ -z "$(current "${nested}")" ]]; then
        echo "${target}: code object is not signed at all" >&2
        echo "In subcomponent: ${nested}" >&2
        exit 1
      fi
    done
    [[ -n "${identifier}" ]] || identifier="$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "${target}/Contents/Info.plist" 2>/dev/null)"
  fi
  record "${target}" "${identifier:-$(basename "${target}")}"
  exit 0
fi
if [[ "${display}" -eq 1 ]]; then
  identifier="$(current "${target}")"
  if [[ -z "${identifier}" ]]; then
    echo "${target}: code object is not signed at all" >&2
    exit 1
  fi
  printf 'Executable=%s\nIdentifier=%s\nFormat=invented\nSignature=adhoc\n' "${target}" "${identifier}" >&2
  status="${STUB_CODESIGN_DISPLAY_EXIT:-0}"
  [[ -z "${STUB_CODESIGN_DISPLAY_ONLY:-}" || "${target}" == "${STUB_CODESIGN_DISPLAY_ONLY}" ]] || status=0
  printf '%s\t%s\texit %s\n' "${target}" "${identifier}" "${status}" >> "$(dirname "${STUB_LOG}")/codesign-display"
  exit "${status}"
fi
exit 0
STUB
cat > "${BIN}/iconutil" <<'STUB'
#!/bin/bash
echo "iconutil $*" >> "${STUB_LOG}"
out=""; previous=""
for argument in "$@"; do [[ "${previous}" == "-o" ]] && out="${argument}"; previous="${argument}"; done
printf 'invented icns\n' > "${out}"
STUB
# Only --install uses these; the Keychain lookup is security. Each only logs:
# nothing real is ever looked up, signaled or opened.
for tool in pgrep pkill security open; do
  cat > "${BIN}/${tool}" <<'STUB'
#!/bin/bash
echo "$(basename "$0") $*" >> "${STUB_LOG}"
[[ "$(basename "$0")" == "open" ]]
STUB
done
cat > "${BIN}/ditto" <<'STUB'
#!/bin/bash
echo "ditto $*" >> "${STUB_LOG}"
exec /usr/bin/ditto "$@"
STUB
# The real plutil, except that STUB_PLUTIL_SKIP names a key whose -replace is
# silently skipped (to see the read-back catch it), and STUB_PLUTIL_FAIL makes
# every plutil command starting with those words fail (exit 73), as a broken
# plutil would.
cat > "${BIN}/plutil" <<'STUB'
#!/bin/bash
if [[ -n "${STUB_PLUTIL_SKIP:-}" && "$1" == "-replace" && "$2" == "${STUB_PLUTIL_SKIP}" ]]; then
  echo "plutil skipped $2" >> "${STUB_LOG}"
  exit 0
fi
if [[ -n "${STUB_PLUTIL_FAIL:-}" && "$*" == "${STUB_PLUTIL_FAIL}"* ]]; then
  echo "plutil failed $*" >> "${STUB_LOG}"
  echo "invented plutil failure" >&2
  exit 73
fi
exec /usr/bin/plutil "$@"
STUB
cat > "${BIN}/npm" <<'STUB'
#!/bin/bash
set -eu
echo "npm $*" >> "${STUB_LOG}"
out=""; previous=""
for argument in "$@"; do [[ "${previous}" == "--outDir" ]] && out="${argument}"; previous="${argument}"; done
if [[ -z "${out}" ]]; then
  # Vite's default: empty native-dist (through a link, too) and write there.
  out="native-dist"
  mkdir -p "${out}"
  find "${out}/" -mindepth 1 -delete
fi
mkdir -p "${out}/assets"
printf '<!doctype html><title>invented Desk</title>\n' > "${out}/index.html"
printf 'console.log("invented");\n' > "${out}/assets/app.js"
case "${STUB_NPM_AFTER:-}" in
  link-root) rm -rf "${out}" && ln -s "${STUB_TARGET}" "${out}" ;;
  link-inside) ln -s "${STUB_TARGET}" "${out}/assets/linked" ;;
  # A program file (STUB_MACHO) slipped into the Desk output as STUB_MACHO_NAME.
  macho) cp "${STUB_MACHO}" "${out}/assets/${STUB_MACHO_NAME}" ;;
esac
STUB
chmod 755 "${BIN}"/*

# --- an invented checkout ----------------------------------------------------
# <case>/repo/apps/{true-convo-mac,desk}, a git repository with one commit.
# The ignore rule covers native-dist whether it is a folder, file or link, so
# only package_app.sh's own checks can refuse it. The build products are
# stand-ins in both build folders, .build/release (the release app) and
# .build/test-identity/release (the test copy), each saying which it is. The
# program and the helper count as linker-signed, as SwiftPM's arm64 products
# are (see the codesign stand-in).
make_case() {
  local dir="${WORK}/$1" mac build
  mac="${dir}/repo/apps/true-convo-mac"
  mkdir -p "${mac}/scripts" "${mac}/Packaging" "${mac}/.build/release" "${mac}/.build/test-identity/release" \
    "${dir}/repo/apps/desk/node_modules" "${dir}/home" "${dir}/tmp"
  cp "${SCRIPT_UNDER_TEST}" "${mac}/scripts/package_app.sh"
  cp "${INFO_PLIST_SRC}" "${mac}/Packaging/Info.plist"
  printf 'invented png\n' > "${mac}/Packaging/TrueConvoIcon.png"
  for build in release test-identity/release; do
    printf '#!/bin/sh\n# invented linker-signed program from .build/%s\nexit 0\n' "${build}" > "${mac}/.build/${build}/VoiceCursorMac"
    cat > "${mac}/.build/${build}/DeskBundleManifest" <<'TOOL'
#!/bin/bash
if [[ "$1" == "write" ]]; then printf '{"invented":true}\n' > "$3"; else [[ -f "$3" && -f "$2/index.html" ]]; fi
TOOL
    chmod 755 "${mac}/.build/${build}/"*
  done
  # Never bundled in a release app; the test copy takes it from its own build.
  printf '#!/bin/sh\n# invented linker-signed supervisor from .build/test-identity/release\nexit 0\n' > "${mac}/.build/test-identity/release/ParticipantSupervisor"
  printf '#!/bin/sh\n# invented linker-signed supervisor from .build/release\nexit 0\n' > "${mac}/.build/release/ParticipantSupervisor"
  chmod 755 "${mac}/.build/release/ParticipantSupervisor" "${mac}/.build/test-identity/release/ParticipantSupervisor"
  printf '{"name":"invented-desk","private":true}\n' > "${dir}/repo/apps/desk/package.json"
  printf 'node_modules\nnative-dist\napps/true-convo-mac/\n' > "${dir}/repo/.gitignore"
  git -C "${dir}/repo" init -q
  git -C "${dir}/repo" add .gitignore apps/desk/package.json
  # A fixed date, so every case's invented commit (recorded by Desk builds)
  # is the same and outputs can be compared byte for byte.
  GIT_AUTHOR_DATE="2026-01-01T00:00:00Z" GIT_COMMITTER_DATE="2026-01-01T00:00:00Z" \
    git -C "${dir}/repo" -c user.name=Invented -c user.email=invented@example.invalid commit -qm "invented"
}

# An invented folder to point links at: a file (0640) and a folder (0750)
# holding another file (0600).
make_target() {
  mkdir -p "$1/inner"
  printf 'INVENTED CANARY\n' > "$1/INVENTED-CANARY.txt"
  printf 'invented inner\n' > "$1/inner/inner.txt"
  chmod 640 "$1/INVENTED-CANARY.txt"
  chmod 600 "$1/inner/inner.txt"
  chmod 750 "$1/inner"
}

# Names, kinds, permissions, owners, sizes and contents, never following links.
tree_state() {
  (cd "$1" && find . -exec stat -f '%N %Sp %u %z' {} \; | sort && find . -type f -exec shasum -a 256 {} \; | sort)
}

# run_package <case> [VAR=value...]: runs the case's script with those
# environment settings and, after them, the options in SCRIPT_ARGS.
SCRIPT_ARGS=()
run_package() {
  local dir="${WORK}/$1"
  shift
  set +e
  (cd "${dir}/repo/apps/true-convo-mac" && env -i PATH="${BIN}:/usr/bin:/bin:/usr/sbin:/sbin" HOME="${dir}/home" \
    TMPDIR="${dir}/tmp" STUB_LOG="${dir}/stub.log" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
    TRUE_CONVO_WITH_DESK=1 "$@" bash scripts/package_app.sh ${SCRIPT_ARGS[@]+"${SCRIPT_ARGS[@]}"}) > "${dir}/output.txt" 2>&1
  STATUS=$?
  set -e
  touch "${dir}/stub.log"
}

said() { grep -qF "$2" "${WORK}/$1/output.txt"; }
npm_ran() { grep -q '^npm ' "${WORK}/$1/stub.log"; }
swift_ran() { grep -q '^swift ' "${WORK}/$1/stub.log"; }
no_desk_bundled() { [[ ! -e "${WORK}/$1/repo/apps/true-convo-mac/dist/True Convo.app/Contents/Resources/Desk" ]]; }
ran() { grep -q "^$2 " "${WORK}/$1/stub.log"; }
# Names, kinds and modes only (no owner, size or contents), never following links.
layout() { (cd "$1" && find . -exec stat -f '%N %HT %Sp' {} \; | sort); }

# An invented stand-in for an apps folder: old app bundles, each with a
# canary, and an unrelated file.
make_apps_target() {
  local app
  mkdir -p "$1"
  for app in "True Convo.app" "Convo Cursor.app" "Voice Cursor.app"; do
    mkdir -p "$1/${app}/Contents"
    printf 'INVENTED CANARY %s\n' "${app}" > "$1/${app}/Contents/CANARY.txt"
  done
  printf 'INVENTED UNRELATED CANARY\n' > "$1/Unrelated-CANARY.txt"
  chmod 640 "$1/Unrelated-CANARY.txt"
}

# 1. native-dist is a link to an invented folder: refused before anything is
#    built (no swift, no npm), and the folder keeps its bytes and modes.
make_case linked-output
TARGET="${WORK}/linked-output/target"
make_target "${TARGET}"
ln -s "${TARGET}" "${WORK}/linked-output/repo/apps/desk/native-dist"
BEFORE="$(tree_state "${TARGET}")"
run_package linked-output
check "linked native-dist: refused (exit 1)" [ "${STATUS}" -eq 1 ]
check "linked native-dist: plain message" said linked-output "Desk: apps/desk/native-dist is a symbolic link; refusing to build through it. Nothing was built or changed."
check "linked native-dist: the build never ran" eval '! npm_ran linked-output'
check "linked native-dist: refused before the app build too" eval '! swift_ran linked-output'
check "linked native-dist: the target's bytes and modes are unchanged" [ "$(tree_state "${TARGET}")" == "${BEFORE}" ]
check "linked native-dist: the link itself is left alone" [ "$(readlink "${WORK}/linked-output/repo/apps/desk/native-dist")" == "${TARGET}" ]

# 2. apps/desk itself is a link.
make_case linked-desk
mv "${WORK}/linked-desk/repo/apps/desk" "${WORK}/linked-desk/repo/apps/desk-elsewhere"
ln -s desk-elsewhere "${WORK}/linked-desk/repo/apps/desk"
run_package linked-desk
check "linked apps/desk: refused (exit 1)" [ "${STATUS}" -eq 1 ]
check "linked apps/desk: plain message" said linked-desk "Desk: apps/desk is a symbolic link; refusing to build through it."
check "linked apps/desk: the build never ran" eval '! npm_ran linked-desk'

# 3. native-dist is a plain file.
make_case file-output
printf 'invented file\n' > "${WORK}/file-output/repo/apps/desk/native-dist"
chmod 640 "${WORK}/file-output/repo/apps/desk/native-dist"
BEFORE="$(tree_state "${WORK}/file-output/repo/apps/desk")"
run_package file-output
check "file native-dist: refused (exit 1)" [ "${STATUS}" -eq 1 ]
check "file native-dist: plain message" said file-output "Desk: apps/desk/native-dist is not a plain folder of yours; refusing to build."
check "file native-dist: the build never ran" eval '! npm_ran file-output'
check "file native-dist: unchanged" [ "$(tree_state "${WORK}/file-output/repo/apps/desk")" == "${BEFORE}" ]

# 4. The normal path, with an old real native-dist: packages from a fresh
#    private temp folder, never touches native-dist, and cleans up.
make_case normal
mkdir -p "${WORK}/normal/repo/apps/desk/native-dist/assets"
printf 'old invented build\n' > "${WORK}/normal/repo/apps/desk/native-dist/index.html"
BEFORE="$(tree_state "${WORK}/normal/repo/apps/desk/native-dist")"
run_package normal
RESOURCES="${WORK}/normal/repo/apps/true-convo-mac/dist/True Convo.app/Contents/Resources"
OUT_DIR="$(sed -n 's/^npm run build:native-proof -- --outDir //p' "${WORK}/normal/stub.log")"
check "normal: packaged (exit 0)" [ "${STATUS}" -eq 0 ]
check "normal: says it packaged" said normal "Packaged "
check "normal: the build was given its own output folder in the temp folder" [ "${OUT_DIR#"${WORK}/normal/tmp/true-convo-desk-build."}" != "${OUT_DIR}" ]
check "normal: the Desk was bundled from that build" grep -qF 'invented Desk' "${RESOURCES}/Desk/index.html"
check "normal: its asset too" [ -f "${RESOURCES}/Desk/assets/app.js" ]
check "normal: manifest written" [ -f "${RESOURCES}/desk-manifest.json" ]
check "normal: the source commit is recorded" [ "$(/usr/libexec/PlistBuddy -c 'Print :TCDeskSourceCommit' "${RESOURCES}/../Info.plist")" == "$(git -C "${WORK}/normal/repo" rev-parse HEAD)" ]
check "normal: the old native-dist is untouched" [ "$(tree_state "${WORK}/normal/repo/apps/desk/native-dist")" == "${BEFORE}" ]
check "normal: the temporary output folder is removed" eval '[ -n "${OUT_DIR}" ] && [ ! -e "${OUT_DIR}" ]'

# 5. The normal path with no native-dist at all: none is made.
make_case no-output
run_package no-output
check "no native-dist: packaged (exit 0)" [ "${STATUS}" -eq 0 ]
check "no native-dist: none is made" [ ! -e "${WORK}/no-output/repo/apps/desk/native-dist" ]

# 6. The build's output folder itself turns into a link: refused, nothing is
#    copied from the link's target, and the target is unchanged.
make_case output-root-link
TARGET="${WORK}/output-root-link/target"
make_target "${TARGET}"
BEFORE="$(tree_state "${TARGET}")"
run_package output-root-link STUB_NPM_AFTER=link-root STUB_TARGET="${TARGET}"
check "output folder became a link: refused (exit 1)" [ "${STATUS}" -eq 1 ]
check "output folder became a link: plain message" said output-root-link "Desk: the build output is or holds a symbolic link or hidden file; refusing to bundle it."
check "output folder became a link: nothing bundled" no_desk_bundled output-root-link
check "output folder became a link: the target is unchanged" [ "$(tree_state "${TARGET}")" == "${BEFORE}" ]

# 7. A link inside the build output: refused.
make_case output-inner-link
TARGET="${WORK}/output-inner-link/target"
make_target "${TARGET}"
BEFORE="$(tree_state "${TARGET}")"
run_package output-inner-link STUB_NPM_AFTER=link-inside STUB_TARGET="${TARGET}"
check "link inside the output: refused (exit 1)" [ "${STATUS}" -eq 1 ]
check "link inside the output: nothing bundled" no_desk_bundled output-inner-link
check "link inside the output: the target is unchanged" [ "$(tree_state "${TARGET}")" == "${BEFORE}" ]

# 8. dist is a link to an invented apps folder, in a Desk build and a plain
#    build: refused before anything is built, and the folder keeps every app,
#    byte and mode.
for build in desk plain; do
  name="linked-dist-${build}"
  with_desk=1
  [[ "${build}" == "plain" ]] && with_desk=0
  make_case "${name}"
  TARGET="${WORK}/${name}/home/Applications"
  make_apps_target "${TARGET}"
  ln -s "${TARGET}" "${WORK}/${name}/repo/apps/true-convo-mac/dist"
  BEFORE="$(tree_state "${TARGET}")"
  run_package "${name}" TRUE_CONVO_WITH_DESK="${with_desk}"
  check "linked dist (${build} build): refused (exit 1)" [ "${STATUS}" -eq 1 ]
  check "linked dist (${build} build): plain message" said "${name}" "dist is a symbolic link; refusing to build through it. Nothing was built or changed."
  check "linked dist (${build} build): nothing was built" eval "! swift_ran ${name} && ! npm_ran ${name}"
  check "linked dist (${build} build): the linked folder keeps every app, byte and mode" [ "$(tree_state "${TARGET}")" == "${BEFORE}" ]
  check "linked dist (${build} build): the link itself is left alone" [ "$(readlink "${WORK}/${name}/repo/apps/true-convo-mac/dist")" == "${TARGET}" ]
done

# 9. Each app folder the build replaces is a link: refused, the target kept.
for app in "True Convo.app" "Voice Cursor.app" "Convo Cursor.app"; do
  name="linked-app-${app%% *}"
  make_case "${name}"
  TARGET="${WORK}/${name}/home/Applications"
  make_apps_target "${TARGET}"
  mkdir -p "${WORK}/${name}/repo/apps/true-convo-mac/dist"
  ln -s "${TARGET}/${app}" "${WORK}/${name}/repo/apps/true-convo-mac/dist/${app}"
  BEFORE="$(tree_state "${TARGET}")"
  run_package "${name}"
  check "linked dist/${app}: refused (exit 1)" [ "${STATUS}" -eq 1 ]
  check "linked dist/${app}: plain message" said "${name}" "dist/${app} is a symbolic link; refusing to build through it. Nothing was built or changed."
  check "linked dist/${app}: nothing was built" eval "! swift_ran ${name}"
  check "linked dist/${app}: the target is unchanged" [ "$(tree_state "${TARGET}")" == "${BEFORE}" ]
done

# 10. dist is a plain file.
make_case file-dist
printf 'invented file\n' > "${WORK}/file-dist/repo/apps/true-convo-mac/dist"
BEFORE="$(shasum -a 256 "${WORK}/file-dist/repo/apps/true-convo-mac/dist")"
run_package file-dist
check "file dist: refused (exit 1)" [ "${STATUS}" -eq 1 ]
check "file dist: plain message" said file-dist "dist is not a plain folder of yours; refusing to build. Nothing was built or changed."
check "file dist: nothing was built" eval '! swift_ran file-dist'
check "file dist: unchanged" [ "$(shasum -a 256 "${WORK}/file-dist/repo/apps/true-convo-mac/dist")" == "${BEFORE}" ]

# 11. dist is a plain folder holding old apps: they are replaced as before, and
#    an unrelated file there is kept.
make_case plain-dist
DIST="${WORK}/plain-dist/repo/apps/true-convo-mac/dist"
make_apps_target "${DIST}"
run_package plain-dist
check "plain dist: packaged (exit 0)" [ "${STATUS}" -eq 0 ]
check "plain dist: the old True Convo.app was replaced" eval '[ ! -e "${DIST}/True Convo.app/Contents/CANARY.txt" ] && [ -f "${DIST}/True Convo.app/Contents/Resources/Desk/index.html" ]'
check "plain dist: old Voice Cursor.app and Convo Cursor.app removed" eval '[ ! -e "${DIST}/Voice Cursor.app" ] && [ ! -e "${DIST}/Convo Cursor.app" ]'
check "plain dist: the unrelated file is kept" grep -qF 'INVENTED UNRELATED CANARY' "${DIST}/Unrelated-CANARY.txt"

# --- the release (default) output, pinned -----------------------------------

APP_LAYOUT_RELEASE="$(printf '%s\n' \
  ". Directory drwxr-xr-x" \
  "./Contents Directory drwxr-xr-x" \
  "./Contents/Info.plist Regular File -rw-r--r--" \
  "./Contents/MacOS Directory drwxr-xr-x" \
  "./Contents/MacOS/True Convo Regular File -rwxr-xr-x" \
  "./Contents/Resources Directory drwxr-xr-x" \
  "./Contents/Resources/AppIcon.icns Regular File -rw-r--r--" \
  "./Contents/Resources/TrueConvoIcon.png Regular File -rw-r--r--")"

# 12. A plain release build: the packaged Info.plist is a byte copy of
#     Packaging/Info.plist, the file layout is exactly as before, and no test
#     copy is made.
make_case release-plain
RELEASE_MAC="${WORK}/release-plain/repo/apps/true-convo-mac"
TEST_BUILD_BEFORE="$(tree_state "${RELEASE_MAC}/.build/test-identity")"
run_package release-plain TRUE_CONVO_WITH_DESK=0
RELEASE_APP="${RELEASE_MAC}/dist/True Convo.app"
check "release build: packaged (exit 0)" [ "${STATUS}" -eq 0 ]
check "release build: Info.plist is a byte copy of Packaging/Info.plist" cmp -s "${RELEASE_APP}/Contents/Info.plist" "${INFO_PLIST_SRC}"
check "release build: exactly the same files and modes as before" [ "$(layout "${RELEASE_APP}")" == "${APP_LAYOUT_RELEASE}" ]
check "release build: bundle id is the real one" [ "$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "${RELEASE_APP}/Contents/Info.plist")" == "com.trueconvo.voice-cursor" ]
check "release build: no test copy is made" [ ! -e "${WORK}/release-plain/repo/apps/true-convo-mac/dist/True Convo Test.app" ]
check "release build: signed ad hoc, as before" grep -qxF "codesign --force --deep --timestamp=none --sign - ${RELEASE_APP}" "${WORK}/release-plain/stub.log"
check "release build: exactly the two codesign commands as before" \
  [ "$(grep '^codesign ' "${WORK}/release-plain/stub.log")" == "$(printf '%s\n' "codesign --force --deep --timestamp=none --sign - ${RELEASE_APP}" "codesign --verify --deep --strict ${RELEASE_APP}")" ]
check "release build: built in the release .build as before (no --scratch-path)" \
  [ "$(grep '^swift build' "${WORK}/release-plain/stub.log")" == "swift build -c release -j 2 --package-path ${RELEASE_MAC}" ]
check "release build: its program is the one from .build/release" cmp -s "${RELEASE_APP}/Contents/MacOS/True Convo" "${RELEASE_MAC}/.build/release/VoiceCursorMac"
check "release build: no ParticipantSupervisor and no TCSourceCommit" \
  eval '[ ! -e "${RELEASE_APP}/Contents/MacOS/ParticipantSupervisor" ] && ! /usr/bin/plutil -extract TCSourceCommit raw -o - "${RELEASE_APP}/Contents/Info.plist" >/dev/null 2>&1'
check "release build: .build/test-identity is untouched" [ "$(tree_state "${RELEASE_MAC}/.build/test-identity")" == "${TEST_BUILD_BEFORE}" ]
check "release build: no install command ran" eval '! ran release-plain pgrep && ! ran release-plain pkill && ! ran release-plain open && ! ran release-plain security'

# 13. A release Desk build: the source plist plus TCDeskSourceCommit only.
make_case release-desk
run_package release-desk
RELEASE_DESK_PLIST="${WORK}/release-desk/repo/apps/true-convo-mac/dist/True Convo.app/Contents/Info.plist"
# The packaged plist without TCDeskSourceCommit equals the source.
source_plus_commit_only() {
  local copy="${WORK}/release-desk/without-commit.plist"
  cp "$1" "${copy}" 2>/dev/null || return 1
  /usr/bin/plutil -remove TCDeskSourceCommit "${copy}" >/dev/null 2>&1 || return 1
  [ "$(/usr/bin/plutil -convert xml1 -o - "${copy}")" == "$(/usr/bin/plutil -convert xml1 -o - "${INFO_PLIST_SRC}")" ]
}
check "release Desk build: packaged (exit 0)" [ "${STATUS}" -eq 0 ]
check "release Desk build: the source plist plus TCDeskSourceCommit, nothing else" source_plus_commit_only "${RELEASE_DESK_PLIST}"

# 14. Before and after: the default runs give byte-identical results with the
#     script as it was before --test-identity (BASELINE_REV) and with this one.
BASELINE="${WORK}/baseline-package_app.sh"
if [[ -n "${BASELINE_SCRIPT:-}" ]]; then
  cp "${BASELINE_SCRIPT}" "${BASELINE}"
else
  git -C "${HERE}" show "${BASELINE_REV}:apps/true-convo-mac/scripts/package_app.sh" > "${BASELINE}" 2>/dev/null || rm -f "${BASELINE}"
fi
normalized() {
  sed -e "s#${WORK}/$1#<case>#g" -e 's#true-convo-desk-build\.[A-Za-z0-9]\{8\}#true-convo-desk-build.XXXXXXXX#g' "${WORK}/$1/$2"
}
# The install backup folder is named after the time of the run, so that one
# name is replaced by <time> before comparing.
outcome() {
  local mac="${WORK}/$1/repo/apps/true-convo-mac"
  {
    echo "status ${STATUS}"
    echo "--- dist"; [[ -e "${mac}/dist" ]] && tree_state "${mac}/dist"
    echo "--- Packaging"; tree_state "${mac}/Packaging"
    echo "--- home"; tree_state "${WORK}/$1/home"
    echo "--- commands"; normalized "$1" stub.log
    echo "--- output"; normalized "$1" output.txt
  } | sed 's#install-backups/[0-9]\{8\}-[0-9]\{6\}#install-backups/<time>#g'
}
# Variants: plain, Desk and old-apps builds; --install into an invented
# Applications folder holding old apps (with pgrep, pkill and open stand-ins);
# and a signing fingerprint refused because the stand-in Keychain lookup finds
# no certificate.
if [[ ! -s "${BASELINE}" ]]; then
  not_ok "before and after: could not read package_app.sh at ${BASELINE_REV} (set BASELINE_SCRIPT)"
else
  for variant in plain desk old-apps install signing-refused lint-fails desk-link-refused; do
    with_desk=0
    extra=()
    expected_status=0
    case "${variant}" in
      desk) with_desk=1 ;;
      install) SCRIPT_ARGS=(--install) ;;
      signing-refused) extra=(TRUE_CONVO_SIGN_IDENTITY=0123456789abcdef0123456789abcdef01234567); expected_status=2 ;;
      # A release run that fails partway keeps what it made, exactly as before:
      # the test copy's cleanup never runs for the real app's build.
      lint-fails) extra=(STUB_PLUTIL_FAIL=-lint); expected_status=73 ;;
      desk-link-refused) with_desk=1; extra=(STUB_NPM_AFTER=link-inside STUB_TARGET=/invented/nowhere); expected_status=1 ;;
    esac
    for side in before after; do
      make_case "same-${variant}-${side}"
      [[ "${side}" == "before" ]] && cp "${BASELINE}" "${WORK}/same-${variant}-${side}/repo/apps/true-convo-mac/scripts/package_app.sh"
      if [[ "${variant}" == "old-apps" ]]; then
        make_apps_target "${WORK}/same-${variant}-${side}/repo/apps/true-convo-mac/dist"
      fi
      if [[ "${variant}" == "install" ]]; then
        make_apps_target "${WORK}/same-${variant}-${side}/home/Applications"
      fi
      run_package "same-${variant}-${side}" TRUE_CONVO_WITH_DESK="${with_desk}" ${extra[@]+"${extra[@]}"}
      outcome "same-${variant}-${side}" > "${WORK}/same-${variant}-${side}.outcome"
    done
    SCRIPT_ARGS=()
    check "before and after (${variant} release run): exit ${expected_status}" grep -qx "status ${expected_status}" "${WORK}/same-${variant}-after.outcome"
    check "before and after (${variant} release run): identical app, Info.plist, files, commands and messages" \
      cmp -s "${WORK}/same-${variant}-before.outcome" "${WORK}/same-${variant}-after.outcome"
  done
  check "before and after (install release run): it did install, back up and open (so the comparison covers it)" \
    eval 'ran same-install-after open && [ -f "${WORK}/same-install-after/home/Applications/True Convo.app/Contents/Info.plist" ] && grep -qF "install-backups/<time>/True Convo.app/Contents/CANARY.txt" "${WORK}/same-install-after.outcome"'
  check "before and after (signing-refused release run): the stand-in Keychain lookup ran" ran same-signing-refused-after security
  check "before and after (lint-fails release run): plutil -lint did fail, and dist/True Convo.app was left as before" \
    eval 'ran same-lint-fails-after "plutil failed" && [ -d "${WORK}/same-lint-fails-after/repo/apps/true-convo-mac/dist/True Convo.app" ]'
  check "before and after (desk-link-refused release run): the Desk output was refused, and its temporary folder removed" \
    eval 'said same-desk-link-refused-after "Desk: the build output is or holds a symbolic link" && [ -z "$(find "${WORK}/same-desk-link-refused-after/tmp" -mindepth 1 -print)" ]'
fi

# --- the test copy (--test-identity) ------------------------------------------

APP_LAYOUT_TEST="$(printf '%s\n' "${APP_LAYOUT_RELEASE}" "./Contents/MacOS/ParticipantSupervisor Regular File -rwxr-xr-x" \
  | sed 's#MacOS/True Convo #MacOS/True Convo Test #' | sort)"
SUPERVISOR_IDENTIFIER="com.trueconvo.voice-cursor.test.participant-supervisor"
codesign_commands() { grep '^codesign ' "${WORK}/$1/stub.log"; }
# The exact signing sequence for a test copy at $1: the helper with its own
# identifier, then the app without --deep, both verified, both identifiers
# read back.
test_signing_sequence() {
  printf '%s\n' \
    "codesign --force --timestamp=none --sign - --identifier ${SUPERVISOR_IDENTIFIER} $1/Contents/MacOS/ParticipantSupervisor" \
    "codesign --force --timestamp=none --sign - $1" \
    "codesign --verify --strict $1/Contents/MacOS/ParticipantSupervisor" \
    "codesign --verify --deep --strict $1" \
    "codesign -dv $1/Contents/MacOS/ParticipantSupervisor" \
    "codesign -dv $1"
}
# The identifier the stand-in codesign last recorded for a path.
recorded_identifier() { awk -F '\t' -v p="$2" '$1 == p { id = $2 } END { print id }' "${WORK}/$1/codesign-state"; }
plist_value() { /usr/bin/plutil -extract "$2" raw -o - "$1" 2>/dev/null; }
# The old release apps and the unrelated file make_apps_target puts in a
# folder: names, modes, owners, sizes and contents.
kept_state() {
  local items=("True Convo.app" "Voice Cursor.app" "Convo Cursor.app" "Unrelated-CANARY.txt")
  (cd "$1" && find "${items[@]}" -exec stat -f '%N %Sp %u %z' {} \; | sort && find "${items[@]}" -type f -exec shasum -a 256 {} \; | sort)
}

# 15. A plain test-copy build next to old release apps in dist and an invented
#     apps folder: only dist/True Convo Test.app is made, with the test names.
make_case test-plain
DIST="${WORK}/test-plain/repo/apps/true-convo-mac/dist"
make_apps_target "${DIST}"
make_apps_target "${WORK}/test-plain/home/Applications"
DIST_BEFORE="$(kept_state "${DIST}")"
APPS_BEFORE="$(tree_state "${WORK}/test-plain/home/Applications")"
SOURCE_BEFORE="$(shasum -a 256 < "${WORK}/test-plain/repo/apps/true-convo-mac/Packaging/Info.plist")"
RELEASE_BUILD_BEFORE="$(tree_state "${WORK}/test-plain/repo/apps/true-convo-mac/.build/release")"
SCRIPT_ARGS=(--test-identity)
run_package test-plain TRUE_CONVO_WITH_DESK=0
SCRIPT_ARGS=()
TEST_MAC="${WORK}/test-plain/repo/apps/true-convo-mac"
TEST_APP="${DIST}/True Convo Test.app"
TEST_PLIST="${TEST_APP}/Contents/Info.plist"
check "test copy: packaged (exit 0)" [ "${STATUS}" -eq 0 ]
check "test copy: says it packaged dist/True Convo Test.app" said test-plain "Packaged ${TEST_APP}"
check "test copy: says it is not installed or opened" said test-plain "Not installed, not opened."
check "test copy: its files are the release layout with the program renamed" [ "$(layout "${TEST_APP}")" == "${APP_LAYOUT_TEST}" ]
check "test copy: bundle id com.trueconvo.voice-cursor.test" [ "$(plist_value "${TEST_PLIST}" CFBundleIdentifier)" == "com.trueconvo.voice-cursor.test" ]
check "test copy: CFBundleName True Convo Test" [ "$(plist_value "${TEST_PLIST}" CFBundleName)" == "True Convo Test" ]
check "test copy: CFBundleDisplayName True Convo Test" [ "$(plist_value "${TEST_PLIST}" CFBundleDisplayName)" == "True Convo Test" ]
check "test copy: CFBundleExecutable True Convo Test" [ "$(plist_value "${TEST_PLIST}" CFBundleExecutable)" == "True Convo Test" ]
check "test copy: Services menu item Correct With True Convo Test" [ "$(plist_value "${TEST_PLIST}" NSServices.0.NSMenuItem.default)" == "Correct With True Convo Test" ]
check "test copy: Services port True Convo Test" [ "$(plist_value "${TEST_PLIST}" NSServices.0.NSPortName)" == "True Convo Test" ]
check "test copy: Services message unchanged" [ "$(plist_value "${TEST_PLIST}" NSServices.0.NSMessage)" == "correctSelectedTextService" ]
check "test copy: microphone prompt names True Convo Test" eval '[[ "$(plist_value "${TEST_PLIST}" NSMicrophoneUsageDescription)" == "True Convo Test records "* ]]'
check "test copy: speech prompt names True Convo Test" eval '[[ "$(plist_value "${TEST_PLIST}" NSSpeechRecognitionUsageDescription)" == "True Convo Test uses "* ]]'
check "test copy: same version and build as the source" eval '[ "$(plist_value "${TEST_PLIST}" CFBundleShortVersionString)" == "$(plist_value "${INFO_PLIST_SRC}" CFBundleShortVersionString)" ] && [ "$(plist_value "${TEST_PLIST}" CFBundleVersion)" == "$(plist_value "${INFO_PLIST_SRC}" CFBundleVersion)" ]'
# Put the source values back into a copy: then it must equal the source, so
# no other key was changed, added or removed.
only_the_test_names_differ() {
  local copy="${WORK}/test-plain/reverted.plist" key
  cp "$1" "${copy}" 2>/dev/null || return 1
  for key in CFBundleIdentifier CFBundleName CFBundleDisplayName CFBundleExecutable NSServices.0.NSMenuItem.default NSServices.0.NSPortName NSMicrophoneUsageDescription NSSpeechRecognitionUsageDescription; do
    /usr/bin/plutil -replace "${key}" -string "$(plist_value "${INFO_PLIST_SRC}" "${key}")" "${copy}" || return 1
  done
  /usr/bin/plutil -remove TCSourceCommit "${copy}" >/dev/null 2>&1 || return 1
  [ "$(/usr/bin/plutil -convert xml1 -o - "${copy}")" == "$(/usr/bin/plutil -convert xml1 -o - "${INFO_PLIST_SRC}")" ]
}
check "test copy: no other Info.plist key differs from the source" only_the_test_names_differ "${TEST_PLIST}"
check "test copy: Packaging/Info.plist itself is unchanged" [ "$(shasum -a 256 < "${WORK}/test-plain/repo/apps/true-convo-mac/Packaging/Info.plist")" == "${SOURCE_BEFORE}" ]
check "test copy: dist/True Convo.app, Voice Cursor.app, Convo Cursor.app and the unrelated file keep every byte and mode" \
  [ "$(kept_state "${DIST}")" == "${DIST_BEFORE}" ]
check "test copy: the dist canaries are still there" eval 'grep -qF "INVENTED CANARY True Convo.app" "${DIST}/True Convo.app/Contents/CANARY.txt" && [ -f "${DIST}/Voice Cursor.app/Contents/CANARY.txt" ] && [ -f "${DIST}/Convo Cursor.app/Contents/CANARY.txt" ]'
check "test copy: the invented Applications folder is untouched" [ "$(tree_state "${WORK}/test-plain/home/Applications")" == "${APPS_BEFORE}" ]
check "test copy: only the test copy is signed" eval '! grep -q "^codesign .*True Convo.app" "${WORK}/test-plain/stub.log"'
check "test copy: built in .build/test-identity, separate from the release build's .build/release" \
  [ "$(grep '^swift build' "${WORK}/test-plain/stub.log")" == "swift build -c release -j 2 --package-path ${TEST_MAC} --scratch-path ${TEST_MAC}/.build/test-identity" ]
check "test copy: its program is the one from .build/test-identity" cmp -s "${TEST_APP}/Contents/MacOS/True Convo Test" "${TEST_MAC}/.build/test-identity/release/VoiceCursorMac"
check "test copy: its ParticipantSupervisor is the one from .build/test-identity (0755)" \
  eval 'cmp -s "${TEST_APP}/Contents/MacOS/ParticipantSupervisor" "${TEST_MAC}/.build/test-identity/release/ParticipantSupervisor" && [ "$(stat -f %Lp "${TEST_APP}/Contents/MacOS/ParticipantSupervisor")" == 755 ]'
check "test copy: the release .build is untouched" [ "$(tree_state "${TEST_MAC}/.build/release")" == "${RELEASE_BUILD_BEFORE}" ]
check "test copy: helper signed first with its identifier, then the app without --deep; both verified; both identifiers read back" \
  [ "$(codesign_commands test-plain)" == "$(test_signing_sequence "${TEST_APP}")" ]
check "test copy: no signing command uses --deep (it would re-sign the helper)" eval '! codesign_commands test-plain | grep -- "--force" | grep -q -- "--deep"'
check "test copy: the helper keeps its identifier after the app is signed" [ "$(recorded_identifier test-plain "${TEST_APP}/Contents/MacOS/ParticipantSupervisor")" == "${SUPERVISOR_IDENTIFIER}" ]
check "test copy: the app is signed as com.trueconvo.voice-cursor.test" [ "$(recorded_identifier test-plain "${TEST_APP}")" == "com.trueconvo.voice-cursor.test" ]
check "test copy: says the helper is signed with its identifier and inactive" said test-plain "Test copy: ParticipantSupervisor signed ad hoc as ${SUPERVISOR_IDENTIFIER} (bundled, still inactive)."
check "test copy: TCSourceCommit is the checkout's HEAD" [ "$(plist_value "${TEST_PLIST}" TCSourceCommit)" == "$(git -C "${WORK}/test-plain/repo" rev-parse HEAD)" ]
check "test copy: says which source commit it recorded" said test-plain "Test copy: source commit $(git -C "${WORK}/test-plain/repo" rev-parse HEAD) (TCSourceCommit)."
check "test copy: never looked for, quit or opened an app, or read the Keychain" eval '! ran test-plain pgrep && ! ran test-plain pkill && ! ran test-plain open && ! ran test-plain security && ! ran test-plain ditto'

# 16. --test-identity with --install, in either order and in a Desk build:
#     refused before anything is built, quit, moved or opened.
for order in before after desk; do
  name="test-install-${order}"
  make_case "${name}"
  make_apps_target "${WORK}/${name}/home/Applications"
  APPS_BEFORE="$(tree_state "${WORK}/${name}/home/Applications")"
  if [[ "${order}" == "after" ]]; then SCRIPT_ARGS=(--install --test-identity); else SCRIPT_ARGS=(--test-identity --install); fi
  with_desk=0
  [[ "${order}" == "desk" ]] && with_desk=1
  run_package "${name}" TRUE_CONVO_WITH_DESK="${with_desk}"
  SCRIPT_ARGS=()
  check "test copy with --install (${order}): refused (exit 2)" [ "${STATUS}" -eq 2 ]
  check "test copy with --install (${order}): plain message" said "${name}" "Test copy: --test-identity never installs."
  check "test copy with --install (${order}): nothing was built" eval "! swift_ran ${name} && [ ! -e '${WORK}/${name}/repo/apps/true-convo-mac/dist' ]"
  check "test copy with --install (${order}): nothing looked for, quit or opened" eval "! ran ${name} pgrep && ! ran ${name} pkill && ! ran ${name} open"
  check "test copy with --install (${order}): the invented Applications folder is untouched" [ "$(tree_state "${WORK}/${name}/home/Applications")" == "${APPS_BEFORE}" ]
done

# 17. --test-identity with a signing identity: refused, and the Keychain is
#     never asked (no security lookup).
make_case test-signed
SCRIPT_ARGS=(--test-identity)
run_package test-signed TRUE_CONVO_WITH_DESK=0 TRUE_CONVO_SIGN_IDENTITY=0123456789abcdef0123456789abcdef01234567
SCRIPT_ARGS=()
check "test copy with a signing identity: refused (exit 2)" [ "${STATUS}" -eq 2 ]
check "test copy with a signing identity: plain message" said test-signed "Test copy: --test-identity is always ad-hoc signed"
check "test copy with a signing identity: the Keychain was never asked" eval '! ran test-signed security'
check "test copy with a signing identity: nothing was built or signed" eval '! swift_ran test-signed && ! ran test-signed codesign'

# 18. dist/True Convo Test.app is a link: refused, the target kept.
make_case test-linked
TARGET="${WORK}/test-linked/home/Applications"
make_apps_target "${TARGET}"
mkdir -p "${WORK}/test-linked/repo/apps/true-convo-mac/dist"
ln -s "${TARGET}/True Convo.app" "${WORK}/test-linked/repo/apps/true-convo-mac/dist/True Convo Test.app"
BEFORE="$(tree_state "${TARGET}")"
SCRIPT_ARGS=(--test-identity)
run_package test-linked TRUE_CONVO_WITH_DESK=0
SCRIPT_ARGS=()
check "linked dist/True Convo Test.app: refused (exit 1)" [ "${STATUS}" -eq 1 ]
check "linked dist/True Convo Test.app: plain message" said test-linked "dist/True Convo Test.app is a symbolic link; refusing to build through it. Nothing was built or changed."
check "linked dist/True Convo Test.app: nothing was built" eval '! swift_ran test-linked'
check "linked dist/True Convo Test.app: the target is unchanged" [ "$(tree_state "${TARGET}")" == "${BEFORE}" ]

# 19. A Desk test-copy build: the Desk and its source commit, with the test names.
make_case test-desk
SCRIPT_ARGS=(--test-identity)
run_package test-desk
SCRIPT_ARGS=()
TEST_DESK_APP="${WORK}/test-desk/repo/apps/true-convo-mac/dist/True Convo Test.app"
check "test copy with the Desk: packaged (exit 0)" [ "${STATUS}" -eq 0 ]
check "test copy with the Desk: the Desk was bundled" grep -qF 'invented Desk' "${TEST_DESK_APP}/Contents/Resources/Desk/index.html"
check "test copy with the Desk: the source commit is recorded" [ "$(plist_value "${TEST_DESK_APP}/Contents/Info.plist" TCDeskSourceCommit)" == "$(git -C "${WORK}/test-desk/repo" rev-parse HEAD)" ]
check "test copy with the Desk: bundle id com.trueconvo.voice-cursor.test" [ "$(plist_value "${TEST_DESK_APP}/Contents/Info.plist" CFBundleIdentifier)" == "com.trueconvo.voice-cursor.test" ]
check "test copy with the Desk: no release app was made" [ ! -e "${WORK}/test-desk/repo/apps/true-convo-mac/dist/True Convo.app" ]

# 20. The read-back: if the bundle id were not changed, the test-named app is
#     removed before signing (it would share the real app's settings and keys).
make_case test-readback
SCRIPT_ARGS=(--test-identity)
run_package test-readback TRUE_CONVO_WITH_DESK=0 STUB_PLUTIL_SKIP=CFBundleIdentifier
SCRIPT_ARGS=()
check "read-back: refused (exit 1)" [ "${STATUS}" -eq 1 ]
check "read-back: plain message" said test-readback 'Test copy: CFBundleIdentifier reads "com.trueconvo.voice-cursor", not "com.trueconvo.voice-cursor.test".'
check "read-back: the half-made app was removed" [ ! -e "${WORK}/test-readback/repo/apps/true-convo-mac/dist/True Convo Test.app" ]
check "read-back: nothing was signed" eval '! ran test-readback codesign'

# 20b. The read-back covers both permission prompts: a prompt that still
#      names "True Convo" is refused the same way.
make_case test-readback-prompt
SCRIPT_ARGS=(--test-identity)
run_package test-readback-prompt TRUE_CONVO_WITH_DESK=0 STUB_PLUTIL_SKIP=NSMicrophoneUsageDescription
SCRIPT_ARGS=()
check "prompt read-back: refused (exit 1)" [ "${STATUS}" -eq 1 ]
check "prompt read-back: plain message" said test-readback-prompt 'Test copy: NSMicrophoneUsageDescription does not start with "True Convo Test ".'
check "prompt read-back: the half-made app was removed" [ ! -e "${WORK}/test-readback-prompt/repo/apps/true-convo-mac/dist/True Convo Test.app" ]
check "prompt read-back: nothing was signed" eval '! ran test-readback-prompt codesign'

# 20c. A permission prompt missing from the source Info.plist: refused with a
#      message, and the half-made app is removed.
make_case test-missing-prompt
/usr/bin/plutil -remove NSSpeechRecognitionUsageDescription "${WORK}/test-missing-prompt/repo/apps/true-convo-mac/Packaging/Info.plist"
SCRIPT_ARGS=(--test-identity)
run_package test-missing-prompt TRUE_CONVO_WITH_DESK=0
SCRIPT_ARGS=()
check "missing prompt: refused (exit 1)" [ "${STATUS}" -eq 1 ]
check "missing prompt: plain message" said test-missing-prompt "Test copy: NSSpeechRecognitionUsageDescription is missing from Info.plist. Removed dist/True Convo Test.app; nothing was signed."
check "missing prompt: the half-made app was removed" [ ! -e "${WORK}/test-missing-prompt/repo/apps/true-convo-mac/dist/True Convo Test.app" ]
check "missing prompt: nothing was signed" eval '! ran test-missing-prompt codesign'

# 20d. Codex review N1: a plutil -replace that fails (exit 73) stops the script
#      under set -e. The half-made test copy (still carrying the release
#      Info.plist) is removed, nothing is signed, and nothing else in dist or
#      the invented Applications folder changes.
make_case test-plutil-fails
DIST="${WORK}/test-plutil-fails/repo/apps/true-convo-mac/dist"
make_apps_target "${DIST}"
make_apps_target "${WORK}/test-plutil-fails/home/Applications"
DIST_BEFORE="$(kept_state "${DIST}")"
APPS_BEFORE="$(tree_state "${WORK}/test-plutil-fails/home/Applications")"
SCRIPT_ARGS=(--test-identity)
run_package test-plutil-fails TRUE_CONVO_WITH_DESK=0 "STUB_PLUTIL_FAIL=-replace CFBundleIdentifier"
SCRIPT_ARGS=()
check "failing plutil: stopped with plutil's exit (73)" [ "${STATUS}" -eq 73 ]
check "failing plutil: the stand-in plutil did fail" ran test-plutil-fails "plutil failed -replace CFBundleIdentifier"
check "failing plutil: plain message" said test-plutil-fails "Test copy: packaging stopped before signing (exit 73). Removed dist/True Convo Test.app; nothing was signed."
check "failing plutil: the half-made app was removed" eval '[ ! -e "${DIST}/True Convo Test.app" ] && [ ! -L "${DIST}/True Convo Test.app" ]'
check "failing plutil: nothing was signed" eval '! ran test-plutil-fails codesign'
check "failing plutil: dist/True Convo.app, Voice Cursor.app, Convo Cursor.app and the unrelated file keep every byte and mode" \
  [ "$(kept_state "${DIST}")" == "${DIST_BEFORE}" ]
check "failing plutil: dist holds nothing new" eval '[ "$(cd "${DIST}" && ls -A | sort | tr "\n" "|")" == "Convo Cursor.app|True Convo.app|Unrelated-CANARY.txt|Voice Cursor.app|" ]'
check "failing plutil: the invented Applications folder is untouched" [ "$(tree_state "${WORK}/test-plutil-fails/home/Applications")" == "${APPS_BEFORE}" ]

# 20e. A later step failing (plutil -lint, after the read-back passed) is
#      cleaned up the same way.
make_case test-lint-fails
SCRIPT_ARGS=(--test-identity)
run_package test-lint-fails TRUE_CONVO_WITH_DESK=0 STUB_PLUTIL_FAIL=-lint
SCRIPT_ARGS=()
check "failing plutil -lint: stopped (exit 73)" [ "${STATUS}" -eq 73 ]
check "failing plutil -lint: plain message" said test-lint-fails "Test copy: packaging stopped before signing (exit 73). Removed dist/True Convo Test.app; nothing was signed."
check "failing plutil -lint: the half-made app was removed" [ ! -e "${WORK}/test-lint-fails/repo/apps/true-convo-mac/dist/True Convo Test.app" ]
check "failing plutil -lint: nothing was signed" eval '! ran test-lint-fails codesign'

# 20f. A Desk test-copy build whose Desk output holds a link: refused before
#      signing, the half-made app and the Desk build's temporary folder are
#      removed, and the link's invented target is unchanged.
make_case test-desk-link
TARGET="${WORK}/test-desk-link/target"
make_target "${TARGET}"
BEFORE="$(tree_state "${TARGET}")"
SCRIPT_ARGS=(--test-identity)
run_package test-desk-link STUB_NPM_AFTER=link-inside STUB_TARGET="${TARGET}"
SCRIPT_ARGS=()
check "Desk output link in a test copy: refused (exit 1)" [ "${STATUS}" -eq 1 ]
check "Desk output link in a test copy: plain messages" eval 'said test-desk-link "Desk: the build output is or holds a symbolic link" && said test-desk-link "Test copy: packaging stopped before signing (exit 1). Removed dist/True Convo Test.app; nothing was signed."'
check "Desk output link in a test copy: the half-made app was removed" [ ! -e "${WORK}/test-desk-link/repo/apps/true-convo-mac/dist/True Convo Test.app" ]
check "Desk output link in a test copy: the Desk build's temporary folder was removed" [ -z "$(find "${WORK}/test-desk-link/tmp" -mindepth 1 -print)" ]
check "Desk output link in a test copy: nothing was signed" eval '! ran test-desk-link codesign'
check "Desk output link in a test copy: the link's target is unchanged" [ "$(tree_state "${TARGET}")" == "${BEFORE}" ]

# 20g. A failure before this run starts its test copy (the build) leaves an
#      older dist/True Convo Test.app from an earlier run exactly as it was:
#      the cleanup removes only what this run made.
make_case test-build-fails
DIST="${WORK}/test-build-fails/repo/apps/true-convo-mac/dist"
mkdir -p "${DIST}/True Convo Test.app/Contents/MacOS"
printf 'INVENTED EARLIER TEST COPY\n' > "${DIST}/True Convo Test.app/Contents/EARLIER-CANARY.txt"
BEFORE="$(tree_state "${DIST}")"
SCRIPT_ARGS=(--test-identity)
run_package test-build-fails TRUE_CONVO_WITH_DESK=0 STUB_SWIFT_FAIL=1
SCRIPT_ARGS=()
check "failing build: stopped with the build's exit (75)" [ "${STATUS}" -eq 75 ]
check "failing build: the earlier test copy keeps every byte and mode" [ "$(tree_state "${DIST}")" == "${BEFORE}" ]
check "failing build: no cleanup message (nothing of this run's to remove)" eval '! said test-build-fails "packaging stopped before signing"'

# 22. An old dist/True Convo Test.app from an earlier run is replaced whole:
#     its old files are gone, and the release apps next to it are kept.
make_case test-replace
DIST="${WORK}/test-replace/repo/apps/true-convo-mac/dist"
make_apps_target "${DIST}"
mkdir -p "${DIST}/True Convo Test.app/Contents/MacOS"
printf 'INVENTED STALE CANARY\n' > "${DIST}/True Convo Test.app/Contents/STALE-CANARY.txt"
printf 'invented old program\n' > "${DIST}/True Convo Test.app/Contents/MacOS/True Convo Test"
DIST_BEFORE="$(kept_state "${DIST}")"
SCRIPT_ARGS=(--test-identity)
run_package test-replace TRUE_CONVO_WITH_DESK=0
SCRIPT_ARGS=()
check "old test copy in dist: packaged (exit 0)" [ "${STATUS}" -eq 0 ]
check "old test copy in dist: its old files are gone and the layout is the new one" \
  eval '[ ! -e "${DIST}/True Convo Test.app/Contents/STALE-CANARY.txt" ] && [ "$(layout "${DIST}/True Convo Test.app")" == "${APP_LAYOUT_TEST}" ]'
check "old test copy in dist: the new program replaced the old one" eval '! grep -qF "invented old program" "${DIST}/True Convo Test.app/Contents/MacOS/True Convo Test"'
check "old test copy in dist: the release apps and the unrelated file keep every byte and mode" [ "$(kept_state "${DIST}")" == "${DIST_BEFORE}" ]

# 23. dist/True Convo Test.app is a plain file: refused before anything is
#     built, and the file is unchanged.
make_case test-file
mkdir -p "${WORK}/test-file/repo/apps/true-convo-mac/dist"
printf 'invented file\n' > "${WORK}/test-file/repo/apps/true-convo-mac/dist/True Convo Test.app"
BEFORE="$(shasum -a 256 "${WORK}/test-file/repo/apps/true-convo-mac/dist/True Convo Test.app")"
SCRIPT_ARGS=(--test-identity)
run_package test-file TRUE_CONVO_WITH_DESK=0
SCRIPT_ARGS=()
check "file dist/True Convo Test.app: refused (exit 1)" [ "${STATUS}" -eq 1 ]
check "file dist/True Convo Test.app: plain message" said test-file "dist/True Convo Test.app is not a plain folder of yours; refusing to build. Nothing was built or changed."
check "file dist/True Convo Test.app: nothing was built" eval '! swift_ran test-file'
check "file dist/True Convo Test.app: unchanged" [ "$(shasum -a 256 "${WORK}/test-file/repo/apps/true-convo-mac/dist/True Convo Test.app")" == "${BEFORE}" ]

# --- F2: the participant supervisor helper in the test copy -----------------

# 24. The helper is missing from .build/test-identity, or is a link there:
#     refused before signing, the half-made app is removed and nothing else
#     in dist changes.
for kind in missing link; do
  name="test-helper-${kind}"
  make_case "${name}"
  MAC="${WORK}/${name}/repo/apps/true-convo-mac"
  DIST="${MAC}/dist"
  make_apps_target "${DIST}"
  DIST_BEFORE="$(kept_state "${DIST}")"
  rm "${MAC}/.build/test-identity/release/ParticipantSupervisor"
  [[ "${kind}" == "link" ]] && ln -s "${MAC}/.build/release/ParticipantSupervisor" "${MAC}/.build/test-identity/release/ParticipantSupervisor"
  SCRIPT_ARGS=(--test-identity)
  run_package "${name}" TRUE_CONVO_WITH_DESK=0
  SCRIPT_ARGS=()
  check "helper ${kind}: refused (exit 1)" [ "${STATUS}" -eq 1 ]
  check "helper ${kind}: plain message" said "${name}" "Test copy: ParticipantSupervisor is missing from .build/test-identity/release (or is not a plain program file). Removed dist/True Convo Test.app; nothing was signed."
  check "helper ${kind}: the half-made app was removed" eval "[ ! -e '${DIST}/True Convo Test.app' ] && [ ! -L '${DIST}/True Convo Test.app' ]"
  check "helper ${kind}: nothing was signed" eval "! ran ${name} codesign"
  check "helper ${kind}: dist holds nothing new" eval "[ \"\$(cd '${DIST}' && ls -A | sort | tr '\n' '|')\" == 'Convo Cursor.app|True Convo.app|Unrelated-CANARY.txt|Voice Cursor.app|' ]"
  check "helper ${kind}: the release apps and the unrelated file keep every byte and mode" [ "$(kept_state "${DIST}")" == "${DIST_BEFORE}" ]
done

# 25. A failing signature check after signing: the signed app is removed too.
make_case test-verify-fails
SCRIPT_ARGS=(--test-identity)
run_package test-verify-fails TRUE_CONVO_WITH_DESK=0 "STUB_CODESIGN_FAIL=--verify --strict"
SCRIPT_ARGS=()
VERIFY_APP="${WORK}/test-verify-fails/repo/apps/true-convo-mac/dist/True Convo Test.app"
check "failing helper verification: refused (exit 1)" [ "${STATUS}" -eq 1 ]
check "failing helper verification: the stand-in check did fail" grep -qxF "codesign --verify --strict ${VERIFY_APP}/Contents/MacOS/ParticipantSupervisor" "${WORK}/test-verify-fails/stub.log"
check "failing helper verification: plain message" said test-verify-fails "Test copy: packaging stopped while signing or checking the signatures (exit 1). Removed dist/True Convo Test.app."
check "failing helper verification: the signed app was removed" [ ! -e "${VERIFY_APP}" ]

# 25b. A Desk test copy whose Desk manifest check fails after signing (the
#      DeskBundleManifest stand-in passes its first --verify, before signing,
#      and fails its second, after): the signed app and the Desk build's
#      temporary folder are both removed.
make_case test-desk-verify-after-signing
MANIFEST_TOOL="${WORK}/test-desk-verify-after-signing/repo/apps/true-convo-mac/.build/test-identity/release/DeskBundleManifest"
cat > "${MANIFEST_TOOL}" <<'TOOL'
#!/bin/bash
if [[ "$1" == "write" ]]; then printf '{"invented":true}\n' > "$3"; exit 0; fi
count_file="$(dirname "${STUB_LOG}")/manifest-verify-count"
count=$(( $(cat "${count_file}" 2>/dev/null || echo 0) + 1 ))
echo "${count}" > "${count_file}"
echo "DeskBundleManifest --verify call ${count}" >> "${STUB_LOG}"
[[ "${count}" -lt 2 ]]
TOOL
chmod 755 "${MANIFEST_TOOL}"
SCRIPT_ARGS=(--test-identity)
run_package test-desk-verify-after-signing
SCRIPT_ARGS=()
AFTER_SIGNING_APP="${WORK}/test-desk-verify-after-signing/repo/apps/true-convo-mac/dist/True Convo Test.app"
check "Desk check failing after signing: refused (exit 1)" [ "${STATUS}" -eq 1 ]
check "Desk check failing after signing: the app was signed, and the second check is the one that failed" \
  eval 'grep -qxF "codesign --force --timestamp=none --sign - ${AFTER_SIGNING_APP}" "${WORK}/test-desk-verify-after-signing/stub.log" && grep -qxF "DeskBundleManifest --verify call 2" "${WORK}/test-desk-verify-after-signing/stub.log"'
check "Desk check failing after signing: plain message" said test-desk-verify-after-signing "Test copy: packaging stopped while signing or checking the signatures (exit 1). Removed dist/True Convo Test.app."
check "Desk check failing after signing: the signed app was removed" eval '[ ! -e "${AFTER_SIGNING_APP}" ] && [ ! -L "${AFTER_SIGNING_APP}" ]'
check "Desk check failing after signing: the Desk build's temporary folder was removed" [ -z "$(find "${WORK}/test-desk-verify-after-signing/tmp" -mindepth 1 -print)" ]

# 25c. The app's own identifier read back wrong (a copy of the script that
#      signs the app as the real app, com.trueconvo.voice-cursor): refused,
#      and the signed app is removed.
make_case test-app-identifier
APP_ID_SCRIPT="${WORK}/test-app-identifier/repo/apps/true-convo-mac/scripts/package_app.sh"
sed -i '' 's/^  codesign --force --timestamp=none --sign - "\${APP_DIR}"$/  codesign --force --timestamp=none --sign - --identifier com.trueconvo.voice-cursor "${APP_DIR}"/' "${APP_ID_SCRIPT}"
check "app identifier wrong: the copy signs the app as com.trueconvo.voice-cursor" grep -qxF '  codesign --force --timestamp=none --sign - --identifier com.trueconvo.voice-cursor "${APP_DIR}"' "${APP_ID_SCRIPT}"
SCRIPT_ARGS=(--test-identity)
run_package test-app-identifier TRUE_CONVO_WITH_DESK=0
SCRIPT_ARGS=()
check "app identifier wrong: refused (exit 1)" [ "${STATUS}" -eq 1 ]
check "app identifier wrong: the read-back names the problem" said test-app-identifier 'Test copy: dist/True Convo Test.app is signed with identifier "com.trueconvo.voice-cursor", not "com.trueconvo.voice-cursor.test".'
check "app identifier wrong: the signed app was removed" eval 'said test-app-identifier "Removed dist/True Convo Test.app." && [ ! -e "${WORK}/test-app-identifier/repo/apps/true-convo-mac/dist/True Convo Test.app" ]'

# 25d. Codex F2-M1: a codesign -dv that prints the expected Identifier line and
#      then exits 73 is refused on its exit status, before its output is read
#      (the old `|| true` accepted it), and the trap removes the signed app.
make_case test-display-fails
SCRIPT_ARGS=(--test-identity)
run_package test-display-fails TRUE_CONVO_WITH_DESK=0 STUB_CODESIGN_DISPLAY_EXIT=73
SCRIPT_ARGS=()
DISPLAY_APP="${WORK}/test-display-fails/repo/apps/true-convo-mac/dist/True Convo Test.app"
DISPLAY_PRINTED="$(printf '%s\t%s\texit 73' "${DISPLAY_APP}/Contents/MacOS/ParticipantSupervisor" "${SUPERVISOR_IDENTIFIER}")"
check "failing identifier read-back: refused (exit 1)" [ "${STATUS}" -eq 1 ]
check "failing identifier read-back: the stand-in printed the helper's expected identifier, then exited 73" \
  grep -qxF "${DISPLAY_PRINTED}" "${WORK}/test-display-fails/codesign-display"
check "failing identifier read-back: both were signed and verified first, as usual" \
  [ "$(codesign_commands test-display-fails | sed -n '1,5p')" == "$(test_signing_sequence "${DISPLAY_APP}" | sed -n '1,5p')" ]
check "failing identifier read-back: refused at the helper's read-back; the app's was never read" \
  eval '! grep -qxF "codesign -dv ${DISPLAY_APP}" "${WORK}/test-display-fails/stub.log"'
check "failing identifier read-back: plain message" \
  said test-display-fails "Test copy: could not read the signature of dist/True Convo Test.app/Contents/MacOS/ParticipantSupervisor (codesign -dv exited 73); refusing."
check "failing identifier read-back: not mistaken for a wrong identifier, nor reported packaged" \
  eval '! said test-display-fails "is signed with identifier" && ! said test-display-fails "Packaged "'
check "failing identifier read-back: the trap removed the signed app" \
  eval 'said test-display-fails "Test copy: packaging stopped while signing or checking the signatures (exit 1). Removed dist/True Convo Test.app." && [ ! -e "${DISPLAY_APP}" ] && [ ! -L "${DISPLAY_APP}" ]'

# 25e. The same for the app's own read-back, the loop's second pass: the
#      helper's read-back passes, then the app's prints the app's expected
#      Identifier line and exits 73. Refused on its exit status, and the trap
#      removes the signed app.
make_case test-app-display-fails
APP_DISPLAY_APP="${WORK}/test-app-display-fails/repo/apps/true-convo-mac/dist/True Convo Test.app"
SCRIPT_ARGS=(--test-identity)
run_package test-app-display-fails TRUE_CONVO_WITH_DESK=0 STUB_CODESIGN_DISPLAY_EXIT=73 "STUB_CODESIGN_DISPLAY_ONLY=${APP_DISPLAY_APP}"
SCRIPT_ARGS=()
check "failing app read-back: refused (exit 1)" [ "${STATUS}" -eq 1 ]
check "failing app read-back: the helper's read-back printed its expected identifier and passed first" \
  grep -qxF "$(printf '%s\t%s\texit 0' "${APP_DISPLAY_APP}/Contents/MacOS/ParticipantSupervisor" "${SUPERVISOR_IDENTIFIER}")" "${WORK}/test-app-display-fails/codesign-display"
check "failing app read-back: the stand-in printed the app's expected identifier, then exited 73" \
  grep -qxF "$(printf '%s\t%s\texit 73' "${APP_DISPLAY_APP}" "com.trueconvo.voice-cursor.test")" "${WORK}/test-app-display-fails/codesign-display"
check "failing app read-back: the whole usual sequence ran, ending with the app's read-back" \
  [ "$(codesign_commands test-app-display-fails)" == "$(test_signing_sequence "${APP_DISPLAY_APP}")" ]
check "failing app read-back: plain message" \
  said test-app-display-fails "Test copy: could not read the signature of dist/True Convo Test.app (codesign -dv exited 73); refusing."
check "failing app read-back: not mistaken for a wrong identifier, nor reported packaged" \
  eval '! said test-app-display-fails "is signed with identifier" && ! said test-app-display-fails "Packaged "'
check "failing app read-back: the trap removed the signed app" \
  eval 'said test-app-display-fails "Test copy: packaging stopped while signing or checking the signatures (exit 1). Removed dist/True Convo Test.app." && [ ! -e "${APP_DISPLAY_APP}" ] && [ ! -L "${APP_DISPLAY_APP}" ]'

# 26. If the app were signed with --deep again (the --deep --force the critic
#     found), the helper's identifier is replaced, the read-back refuses, and
#     the app is removed. If the helper were not signed first, the real
#     codesign accepts SwiftPM's linker signature unchanged (identifier
#     ParticipantSupervisor) when it signs the app, so the read-back is what
#     refuses (26b); only a helper with no signature at all makes the app
#     signing itself refuse (26c). Each is a copy of the script with that one
#     line changed.
make_case test-deep-returns
DEEP_SCRIPT="${WORK}/test-deep-returns/repo/apps/true-convo-mac/scripts/package_app.sh"
sed -i '' 's/^  codesign --force --timestamp=none --sign - "\${APP_DIR}"$/  codesign --force --deep --timestamp=none --sign - "${APP_DIR}"/' "${DEEP_SCRIPT}"
check "--deep returns: the copy signs the app with --deep" grep -qxF '  codesign --force --deep --timestamp=none --sign - "${APP_DIR}"' "${DEEP_SCRIPT}"
SCRIPT_ARGS=(--test-identity)
run_package test-deep-returns TRUE_CONVO_WITH_DESK=0
SCRIPT_ARGS=()
DEEP_APP="${WORK}/test-deep-returns/repo/apps/true-convo-mac/dist/True Convo Test.app"
check "--deep returns: refused (exit 1)" [ "${STATUS}" -eq 1 ]
check "--deep returns: the identifier read-back names the problem" said test-deep-returns "Test copy: dist/True Convo Test.app/Contents/MacOS/ParticipantSupervisor is signed with identifier \"ParticipantSupervisor\", not \"${SUPERVISOR_IDENTIFIER}\"."
check "--deep returns: the signed app was removed" eval 'said test-deep-returns "Removed dist/True Convo Test.app." && [ ! -e "${DEEP_APP}" ]'

for kind in linker-signed unsigned; do
  name="test-helper-${kind}"
  make_case "${name}"
  UNSIGNED_SCRIPT="${WORK}/${name}/repo/apps/true-convo-mac/scripts/package_app.sh"
  sed -i '' '/--identifier "\${TEST_SUPERVISOR_IDENTIFIER}"/d' "${UNSIGNED_SCRIPT}"
  if [[ "${kind}" == "unsigned" ]]; then
    printf '#!/bin/sh\n# invented supervisor with no signature at all\nexit 0\n' > "${WORK}/${name}/repo/apps/true-convo-mac/.build/test-identity/release/ParticipantSupervisor"
  fi
  check "helper not signed first (${kind}): the copy never signs the helper" eval "! grep -q -- '--identifier' '${UNSIGNED_SCRIPT}'"
  SCRIPT_ARGS=(--test-identity)
  run_package "${name}" TRUE_CONVO_WITH_DESK=0
  SCRIPT_ARGS=()
  check "helper not signed first (${kind}): refused (exit 1)" [ "${STATUS}" -eq 1 ]
  if [[ "${kind}" == "linker-signed" ]]; then
    check "helper not signed first (linker-signed): the app signing accepted the linker signature" \
      eval "! said ${name} 'code object is not signed at all' && ran ${name} 'codesign --verify --deep --strict'"
    check "helper not signed first (linker-signed): the read-back names the linker's identifier" \
      said "${name}" "Test copy: dist/True Convo Test.app/Contents/MacOS/ParticipantSupervisor is signed with identifier \"ParticipantSupervisor\", not \"${SUPERVISOR_IDENTIFIER}\"."
  else
    check "helper not signed first (unsigned): the app signing refused the unsigned helper" said "${name}" "code object is not signed at all"
  fi
  check "helper not signed first (${kind}): the app was removed" \
    eval "said ${name} 'Removed dist/True Convo Test.app.' && [ ! -e '${WORK}/${name}/repo/apps/true-convo-mac/dist/True Convo Test.app' ]"
done

# 27. Program files other than the app's program and the helper are refused,
#     wherever they are: test-only products and the packaging tool slipped
#     into the Desk output (an invented file that starts like a 64-bit Mach-O,
#     and once a copy of /usr/bin/true), a program file disguised as an
#     image, and an extra file in Contents/MacOS (a copy of the script that
#     also bundles DeskBundleManifest there). Each removes the half-made app,
#     signs nothing, and removes the Desk build's temporary folder.
INVENTED_MACHO="${WORK}/invented-macho"
printf '\xcf\xfa\xed\xfe invented bytes, not a program\n' > "${INVENTED_MACHO}"
REAL_MACHO="${WORK}/copy-of-true"
cp /usr/bin/true "${REAL_MACHO}"
for name in ParticipantFakeCLI ParticipantTestHost ParticipantPausingSupervisor ParticipantAvailabilityProbe DeskBundleManifest invented-image.png real-ParticipantFakeCLI; do
  case_name="test-macho-${name%.png}"
  make_case "${case_name}"
  macho="${INVENTED_MACHO}"
  bundled_name="${name}"
  if [[ "${name}" == real-* ]]; then macho="${REAL_MACHO}"; bundled_name="${name#real-}"; fi
  SCRIPT_ARGS=(--test-identity)
  run_package "${case_name}" STUB_NPM_AFTER=macho STUB_MACHO="${macho}" STUB_MACHO_NAME="${bundled_name}"
  SCRIPT_ARGS=()
  check "program file ${name} in the Desk output: refused (exit 1)" [ "${STATUS}" -eq 1 ]
  check "program file ${name} in the Desk output: plain message" said "${case_name}" "Test copy: Contents/Resources/Desk/assets/${bundled_name} is a program file (Mach-O); the test copy may hold only Contents/MacOS/True Convo Test and Contents/MacOS/ParticipantSupervisor. Removed dist/True Convo Test.app; nothing was signed."
  check "program file ${name} in the Desk output: the half-made app was removed, nothing signed, temporary folder removed" \
    eval "[ ! -e '${WORK}/${case_name}/repo/apps/true-convo-mac/dist/True Convo Test.app' ] && ! ran ${case_name} codesign && [ -z \"\$(find '${WORK}/${case_name}/tmp' -mindepth 1 -print)\" ]"
done
check "the real Mach-O case used a real program file" eval '[ "$(head -c 4 "${REAL_MACHO}" | od -An -tx1 | tr -d " \n")" == "cafebabe" ] || [ "$(head -c 4 "${REAL_MACHO}" | od -An -tx1 | tr -d " \n")" == "cffaedfe" ]'

make_case test-extra-in-macos
EXTRA_SCRIPT="${WORK}/test-extra-in-macos/repo/apps/true-convo-mac/scripts/package_app.sh"
sed -i '' 's/^  copy_test_copy_supervisor$/  copy_test_copy_supervisor; cp "${DESK_MANIFEST_TOOL}" "${MACOS_DIR}\/DeskBundleManifest"/' "${EXTRA_SCRIPT}"
check "extra file in Contents/MacOS: the copy bundles DeskBundleManifest there" grep -qF 'cp "${DESK_MANIFEST_TOOL}" "${MACOS_DIR}/DeskBundleManifest"' "${EXTRA_SCRIPT}"
SCRIPT_ARGS=(--test-identity)
run_package test-extra-in-macos TRUE_CONVO_WITH_DESK=0
SCRIPT_ARGS=()
check "extra file in Contents/MacOS: refused (exit 1)" [ "${STATUS}" -eq 1 ]
check "extra file in Contents/MacOS: plain message" said test-extra-in-macos 'Test copy: Contents/MacOS holds "DeskBundleManifest|ParticipantSupervisor|True Convo Test|", not exactly "ParticipantSupervisor|True Convo Test|". Removed dist/True Convo Test.app; nothing was signed.'
check "extra file in Contents/MacOS: removed, nothing signed" eval '[ ! -e "${WORK}/test-extra-in-macos/repo/apps/true-convo-mac/dist/True Convo Test.app" ] && ! ran test-extra-in-macos codesign'

# 28. A checkout with local changes or an untracked file: --test-identity is
#     refused before anything is built (Desk off, so only the whole-checkout
#     check can see it), while the release build of the same checkout still
#     packages exactly as before. Ignored files (node_modules, .build, dist)
#     never count.
for kind in untracked modified; do
  for side in test release; do
    name="dirty-${kind}-${side}"
    make_case "${name}"
    if [[ "${kind}" == "untracked" ]]; then
      printf 'invented untracked file\n' > "${WORK}/${name}/repo/INVENTED-UNTRACKED.txt"
    else
      printf 'invented local change\n' >> "${WORK}/${name}/repo/apps/desk/package.json"
    fi
    [[ "${side}" == "test" ]] && SCRIPT_ARGS=(--test-identity)
    run_package "${name}" TRUE_CONVO_WITH_DESK=0
    SCRIPT_ARGS=()
    if [[ "${side}" == "test" ]]; then
      check "dirty checkout (${kind}): --test-identity refused (exit 1)" [ "${STATUS}" -eq 1 ]
      check "dirty checkout (${kind}): plain message" said "${name}" "Test copy: the checkout has local changes or untracked files; refusing to package them. Save or set them aside first. Nothing was built or changed."
      check "dirty checkout (${kind}): nothing was built for the test copy" eval "! swift_ran ${name} && [ ! -e '${WORK}/${name}/repo/apps/true-convo-mac/dist' ]"
    else
      check "dirty checkout (${kind}): the release build still packages (exit 0)" eval "[ \"\${STATUS}\" -eq 0 ] && said ${name} 'Packaged ${WORK}/${name}/repo/apps/true-convo-mac/dist/True Convo.app'"
    fi
  done
done

# 28b. Changes git's own settings would hide from a plain `git status
#      --porcelain` are refused too: an untracked source file under
#      status.showUntrackedFiles=no (set in the invented repository's own
#      config), and a local change to a tracked file marked assume-unchanged
#      or skip-worktree. Each case first shows that a plain status lists
#      nothing.
for kind in untracked-hidden assume-unchanged skip-worktree; do
  name="hidden-${kind}"
  make_case "${name}"
  HIDDEN_REPO="${WORK}/${name}/repo"
  case "${kind}" in
    untracked-hidden)
      git -C "${HIDDEN_REPO}" config status.showUntrackedFiles no
      mkdir -p "${HIDDEN_REPO}/apps/desk/src"
      printf '// invented untracked source\n' > "${HIDDEN_REPO}/apps/desk/src/Invented.swift"
      expected_message="Test copy: the checkout has local changes or untracked files; refusing to package them. Save or set them aside first. Nothing was built or changed."
      ;;
    assume-unchanged|skip-worktree)
      git -C "${HIDDEN_REPO}" update-index "--${kind}" apps/desk/package.json
      printf 'invented hidden local change\n' >> "${HIDDEN_REPO}/apps/desk/package.json"
      expected_message="Test copy: git is told to treat some tracked files as unchanged (assume-unchanged or skip-worktree), so their local changes would not show; refusing to package. Clear those marks first. Nothing was built or changed."
      ;;
  esac
  check "hidden change (${kind}): a plain git status lists nothing" [ -z "$(git -C "${HIDDEN_REPO}" status --porcelain)" ]
  SCRIPT_ARGS=(--test-identity)
  run_package "${name}" TRUE_CONVO_WITH_DESK=0
  SCRIPT_ARGS=()
  check "hidden change (${kind}): --test-identity refused (exit 1)" [ "${STATUS}" -eq 1 ]
  check "hidden change (${kind}): plain message" said "${name}" "${expected_message}"
  check "hidden change (${kind}): nothing was built" eval "! swift_ran ${name} && [ ! -e '${WORK}/${name}/repo/apps/true-convo-mac/dist' ]"
done

# 28c. The checkout changes while packaging (an untracked file appears, or a
#      new commit moves HEAD): the check right before signing refuses, the
#      half-made app is removed and nothing is signed.
make_case test-dirty-during-build
SCRIPT_ARGS=(--test-identity)
run_package test-dirty-during-build TRUE_CONVO_WITH_DESK=0 STUB_SWIFT_DIRTY="${WORK}/test-dirty-during-build/repo/apps/desk/INVENTED-DURING-BUILD.txt"
SCRIPT_ARGS=()
check "changed while packaging: refused (exit 1)" [ "${STATUS}" -eq 1 ]
check "changed while packaging: plain messages" eval 'said test-dirty-during-build "Test copy: the checkout has local changes or untracked files; refusing to package them. Save or set them aside first. Nothing was signed." && said test-dirty-during-build "Test copy: packaging stopped before signing (exit 1). Removed dist/True Convo Test.app; nothing was signed."'
check "changed while packaging: removed, nothing signed" eval '[ ! -e "${WORK}/test-dirty-during-build/repo/apps/true-convo-mac/dist/True Convo Test.app" ] && ! ran test-dirty-during-build codesign'

make_case test-moved-during-build
MOVED_FROM="$(git -C "${WORK}/test-moved-during-build/repo" rev-parse HEAD)"
SCRIPT_ARGS=(--test-identity)
run_package test-moved-during-build TRUE_CONVO_WITH_DESK=0 STUB_SWIFT_COMMIT="${WORK}/test-moved-during-build/repo"
SCRIPT_ARGS=()
MOVED_TO="$(git -C "${WORK}/test-moved-during-build/repo" rev-parse HEAD)"
check "moved while packaging: the stand-in build did make a new commit" [ "${MOVED_FROM}" != "${MOVED_TO}" ]
check "moved while packaging: refused (exit 1)" [ "${STATUS}" -eq 1 ]
check "moved while packaging: plain message" said test-moved-during-build "Test copy: the checkout moved from ${MOVED_FROM} to ${MOVED_TO} while packaging; refusing. Nothing was signed."
check "moved while packaging: removed, nothing signed" eval '[ ! -e "${WORK}/test-moved-during-build/repo/apps/true-convo-mac/dist/True Convo Test.app" ] && ! ran test-moved-during-build codesign'

# 29. Packaging twice in an invented checkout that tracks the script and uses
#     this repository's real ignore rules (the top-level .gitignore and the
#     Mac app's own), with real program files (copies of /usr/bin/true, never
#     run) as the program and the helper: both runs package, the checkout is
#     still clean after each (.build/test-identity and dist are ignored), and
#     both record the same TCSourceCommit, the checkout's HEAD.
make_case test-twice
TWICE_REPO="${WORK}/test-twice/repo"
TWICE_MAC="${TWICE_REPO}/apps/true-convo-mac"
cp "${HERE}/../../../../.gitignore" "${TWICE_REPO}/.gitignore"
cp "${HERE}/../../.gitignore" "${TWICE_MAC}/.gitignore"
cp /usr/bin/true "${TWICE_MAC}/.build/test-identity/release/VoiceCursorMac"
cp /usr/bin/true "${TWICE_MAC}/.build/test-identity/release/ParticipantSupervisor"
git -C "${TWICE_REPO}" add -A
GIT_AUTHOR_DATE="2026-01-01T00:00:00Z" GIT_COMMITTER_DATE="2026-01-01T00:00:00Z" \
  git -C "${TWICE_REPO}" -c user.name=Invented -c user.email=invented@example.invalid commit -qm "invented, with the real ignore rules"
check "twice: the invented checkout tracks the script and ignores .build" \
  eval 'git -C "${TWICE_REPO}" ls-files --error-unmatch apps/true-convo-mac/scripts/package_app.sh >/dev/null 2>&1 && git -C "${TWICE_REPO}" check-ignore -q apps/true-convo-mac/.build/test-identity/release/ParticipantSupervisor'
check "twice: it starts clean" [ -z "$(git -C "${TWICE_REPO}" status --porcelain --untracked-files=all)" ]
TWICE_HEAD="$(git -C "${TWICE_REPO}" rev-parse HEAD)"
for round in first second; do
  SCRIPT_ARGS=(--test-identity)
  run_package test-twice TRUE_CONVO_WITH_DESK=0
  SCRIPT_ARGS=()
  TWICE_APP="${TWICE_MAC}/dist/True Convo Test.app"
  check "twice (${round} run): packaged (exit 0)" [ "${STATUS}" -eq 0 ]
  check "twice (${round} run): the checkout is still clean" [ -z "$(git -C "${TWICE_REPO}" status --porcelain --untracked-files=all)" ]
  check "twice (${round} run): TCSourceCommit is the checkout's HEAD" [ "$(plist_value "${TWICE_APP}/Contents/Info.plist" TCSourceCommit)" == "${TWICE_HEAD}" ]
  check "twice (${round} run): the test copy's layout" [ "$(layout "${TWICE_APP}")" == "${APP_LAYOUT_TEST}" ]
  check "twice (${round} run): the real program files in Contents/MacOS were allowed" \
    eval 'cmp -s "${TWICE_APP}/Contents/MacOS/ParticipantSupervisor" /usr/bin/true && cmp -s "${TWICE_APP}/Contents/MacOS/True Convo Test" /usr/bin/true'
done
check "twice: each run signed the helper with its identifier" [ "$(grep -c "^codesign --force --timestamp=none --sign - --identifier ${SUPERVISOR_IDENTIFIER} " "${WORK}/test-twice/stub.log")" -eq 2 ]

# 30. The refusals that keep the test copy off ~/Applications and away from
#     signing identities still come before the clean-checkout check, the
#     build and anything else, even in a dirty checkout.
make_case test-install-dirty
printf 'invented untracked file\n' > "${WORK}/test-install-dirty/repo/INVENTED-UNTRACKED.txt"
SCRIPT_ARGS=(--test-identity --install)
run_package test-install-dirty TRUE_CONVO_WITH_DESK=0
SCRIPT_ARGS=()
check "--install in a dirty checkout: still the --install refusal (exit 2)" eval '[ "${STATUS}" -eq 2 ] && said test-install-dirty "Test copy: --test-identity never installs." && ! said test-install-dirty "the checkout has local changes"'
make_case test-signed-dirty
printf 'invented untracked file\n' > "${WORK}/test-signed-dirty/repo/INVENTED-UNTRACKED.txt"
SCRIPT_ARGS=(--test-identity)
run_package test-signed-dirty TRUE_CONVO_WITH_DESK=0 TRUE_CONVO_SIGN_IDENTITY=0123456789abcdef0123456789abcdef01234567
SCRIPT_ARGS=()
check "a signing identity in a dirty checkout: still that refusal (exit 2), no Keychain lookup, nothing signed" \
  eval '[ "${STATUS}" -eq 2 ] && said test-signed-dirty "Test copy: --test-identity is always ad-hoc signed" && ! ran test-signed-dirty security && ! ran test-signed-dirty codesign'

# 31. .build/test-identity (or .build) that is a link: refused before
#     anything is built, the link's target unchanged.
for linked in .build/test-identity .build; do
  name="test-build-link-${linked//[.\/]/}"
  make_case "${name}"
  MAC="${WORK}/${name}/repo/apps/true-convo-mac"
  TARGET="${WORK}/${name}/target"
  make_target "${TARGET}"
  BEFORE="$(tree_state "${TARGET}")"
  rm -rf "${MAC:?}/${linked}"
  ln -s "${TARGET}" "${MAC}/${linked}"
  SCRIPT_ARGS=(--test-identity)
  run_package "${name}" TRUE_CONVO_WITH_DESK=0
  SCRIPT_ARGS=()
  check "linked ${linked}: refused (exit 1)" [ "${STATUS}" -eq 1 ]
  check "linked ${linked}: plain message" said "${name}" "Test copy: ${linked} is a symbolic link; refusing to build through it. Nothing was built or changed."
  check "linked ${linked}: nothing was built" eval "! swift_ran ${name}"
  check "linked ${linked}: the target is unchanged" [ "$(tree_state "${TARGET}")" == "${BEFORE}" ]
done

# 32. Desk install (step 1, PR 4). A clean checkout installs the Desk build
#     into the invented Applications folder, backed up and opened by the
#     stand-ins, with TCSourceCommit naming the checkout's commit. A dirty
#     checkout, or one that changes while packaging, is refused and nothing
#     is signed, installed, quit or opened.
make_case desk-install
make_apps_target "${WORK}/desk-install/home/Applications"
DESK_INSTALL_COMMIT="$(git -C "${WORK}/desk-install/repo" rev-parse HEAD)"
SCRIPT_ARGS=(--install)
run_package desk-install
SCRIPT_ARGS=()
INSTALLED="${WORK}/desk-install/home/Applications/True Convo.app"
check "Desk install: packaged and installed (exit 0)" [ "${STATUS}" -eq 0 ]
check "Desk install: the installed app carries the Desk" [ -f "${INSTALLED}/Contents/Resources/Desk/index.html" ]
check "Desk install: TCSourceCommit names the checkout's commit" \
  [ "$(/usr/bin/plutil -extract TCSourceCommit raw -o - "${INSTALLED}/Contents/Info.plist" 2>/dev/null)" == "${DESK_INSTALL_COMMIT}" ]
check "Desk install: TCDeskSourceCommit is there too" /usr/bin/plutil -extract TCDeskSourceCommit raw -o - "${INSTALLED}/Contents/Info.plist"
check "Desk install: the old app was backed up and the new one opened" \
  eval 'ran desk-install open && [ -n "$(find "${WORK}/desk-install/repo/apps/true-convo-mac/dist/install-backups" -name CANARY.txt -path "*True Convo.app*" -print)" ]'
check "Desk install: says which commit it installed" said desk-install "Desk install: source commit ${DESK_INSTALL_COMMIT} (TCSourceCommit)."
check "Desk install: no trial-build refusal any more" eval '! said desk-install "trial build"'

make_case desk-install-dirty
make_apps_target "${WORK}/desk-install-dirty/home/Applications"
APPS_BEFORE_DIRTY="$(tree_state "${WORK}/desk-install-dirty/home/Applications")"
printf 'invented untracked file\n' > "${WORK}/desk-install-dirty/repo/INVENTED-UNTRACKED.txt"
SCRIPT_ARGS=(--install)
run_package desk-install-dirty
SCRIPT_ARGS=()
check "Desk install, dirty checkout: refused (exit 1)" [ "${STATUS}" -eq 1 ]
check "Desk install, dirty checkout: plain message" said desk-install-dirty "Desk install: the checkout has local changes or untracked files; refusing to package them. Save or set them aside first. Nothing was built, signed or installed."
check "Desk install, dirty checkout: nothing built, signed, quit or opened" \
  eval '! swift_ran desk-install-dirty && ! ran desk-install-dirty codesign && ! ran desk-install-dirty pkill && ! ran desk-install-dirty open'
check "Desk install, dirty checkout: the invented Applications folder is untouched" [ "$(tree_state "${WORK}/desk-install-dirty/home/Applications")" == "${APPS_BEFORE_DIRTY}" ]

make_case desk-install-changed
make_apps_target "${WORK}/desk-install-changed/home/Applications"
APPS_BEFORE_CHANGED="$(tree_state "${WORK}/desk-install-changed/home/Applications")"
SCRIPT_ARGS=(--install)
run_package desk-install-changed STUB_SWIFT_DIRTY="${WORK}/desk-install-changed/repo/INVENTED-DURING-BUILD.txt"
SCRIPT_ARGS=()
check "Desk install, changed while packaging: refused (exit 1)" [ "${STATUS}" -eq 1 ]
check "Desk install, changed while packaging: plain message" said desk-install-changed "Desk install: the checkout has local changes or untracked files; refusing to package them. Save or set them aside first. Nothing was signed or installed."
check "Desk install, changed while packaging: nothing signed, quit or opened" \
  eval '! ran desk-install-changed codesign && ! ran desk-install-changed pkill && ! ran desk-install-changed open'
check "Desk install, changed while packaging: the invented Applications folder is untouched" [ "$(tree_state "${WORK}/desk-install-changed/home/Applications")" == "${APPS_BEFORE_CHANGED}" ]

make_case desk-signed
run_package desk-signed TRUE_CONVO_SIGN_IDENTITY=0123456789abcdef0123456789abcdef01234567
check "Desk build with a signing identity: no trial-build refusal; it reaches the Keychain check (exit 2, no certificate)" \
  eval '[ "${STATUS}" -eq 2 ] && ran desk-signed security && said desk-signed "No valid Developer ID Application certificate" && ! said desk-signed "trial build"'

make_case desk-plain-no-commit
run_package desk-plain-no-commit
check "Desk build without --install or signing: unchanged, no TCSourceCommit" \
  eval '[ "${STATUS}" -eq 0 ] && ! /usr/bin/plutil -extract TCSourceCommit raw -o - "${WORK}/desk-plain-no-commit/repo/apps/true-convo-mac/dist/True Convo.app/Contents/Info.plist" >/dev/null 2>&1'

# 21. Unknown options are still refused.
make_case unknown-option
SCRIPT_ARGS=(--test)
run_package unknown-option TRUE_CONVO_WITH_DESK=0
SCRIPT_ARGS=()
check "unknown option: refused (exit 2)" [ "${STATUS}" -eq 2 ]
check "unknown option: nothing was built" eval '! swift_ran unknown-option'

check "the real Packaging/Info.plist is unchanged by this test run" [ "$(shasum -a 256 "${INFO_PLIST_SRC}")" == "${INFO_PLIST_SRC_BEFORE}" ]

if [[ "${FAILURES}" -ne 0 ]]; then
  echo "${FAILURES} check(s) failed." >&2
  exit 1
fi
echo "All package_app.sh Desk output, dist and test copy checks passed."
