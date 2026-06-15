import { test, before } from "node:test";
import assert from "node:assert/strict";
import { voronoi, medialAxis, tessellate, init } from "../dist/voron8.js";

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

// Whether an edge bisects a point site and a segment site incident to it
// (a polygon vertex and one of its own edges) — the degenerate, non-medial case.
function isIncidentBisector(e) {
  const same = (a, b) => a && b && a.polygon === b.polygon && a.vertex === b.vertex;
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
