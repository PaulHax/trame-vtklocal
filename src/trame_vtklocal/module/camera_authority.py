"""Who owns a view's rendered camera (push sync v2).

- ``"server"``: cameras are normal synced nodes for initial and idle state.
  During a client interaction, camera-node prop updates are deferred by the
  reconciler and the newest deferred state applies when interaction ends.
  Explicit ``camera.set``/``camera.reset`` commands remain available for
  ordered server intents.
- ``"client"``: cameras never become nodes and no ref slot (the renderer's
  ``activeCamera``) points at one; the server drives the view via commands and
  the client pushes rendered matrices itself, reporting them only inside
  seq-stamped events.

The option threads from the view constructor through the publisher into node
translation, which is the single place the node shape changes.
"""

CAMERA_AUTHORITIES = frozenset({"server", "client"})


def validate_camera_authority(camera_authority):
    if camera_authority not in CAMERA_AUTHORITIES:
        raise ValueError(
            f"camera_authority must be one of {sorted(CAMERA_AUTHORITIES)}, "
            f"got {camera_authority!r}"
        )
    return camera_authority
