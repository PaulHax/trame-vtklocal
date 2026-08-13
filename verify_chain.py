#!/usr/bin/env python3
"""Prove the UMD bundle about to ship was built from the pinned dependency chain.

The wheel is a black box once built: nothing inside a minified bundle says which
vtk.js it came from, and every link in the chain can silently float — a moving
fork branch, a dev symlink standing in for a released package, a released
``@kitware/vtk.js`` that has no ``vtkPointGaussianMapper`` at all. Each check
below turns one of those silent substitutions into a failed release.

Run from ``release.sh`` (so local and CI releases prove the same things):

    python3 verify_chain.py --umd <umd path> --build-info <json path>

The build-info JSON is written next to the bundle and ships inside the wheel, so
an installed wheel can be asked which vtk.js it carries.
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PIN_FILE = ROOT / "vtkjs-fork.env"
VUE = ROOT / "vue-components"
STREAMED_SCENE_PY = ROOT / "src" / "trame_vtklocal" / "streamed_scene.py"

# The bundle is minified, so class names are mangled but the strings vtk.js
# registers itself with survive verbatim. Quote style differs per bundler
# (esbuild emits ", rolldown emits `), hence the character class.
QUOTE = "[\"'`]"


def die(message: str) -> None:
    sys.exit(f"verify_chain: FAIL: {message}")


def read_pin() -> dict:
    """Parse the KEY=VALUE pin file that also feeds bash and the workflow."""
    if not PIN_FILE.is_file():
        die(f"missing pin file {PIN_FILE}")
    pin = {}
    for line in PIN_FILE.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, _, value = line.partition("=")
        pin[key.strip()] = value.strip()
    commit = pin.get("VTKJS_FORK_COMMIT", "")
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        die(f"VTKJS_FORK_COMMIT must be a full 40-character sha, got '{commit}'")
    return pin


def git_output(cwd: Path, *args: str) -> str | None:
    try:
        out = subprocess.check_output(
            ["git", *args], cwd=cwd, stderr=subprocess.DEVNULL
        )
    except (OSError, subprocess.CalledProcessError):
        return None
    return out.decode().strip() or None


def check_vtkjs(pin: dict) -> dict:
    """The linked @kitware/vtk.js must be a checkout of the pinned commit."""
    link = VUE / "node_modules" / "@kitware" / "vtk.js"
    if not link.exists():
        die(
            f"{link} is missing — link the fork build:\n"
            f"    git clone {pin['VTKJS_FORK_REPO']} && cd vtk-js\n"
            f"    git checkout {pin['VTKJS_FORK_COMMIT']}\n"
            "    npm ci && npm run build:esm && cd dist/esm && npm link\n"
            "    cd - && (cd vue-components && npm link @kitware/vtk.js)"
        )
    source = link.resolve()
    toplevel = git_output(source, "rev-parse", "--show-toplevel")
    if not toplevel:
        die(
            f"{link} resolves to {source}, which is not inside a git checkout, so "
            "the vtk.js commit it was built from cannot be proven"
        )
    head = git_output(Path(toplevel), "rev-parse", "HEAD")
    if head != pin["VTKJS_FORK_COMMIT"]:
        die(
            f"linked vtk.js is at {head}, pinned commit is "
            f"{pin['VTKJS_FORK_COMMIT']} ({PIN_FILE.name}). Check out the pinned "
            "commit and rebuild `npm run build:esm`, or update the pin on purpose."
        )
    dirty = git_output(Path(toplevel), "status", "--porcelain")
    if dirty:
        die(
            f"vtk.js checkout {toplevel} has uncommitted changes, so the bundle "
            f"would not be reproducible from {pin['VTKJS_FORK_COMMIT']}"
        )
    return {
        "repository": pin["VTKJS_FORK_REPO"],
        "branch": pin["VTKJS_FORK_BRANCH"],
        "commit": head,
    }


def check_pointcloud_lod() -> dict:
    """pointcloud-lod must come from the lockfile, not from a dev symlink."""
    installed = VUE / "node_modules" / "pointcloud-lod"
    if not installed.exists():
        die(f"{installed} is missing — run `npm ci` in vue-components")
    if installed.is_symlink():
        die(
            f"{installed} is a symlink to a working copy, so the wheel would "
            "embed whatever that tree happens to hold. Run `npm ci` in "
            "vue-components to install the locked, integrity-checked release."
        )
    version = json.loads((installed / "package.json").read_text())["version"]

    lock = json.loads((VUE / "package-lock.json").read_text())
    entry = lock.get("packages", {}).get("node_modules/pointcloud-lod")
    if not entry:
        die("package-lock.json has no node_modules/pointcloud-lod entry")
    resolved, integrity = entry.get("resolved", ""), entry.get("integrity", "")
    if not resolved.startswith("https://registry.npmjs.org/"):
        die(f"pointcloud-lod must resolve to a published tarball, got '{resolved}'")
    if not integrity.startswith("sha512-"):
        die(f"pointcloud-lod lock entry carries no sha512 integrity: '{integrity}'")
    if entry.get("version") != version:
        die(
            f"installed pointcloud-lod {version} != locked {entry.get('version')} "
            "— run `npm ci` in vue-components"
        )
    return {"version": version, "resolved": resolved, "integrity": integrity}


def node_json(source: str, what: str):
    """Evaluate an ESM snippet with `pointcloud-lod` resolved as the bundle
    resolves it, and read back what it prints as JSON."""
    try:
        out = subprocess.check_output(
            ["node", "--input-type=module", "-e", source],
            cwd=VUE,
            stderr=subprocess.PIPE,
        )
    except FileNotFoundError:
        die(f"node is not on PATH, so {what} cannot be read from the library")
    except subprocess.CalledProcessError as error:
        detail = error.stderr.decode().strip().splitlines()
        die(
            f"reading {what} from pointcloud-lod failed: {detail[-1] if detail else ''}"
        )
    return json.loads(out)


def check_adaptive_floor() -> dict:
    """The Python source validator's adaptive floor matches the library.

    ``PointCloudSource`` rejects a ``max_budget`` below the floor, but Python
    cannot import the number the JS validator enforces, so it holds a copy.
    The library publishes ``ADAPTIVE_QUALITY_DEFAULTS.minBudget`` from its
    vtk-free entry precisely so hosts read the floor instead of restating it —
    read it here, or a policy change leaves the two validators disagreeing
    about which configurations are legal.

    It must come from the package root: the renderer entry (``pointcloud-lod
    /vtk``) cannot be imported from node at all, so a floor reachable only
    through it is a floor this gate cannot check.
    """
    library = node_json(
        'const m = await import("pointcloud-lod");'
        "console.log(JSON.stringify(m.ADAPTIVE_QUALITY_DEFAULTS?.minBudget ?? null));",
        "ADAPTIVE_QUALITY_DEFAULTS.minBudget",
    )
    if not isinstance(library, (int, float)):
        die(
            "pointcloud-lod no longer exports ADAPTIVE_QUALITY_DEFAULTS.minBudget; "
            f"the Python source floor in {STREAMED_SCENE_PY.name} has nothing to track"
        )

    tree = ast.parse(STREAMED_SCENE_PY.read_text())
    assignment = next(
        (
            node
            for node in tree.body
            if isinstance(node, ast.Assign)
            and any(
                isinstance(target, ast.Name)
                and target.id == "DEFAULT_ADAPTIVE_MIN_BUDGET"
                for target in node.targets
            )
        ),
        None,
    )
    if assignment is None:
        die(f"{STREAMED_SCENE_PY.name} has no DEFAULT_ADAPTIVE_MIN_BUDGET")
    python = ast.literal_eval(assignment.value)

    if python != library:
        die(
            f"{STREAMED_SCENE_PY.name} DEFAULT_ADAPTIVE_MIN_BUDGET is {python:_} but "
            f"pointcloud-lod DEFAULTS.minBudget is {library:_}. The two validators "
            "would accept different max_budget values; set the Python copy to the "
            "library's floor."
        )
    return {"minBudget": library}


def check_no_vtkjs_range() -> None:
    """No published @kitware/vtk.js carries vtkPointGaussianMapper, so any
    declared range is a promise npm could satisfy with a build that cannot
    render a point cloud."""
    manifests = [
        VUE / "package.json",
        VUE / "node_modules" / "pointcloud-lod" / "package.json",
    ]
    fields = (
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
    )
    for manifest in manifests:
        if not manifest.is_file():
            continue
        data = json.loads(manifest.read_text())
        for field in fields:
            spec = data.get(field, {}).get("@kitware/vtk.js")
            if spec:
                die(
                    f"{manifest} declares {field}['@kitware/vtk.js'] = '{spec}'. "
                    "Every released vtk.js lacks vtkPointGaussianMapper, so that "
                    "range would resolve to a build the renderer adapter cannot "
                    "use. The fork is supplied by `npm link` instead."
                )


def check_bundle(umd: Path) -> dict:
    """The capabilities the point-cloud path needs must be *in* the bundle."""
    if not umd.is_file():
        die(f"bundle not found: {umd}")
    text = umd.read_text(encoding="utf-8")

    def registers(class_name: str) -> bool:
        return (
            re.search(rf"classHierarchy\.push\(\s*{QUOTE}{class_name}{QUOTE}", text)
            is not None
        )

    required = {
        # The mapper the pointcloud-lod renderer adapter instantiates.
        "vtkPointGaussianMapper": registers("vtkPointGaussianMapper"),
        # Without the OpenGL override the mapper draws nothing.
        "vtkOpenGLPointGaussianMapper": registers("vtkOpenGLPointGaussianMapper"),
        # Both come from the Geometry profile; absent it, no override registers.
        "vtkOpenGLPolyDataMapper": registers("vtkOpenGLPolyDataMapper"),
        "vtkOpenGLActor": registers("vtkOpenGLActor"),
        # worldSize is the fork's world-space point sizing — the feature the
        # pinned commit adds, so its presence proves the fork build was used.
        "worldSize": re.search(
            rf"{QUOTE}scaleFactor{QUOTE}\s*,\s*{QUOTE}circle{QUOTE}"
            rf"\s*,\s*{QUOTE}worldSize{QUOTE}",
            text,
        )
        is not None,
    }
    missing = [name for name, present in required.items() if not present]
    if missing:
        die(
            f"{umd} is missing {', '.join(missing)}. The bundle was built against "
            "a vtk.js without the point-gaussian work, or the Geometry profile "
            "import was dropped."
        )
    return {
        "sha256": hashlib.sha256(umd.read_bytes()).hexdigest(),
        "bytes": umd.stat().st_size,
        "present": sorted(required),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--umd", required=True, type=Path)
    parser.add_argument("--build-info", required=True, type=Path)
    args = parser.parse_args()

    pin = read_pin()
    vtkjs = check_vtkjs(pin)
    pointcloud_lod = check_pointcloud_lod()
    check_no_vtkjs_range()
    adaptive = check_adaptive_floor()
    bundle = check_bundle(args.umd)

    build_info = {
        "bridgeCommit": git_output(ROOT, "rev-parse", "HEAD"),
        "vtkjs": vtkjs,
        "pointcloudLod": {**pointcloud_lod, **adaptive},
        "bundle": bundle,
    }
    args.build_info.parent.mkdir(parents=True, exist_ok=True)
    args.build_info.write_text(json.dumps(build_info, indent=2, sort_keys=True) + "\n")

    print(f"  vtk.js         : {vtkjs['commit']} ({vtkjs['branch']})")
    print(f"  pointcloud-lod : {pointcloud_lod['version']}")
    print(f"                   {pointcloud_lod['integrity']}")
    print(f"  adaptive floor : {adaptive['minBudget']:_} (library == Python)")
    print(f"  bundle sha256  : {bundle['sha256']}")
    print(f"  bundle carries : {', '.join(bundle['present'])}")
    print(f"  build info     : {args.build_info}")
    print("CHAIN VERIFY PASS: bundle built from the pinned, immutable chain")


if __name__ == "__main__":
    main()
