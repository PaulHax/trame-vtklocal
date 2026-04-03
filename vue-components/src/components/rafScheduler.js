export function createRafScheduler(callback) {
  let rafPending = false;
  let latestArgs = [];

  return function schedule(...args) {
    latestArgs = args;

    if (rafPending) {
      return;
    }

    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      callback(...latestArgs);
    });
  };
}
