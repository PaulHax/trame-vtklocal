// Ordered registration arm state. Transport delivery may lag a newer command.
export function createRegistrationGesture() {
  let current = { generation: -1, token: null, asset_id: null };
  return {
    set(spec) {
      if (
        !spec ||
        !Number.isSafeInteger(spec.generation) ||
        spec.generation <= current.generation
      ) {
        return false;
      }
      current = { ...spec };
      return true;
    },
    capture() {
      return current;
    },
  };
}
