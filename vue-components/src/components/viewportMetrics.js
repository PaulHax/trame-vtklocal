// One place owns the device-pixel/CSS-pixel conversion for the rendered view.
//
// vtk.js view sizes are device pixels while every client-facing contract here
// (pointer coordinates, glyph screen size, LOD pixel budgets) is CSS pixels, so
// the sizing path, the pick path and the LOD path must never disagree about the
// divide.

import { isPositiveFinite } from "./predicates";

export function getDevicePixelRatio() {
  const ratio = Number(globalThis.devicePixelRatio);
  return isPositiveFinite(ratio) ? ratio : 1;
}

// Renderer viewport size in CSS px plus its normalized viewport rectangle and
// the viewport's top-left corner in canvas CSS px (canvas y grows downward
// while the vtk viewport rectangle is bottom-up, hence the 1 - max flip), or
// null when the view has no usable size yet.
export function getViewportMetrics(renderer, renderWindow) {
  const viewport = renderer?.getViewport?.() || [0, 0, 1, 1];
  const view = renderWindow?.getViews?.()?.[0] || null;
  const size = view?.getSize?.();
  if (!size || size.length < 2) {
    return null;
  }

  const devicePixelRatio = getDevicePixelRatio();
  const viewWidth = Number(size[0]) / devicePixelRatio;
  const viewHeight = Number(size[1]) / devicePixelRatio;
  const x0 = Number(viewport[0] ?? 0);
  const y0 = Number(viewport[1] ?? 0);
  const x1 = Number(viewport[2] ?? 1);
  const y1 = Number(viewport[3] ?? 1);
  const width = Math.abs(x1 - x0) * viewWidth;
  const height = Math.abs(y1 - y0) * viewHeight;
  if (!isPositiveFinite(width) || !isPositiveFinite(height)) {
    return null;
  }

  return {
    width,
    height,
    aspect: width / height,
    viewport: [x0, y0, x1, y1],
    leftCssPx: Math.min(x0, x1) * viewWidth,
    topCssPx: (1 - Math.max(y0, y1)) * viewHeight,
  };
}
