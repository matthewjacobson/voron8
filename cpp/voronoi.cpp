// voron8 — CGAL Segment Voronoi diagram of polygons, compiled to WebAssembly.
//
// Kernel choice (see README "Why the exact kernel"): WebAssembly cannot set the
// FPU rounding mode, which makes CGAL's interval-arithmetic filtered predicates
// (EPICK/EPECK, the kernels CGAL's own examples recommend) unsound here. We use a
// pure exact rational kernel instead — correct and deterministic on wasm, at the
// cost of speed. Spatial sorting (built into insert_segments) recovers a lot of
// that speed by improving insertion locality.

#include <CGAL/Simple_cartesian.h>
#include <CGAL/Quotient.h>
#include <CGAL/MP_Float.h>
#include <CGAL/Segment_Delaunay_graph_2.h>
#include <CGAL/Segment_Delaunay_graph_traits_2.h>
#include <CGAL/Parabola_segment_2.h>

#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <map>
#include <vector>
#include <utility>

typedef CGAL::Quotient<CGAL::MP_Float>                              NT;
typedef CGAL::Simple_cartesian<NT>                                  K;
// Non-filtered traits with Field_tag: no sqrt required, no interval arithmetic.
typedef CGAL::Segment_Delaunay_graph_traits_2<K, CGAL::Field_tag>   Gt;
typedef CGAL::Segment_Delaunay_graph_2<Gt>                          SDG;

typedef SDG::Point_2     Point_2;
typedef SDG::Face_handle Face_handle;
typedef SDG::Edge        Edge;

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
