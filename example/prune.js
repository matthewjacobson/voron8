// Feature pruning for a voron8 medial axis.
//
// The medial axis is a graph; insignificant features show up as short leaf
// branches (a path from a degree-1 leaf to the next junction). We iteratively
// collapse leaf branches whose significance is below a threshold, under one of
// three measures:
//
//   "length" — total branch length            (remove features shorter than t)
//   "area"   — ribbon area ≈ Σ length × radius (remove features smaller than t)
//   "angle"  — corner sharpness at the leaf,   (remove branches off nearly-flat
//              i.e. 180° − interior angle        corners, keep sharp features)
//
// Pure, DOM-free, and unit-tested in test/prune.test.mjs.

function xy(p) {
  return Array.isArray(p) ? [p[0], p[1]] : [p.x, p.y];
}

// Distance from point (px,py) to segment (ax,ay)-(bx,by).
function pointSegDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function boundarySegments(polygons) {
  const segs = [];
  for (const ring of polygons) {
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const a = xy(ring[i]);
      const b = xy(ring[(i + 1) % n]);
      segs.push([a[0], a[1], b[0], b[1]]);
    }
  }
  return segs;
}

// 180° − interior angle at the polygon corner a medial leaf sits on. Larger =
// sharper, more significant feature. Infinity when the vertex isn't an input
// corner (so junction nodes exposed by pruning are never pruned by angle).
function cornerSharpness(vertex, polygons) {
  if (!vertex || !vertex.source) return Infinity;
  const ring = polygons[vertex.source.polygon];
  const n = ring.length;
  const k = vertex.source.vertex;
  const c = xy(ring[k]);
  const p = xy(ring[(k - 1 + n) % n]);
  const q = xy(ring[(k + 1) % n]);
  const a = [p[0] - c[0], p[1] - c[1]];
  const b = [q[0] - c[0], q[1] - c[1]];
  const na = Math.hypot(a[0], a[1]);
  const nb = Math.hypot(b[0], b[1]);
  if (!na || !nb) return Infinity;
  const cos = Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1]) / (na * nb)));
  return 180 - (Math.acos(cos) * 180) / Math.PI;
}

/**
 * Precompute per-edge length and ribbon area, and per-vertex corner sharpness.
 * These depend only on geometry, so a slider can re-`prune()` without redoing
 * them. `tessellate` is voron8's tessellate (injected to keep this standalone).
 */
export function precomputeMetrics(medial, polygons, tessellate, parabolaSamples = 16) {
  const segs = boundarySegments(polygons);
  const radiusAt = (x, y) => {
    let m = Infinity;
    for (const s of segs) {
      const d = pointSegDistance(x, y, s[0], s[1], s[2], s[3]);
      if (d < m) m = d;
    }
    return m;
  };

  const lenOf = new Array(medial.edges.length).fill(0);
  const areaOf = new Array(medial.edges.length).fill(0);
  medial.edges.forEach((e, i) => {
    if (e.from < 0 || e.to < 0) return;
    const poly = tessellate(e.geometry, { parabolaSamples });
    let L = 0;
    for (let k = 1; k < poly.length; k++) {
      L += Math.hypot(poly[k].x - poly[k - 1].x, poly[k].y - poly[k - 1].y);
    }
    let r = 0;
    for (const p of poly) r += radiusAt(p.x, p.y);
    r = poly.length ? r / poly.length : 0;
    lenOf[i] = L;
    areaOf[i] = L * r;
  });

  const sharpnessOf = new Map();
  medial.vertices.forEach((v, node) => sharpnessOf.set(node, cornerSharpness(v, polygons)));

  return { lenOf, areaOf, sharpnessOf };
}

function buildAdjacency(edges, alive) {
  const adj = new Map();
  const add = (n, e, o) => {
    if (!adj.has(n)) adj.set(n, []);
    adj.get(n).push({ e, o });
  };
  edges.forEach((ed, i) => {
    if (!alive[i] || ed.from < 0 || ed.to < 0) return;
    add(ed.from, i, ed.to);
    add(ed.to, i, ed.from);
  });
  return adj;
}

// Walk from a leaf through degree-2 nodes to the next leaf or junction,
// collecting the edges of that branch.
function traceBranch(leaf, adj) {
  const edges = [];
  let node = leaf;
  let fromEdge = -1;
  while (true) {
    const nbrs = adj.get(node) || [];
    if (node !== leaf && nbrs.length !== 2) break; // reached a junction or leaf
    let next = null;
    for (const nb of nbrs) {
      if (nb.e !== fromEdge) { next = nb; break; }
    }
    if (!next) break;
    edges.push(next.e);
    fromEdge = next.e;
    node = next.o;
    if (node === leaf) break; // pure-cycle guard (shouldn't happen from a leaf)
  }
  return { edges, terminal: node };
}

/**
 * Return a boolean array (per medial edge) of which edges survive pruning at
 * `threshold` under `mode` ("none" | "length" | "area" | "angle"). Cycles (e.g.
 * around holes) have no leaves and are never pruned.
 */
export function prune(medial, metrics, mode, threshold) {
  const edges = medial.edges;
  const alive = edges.map((e) => e.from >= 0 && e.to >= 0);
  if (mode === "none" || !(threshold > 0)) return alive;

  let changed = true;
  while (changed) {
    changed = false;
    const adj = buildAdjacency(edges, alive);
    const leaves = [];
    for (const [node, nbrs] of adj) if (nbrs.length === 1) leaves.push(node);

    for (const leaf of leaves) {
      const nbrs = adj.get(leaf);
      if (!nbrs || nbrs.length !== 1) continue; // degree changed earlier this pass
      const branch = traceBranch(leaf, adj);
      if (!branch.edges.length || branch.edges.some((ei) => !alive[ei])) continue;

      let sig;
      if (mode === "length") sig = branch.edges.reduce((s, ei) => s + metrics.lenOf[ei], 0);
      else if (mode === "area") sig = branch.edges.reduce((s, ei) => s + metrics.areaOf[ei], 0);
      else if (mode === "angle") sig = metrics.sharpnessOf.get(leaf) ?? Infinity;
      else sig = Infinity;

      if (sig < threshold) {
        branch.edges.forEach((ei) => (alive[ei] = false));
        changed = true;
      }
    }
  }
  return alive;
}
