import { test, before } from "node:test";
import assert from "node:assert/strict";
import { init, voronoi, tessellate, MedialAxisPathFinder } from "../dist/voron8.js";
import { MATISSE_NUIT } from "./fixtures-matisse-nuit.mjs";

before(() => init());

const OUTER = [
  [0, 0],
  [100, 0],
  [100, 100],
  [0, 100],
];
const HOLE = [
  [40, 40],
  [60, 40],
  [60, 60],
  [40, 60],
];

// --- geometry helpers for invariants ---------------------------------------

function insideBox(p, x0, y0, x1, y1) {
  return p.x > x0 && p.x < x1 && p.y > y0 && p.y < y1;
}

function ccw(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

// Proper crossing of open segments p1p2 and p3p4 (shared endpoints don't count).
function segmentsCross(p1, p2, p3, p4) {
  const d1 = ccw(p3, p4, p1);
  const d2 = ccw(p3, p4, p2);
  const d3 = ccw(p1, p2, p3);
  const d4 = ccw(p1, p2, p4);
  return (d1 > 0) !== (d2 > 0) && (d3 > 0) !== (d4 > 0);
}

function pathCrossesSegment(path, a, b) {
  for (let i = 0; i + 1 < path.length; i++) {
    if (segmentsCross(path[i], path[i + 1], a, b)) return true;
  }
  return false;
}

function xy(p) {
  return { x: p[0], y: p[1] };
}

// ---------------------------------------------------------------------------

test("finds a path across a simple square", () => {
  const f = new MedialAxisPathFinder([OUTER]);
  try {
    const r = f.findPath([5, 50], [95, 50]);
    assert.equal(r.found, true);
    assert.ok(r.path.length >= 2);
    // Endpoints are exactly the requested start and end.
    assert.deepEqual(r.path[0], { x: 5, y: 50 });
    assert.deepEqual(r.path[r.path.length - 1], { x: 95, y: 50 });
    // Length is at least the straight-line distance.
    assert.ok(r.length >= Math.hypot(90, 0) - 1e-6);
  } finally {
    f.dispose();
  }
});

test("routes around a hole without entering it", () => {
  const f = new MedialAxisPathFinder([OUTER, HOLE]);
  try {
    const r = f.findPath([5, 50], [95, 50]);
    assert.equal(r.found, true);
    assert.ok(!r.path.some((p) => insideBox(p, 40, 40, 60, 60)), "path entered the hole");
    // A detour is longer than the blocked straight line (length 90).
    assert.ok(r.length > 90);
  } finally {
    f.dispose();
  }
});

test("a wall fully partitioning the region makes the far side unreachable", () => {
  const f = new MedialAxisPathFinder([OUTER]);
  try {
    f.addWall([50, 0], [50, 100]);
    const r = f.findPath([5, 50], [95, 50]);
    assert.equal(r.found, false);
    assert.equal(r.path.length, 0);
    assert.equal(r.length, 0);
  } finally {
    f.dispose();
  }
});

test("a partial wall is routed around, never crossed", () => {
  const f = new MedialAxisPathFinder([OUTER]);
  try {
    const wallA = xy([50, 0]);
    const wallB = xy([50, 60]); // leaves a gap for y in (60, 100)
    f.addWall([50, 0], [50, 60]);
    const r = f.findPath([5, 50], [95, 50]);
    assert.equal(r.found, true);
    assert.ok(!pathCrossesSegment(r.path, wallA, wallB), "path crossed the wall");
    // The only way across is over the wall's top endpoint.
    assert.ok(
      r.path.some((p) => Math.abs(p.x - 50) < 10 && p.y > 58),
      "path did not route over the wall's open end",
    );
  } finally {
    f.dispose();
  }
});

test("adding a wall incrementally changes the route", () => {
  const f = new MedialAxisPathFinder([OUTER]);
  try {
    const before = f.findPath([5, 50], [95, 50]);
    assert.equal(before.found, true);

    f.addWall([50, 0], [50, 60]);
    const after = f.findPath([5, 50], [95, 50]);
    assert.equal(after.found, true);
    // Detouring around the wall is strictly longer than the unobstructed route.
    assert.ok(after.length > before.length + 1e-6);
  } finally {
    f.dispose();
  }
});

test("repeated queries between insertions are deterministic (cache reuse)", () => {
  const f = new MedialAxisPathFinder([OUTER, HOLE]);
  try {
    const a = f.findPath([5, 50], [95, 50]);
    const b = f.findPath([5, 50], [95, 50]);
    assert.deepEqual(a, b);
  } finally {
    f.dispose();
  }
});

test("multiple walls can be added and are all respected", () => {
  const f = new MedialAxisPathFinder([OUTER]);
  try {
    // Two staggered walls forming a chicane that still leaves a corridor.
    f.addWall([33, 0], [33, 70]);
    f.addWall([66, 30], [66, 100]);
    const w1 = [xy([33, 0]), xy([33, 70])];
    const w2 = [xy([66, 30]), xy([66, 100])];
    const r = f.findPath([5, 50], [95, 50]);
    assert.equal(r.found, true);
    assert.ok(!pathCrossesSegment(r.path, w1[0], w1[1]), "crossed wall 1");
    assert.ok(!pathCrossesSegment(r.path, w2[0], w2[1]), "crossed wall 2");
  } finally {
    f.dispose();
  }
});

test("a short hop within one cell stays local", () => {
  // Two nearby points in an open square should not detour to the far skeleton.
  const f = new MedialAxisPathFinder([OUTER]);
  try {
    const r = f.findPath([48, 50], [52, 50]);
    assert.equal(r.found, true);
    assert.ok(r.length < 20, `expected a short local hop, got ${r.length}`);
  } finally {
    f.dispose();
  }
});

test("attachment prefers the interior spine over a boundary stub", () => {
  // A long thin rectangle: the medial axis is a central horizontal spine
  // (y = 10, both endpoints interior) plus diagonal spokes to the four corners.
  // A point near the bottom-left corner is geometrically closest to a spoke, but
  // attachment should skip that boundary-touching edge and jump to the spine.
  const RECT = [[0, 0], [100, 0], [100, 20], [0, 20]];
  const f = new MedialAxisPathFinder([RECT]);
  try {
    const r = f.findPath([5, 3], [95, 3]);
    assert.equal(r.found, true);
    // path[0] is the start; path[1] is where it meets the axis. The spine sits at
    // y = 10; a spoke attachment would land near y = 5.
    assert.ok(r.path[1].y >= 8, `start attached to a boundary stub at ${JSON.stringify(r.path[1])}`);
    assert.ok(
      r.path[r.path.length - 2].y >= 8,
      `end attached to a boundary stub at ${JSON.stringify(r.path[r.path.length - 2])}`,
    );
  } finally {
    f.dispose();
  }
});

test("a convex region attaches to its interior branch vertex", () => {
  // A square's whole medial axis is corner-to-centre spokes — every edge touches
  // the boundary — but the centre (25,25) is an interior branch vertex. Rather
  // than hugging a boundary spoke, attachment jumps straight to that vertex.
  const SQUARE = [[0, 0], [50, 0], [50, 50], [0, 50]];
  const f = new MedialAxisPathFinder([SQUARE]);
  try {
    const r = f.findPath([12, 10], [38, 40]);
    assert.equal(r.found, true);
    // Both endpoints attach to the interior centre, so path is start->centre->end.
    const near = (p, x, y) => Math.hypot(p.x - x, p.y - y) < 1e-6;
    assert.ok(near(r.path[1], 25, 25), `start attached at ${JSON.stringify(r.path[1])}, not the centre`);
    assert.ok(
      near(r.path[r.path.length - 2], 25, 25),
      `end attached at ${JSON.stringify(r.path[r.path.length - 2])}, not the centre`,
    );
  } finally {
    f.dispose();
  }
});

test("a start point lying on a medial edge attaches at that point", () => {
  // The spine of a thin rectangle is the A|B boundary between the top and bottom
  // edge cells. A start exactly on it is already on the axis — no matter which
  // cell nearest_neighbor picks, the shared spine edge is found at distance ~0.
  const RECT = [[0, 0], [100, 0], [100, 20], [0, 20]];
  const f = new MedialAxisPathFinder([RECT]);
  try {
    const r = f.findPath([50, 10], [90, 10]);
    assert.equal(r.found, true);
    assert.deepEqual(r.path[0], { x: 50, y: 10 });
    // Straight along the spine — no detour off and back onto the axis.
    assert.ok(Math.abs(r.length - 40) < 1e-6, `expected ~40 along the spine, got ${r.length}`);
    assert.ok(r.path.every((p) => Math.abs(p.y - 10) < 1e-6), "path left the spine");
  } finally {
    f.dispose();
  }
});

test("a start point lying on a Voronoi vertex attaches at the vertex", () => {
  const SQUARE = [[0, 0], [50, 0], [50, 50], [0, 50]];
  const f = new MedialAxisPathFinder([SQUARE]);
  try {
    const r = f.findPath([25, 25], [10, 10]); // start exactly on the centre vertex
    assert.equal(r.found, true);
    assert.deepEqual(r.path[0], { x: 25, y: 25 });
  } finally {
    f.dispose();
  }
});

test("attachment is continuous as a point crosses a cell boundary", () => {
  // Sweeping the start across the spine must not make the path length jump: the
  // shared boundary feature is chosen symmetrically from either side.
  const RECT = [[0, 0], [100, 0], [100, 20], [0, 20]];
  const f = new MedialAxisPathFinder([RECT]);
  try {
    const len = (y) => f.findPath([50, y], [90, 10]).length;
    const below = len(9.9), on = len(10), above = len(10.1);
    assert.ok(Math.abs(below - above) < 1e-6, "asymmetric across the boundary");
    assert.ok(on <= below + 1e-9 && on <= above + 1e-9, "not minimal on the axis");
    assert.ok(below - on < 0.2, `discontinuous jump across the boundary (${below} vs ${on})`);
  } finally {
    f.dispose();
  }
});

test("a point near a wall attaches to its own side, not across the wall", () => {
  // A full-width wall splits the square into left (x<50) and right (x>50). Two
  // points close together on the same side must connect: the near one must not
  // attach to a jump feature across the wall (which would land it in the far
  // component and report a spurious "no path"). The wall's Voronoi cell
  // straddles both sides, so attachment must reject the cross-wall connector.
  const SQ = [[0, 0], [100, 0], [100, 100], [0, 100]];
  const wallA = { x: 50, y: 0 }, wallB = { x: 50, y: 100 };
  const f = new MedialAxisPathFinder([SQ]);
  try {
    f.addWall([wallA.x, wallA.y], [wallB.x, wallB.y]);
    // Start hugging the wall on the left; end deeper left. Both on the left.
    const r = f.findPath([48, 50], [15, 50]);
    assert.equal(r.found, true, "same-side points near a wall should connect");
    // The connector start->attach must not cross the wall.
    assert.ok(
      !segmentsCross(r.path[0], r.path[1], wallA, wallB),
      `start attached across the wall: ${JSON.stringify(r.path.slice(0, 2))}`,
    );
    // The whole route stays on the left of the wall.
    assert.ok(r.path.every((p) => p.x <= 50 + 1e-6), "route crossed to the far side");
  } finally {
    f.dispose();
  }
});

test("matisse-nuit: a point near a wall does not mis-attach across it", () => {
  // Regression for the "no path even though it isn't blocked" bug. With this
  // wall, the start's containing cell is the wall's cell (which straddles both
  // sides); before the connector-crossing filter, the start attached to the
  // closest interior feature — which lay across the wall, in a different medial
  // component — so Dijkstra reported no path. Both points are on the same side
  // and only ~21 apart, so a route plainly exists.
  const f = new MedialAxisPathFinder(MATISSE_NUIT);
  try {
    f.addWall([407, 13], [299, 689]);
    const r = f.findPath({ x: 346.09, y: 349.9 }, { x: 335.03, y: 348.13 });
    assert.equal(r.found, true, "near-wall point mis-attached across the wall → spurious no-path");
    assert.ok(r.length < 60, `expected a short local route, got ${r.length}`);
  } finally {
    f.dispose();
  }
});

test("a wall's endpoints are boundary corners, so attachment skips their stubs", () => {
  // A thin rectangle's spine sits at y = 10. A wall poking up from the bottom
  // boundary at (50,0) to an interior tip (50,7) creates a clearance-0 junction
  // at (50,0) whose incident bisectors are short boundary stubs — exactly the
  // polygon-corner stub problem, but for a wall. A start hugging that junction
  // must not attach to the near-boundary stub; it should jump to the interior
  // branch vertex on the way to the spine.
  const RECT = [[0, 0], [100, 0], [100, 20], [0, 20]];
  const f = new MedialAxisPathFinder([RECT]);
  try {
    f.addWall([50, 0], [50, 7]);
    const r = f.findPath([56, 2], [90, 10]);
    assert.equal(r.found, true);
    // The wall/boundary stub sits near y = 2–4; the interior branch vertex is at
    // clearance ~7. Attachment must land on the interior feature, not the stub.
    assert.ok(
      r.path[1].y >= 6,
      `start attached to a wall boundary stub at ${JSON.stringify(r.path[1])}`,
    );
  } finally {
    f.dispose();
  }
});

// --- endpoint attachment at junctions (reflex corners, wall junctions) -------
//
// An L-shape with its reflex vertex at (50,50). It is mirror-symmetric across
// the diagonal y = x, so queries mirrored across that diagonal must have equal
// lengths — an asymmetry means attachment broke a tie against the destination.
const LSHAPE = [
  [0, 0],
  [100, 0],
  [100, 50],
  [50, 50],
  [50, 100],
  [0, 100],
];

test("a start exactly on a boundary reflex vertex routes optimally into either arm", () => {
  // (50,50) is equidistant from three sites — the corner point site and both
  // incident boundary segments — and the medial features flanking the corner
  // tie for nearest. A single destination-blind connector detoured every path
  // headed the other way (~92 instead of ~35 here).
  const f = new MedialAxisPathFinder([LSHAPE]);
  try {
    const left = f.findPath([50, 50], [25, 75]);
    const bottom = f.findPath([50, 50], [75, 25]);
    assert.equal(left.found, true);
    assert.equal(bottom.found, true);
    assert.ok(
      Math.abs(left.length - bottom.length) < 1e-6,
      `asymmetric routes from the reflex vertex: ${left.length} vs ${bottom.length}`,
    );
    assert.ok(bottom.length < 60, `detoured through the far arm: ${bottom.length}`);
  } finally {
    f.dispose();
  }
});

test("attachment near a reflex vertex is destination-aware", () => {
  // Strictly interior, but equidistant from the medial features on both sides
  // of the reflex vertex — the tie must not be broken against the destination.
  const f = new MedialAxisPathFinder([LSHAPE]);
  try {
    const left = f.findPath([49.99, 49.99], [25, 75]);
    const bottom = f.findPath([49.99, 49.99], [75, 25]);
    assert.equal(left.found, true);
    assert.equal(bottom.found, true);
    assert.ok(
      Math.abs(left.length - bottom.length) < 1e-6,
      `tie broken against the destination: ${left.length} vs ${bottom.length}`,
    );
    assert.ok(bottom.length < 60, `detoured through the far arm: ${bottom.length}`);
  } finally {
    f.dispose();
  }
});

test("a start on a wall endpoint at a reflex corner reaches both sides", () => {
  // The wall runs from the reflex vertex to the outer boundary, sealing the
  // bottom arm off from the left arm (the coverage-decomposition "portal"
  // pattern). The start sits exactly on the junction — in the closure of both
  // components — so it must attach on both sides: each destination is
  // reachable, and neither route crosses the wall.
  const wallA = xy([50, 50]);
  const wallB = xy([50, 0]);
  const f = new MedialAxisPathFinder([LSHAPE]);
  try {
    f.addWall([50, 50], [50, 0]);
    const left = f.findPath([50, 50], [25, 75]);
    const bottom = f.findPath([50, 50], [75, 25]);
    assert.equal(left.found, true, "left arm unreachable from the junction");
    assert.equal(bottom.found, true, "bottom arm unreachable from the junction");
    assert.ok(!pathCrossesSegment(left.path, wallA, wallB), "left route crossed the wall");
    assert.ok(!pathCrossesSegment(bottom.path, wallA, wallB), "bottom route crossed the wall");
  } finally {
    f.dispose();
  }
});

test("a start on a wall–boundary T-junction reaches both sides", () => {
  // The wall drops from (70,50) — the *interior* of a boundary edge, so its
  // insertion creates a T-junction point site there — to the opposite
  // boundary, splitting the bottom arm in two. A start exactly on the junction
  // previously attached to an arbitrary side and reported "no path" toward
  // the other.
  const wallA = xy([70, 50]);
  const wallB = xy([70, 0]);
  const f = new MedialAxisPathFinder([LSHAPE]);
  try {
    f.addWall([70, 50], [70, 0]);
    const left = f.findPath([70, 50], [25, 25]);
    const right = f.findPath([70, 50], [85, 25]);
    assert.equal(left.found, true, "left side unreachable from the T-junction");
    assert.equal(right.found, true, "right side unreachable from the T-junction");
    assert.ok(!pathCrossesSegment(left.path, wallA, wallB), "left route crossed the wall");
    assert.ok(!pathCrossesSegment(right.path, wallA, wallB), "right route crossed the wall");
  } finally {
    f.dispose();
  }
});

test("matisse-nuit routes between its default (extreme-axis) endpoints", () => {
  // Regression: an interior segment medial edge whose endpoint sat on the polygon
  // boundary was dropped by the interior test (which sampled an endpoint, not the
  // midpoint), disconnecting the axis — so the demo's default endpoints reported
  // "no path" with zero walls. Reproduce the demo's endpoint choice exactly.
  const sameVertex = (a, b) => a && b && a.input === b.input && a.vertex === b.vertex;
  const isIncident = (e) => {
    const inc = (pt, seg) =>
      pt.type === "point" && seg.type === "segment" && seg.segment &&
      (sameVertex(pt.source, seg.segment[0]) || sameVertex(pt.source, seg.segment[1]));
    const [a, b] = e.sites;
    return inc(a, b) || inc(b, a);
  };
  const axisPts = voronoi({ polygons: MATISSE_NUIT }).edges
    .filter((e) => e.location === "interior" && !isIncident(e))
    .flatMap((e) => tessellate(e.geometry, { parabolaSamples: 20 }));
  let lo = axisPts[0], hi = axisPts[0];
  for (const p of axisPts) { if (p.x < lo.x) lo = p; if (p.x > hi.x) hi = p; }

  const f = new MedialAxisPathFinder(MATISSE_NUIT);
  try {
    const r = f.findPath(lo, hi);
    assert.equal(r.found, true, "matisse-nuit default endpoints should route with no walls");
    assert.ok(r.length > 0 && r.path.length >= 2);
  } finally {
    f.dispose();
  }
});

test("dispose() frees the finder and blocks further use", () => {
  const f = new MedialAxisPathFinder([OUTER]);
  f.dispose();
  assert.throws(() => f.findPath([5, 5], [95, 95]), /disposed/);
  assert.doesNotThrow(() => f.dispose()); // idempotent
});
