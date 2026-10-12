#!/usr/bin/env bash
# Invented-data checks of how scripts/package_app.sh handles the Desk build
# output (Codex review B1) and the dist folder the app is assembled in (review
# F1: a dist link must not send the delete or the build elsewhere). Each case
# runs a copy of the script in its own
# throwaway folder, with stand-ins for swift, npm (which behaves like Vite,
# emptying native-dist through a link when no output folder is named),
# iconutil and codesign. It never builds the real app, signs, installs,
# launches anything, uses the network, or touches anything outside its temp
# folder. Every link points at an invented folder inside that temp folder.
#
#   scripts/tests/package_app_desk_output_test.sh
#
# SCRIPT_UNDER_TEST may name another copy of package_app.sh (for example an
# older one, to see these cases catch the old behaviour). KEEP=1 keeps the
# temp folder for inspection.
set -euo pipefail
export LC_ALL=C

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_UNDER_TEST="${SCRIPT_UNDER_TEST:-${HERE}/../package_app.sh}"
INFO_PLIST_SRC="${HERE}/../../Packaging/Info.plist"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/package-app-desk-test.XXXXXXXX")"
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
cat > "${BIN}/swift" <<'STUB'
#!/bin/bash
echo "swift $*" >> "${STUB_LOG}"
STUB
cat > "${BIN}/codesign" <<'STUB'
#!/bin/bash
echo "codesign $*" >> "${STUB_LOG}"
STUB
cat > "${BIN}/iconutil" <<'STUB'
#!/bin/bash
echo "iconutil $*" >> "${STUB_LOG}"
out=""; previous=""
for argument in "$@"; do [[ "${previous}" == "-o" ]] && out="${argument}"; previous="${argument}"; done
printf 'invented icns\n' > "${out}"
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
esac
STUB
chmod 755 "${BIN}"/*

# --- an invented checkout ----------------------------------------------------
# <case>/repo/apps/{true-convo-mac,desk}, a git repository with one commit.
# The ignore rule covers native-dist whether it is a folder, file or link, so
# only package_app.sh's own checks can refuse it.
make_case() {
  local dir="${WORK}/$1" mac
  mac="${dir}/repo/apps/true-convo-mac"
  mkdir -p "${mac}/scripts" "${mac}/Packaging" "${mac}/.build/release" "${dir}/repo/apps/desk/node_modules" "${dir}/home" "${dir}/tmp"
  cp "${SCRIPT_UNDER_TEST}" "${mac}/scripts/package_app.sh"
  cp "${INFO_PLIST_SRC}" "${mac}/Packaging/Info.plist"
  printf 'invented png\n' > "${mac}/Packaging/TrueConvoIcon.png"
  printf '#!/bin/sh\nexit 0\n' > "${mac}/.build/release/VoiceCursorMac"
  cat > "${mac}/.build/release/DeskBundleManifest" <<'TOOL'
#!/bin/bash
if [[ "$1" == "write" ]]; then printf '{"invented":true}\n' > "$3"; else [[ -f "$3" && -f "$2/index.html" ]]; fi
TOOL
  chmod 755 "${mac}/.build/release/"*
  printf '{"name":"invented-desk","private":true}\n' > "${dir}/repo/apps/desk/package.json"
  printf 'node_modules\nnative-dist\napps/true-convo-mac/\n' > "${dir}/repo/.gitignore"
  git -C "${dir}/repo" init -q
  git -C "${dir}/repo" add .gitignore apps/desk/package.json
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

run_package() {
  local dir="${WORK}/$1"
  shift
  set +e
  (cd "${dir}/repo/apps/true-convo-mac" && env -i PATH="${BIN}:/usr/bin:/bin:/usr/sbin:/sbin" HOME="${dir}/home" \
    TMPDIR="${dir}/tmp" STUB_LOG="${dir}/stub.log" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
    TRUE_CONVO_WITH_DESK=1 "$@" bash scripts/package_app.sh) > "${dir}/output.txt" 2>&1
  STATUS=$?
  set -e
  touch "${dir}/stub.log"
}

said() { grep -qF "$2" "${WORK}/$1/output.txt"; }
npm_ran() { grep -q '^npm ' "${WORK}/$1/stub.log"; }
swift_ran() { grep -q '^swift ' "${WORK}/$1/stub.log"; }
no_desk_bundled() { [[ ! -e "${WORK}/$1/repo/apps/true-convo-mac/dist/True Convo.app/Contents/Resources/Desk" ]]; }

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

if [[ "${FAILURES}" -ne 0 ]]; then
  echo "${FAILURES} check(s) failed." >&2
  exit 1
fi
echo "All package_app.sh Desk output and dist checks passed."
