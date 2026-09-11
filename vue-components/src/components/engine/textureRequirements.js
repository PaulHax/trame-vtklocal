// Only the small render graph participates in texture admission. Geometry
// arrays and blobs stay in the ordinary scene queue and reconciler.
const TYPES = new Set([
  "vtkRenderWindow",
  "vtkRenderer",
  "vtkActor",
  "vtkActor2D",
  "vtkAssembly",
  "vtkPropAssembly",
  "vtkProperty",
  "vtkProjectedTextureMapper",
]);

function isRenderNode(node) {
  return (
    TYPES.has(node?.type) ||
    ["mapper", "viewProps", "renderers", "parts"].some(
      (slot) => node?.refs?.[slot] !== undefined,
    )
  );
}

export function textureGraphAfter(previous, message, snapshot = false) {
  let next = snapshot ? new Map() : previous;
  const put = (id, node) => {
    id = String(id);
    if (!isRenderNode(node) && !next.has(id)) return;
    if (next === previous) next = new Map(previous);
    if (isRenderNode(node)) next.set(id, node);
    else next.delete(id);
  };
  if (snapshot) {
    for (const [id, node] of Object.entries(message.nodes || {})) put(id, node);
  } else {
    for (const op of message.ops || []) {
      if (op.op === "upsert") put(op.id, op.node);
      else if (op.op === "remove") put(op.id, null);
    }
  }
  return next;
}

export function requiredTextures(graph, rootId) {
  const result = new Set();
  const visited = new Set();
  const get = (id) => graph.get(String(id));
  const visit = (id) => {
    id = String(id);
    if (visited.has(id)) return;
    visited.add(id);
    const node = get(id);
    if (
      !node ||
      node.props?.visibility === 0 ||
      node.props?.visibility === false ||
      node.props?.draw === 0 ||
      node.props?.draw === false
    )
      return;
    const property = get(node.refs?.property);
    if (property?.props?.opacity === 0) return;
    const mapper = get(node.refs?.mapper);
    if (
      mapper?.type === "vtkProjectedTextureMapper" &&
      mapper.blocks?.projectedTexture?.textureKey
    ) {
      result.add(mapper.blocks.projectedTexture.textureKey);
    }
    for (const slot of ["renderers", "viewProps", "parts"]) {
      const refs = node.refs?.[slot];
      for (const ref of Array.isArray(refs) ? refs : refs == null ? [] : [refs])
        visit(ref);
    }
  };
  visit(rootId);
  return result;
}
