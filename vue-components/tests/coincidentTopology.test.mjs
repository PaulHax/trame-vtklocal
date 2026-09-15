import assert from "node:assert/strict";
import { after, test } from "node:test";

import { closeModuleLoader, loadModule } from "./loadModule.mjs";

after(async () => {
  await closeModuleLoader();
});

test("scene depth offsets apply to the live vtk.js mapper and clear on removal", async () => {
  const { applyCoincidentTopologyBlock } = await loadModule(
    "/src/components/coincidentTopology.js",
  );
  const { default: vtkMapper } = await loadModule(
    "/node_modules/@kitware/vtk.js/Rendering/Core/Mapper.js",
  );
  const mapper = vtkMapper.newInstance();
  const unmarked = vtkMapper.newInstance();
  const defaults = {
    line: { ...mapper.getResolveCoincidentTopologyLineOffsetParameters() },
    polygon: {
      ...mapper.getResolveCoincidentTopologyPolygonOffsetParameters(),
    },
    point: { ...mapper.getResolveCoincidentTopologyPointOffsetParameters() },
  };

  applyCoincidentTopologyBlock(
    {
      line: { factor: 0, offset: -4 },
      polygon: { factor: 1, offset: -2 },
    },
    mapper,
  );
  assert.equal(mapper.getResolveCoincidentTopology(), 1);
  assert.deepEqual(mapper.getRelativeCoincidentTopologyLineOffsetParameters(), {
    factor: 0,
    offset: -4,
  });
  assert.deepEqual(
    mapper.getRelativeCoincidentTopologyPolygonOffsetParameters(),
    {
      factor: 1,
      offset: -2,
    },
  );
  assert.deepEqual(unmarked.getCoincidentTopologyLineOffsetParameters(), {
    factor: 0,
    offset: 0,
  });
  assert.deepEqual(unmarked.getCoincidentTopologyPolygonOffsetParameters(), {
    factor: 0,
    offset: 0,
  });
  assert.deepEqual(unmarked.getCoincidentTopologyPointOffsetParameter(), {
    factor: 0,
    offset: 0,
  });

  applyCoincidentTopologyBlock(null, mapper);
  assert.equal(mapper.getResolveCoincidentTopology(), 0);
  assert.deepEqual(mapper.getRelativeCoincidentTopologyLineOffsetParameters(), {
    factor: 0,
    offset: 0,
  });
  assert.deepEqual(
    mapper.getResolveCoincidentTopologyLineOffsetParameters(),
    defaults.line,
  );
  assert.deepEqual(
    mapper.getResolveCoincidentTopologyPolygonOffsetParameters(),
    defaults.polygon,
  );
  assert.deepEqual(
    mapper.getResolveCoincidentTopologyPointOffsetParameters(),
    defaults.point,
  );
});

test("a second offset mapper keeps the shared depth mode enabled", async () => {
  const { applyCoincidentTopologyBlock } = await loadModule(
    "/src/components/coincidentTopology.js",
  );
  const { default: vtkMapper } = await loadModule(
    "/node_modules/@kitware/vtk.js/Rendering/Core/Mapper.js",
  );
  const rays = vtkMapper.newInstance();
  const frustum = vtkMapper.newInstance();

  applyCoincidentTopologyBlock(
    { line: { factor: 0, offset: 2 }, polygon: { factor: 0, offset: 0 } },
    rays,
  );
  applyCoincidentTopologyBlock(
    { line: { factor: 0, offset: -4 }, polygon: { factor: 0, offset: 0 } },
    frustum,
  );
  applyCoincidentTopologyBlock(null, rays);
  assert.equal(frustum.getResolveCoincidentTopology(), 1);
  applyCoincidentTopologyBlock(null, frustum);
  assert.equal(frustum.getResolveCoincidentTopology(), 0);
});

test("disposing one view leaves another view's depth mode intact", async () => {
  const { createCoincidentTopologyHandler } = await loadModule(
    "/src/components/coincidentTopology.js",
  );
  const { default: vtkMapper } = await loadModule(
    "/node_modules/@kitware/vtk.js/Rendering/Core/Mapper.js",
  );
  const firstView = createCoincidentTopologyHandler();
  const secondView = createCoincidentTopologyHandler();
  const first = vtkMapper.newInstance();
  const second = vtkMapper.newInstance();
  const block = {
    line: { factor: 0, offset: -4 },
    polygon: { factor: 0, offset: 0 },
  };

  firstView.apply(block, first);
  secondView.apply(block, second);
  firstView.clear();
  assert.equal(second.getResolveCoincidentTopology(), 1);
  secondView.clear();
  assert.equal(second.getResolveCoincidentTopology(), 0);
});
