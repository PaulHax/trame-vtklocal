/* eslint-disable */
// Push-sync e2e oracle page setup.
//
// The trame app loads this script alongside the widget mount. It wires
// `window.__pushOracle__` to forward `waitForSeq` / `dump` / `diagnostics`
// to the production widget's exposed diagnostic API. This script is the
// only piece of e2e-specific JS the test page runs in addition to the
// production bundle.

(function () {
  function getView(refName) {
    const ref = window.trame?.refs?.[refName || "vtkView"];
    if (!ref) return null;
    if (typeof ref.getSyncDiagnostics === "function") return ref;
    if (ref.$ && ref.$.exposed && typeof ref.$.exposed.getSyncDiagnostics === "function") {
      return ref.$.exposed;
    }
    return ref;
  }

  function diagnostics(refName) {
    const view = getView(refName);
    if (!view || typeof view.getSyncDiagnostics !== "function") {
      return null;
    }
    return view.getSyncDiagnostics();
  }

  function dump(rwId, refName) {
    const view = getView(refName);
    if (!view || typeof view.getAppliedSceneState !== "function") {
      return null;
    }
    return view.getAppliedSceneState(rwId);
  }

  function waitForSeq(target, timeoutMs, refName) {
    const deadline = Date.now() + (timeoutMs || 5000);
    return new Promise(function (resolve, reject) {
      function tick() {
        const diag = diagnostics(refName);
        if (diag && diag.lastSeq >= target) {
          resolve(diag);
          return;
        }
        if (Date.now() > deadline) {
          reject(
            new Error(
              "waitForSeq(" +
                target +
                ") timed out; diagnostics=" +
                JSON.stringify(diag),
            ),
          );
          return;
        }
        setTimeout(tick, 16);
      }
      tick();
    });
  }

  window.__pushOracle__ = {
    diagnostics: diagnostics,
    dump: dump,
    waitForSeq: waitForSeq,
    isReady: function (refName) {
      return !!getView(refName) && diagnostics(refName) !== null;
    },
  };

  // Capture console errors so the runner can surface them on assertion
  // failure. The list is reset between scenes via reset().
  if (!window.__pushOracleConsole__) {
    window.__pushOracleConsole__ = { errors: [], warnings: [] };
    const origError = console.error;
    console.error = function () {
      try {
        window.__pushOracleConsole__.errors.push(
          Array.from(arguments).join(" "),
        );
      } catch (_) {}
      origError.apply(console, arguments);
    };
    const origWarn = console.warn;
    console.warn = function () {
      try {
        window.__pushOracleConsole__.warnings.push(
          Array.from(arguments).join(" "),
        );
      } catch (_) {}
      origWarn.apply(console, arguments);
    };
  }
})();
