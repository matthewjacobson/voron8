# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[3.0.0]: https://github.com/matthewjacobson/voron8/compare/v2.0.3...v3.0.0
[2.0.3]: https://github.com/matthewjacobson/voron8/compare/v2.0.2...v2.0.3
[2.0.2]: https://github.com/matthewjacobson/voron8/compare/v2.0.1...v2.0.2
[2.0.1]: https://github.com/matthewjacobson/voron8/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/matthewjacobson/voron8/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/matthewjacobson/voron8/releases/tag/v1.0.0
