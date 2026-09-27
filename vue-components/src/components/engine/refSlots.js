// Ref-slot -> vtk.js calls, pinned by the wire protocol. The reconciler
// applies slots through this table and the applied-scene dump reads them back
// through it, so a slot the reconciler writes is one the dump can read.

export const SINGLE_REF_SLOTS = {
  mapper: { set: "setMapper", get: "getMapper" },
  property: { set: "setProperty", get: "getProperty" },
  lookupTable: { set: "setLookupTable", get: "getLookupTable" },
};

export const LIST_REF_SLOTS = {
  renderers: {
    add: "addRenderer",
    remove: "removeRenderer",
    read: "getRenderers",
  },
  viewProps: {
    add: "addViewProp",
    remove: "removeViewProp",
    read: "getViewProps",
  },
  lights: { add: "addLight", remove: "removeLight", read: "getLights" },
  textures: { add: "addTexture", remove: "removeTexture", read: "getTextures" },
};

export const INDEXED_REF_SLOTS = {
  rgbTransferFunction: {
    set: "setRGBTransferFunction",
    get: "getRGBTransferFunction",
  },
  grayTransferFunction: {
    set: "setGrayTransferFunction",
    get: "getGrayTransferFunction",
  },
  scalarOpacity: { set: "setScalarOpacity", get: "getScalarOpacity" },
};
