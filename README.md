# voron8

[![CI](https://github.com/matthewjacobson/voron8/actions/workflows/ci.yml/badge.svg)](https://github.com/matthewjacobson/voron8/actions/workflows/ci.yml)

The segment **Voro**noi diagram of polygons, computed by [CGAL](https://www.cgal.org/) and shipped as WebAssembly.

**[Voronoi demo →](https://matthewjacobson.github.io/voron8/example/)** · **[Medial-axis demo →](https://matthewjacobson.github.io/voron8/example/medial-axis.html)** (pick a shape from the [interesting-polygon-archive](https://github.com/LingDong-/interesting-polygon-archive)) · **[Compound-Voronoi demo →](https://matthewjacobson.github.io/voron8/example/compound-voronoi.html)** (live soft-body blobs)

Give it an array of polygons; get back a graph of Voronoi vertices and edges where:

- **every edge is labeled `interior` or `exterior`** relative to the even-odd filled input region (so it doubles as a medial-axis / shape-skeleton extractor), and
- **every vertex that coincides with an original polygon corner is traced back** to its `{ polygon, vertex }` source.

The published package is a single ES module with the wasm embedded as base64 — nothing extra to host, no native toolchain to install.

## Install

```sh
npm install voron8
```

## Usage

```js
import { voronoi, medialAxis, tessellate } from "voron8";

// One ring per polygon. Points may be {x, y} or [x, y]; rings auto-close.
const square = [
  [ [0, 0], [4, 0], [4, 4], [0, 4] ],
];

const { vertices, edges } = await voronoi(square);

// Which Voronoi vertices are original polygon corners?
for (const v of vertices) {
  if (v.isInput) {
    console.log(`corner ${v.source.polygon}:${v.source.vertex} at (${v.x}, ${v.y})`);
  }
}

// The medial axis (interior skeleton) of the shape.
const skeleton = await medialAxis(square);

// Turn any edge — straight, ray, or curved parabolic arc — into a polyline.
for (const e of skeleton.edges) {
  const polyline = tessellate(e.geometry, { parabolaSamples: 24 });
  draw(polyline);
}
```

`init()` is awaited automatically by `voronoi()`; call it yourself only if you want to warm the wasm up ahead of time.

### Module formats

The package ships an ES module (the default) and a UMD build. The wasm core is
inlined in both, so there are no extra assets to host.

```js
// ES modules / bundlers
import { voronoi, medialAxis, tessellate } from "voron8";

// CommonJS
const { voronoi, medialAxis, tessellate } = require("voron8");
```

For a classic `<script>` tag, load the UMD build from a CDN; it exposes a global
`voron8`:

```html
<script src="https://cdn.jsdelivr.net/npm/voron8/dist/voron8.umd.cjs"></script>
<script>
  voron8.voronoi([[ [0, 0], [4, 0], [4, 4], [0, 4] ]]).then(({ edges }) => {
    console.log(edges.length);
  });
</script>
```

## Input

```ts
type Polygon = Point[] | Array<[number, number]>;
voronoi(polygons: Polygon[]): Promise<VoronoiResult>;
```

- Each polygon is a closed ring of vertices (do **not** repeat the first point at the end).
- Pass multiple rings to compute one diagram over all of them at once.
- **Holes:** interior/exterior labeling uses the even-odd fill rule, so a ring nested inside another acts as a hole — edges inside the hole are labeled `exterior`.

## Output

```ts
interface VoronoiResult {
  vertices: VoronoiVertex[];
  edges: VoronoiEdge[];
}

interface VoronoiVertex {
  x: number;
  y: number;
  isInput: boolean;                                   // coincides with a polygon corner?
  source: { polygon: number; vertex: number } | null; // where it came from, if so
}

interface VoronoiEdge {
  from: number;   // index into vertices, or -1 if this endpoint is at infinity
  to: number;     // index into vertices, or -1 if this endpoint is at infinity
  location: "interior" | "exterior";
  sites: [SiteRef, SiteRef];  // the two input sites this edge bisects
  geometry: EdgeGeometry;
}

interface SiteRef {
  type: "point" | "segment" | "infinite";
  source: VertexRef | null;                          // set for input corners (point sites)
  segment: [VertexRef | null, VertexRef | null] | null; // endpoints (segment sites)
}

interface VertexRef { polygon: number; vertex: number; }
```

`EdgeGeometry` is a tagged union — the segment Voronoi diagram has both straight and curved bisectors:

| `type`       | fields                                              | meaning |
|--------------|-----------------------------------------------------|---------|
| `"segment"`  | `source`, `target`                                  | a finite straight bisector |
| `"ray"`      | `source`, `direction`                               | a semi-infinite bisector (always `exterior`) |
| `"line"`     | `point`, `direction`                                | a doubly-infinite bisector (rare) |
| `"parabola"` | `focus`, `directrix {a,b,c}`, `source`, `target`    | a parabolic arc between a corner (focus) and a non-adjacent edge (directrix `ax+by+c=0`) |

### Tessellation

```ts
tessellate(geom: EdgeGeometry, options?: {
  parabolaSamples?: number;  // points along a parabolic arc (default 16)
  infiniteLength?: number;   // extrusion length for rays/lines (default 1e4)
}): Point[];
```

Returns a polyline. Straight edges return their two endpoints; parabolic arcs are sampled exactly along the curve; rays and lines are extruded to a finite length.

### Medial axis

```ts
medialAxis(polygons: Polygon[]): Promise<VoronoiResult>;
```

The interior **medial axis** (skeleton) of the filled region: every interior Voronoi edge *except* the degenerate bisectors between a polygon vertex and one of its own incident edges. Because CGAL treats each segment endpoint as its own site, those incident pairs produce perpendicular bisectors that touch the boundary at a single point and aren't part of the skeleton. Everything else is kept — including the parabolic arcs between a reflex vertex and the wall facing it, and bisectors between two reflex vertices. The result shares the same `vertices` as `voronoi()` (so `from`/`to` indices stay valid) with `edges` narrowed to the medial axis.

The interactive [medial-axis demo](https://matthewjacobson.github.io/voron8/example/medial-axis.html) runs this over shapes from the [interesting-polygon-archive](https://github.com/LingDong-/interesting-polygon-archive), with three sliders that feature-prune the axis. The pruning follows the rooted-tree model of [micycle1's PGS `MedialAxis`](https://github.com/micycle1/PGS/blob/8231057/src/main/java/micycle/pgs/PGS_Contour.java): the axis is rooted at its widest disk, and three normalized 0..1 thresholds prune it — **axial** (per-edge gradient `d(radius)/d(length)`), **distance** (geodesic distance from the root), and **area** (a subtree's aggregate feature area, normalized per connected component) — each cutting an edge and its whole subtree. It's plain client-side code in [`example/prune.js`](example/prune.js); voron8 itself returns the unpruned axis.

### Edges that separate two polygons

When you pass several polygons at once, the edges whose two sites come from *different* polygons trace the boundary between them — the compound-Voronoi partition. Every edge already carries the two `sites` it bisects, and each site knows the polygon it came from, so you can filter for these directly — no need to inspect `from`/`to` (those index the edge's *endpoints*, not the cells it divides):

```js
// The polygon a site originates from, or null if it can't be attributed.
const sitePolygon = (s) =>
  s.type === "point"   ? (s.source?.polygon ?? null) :
  s.type === "segment" ? (s.segment?.[0]?.polygon ?? s.segment?.[1]?.polygon ?? null) :
  null; // infinite

const { edges } = await voronoi(polygons);
const separating = edges.filter((e) => {
  const [a, b] = e.sites;
  const pa = sitePolygon(a), pb = sitePolygon(b);
  return pa !== null && pb !== null && pa !== pb;
});
```

(A segment site's two endpoints are consecutive vertices of the same ring, so either one gives its polygon; endpoints read `null` only for points CGAL synthesized, e.g. where two input rings cross.) The live [compound-Voronoi demo](https://matthewjacobson.github.io/voron8/example/compound-voronoi.html) animates a set of morphing soft-body blobs and redraws this separation network every frame.

## Why a polygon corner shows up as a Voronoi vertex

In the segment Voronoi diagram each polygon **edge** and each polygon **corner** is a site. Two edges meeting at a corner are both zero distance from that corner, so the corner is itself a Voronoi vertex — which is why `voronoi()` can hand its provenance straight back to you via `source`.

## Building from source

You only need this if you're changing the C++; the prebuilt wasm is committed.

Requirements: [Emscripten](https://emscripten.org/) (`emcc` on `PATH`), plus CGAL and Boost headers (`brew install cgal boost`).

```sh
npm run build:wasm   # cpp/voronoi.cpp -> src/core/voronoi.js (single-file ESM)
npm run build        # bundle the TS API + wasm -> dist/voron8.js (ESM), dist/voron8.umd.cjs (UMD) (+ .d.ts)
npm run build:all    # both
npm test
```

Override header locations with `CGAL_INCLUDE_DIR` / `BOOST_INCLUDE_DIR` if they aren't in Homebrew's default prefix.

### Why a filtered kernel on WASM (and how it stays sound)

CGAL's filtered kernels (`EPICK`/`EPECK`) get their speed from interval arithmetic, which normally needs to switch the CPU's floating-point **rounding mode** to keep its bounds rigorous. **WebAssembly has no instruction to change the rounding mode** — every operation rounds to nearest — so a naive filtered kernel would be *unsound* here (occasional wrong predicate signs → wrong topology), which is why earlier versions of voron8 fell back to a slow pure-exact rational kernel.

CGAL anticipates exactly this case with the **`CGAL_ALWAYS_ROUND_TO_NEAREST`** build flag: `Interval_nt` then computes in round-to-nearest and widens each bound outward by one ULP (`nextafter`), so the bounds stay rigorous — just slightly looser, costing a few extra exact fallbacks. With that flag (set in `scripts/build-wasm.sh`), voron8 uses CGAL's **`Segment_Delaunay_graph_filtered_traits_2`**: predicates resolve in fast double intervals and fall back to an exact GMP-free `Quotient<MP_Float>` kernel only on genuinely close cases.

The result is **~50× faster** than the old pure-exact kernel (the compound-Voronoi example dropped from ~22 s to ~0.4 s) while producing **identical topology**. Constructions run in `double`, so Voronoi-vertex coordinates carry machine-epsilon error (~1e-14); input polygon corners still match exactly, so vertex/site provenance (`isInput`, `source`, `sites`) is preserved. Insertion still uses CGAL's spatial-sorted `insert_segments`.

## Releasing

Releases publish to npm via [Trusted Publishing (OIDC)](https://docs.npmjs.com/trusted-publishers/) — no npm token is stored in the repo. The `Publish` workflow runs on `v*` tags, authenticates through GitHub's OIDC, and npm attaches a provenance attestation automatically.

One-time bootstrap (OIDC cannot create a package, only publish to an existing one):

1. `npm login`, then `npm publish` locally to create the package's first version.
2. On npmjs.com → the package → **Settings → Trusted Publisher**, add: organization `matthewjacobson`, repository `voron8`, workflow `publish.yml`.

After that, each release is just:

```sh
npm version patch   # bumps package.json and creates the matching git tag
git push --follow-tags
```

## License

MIT (this wrapper). Note that CGAL itself is distributed under GPL/LGPL terms; the compiled wasm links CGAL's headers, so your use of the wasm artifact is subject to CGAL's licensing.
