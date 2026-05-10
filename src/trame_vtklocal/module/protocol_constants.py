"""Shared protocol constants used by both the translator and PushSync.

Lives in `module/` so it can be imported from either side without creating a
top-level cycle between `widgets/push_sync` and `module/vtkjs_translator`.
"""

SYNTHETIC_VERSION_PREFIX = "v:"
SYNTHETIC_CELL_PREFIX = "cell:"
RESERVED_HASH_PREFIXES = (SYNTHETIC_VERSION_PREFIX, SYNTHETIC_CELL_PREFIX)
