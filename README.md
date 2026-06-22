# voron8

[![CI](https://github.com/matthewjacobson/voron8/actions/workflows/ci.yml/badge.svg)](https://github.com/matthewjacobson/voron8/actions/workflows/ci.yml)

The segment **Voro**noi diagram of points, segments, and polygons, computed by [CGAL](https://www.cgal.org/) and shipped as WebAssembly.

- **[Voronoi demo →](https://matthewjacobson.github.io/voron8/example/)**
- **[Medial-axis demo →](https://matthewjacobson.github.io/voron8/example/medial-axis.html)** (pick a shape from the [interesting-polygon-archive](https://github.com/LingDong-/interesting-polygon-archive))
- **[Compound-Voronoi demo →](https://matthewjacobson.github.io/voron8/example/compound-voronoi.html)** (live soft-body blobs, points & open segments — disjoint mixed input)
- **[Connected-component demo →](https://matthewjacobson.github.io/voron8/example/compound-connected.html)** (overlapping strokes that merge into compound shapes when they cross)
- **[CDN/UMD demo →](https://matthewjacobson.github.io/voron8/example/cdn-umd.html)** (no build step)

Give it any mix of points, open segments, and closed polygons; get back a graph of Voronoi vertices and edges where:

- **every edge is labeled `interior` or `exterior`** relative to the even-odd filled region of the polygons (so it doubles as a medial-axis / shape-skeleton extractor), and
- **every vertex that coincides with an original input vertex is traced back** to its `{ input, vertex }` source.

The published package is a single ES module with the wasm embedded as base64 — nothing extra to host, no native toolchain to install.

## Install

```sh
npm install voron8
```

## Usage

```js
import { init, voronoi, medialAxis, tessellate } from "voron8";

// Load the wasm once. This is the only asynchronous step.
await init();

// One ring per polygon. Points may be {x, y} or [x, y]; rings auto-close.
const square = [
  [ [0, 0], [4, 0], [4, 4], [0, 4] ],
];

const { vertices, edges } = voronoi(square);

// Which Voronoi vertices are original input vertices?
for (const v of vertices) {
  if (v.isInput) {
    console.log(`corner ${v.source.input}:${v.source.vertex} at (${v.x}, ${v.y})`);
  }
}

// The medial axis (interior skeleton) of the shape.
const skeleton = medialAxis(square);

// Turn any edge — straight, ray, or curved parabolic arc — into a polyline.
for (const e of skeleton.edges) {
  const polyline = tessellate(e.geometry, { parabolaSamples: 24 });
  draw(polyline);
}
```

`init()` loads and caches the wasm module; call it once (awaiting it) before
`voronoi()` or `medialAxis()`, which are synchronous and throw if it hasn't
finished. Calling `init()` again just returns the cached module.

### Module formats

The package ships an ES module (the default) and a UMD build. The wasm core is
inlined in both, so there are no extra assets to host.

```js
// ES modules / bundlers
import { init, voronoi, medialAxis, tessellate } from "voron8";

// CommonJS
const { init, voronoi, medialAxis, tessellate } = require("voron8");
```

For a classic `<script>` tag, load the UMD build from a CDN; it exposes a global
`voron8`:

```html
<script src="https://cdn.jsdelivr.net/npm/voron8/dist/voron8.umd.js"></script>
<script>
  voron8.init().then(() => {
    const { edges } = voron8.voronoi([[ [0, 0], [4, 0], [4, 4], [0, 4] ]]);
    console.log(edges.length);
  });
</script>
```

## Input

```ts
type Polygon  = Point[] | Array<[number, number]>; // closed ring
type Polyline = Point[] | Array<[number, number]>; // open chain (>= 2 points)

interface SiteInput {
  points?:   Array<Point | [number, number]>; // isolated points
  segments?: Polyline[];                       // open segments / polylines
  polygons?: Polygon[];                        // closed rings
}

voronoi(input: Polygon[] | SiteInput, options?: VoronoiOptions): VoronoiResult; // await init() once first
```

You can pass any mix of site kinds:

```js
voronoi({
  points:   [[5, 5]],
  segments: [[ [0, 0], [4, 4] ]], // a single open segment
  polygons: [ square ],           // closed ring(s)
});
```

- A bare array of rings is shorthand for `{ polygons }` — the original API is unchanged.
- Each **polygon** is a closed ring (do **not** repeat the first point at the end); each **segment** is an open chain that is *not* closed; a two-point chain is a single line segment.
- Sites flatten into one ordered list — **points, then segments, then polygons** — and `source.input` (below) indexes into that list. With the bare-array form, `input` is just the ring index.
- **Holes / interior:** interior/exterior labeling uses the even-odd fill rule over the **polygons only** (points and open segments enclose no region). A ring nested inside another acts as a hole — edges inside it are `exterior`.
- **Crossing segments** are allowed: where two segment interiors cross, CGAL inserts the intersection as a new point site. That site is not an input vertex, so it appears with `isInput: false` and a `null` source. Crossings are also the main cost driver — see [Performance](#performance-crossing-segments) for the numbers and an opt-in fast path for intersection-free input.

## Output

```ts
interface VoronoiResult {
  vertices: VoronoiVertex[];
  edges: VoronoiEdge[];
  faces: VoronoiFace[];  // one per input site (empty from medialAxis())
  groups?: CellGroup[];  // present only when the `labels` option is passed
}

interface VoronoiVertex {
  x: number;
  y: number;
  isInput: boolean;                                  // coincides with an input vertex?
  source: { input: number; vertex: number } | null; // where it came from, if so
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
  source: VertexRef | null;                          // set for input vertices (point sites)
  segment: [VertexRef | null, VertexRef | null] | null; // endpoints (segment sites)
}

interface VertexRef { input: number; vertex: number; }

interface VoronoiFace {
  site: SiteRef;       // the cell's generating site
  unbounded: boolean;  // does the cell run off to infinity?
  boundary: number[];  // indices into edges[], the cell boundary in CCW order
}

interface VoronoiOptions {
  labels?: number[];               // one label per input (enables `groups`)
  assumeNoIntersections?: boolean; // fast path; input must be intersection-free
  skipIntersectionCheck?: boolean; // opt out of the fast path's safety scan
}

interface CellGroup {
  label: number;          // the caller-supplied label value
  rings: OutlineRing[];   // outline of the union of this label's cells
}

interface OutlineRing { unbounded: boolean; boundary: number[]; }  // like a face boundary
```

Each face is a Voronoi cell, reported directly by CGAL — no need to reassemble cells from the edge list. `boundary` lists the cell's edges (as indices into `edges`) in counter-clockwise order: for a bounded cell the edges form a closed loop (consecutive edges, and the last with the first, share a `vertices` endpoint); for an unbounded cell the boundary is an open arc whose first and last entries are the cell's two semi-infinite edges, with the gap between them at infinity. To render a filled cell you still clip the unbounded ones to a viewport (`tessellate` extrudes rays to a finite length); see `example/compound-connected.html`.

### Compound-Voronoi groups

Pass `labels` (one per input, in `source.input` order) and the result gains `groups`: for each distinct label, the **outline of the union of that label's cells** — the compound-Voronoi "territory" of that label. Each ring is shaped exactly like a face `boundary` (CCW edge indices, open at infinity when unbounded), so you render it the same way. This is computed in CGAL by tracing the frontier between differently-labeled cells, so you get one merged polygon per label rather than a pile of per-cell boundaries.

```js
// strokes that touch share a label; their cells merge into one territory
const { groups } = voronoi({ segments: strokes }, { labels: component });
```

A synthesized segment-crossing point (which has no input) inherits the label of its surrounding cells when they agree — so when two inputs sharing a label cross, the crossing is folded into the territory rather than punching a hole in it. A genuine junction between two different labels stays its own tiny region. See `example/compound-connected.html`, which fills and strokes one outline per compound shape.

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
medialAxis(input: Polygon[]): VoronoiResult; // await init() once first
```

The interior **medial axis** (skeleton) of the filled region: every interior Voronoi edge *except* the degenerate bisectors between a polygon vertex and one of its own incident edges. Because CGAL treats each segment endpoint as its own site, those incident pairs produce perpendicular bisectors that touch the boundary at a single point and aren't part of the skeleton. Everything else is kept — including the parabolic arcs between a reflex vertex and the wall facing it, and bisectors between two reflex vertices. The result shares the same `vertices` as `voronoi()` (so `from`/`to` indices stay valid) with `edges` narrowed to the medial axis.

`medialAxis()` takes **polygon rings only** — a medial axis is defined by the *filled region*, and only closed polygons enclose area (nested rings act as holes under the even-odd rule). Isolated points and open polylines enclose nothing, so they aren't a meaningful medial-axis input. If you want the skeleton of a mixed `SiteInput`, call `voronoi({ ... })` and filter its edges to the interior ones yourself.

The interactive [medial-axis demo](https://matthewjacobson.github.io/voron8/example/medial-axis.html) runs this over shapes from the [interesting-polygon-archive](https://github.com/LingDong-/interesting-polygon-archive), with three sliders that feature-prune the axis. The pruning follows the rooted-tree model of [micycle1's PGS `MedialAxis`](https://github.com/micycle1/PGS/blob/8231057/src/main/java/micycle/pgs/PGS_Contour.java): the axis is rooted at its widest disk, and three normalized 0..1 thresholds prune it — **axial** (per-edge gradient `d(radius)/d(length)`), **distance** (geodesic distance from the root), and **area** (a subtree's aggregate feature area, normalized per connected component) — each cutting an edge and its whole subtree. It's plain client-side code in [`example/prune.js`](example/prune.js); voron8 itself returns the unpruned axis.

### Edges that separate two polygons

When you pass several inputs at once, the edges whose two sites come from *different* inputs trace the boundary between them — the compound-Voronoi partition. Every edge already carries the two `sites` it bisects, and each site knows the input it came from (`source.input`), so you can filter for these directly — no need to inspect `from`/`to` (those index the edge's *endpoints*, not the cells it divides):

```js
// The input a site originates from, or null if it can't be attributed.
const siteInput = (s) =>
  s.type === "point"   ? (s.source?.input ?? null) :
  s.type === "segment" ? (s.segment?.[0]?.input ?? s.segment?.[1]?.input ?? null) :
  null; // infinite

const { edges } = voronoi(polygons);
const separating = edges.filter((e) => {
  const [a, b] = e.sites;
  const pa = siteInput(a), pb = siteInput(b);
  return pa !== null && pb !== null && pa !== pb;
});
```

(A segment site's two endpoints are consecutive vertices of the same input, so either one gives its index; endpoints read `null` only for points CGAL synthesized, e.g. where two segments cross.) The live [compound-Voronoi demo](https://matthewjacobson.github.io/voron8/example/compound-voronoi.html) animates a mix of morphing soft-body blobs, open segments, and points — kept disjoint — and redraws this separation network every frame.

When inputs are allowed to **overlap**, "which shape did this come from" is no longer one input index. The [connected-component demo](https://matthewjacobson.github.io/voron8/example/compound-connected.html) handles that by grouping the inputs into connected components (union-find over shared endpoints and crossings) and treating each component as one compound shape: separators are drawn only between *different* components, so where two strokes cross they merge into a single shape and the boundary between them disappears. This also sidesteps the synthesized crossing point's `null` provenance — that point is interior to the merged shape, so the ambiguous edges around it are exactly the ones that correctly drop out.

## Performance: crossing segments

voron8's running time is dominated by **segment–segment intersections**. The default traits handles crossing and overlapping segments robustly by constructing each intersection point and inserting it as a new site — but on WebAssembly, where the exact fallback kernel is GMP-free `MP_Float`, every crossing is expensive. Measured on disjoint vs. crossing inputs, the cost is almost exactly linear in each:

> **time ≈ 12 ms × (#segments) + 17 ms × (#crossings)**

A plain segment insertion costs ~12 ms; each intersection adds ~17 ms. Because a set of *s* mutually-crossing segments has Θ(*s*²) intersections, densely crossing input degrades toward quadratic time — e.g. 60 segments through a common point takes ~9 s, versus tens of milliseconds when they don't cross. (This is specifically about **crossings**: collinear, overlapping, or duplicate segments are *not* slow — CGAL merges them cheaply.)

### The intersection-free fast path

If you can guarantee the input has **no crossing or overlapping segments** — a simple polygon, a polygon with holes, or any planar graph you've already noded — pass `assumeNoIntersections: true`:

```js
voronoi({ polygons: [outer, hole] }, { assumeNoIntersections: true });
```

This selects CGAL's *without-intersections* traits, which omits all the intersection machinery; it's markedly faster (~3× even on already-intersection-free input, and it sidesteps the quadratic blow-up entirely). Segments that merely **touch at a shared endpoint** — like consecutive polygon edges — are fine; only interiors that cross, T-junctions, and collinear overlaps are disallowed.

CGAL would *silently drop* an offending segment on a broken promise, returning a corrupt diagram with no error. So voron8 first runs a **sweep-line scan** (`O((n + k) log n)` for *n* segments) and throws a clear error if any two input segments actually cross or overlap. The scan is cheap next to the construction it guards (microseconds-to-milliseconds even for thousands of segments). If you are *certain* the input is clean and want to skip even that, also pass `skipIntersectionCheck: true` to recover CGAL's raw "trust me" behavior:

```js
voronoi(input, { assumeNoIntersections: true, skipIntersectionCheck: true });
```

## Why an input vertex shows up as a Voronoi vertex

In the segment Voronoi diagram each segment and each endpoint/corner is a site. Two segments meeting at a shared vertex are both zero distance from it, so that vertex is itself a Voronoi vertex — which is why `voronoi()` can hand its provenance straight back to you via `source`.

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
