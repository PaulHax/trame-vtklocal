// Zero-import leaf predicates shared across the client components.

// A vtk.js instance the caller may still touch. Deleted instances throw (or
// silently corrupt state) when fed to setters, so every consumer gates on this.
export function isLiveInstance(instance) {
  return (
    !!instance &&
    !(typeof instance.isDeleted === "function" && instance.isDeleted())
  );
}

export function isPositiveFinite(value) {
  return Number.isFinite(value) && value > 0;
}
