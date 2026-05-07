"""xprocess entry-point for the oracle test app, local-canvas variant."""

import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from tests.push_oracle_e2e.app import OracleApp  # noqa: E402


def main():
    OracleApp(view="local").server.start()


if __name__ == "__main__":
    main()
