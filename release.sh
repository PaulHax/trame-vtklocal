#!/usr/bin/env bash
#
# release.sh — build the trame-vtklocal fork wheel with a commit-stamped version,
# prove it was built from the pinned dependency chain and that the UMD bundle
# embedded in the wheel byte-matches the freshly built one, and (optionally)
# publish it as a GitHub prerelease.
#
# Usage:
#   ./release.sh              build + verify, DO NOT publish (default, safe)
#   ./release.sh --publish    build + verify, then create/refresh the GitHub
#                             prerelease and print the exact app pin (URL + sha256)
#
# The `.github/workflows/build-fork-wheel.yml` CI job runs `./release.sh
# --publish` on every push to `shared-context`, so this is the single source of
# truth for both local and CI releases. In CI, `GH_TOKEN`/`GITHUB_TOKEN`
# supplies gh auth (no interactive `gh auth login` needed).
#
# Env overrides:
#   PYTHON              python interpreter used for the build (default: python3;
#                       must have `build` + `hatchling` for isolated builds)
#   EXPECT_UMD_SHA256   refuse to proceed unless the rebuilt bundle is exactly
#                       this one. CI validates a wheel, then re-runs with
#                       --publish, and sets this so only the bundle the browser
#                       smoke tests exercised can be released.
#
# The wheel version is <BASE_VERSION>+shared-context.<short-sha> (see
# hatch_build.py). The same short sha is exported so the build hook and the
# release tag agree. Safe to re-run.
#
# The vtk.js the bundle carries is pinned by commit in `vtkjs-fork.env`, and
# `verify_chain.py` refuses to release a bundle built from anything else. The
# resulting build-info.json ships inside the wheel, so an installed wheel can be
# asked which vtk.js and which pointcloud-lod it was built from.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

PYTHON="${PYTHON:-python3}"
UMD_REL="src/trame_vtklocal/module/serve/js/trame_vtklocal.umd.js"
# Written by verify_chain.py next to the bundle, so hatch's serve/js/** include
# ships it in the wheel alongside the bundle it describes.
BUILD_INFO_REL="src/trame_vtklocal/module/serve/js/build-info.json"
EVIDENCE_REL="dist/release-evidence.json"

PUBLISH=0
for arg in "$@"; do
  case "$arg" in
    --publish) PUBLISH=1 ;;
    -h|--help)
      sed -n '2,33p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
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

# --- pinned dependency chain -----------------------------------------------
[ -f "$ROOT/vtkjs-fork.env" ] || die "missing vtkjs-fork.env (the vtk.js pin)"
# shellcheck source=vtkjs-fork.env
. "$ROOT/vtkjs-fork.env"

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
if [ -n "${EXPECT_UMD_SHA256:-}" ] && [ "$EXPECT_UMD_SHA256" != "$SRC_UMD_SHA" ]; then
  die "rebuilt UMD ${SRC_UMD_SHA} is not the validated ${EXPECT_UMD_SHA256}"
fi

# --- prove the bundle came from the pinned chain ---------------------------
step "Verifying the pinned dependency chain"
"$PYTHON" verify_chain.py --umd "$UMD_REL" --build-info "$BUILD_INFO_REL" \
  || die "chain verification failed"
BUILD_INFO_SHA="$(sha256sum "$BUILD_INFO_REL" | awk '{print $1}')"

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

# --- assert the wheel embeds the fresh bundle and its build info -----------
step "Verifying the wheel embeds the freshly built bundle"
"$PYTHON" - "$WHEEL" \
  "module/serve/js/trame_vtklocal.umd.js=$SRC_UMD_SHA" \
  "module/serve/js/build-info.json=$BUILD_INFO_SHA" <<'PY'
import hashlib, sys, zipfile
wheel, *expected = sys.argv[1:]
with zipfile.ZipFile(wheel) as z:
    names = z.namelist()
    for item in expected:
        suffix, _, source_sha = item.partition("=")
        hits = [n for n in names if n.endswith(suffix)]
        if len(hits) != 1:
            sys.exit(f"FAIL: expected 1 {suffix} entry in wheel, found {len(hits)}: {hits}")
        wheel_sha = hashlib.sha256(z.read(hits[0])).hexdigest()
        print(f"  {hits[0]}")
        print(f"    wheel sha : {wheel_sha}")
        print(f"    source sha: {source_sha}")
        if wheel_sha != source_sha:
            sys.exit(f"FAIL: {suffix} in the wheel does NOT match the freshly built file")
print("HASH-ASSERT PASS: wheel carries the vue-components build and its build info")
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

# --- release evidence ------------------------------------------------------
# One file naming everything that went into this wheel, published beside it so a
# pinned wheel can be traced back to its inputs without rebuilding.
WHEEL_SHA="$(sha256sum "$WHEEL" | awk '{print $1}')"
"$PYTHON" - "$BUILD_INFO_REL" "$EVIDENCE_REL" "$WHEEL" "$WHEEL_SHA" "$VERSION" "$TAG" <<'PY'
import json, sys
from pathlib import Path
build_info, out, wheel, wheel_sha, version, tag = sys.argv[1:]
evidence = json.loads(Path(build_info).read_text())
evidence["wheel"] = {
    "name": Path(wheel).name,
    "sha256": wheel_sha,
    "version": version,
    "tag": tag,
}
Path(out).write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n")
PY
PCL_VERSION="$("$PYTHON" -c \
  'import json,sys; print(json.load(open(sys.argv[1]))["pointcloudLod"]["version"])' \
  "$BUILD_INFO_REL")"

step "BUILD + VERIFY OK"
echo "  version        : ${VERSION}"
echo "  wheel          : ${WHEEL}"
echo "  wheel sha256   : ${WHEEL_SHA}"
echo "  tag            : ${TAG}"
echo "  vtk.js         : ${VTKJS_FORK_COMMIT}"
echo "  pointcloud-lod : ${PCL_VERSION}"
echo "  evidence       : ${EVIDENCE_REL}"

if [ "$PUBLISH" -ne 1 ]; then
  echo
  echo "Default build-and-verify mode: NOT publishing. Re-run with --publish to release."
  exit 0
fi

# --- publish ---------------------------------------------------------------
step "Publishing GitHub prerelease ${TAG}"
command -v gh >/dev/null 2>&1 || die "gh CLI not found"
# In CI, GH_TOKEN/GITHUB_TOKEN authenticates gh non-interactively; only fall
# back to the interactive-login check when no token is present.
if [ -z "${GH_TOKEN:-}${GITHUB_TOKEN:-}" ]; then
  gh auth status >/dev/null 2>&1 || die "gh not authenticated (run: gh auth login, or set GH_TOKEN)"
fi

NOTES="$(cat <<EOF
Fork build of trame-vtklocal at ${SHA} (version ${VERSION}).

Embedded chain (see the attached release-evidence.json):

- vtk.js ${VTKJS_FORK_REPO} @ \`${VTKJS_FORK_COMMIT}\`
- pointcloud-lod ${PCL_VERSION}
- UMD sha256 \`${SRC_UMD_SHA}\`
- wheel sha256 \`${WHEEL_SHA}\`
EOF
)"

if gh release view "$TAG" >/dev/null 2>&1; then
  echo "release ${TAG} exists — uploading wheel + evidence with --clobber"
  gh release upload "$TAG" "$WHEEL" "$EVIDENCE_REL" --clobber || die "asset upload failed"
else
  gh release create "$TAG" "$WHEEL" "$EVIDENCE_REL" \
    --prerelease \
    --title "$TAG" \
    --notes "$NOTES" \
    || die "gh release create failed"
fi

# Derive the true asset download URL from GitHub (it sanitizes filenames, so we
# read back what it actually served rather than guessing).
DL_URL="$(gh release view "$TAG" --json assets \
  -q '.assets[] | select(.name | endswith(".whl")) | .url' | head -n1)"
[ -n "$DL_URL" ] || die "could not read uploaded asset URL from release ${TAG}"

step "PUBLISHED — paste into the app's pyproject.toml"
echo
echo "trame-vtklocal = { url = \"${DL_URL}\" }"
echo
echo "# sha256 = ${WHEEL_SHA}"
