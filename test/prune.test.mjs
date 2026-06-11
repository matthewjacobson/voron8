import { test } from "node:test";
import assert from "node:assert/strict";
import { medialAxis, tessellate } from "../dist/voron8.js";
import { buildMedialTree, pruneTree } from "../example/prune.js";

// A rectangle with four short spikes off the top edge — small features that
// pruning should remove before the main horizontal spine.
const COMB = [
  [
    [0, 0], [100, 0], [100, 40],
    [82, 40], [80, 52], [78, 40],
    [62, 40], [60, 52], [58, 40],
    [42, 40], [40, 52], [38, 40],
    [22, 40], [20, 52], [18, 40],
    [0, 40],
  ],
];

const L_SHAPE = [
  [ [0, 0], [6, 0], [6, 2], [2, 2], [2, 6], [0, 6] ],
];

async function setup(polygons) {
  const medial = await medialAxis(polygons);
  const tree = buildMedialTree(medial, polygons, tessellate, 24);
  const boundedCount = medial.edges.filter((e) => e.from >= 0 && e.to >= 0).length;
  const keep = (a, d, ar) => pruneTree(tree, a, d, ar).filter(Boolean).length;
  return { medial, tree, boundedCount, keep };
}

test("all-zero thresholds keep every bounded edge", async () => {
  const { boundedCount, keep } = await setup(COMB);
  assert.equal(keep(0, 0, 0), boundedCount);
});

test("the tree is rooted at the widest disk", async () => {
  const { tree } = await setup(COMB);
  assert.ok(tree.roots.length >= 1);
  const maxR = Math.max(...tree.radius.values());
  for (const root of tree.roots) {
    // each component root has distance 0 and the max radius among reachable nodes
    assert.equal(tree.distance.get(root), 0);
  }
  // The global widest disk is a root.
  const widest = [...tree.radius.entries()].sort((a, b) => b[1] - a[1])[0][0];
  assert.ok(tree.roots.includes(widest));
  assert.ok(maxR > 0);
});

test("each threshold prunes monotonically and 1 removes (almost) everything", async () => {
  const { boundedCount, keep } = await setup(COMB);
  for (const axis of [0, 1, 2]) { // axial, distance, area
    let prev = Infinity;
    for (const t of [0, 0.2, 0.4, 0.7, 1]) {
      const args = [0, 0, 0];
      args[axis] = t;
      const c = keep(...args);
      assert.ok(c <= prev, `measure ${axis} non-increasing at t=${t} (${c} > ${prev})`);
      prev = c;
    }
    const args = [0, 0, 0];
    args[axis] = 1;
    assert.ok(keep(...args) < boundedCount, `measure ${axis}=1 prunes`);
  }
});

test("distance pruning removes the periphery, keeping a connected core at the root", async () => {
  const { tree, keep, boundedCount } = await setup(COMB);
  // A mid distance threshold keeps fewer edges but not zero.
  const mid = keep(0, 0.5, 0);
  assert.ok(mid > 0 && mid < boundedCount);
  // Every kept tree edge is within the mapped distance of the root.
  const alive = pruneTree(tree, 0, 0.5, 0);
  const ceiling = tree.furthestDistance * 0.5;
  tree.edges.forEach((e, i) => {
    if (alive[i] && tree.treeEdges.has(i)) {
      const child = tree.parentEdge.get(e.from) === i ? e.from : e.to;
      assert.ok(tree.distance.get(child) <= ceiling + 1e-9);
    }
  });
});

test("axial pruning keeps shallow-gradient edges and drops steep tapers", async () => {
  const { tree } = await setup(COMB);
  const alive = pruneTree(tree, 0.5, 0, 0);
  const a = 0.5 ** 3;
  const floor = tree.minGrad + (tree.maxGrad - tree.minGrad) * a;
  tree.edges.forEach((e, i) => {
    if (alive[i] && tree.treeEdges.has(i)) {
      const child = tree.parentEdge.get(e.from) === i ? e.from : e.to;
      assert.ok(tree.axialGradient.get(child) >= floor - 1e-9);
    }
  });
});

test("works on a real archived polygon (mapbox-building)", async () => {
  const url =
    "https://raw.githubusercontent.com/LingDong-/interesting-polygon-archive/master/json/mapbox-building.json";
  const polygons = await (await fetch(url)).json();
  const { boundedCount, keep } = await setup(polygons);
  assert.equal(keep(0, 0, 0), boundedCount);
  assert.ok(keep(0.3, 0.3, 0.3) < boundedCount);
  assert.ok(keep(0.3, 0.3, 0.3) > 0);
});
