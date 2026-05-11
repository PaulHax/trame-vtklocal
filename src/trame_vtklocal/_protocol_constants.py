"""Shared protocol constants. Leaf module so importers do not transit
`module/__init__.py`, which would pull VTK in eagerly via `protocol.py`.
"""

SYNTHETIC_VERSION_PREFIX = "v:"
SYNTHETIC_CELL_PREFIX = "cell:"
RESERVED_HASH_PREFIXES = (SYNTHETIC_VERSION_PREFIX, SYNTHETIC_CELL_PREFIX)
