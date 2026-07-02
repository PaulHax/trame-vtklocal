#!/usr/bin/env bash
#
# release.sh — build the trame-vtklocal fork wheel with a commit-stamped version,
# prove the UMD bundle embedded in the wheel byte-matches the freshly built one,
# and (optionally) publish it as a GitHub prerelease.
#
# Usage:
#   ./release.sh              build + verify, DO NOT publish (default, safe)
#   ./release.sh --publish    build + verify, then create/refresh the GitHub
#                             prerelease and print the exact app pin (URL + sha256)
#
# Env overrides:
#   PYTHON   python interpreter used for the build (default: python3;
#            must have `build` + `hatchling` available for isolated builds)
#
# The wheel version is <BASE_VERSION>+shared-context.<short-sha> (see
# hatch_build.py). The same short sha is exported so the build hook and the
# release tag agree. Safe to re-run.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

PYTHON="${PYTHON:-python3}"
UMD_REL="src/trame_vtklocal/module/serve/js/trame_vtklocal.umd.js"

PUBLISH=0
for arg in "$@"; do
  case "$arg" in
    --publish) PUBLISH=1 ;;
    -h|--help)
      sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "release.sh: unknown argument '$arg' (use --publish or --help)" >&2
      exit 2
      ;;
  esac
done

die() { echo "release.sh: ERROR: $*" >&2; exit 1; }
step() { echo; echo "==> $*"; }

# --- sha + version ---------------------------------------------------------
git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1 || die "not a git repo: $ROOT"
SHA="$(git -C "$ROOT" rev-parse --short HEAD)"
export TRAME_VTKLOCAL_SHA="$SHA"
BASE="$(sed -n 's/^BASE_VERSION *= *"\(.*\)".*/\1/p' hatch_build.py | head -n1)"
[ -n "$BASE" ] || die "could not read BASE_VERSION from hatch_build.py"
TAG="v${BASE}-shared-context.${SHA}"
echo "commit=${SHA}  base=${BASE}  tag=${TAG}"

# --- build the vue components (produces the UMD bundle) --------------------
step "Building vue-components (npm run build)"
( cd vue-components && npm run build ) || die "vue-components build failed"
[ -f "$UMD_REL" ] || die "expected UMD not found after build: $UMD_REL"
SRC_UMD_SHA="$(sha256sum "$UMD_REL" | awk '{print $1}')"
echo "freshly built UMD sha256=${SRC_UMD_SHA}"

# --- build the wheel -------------------------------------------------------
step "Building wheel (python -m build --wheel)"
# Clear prior fork wheels so exactly one wheel remains → unambiguous + idempotent.
rm -f dist/trame_vtklocal-*.whl
"$PYTHON" -m build --wheel --outdir dist . || die "wheel build failed"

shopt -s nullglob
WHEELS=(dist/trame_vtklocal-*.whl)
shopt -u nullglob
[ "${#WHEELS[@]}" -eq 1 ] || die "expected exactly one wheel in dist/, found ${#WHEELS[@]}"
WHEEL="${WHEELS[0]}"
echo "built wheel: ${WHEEL}"

# --- assert the wheel's embedded UMD byte-matches the fresh one ------------
step "Verifying embedded UMD matches freshly built UMD"
"$PYTHON" - "$WHEEL" "$SRC_UMD_SHA" <<'PY'
import hashlib, sys, zipfile
wheel, src_sha = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(wheel) as z:
    hits = [n for n in z.namelist()
            if n.endswith("module/serve/js/trame_vtklocal.umd.js")]
    if len(hits) != 1:
        sys.exit(f"FAIL: expected 1 UMD entry in wheel, found {len(hits)}: {hits}")
    wheel_sha = hashlib.sha256(z.read(hits[0])).hexdigest()
print(f"  wheel UMD : {hits[0]}")
print(f"  wheel sha : {wheel_sha}")
print(f"  source sha: {src_sha}")
if wheel_sha != src_sha:
    sys.exit("FAIL: embedded UMD does NOT match the freshly built UMD")
print("UMD HASH-ASSERT PASS: wheel UMD byte-matches vue-components build")
PY

# --- report the stamped version -------------------------------------------
VERSION="$("$PYTHON" - "$WHEEL" <<'PY'
import re, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    meta = next(n for n in z.namelist() if n.endswith(".dist-info/METADATA"))
    for line in z.read(meta).decode().splitlines():
        if line.startswith("Version:"):
            print(line.split(":", 1)[1].strip()); break
PY
)"
[ -n "$VERSION" ] || die "could not read Version from wheel METADATA"
case "$VERSION" in
  *"$SHA"*) : ;;
  *) die "wheel version '$VERSION' does not carry sha '$SHA'" ;;
esac

step "BUILD + VERIFY OK"
echo "  version : ${VERSION}"
echo "  wheel   : ${WHEEL}"
echo "  tag     : ${TAG}"

if [ "$PUBLISH" -ne 1 ]; then
  echo
  echo "Default build-and-verify mode: NOT publishing. Re-run with --publish to release."
  exit 0
fi

# --- publish ---------------------------------------------------------------
step "Publishing GitHub prerelease ${TAG}"
command -v gh >/dev/null 2>&1 || die "gh CLI not found"
gh auth status >/dev/null 2>&1 || die "gh not authenticated (run: gh auth login)"

if gh release view "$TAG" >/dev/null 2>&1; then
  echo "release ${TAG} exists — uploading wheel with --clobber"
  gh release upload "$TAG" "$WHEEL" --clobber || die "asset upload failed"
else
  gh release create "$TAG" "$WHEEL" \
    --prerelease \
    --title "$TAG" \
    --notes "Fork build of trame-vtklocal at ${SHA} (version ${VERSION})." \
    || die "gh release create failed"
fi

# Derive the true asset download URL from GitHub (it sanitizes filenames, so we
# read back what it actually served rather than guessing).
DL_URL="$(gh release view "$TAG" --json assets \
  -q '.assets[] | select(.name | endswith(".whl")) | .url' | head -n1)"
[ -n "$DL_URL" ] || die "could not read uploaded asset URL from release ${TAG}"
WHEEL_SHA="$(sha256sum "$WHEEL" | awk '{print $1}')"

step "PUBLISHED — paste into the app's pyproject.toml"
echo
echo "trame-vtklocal = { url = \"${DL_URL}\" }"
echo
echo "# sha256 = ${WHEEL_SHA}"
