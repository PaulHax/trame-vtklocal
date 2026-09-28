"""Resolve the terminal landmark drag using the camera stamped on its event."""

import numpy as np


def drag_point(event):
    if event.get("type") != "target.drag.end" or event.get("cancelled"):
        return None
    camera, viewport, pointer = (
        event.get(key) for key in ("camera", "viewport", "pointer")
    )
    if not camera or not viewport or not pointer:
        return None
    width, height = viewport["width"], viewport["height"]
    if width <= 0 or height <= 0:
        return None
    view = np.asarray(camera["viewMatrix"]).reshape(4, 4, order="F")
    projection = np.asarray(camera["projectionMatrix"]).reshape(4, 4, order="F")
    try:
        inverse = np.linalg.inv(projection @ view)
    except np.linalg.LinAlgError:
        return None
    x, y = 2 * pointer["x"] / width - 1, 1 - 2 * pointer["y"] / height
    ends = [inverse @ np.array([x, y, z, 1]) for z in (-1, 1)]
    if any(abs(point[3]) < 1e-12 for point in ends):
        return None
    near, far = [point[:3] / point[3] for point in ends]
    direction = far - near
    if abs(direction[2]) < 1e-12:
        return None
    world = near + direction * ((2 - near[2]) / direction[2])
    return world if np.isfinite(world).all() else None
