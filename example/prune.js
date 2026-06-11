// Feature pruning for a voron8 medial axis, following the rooted-tree model of
// micycle1's PGS / boneyard MedialAxis (getPrunedEdges):
// https://github.com/micycle1/PGS/blob/8231057/src/main/java/micycle/pgs/PGS_Contour.java
//
// The medial axis is rooted at its widest point (largest inscribed disk) and
// turned into a tree. Three normalized 0..1 measures prune it, each cutting an
// edge AND its whole subtree at the first failing node:
//
//   axial    — per-edge axial gradient d(radius)/d(length). Pruning raises the
//              kept-floor from the min gradient toward the max, removing the
//              steeply tapering tips first.
//   distance — geodesic distance from the root to the edge's far end. Pruning
//              lowers the kept-ceiling from the furthest disk toward the root.
//   area     — feature area of the edge's subtree (Σ ribbon area of descendants).
//              Pruning raises the kept-floor toward the whole-shape area.
//
// Thresholds map exactly as PGS does: axial/area are cubed (t³) before mapping;
// distance maps as furthest·(1−t). 0 = no pruning, 1 = maximum pruning.
//
// Pure, DOM-free, and unit-tested in test/prune.test.mjs.

function xy(p) {
  return Array.isArray(p) ? [p[0], p[1]] : [p.x, p.y];
}

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

const clamp01 = (t) => Math.min(1, Math.max(0, t));

/**
 * Build the rooted medial-axis tree and per-edge/per-node metrics. Geometry-only,
 * so a slider can re-`pruneTree()` cheaply without rebuilding. `tessellate` is
 * voron8's tessellate (injected to keep this module standalone).
 */
export function buildMedialTree(medial, polygons, tessellate, parabolaSamples = 24) {
  const edges = medial.edges;
  const segs = boundarySegments(polygons);
  const radiusAt = (x, y) => {
    let m = Infinity;
    for (const s of segs) {
      const d = pointSegDistance(x, y, s[0], s[1], s[2], s[3]);
      if (d < m) m = d;
    }
    return m;
  };

  // Inscribed radius (clearance) at every medial vertex an edge touches.
  const radius = new Map();
  const note = (n) => {
    if (n >= 0 && !radius.has(n)) {
      const v = medial.vertices[n];
      radius.set(n, radiusAt(v.x, v.y));
    }
  };
  edges.forEach((e) => {
    if (e.from >= 0 && e.to >= 0) { note(e.from); note(e.to); }
  });

  // Per-edge length and a ribbon-area proxy (length × average clearance) standing
  // in for PGS's Delaunay-triangle area.
  const edgeLen = new Array(edges.length).fill(0);
  const edgeArea = new Array(edges.length).fill(0);
  edges.forEach((e, i) => {
    if (e.from < 0 || e.to < 0) return;
    const poly = tessellate(e.geometry, { parabolaSamples });
    let L = 0;
    for (let k = 1; k < poly.length; k++) {
      L += Math.hypot(poly[k].x - poly[k - 1].x, poly[k].y - poly[k - 1].y);
    }
    let r = 0;
    for (const p of poly) r += radiusAt(p.x, p.y);
    r = poly.length ? r / poly.length : 0;
    edgeLen[i] = L;
    edgeArea[i] = L * r;
  });

  // Adjacency over bounded edges.
  const adj = new Map();
  const add = (n, e, o) => {
    if (!adj.has(n)) adj.set(n, []);
    adj.get(n).push({ e, o });
  };
  edges.forEach((e, i) => {
    if (e.from < 0 || e.to < 0) return;
    add(e.from, i, e.to);
    add(e.to, i, e.from);
  });

  // Forest BFS: root each connected component at its widest disk (max radius),
  // mirroring PGS's "largest inscribed disk" root. Geodesic distance accumulates
  // edge lengths from the root.
  const parentEdge = new Map();
  const children = new Map();
  const distance = new Map();
  const visited = new Set();
  const roots = [];
  const byRadiusDesc = [...radius.keys()].sort((a, b) => radius.get(b) - radius.get(a));

  for (const start of byRadiusDesc) {
    if (visited.has(start)) continue;
    roots.push(start);
    visited.add(start);
    distance.set(start, 0);
    if (!children.has(start)) children.set(start, []);
    const queue = [start];
    while (queue.length) {
      const u = queue.shift();
      for (const { e, o } of adj.get(u) || []) {
        if (visited.has(o)) continue;
        visited.add(o);
        parentEdge.set(o, e);
        distance.set(o, distance.get(u) + edgeLen[e]);
        children.get(u).push({ edge: e, child: o });
        if (!children.has(o)) children.set(o, []);
        queue.push(o);
      }
    }
  }

  // Axial gradient of each tree edge (attributed to its far/child node).
  const axialGradient = new Map();
  let minGrad = Infinity, maxGrad = -Infinity;
  for (const [child, e] of parentEdge) {
    const u = edges[e].from === child ? edges[e].to : edges[e].from;
    const g = edgeLen[e] ? (radius.get(child) - radius.get(u)) / edgeLen[e] : 0;
    axialGradient.set(child, g);
    if (g < minGrad) minGrad = g;
    if (g > maxGrad) maxGrad = g;
  }
  if (!isFinite(minGrad)) { minGrad = 0; maxGrad = 0; }

  // Feature area: subtree sum of node areas (a node's area is its parent edge's
  // ribbon area; the root contributes 0). Post-order over each rooted tree.
  const featureArea = new Map();
  const nodeArea = (n) => (parentEdge.has(n) ? edgeArea[parentEdge.get(n)] : 0);
  for (const root of roots) {
    const order = [];
    const stack = [root];
    while (stack.length) {
      const u = stack.pop();
      order.push(u);
      for (const { child } of children.get(u) || []) stack.push(child);
    }
    for (let i = order.length - 1; i >= 0; i--) {
      const u = order[i];
      let a = nodeArea(u);
      for (const { child } of children.get(u) || []) a += featureArea.get(child);
      featureArea.set(u, a);
    }
  }

  const furthestDistance = distance.size ? Math.max(...distance.values()) : 0;
  const totalArea = roots.reduce((s, r) => s + (featureArea.get(r) || 0), 0);
  const treeEdges = new Set(parentEdge.values());

  return {
    edges, edgeLen, edgeArea, radius, parentEdge, children, distance,
    axialGradient, featureArea, roots, treeEdges,
    minGrad, maxGrad, furthestDistance, totalArea,
  };
}

/**
 * Boolean array (per medial edge) of which edges survive pruning at the three
 * normalized 0..1 thresholds, using PGS's mapping and root-down subtree cutoff.
 * Edges closing a cycle (e.g. around a hole) aren't tree edges; they survive iff
 * both endpoints survive.
 */
export function pruneTree(tree, axialThreshold, distanceThreshold, areaThreshold) {
  const a = clamp01(axialThreshold);
  const mappedAxial = tree.minGrad + (tree.maxGrad - tree.minGrad) * (a * a * a);
  const mappedDistance = tree.furthestDistance * (1 - clamp01(distanceThreshold));
  const ar = clamp01(areaThreshold);
  const mappedArea = ar * ar * ar * tree.totalArea;

  const alive = tree.edges.map(() => false);
  const aliveNode = new Set();

  for (const root of tree.roots) {
    aliveNode.add(root);
    const stack = [root];
    while (stack.length) {
      const u = stack.pop();
      for (const { edge, child } of tree.children.get(u) || []) {
        const keep =
          tree.axialGradient.get(child) >= mappedAxial &&
          tree.distance.get(child) <= mappedDistance &&
          tree.featureArea.get(child) >= mappedArea;
        if (keep) {
          alive[edge] = true;
          aliveNode.add(child);
          stack.push(child);
        }
      }
    }
  }

  // Non-tree (cycle-closing) edges survive when both endpoints survived.
  tree.edges.forEach((e, i) => {
    if (alive[i] || e.from < 0 || e.to < 0 || tree.treeEdges.has(i)) return;
    if (aliveNode.has(e.from) && aliveNode.has(e.to)) alive[i] = true;
  });

  return alive;
}
