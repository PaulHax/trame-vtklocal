import components from "./components";

import vtkTexture from "@kitware/vtk.js/Rendering/Core/Texture";
import vtkImageData from "@kitware/vtk.js/Common/DataModel/ImageData";
import vtkDataArray from "@kitware/vtk.js/Common/Core/DataArray";

// Expose vtk.js utilities for external modules (e.g. map_video_texturing)
if (typeof window !== "undefined") {
  window.trame = window.trame || {};
  window.trame.utils = window.trame.utils || {};
  window.trame.utils.vtk = { vtkTexture, vtkImageData, vtkDataArray };
}

export function install(Vue) {
  Object.keys(components).forEach((name) => {
    Vue.component(name, components[name]);
  });
}
