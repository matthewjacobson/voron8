# voron8

The segment **Voro**noi diagram of polygons, computed by [CGAL](https://www.cgal.org/) and shipped as WebAssembly.

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
import { voronoi, tessellate } from "voron8";

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

// The interior edges are the medial axis of the shape.
const medialAxis = edges.filter((e) => e.location === "interior");

// Turn any edge — straight, ray, or curved parabolic arc — into a polyline.
for (const e of medialAxis) {
  const polyline = tessellate(e.geometry, { parabolaSamples: 24 });
  draw(polyline);
}
```

`init()` is awaited automatically by `voronoi()`; call it yourself only if you want to warm the wasm up ahead of time.

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
  geometry: EdgeGeometry;
}
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

## Why a polygon corner shows up as a Voronoi vertex

In the segment Voronoi diagram each polygon **edge** and each polygon **corner** is a site. Two edges meeting at a corner are both zero distance from that corner, so the corner is itself a Voronoi vertex — which is why `voronoi()` can hand its provenance straight back to you via `source`.

## Building from source

You only need this if you're changing the C++; the prebuilt wasm is committed.

Requirements: [Emscripten](https://emscripten.org/) (`emcc` on `PATH`), plus CGAL and Boost headers (`brew install cgal boost`).

```sh
npm run build:wasm   # cpp/voronoi.cpp -> src/core/voronoi.js (single-file ESM)
npm run build        # bundle the TS API + wasm -> dist/voron8.js (+ .d.ts)
npm run build:all    # both
npm test
```

Override header locations with `CGAL_INCLUDE_DIR` / `BOOST_INCLUDE_DIR` if they aren't in Homebrew's default prefix.

### Why the exact kernel (and not CGAL's recommended filtered traits)

CGAL's own examples use filtered traits (`EPICK`/`EPECK`), which rely on interval arithmetic for speed. But interval arithmetic needs to switch the CPU's floating-point **rounding mode**, and **WebAssembly cannot set the rounding mode** — making those predicates unsound here. voron8 therefore uses a pure exact rational kernel, `Simple_cartesian<Quotient<MP_Float>>` with `Field_tag` traits: slower, but correct and deterministic in the browser. Insertion still uses CGAL's spatial-sorted `insert_segments`, which recovers much of the lost speed by improving locality.

## License

MIT (this wrapper). Note that CGAL itself is distributed under GPL/LGPL terms; the compiled wasm links CGAL's headers, so your use of the wasm artifact is subject to CGAL's licensing.
