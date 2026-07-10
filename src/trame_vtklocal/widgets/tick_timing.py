"""Environment-gated publisher tick timing."""

from __future__ import annotations

import logging
import os
from time import perf_counter

LOGGER = logging.getLogger("trame_vtklocal.publisher.timing")


class TickTiming:
    def __init__(self, rw_id):
        self.enabled = os.environ.get("TRAME_VTKLOCAL_TICK_TIMING") == "1"
        self.rw_id = rw_id
        self.values = {}

    def measure(self, name):
        return _Measurement(self, name)

    def log(self):
        if self.enabled:
            LOGGER.info(
                "vtk.js publish tick rw=%s %s",
                self.rw_id,
                " ".join(
                    f"{name}={milliseconds:.3f}ms"
                    for name, milliseconds in self.values.items()
                ),
            )


class _Measurement:
    def __init__(self, timing, name):
        self.timing = timing
        self.name = name
        self.started = None

    def __enter__(self):
        if self.timing.enabled:
            self.started = perf_counter()
        return self

    def __exit__(self, *_exc):
        if self.started is not None:
            self.timing.values[self.name] = (perf_counter() - self.started) * 1000
