# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[2.0.3]: https://github.com/matthewjacobson/voron8/compare/v2.0.2...v2.0.3
[2.0.2]: https://github.com/matthewjacobson/voron8/compare/v2.0.1...v2.0.2
[2.0.1]: https://github.com/matthewjacobson/voron8/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/matthewjacobson/voron8/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/matthewjacobson/voron8/releases/tag/v1.0.0
