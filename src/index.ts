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

export interface VoronoiEdge {
  /** Index into `vertices` of one endpoint, or -1 if that endpoint is at infinity. */
  from: number;
  /** Index into `vertices` of the other endpoint, or -1 if at infinity. */
  to: number;
  /** Position relative to the even-odd filled input region. */
  location: "interior" | "exterior";
  geometry: EdgeGeometry;
}

export interface VoronoiResult {
  vertices: VoronoiVertex[];
  edges: VoronoiEdge[];
}

type WasmModule = {
  computeVoronoi: (coords: number[], ringSizes: number[]) => {
    vertices: VoronoiVertex[];
    edges: any[];
  };
};

let modulePromise: Promise<WasmModule> | null = null;

/**
 * Load and cache the WebAssembly module. Optional to call — voronoi() awaits it
 * automatically — but useful to warm up the wasm ahead of time.
 */
export function init(): Promise<WasmModule> {
  if (!modulePromise) {
    modulePromise = createVoron8Module() as Promise<WasmModule>;
  }
  return modulePromise;
}

function toXY(p: Point | [number, number]): [number, number] {
  return Array.isArray(p) ? [p[0], p[1]] : [p.x, p.y];
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
 * @param polygons Array of rings. Each ring is a list of points ({x,y} or
 *                 [x,y]); rings are treated as closed. Nested rings act as holes
 *                 under the even-odd fill rule used for interior/exterior labels.
 */
export async function voronoi(polygons: Polygon[]): Promise<VoronoiResult> {
  const mod = await init();

  const coords: number[] = [];
  const ringSizes: number[] = [];
  const rings: Array<Array<[number, number]>> = [];

  for (const poly of polygons) {
    const ring: Array<[number, number]> = [];
    for (const pt of poly as Array<Point | [number, number]>) {
      const [x, y] = toXY(pt);
      coords.push(x, y);
      ring.push([x, y]);
    }
    ringSizes.push(ring.length);
    rings.push(ring);
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

    return { from: e.from, to: e.to, location, geometry };
  });

  return { vertices: raw.vertices, edges };
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
