.. |pypi_download| image:: https://img.shields.io/pypi/dm/trame-vtklocal

trame-vtklocal  |pypi_download|

Local rendering for trame: a server-side ``vtkRenderWindow`` is published as a
flat scene and drawn in the browser with vtk.js, either on the view's own canvas
(``VtkJsLocalView``) or inside a host's WebGL context (``VtkJsSharedView``).
Shared views can render inside MapLibre while the map owns the canvas, camera
and interaction.

License
----------------------------------------

This library is OpenSource and follow the Apache Software License

Installation
----------------------------------------

.. code-block:: console

    # to install a compatible version of VTK
    pip install "trame-vtklocal[vtk]"

    # to install VTK yourself
    pip install trame-vtklocal
    pip install "vtk>=9.6,<9.7"


Development
----------------------------------------

Build and install the Vue components. The bundle needs the vtk-js fork built at
the exact commit recorded in ``vtkjs-fork.env`` (``VTKJS_FORK_COMMIT``), the
only place that sha is written, so this README, ``release.sh`` and CI cannot
disagree about which vtk.js the bundle carries.

.. code-block:: console

    source ./vtkjs-fork.env
    git clone "$VTKJS_FORK_REPO" ../vtk-js-stuff/external-context-integration
    cd ../vtk-js-stuff/external-context-integration
    git checkout "$VTKJS_FORK_COMMIT"
    npm ci
    npm run build:esm
    cd dist/esm
    npm link
    cd ../../../trame-vtklocal/vue-components
    npm ci
    npm link @kitware/vtk.js
    npm run build
    cd -

``npm ci`` (not ``npm i``) is what installs the locked, integrity-checked
``pointcloud-lod`` release; ``release.sh`` refuses to build a wheel against a
``npm link``-ed working copy of it.

Install the library

.. code-block:: console

    pip install -e .

Fork release flow (shared-context)
----------------------------------------

This ``shared-context`` fork publishes GitHub prerelease wheels for applications
to pin by URL. The wheel version is stamped at build time with the git short sha
(``0.16.0+shared-context.<sha>``, computed by the ``hatch_build.py`` metadata
hook) so ``importlib.metadata.version("trame-vtklocal")`` proves exactly which
fork commit produced the embedded UMD bundle.

The wheel carries no VTK.wasm runtime. Its views render through vtk.js, which
vite bundles into ``serve/js/trame_vtklocal.umd.js``; the only WebAssembly it
ships is the offline 3D Tiles decoders under ``serve/wasm/tiles3d/``.

``.github/workflows/build-fork-wheel.yml`` builds and publishes releases on
every push to ``shared-context``. CI builds the wheel once, runs the Python
unit tests and a browser smoke test against that wheel, then publishes the
tested artifact. Its inputs are immutable: vtk-js is fetched at the commit in
``vtkjs-fork.env`` and ``pointcloud-lod`` is installed from the lockfile.

``verify_chain.py`` proves that before any wheel ships: the linked vtk.js is a
clean checkout of the pinned commit, ``pointcloud-lod`` came from its
integrity-checked tarball rather than a dev link, nothing declares a
``@kitware/vtk.js`` range (no released version has ``vtkPointGaussianMapper``),
and the built bundle really does carry the mapper, its OpenGL override, the
fork's world-space point sizing and the Geometry profile. What it found is
written to ``serve/js/build-info.json``, which ships inside the wheel, and to
``dist/release-evidence.json``, which is attached to the release next to the
wheel it describes.

For local development checks, run ``release.sh build`` at the fork root. It
requires the vtk-js fork to be linked into ``vue-components`` (see Development
above) and publishes nothing:

.. code-block:: console

    ./release.sh build

This rebuilds ``vue-components`` (the UMD bundle), builds the wheel, and asserts
the UMD embedded in the wheel byte-matches the freshly built
``serve/js/trame_vtklocal.umd.js`` (sha256 compare) so a stale wheel can never
ship. It writes the wheel and ``release-evidence.json`` to ``dist/`` and prints
the stamped version and the release tag.

CI's final upload step runs ``release.sh publish`` on the tested wheel without
rebuilding it. The command checks that ``dist/release-evidence.json`` names
``HEAD`` and the wheel's ``sha256``, then uploads the wheel and evidence to
the GitHub prerelease ``v0.16.0-shared-context.<sha>``. It prints the dependency
URL and wheel hash for application consumers.

To consume a release, update the application's dependency URL to the printed
``trame-vtklocal = { url = "..." }`` entry and regenerate its lockfile. The URL
identifies the wheel built and verified from the pinned library revisions.


Running examples
----------------------------------------

.. code-block:: console

    pip install trame "trame-vtklocal[vtk]" trame-vuetify

    # a cone rendered with vtk.js on the view's own canvas
    python ./examples/vtk/vtkjs_cone.py

    # vtk.js layered renderers: preserve color while resetting overlay depth
    python ./examples/vtk/vtkjs_layered_renderers.py

3D Tiles host policies
----------------------------------------

``VtkJsLocalView`` and ``VtkJsSharedView`` accept declarative policy options
from Python. Texture policy defaults to ``"auto"``, which selects native GPU
compression except when a software renderer or headless browser requires RGBA.
Set it to ``"native"`` or ``"rgba"`` to override that detection. Quality
policy defaults to ``"adaptive"`` and may be set to ``"fixed"`` for controlled
comparisons.

.. code-block:: python

    view = VtkJsSharedView(
        render_window,
        tiles3d_texture_policy="rgba",
        tiles3d_quality_policy="fixed",
    )


Professional Support
--------------------------------------------------------------------------

* `Training <https://www.kitware.com/courses/trame/>`_: Learn how to confidently use trame from the expert developers at Kitware.
* `Support <https://www.kitware.com/trame/support/>`_: Our experts can assist your team as you build your web application and establish in-house expertise.
* `Custom Development <https://www.kitware.com/trame/support/>`_: Leverage Kitware’s 25+ years of experience to quickly build your web application.

Scene gate for external resources
---------------------------------

``VtkJsSharedView`` exposes ``registerSceneGate(hold)`` and
``retrySceneGate()``. ``hold(message)`` receives each in-order scene ops
message before it applies and returns ``true`` to hold it, for example while
the video frame a retained ``video.frame.<key>`` command names has not
arrived. Held messages keep their order: a later message the gate also holds
queues behind them, while one it would not hold applies them first, so an
unrelated update never waits on the resource. Call ``retrySceneGate()`` when
the awaited resource lands; a held message also applies at its deadline (3 s)
whatever the gate says, so a resource that never arrives cannot stall the
view. Ask for the resource again well before that deadline rather than
relying on it. Snapshots are never held.
The registration disposer releases anything the gate held.

PointGaussianMapper support
--------------------------

The vtk.js backend implements only simple points. Python callers must explicitly
call ``mapper.SetScaleFactor(0)``. Nonzero scale factors, anisotropy, Gaussian
scale/opacity arrays or functions, rotation arrays, and custom splat shaders
raise an error during scene translation. Gaussian-only defaults such as
``Emissive`` and ``BoundScale`` are not forwarded and have no effect in this mode.

Point size comes from the actor property. The direct-cloud presentation block
converts CSS pixels with the vtk.js ``pointSizeScale`` extension; it does not
change ``scaleFactor``. Streamed scenes create their simple-point mappers in the
browser, where the renderer also controls the resident-buffer draw prefix.

Scene publication and recovery
------------------------------

For vtk.js views, ``view.transaction()`` batches ordinary VTK mutations and
commands into one publication; ``view.sync()`` flushes pending changes. Replaced
dependencies are tracked automatically, including shared datasets, properties,
and pipeline connections. Pipeline and transform aggregate MTimes are checked
at publication because some VTK operations do not emit ``ModifiedEvent``.

After deliberately bypassing VTK modification notifications, call
``view.recover()`` to scan observed MTimes and publish missed changes. Browser
resynchronization performs this recovery before returning its snapshot.
A failed pre-commit serialization preserves pending changes and command order
for a later retry.


MapLibre shared-context example
------------------------------

``examples/vtk/maplibre_vtkjs.py`` exercises shared MapLibre rendering,
three renderer layers, delayed projected textures, screen-sized pickable
glyphs, direct and streamed clouds, a textured 3D Tiles mesh, and dependency
replacement across two views. See ``examples/vtk/maplibre_demo/README.md`` for
controls and reproducible headless checks.

Gesture ``pointer_event`` camera matrices use column-major layout for both
local and shared views, matching ``setRenderedCamera``.

Drag release acknowledgement
----------------------------

Drag events carry an opaque ``gesture_id`` shared by their start, moves and
end. The browser holds the final preview position after release so delayed
scene updates cannot replay earlier pointer positions. After processing a
``target.drag.end`` event, the application must enqueue an acknowledgement on
the originating view, after publishing any final scene mutations::

    view.send_command("pointer.drag.end", {"gesture_id": event["gesture_id"]})

Send the acknowledgement even when the drop is unchanged, cancelled or
rejected. Use ``finally`` if the handler may return early. Do not retain the
command. The acknowledgement shares the ordered scene stream with the final
position; once applied, the server position becomes authoritative. Async
handlers must await their scene mutations before acknowledging the release.

For points that move between render buckets, pass the same nonempty
``preview_group`` to ``make_pickable`` for every bucket in one layer. Provide
stable ``ids`` that are unique within that group and use one coordinate system
and preview mode throughout it. Use a distinct group for every independent
layer or dataset. The preview follows ``(preview_group, point_id)`` across
buckets; duplicate identities or a removed target stop that preview safely.
Different points retain independent pending previews, and a regrab transfers
that point's preview to the new gesture.

Streamed memory allowance
-------------------------

``VtkJsLocalView`` and ``VtkJsSharedView`` accept
``streamed_memory_budget_bytes`` at construction. All views on a page share
one allowance; pass the same value to each view. Omit it to use the
browser-derived default. This controls resident streamed geometry and textures,
not total browser memory, and does not detect or reserve GPU memory. Changing
the allowance requires a page reload.
