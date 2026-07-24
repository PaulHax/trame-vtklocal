.. |pypi_download| image:: https://img.shields.io/pypi/dm/trame-vtklocal

========================================================
trame-vtklocal  |pypi_download|
========================================================

Local Rendering using VTK.wasm to match server side rendering pipeline on the client side.
The current code base is still at its infancy but we aim to make it the default implementation for local rendering using VTK/ParaView with trame.
This WASM capability is starting to be available with VTK 9.4. 

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
    pip install "vtk>=9.4,<9.5"


Development
----------------------------------------

Build and install the Vue components

.. code-block:: console

    cd ../vtk-js-stuff/external-context-integration
    npm ci
    npm run build:esm
    cd dist/esm
    npm link
    cd ../../../trame-vtklocal/vue-components
    npm i
    npm link @kitware/vtk.js
    npm run build
    cd -

Install the library

.. code-block:: console

    pip install -e .

Optionally, you can develop with bleeding edge VTK by following these steps. Make sure you've these tools

1. git
2. CMake
3. Ninja
4. Python
5. NodeJS >= 24.0.1: https://nodejs.org/en/download/package-manager
6. Emscripten SDK version 4.0.10: See https://emscripten.org/docs/getting_started/downloads.html#download-and-install

.. code-block:: console

    # Compile VTK for wasm32 architecture using emscripten. Build artifacts can be found in dev/vtk/build/wasm
    python ./utils/build_vtk.py -u https://gitlab.kitware.com/vtk/vtk.git -b master -t wasm32 -c RelWithDebInfo

    # Compile VTK with python wrappings using system C++ compiler. Build artifacts can be found in dev/vtk/build/py
    python ./utils/build_vtk.py -u https://gitlab.kitware.com/vtk/vtk.git -b master -t py -c RelWithDebInfo

    # Windows: Set environment variables
    ./utils/dev_environment.ps1 -b master -c RelWithDebInfo
    
    # Unix: Set environemt variables
    source ./utils/dev_environment.sh -b master -c RelWithDebInfo


Fork release flow (shared-context)
----------------------------------------

This ``shared-context`` fork ships as a pinned wheel to the app repo rather than
to PyPI. The wheel version is stamped at build time with the git short sha
(``0.16.0+shared-context.<sha>``, computed by the ``hatch_build.py`` metadata
hook) so ``importlib.metadata.version("trame-vtklocal")`` proves exactly which
fork commit produced the embedded UMD bundle.

The wheel is **WASM-free by construction** (~800 KB). The fork's consumers render
only through the vtk.js WebGL shared-context path (``VtkJsSharedView`` /
``vtk-js-shared``), which bundles all of ``@kitware/vtk.js`` into
``serve/js/trame_vtklocal.umd.js`` at vite build time and fetches no ``.mjs`` or
``.wasm``. The ``vtkWasmSceneManager`` / ``LocalView`` (``vtk-local``) path — and
its ``serve/wasm/`` tree — is a separate, unused code path. The wheel packaging
(``[tool.hatch.build]`` include) ships only ``serve/js/**``, so whatever
``serve/wasm/`` runtime artifacts sit in the working tree are never swept into
the wheel.

**Publishing is manual, via** ``release.sh --publish`` — never CI. The CI workflow
``.github/workflows/build-fork-wheel.yml`` is a **build-only** sanity check
(checkout + build the vtk-js fork + vue-components + wheel, then upload the wheel
as an artifact). It does **not** publish a release: CI independently rebuilds the
vtk-js fork, producing a byte-divergent, untested UMD, whereas ``release.sh``
ships the locally-built UMD you actually ran and asserts the wheel's embedded UMD
byte-matches it.

Use ``release.sh`` at the fork root. It requires the vtk-js fork to be linked
into ``vue-components`` (see Development above).

Build and verify only (default, does NOT publish):

.. code-block:: console

    ./release.sh

This rebuilds ``vue-components`` (the UMD bundle), builds the wheel, and asserts
the UMD embedded in the wheel byte-matches the freshly built
``serve/js/trame_vtklocal.umd.js`` (sha256 compare) so a stale wheel can never
ship. It prints the stamped version and the release tag but publishes nothing.

Publish a GitHub prerelease and print the app pin:

.. code-block:: console

    ./release.sh --publish

This additionally creates (or re-uploads to) the ``gh`` prerelease
``v0.16.0-shared-context.<sha>`` with the wheel attached, then prints the exact
line to paste into the app's ``pyproject.toml`` plus the wheel ``sha256``.
Re-running is safe (existing releases get the asset re-uploaded with
``--clobber``).

Two-repo pin bump: after ``--publish``, paste the printed dependency line into
the app repo's ``pyproject.toml`` (the ``trame-vtklocal = { url = "..." }`` entry
pointing at the new release asset) and re-lock. The fork release and the app pin
are the two halves of a single version bump — keep them in sync.


Running examples
----------------------------------------

.. code-block:: console

    pip install trame "trame-vtklocal[vtk]" trame-vuetify trame-vtk

    # regular trame app
    python ./examples/vtk/cone.py 

    # vtk.js layered renderers: preserve color while resetting overlay depth
    python ./examples/vtk/vtkjs_layered_renderers.py


Some example are meant to test and validate WASM rendering.
Some will default for remote rendering but if you want to force them to use WASM just run `export USE_WASM=1` before executing them.

Progress events
----------------------------------------

The client-side VtkLocal component emits a `progress` event while wasm sync is happening.
This can be used to keep a global loader visible until the first sync completes.

.. code-block:: python

    from trame.widgets import vtklocal, vuetify

    state.app_loading = True
    state._vtklocal_seen_active = False

    def on_vtklocal_progress(event):
        if event.get("active"):
            state._vtklocal_seen_active = True
            state.app_loading = True
        elif state._vtklocal_seen_active:
            state.app_loading = False

    with vuetify.VOverlay(v_model=("app_loading",), absolute=True):
        vuetify.VProgressCircular(indeterminate=True, size=64)

    view = vtklocal.LocalView(
        render_window,
        progress=(on_vtklocal_progress, "[$event]"),
    )

If you are using the Vue component directly, you can override the built-in loader
with the `loader` slot.

.. code-block:: html

    <vtk-local>
      <template #loader="{ progress, wasmLoading, statePercent, hashPercent }">
        <div v-if="wasmLoading">Loading wasm...</div>
        <div v-else>
          States: {{ progress.state.current }}/{{ progress.state.total }}
          Blobs: {{ progress.hash.current }}/{{ progress.hash.total }}
        </div>
      </template>
    </vtk-local>

SharedArrayBuffer
----------------------------------------

To enable SharedArrayBuffer within trame you can just set the following on the server. 
This option is not required anymore but still available if needed.

.. code-block:: console

    server.http_headers.shared_array_buffer = True


This will download the threaded WASM version. Otherwise, the non-threaded version will be used as it does not require SharedArrayBuffer.


VTK.wasm vs trame-vtklocal
----------------------------------------

This repository `trame-vtklocal` focus on providing a web component that is capable of mirroring a `vtkRenderWindow` defined on the server side.
This include a JavaScript section for the browser and a Python section for the server. 

The server include a definition of a custom network protocol over our WebSocket (wslink/trame) and some helper class to ease the vtkRenderWindow binding with a web component in the browser.
While the Python package include a Vue.js component for a seamless integration with trame, we also publish a `npm package <https://www.npmjs.com/package/@kitware/trame-vtklocal>`_.
That pure JavaScript library let you still use the trame infrastructure on the server side but with your own stack on the client side. A usage example of that pure JavaScript option is covered `in that directory <https://github.com/Kitware/trame-vtklocal/tree/master/examples/pure-js>`_.

For the pure Python trame usage, you can find the `documented API <https://trame.readthedocs.io/en/latest/trame.widgets.vtklocal.html>`_.

By design there is a nice separation between VTK.wasm and trame-vtklocal which should make trame-vtklocal fairly independent of VTK.wasm version. 
But since we are still building capabilities, when the C++ API expend, we will also expand the Python/JavaScript component properties/methods. 
Hopefully we should be able to evolve trame-vtklocal with some reasonable fallback when the version of VTK is not in par with what is exposed in trame-vtklocal.

Also most the testing of VTK.wasm is in VTK repository as many validation can be done in pure C++ or `Python <https://gitlab.kitware.com/vtk/vtk/-/tree/master/Serialization/Manager/Testing/Python>`_. 
Then we have `the WASM module API <https://gitlab.kitware.com/vtk/vtk/-/blob/master/Web/WebAssembly/vtkWasmSceneManagerEmBinding.cxx>`_  with its `node/chrome testing <https://gitlab.kitware.com/vtk/vtk/-/tree/master/Web/WebAssembly/Testing/JavaScript>`_.

The documented API of `vtkWasmSceneManager <https://vtk.org/doc/nightly/html/classvtkWasmSceneManager.html>`_ and `vtkObjectManager parent of vtkWasmSceneManager <https://vtk.org/doc/nightly/html/classvtkObjectManager.html>`_

For the moment we rely on manual testing for when we change the network and/or API at the trame-vtklocal by going over a specific set of `examples <https://github.com/Kitware/trame-vtklocal/tree/master/examples>`_.

Currently the WASM implementation is used in the following set of projects:

- `Pan3D <https://github.com/Kitware/pan3d/>`_: Pan3D aims to be an utility package for viewing and processing a wide variety of multidimensional datasets. Any dataset that can be interpreted with xarray can be explored and rendered with Pan3D.


Professional Support
--------------------------------------------------------------------------

* `Training <https://www.kitware.com/courses/trame/>`_: Learn how to confidently use trame from the expert developers at Kitware.
* `Support <https://www.kitware.com/trame/support/>`_: Our experts can assist your team as you build your web application and establish in-house expertise.
* `Custom Development <https://www.kitware.com/trame/support/>`_: Leverage Kitware’s 25+ years of experience to quickly build your web application.
