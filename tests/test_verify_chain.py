import importlib.util
import json
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location(
    "verify_chain", Path(__file__).resolve().parents[1] / "verify_chain.py"
)
verify_chain = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify_chain)

REVISION = "f" * 40
TARBALL = (
    "https://github.com/PaulHax/pointcloud-lod/releases/download/"
    f"revision-{REVISION}/pointcloud-lod-{REVISION}.tgz"
)


@pytest.fixture
def install(tmp_path, monkeypatch):
    monkeypatch.setattr(verify_chain, "VUE", tmp_path)
    package = tmp_path / "node_modules" / "pointcloud-lod"
    package.mkdir(parents=True)
    (package / "package.json").write_text(json.dumps({"version": "0.0.0-development"}))

    def write(resolved=TARBALL, integrity="sha512-digest"):
        (tmp_path / "package-lock.json").write_text(
            json.dumps(
                {
                    "packages": {
                        "node_modules/pointcloud-lod": {
                            "version": "0.0.0-development",
                            "resolved": resolved,
                            "integrity": integrity,
                        }
                    }
                }
            )
        )

    return write


def test_commit_tarball_records_source_revision(install):
    install()
    assert verify_chain.check_pointcloud_lod()["sourceRevision"] == REVISION


@pytest.mark.parametrize(
    "url",
    [
        TARBALL.replace(REVISION, "main"),
        TARBALL.replace(f"pointcloud-lod-{REVISION}", "pointcloud-lod-latest"),
        TARBALL.replace("PaulHax", "another-owner"),
    ],
)
def test_rejects_unpinned_or_untrusted_tarballs(install, url):
    install(resolved=url)
    with pytest.raises(SystemExit):
        verify_chain.check_pointcloud_lod()


def test_commit_tarball_still_requires_integrity(install):
    install(integrity="")
    with pytest.raises(SystemExit):
        verify_chain.check_pointcloud_lod()
