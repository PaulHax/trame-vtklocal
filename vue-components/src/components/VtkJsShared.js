import { ref, inject, onBeforeUnmount } from "vue";

import "@kitware/vtk.js/Rendering/Profiles/Geometry";

import vtkRenderWindow from "@kitware/vtk.js/Rendering/Core/RenderWindow";
import vtkSharedRenderWindow from "@kitware/vtk.js/Rendering/OpenGL/SharedRenderWindow";
import vtkRenderPass from "@kitware/vtk.js/Rendering/SceneGraph/RenderPass";

import {
  createSyncContext,
  getSyncedRenderers,
  cleanupSyncContext,
} from "./vtkJsSync";

const TYPED_ARRAY_CONSTRUCTORS = {
  Int8Array,
  Uint8Array,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
};

export default {
  emits: ["updated", "viewStateChange", "onReady", "beforeSceneLoaded", "afterSceneLoaded"],
  props: {
    renderWindow: {
      type: Number,
      required: true,
    },
    wsClient: {
      type: Object,
    },
  },
  setup(props, { emit }) {
    const trame = inject("trame");
    const client = props.wsClient || trame?.client;
    const ready = ref(false);

    let sharedRenderWindow = null;
    let renderWindow = null;
    let syncRenderWindow = null;
    let synchronizerContext = null;
    let buildOnlyPass = null;
    let renderRequestedCallback = null;
    let repaintCallback = null;
    let syncStateAtRenderFlag = false;
    let wsSubscription = null;
    let wsPartialUpdateSubscription = null;
    let stateQueue = [];
    let rwId = null;
    let visibilityHandler = null;
    let freshRenderer = null;
    let glContext = null;

    function resetGLStateForSharedContext() {
      const gl = glContext;
      if (!gl) return;

      const width = gl.drawingBufferWidth;
      const height = gl.drawingBufferHeight;

      gl.disable(gl.SCISSOR_TEST);
      gl.viewport(0, 0, width, height);
      gl.scissor(0, 0, width, height);
    }

    function setRepaintCallback(fn) {
      repaintCallback = fn;
    }

    function initializeForSharedContext(canvas, gl, options = {}) {
      const { syncStateAtRender = false, onResyncRequired = null } = options;

      syncStateAtRenderFlag = syncStateAtRender;
      glContext = gl;

      const contextName = `vtkjs-shared-${props.renderWindow}`;

      sharedRenderWindow = vtkSharedRenderWindow.createFromContext(canvas, gl);

      renderWindow = vtkRenderWindow.newInstance();
      renderWindow.addView(sharedRenderWindow);

      buildOnlyPass = vtkRenderPass.newInstance({
        preDelegateOperations: ["buildPass"],
      });

      const ctx = createSyncContext(client, contextName, renderWindow);
      synchronizerContext = ctx.synchronizerContext;
      syncRenderWindow = ctx.syncRenderWindow;

      rwId = String(props.renderWindow);

      wsSubscription = client
        .getConnection()
        .getSession()
        .subscribe("trame.vtk.delta", ([deltaState]) => {
          if (!rwId || deltaState.id === rwId) {
            if (!rwId) {
              rwId = deltaState.id;
            }
            stateQueue.push(deltaState);
            emit("viewStateChange", deltaState);
            if (syncStateAtRenderFlag) {
              if (repaintCallback) {
                repaintCallback();
              }
            } else {
              applyQueuedState().then(() => {
                if (renderRequestedCallback) {
                  renderRequestedCallback();
                }
              });
            }
          }
        });

      wsPartialUpdateSubscription = client
        .getConnection()
        .getSession()
        .subscribe("trame.vtk.array.partial", async ([update]) => {
          if (!synchronizerContext) return;

          if (stateQueue.length > 0) {
            await applyQueuedState();
          }

          const { instanceId, arrayPath, offset, data, dataType } = update;

          const instance = synchronizerContext.getInstance(instanceId);
          if (!instance) {
            console.warn(`[VtkJsShared] Instance ${instanceId} not found for partial update`);
            return;
          }

          let target = instance;
          if (arrayPath === "points" && instance.getPoints) {
            target = instance.getPoints();
          } else if (arrayPath === "polys" && instance.getPolys) {
            target = instance.getPolys();
          } else if (arrayPath === "lines" && instance.getLines) {
            target = instance.getLines();
          } else if (arrayPath === "verts" && instance.getVerts) {
            target = instance.getVerts();
          } else if (arrayPath === "strips" && instance.getStrips) {
            target = instance.getStrips();
          }

          if (!target || typeof target.getData !== "function") {
            console.warn(`[VtkJsShared] Cannot find array at path ${arrayPath} on instance ${instanceId}`);
            return;
          }

          const values = target.getData();
          if (!values) {
            console.warn(`[VtkJsShared] No data array found at ${arrayPath}`);
            return;
          }

          const TypedArrayCtor = TYPED_ARRAY_CONSTRUCTORS[dataType] || Float32Array;
          let newData;
          if (typeof data === "string") {
            const binaryStr = atob(data);
            const bytes = new Uint8Array(binaryStr.length);
            for (let i = 0; i < binaryStr.length; i++) {
              bytes[i] = binaryStr.charCodeAt(i);
            }
            newData = new TypedArrayCtor(bytes.buffer);
          } else {
            newData = new TypedArrayCtor(data);
          }

          const TargetCtor = values.constructor;
          if (TypedArrayCtor !== TargetCtor) {
            newData = new TargetCtor(newData);
          }

          if (offset + newData.length > values.length) {
            console.warn(
              `[VtkJsShared] Partial update out of bounds: offset=${offset}, ` +
              `newData.length=${newData.length}, values.length=${values.length}`
            );
            return;
          }

          values.set(newData, offset);

          if (target.modified) {
            target.modified();
          }

          if (instance.modified) {
            instance.modified();
          }

          if (renderRequestedCallback) {
            renderRequestedCallback();
          }
        });

      if (onResyncRequired) {
        visibilityHandler = () => {
          if (document.visibilityState === "visible") {
            stateQueue.length = 0;
            onResyncRequired();
          }
        };
        document.addEventListener("visibilitychange", visibilityHandler);
      }

      ready.value = true;
      emit("onReady", true);
    }

    async function applyQueuedState() {
      if (!stateQueue.length || !syncRenderWindow) return false;

      emit("beforeSceneLoaded");
      while (stateQueue.length) {
        const state = stateQueue.shift();
        try {
          sharedRenderWindow?.prepareSharedRender?.();
          const synced = await syncRenderWindow.synchronize(state);
          if (synced) {
            const syncedRenderers = getSyncedRenderers(renderWindow);
            if (syncedRenderers.length > 0) {
              freshRenderer = syncedRenderers[0];
            }
            emit("updated");
          }
        } catch (err) {
          console.error("VtkJsShared: synchronize error", err);
        }
      }
      emit("afterSceneLoaded");
      return true;
    }

    async function renderShared(options = {}) {
      const { skipRender = false } = options;

      await applyQueuedState();

      if (!skipRender && sharedRenderWindow) {
        sharedRenderWindow.renderShared({});
        resetGLStateForSharedContext();
      }
    }

    function onRenderRequested(callback) {
      renderRequestedCallback = callback;
      if (sharedRenderWindow?.setRenderCallback) {
        sharedRenderWindow.setRenderCallback(callback);
      }
    }

    function getRenderWindow() {
      return renderWindow;
    }

    function getRenderer() {
      return freshRenderer || renderWindow?.getRenderersByReference?.()?.[0] || null;
    }

    onBeforeUnmount(() => {
      if (wsSubscription && client) {
        client.getConnection().getSession().unsubscribe(wsSubscription);
        wsSubscription = null;
      }

      if (wsPartialUpdateSubscription && client) {
        client.getConnection().getSession().unsubscribe(wsPartialUpdateSubscription);
        wsPartialUpdateSubscription = null;
      }

      if (visibilityHandler) {
        document.removeEventListener("visibilitychange", visibilityHandler);
        visibilityHandler = null;
      }

      if (sharedRenderWindow) {
        sharedRenderWindow.delete();
        sharedRenderWindow = null;
      }

      if (renderWindow) {
        renderWindow.delete();
        renderWindow = null;
      }

      if (buildOnlyPass) {
        buildOnlyPass.delete();
        buildOnlyPass = null;
      }

      cleanupSyncContext(`vtkjs-shared-${props.renderWindow}`);
      synchronizerContext = null;
    });

    return {
      initializeForSharedContext,
      renderShared,
      onRenderRequested,
      setRepaintCallback,
      getRenderWindow,
      getRenderer,
      resetGLStateForSharedContext,
    };
  },
  template: `<div style="display: none;"></div>`,
};
