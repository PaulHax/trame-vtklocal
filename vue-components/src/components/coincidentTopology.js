export const COINCIDENT_TOPOLOGY_BLOCK_KEY = "coincidentTopology";

const activeMappers = new Set();
let staticOffsets = null;

function setStaticOffsets(mapper, offsets) {
  mapper.setResolveCoincidentTopologyLineOffsetParameters(
    offsets.line.factor,
    offsets.line.offset,
  );
  mapper.setResolveCoincidentTopologyPolygonOffsetParameters(
    offsets.polygon.factor,
    offsets.polygon.offset,
  );
  mapper.setResolveCoincidentTopologyPointOffsetParameters(
    offsets.point.factor,
    offsets.point.offset,
  );
}

function ownStaticOffsets(mapper) {
  staticOffsets = {
    line: { ...mapper.getResolveCoincidentTopologyLineOffsetParameters() },
    polygon: {
      ...mapper.getResolveCoincidentTopologyPolygonOffsetParameters(),
    },
    point: { ...mapper.getResolveCoincidentTopologyPointOffsetParameters() },
  };
  setStaticOffsets(mapper, {
    line: { factor: 0, offset: 0 },
    polygon: { factor: 0, offset: 0 },
    point: { factor: 0, offset: 0 },
  });
}

export function applyCoincidentTopologyBlock(block, mapper) {
  if (!mapper?.setResolveCoincidentTopologyToPolygonOffset) return;

  if (!block) {
    activeMappers.delete(mapper);
    if (activeMappers.size === 0 && staticOffsets) {
      mapper.setResolveCoincidentTopologyToOff();
      setStaticOffsets(mapper, staticOffsets);
      staticOffsets = null;
    }
    mapper.setRelativeCoincidentTopologyLineOffsetParameters(0, 0);
    mapper.setRelativeCoincidentTopologyPolygonOffsetParameters(0, 0);
    return;
  }

  if (activeMappers.size === 0) ownStaticOffsets(mapper);
  activeMappers.add(mapper);
  mapper.setResolveCoincidentTopologyToPolygonOffset();
  mapper.setRelativeCoincidentTopologyLineOffsetParameters(
    block.line.factor,
    block.line.offset,
  );
  mapper.setRelativeCoincidentTopologyPolygonOffsetParameters(
    block.polygon.factor,
    block.polygon.offset,
  );
}

export function createCoincidentTopologyHandler() {
  const ownedMappers = new Set();
  return {
    apply(block, mapper) {
      if (block) ownedMappers.add(mapper);
      else ownedMappers.delete(mapper);
      applyCoincidentTopologyBlock(block, mapper);
    },
    clear() {
      for (const mapper of ownedMappers)
        applyCoincidentTopologyBlock(null, mapper);
      ownedMappers.clear();
    },
  };
}
