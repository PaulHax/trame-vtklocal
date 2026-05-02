import { performance } from "node:perf_hooks";
import { createServer } from "vite";

let viteServer = null;

async function loadModule(modulePath) {
  if (!viteServer) {
    viteServer = await createServer({
      configFile: false,
      root: process.cwd(),
      server: {
        middlewareMode: true,
        hmr: false,
      },
      appType: "custom",
      logLevel: "error",
    });
  }

  return viteServer.ssrLoadModule(modulePath);
}

function createDocumentStub() {
  const listeners = new Map();

  return {
    visibilityState: "visible",
    addEventListener(type, callback) {
      listeners.set(type, callback);
    },
    removeEventListener(type, callback) {
      if (listeners.get(type) === callback) {
        listeners.delete(type);
      }
    },
  };
}

function createClientHarness({ onCall }) {
  const subscriptions = new Map();

  const session = {
    subscribe(topic, callback) {
      subscriptions.set(topic, callback);
      return { topic, callback };
    },
    unsubscribe(subscription) {
      subscriptions.delete(subscription.topic);
    },
    call(method, args) {
      return onCall(method, args);
    },
  };

  return {
    client: {
      getConnection() {
        return {
          getSession() {
            return session;
          },
        };
      },
    },
    emit(topic, payload) {
      subscriptions.get(topic)?.([payload]);
    },
  };
}

function makeArrayDescriptor(hash, name = "Points") {
  return {
    hash,
    dataType: "Float32Array",
    numberOfComponents: 3,
    size: 3,
    name,
  };
}

function createSceneState(index, dependencyCount) {
  const dependencies = [];

  for (let i = 0; i < dependencyCount; i += 1) {
    const baseHash = `array-${i}`;
    dependencies.push({
      id: `poly-${i}`,
      type: "vtkPolyData",
      mtime: index,
      properties: {
        points: makeArrayDescriptor(baseHash),
        fields: [
          makeArrayDescriptor(`color-${i}`, "RGB"),
          makeArrayDescriptor(`scalar-${i}`, "Intensity"),
        ],
      },
    });
  }

  return {
    id: "rw",
    type: "vtkRenderWindow",
    mtime: index,
    properties: {},
    dependencies,
  };
}

function buildCachedContext(dependencyCount) {
  const cache = new Map();
  const values = new Float32Array([1, 2, 3]);

  for (let i = 0; i < dependencyCount; i += 1) {
    cache.set(`array-${i}`, values);
    cache.set(`color-${i}`, values);
    cache.set(`scalar-${i}`, values);
  }

  return {
    cacheArray(hash, array) {
      cache.set(hash, array);
    },
    getCachedArray(hash) {
      return cache.get(hash) || null;
    },
  };
}

async function flushAsyncWork() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function createReadyPushSync(createPushSync, dependencyCount) {
  const { client, emit } = createClientHarness({
    onCall(method, [arg]) {
      if (method === "vtkjs.push.resync") {
        if (arg !== "rw") {
          throw new Error(`Unexpected render window id: ${arg}`);
        }
        return Promise.resolve({
          id: "rw",
          type: "vtkRenderWindow",
          mtime: 0,
          properties: {},
        });
      }

      if (method === "vtkjs.get.arrays") {
        throw new Error("Benchmark expects all arrays to be cached");
      }

      throw new Error(`Unexpected RPC: ${method}`);
    },
  });

  const sync = createPushSync(
    client,
    {
      async synchronize() {
        return true;
      },
    },
    buildCachedContext(dependencyCount),
    "rw",
  );

  await flushAsyncWork();
  sync.drainReadyStates();

  return { sync, emit };
}

async function runCase(createPushSync, benchCase) {
  const { states, dependencies, drainEvery } = benchCase;
  const { sync, emit } = await createReadyPushSync(
    createPushSync,
    dependencies,
  );

  const t0 = performance.now();
  let drained = 0;

  for (let i = 1; i <= states; i += 1) {
    emit("trame.vtk.delta", createSceneState(i, dependencies));

    if (drainEvery > 0 && i % drainEvery === 0) {
      drained += sync.drainReadyStates().length;
    }
  }

  drained += sync.drainReadyStates().length;
  const durationMs = performance.now() - t0;
  sync.cleanup();

  if (drained !== states) {
    throw new Error(`Expected to drain ${states} states, drained ${drained}`);
  }

  return {
    ...benchCase,
    durationMs,
    statesPerSecond: (states / durationMs) * 1000,
  };
}

async function main() {
  const previousDocument = globalThis.document;
  globalThis.document = createDocumentStub();

  try {
    const { createPushSync } = await loadModule("/src/components/pushSync.js");
    const cases = [
      {
        name: "steady-240x120",
        states: 240,
        dependencies: 120,
        drainEvery: 1,
      },
      {
        name: "backlog-240x120",
        states: 240,
        dependencies: 120,
        drainEvery: 0,
      },
    ];

    // One warmup pass keeps module loading and JIT compilation out of the numbers.
    await runCase(createPushSync, cases[0]);

    const results = [];
    for (const benchCase of cases) {
      const runs = [];
      for (let i = 0; i < 5; i += 1) {
        runs.push(await runCase(createPushSync, benchCase));
      }
      runs.sort((a, b) => a.durationMs - b.durationMs);
      results.push(runs[Math.floor(runs.length / 2)]);
    }

    console.log(JSON.stringify({ results }, null, 2));
  } finally {
    globalThis.document = previousDocument;
    if (viteServer) {
      await viteServer.close();
    }
  }
}

main().catch(async (error) => {
  console.error(error);
  if (viteServer) {
    await viteServer.close();
  }
  process.exitCode = 1;
});
