import { test } from "node:test";
import assert from "node:assert/strict";
import { medialAxis, tessellate } from "../dist/voron8.js";
import { precomputeMetrics, prune } from "../example/prune.js";

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
  const metrics = precomputeMetrics(medial, polygons, tessellate, 16);
  const count = (mode, t) => prune(medial, metrics, mode, t).filter(Boolean).length;
  return { medial, metrics, count };
}

test("mode 'none' keeps every medial edge", async () => {
  const { medial, count } = await setup(COMB);
  assert.equal(count("none", 0), medial.edges.length);
  assert.equal(count("length", 0), medial.edges.length, "threshold 0 prunes nothing");
});

test("length pruning is monotonic and prunes progressively", async () => {
  const { medial, count } = await setup(COMB);
  const full = medial.edges.length;
  const seq = [0, 20, 40, 60].map((t) => count("length", t));
  assert.equal(seq[0], full, "threshold 0 prunes nothing");
  for (let i = 1; i < seq.length; i++) {
    assert.ok(seq[i] <= seq[i - 1], "larger threshold keeps fewer-or-equal edges");
  }
  assert.ok(seq.some((c) => c > 0 && c < full), "some threshold partially prunes");
  assert.equal(count("length", 1e6), 0, "a huge threshold removes everything");
});

test("area pruning is monotonic", async () => {
  const { count } = await setup(COMB);
  let prev = Infinity;
  for (const t of [0, 10, 50, 200, 1000]) {
    const c = count("area", t);
    assert.ok(c <= prev, `area kept-count non-increasing at t=${t}`);
    prev = c;
  }
});

test("angle pruning removes branches off the flattest corners first", async () => {
  // Spike tips (~20° corner -> ~160° sharpness) are very sharp; the rectangle's
  // 90° corners are less sharp (90° sharpness). A threshold between the two
  // keeps the spikes and trims the rectangle-corner branches.
  const { count } = await setup(COMB);
  const full = count("angle", 0);
  const mid = count("angle", 100); // 90° corners (sharpness 90) pruned, spikes (160) kept
  assert.ok(mid < full, "some branches pruned at 100°");
  assert.ok(mid > 0, "sharp spikes survive");
  // Monotonic.
  assert.ok(count("angle", 170) <= mid);
});

test("pruning never resurrects edges and respects the graph", async () => {
  const { medial, metrics } = await setup(L_SHAPE);
  const alive = prune(medial, metrics, "length", 1.5);
  // Kept edges are a subset of the bounded medial edges.
  alive.forEach((a, i) => {
    if (a) assert.ok(medial.edges[i].from >= 0 && medial.edges[i].to >= 0);
  });
  assert.ok(alive.filter(Boolean).length < medial.edges.length);
});
