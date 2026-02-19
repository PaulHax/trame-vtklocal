export function createPullSync(client, syncRenderWindow, synchronizerContext, rwId) {
  async function update() {
    const session = client.getConnection().getSession();
    const state = await session.call("vtkjs.get.state", [Number(rwId)]);
    if (!state || !syncRenderWindow) return null;

    synchronizerContext.emptyCachedInstances();
    synchronizerContext.emptyCachedArrays();

    const synced = await syncRenderWindow.synchronize(state);
    return synced ? state : null;
  }

  function cleanup() {}

  return { update, cleanup };
}
