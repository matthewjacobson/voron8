import { test, before } from "node:test";
import assert from "node:assert/strict";
import { voronoi, medialAxis, tessellate, componentAdjacency, init } from "../dist/voron8.js";

// voronoi()/medialAxis() are synchronous; load the wasm once up front.
before(() => init());

const SQUARE = [
  [
    [0, 0],
    [4, 0],
    [4, 4],
    [0, 4],
  ],
];

test("init() returns the same cached module", async () => {
  const a = await init();
  const b = await init();
  assert.equal(a, b);
  assert.equal(typeof a.computeVoronoi, "function");
});

test("square produces a Voronoi graph", async () => {
  const { vertices, edges } = voronoi(SQUARE);
  assert.ok(vertices.length >= 5, "has interior + corner vertices");
  assert.ok(edges.length > 0, "has edges");
});

test("input polygon corners are flagged and mapped back to source", async () => {
  const { vertices } = voronoi(SQUARE);
  const inputs = vertices.filter((v) => v.isInput);
  assert.equal(inputs.length, 4, "all four corners coincide with Voronoi vertices");

  for (const v of inputs) {
    assert.equal(v.source.input, 0);
    assert.ok(v.source.vertex >= 0 && v.source.vertex < 4);
  }
  // Provenance covers each of the four corners exactly once.
  const seen = new Set(inputs.map((v) => v.source.vertex));
  assert.equal(seen.size, 4);

  // Non-input vertices carry a null source.
  for (const v of vertices.filter((v) => !v.isInput)) {
    assert.equal(v.source, null);
  }
});

test("the medial axis (interior) of a square meets at its center", async () => {
  const { vertices, edges } = voronoi(SQUARE);
  const interior = edges.filter((e) => e.location === "interior");
  assert.ok(interior.length >= 4, "square has interior medial edges");

  // Every interior edge must be bounded (no rays escape the region).
  for (const e of interior) {
    assert.notEqual(e.geometry.type, "ray");
    assert.notEqual(e.geometry.type, "line");
  }

  // The center (2,2) is a Voronoi vertex shared by the interior edges.
  const center = vertices.find(
    (v) => Math.abs(v.x - 2) < 1e-9 && Math.abs(v.y - 2) < 1e-9,
  );
  assert.ok(center, "center vertex exists");
  assert.equal(center.isInput, false);
});

test("unbounded bisectors are labeled exterior", async () => {
  const { edges } = voronoi(SQUARE);
  const rays = edges.filter((e) => e.geometry.type === "ray");
  assert.ok(rays.length > 0, "a square has exterior rays");
  for (const r of rays) {
    assert.equal(r.location, "exterior");
  }
});

test("edge endpoints index into the vertex array", async () => {
  const { vertices, edges } = voronoi(SQUARE);
  for (const e of edges) {
    for (const idx of [e.from, e.to]) {
      assert.ok(idx === -1 || (idx >= 0 && idx < vertices.length));
    }
  }
});

test("a hole flips interior/exterior (even-odd fill)", async () => {
  // A big square with a smaller square hole inside it.
  const outer = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ];
  const hole = [
    [4, 4],
    [6, 4],
    [6, 6],
    [4, 6],
  ];
  const { edges } = voronoi([outer, hole]);

  // The center of the hole is outside the filled region — any bisector sampled
  // there must be exterior. Confirm at least one edge sits near the hole center
  // and is exterior.
  const nearHoleCenter = edges.filter((e) => {
    const g = e.geometry;
    if (g.type !== "segment" && g.type !== "parabola") return false;
    const mx = (g.source.x + g.target.x) / 2;
    const my = (g.source.y + g.target.y) / 2;
    return mx > 4.2 && mx < 5.8 && my > 4.2 && my < 5.8;
  });
  assert.ok(nearHoleCenter.length > 0, "found edges inside the hole");
  for (const e of nearHoleCenter) {
    assert.equal(e.location, "exterior", "edges inside a hole are exterior");
  }
});

test("every edge reports its two defining sites", async () => {
  const { edges } = voronoi(SQUARE);
  for (const e of edges) {
    assert.equal(e.sites.length, 2);
    for (const s of e.sites) {
      assert.ok(["point", "segment", "infinite"].includes(s.type));
      if (s.type === "point" && s.source) {
        assert.equal(s.source.input, 0);
        assert.ok(s.source.vertex >= 0 && s.source.vertex < 4);
      } else {
        assert.equal(s.source, null);
      }
    }
  }
});

// An L-shape: one reflex (concave) vertex at index 3, (2,2).
const L_SHAPE = [
  [
    [0, 0],
    [6, 0],
    [6, 2],
    [2, 2], // reflex
    [2, 6],
    [0, 6],
  ],
];

// Whether an edge bisects a point site and a segment site incident to it
// (a polygon vertex and one of its own edges) — the degenerate, non-medial case.
function isIncidentBisector(e) {
  const same = (a, b) => a && b && a.input === b.input && a.vertex === b.vertex;
  const inc = (pt, seg) =>
    pt.type === "point" &&
    seg.type === "segment" &&
    seg.segment &&
    (same(pt.source, seg.segment[0]) || same(pt.source, seg.segment[1]));
  return inc(e.sites[0], e.sites[1]) || inc(e.sites[1], e.sites[0]);
}

test("medialAxis drops only the degenerate incident bisectors", async () => {
  const full = voronoi(L_SHAPE);
  const medial = medialAxis(L_SHAPE);

  const interior = full.edges.filter((e) => e.location === "interior");
  assert.ok(medial.edges.length > 0, "medial axis is non-empty");
  assert.ok(
    medial.edges.length < interior.length,
    "medial axis prunes some interior edges",
  );

  // Nothing kept is an incident bisector...
  for (const e of medial.edges) {
    assert.equal(e.location, "interior");
    assert.ok(!isIncidentBisector(e), "no medial edge is an incident bisector");
  }
  // ...and everything pruned is exactly an incident bisector.
  const medialKey = new Set(medial.edges.map((e) => `${e.from},${e.to}`));
  for (const e of interior) {
    if (!medialKey.has(`${e.from},${e.to}`)) {
      assert.ok(isIncidentBisector(e), "every pruned interior edge is an incident bisector");
    }
  }
});

test("parabolic arcs are always part of the medial axis", async () => {
  // The arc bisectors (reflex vertex vs. a facing wall) are genuine medial axis
  // edges — a regression guard against over-pruning them.
  const full = voronoi(L_SHAPE);
  const medial = medialAxis(L_SHAPE);
  const interiorParabolas = full.edges.filter(
    (e) => e.location === "interior" && e.geometry.type === "parabola",
  ).length;
  const medialParabolas = medial.edges.filter(
    (e) => e.geometry.type === "parabola",
  ).length;
  assert.ok(interiorParabolas > 0, "the L-shape has interior parabolic bisectors");
  assert.equal(medialParabolas, interiorParabolas, "no parabolic arc is pruned");
});

test("a convex polygon's medial axis equals its interior edges", async () => {
  // No reflex vertices, so there are no interior incident bisectors to prune.
  const full = voronoi(SQUARE);
  const medial = medialAxis(SQUARE);
  const interior = full.edges.filter((e) => e.location === "interior");
  assert.equal(medial.edges.length, interior.length);
});

test("tessellate turns geometry into polylines", async () => {
  const { edges } = voronoi(SQUARE);

  const seg = edges.find((e) => e.geometry.type === "segment");
  const segLine = tessellate(seg.geometry);
  assert.equal(segLine.length, 2);

  const ray = edges.find((e) => e.geometry.type === "ray");
  const rayLine = tessellate(ray.geometry, { infiniteLength: 100 });
  assert.equal(rayLine.length, 2);
  // Endpoint is ~100 units from the source.
  const d = Math.hypot(
    rayLine[1].x - rayLine[0].x,
    rayLine[1].y - rayLine[0].y,
  );
  assert.ok(Math.abs(d - 100) < 1e-6);
});

test("parabolic arcs appear for non-convex input and sample on-curve", async () => {
  // An L-shaped polygon has a reflex corner, producing parabolic bisectors.
  const L = [
    [
      [0, 0],
      [6, 0],
      [6, 2],
      [2, 2],
      [2, 6],
      [0, 6],
    ],
  ];
  const { edges } = voronoi(L);
  const parabolas = edges.filter((e) => e.geometry.type === "parabola");
  assert.ok(parabolas.length > 0, "L-shape produces parabolic bisectors");

  const g = parabolas[0].geometry;
  const pts = tessellate(g, { parabolaSamples: 24 });
  assert.equal(pts.length, 24);

  // Every sampled point is equidistant from the focus and the directrix line.
  const nlen = Math.hypot(g.directrix.a, g.directrix.b);
  for (const p of pts) {
    const dFocus = Math.hypot(p.x - g.focus.x, p.y - g.focus.y);
    const dLine = Math.abs(
      (g.directrix.a * p.x + g.directrix.b * p.y + g.directrix.c) / nlen,
    );
    assert.ok(
      Math.abs(dFocus - dLine) < 1e-6,
      `on-curve: |focus|=${dFocus} vs |directrix|=${dLine}`,
    );
  }
  // Endpoints match the reported arc endpoints.
  assert.ok(Math.hypot(pts[0].x - g.source.x, pts[0].y - g.source.y) < 1e-9);
  assert.ok(
    Math.hypot(pts[23].x - g.target.x, pts[23].y - g.target.y) < 1e-9,
  );
});

// --- Generalized input: points, segments, and mixed sites. ---

test("two isolated points bisect along their perpendicular", async () => {
  const { edges } = voronoi({ points: [[0, 0], [4, 0]] });
  assert.ok(edges.length > 0, "two points produce a bisector");

  // The bisector is the infinite line x = 2; with no polygons it is exterior.
  const bisector = edges.find(
    (e) => e.geometry.type === "line" || e.geometry.type === "ray",
  );
  assert.ok(bisector, "the bisector of two points is unbounded");
  assert.equal(bisector.location, "exterior");

  // Both defining sites are the input points, traced back by input index.
  for (const s of bisector.sites) {
    assert.equal(s.type, "point");
    assert.ok(s.source, "a point site carries its source");
  }
  const inputs = bisector.sites.map((s) => s.source.input).sort();
  assert.deepEqual(inputs, [0, 1], "the two points are inputs 0 and 1");
});

test("an open segment is a site without enclosing any interior", async () => {
  const { edges } = voronoi({ segments: [[[0, 0], [4, 0]]] });
  assert.ok(edges.length > 0, "a segment produces bisectors");

  // A lone open segment encloses no region, so nothing is interior.
  for (const e of edges) assert.equal(e.location, "exterior");

  // The segment itself appears as a site, alongside its two endpoint points.
  const kinds = new Set(edges.flatMap((e) => e.sites).map((s) => s.type));
  assert.ok(kinds.has("segment"), "the open segment is a segment site");
  assert.ok(kinds.has("point"), "its endpoints are point sites");
});

test("mixed input flattens as points, then segments, then polygons", async () => {
  // One stray point (input 0) plus the square (input 1) — the point comes first
  // in the flattened ordering, so the square's corners are now input 1.
  const { edges } = voronoi({ points: [[5, 5]], polygons: SQUARE });

  const pointSites = edges
    .flatMap((e) => e.sites)
    .filter((s) => s.type === "point" && s.source);
  assert.ok(
    pointSites.some((s) => s.source.input === 0),
    "the lone point is input 0",
  );
  assert.ok(
    pointSites.some((s) => s.source.input === 1),
    "the square's corners are input 1",
  );
});

test("crossing segments insert a non-input intersection site", async () => {
  // The two diagonals of a square cross at (2,2). With CGAL's intersecting
  // traits, that crossing is inserted as a new site — but it is not an input
  // vertex, so its provenance is null.
  const { edges } = voronoi({
    segments: [
      [[0, 0], [4, 4]],
      [[0, 4], [4, 0]],
    ],
  });
  assert.ok(edges.length > 0, "crossing segments still produce a diagram");

  const sites = edges.flatMap((e) => e.sites);
  const hasNullProvenance =
    sites.some((s) => s.type === "point" && s.source === null) ||
    sites.some(
      (s) =>
        s.type === "segment" &&
        s.segment &&
        (s.segment[0] === null || s.segment[1] === null),
    );
  assert.ok(
    hasNullProvenance,
    "the crossing introduces a site with no input provenance",
  );
});

test("the bare-array form is shorthand for { polygons }", async () => {
  const fromArray = voronoi(SQUARE);
  const fromObject = voronoi({ polygons: SQUARE });
  assert.equal(fromArray.edges.length, fromObject.edges.length);

  // Bare-array input indices equal the ring indices (the only sites present).
  const corners = fromArray.vertices.filter((v) => v.isInput);
  assert.equal(corners.length, 4);
  for (const v of corners) assert.equal(v.source.input, 0);
});

test("assumeNoIntersections matches the default on intersection-free input", async () => {
  // A simple polygon, a hole, plus a disjoint open segment — no crossings.
  const input = {
    polygons: [
      [[0, 0], [10, 0], [10, 10], [0, 10]],
      [[3, 3], [7, 3], [7, 7], [3, 7]],
    ],
    segments: [[[20, 0], [20, 10]]],
  };
  const slow = voronoi(input);
  const fast = voronoi(input, { assumeNoIntersections: true });

  assert.equal(fast.vertices.length, slow.vertices.length);
  assert.equal(fast.edges.length, slow.edges.length);
  assert.equal(fast.faces.length, slow.faces.length);

  // Same edge geometry, compared order-independently.
  const key = (r) =>
    r.edges
      .map((e) => `${e.geometry.type}:${e.location}`)
      .sort()
      .join("|");
  assert.equal(key(fast), key(slow));
});

test("assumeNoIntersections throws on crossing segments instead of corrupting", async () => {
  assert.throws(
    () =>
      voronoi(
        { segments: [[[0, 0], [10, 0]], [[5, -5], [5, 5]]] },
        { assumeNoIntersections: true },
      ),
    /cross or overlap/,
  );
});

test("assumeNoIntersections throws on a collinear overlap", async () => {
  assert.throws(
    () =>
      voronoi(
        { segments: [[[0, 0], [10, 0]], [[5, 0], [15, 0]]] },
        { assumeNoIntersections: true },
      ),
    /cross or overlap/,
  );
});

test("assumeNoIntersections allows segments that share only an endpoint", async () => {
  // A chevron: two segments meeting at (5,5). Shared endpoints are legal.
  assert.doesNotThrow(() =>
    voronoi(
      { segments: [[[0, 0], [5, 5]], [[5, 5], [10, 0]]] },
      { assumeNoIntersections: true },
    ),
  );
});

test("componentAdjacency: two separate segments are one adjacent pair", async () => {
  // Two parallel segments, each its own connected component.
  const { componentCount, vertexComponent, adjacency, pairs } = componentAdjacency({
    vertices: [[0, 0], [4, 0], [0, 5], [4, 5]],
    edges: [[0, 1], [2, 3]],
  });
  assert.equal(componentCount, 2);
  assert.deepEqual(vertexComponent, [0, 0, 1, 1]);
  assert.deepEqual(adjacency, [[1], [0]]);
  assert.deepEqual(pairs, [[0, 1]]);
});

test("componentAdjacency: a single connected graph has no adjacencies", async () => {
  // A triangle is one component; every Voronoi edge is intra-component.
  const { componentCount, vertexComponent, adjacency, pairs } = componentAdjacency({
    vertices: [[0, 0], [4, 0], [2, 3]],
    edges: [[0, 1], [1, 2], [2, 0]],
  });
  assert.equal(componentCount, 1);
  assert.deepEqual(vertexComponent, [0, 0, 0]);
  assert.deepEqual(adjacency, [[]]);
  assert.deepEqual(pairs, []);
});

test("componentAdjacency: a path of two edges sharing a vertex is one component", async () => {
  // Shared endpoints are legal (no T-junction); the two edges are connected.
  const { componentCount, pairs } = componentAdjacency({
    vertices: [[0, 0], [1, 0], [2, 0]],
    edges: [[0, 1], [1, 2]],
  });
  assert.equal(componentCount, 1);
  assert.deepEqual(pairs, []);
});

test("componentAdjacency: isolated points are singleton components", async () => {
  // Three collinear points: the middle cell separates the two ends, so the ends
  // are not adjacent to each other.
  const { componentCount, vertexComponent, pairs } = componentAdjacency({
    vertices: [[0, 0], [10, 0], [20, 0]],
    edges: [],
  });
  assert.equal(componentCount, 3);
  assert.deepEqual(vertexComponent, [0, 1, 2]);
  assert.deepEqual(pairs, [[0, 1], [1, 2]]);
});

test("componentAdjacency: mixed isolated point and segments adjoin", async () => {
  // A point between two segments — point is its own component (#0, points first).
  const { componentCount, vertexComponent } = componentAdjacency({
    vertices: [[5, 5], [0, 0], [0, 10], [10, 0], [10, 10]],
    edges: [[1, 2], [3, 4]],
  });
  assert.equal(componentCount, 3);
  // Vertex 0 (isolated) is its own component; the two segments are the others.
  assert.equal(vertexComponent[0], vertexComponent[0]);
  assert.equal(vertexComponent[1], vertexComponent[2]);
  assert.equal(vertexComponent[3], vertexComponent[4]);
  assert.notEqual(vertexComponent[1], vertexComponent[3]);
});

test("componentAdjacency: crossing edges throw (not a valid PSLG)", async () => {
  assert.throws(
    () =>
      componentAdjacency({
        vertices: [[0, 0], [4, 4], [0, 4], [4, 0]],
        edges: [[0, 1], [2, 3]], // an X — cross at (2,2)
      }),
    /planar straight line graph|cross|noded/i,
  );
});

test("componentAdjacency: duplicate and self-loop edges are tolerated", async () => {
  const { componentCount, pairs } = componentAdjacency({
    vertices: [[0, 0], [1, 0]],
    edges: [[0, 1], [1, 0], [0, 0]], // duplicate (reversed) + a self-loop
  });
  assert.equal(componentCount, 1);
  assert.deepEqual(pairs, []);
});

test("componentAdjacency: out-of-range edge index throws", async () => {
  assert.throws(
    () => componentAdjacency({ vertices: [[0, 0], [1, 0]], edges: [[0, 5]] }),
    /out-of-range/,
  );
});
