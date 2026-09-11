// CSS-hidden panels must not keep independent streaming/governor loops alive.
// Observe the ancestor chain instead of reading layout on every render.
export function observeElementVisibility(element, changed) {
  const document = element?.ownerDocument;
  // Offscreen canvases have no DOM visibility to follow.
  if (!document) return { dispose() {} };
  const window = document.defaultView;
  let disposed = false;
  let visible;
  const observer = new window.MutationObserver(refresh);
  const resizeObserver = new window.ResizeObserver(refresh);

  function refresh() {
    if (disposed) return;
    observer.disconnect();
    if (!element.isConnected) {
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
    } else {
      for (let node = element; node; node = node.parentElement) {
        observer.observe(node, {
          attributes: true,
          attributeFilter: ["class", "style", "hidden"],
          childList: true,
        });
      }
    }
    const next = element.checkVisibility({ visibilityProperty: true });
    if (next === visible) return;
    visible = next;
    changed(next);
  }

  resizeObserver.observe(element);
  window.addEventListener("resize", refresh);
  refresh();
  return {
    dispose() {
      disposed = true;
      observer.disconnect();
      resizeObserver.disconnect();
      window.removeEventListener("resize", refresh);
    },
  };
}
