"""CI guard: generated translation schema must mirror vtkjs_translator.

The JS-side push-sync oracle dump consumes
``vue-components/src/components/generated/translationSchema.js`` to mirror the
static lookup tables of ``trame_vtklocal.module.vtkjs_translator``. If a dev
edits the Python source without re-running ``npm run gen-schema``, the JS
mirror silently drifts. This test re-runs the generator in --check mode and
fails when the on-disk file is out of date.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
GENERATOR = (
    REPO_ROOT / "vue-components" / "scripts" / "gen_translation_schema.py"
)
GENERATED = (
    REPO_ROOT
    / "vue-components"
    / "src"
    / "components"
    / "generated"
    / "translationSchema.js"
)


@pytest.mark.skipif(
    not GENERATOR.exists(),
    reason="translation-schema generator not present in this checkout",
)
def test_translation_schema_in_sync():
    result = subprocess.run(
        [sys.executable, str(GENERATOR), "--out", str(GENERATED), "--check"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        pytest.fail(
            "translationSchema.js is out of sync with vtkjs_translator.py. "
            "Run `npm run gen-schema` in vue-components/.\n"
            f"stderr:\n{result.stderr}\nstdout:\n{result.stdout}"
        )
