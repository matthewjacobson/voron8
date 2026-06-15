// voron8 — public API.
//
// voronoi(polygons) builds the CGAL segment Voronoi diagram of the polygon
// edges and returns a graph of vertices and edges. Each edge is labeled
// "interior" or "exterior" w.r.t. the even-odd filled region of the input, and
// each vertex that coincides with an original polygon corner is traced back to
// its { polygon, vertex } source. tessellate() turns any edge — including the
// curved parabolic bisectors — into a polyline.

// @ts-ignore — generated single-file Emscripten ESM module (no types).
import createVoron8Module from "./core/voronoi.js";

export interface Point {
  x: number;
  y: number;
}

/** A ring of vertices. Treated as closed: the last point connects to the first. */
export type Polygon = Point[] | Array<[number, number]>;

export interface VoronoiVertex extends Point {
  /** True if this Voronoi vertex coincides with an input polygon corner. */
  isInput: boolean;
  /** Provenance when isInput; null otherwise. */
  source: { polygon: number; vertex: number } | null;
}

/** A straight finite bisector between two sites. */
export interface SegmentGeometry {
  type: "segment";
  source: Point;
  target: Point;
}

/** A semi-infinite bisector. Extends from `source` along `direction` forever. */
export interface RayGeometry {
  type: "ray";
  source: Point;
  direction: Point;
}

/** A doubly-infinite bisector (rare; two parallel-supporting sites). */
export interface LineGeometry {
  type: "line";
  point: Point;
  direction: Point;
}

/**
 * A parabolic-arc bisector between a point site (the `focus`) and a segment
 * site (whose supporting line is the `directrix`, given as ax + by + c = 0).
 * The arc runs between `source` and `target`.
 */
export interface ParabolaGeometry {
  type: "parabola";
  focus: Point;
  directrix: { a: number; b: number; c: number };
  source: Point;
  target: Point;
}

export type EdgeGeometry =
  | SegmentGeometry
  | RayGeometry
  | LineGeometry
  | ParabolaGeometry;

/** A reference back to an original polygon vertex. */
export interface VertexRef {
  polygon: number;
  vertex: number;
}

/**
 * One of the two input sites whose bisector an edge is.
 * - `point`: `source` is its `{ polygon, vertex }` when it is an original
 *   polygon corner (null for e.g. a segment-intersection point).
 * - `segment`: `segment` holds the provenance of its two endpoints (each a
 *   `VertexRef` or null), so callers can test incidence with a point site.
 * - `infinite`: the site at infinity; both fields are null.
 */
export interface SiteRef {
  type: "point" | "segment" | "infinite";
  source: VertexRef | null;
  segment: [VertexRef | null, VertexRef | null] | null;
}

export interface VoronoiEdge {
  /** Index into `vertices` of one endpoint, or -1 if that endpoint is at infinity. */
  from: number;
  /** Index into `vertices` of the other endpoint, or -1 if at infinity. */
  to: number;
  /** Position relative to the even-odd filled input region. */
  location: "interior" | "exterior";
  /** The two sites this edge bisects. */
  sites: [SiteRef, SiteRef];
  geometry: EdgeGeometry;
}

export interface VoronoiResult {
  vertices: VoronoiVertex[];
  edges: VoronoiEdge[];
}

type WasmModule = {
  computeVoronoi: (coords: number[], ringSizes: number[]) => {
    vertices: VoronoiVertex[];
    edges: Array<{ sites: [SiteRef, SiteRef] } & Record<string, any>>;
  };
};

let modulePromise: Promise<WasmModule> | null = null;
let wasmModule: WasmModule | null = null;

/**
 * Load and cache the WebAssembly module. This is the only asynchronous step;
 * await it once before calling voronoi()/medialAxis(), which are synchronous.
 * Calling it again returns the same cached module.
 */
export function init(): Promise<WasmModule> {
  if (!modulePromise) {
    modulePromise = (createVoron8Module() as Promise<WasmModule>).then((mod) => {
      wasmModule = mod;
      return mod;
    });
  }
  return modulePromise;
}

/** Return the loaded module, or throw if init() has not completed yet. */
function getModule(): WasmModule {
  if (!wasmModule) {
    throw new Error(
      "voron8: wasm not initialized — await init() once before calling voronoi() or medialAxis().",
    );
  }
  return wasmModule;
}

function toXY(p: Point | [number, number]): [number, number] {
  return Array.isArray(p) ? [p[0], p[1]] : [p.x, p.y];
}

function toRing(poly: Polygon): Array<[number, number]> {
  return (poly as Array<Point | [number, number]>).map(toXY);
}

/**
 * Even-odd point-in-region test against the union of all input rings. A point
 * inside an odd number of rings is "filled" — so nested rings act as holes.
 */
function insideFilledRegion(
  px: number,
  py: number,
  rings: Array<Array<[number, number]>>,
): boolean {
  let inside = false;
  for (const ring of rings) {
    const n = ring.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      const intersects =
        yi > py !== yj > py &&
        px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
      if (intersects) inside = !inside;
    }
  }
  return inside;
}

function sameVertex(a: VertexRef | null, b: VertexRef | null): boolean {
  return a !== null && b !== null && a.polygon === b.polygon && a.vertex === b.vertex;
}

/**
 * True when an edge's bisector is between a point site and a segment site that
 * is incident to that point (the point is an endpoint of the segment). Such a
 * bisector is the perpendicular at a polygon vertex and touches the boundary at
 * only that one point, so it is degenerate — not part of the medial axis.
 */
function isIncidentBisector(edge: VoronoiEdge): boolean {
  const incident = (pt: SiteRef, seg: SiteRef) =>
    pt.type === "point" &&
    seg.type === "segment" &&
    seg.segment !== null &&
    (sameVertex(pt.source, seg.segment[0]) || sameVertex(pt.source, seg.segment[1]));
  const [a, b] = edge.sites;
  return incident(a, b) || incident(b, a);
}

/** Representative interior point used to classify a bounded edge. */
function sampleOf(geom: EdgeGeometry): Point | null {
  switch (geom.type) {
    case "segment":
    case "parabola":
      return {
        x: (geom.source.x + geom.target.x) / 2,
        y: (geom.source.y + geom.target.y) / 2,
      };
    // Unbounded edges escape every bounded filled region → always exterior.
    case "ray":
    case "line":
      return null;
  }
}

/**
 * Compute the segment Voronoi diagram of one or more polygons.
 *
 * Synchronous: await init() once before calling this (it throws otherwise).
 *
 * @param polygons Array of rings. Each ring is a list of points ({x,y} or
 *                 [x,y]); rings are treated as closed. Nested rings act as holes
 *                 under the even-odd fill rule used for interior/exterior labels.
 */
export function voronoi(polygons: Polygon[]): VoronoiResult {
  const mod = getModule();

  const coords: number[] = [];
  const ringSizes: number[] = [];
  const rings = polygons.map(toRing);

  for (const ring of rings) {
    for (const [x, y] of ring) coords.push(x, y);
    ringSizes.push(ring.length);
  }

  const raw = mod.computeVoronoi(coords, ringSizes);

  const edges: VoronoiEdge[] = raw.edges.map((e: any) => {
    let geometry: EdgeGeometry;
    switch (e.type) {
      case "segment":
        geometry = { type: "segment", source: e.source, target: e.target };
        break;
      case "ray":
        geometry = { type: "ray", source: e.source, direction: e.direction };
        break;
      case "line":
        geometry = { type: "line", point: e.point, direction: e.direction };
        break;
      case "parabola":
        geometry = {
          type: "parabola",
          focus: e.focus,
          directrix: e.directrix,
          source: e.source,
          target: e.target,
        };
        break;
      default:
        throw new Error(`voron8: unknown edge geometry "${e.type}"`);
    }

    const sample = sampleOf(geometry);
    const location =
      sample && insideFilledRegion(sample.x, sample.y, rings)
        ? "interior"
        : "exterior";

    return { from: e.from, to: e.to, location, sites: e.sites, geometry };
  });

  return { vertices: raw.vertices, edges };
}

/**
 * The interior medial axis of the filled input region.
 *
 * The medial axis is every interior Voronoi edge *except* the degenerate
 * bisectors between a polygon vertex and one of its own incident edges. Because
 * CGAL treats each segment endpoint as its own site, those incident pairs
 * produce perpendicular bisectors that touch the boundary at a single point and
 * are not part of the skeleton. Everything else — including the parabolic arcs
 * between a reflex vertex and the wall facing it, and bisectors between two
 * reflex vertices — is genuine medial axis and is kept.
 *
 * Returns the same `vertices` as `voronoi()` (so edge `from`/`to` indices stay
 * valid) with `edges` narrowed to the medial axis.
 *
 * Synchronous: await init() once before calling this (it throws otherwise).
 *
 * @see https://stackoverflow.com/questions/69237154 (Richard's CGAL answer)
 */
export function medialAxis(polygons: Polygon[]): VoronoiResult {
  const result = voronoi(polygons);
  const edges = result.edges.filter(
    (e) => e.location === "interior" && !isIncidentBisector(e),
  );
  return { vertices: result.vertices, edges };
}

export interface TessellateOptions {
  /** Points sampled along a parabolic arc, inclusive of endpoints. Default 16. */
  parabolaSamples?: number;
  /** Finite length used when extruding an unbounded ray or line. Default 1e4. */
  infiniteLength?: number;
}

/**
 * Convert any edge geometry to a polyline (a list of points). Straight edges
 * return their endpoints; parabolic arcs are sampled exactly along the curve;
 * unbounded rays/lines are extruded to a finite length.
 */
export function tessellate(
  geom: EdgeGeometry,
  options: TessellateOptions = {},
): Point[] {
  const samples = Math.max(2, options.parabolaSamples ?? 16);
  const far = options.infiniteLength ?? 1e4;

  switch (geom.type) {
    case "segment":
      return [geom.source, geom.target];

    case "ray": {
      const len = Math.hypot(geom.direction.x, geom.direction.y) || 1;
      return [
        geom.source,
        {
          x: geom.source.x + (geom.direction.x / len) * far,
          y: geom.source.y + (geom.direction.y / len) * far,
        },
      ];
    }

    case "line": {
      const len = Math.hypot(geom.direction.x, geom.direction.y) || 1;
      const ux = geom.direction.x / len;
      const uy = geom.direction.y / len;
      return [
        { x: geom.point.x - ux * far, y: geom.point.y - uy * far },
        { x: geom.point.x + ux * far, y: geom.point.y + uy * far },
      ];
    }

    case "parabola":
      return sampleParabola(geom, samples);
  }
}

/**
 * Sample a parabolic bisector between `source` and `target`. In a frame whose
 * u-axis is parallel to the directrix and n-axis is its normal (signed so that
 * the focus's distance is positive), a parabola point at u-offset α from the
 * focus has n-offset β = (α² − δ²) / (2δ), where δ is the focus's signed
 * distance to the directrix. We march α linearly from the source's to the
 * target's projection.
 */
function sampleParabola(geom: ParabolaGeometry, samples: number): Point[] {
  const { focus: F, directrix: L } = geom;
  const nlen = Math.hypot(L.a, L.b) || 1;
  // Unit normal (direction of increasing signed distance) and unit tangent.
  const nx = L.a / nlen;
  const ny = L.b / nlen;
  const ux = -ny;
  const uy = nx;

  // Signed distance of the focus to the directrix.
  const delta = (L.a * F.x + L.b * F.y + L.c) / nlen;
  if (delta === 0) {
    // Degenerate (focus on directrix) — fall back to the chord.
    return [geom.source, geom.target];
  }

  const proj = (p: Point) => (p.x - F.x) * ux + (p.y - F.y) * uy;
  const a0 = proj(geom.source);
  const a1 = proj(geom.target);

  const pts: Point[] = [];
  for (let i = 0; i < samples; i++) {
    const alpha = a0 + ((a1 - a0) * i) / (samples - 1);
    const beta = (alpha * alpha - delta * delta) / (2 * delta);
    pts.push({
      x: F.x + alpha * ux + beta * nx,
      y: F.y + alpha * uy + beta * ny,
    });
  }
  return pts;
}
