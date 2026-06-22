import { test, before } from "node:test";
import assert from "node:assert/strict";
import { voronoi, init } from "../dist/voron8.js";

before(() => init());

// ---------------------------------------------------------------------------
// Independent O(n²) oracle for "do these segments conflict?" — a separate
// implementation from the library's sweep, so agreement is meaningful.
// ---------------------------------------------------------------------------
const cross = (o, p, q) =>
  (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
const same = (p, q) => p[0] === q[0] && p[1] === q[1];
function inside(a, b, p) {
  if (cross(a, b, p) !== 0) return false;
  if (same(p, a) || same(p, b)) return false;
  return (
    Math.min(a[0], b[0]) <= p[0] && p[0] <= Math.max(a[0], b[0]) &&
    Math.min(a[1], b[1]) <= p[1] && p[1] <= Math.max(a[1], b[1])
  );
}
function conflict(s, t) {
  const [sa, sb] = s, [ta, tb] = t;
  const d1 = cross(ta, tb, sa), d2 = cross(ta, tb, sb);
  const d3 = cross(sa, sb, ta), d4 = cross(sa, sb, tb);
  if (((d1 > 0) !== (d2 > 0)) && d1 !== 0 && d2 !== 0 &&
      ((d3 > 0) !== (d4 > 0)) && d3 !== 0 && d4 !== 0) return true;
  return inside(ta, tb, sa) || inside(ta, tb, sb) ||
         inside(sa, sb, ta) || inside(sa, sb, tb);
}
function oracleHasConflict(segs) {
  for (let i = 0; i < segs.length; i++) {
    if (same(segs[i][0], segs[i][1])) continue;
    for (let j = i + 1; j < segs.length; j++) {
      if (same(segs[j][0], segs[j][1])) continue;
      if (conflict(segs[i], segs[j])) return true;
    }
  }
  return false;
}

/** Does voronoi's guard reject this segment set? (true = threw a conflict error) */
function libRejects(segs) {
  try {
    voronoi({ segments: segs }, { assumeNoIntersections: true });
    return false;
  } catch (e) {
    if (/cross or overlap/.test(String(e))) return true;
    throw e; // unrelated failure — surface it
  }
}

// Deterministic RNG so failures are reproducible.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("sweep agrees with the O(n²) oracle on random small-integer segment sets", () => {
  // Small integer coordinates pack in collinear overlaps, shared endpoints,
  // verticals, and T-junctions — the degenerate cases — and keep both the sweep
  // and the oracle in exact arithmetic.
  const rng = mulberry32(0xc0ffee);
  let mismatches = 0;
  const RANGE = 5;
  for (let iter = 0; iter < 1500; iter++) {
    const n = 2 + Math.floor(rng() * 9);
    const segs = [];
    for (let i = 0; i < n; i++) {
      const a = [Math.floor(rng() * RANGE), Math.floor(rng() * RANGE)];
      let b = [Math.floor(rng() * RANGE), Math.floor(rng() * RANGE)];
      while (same(a, b)) b = [Math.floor(rng() * RANGE), Math.floor(rng() * RANGE)];
      segs.push([a, b]);
    }
    const expected = oracleHasConflict(segs);
    const got = libRejects(segs);
    if (expected !== got) {
      mismatches++;
      if (mismatches <= 3) {
        console.error(`mismatch: expected=${expected} got=${got} segs=${JSON.stringify(segs)}`);
      }
    }
  }
  assert.equal(mismatches, 0, `${mismatches} sweep/oracle mismatches`);
});

// ---------------------------------------------------------------------------
// Structured adversarial cases
// ---------------------------------------------------------------------------

test("sweep flags a grid of crossing verticals and horizontals", () => {
  const segs = [];
  const k = 6;
  for (let i = 0; i < k; i++) {
    segs.push([[i, -1], [i, k]]);          // verticals
    segs.push([[-1, i], [k, i]]);          // horizontals
  }
  assert.equal(libRejects(segs), true);
});

test("sweep flags a pencil of segments through a common point", () => {
  const segs = [];
  for (let i = 0; i < 12; i++) {
    const a = (Math.PI * i) / 12;
    segs.push([[-Math.cos(a) * 10, -Math.sin(a) * 10], [Math.cos(a) * 10, Math.sin(a) * 10]]);
  }
  assert.equal(libRejects(segs), true);
});

test("sweep flags a T-junction (endpoint on another segment's interior)", () => {
  assert.equal(libRejects([[[0, 0], [10, 0]], [[5, 0], [5, 5]]]), true);
});

test("sweep flags two overlapping verticals on the same line", () => {
  assert.equal(libRejects([[[2, 0], [2, 5]], [[2, 3], [2, 8]]]), true);
});

test("sweep allows two verticals that only touch at an endpoint", () => {
  assert.equal(libRejects([[[2, 0], [2, 5]], [[2, 5], [2, 8]]]), false);
});

test("sweep allows disjoint verticals", () => {
  assert.equal(libRejects([[[2, 0], [2, 5]], [[7, 0], [7, 5]]]), false);
});

test("sweep allows a fan of many segments sharing one endpoint", () => {
  // All segments emanate from the origin to distinct outer points — they meet
  // only at the shared endpoint, which is legal.
  const segs = [];
  for (let i = 0; i < 30; i++) {
    const a = (2 * Math.PI * i) / 30;
    segs.push([[0, 0], [Math.cos(a) * 10, Math.sin(a) * 10]]);
  }
  assert.equal(libRejects(segs), false);
});

test("sweep allows a large simple polygon ring (consecutive shared endpoints)", () => {
  const ring = [];
  for (let i = 0; i < 64; i++) {
    const a = (2 * Math.PI * i) / 64;
    ring.push([Math.cos(a) * 100, Math.sin(a) * 100]);
  }
  // Passed as a closed polygon, so adjacent edges share endpoints throughout.
  assert.doesNotThrow(() => voronoi({ polygons: [ring] }, { assumeNoIntersections: true }));
});
