#!/usr/bin/env bash
#
# release.sh: build the trame-vtklocal fork wheel with a commit-stamped version
# and prove it was built from the pinned dependency chain, or publish the wheel
# a build left in dist/ as a GitHub prerelease.
#
# Usage:
#   ./release.sh build     build + verify the wheel and write
#                          dist/release-evidence.json; publishes nothing
#   ./release.sh publish   publish the dist/ wheel and its evidence as the
#                          GitHub prerelease for HEAD and print the exact app
#                          pin (URL + sha256)
#
# `publish` never builds: it uploads the wheel `build` produced, after checking
# that the evidence names HEAD and the wheel's sha256, so the wheel a release
# carries is the one tested between the two steps. The
# `.github/workflows/build-fork-wheel.yml` CI job runs `build`, tests that wheel,
# then runs `publish` on every push to `shared-context`, so this is the single
# source of truth for both local and CI releases. In CI, `GH_TOKEN`/
# `GITHUB_TOKEN` supplies gh auth (no interactive `gh auth login` needed).
#
# Env overrides:
#   PYTHON              python interpreter used for the build (default: python3;
#                       must have `build` + `hatchling` for isolated builds)
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

usage() { sed -n '2,33p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

case "${1:-}" in
  build | publish) COMMAND="$1" ;;
  -h | --help)
    usage
    exit 0
    ;;
  *)
    echo "release.sh: expected 'build' or 'publish' (see --help)" >&2
    exit 2
    ;;
esac
if [ "$#" -ne 1 ]; then
  echo "release.sh: '$COMMAND' takes no further arguments" >&2
  exit 2
fi

die() { echo "release.sh: ERROR: $*" >&2; exit 1; }
step() { echo; echo "==> $*"; }

# --- pinned dependency chain -----------------------------------------------
[ -f "$ROOT/vtkjs-fork.env" ] || die "missing vtkjs-fork.env (the vtk.js pin)"
# shellcheck source=vtkjs-fork.env
. "$ROOT/vtkjs-fork.env"

# --- sha + version ---------------------------------------------------------
git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1 || die "not a git repo: $ROOT"
FULL_SHA="$(git -C "$ROOT" rev-parse HEAD)"
SHA="$(git -C "$ROOT" rev-parse --short HEAD)"
export TRAME_VTKLOCAL_SHA="$SHA"
BASE="$(sed -n 's/^BASE_VERSION *= *"\(.*\)".*/\1/p' hatch_build.py | head -n1)"
[ -n "$BASE" ] || die "could not read BASE_VERSION from hatch_build.py"
TAG="v${BASE}-shared-context.${SHA}"
echo "commit=${SHA}  base=${BASE}  tag=${TAG}"

# The one fork wheel in dist/ (build clears older ones first).
dist_wheel() {
  shopt -s nullglob
  local wheels=(dist/trame_vtklocal-*.whl)
  shopt -u nullglob
  [ "${#wheels[@]}" -eq 1 ] || die "expected exactly one wheel in dist/, found ${#wheels[@]}"
  echo "${wheels[0]}"
}

build() {
  # Same-version development packages cannot be identified by package metadata
  # or npm's hidden lockfile (which --package-lock-only also rewrites). Install
  # the locked bytes before bundling and restore the verified vtk.js build link.
  step "Installing locked vue-components dependencies"
  local vtkjs_build
  vtkjs_build="$("$PYTHON" - <<'PYTHON_CODE'
import verify_chain as chain
chain.check_vtkjs(chain.read_pin())
print((chain.VUE / "node_modules" / "@kitware" / "vtk.js").resolve())
PYTHON_CODE
)"
  (
    cd vue-components
    npm ci &&
      mkdir -p node_modules/@kitware &&
      ln -s "$vtkjs_build" node_modules/@kitware/vtk.js
  ) || die "locked dependency installation failed"

  # --- build the vue components (produces the UMD bundle) ------------------
  step "Building vue-components (npm run build)"
  ( cd vue-components && npm run build ) || die "vue-components build failed"
  [ -f "$UMD_REL" ] || die "expected UMD not found after build: $UMD_REL"
  local umd_sha
  umd_sha="$(sha256sum "$UMD_REL" | awk '{print $1}')"
  echo "freshly built UMD sha256=${umd_sha}"

  # --- prove the bundle came from the pinned chain -------------------------
  step "Verifying the pinned dependency chain"
  "$PYTHON" verify_chain.py --umd "$UMD_REL" --build-info "$BUILD_INFO_REL" \
    || die "chain verification failed"
  local build_info_sha
  build_info_sha="$(sha256sum "$BUILD_INFO_REL" | awk '{print $1}')"

  # --- build the wheel -----------------------------------------------------
  step "Building wheel (python -m build --wheel)"
  # Clear prior fork wheels and evidence so exactly one wheel remains and no
  # evidence outlives the wheel it describes.
  rm -f dist/trame_vtklocal-*.whl "$EVIDENCE_REL"
  "$PYTHON" -m build --wheel --outdir dist . || die "wheel build failed"
  local wheel
  wheel="$(dist_wheel)"
  echo "built wheel: ${wheel}"

  # --- assert the wheel embeds the fresh bundle and its build info ---------
  step "Verifying the wheel embeds the freshly built bundle"
  "$PYTHON" - "$wheel" \
    "module/serve/js/trame_vtklocal.umd.js=$umd_sha" \
    "module/serve/js/build-info.json=$build_info_sha" <<'PY'
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

  # --- report the stamped version ------------------------------------------
  local version
  version="$("$PYTHON" - "$wheel" <<'PY'
import re, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    meta = next(n for n in z.namelist() if n.endswith(".dist-info/METADATA"))
    for line in z.read(meta).decode().splitlines():
        if line.startswith("Version:"):
            print(line.split(":", 1)[1].strip()); break
PY
)"
  [ -n "$version" ] || die "could not read Version from wheel METADATA"
  case "$version" in
    *"$SHA"*) : ;;
    *) die "wheel version '$version' does not carry sha '$SHA'" ;;
  esac

  # --- release evidence ----------------------------------------------------
  # One file naming everything that went into this wheel, published beside it
  # so a pinned wheel can be traced back to its inputs without rebuilding.
  local wheel_sha
  wheel_sha="$(sha256sum "$wheel" | awk '{print $1}')"
  "$PYTHON" - "$BUILD_INFO_REL" "$EVIDENCE_REL" "$wheel" "$wheel_sha" "$version" "$TAG" <<'PY'
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
  local pcl_version
  pcl_version="$("$PYTHON" -c \
    'import json,sys; print(json.load(open(sys.argv[1]))["pointcloudLod"]["version"])' \
    "$BUILD_INFO_REL")"

  step "BUILD + VERIFY OK"
  echo "  version        : ${version}"
  echo "  wheel          : ${wheel}"
  echo "  wheel sha256   : ${wheel_sha}"
  echo "  tag            : ${TAG}"
  echo "  vtk.js         : ${VTKJS_FORK_COMMIT}"
  echo "  pointcloud-lod : ${pcl_version}"
  echo "  evidence       : ${EVIDENCE_REL}"
  echo
  echo "Not published. Run './release.sh publish' to release this wheel."
}

publish() {
  step "Checking the dist/ wheel against its evidence"
  [ -f "$EVIDENCE_REL" ] || die "missing ${EVIDENCE_REL}; run './release.sh build' first"
  local wheel wheel_sha
  wheel="$(dist_wheel)"
  wheel_sha="$(sha256sum "$wheel" | awk '{print $1}')"
  # Prints the release fields, one per line, only when the evidence describes
  # exactly this wheel built from HEAD.
  local fields
  fields="$("$PYTHON" - "$EVIDENCE_REL" "$wheel" "$wheel_sha" "$FULL_SHA" "$TAG" <<'PY'
import json, sys
from pathlib import Path
path, wheel, wheel_sha, head, tag = sys.argv[1:]
evidence = json.loads(Path(path).read_text())
built = evidence["wheel"]
checks = {
    "commit": (evidence["bridgeCommit"], head),
    "tag": (built["tag"], tag),
    "wheel name": (built["name"], Path(wheel).name),
    "wheel sha256": (built["sha256"], wheel_sha),
}
for name, (recorded, actual) in checks.items():
    if recorded != actual:
        sys.exit(f"FAIL: evidence {name} is {recorded}, expected {actual}")
print(built["version"])
print(evidence["pointcloudLod"]["version"])
print(evidence["bundle"]["sha256"])
PY
)" || die "dist/ does not hold the wheel built from HEAD; run './release.sh build'"
  local version pcl_version umd_sha
  { read -r version; read -r pcl_version; read -r umd_sha; } <<<"$fields"
  echo "  wheel          : ${wheel}"
  echo "  wheel sha256   : ${wheel_sha}"
  echo "  version        : ${version}"

  step "Publishing GitHub prerelease ${TAG}"
  command -v gh >/dev/null 2>&1 || die "gh CLI not found"
  # In CI, GH_TOKEN/GITHUB_TOKEN authenticates gh non-interactively; only fall
  # back to the interactive-login check when no token is present.
  if [ -z "${GH_TOKEN:-}${GITHUB_TOKEN:-}" ]; then
    gh auth status >/dev/null 2>&1 || die "gh not authenticated (run: gh auth login, or set GH_TOKEN)"
  fi

  local notes
  notes="$(cat <<EOF
Fork build of trame-vtklocal at ${SHA} (version ${version}).

Embedded chain (see the attached release-evidence.json):

- vtk.js ${VTKJS_FORK_REPO} @ \`${VTKJS_FORK_COMMIT}\`
- pointcloud-lod ${pcl_version}
- UMD sha256 \`${umd_sha}\`
- wheel sha256 \`${wheel_sha}\`
EOF
)"

  if gh release view "$TAG" >/dev/null 2>&1; then
    echo "release ${TAG} exists — uploading wheel + evidence with --clobber"
    gh release upload "$TAG" "$wheel" "$EVIDENCE_REL" --clobber || die "asset upload failed"
  else
    gh release create "$TAG" "$wheel" "$EVIDENCE_REL" \
      --target "$FULL_SHA" \
      --prerelease \
      --title "$TAG" \
      --notes "$notes" \
      || die "gh release create failed"
  fi

  # Derive the true asset download URL from GitHub (it sanitizes filenames, so
  # we read back what it actually served rather than guessing).
  local dl_url
  dl_url="$(gh release view "$TAG" --json assets \
    -q '.assets[] | select(.name | endswith(".whl")) | .url' | head -n1)"
  [ -n "$dl_url" ] || die "could not read uploaded asset URL from release ${TAG}"

  step "PUBLISHED — paste into the app's pyproject.toml"
  echo
  echo "trame-vtklocal = { url = \"${dl_url}\" }"
  echo
  echo "# sha256 = ${wheel_sha}"
}

"$COMMAND"
