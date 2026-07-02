// Per-render-window registry of externally sourced textures (video frames,
// generated canvases, ...), keyed by name. vtkProjectedTextureMapper resolves
// its `textureKey` here at render time, so a rebuilt scene re-binds by key with
// no client choreography.
//
// Uploads are raw texImage2D with explicit UNPACK_FLIP_Y_WEBGL=false and
// UNPACK_PREMULTIPLY_ALPHA_WEBGL=false. vtk.js's vtkOpenGLTexture cannot be
// used here: create2DFromImage force-flips Y, create2DFromImageBitmap inherits
// whatever ambient flip state the context is in, and the non-resizable paths
// allocate immutable texStorage2D storage that breaks per-frame re-upload.
// Projective-texture sampling conventions depend on unflipped uploads.

// Registries are scoped per renderable vtkRenderWindow: in the shared-GL
// architecture the context is shared across views but serialization scope and
// instances are per view, so each view uploads its own copy (same cost shape
// as the previous per-view raw-texture instances).
const registries = new WeakMap();

function createTextureState() {
  return {
    glContext: null,
    glTexture: null,
    width: 0,
    height: 0,
    needsUpload: false,
    uploadSource: null,
    pixelData: null,
  };
}

function createTexture(gl, textureState) {
  textureState.glContext = gl;
  textureState.glTexture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, textureState.glTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  // 1x1 transparent placeholder so consumers render invisible (not black)
  // until the first real source arrives.
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    1,
    1,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    new Uint8Array([0, 0, 0, 0]),
  );
}

function uploadPending(gl, textureState) {
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

  if (textureState.uploadSource) {
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      textureState.uploadSource,
    );
  } else if (textureState.pixelData) {
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      textureState.width,
      textureState.height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      textureState.pixelData,
    );
  }
  textureState.needsUpload = false;
  textureState.uploadSource = null;
  textureState.pixelData = null;
}

function deleteTexture(textureState) {
  if (textureState.glTexture && textureState.glContext) {
    textureState.glContext.deleteTexture(textureState.glTexture);
  }
  textureState.glContext = null;
  textureState.glTexture = null;
}

function createExternalTextureRegistry() {
  const entries = new Map();

  function getOrCreateEntry(key) {
    let entry = entries.get(key);
    if (!entry) {
      entry = createTextureState();
      entries.set(key, entry);
    }
    return entry;
  }

  return {
    // source: any TexImageSource (ImageBitmap, canvas, ImageData, video
    // element) or a typed pixel array with explicit width/height. The caller
    // owns the source's lifetime until the next bind uploads it.
    setSource(key, source, { width = 0, height = 0 } = {}) {
      const entry = getOrCreateEntry(key);
      const isPixelData = ArrayBuffer.isView(source);
      entry.width = isPixelData ? width : (source?.width ?? width);
      entry.height = isPixelData ? height : (source?.height ?? height);
      entry.uploadSource = isPixelData ? null : source;
      entry.pixelData = isPixelData ? source : null;
      entry.needsUpload = true;
    },

    hasSource(key) {
      return entries.has(key);
    },

    // Bind the texture for `key` on the currently active texture unit,
    // creating it (placeholder) and uploading any pending source. The caller
    // selects the unit; the entry (re)creates its GL object when the context
    // changed (view rebuild) since the prior handle died with its context.
    bindTexture(key, gl) {
      if (!gl) {
        return false;
      }
      const entry = getOrCreateEntry(key);
      if (!entry.glTexture || entry.glContext !== gl) {
        createTexture(gl, entry);
      }
      gl.bindTexture(gl.TEXTURE_2D, entry.glTexture);
      if (entry.needsUpload) {
        uploadPending(gl, entry);
      }
      return true;
    },

    removeKey(key) {
      const entry = entries.get(key);
      if (entry) {
        deleteTexture(entry);
        entries.delete(key);
      }
    },

    clear() {
      for (const entry of entries.values()) {
        deleteTexture(entry);
      }
      entries.clear();
    },

    describe() {
      const described = [];
      for (const [key, entry] of entries) {
        described.push({
          key,
          width: entry.width,
          height: entry.height,
          needsUpload: entry.needsUpload,
          created: !!entry.glTexture,
        });
      }
      return { size: entries.size, entries: described };
    },
  };
}

export function getExternalTextures(renderWindow) {
  if (!renderWindow || typeof renderWindow !== "object") {
    return null;
  }
  let registry = registries.get(renderWindow);
  if (!registry) {
    registry = createExternalTextureRegistry();
    registries.set(renderWindow, registry);
  }
  return registry;
}

// Read-only lookup for cleanup and diagnostics paths that must not create a
// registry as a side effect.
export function peekExternalTextures(renderWindow) {
  if (!renderWindow || typeof renderWindow !== "object") {
    return null;
  }
  return registries.get(renderWindow) || null;
}

export default { getExternalTextures, peekExternalTextures };
