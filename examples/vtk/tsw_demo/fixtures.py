"""Tiny deterministic HTTP assets; no TSW datasets or external tile service."""

import json
import struct
import zlib
from pathlib import Path

import numpy as np


IDENTITY = tuple(float(i % 5 == 0) for i in range(16))


def write_assets(root: Path):
    """A real PCT1 leaf and a glTF triangle in a 3D Tiles 1.1 tileset."""
    cloud = root / "cloud"
    (cloud / "hierarchy").mkdir(parents=True)
    (cloud / "tile").mkdir()
    xy = np.array([(x, y) for x in range(16) for y in range(16)], dtype="<f4")
    points = np.column_stack((xy / 2 - 4, np.sin(xy[:, 0]) / 2)).astype("<f4")
    colors = np.tile(np.array([70, 210, 240], dtype=np.uint8), (len(points), 1))
    header = struct.pack("<4sIII3d", b"PCT1", len(points), 1, 0, 0, 0, 0)
    (cloud / "tile/0-0-0-0.bin").write_bytes(
        header + points.tobytes() + colors.tobytes()
    )
    entry = {
        "pointCount": len(points),
        "bounds": {"min": [-4, -4, -1], "max": [4, 4, 1]},
        "spacing": 0.5,
        "children": [],
        "page": None,
    }
    (cloud / "hierarchy/0-0-0-0.json").write_text(
        json.dumps({"nodes": {"0-0-0-0": entry}})
    )
    mesh = root / "mesh"
    mesh.mkdir()
    positions = np.array([[-3, 0, 0], [3, 0, 0], [0, 0, 5]], dtype="<f4")
    uv = np.array([[0, 0], [1, 0], [0.5, 1]], dtype="<f4")

    def chunk(kind, data):
        return (
            struct.pack(">I", len(data))
            + kind
            + data
            + struct.pack(">I", zlib.crc32(kind + data))
        )

    scanlines = b"".join(
        b"\0" + bytes([255, 110 + y * 30, 40, 255]) * 4 for y in range(4)
    )
    png = b"\x89PNG\r\n\x1a\n" + chunk(
        b"IHDR", struct.pack(">IIBBBBB", 4, 4, 8, 6, 0, 0, 0)
    )
    png += chunk(b"IDAT", zlib.compress(scanlines)) + chunk(b"IEND", b"")
    image_offset = positions.nbytes + uv.nbytes
    binary = positions.tobytes() + uv.tobytes() + png
    binary += b"\0" * (-len(binary) % 4)
    # glTF uses Y up; the tiles renderer converts it to the scene's Z up.
    document = {
        "asset": {"version": "2.0"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0}],
        "meshes": [
            {
                "primitives": [
                    {"attributes": {"POSITION": 0, "TEXCOORD_0": 1}, "material": 0}
                ]
            }
        ],
        "materials": [
            {
                "doubleSided": True,
                "pbrMetallicRoughness": {
                    "baseColorTexture": {"index": 0},
                    "metallicFactor": 0,
                    "roughnessFactor": 1,
                },
            }
        ],
        "textures": [{"source": 0}],
        "images": [{"bufferView": 2, "mimeType": "image/png"}],
        "buffers": [{"byteLength": len(binary)}],
        "bufferViews": [
            {"buffer": 0, "byteOffset": 0, "byteLength": positions.nbytes},
            {"buffer": 0, "byteOffset": positions.nbytes, "byteLength": uv.nbytes},
            {"buffer": 0, "byteOffset": image_offset, "byteLength": len(png)},
        ],
        "accessors": [
            {
                "bufferView": 0,
                "componentType": 5126,
                "count": 3,
                "type": "VEC3",
                "min": [-3, 0, 0],
                "max": [3, 0, 5],
            },
            {"bufferView": 1, "componentType": 5126, "count": 3, "type": "VEC2"},
        ],
    }
    encoded = json.dumps(document).encode()
    encoded += b" " * (-len(encoded) % 4)
    glb = struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(encoded) + 8 + len(binary))
    glb += struct.pack("<II", len(encoded), 0x4E4F534A) + encoded
    glb += struct.pack("<II", len(binary), 0x004E4942) + binary
    (mesh / "triangle.glb").write_bytes(glb)
    (mesh / "tileset.json").write_text(
        json.dumps(
            {
                "asset": {"version": "1.1"},
                "geometricError": 0,
                "root": {
                    "boundingVolume": {
                        "box": [0, -2.5, 0, 3, 0, 0, 0, 2.5, 0, 0, 0, 0.1]
                    },
                    "geometricError": 0,
                    "refine": "REPLACE",
                    "content": {"uri": "triangle.glb"},
                },
            }
        )
    )
    return len(points)
