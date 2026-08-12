from pathlib import Path
import subprocess
import sys
from zipfile import ZipFile


def test_offline_tiles3d_runtime_is_staged_and_selected_for_wheel(tmp_path):
    root = Path(__file__).resolve().parents[1]
    serve = root / "src" / "trame_vtklocal" / "module" / "serve"
    required = {
        "js/trame_vtklocal.umd.js",
        "js/tiles3dDecodeWorker.classic.js",
        "wasm/tiles3d/draco_wasm_wrapper.js",
        "wasm/tiles3d/draco_decoder.wasm",
        "wasm/tiles3d/basis_encoder.js",
        "wasm/tiles3d/basis_encoder.wasm",
    }
    assert all((serve / relative).is_file() for relative in required)
    codec_sources = {
        "draco_wasm_wrapper.js": root
        / "vue-components/node_modules/pointcloud-lod/dist/tiles3d-codecs/draco_wasm_wrapper.js",
        "draco_decoder.wasm": root
        / "vue-components/node_modules/pointcloud-lod/dist/tiles3d-codecs/draco_decoder.wasm",
        "basis_encoder.js": root
        / "vue-components/node_modules/pointcloud-lod/dist/tiles3d-codecs/basis_encoder.js",
        "basis_encoder.wasm": root
        / "vue-components/node_modules/pointcloud-lod/dist/tiles3d-codecs/basis_encoder.wasm",
    }
    for name, source in codec_sources.items():
        assert (serve / "wasm/tiles3d" / name).read_bytes() == source.read_bytes()
    pyproject = (root / "pyproject.toml").read_text()
    assert '"/src/trame_vtklocal/module/serve/js/**"' in pyproject
    assert '"/src/trame_vtklocal/module/serve/wasm/tiles3d/**"' in pyproject
    assert '"/src/trame_vtklocal/module/serve/wasm/9.*"' in pyproject

    subprocess.run(
        [
            sys.executable,
            "-m",
            "build",
            "--wheel",
            "--no-isolation",
            "--outdir",
            str(tmp_path),
        ],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
    )
    wheel = next(tmp_path.glob("*.whl"))
    with ZipFile(wheel) as archive:
        names = set(archive.namelist())
    prefix = "trame_vtklocal/module/serve/"
    assert {prefix + relative for relative in required} <= names
    assert not any(name.startswith(prefix + "wasm/9.") for name in names)
