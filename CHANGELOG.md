# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.4.2] - 2026-07-10

### Fixed

- `MedialAxisPathFinder`: endpoint connectors are now checked against the
  polygon's own boundary edges, not just walls. Near a narrow notch, a straight
  connector could leave the region and re-enter a *different* pocket of it
  without crossing any wall, attaching the endpoint to the wrong medial
  component and reporting a spurious `found: false` between plainly connected
  points.
- `MedialAxisPathFinder`: the connector-blocking test now uses a grazing
  tolerance (~1e-9 of the coordinate scale). An endpoint constructed exactly on
  a boundary or wall edge carries machine-epsilon residue off the exact line,
  which the strict crossing test read as a hair-width proper crossing of the
  very edge the point sits on — wrongly rejecting valid connectors and causing
  detours or spurious `found: false`.
- `MedialAxisPathFinder`: coincident Voronoi-vertex duals no longer fragment
  the medial graph. At a clearance-0 junction (a boundary reflex corner, a wall
  endpoint on an edge) several Delaunay faces dualize to the same point; keyed
  per face they formed distinct nodes joined by zero-length edges that were
  then dropped, splitting the local axis into an island no path could leave.
  Coincident duals are now merged along their (near-)zero-length connecting
  edges — but only when the edge's sites are *not* an incident point–segment
  pair, so the angular-sector boundaries at a pinch point still keep the two
  sides of a partitioning wall apart. Near-equality (1e-9 of the coordinate
  scale) covers positive-radius degeneracies whose independently computed
  circumcenters agree only to ~1e-12.

### Changed

- `MedialAxisPathFinder`: the point-in-region test used during the medial-graph
  rebuild is now banded by y-interval instead of scanning every ring edge per
  query, substantially speeding up rebuilds after `addWall()` on large polygons.

## [3.4.1] - 2026-07-09

### Fixed

- `MedialAxisPathFinder`: endpoint attachment at junction points — a start or
  end lying exactly on a boundary reflex vertex, a wall endpoint, or a
  wall–boundary T-junction (and, more generally, any point where nearby medial
  features tie for nearest). Attachment previously located a *single* Voronoi
  cell via `nearest_neighbor()` — whose tie-break is arbitrary when the point
  is equidistant from several sites, exactly the situation at a junction — and
  committed to a *single* nearest connector, which is destination-blind: at a
  skeleton branch two features tie for nearest, and picking one arbitrarily
  detoured every path headed the other way (observed 92 vs the correct 35 on an
  L-shape), or, with walls, attached to the wrong medial component and reported
  a spurious `found: false` between plainly connected points. Attachment now
  gathers every cell whose closure contains the point (the nearest site plus
  all tied sites, found by BFS over Delaunay adjacency) and adds a temporary
  connector to *every* eligible feature in the preferred tier, letting the
  Dijkstra search make the destination-aware choice. The tier preferences
  (interior spine over boundary stubs, wall-crossing connectors rejected) are
  unchanged, and the global-scan fallback still attaches to the single nearest
  feature only.

## [3.4.0] - 2026-07-07

### Added

- `MedialAxisPathFinder` — a stateful, incremental point-to-point path finder
  that routes along the medial axis of a polygon with holes. Construct it from
  the polygon rings, insert *walls* (segments the path may not cross) one at a
  time with `addWall()` — each is inserted into a live segment Delaunay graph in
  place, not rebuilt — and call `findPath(start, end)` to get
  `{ found, path, length }`, the route as a polyline (parabolic arcs sampled).
  Each endpoint is attached to the axis by locating the Voronoi cell that
  contains it and jumping to the closest interior feature bounding that cell —
  an edge not touching a polygon corner *or a wall endpoint*, or an interior
  branch vertex — so the connector reaches the skeleton's spine rather than a
  short boundary stub (considering vertices also covers a convex region, whose
  only interior feature is its central branch vertex). A wall's endpoints are
  treated as boundary corners exactly like the polygon's, so the clearance-0
  stubs a wall introduces (e.g. where it meets the outer boundary) are skipped
  during attachment just as polygon-corner stubs are. Attachment also rejects
  any candidate whose straight connector would cross a wall: a wall's Voronoi
  cell straddles both of its sides, so a point next to a wall could otherwise
  attach to a feature on the far side (a different medial component when the
  wall splits the axis) and report a spurious "no path" between two points that
  are plainly connected on the same side.
  The whole finder — medial-graph extraction, endpoint attachment, and the
  Dijkstra search — runs in C++/WASM, so adding a wall or querying a path never
  marshals the diagram across the JS boundary; the derived graph is cached and
  recomputed only after a wall is added. Because walls are Voronoi sites the axis
  never crosses, a wall that fully partitions the region makes the two sides
  unreachable (`found: false`). Call `dispose()` to free the underlying object.

## [3.3.0] - 2026-06-29

### Added

- `componentAdjacency(graph)` — a new entry point that takes a planar straight
  line graph (`{ vertices, edges }`, edges as index pairs) and reports which of
  its connected components are Voronoi-adjacent: two components are adjacent when
  some Voronoi edge separates a cell generated by one from a cell generated by
  the other. Returns `componentCount`, the component id of each vertex
  (`vertexComponent`), an `adjacency` list, and the deduped `pairs`. Components
  are an exact union-find over the shared vertex indices (no coordinate
  heuristics). It runs as a single segment Voronoi diagram on the
  intersection-free fast path, so a valid (properly-noded) PSLG is required: it
  throws if any two edges cross, overlap, or form a T-junction. Duplicate and
  self-loop edges are tolerated, and `skipIntersectionCheck` opts out of the
  guard for graphs already known to be well-formed.

## [3.2.0] - 2026-06-22

### Added

- `voronoi(input, { assumeNoIntersections: true })` — an opt-in fast path for
  input whose segments do not cross or overlap (a simple polygon, a polygon with
  holes, any pre-noded planar graph). It uses CGAL's *without-intersections*
  segment Delaunay traits, which omits the intersection-construction machinery
  that dominates runtime: each segment–segment crossing otherwise costs ~17 ms
  on top of ~12 ms per segment, so densely crossing input degrades toward
  quadratic time. The fast path is ~3× faster even on already-crossing-free
  input and produces identical output. Because CGAL silently drops an offending
  segment on a broken promise, voron8 first runs a Shamos–Hoey sweep
  (O((n + k) log n)) and throws if any two input segments actually cross or
  overlap (shared endpoints are allowed).
- `skipIntersectionCheck` option — opt out of that safety sweep when the input
  is already known to be intersection-free (no effect without
  `assumeNoIntersections`).

### Changed

- `medialAxis()` now takes `Polygon[]` only (was `Polygon[] | SiteInput`). A
  medial axis is defined by a filled region, which only closed polygons enclose;
  isolated points and open polylines were never meaningful input. For a mixed
  `SiteInput`, call `voronoi()` and filter its edges to the interior ones.

## [3.1.1] - 2026-06-18

### Fixed

- Passing `labels` to `voronoi()` was far slower than it should be and got
  worse with more distinct labels — the group-outline tracer rescanned every
  halfedge once per group (O(labels × edges)). It now traces all groups in a
  single faces/ccb-driven pass, independent of the label count. On a 100-segment
  diagram with one label per input this drops the call from ~13 s to ~0.5 s; the
  remaining overhead over an unlabeled call is a flat ~2.3× (a second pass over
  the diagram plus emitting the outlines). Output is unchanged.

## [3.1.0] - 2026-06-18

### Added

- `VoronoiResult.faces` — one Voronoi **face** (cell) per input site, reported
  directly by CGAL's Voronoi-diagram adaptor. Each face carries its `site`, an
  `unbounded` flag, and `boundary`: the cell's edges as indices into `edges[]`
  in CCW order (an open arc, rays first/last, when unbounded). Callers no longer
  need to reassemble cells from the edge list.
- `voronoi()` now takes an optional `{ labels }` (one group label per input). When
  given, the result gains `groups` — for each distinct label, the **outline of the
  union of that label's cells** (the compound-Voronoi territory), as `CellGroup`s
  of `OutlineRing`s shaped like face boundaries. Traced in CGAL via the frontier
  between differently-labeled cells. A synthesized segment-crossing point inherits
  its surrounding label when neighbors agree, so crossings within a label merge
  into the territory instead of punching holes. New exported types: `VoronoiFace`,
  `VoronoiOptions`, `CellGroup`, `OutlineRing`.

### Changed

- `example/compound-connected.html` now fills and strokes a single union outline
  per compound shape using the new `groups`, instead of drawing each cell.

## [3.0.0] - 2026-06-18

### Changed

- **BREAKING:** input-vertex provenance is now keyed by `input` instead of
  `polygon`. `VoronoiVertex.source`, `SiteRef.source`, and segment-endpoint
  `VertexRef`s are now `{ input, vertex }`, where `input` indexes into the
  flattened input site list. For the existing array form this is the same number
  the `polygon` field held — only the key name changed.

### Added

- `voronoi()` and `medialAxis()` now accept a general `SiteInput` object —
  `{ points, segments, polygons }` — mixing isolated **points**, open
  **segments**/polylines, and closed **polygons**. The previous `voronoi(polygons)`
  array form still works and is shorthand for `{ polygons }`.

  ```js
  voronoi({
    points: [[5, 5]],
    segments: [[[0, 0], [4, 4]]], // open polylines
    polygons: [square],           // closed rings
  });
  ```

  Sites flatten into one ordered list — points, then segments, then polygons —
  which is the ordering `source.input` indexes into.
- Crossing/overlapping segment interiors are supported: CGAL inserts the
  intersection point as a new site, which surfaces as a non-input
  (`isInput: false`, null `source`) vertex.

### Notes

- Interior/exterior labeling and `medialAxis()` are defined by the **polygons**
  only; points and open segments perturb the diagram as sites but enclose no
  region. An input with no polygons therefore has an empty medial axis.

## [2.0.3] - 2026-06-15

### Fixed

- The UMD bundle is now also emitted as `dist/voron8.umd.js`, which the
  `unpkg`/`jsdelivr` fields point at. Loading the `.cjs` build from a
  `<script>` tag failed in browsers because CDNs serve `.cjs` with a non-JS
  MIME type (jsDelivr uses `application/node`), which `X-Content-Type-Options:
  nosniff` blocks from executing. The `.cjs` build is retained for Node's
  `require`.

## [2.0.2] - 2026-06-15

### Changed

- The publish workflow now creates a GitHub Release for each version tag
  automatically. No effect on the published package.

## [2.0.1] - 2026-06-15

### Added

- This changelog, now shipped in the published package.

## [2.0.0] - 2026-06-15

### Changed

- **BREAKING:** `voronoi()` and `medialAxis()` are now synchronous and return a
  `VoronoiResult` directly instead of a `Promise`. Wasm loading is split into
  the single async step, `init()`. Await `init()` once before calling either
  function; they throw if it has not finished.

  ```js
  import { init, voronoi } from "voron8";
  await init();
  const { vertices, edges } = voronoi(polygons); // no await
  ```

### Added

- UMD build (`dist/voron8.umd.cjs`) alongside the ESM bundle, exposing the
  library to CommonJS `require()`, AMD, and a `voron8` global for classic
  `<script>` tags. Wired up via the package's `require` export condition and
  `unpkg`/`jsdelivr` fields.
- `repository`, `homepage`, and `bugs` metadata in `package.json`.

## [1.0.0]

- Initial release: CGAL segment Voronoi diagram of polygons compiled to
  WebAssembly, with interior/exterior edge labeling, input-vertex provenance,
  `medialAxis()`, and `tessellate()`.

[3.4.1]: https://github.com/matthewjacobson/voron8/compare/v3.4.0...v3.4.1
[3.4.0]: https://github.com/matthewjacobson/voron8/compare/v3.3.0...v3.4.0
[3.3.0]: https://github.com/matthewjacobson/voron8/compare/v3.2.0...v3.3.0
[3.2.0]: https://github.com/matthewjacobson/voron8/compare/v3.1.1...v3.2.0
[3.1.1]: https://github.com/matthewjacobson/voron8/compare/v3.1.0...v3.1.1
[3.1.0]: https://github.com/matthewjacobson/voron8/compare/v3.0.0...v3.1.0
[3.0.0]: https://github.com/matthewjacobson/voron8/compare/v2.0.3...v3.0.0
[2.0.3]: https://github.com/matthewjacobson/voron8/compare/v2.0.2...v2.0.3
[2.0.2]: https://github.com/matthewjacobson/voron8/compare/v2.0.1...v2.0.2
[2.0.1]: https://github.com/matthewjacobson/voron8/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/matthewjacobson/voron8/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/matthewjacobson/voron8/releases/tag/v1.0.0
