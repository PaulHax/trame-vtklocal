"""Number checks shared by the scene-marking helpers and streamed sources."""

from __future__ import annotations

import math
from typing import SupportsFloat


def positive_finite(value: SupportsFloat, message: str) -> float:
    """``value`` as a positive, finite float, else ``ValueError(message)``."""
    number = float(value)
    if not math.isfinite(number) or number <= 0:
        raise ValueError(message)
    return number
