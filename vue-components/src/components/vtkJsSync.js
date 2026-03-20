import vtkSynchronizableRenderWindow from "@kitware/vtk.js/Rendering/Misc/SynchronizableRenderWindow";

export function createFetchArray(client) {
  return async function fetchArray(hash) {
    const session = client.getConnection().getSession();
    const content = await session.call("vtkjs.get.array", [hash, null]);
    if (content.arrayBuffer) {
      return await content.arrayBuffer();
    }
    if (content instanceof Uint8Array) {
      return content.buffer.slice(
        content.byteOffset,
        content.byteOffset + content.byteLength
      );
    }
    if (content instanceof ArrayBuffer) {
      return content;
    }
    return content;
  };
}

export function createSyncContext(client, contextName, renderWindow) {
  const synchronizerContext =
    vtkSynchronizableRenderWindow.getSynchronizerContext(contextName);
  synchronizerContext.setFetchArrayFunction(createFetchArray(client));
  const syncRenderWindow = vtkSynchronizableRenderWindow.decorate(
    renderWindow,
    contextName
  );
  return { synchronizerContext, syncRenderWindow };
}

export function getSyncedRenderers(renderWindow) {
  return renderWindow.getRenderers().filter(
    (ren) =>
      ren.get("remoteId")?.remoteId !== undefined ||
      ren.get("managedInstanceId")?.managedInstanceId !== undefined
  );
}

export function cleanupSyncContext(contextName) {
  vtkSynchronizableRenderWindow.clearSynchronizerContext(contextName);
}

export function extractCameraParams(camera) {
  return {
    position: camera.getPosition(),
    focalPoint: camera.getFocalPoint(),
    viewUp: camera.getViewUp(),
    viewAngle: camera.getViewAngle(),
    parallelProjection: camera.getParallelProjection(),
    parallelScale: camera.getParallelScale(),
    clippingRange: camera.getClippingRange(),
  };
}

export function applyCameraParams(camera, params) {
  if (params.position) camera.setPosition(...params.position);
  if (params.focalPoint) camera.setFocalPoint(...params.focalPoint);
  if (params.viewUp) camera.setViewUp(...params.viewUp);
  if (params.viewAngle !== undefined) camera.setViewAngle(params.viewAngle);
  if (params.parallelProjection !== undefined)
    camera.setParallelProjection(params.parallelProjection);
  if (params.parallelScale !== undefined)
    camera.setParallelScale(params.parallelScale);
  if (params.clippingRange) camera.setClippingRange(...params.clippingRange);
}
