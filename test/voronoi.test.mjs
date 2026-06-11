import { test } from "node:test";
import assert from "node:assert/strict";
import { voronoi, medialAxis, tessellate, init } from "../dist/voron8.js";

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
  const { vertices, edges } = await voronoi(SQUARE);
  assert.ok(vertices.length >= 5, "has interior + corner vertices");
  assert.ok(edges.length > 0, "has edges");
});

test("input polygon corners are flagged and mapped back to source", async () => {
  const { vertices } = await voronoi(SQUARE);
  const inputs = vertices.filter((v) => v.isInput);
  assert.equal(inputs.length, 4, "all four corners coincide with Voronoi vertices");

  for (const v of inputs) {
    assert.equal(v.source.polygon, 0);
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
  const { vertices, edges } = await voronoi(SQUARE);
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
  const { edges } = await voronoi(SQUARE);
  const rays = edges.filter((e) => e.geometry.type === "ray");
  assert.ok(rays.length > 0, "a square has exterior rays");
  for (const r of rays) {
    assert.equal(r.location, "exterior");
  }
});

test("edge endpoints index into the vertex array", async () => {
  const { vertices, edges } = await voronoi(SQUARE);
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
  const { edges } = await voronoi([outer, hole]);

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
  const { edges } = await voronoi(SQUARE);
  for (const e of edges) {
    assert.equal(e.sites.length, 2);
    for (const s of e.sites) {
      assert.ok(["point", "segment", "infinite"].includes(s.type));
      if (s.type === "point" && s.source) {
        assert.equal(s.source.polygon, 0);
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

test("medialAxis drops edges defined by a reflex vertex", async () => {
  const full = await voronoi(L_SHAPE);
  const medial = await medialAxis(L_SHAPE);

  const interior = full.edges.filter((e) => e.location === "interior");
  assert.ok(medial.edges.length > 0, "medial axis is non-empty");
  assert.ok(
    medial.edges.length < interior.length,
    "medial axis prunes some interior edges",
  );

  // Every medial edge is interior and free of the reflex vertex (0:3).
  for (const e of medial.edges) {
    assert.equal(e.location, "interior");
    for (const s of e.sites) {
      assert.ok(
        !(s.type === "point" && s.source && s.source.polygon === 0 && s.source.vertex === 3),
        "no medial edge is defined by the reflex vertex",
      );
    }
  }

  // At least one pruned interior edge WAS defined by the reflex vertex.
  const prunedReflex = interior.some((e) =>
    e.sites.some(
      (s) => s.type === "point" && s.source && s.source.polygon === 0 && s.source.vertex === 3,
    ),
  );
  assert.ok(prunedReflex, "the reflex vertex did define interior edges that got pruned");

  // The medial axis has its leaves at convex corners and stops short of the
  // reflex corner (whose interior wedge is the pruned reflex point-cell).
  const touches = (x, y) =>
    medial.edges.some((e) =>
      [e.from, e.to].some((idx) => {
        const v = medial.vertices[idx];
        return v && Math.abs(v.x - x) < 1e-9 && Math.abs(v.y - y) < 1e-9;
      }),
    );
  assert.ok(touches(0, 0), "medial axis reaches a convex corner");
  assert.ok(!touches(2, 2), "medial axis does not reach the reflex corner");
});

test("a convex polygon's medial axis equals its interior edges", async () => {
  // No reflex vertices, so nothing is pruned.
  const full = await voronoi(SQUARE);
  const medial = await medialAxis(SQUARE);
  const interior = full.edges.filter((e) => e.location === "interior");
  assert.equal(medial.edges.length, interior.length);
});

test("tessellate turns geometry into polylines", async () => {
  const { edges } = await voronoi(SQUARE);

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
  const { edges } = await voronoi(L);
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
