import components from "./components";

// Publishes window.trameVtklocal.glMatrix ({ mat4, vec3 }) on load.
import "./glMatrix";

export function install(Vue) {
  Object.keys(components).forEach((name) => {
    Vue.component(name, components[name]);
  });
}
