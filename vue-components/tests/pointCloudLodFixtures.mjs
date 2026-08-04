// Shared scaffolding for the point-cloud LOD suites.
//
// The four LOD test files each drive the same streamed cloud, so they need the
// same tile-service stand-in: one PCT1 tile and the one-node hierarchy that
// points at it. Encoding that wire format in one place is what keeps a change
// to it from being a four-file edit — and from being made in three of them.

import { loadModule } from "./loadModule.mjs";

export const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Two points straddling the origin — the default tile payload. */
export const POSITIONS = [0.1, 0.1, 0.1, -0.1, -0.1, -0.1];

/** Matching per-point RGB for a payload that carries colour. */
export const RGB = [255, 0, 0, 0, 200, 0];

const PCT1_HEADER_BYTES = 40;

export async function loadLodModule() {
  return loadModule("/src/components/pointCloudLod.js");
}

/**
 * Encode one PCT1 tile: magic, point count, an RGB flag, a float64 origin, then
 * the interleaved float32 positions and optional u8 colours.
 */
export function makePct1(positions, rgb) {
  const bytes =
    PCT1_HEADER_BYTES + positions.length * 4 + (rgb ? rgb.length : 0);
  const buffer = new ArrayBuffer(bytes);
  const view = new DataView(buffer);
  for (let index = 0; index < 4; index += 1) {
    view.setUint8(index, "PCT1".charCodeAt(index));
  }
  view.setUint32(4, positions.length / 3, true);
  view.setUint32(8, rgb ? 1 : 0, true);
  view.setFloat64(16, 0, true);
  view.setFloat64(24, 0, true);
  view.setFloat64(32, 0, true);
  new Float32Array(buffer, PCT1_HEADER_BYTES, positions.length).set(positions);
  if (rgb) {
    new Uint8Array(
      buffer,
      PCT1_HEADER_BYTES + positions.length * 4,
      rgb.length,
    ).set(rgb);
  }
  return buffer;
}

/** The single-node hierarchy the stub serves, wrapping the one tile above. */
export const HIERARCHY = {
  nodes: {
    "0-0-0-0": {
      pointCount: 2,
      children: [],
      page: null,
      bounds: { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
      spacing: 0.1,
    },
  },
};

/**
 * Replace global fetch with the one-tile service and return the array of URLs
 * it was asked for, so a caller can assert what was requested.
 */
export function stubFetch({ positions = POSITIONS, rgb = RGB } = {}) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes("/hierarchy/")) {
      return new Response(JSON.stringify(HIERARCHY), { status: 200 });
    }
    return new Response(makePct1(positions, rgb), { status: 200 });
  };
  return calls;
}
