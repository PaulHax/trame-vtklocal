from pathlib import Path
import shutil
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

    # Anything else a checkout holds under serve/wasm/ must stay out.
    stray = serve / "wasm" / "stale-runtime"
    stray.mkdir(exist_ok=True)
    (stray / "vtkWebAssembly.wasm").write_bytes(b"\0asm")
    try:
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
    finally:
        shutil.rmtree(stray)
    wheel = next(tmp_path.glob("*.whl"))
    with ZipFile(wheel) as archive:
        names = set(archive.namelist())
    prefix = "trame_vtklocal/module/serve/"
    assert {prefix + relative for relative in required} <= names
    assert {name for name in names if name.startswith(prefix + "wasm/")} == {
        prefix + relative for relative in required if relative.startswith("wasm/")
    }
