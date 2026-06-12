// voron8 — CGAL Segment Voronoi diagram of polygons, compiled to WebAssembly.
//
// Kernel choice (see README "Why a filtered kernel on WASM"): WebAssembly has no
// instruction to change the FPU rounding mode — every op rounds to nearest — so
// CGAL's interval-arithmetic filter (Interval_nt, used by every filtered/lazy
// kernel) would normally be UNSOUND here: it relies on directed rounding to make
// its bounds rigorous. CGAL anticipates exactly this case with the
// CGAL_ALWAYS_ROUND_TO_NEAREST build flag, which makes Interval_nt compute in
// round-to-nearest and then widen each bound outward by one ULP (via nextafter).
// The bounds stay rigorous, just slightly looser (a few more exact fallbacks).
//
// With that flag set (see scripts/build-wasm.sh) we use the *filtered* segment
// Delaunay traits: predicates resolve in fast double intervals and fall back to an
// exact Quotient<MP_Float> kernel (GMP-free) only on genuinely close cases. This is
// ~50x faster than the previous pure-exact kernel while producing identical
// topology; constructions are in double (machine-epsilon coordinate accuracy).
// Input-corner coincidence still matches exactly because the dual of a corner face
// is constructed as the corner point itself.

#include <CGAL/Simple_cartesian.h>
#include <CGAL/Quotient.h>
#include <CGAL/MP_Float.h>
#include <CGAL/Segment_Delaunay_graph_2.h>
#include <CGAL/Segment_Delaunay_graph_filtered_traits_2.h>
#include <CGAL/Parabola_segment_2.h>

#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <map>
#include <vector>
#include <utility>

// Construction kernel: double (fast, machine-epsilon coordinates). The filtered
// traits supplies its own interval filter (FK) and exact fallback (EK defaults to
// Simple_cartesian<Quotient<MP_Float>> under -DCGAL_DISABLE_GMP).
typedef double                                                      NT;
typedef CGAL::Simple_cartesian<double>                              CK;
typedef CGAL::Segment_Delaunay_graph_filtered_traits_2<CK>          Gt;
typedef CGAL::Segment_Delaunay_graph_2<Gt>                          SDG;

typedef SDG::Point_2       Point_2;
typedef SDG::Face_handle   Face_handle;
typedef SDG::Vertex_handle Vertex_handle;
typedef SDG::Edge          Edge;
typedef SDG::Site_2        Site_2;

typedef Gt::Line_2    Line_2;
typedef Gt::Segment_2 Segment_2;
typedef Gt::Ray_2     Ray_2;

namespace {

double to_double(const NT& n) { return CGAL::to_double(n); }

// Lexicographic comparator so input points can live in a std::map for O(log n)
// coincidence lookup against computed Voronoi vertices, using exact comparison.
struct PointLess {
  bool operator()(const Point_2& a, const Point_2& b) const {
    return CGAL::compare_xy(a, b) == CGAL::SMALLER;
  }
};

emscripten::val point_val(const Point_2& p) {
  emscripten::val o = emscripten::val::object();
  o.set("x", to_double(p.x()));
  o.set("y", to_double(p.y()));
  return o;
}

} // namespace

// coords:    flat [x0,y0,x1,y1,...] of every ring vertex, rings concatenated.
// ringSizes: vertex count of each ring, in order.
// Rings are treated as closed (last vertex connects back to the first).
emscripten::val compute_voronoi(emscripten::val coordsVal, emscripten::val ringSizesVal) {
  const std::vector<double> coords =
      emscripten::convertJSArrayToNumberVector<double>(coordsVal);
  const std::vector<int> ringSizes =
      emscripten::convertJSArrayToNumberVector<int>(ringSizesVal);

  // Build the point list plus a (polygon, vertex) provenance entry for each point,
  // and the closed-ring edge index pairs that insert_segments consumes.
  std::vector<Point_2> points;
  std::vector<std::pair<int, int>> provenance;  // (polygon index, vertex index)
  std::vector<std::pair<std::size_t, std::size_t>> indices;

  std::size_t cursor = 0;  // index into coords (advances by 2 per vertex)
  for (int poly = 0; poly < static_cast<int>(ringSizes.size()); ++poly) {
    const int n = ringSizes[poly];
    if (n <= 0) continue;
    const std::size_t base = points.size();
    for (int v = 0; v < n; ++v) {
      points.emplace_back(coords[cursor], coords[cursor + 1]);
      provenance.emplace_back(poly, v);
      cursor += 2;
    }
    for (int v = 0; v < n; ++v) {
      indices.emplace_back(base + v, base + (v + 1) % n);
    }
  }

  // Map every input point to its provenance for later coincidence testing.
  std::map<Point_2, std::pair<int, int>, PointLess> inputIndex;
  for (std::size_t i = 0; i < points.size(); ++i) {
    inputIndex.emplace(points[i], provenance[i]);
  }

  SDG sdg;
  // insert_segments spatial-sorts internally before insertion — the speedup the
  // CGAL "fast-sp-polygon" example demonstrates.
  if (!indices.empty()) {
    sdg.insert_segments(points, indices.begin(), indices.end());
  }

  // --- Voronoi vertices: one per finite face of the Delaunay graph. ---
  std::map<Face_handle, int> faceIndex;
  emscripten::val vertices = emscripten::val::array();
  int vIdx = 0;
  for (auto fit = sdg.finite_faces_begin(); fit != sdg.finite_faces_end(); ++fit) {
    Face_handle f = fit;
    const Point_2 vp = sdg.primal(f);
    emscripten::val v = point_val(vp);

    auto hit = inputIndex.find(vp);
    if (hit != inputIndex.end()) {
      v.set("isInput", true);
      emscripten::val src = emscripten::val::object();
      src.set("polygon", hit->second.first);
      src.set("vertex", hit->second.second);
      v.set("source", src);
    } else {
      v.set("isInput", false);
      v.set("source", emscripten::val::null());
    }

    faceIndex[f] = vIdx;
    vertices.set(vIdx, v);
    ++vIdx;
  }

  // --- Voronoi edges: the dual of each finite Delaunay edge. ---
  // A Voronoi edge is the bisector of the two sites sitting across it; those are
  // the ccw/cw vertices of the Delaunay edge. We report each so callers can,
  // e.g., drop bisectors defined by a reflex vertex when extracting a medial axis.
  // Map a point back to its input {polygon, vertex}, or null if it isn't an
  // input corner (e.g. a segment-intersection point).
  auto vref = [&](const Point_2& p) -> emscripten::val {
    auto hit = inputIndex.find(p);
    if (hit == inputIndex.end()) return emscripten::val::null();
    emscripten::val r = emscripten::val::object();
    r.set("polygon", hit->second.first);
    r.set("vertex", hit->second.second);
    return r;
  };

  auto describe_site = [&](Vertex_handle v) {
    emscripten::val s = emscripten::val::object();
    if (sdg.is_infinite(v)) {
      s.set("type", std::string("infinite"));
      s.set("source", emscripten::val::null());
      s.set("segment", emscripten::val::null());
      return s;
    }
    const Site_2 site = v->site();
    if (site.is_point()) {
      s.set("type", std::string("point"));
      s.set("source", vref(site.point()));
      s.set("segment", emscripten::val::null());
    } else {
      // Report the segment's endpoint provenance so callers can test whether a
      // point site is incident to this segment (an adjacency that produces a
      // spurious, non-medial bisector).
      s.set("type", std::string("segment"));
      s.set("source", emscripten::val::null());
      emscripten::val seg = emscripten::val::array();
      seg.set(0, vref(site.source()));
      seg.set(1, vref(site.target()));
      s.set("segment", seg);
    }
    return s;
  };

  emscripten::val edges = emscripten::val::array();
  int eIdx = 0;
  for (auto eit = sdg.finite_edges_begin(); eit != sdg.finite_edges_end(); ++eit) {
    Edge e = *eit;
    Face_handle f1 = e.first;
    Face_handle f2 = e.first->neighbor(e.second);

    emscripten::val edge = emscripten::val::object();
    auto i1 = faceIndex.find(f1);
    auto i2 = faceIndex.find(f2);
    edge.set("from", sdg.is_infinite(f1) || i1 == faceIndex.end() ? -1 : i1->second);
    edge.set("to",   sdg.is_infinite(f2) || i2 == faceIndex.end() ? -1 : i2->second);

    emscripten::val sites = emscripten::val::array();
    sites.set(0, describe_site(e.first->vertex(sdg.ccw(e.second))));
    sites.set(1, describe_site(e.first->vertex(sdg.cw(e.second))));
    edge.set("sites", sites);

    CGAL::Object o = sdg.primal(e);

    Segment_2 seg;
    Ray_2 ray;
    Line_2 line;
    CGAL::Parabola_segment_2<Gt> parc;

    if (CGAL::assign(seg, o)) {
      edge.set("type", std::string("segment"));
      edge.set("source", point_val(seg.source()));
      edge.set("target", point_val(seg.target()));
    } else if (CGAL::assign(ray, o)) {
      edge.set("type", std::string("ray"));
      edge.set("source", point_val(ray.source()));
      auto dir = ray.to_vector();
      emscripten::val d = emscripten::val::object();
      d.set("x", to_double(dir.x()));
      d.set("y", to_double(dir.y()));
      edge.set("direction", d);
    } else if (CGAL::assign(parc, o)) {
      edge.set("type", std::string("parabola"));
      edge.set("focus", point_val(parc.center()));
      const Line_2& dl = parc.line();
      emscripten::val dir = emscripten::val::object();
      dir.set("a", to_double(dl.a()));
      dir.set("b", to_double(dl.b()));
      dir.set("c", to_double(dl.c()));
      edge.set("directrix", dir);
      edge.set("source", point_val(parc.p1));
      edge.set("target", point_val(parc.p2));
    } else if (CGAL::assign(line, o)) {
      edge.set("type", std::string("line"));
      auto p = line.point(0);
      auto dir = line.to_vector();
      edge.set("point", point_val(p));
      emscripten::val d = emscripten::val::object();
      d.set("x", to_double(dir.x()));
      d.set("y", to_double(dir.y()));
      edge.set("direction", d);
    } else {
      continue;  // unknown primal geometry — skip defensively
    }

    edges.set(eIdx, edge);
    ++eIdx;
  }

  emscripten::val result = emscripten::val::object();
  result.set("vertices", vertices);
  result.set("edges", edges);
  return result;
}

EMSCRIPTEN_BINDINGS(voron8) {
  emscripten::function("computeVoronoi", &compute_voronoi);
}
