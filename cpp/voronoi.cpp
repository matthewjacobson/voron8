// voron8 — CGAL Segment Voronoi diagram of points, segments, and polygons,
// compiled to WebAssembly.
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
//
// Two traits variants are compiled and exposed (see EMSCRIPTEN_BINDINGS at the
// bottom). The DEFAULT `computeVoronoi` uses the *with-intersections* traits:
// crossing/overlapping input segments Just Work because CGAL constructs each
// intersection point and inserts it as a new site. That robustness is costly,
// though — every crossing forces an exact-kernel construction plus a cluster of
// exact-fallback predicates around it (~17ms per crossing on WASM, where the exact
// kernel is the GMP-free MP_Float), so input with many mutually-crossing segments
// degrades toward quadratic time. `computeVoronoiNoIntersections` uses the
// *without-intersections* traits: it has no intersection machinery at all (its
// exact fallback is a division-free MP_Float ring, the configuration that variant
// is designed around), so it is markedly faster — but the caller must guarantee
// the input segments do not cross or overlap, or CGAL's preconditions fail.

#include <CGAL/Simple_cartesian.h>
#include <CGAL/Quotient.h>
#include <CGAL/MP_Float.h>
#include <CGAL/Segment_Delaunay_graph_2.h>
#include <CGAL/Segment_Delaunay_graph_filtered_traits_2.h>
#include <CGAL/Parabola_segment_2.h>
#include <CGAL/Voronoi_diagram_2.h>
#include <CGAL/Segment_Delaunay_graph_adaptation_traits_2.h>
#include <CGAL/Segment_Delaunay_graph_adaptation_policies_2.h>

#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <map>
#include <set>
#include <unordered_map>
#include <unordered_set>
#include <cstdint>
#include <vector>
#include <utility>
#include <queue>
#include <cmath>
#include <limits>
#include <algorithm>

// Construction kernel: double (fast, machine-epsilon coordinates). The filtered
// traits supplies its own interval filter (FK) and exact fallback (EK defaults to
// Simple_cartesian<Quotient<MP_Float>> under -DCGAL_DISABLE_GMP).
typedef double                                                      NT;
typedef CGAL::Simple_cartesian<double>                              CK;

// Geometry value types are the construction kernel's regardless of which traits
// variant is used, so the extraction helpers below stay traits-independent.
typedef CK::Point_2   Point_2;
typedef CK::Line_2    Line_2;
typedef CK::Segment_2 Segment_2;
typedef CK::Ray_2     Ray_2;

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

// Canonical key for an undirected Delaunay edge: the unordered pair of the two
// site vertices it separates (equivalently, the two sites of its dual Voronoi
// edge). Both representations of the edge — (f,i) and its mirror — map here to
// the same key, so a face's boundary halfedge can look up the emitted edge index
// via he->dual(). Vertex handles are stable for the lifetime of one call.
template <class SDG>
std::pair<const void*, const void*> edge_key(const SDG& sdg, const typename SDG::Edge& e) {
  const void* a = &*e.first->vertex(sdg.ccw(e.second));
  const void* b = &*e.first->vertex(sdg.cw(e.second));
  return a < b ? std::make_pair(a, b) : std::make_pair(b, a);
}

// Hash for edge_key()'s pointer pair, so the edge index map can be an
// unordered_map (O(1) lookups instead of O(log E)) — it is hit once per
// boundary halfedge across the faces and group emitters.
struct EdgeKeyHash {
  std::size_t operator()(const std::pair<const void*, const void*>& k) const {
    const std::size_t a = std::hash<const void*>()(k.first);
    const std::size_t b = std::hash<const void*>()(k.second);
    return a ^ (b + 0x9e3779b97f4a7c15ULL + (a << 6) + (a >> 2));
  }
};

// coords:    flat [x0,y0,x1,y1,...] of every ring vertex, rings concatenated.
// ringSizes: vertex count of each ring, in order. A size-1 ring is an isolated
//            point site; a size>=2 ring is a polyline/polygon.
// closed:    1 if the ring is a closed polygon (last vertex connects back to the
//            first), 0 if it is an open polyline or an isolated point.
// labels:    optional group label per ring (same order). When non-empty, the
//            result gains `faces`-style outlines of the union of each label's
//            cells (the compound-Voronoi territories). Empty = no grouping.
//
// Templated on the segment Delaunay traits `Gt` so the same body serves both the
// with- and without-intersections variants (see the two bindings below).
template <class Gt>
emscripten::val compute_voronoi_impl(emscripten::val coordsVal, emscripten::val ringSizesVal,
                                     emscripten::val closedVal, emscripten::val labelsVal) {
  typedef CGAL::Segment_Delaunay_graph_2<Gt>                              SDG;
  // Voronoi-diagram adaptor over the segment Delaunay graph. It presents the dual
  // directly as faces (one per site) with ordered boundary circulators, so the
  // cells need not be reassembled from the edge soup on the JS side. The
  // degeneracy-removal policy yields a clean diagram (no zero-length edges/merged
  // covertices).
  typedef CGAL::Segment_Delaunay_graph_adaptation_traits_2<SDG>           AT;
  typedef CGAL::Segment_Delaunay_graph_degeneracy_removal_policy_2<SDG>   AP;
  typedef CGAL::Voronoi_diagram_2<SDG, AT, AP>                            VD;

  typedef typename SDG::Face_handle   Face_handle;
  typedef typename SDG::Vertex_handle Vertex_handle;
  typedef typename SDG::Edge          Edge;
  typedef typename SDG::Site_2        Site_2;

  const std::vector<double> coords =
      emscripten::convertJSArrayToNumberVector<double>(coordsVal);
  const std::vector<int> ringSizes =
      emscripten::convertJSArrayToNumberVector<int>(ringSizesVal);
  const std::vector<int> closed =
      emscripten::convertJSArrayToNumberVector<int>(closedVal);
  const std::vector<int> labels =
      emscripten::convertJSArrayToNumberVector<int>(labelsVal);

  // Build the point list plus an (input, vertex) provenance entry for each point,
  // the edge index pairs that insert_segments consumes, and the isolated points
  // (rings of size 1) that have no incident edge and must be inserted directly.
  std::vector<Point_2> points;
  std::vector<std::pair<int, int>> provenance;  // (input index, vertex index)
  std::vector<std::pair<std::size_t, std::size_t>> indices;
  std::vector<std::size_t> lonePoints;

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
    if (n == 1) {
      // Isolated point: no edges; insert_segments would never see it.
      lonePoints.push_back(base);
      continue;
    }
    for (int v = 0; v + 1 < n; ++v) {
      indices.emplace_back(base + v, base + v + 1);
    }
    if (poly < static_cast<int>(closed.size()) && closed[poly]) {
      indices.emplace_back(base + (n - 1), base + 0);  // close the ring
    }
  }

  // Map every input point to its provenance for later coincidence testing.
  std::map<Point_2, std::pair<int, int>, PointLess> inputIndex;
  for (std::size_t i = 0; i < points.size(); ++i) {
    inputIndex.emplace(points[i], provenance[i]);
  }

  SDG sdg_build;
  // insert_segments spatial-sorts internally before insertion — the speedup the
  // CGAL "fast-sp-polygon" example demonstrates. It inserts each segment's two
  // endpoints as point sites too, so only truly isolated points need insert().
  if (!indices.empty()) {
    sdg_build.insert_segments(points, indices.begin(), indices.end());
  }
  for (std::size_t idx : lonePoints) {
    sdg_build.insert(points[idx]);
  }

  // Wrap the graph in the Voronoi adaptor (swap = move, leaving sdg_build empty)
  // and treat the adaptor's own dual graph as authoritative from here on. Edge
  // and vertex handles obtained below — and from face boundary halfedges — then
  // refer to the same graph instance, so edge_key lookups match.
  VD vd(sdg_build, true);
  const SDG& sdg = vd.dual();

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
      src.set("input", hit->second.first);
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
  // Map a point back to its input {input, vertex}, or null if it isn't an input
  // corner (e.g. a point where two segments cross, inserted by CGAL).
  auto vref = [&](const Point_2& p) -> emscripten::val {
    auto hit = inputIndex.find(p);
    if (hit == inputIndex.end()) return emscripten::val::null();
    emscripten::val r = emscripten::val::object();
    r.set("input", hit->second.first);
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

  // Maps an undirected Delaunay edge to its emitted index, so a face's boundary
  // halfedges (he->dual()) can reference edges[] instead of duplicating geometry.
  std::unordered_map<std::pair<const void*, const void*>, int, EdgeKeyHash> edgeIndex;

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

    edgeIndex[edge_key(sdg, e)] = eIdx;  // only for edges actually emitted
    edges.set(eIdx, edge);
    ++eIdx;
  }

  // --- Voronoi faces (cells): one per site, with an ordered boundary. ---
  // The adaptor gives each face's boundary as a CCW halfedge circulator, so we
  // emit each cell as its site plus the ordered list of edge indices bounding
  // it — no reassembly (edge bucketing, vertex chaining) needed downstream. For
  // an unbounded cell the boundary is an open arc: we break the cyclic ccb at
  // the vertex at infinity so boundary[0] and boundary[last] are its two rays.
  emscripten::val faces = emscripten::val::array();
  int fIdx = 0;
  for (auto fit = vd.faces_begin(); fit != vd.faces_end(); ++fit) {
    std::vector<typename VD::Halfedge_handle> hes;
    typename VD::Ccb_halfedge_circulator ccb = fit->ccb(), done = ccb;
    do { hes.push_back(ccb); } while (++ccb != done);

    bool unbounded = false;
    int startAt = 0;  // index of the halfedge emanating from infinity, if any
    for (std::size_t i = 0; i < hes.size(); ++i) {
      if (!hes[i]->has_source() || !hes[i]->has_target()) unbounded = true;
      if (!hes[i]->has_source()) startAt = static_cast<int>(i);
    }

    emscripten::val boundary = emscripten::val::array();
    int bIdx = 0;
    for (std::size_t k = 0; k < hes.size(); ++k) {
      typename VD::Halfedge_handle he = hes[(startAt + k) % hes.size()];
      auto hit = edgeIndex.find(edge_key(sdg, he->dual()));
      if (hit == edgeIndex.end()) continue;  // edge was skipped above — defensive
      boundary.set(bIdx++, hit->second);
    }

    emscripten::val face = emscripten::val::object();
    face.set("site", describe_site(fit->dual()));  // the cell's generating site
    face.set("unbounded", unbounded);
    face.set("boundary", boundary);
    faces.set(fIdx++, face);
  }

  // --- Compound-Voronoi groups: the outline of the union of each label's cells.
  // The union of a set of cells is a face of the *quotient* diagram, so its
  // boundary is reported exactly like a cell's: ordered edge indices (CCW), with
  // unbounded outlines opened at infinity. Only emitted when labels are given.
  emscripten::val groups = emscripten::val::array();
  if (!labels.empty()) {
    // Ring (input) index a site came from, or -1 for a synthesized crossing
    // point that has no input provenance.
    auto site_input = [&](Vertex_handle v) -> int {
      const Site_2 s = v->site();
      auto look = [&](const Point_2& p) -> int {
        auto h = inputIndex.find(p);
        return h == inputIndex.end() ? -1 : h->second.first;
      };
      if (s.is_point()) return look(s.point());
      const int i = look(s.source());
      return i >= 0 ? i : look(s.target());
    };

    // Dense internal group id per distinct caller label, so caller labels never
    // collide with the unique ids handed to unresolved crossing cells below.
    std::map<int, int> labelToId;
    std::vector<int> idToLabel;
    auto internOf = [&](int lbl) -> int {
      auto it = labelToId.find(lbl);
      if (it != labelToId.end()) return it->second;
      const int id = static_cast<int>(idToLabel.size());
      labelToId.emplace(lbl, id);
      idToLabel.push_back(lbl);
      return id;
    };

    // Label every cell. A VD face is identified by its site vertex (face->dual()
    // is stable), so we key by that. Cells whose site has an input take that
    // input's label; crossing-point cells start unlabeled (id -1).
    std::unordered_map<const void*, int> groupId;
    std::unordered_map<const void*, std::vector<const void*>> nbrs;  // unlabeled adjacency
    std::vector<const void*> unlabeled;
    for (auto fit = vd.faces_begin(); fit != vd.faces_end(); ++fit) {
      const int in = site_input(fit->dual());
      groupId[&*fit->dual()] = in >= 0 ? internOf(labels[in]) : -1;
    }
    for (auto fit = vd.faces_begin(); fit != vd.faces_end(); ++fit) {
      const void* key = &*fit->dual();
      if (groupId[key] != -1) continue;
      unlabeled.push_back(key);
      typename VD::Ccb_halfedge_circulator ccb = fit->ccb(), done = ccb;
      do { nbrs[key].push_back(&*ccb->opposite()->face()->dual()); } while (++ccb != done);
    }
    // Policy (b): an unlabeled (crossing) cell adopts label L when all of its
    // *labeled* neighbours agree on L; a cell straddling two labels stays
    // unlabeled (a genuine junction). Iterate to convergence so chains of
    // adjacent crossing cells resolve inward from their labeled borders.
    bool changed = true;
    while (changed) {
      changed = false;
      for (const void* f : unlabeled) {
        if (groupId[f] != -1) continue;
        int found = -1; bool conflict = false;
        for (const void* nb : nbrs[f]) {
          const int li = groupId[nb];
          if (li < 0) continue;
          if (found < 0) found = li; else if (found != li) conflict = true;
        }
        if (!conflict && found >= 0) { groupId[f] = found; changed = true; }
      }
    }
    // Any cell still unlabeled (a real multi-label junction) becomes its own
    // singleton group — a fresh id mapped to no caller label, so it is excluded
    // from every reported union (it shows as a sliver hole, which is correct).
    int nextId = static_cast<int>(idToLabel.size());
    for (const void* f : unlabeled) if (groupId[f] == -1) groupId[f] = nextId++;

    const int K = static_cast<int>(idToLabel.size());
    auto labelOf = [&](typename VD::Halfedge_handle h) { return groupId[&*h->face()->dual()]; };
    auto edgeOf = [&](typename VD::Halfedge_handle h) -> int {
      auto it = edgeIndex.find(edge_key(sdg, h->dual()));
      return it == edgeIndex.end() ? -1 : it->second;
    };

    // Trace every group's outline in ONE pass, driven by faces + ccb circulators
    // (cheap — the same traversal the faces emitter uses) rather than the global
    // halfedge iterator with per-halfedge face/opposite navigation. A ccb
    // halfedge is on its face's group outline iff the bisector's *other* site
    // (he->up()/down(), avoiding opposite()->face()->dual()) is in a different
    // group; from there we walk the ring, turning into adjacent same-group cells.
    // Each (frontier edge, gid) pair is walked once (tracked in `seen`), so this
    // is O(E) regardless of the label count.
    std::vector<emscripten::val> groupRings(K);
    std::vector<int> ringCount(K, 0);
    for (int i = 0; i < K; ++i) groupRings[i] = emscripten::val::array();
    std::unordered_set<uint64_t> seen;  // key = edgeIndex * K + gid
    for (auto fit = vd.faces_begin(); fit != vd.faces_end(); ++fit) {
      auto sF = fit->dual();                         // this cell's site
      const int gid = groupId[&*sF];
      if (gid < 0 || gid >= K) continue;             // singleton/junction cells own no group
      typename VD::Ccb_halfedge_circulator ccb = fit->ccb(), done = ccb;
      do {
        typename VD::Halfedge_handle h = ccb;
        auto nb = (h->up() == sF) ? h->down() : h->up();  // neighbour cell's site
        if (groupId[&*nb] == gid) continue;          // interior edge, not a frontier
        const int e0 = edgeOf(h);
        if (e0 < 0) continue;                         // unreferenced edge — defensive
        if (!seen.insert(static_cast<uint64_t>(e0) * K + gid).second) continue;  // ring done

        std::vector<std::pair<typename VD::Halfedge_handle, int>> hs;  // (halfedge, edge index)
        typename VD::Halfedge_handle e = h;
        int guard = 0;
        do {
          const int ei = edgeOf(e);
          hs.emplace_back(e, ei);
          if (ei >= 0) seen.insert(static_cast<uint64_t>(ei) * K + gid);
          typename VD::Halfedge_handle n = e->next();
          while (labelOf(n->opposite()) == gid) n = n->opposite()->next();
          e = n;
        } while (e != h && ++guard < 1000000);

        // Open an unbounded outline at infinity, like a cell boundary, so its
        // two rays end up first and last.
        bool unbounded = false;
        int startAt = 0;
        for (std::size_t i = 0; i < hs.size(); ++i) {
          if (!hs[i].first->has_source() || !hs[i].first->has_target()) unbounded = true;
          if (!hs[i].first->has_source()) startAt = static_cast<int>(i);
        }
        emscripten::val boundary = emscripten::val::array();
        int bi = 0;
        for (std::size_t k = 0; k < hs.size(); ++k) {
          const int ei = hs[(startAt + k) % hs.size()].second;
          if (ei >= 0) boundary.set(bi++, ei);
        }

        emscripten::val r = emscripten::val::object();
        r.set("unbounded", unbounded);
        r.set("boundary", boundary);
        groupRings[gid].set(ringCount[gid]++, r);
      } while (++ccb != done);
    }
    for (int gid = 0; gid < K; ++gid) {
      emscripten::val g = emscripten::val::object();
      g.set("label", idToLabel[gid]);
      g.set("rings", groupRings[gid]);
      groups.set(gid, g);
    }
  }

  emscripten::val result = emscripten::val::object();
  result.set("vertices", vertices);
  result.set("edges", edges);
  result.set("faces", faces);
  result.set("groups", groups);
  return result;
}

// The two traits variants. The filtered traits already supports intersecting
// segments (it is the WITH-intersections variant); the without-intersections
// sibling drops that machinery for speed but requires intersection-free input.
typedef CGAL::Segment_Delaunay_graph_filtered_traits_2<CK>                       Gt_with;
typedef CGAL::Segment_Delaunay_graph_filtered_traits_without_intersections_2<CK> Gt_without;

emscripten::val compute_voronoi(emscripten::val coords, emscripten::val ringSizes,
                                emscripten::val closed, emscripten::val labels) {
  return compute_voronoi_impl<Gt_with>(coords, ringSizes, closed, labels);
}

emscripten::val compute_voronoi_no_intersections(emscripten::val coords, emscripten::val ringSizes,
                                                 emscripten::val closed, emscripten::val labels) {
  return compute_voronoi_impl<Gt_without>(coords, ringSizes, closed, labels);
}

// ===========================================================================
// Incremental medial-axis path finder.
//
// A stateful class over a *live* segment Delaunay graph. The polygon (with
// holes) is inserted once at construction; walls — segments the path may not
// cross — are inserted incrementally with addWall() (CGAL's insert() updates
// the graph in place, no rebuild). findPath() derives the interior medial axis
// from the current graph (rebuilt lazily, only when a wall has been added since
// the last query), connects the start/end points to it, and runs Dijkstra.
//
// The whole path finder lives in C++ so that adding a wall or routing a path
// never marshals the entire diagram across the JS boundary — only the final
// polyline is returned. The with-intersections traits is used so that walls
// which happen to cross each other or the boundary are handled robustly.
// ===========================================================================

typedef CGAL::Segment_Delaunay_graph_2<Gt_with> PF_SDG;

double sqdist(const Point_2& a, const Point_2& b) {
  const double dx = a.x() - b.x(), dy = a.y() - b.y();
  return dx * dx + dy * dy;
}

double polyline_len(const std::vector<Point_2>& poly) {
  double len = 0;
  for (std::size_t i = 0; i + 1 < poly.size(); ++i)
    len += std::sqrt(sqdist(poly[i], poly[i + 1]));
  return len;
}

// Even-odd point-in-region test over the polygon fill rings (holes are the
// even-nesting regions), matching insideFilledRegion() in the JS layer — but
// with the ring edges bucketed into horizontal bands, so a query tests only
// the edges whose y-span can cross its ray instead of every edge. Exact: an
// edge not spanning the query's y contributes nothing to the even-odd count,
// so skipping it cannot change the result. This test runs once per candidate
// medial edge on every rebuild, which made it the rebuild's dominant cost on
// large inputs when it scanned all rings.
class FillIndex {
 public:
  void build(const std::vector<std::vector<Point_2>>& rings) {
    double ymin = std::numeric_limits<double>::infinity(), ymax = -ymin;
    std::size_t edgeCount = 0;
    for (const auto& ring : rings) {
      if (ring.size() < 3) continue;
      edgeCount += ring.size();
      for (const auto& p : ring) { ymin = std::min(ymin, p.y()); ymax = std::max(ymax, p.y()); }
    }
    if (edgeCount == 0 || !(ymax > ymin)) { nbands_ = 0; return; }
    nbands_ = static_cast<int>(std::min<std::size_t>(edgeCount, 256));
    y0_ = ymin;
    dy_ = (ymax - ymin) / nbands_;
    bands_.assign(nbands_, {});
    for (const auto& ring : rings) {
      const std::size_t n = ring.size();
      if (n < 3) continue;
      for (std::size_t i = 0, j = n - 1; i < n; j = i++) {
        const int b0 = bandOf(std::min(ring[i].y(), ring[j].y()));
        const int b1 = bandOf(std::max(ring[i].y(), ring[j].y()));
        for (int b = b0; b <= b1; ++b) bands_[b].emplace_back(ring[j], ring[i]);
      }
    }
  }

  bool inside(double px, double py) const {
    if (nbands_ == 0) return false;
    if (py < y0_ || py > y0_ + dy_ * nbands_) return false;
    bool in = false;
    for (const auto& e : bands_[bandOf(py)]) {
      const double xi = e.second.x(), yi = e.second.y();
      const double xj = e.first.x(), yj = e.first.y();
      const bool crosses = ((yi > py) != (yj > py)) &&
                           (px < (xj - xi) * (py - yi) / (yj - yi) + xi);
      if (crosses) in = !in;
    }
    return in;
  }

 private:
  int bandOf(double y) const {
    int b = static_cast<int>((y - y0_) / dy_);
    if (b < 0) b = 0;
    if (b >= nbands_) b = nbands_ - 1;
    return b;
  }
  double y0_ = 0, dy_ = 1;
  int nbands_ = 0;
  std::vector<std::vector<std::pair<Point_2, Point_2>>> bands_;
};

// Sample a parabolic bisector between p1 and p2 into a polyline, using the same
// directrix-frame formula as the JS tessellate() (β = (α²−δ²)/(2δ)).
void sample_parabola(const Point_2& F, double la, double lb, double lc,
                     const Point_2& p1, const Point_2& p2, int samples,
                     std::vector<Point_2>& out) {
  double nlen = std::hypot(la, lb);
  if (nlen == 0) nlen = 1;
  const double nx = la / nlen, ny = lb / nlen;
  const double ux = -ny, uy = nx;
  const double Fx = F.x(), Fy = F.y();
  const double delta = (la * Fx + lb * Fy + lc) / nlen;
  if (delta == 0) { out.push_back(p1); out.push_back(p2); return; }
  auto proj = [&](const Point_2& p) { return (p.x() - Fx) * ux + (p.y() - Fy) * uy; };
  const double a0 = proj(p1), a1 = proj(p2);
  for (int i = 0; i < samples; ++i) {
    const double alpha = a0 + (a1 - a0) * i / (samples - 1);
    const double beta = (alpha * alpha - delta * delta) / (2 * delta);
    out.emplace_back(Fx + alpha * ux + beta * nx, Fy + alpha * uy + beta * ny);
  }
}

// True when open segments ab and cd properly cross (interiors intersect at a
// single point). Endpoint touching and collinear overlap return false, so a
// connector may reach a point that merely coincides with a wall endpoint.
// `tol` is an absolute distance: an endpoint within `tol` of the other
// segment's line counts as touching, not crossing. Callers construct points
// ON boundary edges (a fill lane's end, a portal midpoint on a cut) whose
// coordinates carry ~machine-epsilon residue off the exact line; without the
// tolerance that residue reads as a hair-width proper crossing of the very
// edge the point sits on.
bool segments_properly_cross(const Point_2& a, const Point_2& b,
                             const Point_2& c, const Point_2& d, double tol) {
  auto side = [](const Point_2& p, const Point_2& q, const Point_2& r) {
    return (q.x() - p.x()) * (r.y() - p.y()) - (q.y() - p.y()) * (r.x() - p.x());
  };
  const double d1 = side(c, d, a), d2 = side(c, d, b);
  const double d3 = side(a, b, c), d4 = side(a, b, d);
  if (!(d1 * d2 < 0 && d3 * d4 < 0)) return false;
  // side() magnitude = segment length x the point's distance from its line.
  const double tcd = std::hypot(d.x() - c.x(), d.y() - c.y()) * tol;
  const double tab = std::hypot(b.x() - a.x(), b.y() - a.y()) * tol;
  return std::min(std::abs(d1), std::abs(d2)) > tcd &&
         std::min(std::abs(d3), std::abs(d4)) > tab;
}

// Closest point on a polyline to (x,y): the projection q, the index of the
// segment it lies on, and the (squared) distance.
struct Proj { double d2; Point_2 q; int seg; };
Proj project_polyline(double x, double y, const std::vector<Point_2>& poly) {
  Proj best{std::numeric_limits<double>::infinity(), poly.empty() ? Point_2(x, y) : poly[0], 0};
  for (std::size_t i = 0; i + 1 < poly.size(); ++i) {
    const double ax = poly[i].x(), ay = poly[i].y();
    const double bx = poly[i + 1].x(), by = poly[i + 1].y();
    const double dx = bx - ax, dy = by - ay;
    const double len2 = dx * dx + dy * dy;
    double t = len2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / len2 : 0;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const double qx = ax + t * dx, qy = ay + t * dy;
    const double d2 = (x - qx) * (x - qx) + (y - qy) * (y - qy);
    if (d2 < best.d2) { best.d2 = d2; best.q = Point_2(qx, qy); best.seg = static_cast<int>(i); }
  }
  return best;
}

class MedialPathFinder {
 public:
  typedef PF_SDG::Face_handle    Face_handle;
  typedef PF_SDG::Vertex_handle  Vertex_handle;
  typedef PF_SDG::Edge           Edge;
  typedef PF_SDG::Edge_circulator Edge_circulator;
  typedef PF_SDG::Vertex_circulator Vertex_circulator;
  typedef PF_SDG::Site_2         Site_2;

  // coords/ringSizes describe the polygon exactly like computeVoronoi's inputs,
  // but every ring is a closed polygon (outer boundary plus holes). The rings
  // both seed the Delaunay graph and define the filled region for the interior
  // test that selects medial edges.
  MedialPathFinder(emscripten::val coordsVal, emscripten::val ringSizesVal) : dirty_(true) {
    const std::vector<double> coords =
        emscripten::convertJSArrayToNumberVector<double>(coordsVal);
    const std::vector<int> ringSizes =
        emscripten::convertJSArrayToNumberVector<int>(ringSizesVal);

    std::vector<Point_2> pts;
    std::vector<std::pair<std::size_t, std::size_t>> idx;
    std::size_t cursor = 0;
    for (int r = 0; r < static_cast<int>(ringSizes.size()); ++r) {
      const int n = ringSizes[r];
      if (n <= 0) continue;
      const std::size_t base = pts.size();
      std::vector<Point_2> ring;
      for (int v = 0; v < n; ++v) {
        Point_2 p(coords[cursor], coords[cursor + 1]);
        cursor += 2;
        pts.push_back(p);
        ring.push_back(p);
        boundaryVerts_.insert(p);  // polygon corners — where the axis touches the boundary
        scale_ = std::max(scale_, std::max(std::abs(p.x()), std::abs(p.y())));
      }
      fillRings_.push_back(ring);
      for (int v = 0; v + 1 < n; ++v) idx.emplace_back(base + v, base + v + 1);
      if (n >= 2) idx.emplace_back(base + (n - 1), base + 0);  // close the ring
      // Boundary edges join the walls as connector barriers: a straight
      // connector that properly crosses one leaves the region — near a narrow
      // notch it can reach a feature in a *different* pocket of the region
      // through the exterior, without crossing any wall.
      for (int v = 0; v < n; ++v)
        barriers_.emplace_back(ring[v], ring[(v + 1) % n]);
    }
    if (!idx.empty()) sdg_.insert_segments(pts, idx.begin(), idx.end());
    fillIndex_.build(fillRings_);
  }

  // Insert a wall segment the path may not cross. Incremental: the Delaunay
  // graph is updated in place; only the derived medial graph is invalidated.
  void addWall(double x1, double y1, double x2, double y2) {
    sdg_.insert(Point_2(x1, y1), Point_2(x2, y2));
    // Keep the wall segment so endpoint attachment can reject connectors that
    // would cross it (which would attach a point to the far side of the wall).
    barriers_.emplace_back(Point_2(x1, y1), Point_2(x2, y2));
    // A wall's endpoints are boundary corners just like the polygon's: the
    // Voronoi vertices sitting on them (clearance 0) anchor short stubs that
    // are not the skeleton's spine. Record them so endpoint attachment skips
    // those stubs in favour of the interior spine (see connectPoint / the
    // onBoundary_ preference), exactly as it does for polygon corners.
    boundaryVerts_.insert(Point_2(x1, y1));
    boundaryVerts_.insert(Point_2(x2, y2));
    scale_ = std::max({scale_, std::abs(x1), std::abs(y1), std::abs(x2), std::abs(y2)});
    dirty_ = true;
  }

  // Expose the derived medial graph for inspection/overlays: nodes with their
  // positions and boundary flag, edges as node-id pairs, plus every dropped
  // finite-face edge with the reason it was dropped.
  emscripten::val debugGraph() {
    if (dirty_) rebuild();
    emscripten::val out = emscripten::val::object();
    emscripten::val nodes = emscripten::val::array();
    for (std::size_t i = 0; i < nodePos_.size(); ++i) {
      emscripten::val n = point_val(nodePos_[i]);
      n.set("onBoundary", onBoundary_[i] != 0);
      nodes.set(static_cast<int>(i), n);
    }
    emscripten::val edges = emscripten::val::array();
    for (std::size_t i = 0; i < medialEdges_.size(); ++i) {
      emscripten::val e = emscripten::val::object();
      e.set("from", medialEdges_[i].from);
      e.set("to", medialEdges_[i].to);
      edges.set(static_cast<int>(i), e);
    }
    emscripten::val dropped = emscripten::val::array();
    int di = 0;
    for (auto eit = sdg_.finite_edges_begin(); eit != sdg_.finite_edges_end(); ++eit) {
      Edge e = *eit;
      Face_handle f1 = e.first;
      Face_handle f2 = e.first->neighbor(e.second);
      auto i1 = faceNode_.find(f1), i2 = faceNode_.find(f2);
      const char* reason = nullptr;
      Point_2 a(0, 0), b(0, 0);
      if (sdg_.is_infinite(f1) || sdg_.is_infinite(f2) ||
          i1 == faceNode_.end() || i2 == faceNode_.end()) {
        reason = "infinite-face";
      } else {
        a = nodePos_[i1->second];
        b = nodePos_[i2->second];
        if (i1->second == i2->second) reason = "merged-selfloop";
        else {
          CGAL::Object o = sdg_.primal(e);
          Segment_2 seg;
          CGAL::Parabola_segment_2<Gt_with> parc;
          std::vector<Point_2> poly;
          if (CGAL::assign(seg, o)) { poly.push_back(seg.source()); poly.push_back(seg.target()); }
          else if (CGAL::assign(parc, o)) {
            const Line_2& dl = parc.line();
            sample_parabola(parc.center(), to_double(dl.a()), to_double(dl.b()), to_double(dl.c()),
                            parc.p1, parc.p2, 16, poly);
          } else reason = "ray-line";
          if (!reason) {
            if (poly.size() < 2) reason = "short-poly";
            else {
              const std::size_t m = poly.size() / 2;
              const Point_2 mid((poly[m - 1].x() + poly[m].x()) / 2,
                                (poly[m - 1].y() + poly[m].y()) / 2);
              if (!fillIndex_.inside(mid.x(), mid.y())) reason = "exterior";
              else if (isIncident(e.first->vertex(sdg_.ccw(e.second)),
                                  e.first->vertex(sdg_.cw(e.second)))) reason = "incident";
            }
          }
        }
      }
      if (!reason) continue;
      emscripten::val d = emscripten::val::object();
      d.set("reason", std::string(reason));
      d.set("ax", to_double(a.x())); d.set("ay", to_double(a.y()));
      d.set("bx", to_double(b.x())); d.set("by", to_double(b.y()));
      dropped.set(di++, d);
    }
    out.set("nodes", nodes);
    out.set("edges", edges);
    out.set("dropped", dropped);
    return out;
  }

  // Route from (sx,sy) to (ex,ey) along the medial axis. Returns
  // { found, path: [{x,y}...], length }.
  emscripten::val findPath(double sx, double sy, double ex, double ey) {
    if (dirty_) rebuild();

    emscripten::val result = emscripten::val::object();
    emscripten::val path = emscripten::val::array();

    // Working graph = a copy of the cached medial adjacency, extended with the
    // temporary start/end/projection nodes and the connector edges.
    std::vector<std::vector<Adj>> g = adj_;
    std::vector<std::vector<Point_2>> tempPolys;

    std::map<int, EdgeAttach> attachS, attachE;
    bool okS = false, okE = false;
    const int S = connectPoint(sx, sy, g, tempPolys, attachS, okS);
    const int T = connectPoint(ex, ey, g, tempPolys, attachE, okE);

    if (!okS || !okE) {  // no medial axis to attach to
      result.set("found", false);
      result.set("path", path);
      result.set("length", 0.0);
      return result;
    }

    // Wherever both endpoints split the *same* medial edge, join their two
    // projection nodes directly by the sub-arc between them, so a short hop does
    // not detour out to a shared edge endpoint.
    for (const auto& [id, sa] : attachS) {
      auto it = attachE.find(id);
      if (it == attachE.end()) continue;
      std::vector<Point_2> arc;
      buildArc(medialEdges_[id].poly, sa.proj, it->second.proj, arc);
      addTemp(g, tempPolys, sa.q, it->second.q, arc, polyline_len(arc));
    }

    // Dijkstra from S to T over g.
    const int nodes = static_cast<int>(g.size());
    std::vector<double> dist(nodes, std::numeric_limits<double>::infinity());
    std::vector<int> prevNode(nodes, -1);
    std::vector<Adj> prevAdj(nodes);
    typedef std::pair<double, int> QN;
    std::priority_queue<QN, std::vector<QN>, std::greater<QN>> pq;
    dist[S] = 0;
    pq.push({0.0, S});
    while (!pq.empty()) {
      auto [d, u] = pq.top();
      pq.pop();
      if (d > dist[u]) continue;
      if (u == T) break;
      for (const Adj& a : g[u]) {
        const double nd = d + a.w;
        if (nd < dist[a.to]) {
          dist[a.to] = nd;
          prevNode[a.to] = u;
          prevAdj[a.to] = a;
          pq.push({nd, a.to});
        }
      }
    }

    if (!std::isfinite(dist[T])) {  // start and end separated by walls/holes
      result.set("found", false);
      result.set("path", path);
      result.set("length", 0.0);
      return result;
    }

    // Reconstruct the polyline: gather each edge oriented prev->cur, from T back
    // to S, then reverse and concatenate (dropping duplicated shared vertices).
    std::vector<std::vector<Point_2>> segs;
    for (int cur = T; cur != S; cur = prevNode[cur]) {
      const Adj& a = prevAdj[cur];
      std::vector<Point_2> poly;
      if (a.edgeId >= 0) {
        poly = medialEdges_[a.edgeId].poly;  // oriented from->to
        if (a.reversed) std::reverse(poly.begin(), poly.end());
      } else {
        poly = tempPolys[a.tempPoly];  // already oriented prev->cur
      }
      segs.push_back(std::move(poly));
    }
    std::reverse(segs.begin(), segs.end());

    int k = 0;
    for (const auto& seg : segs) {
      for (const Point_2& p : seg) {
        if (k > 0) {
          emscripten::val prev = path[k - 1];
          if (prev["x"].as<double>() == p.x() && prev["y"].as<double>() == p.y()) continue;
        }
        emscripten::val pv = emscripten::val::object();
        pv.set("x", to_double(p.x()));
        pv.set("y", to_double(p.y()));
        path.set(k++, pv);
      }
    }

    result.set("found", true);
    result.set("path", path);
    result.set("length", dist[T]);
    return result;
  }

 private:
  // A kept medial-axis edge: its two endpoint node ids and the polyline geometry
  // (oriented from `from` to `to`; a segment is two points, a parabola sampled).
  struct MEdge { int from, to; double weight; std::vector<Point_2> poly; };
  // A working-graph adjacency entry. For a cached medial edge, edgeId indexes
  // medialEdges_ and reversed says whether to flip its polyline for this
  // direction. For a temporary connector, edgeId is -1 and tempPoly indexes the
  // per-call polyline list (already oriented in this direction).
  struct Adj { int to; double w; int edgeId; bool reversed; int tempPoly; };

  // Rebuild the cached medial-axis graph from the current Delaunay graph. Nodes
  // are the finite Voronoi vertices (duals of finite faces); edges are the
  // interior, non-incident bisectors between them.
  void rebuild() {
    faceNode_.clear();
    nodePos_.clear();
    onBoundary_.clear();
    medialEdges_.clear();
    edgeLookup_.clear();
    adj_.clear();

    // A clearance-0 junction (a polygon corner, or a wall endpoint on a
    // boundary edge) is the dual of SEVERAL Delaunay faces, all constructed as
    // exactly the junction point. Keyed per face those coincident duals are
    // distinct nodes whose connecting zero-length Voronoi edges are dropped
    // below (no length, and their on-boundary midpoints fail the interior
    // test) — splitting the local axis into an island no path can leave (the
    // raw SDG has no degeneracy-removal policy, unlike computeVoronoi's
    // adaptor). But blanket merging by coordinate is wrong too: at a pinch
    // point the junction carries duals from BOTH sides of a wall, and fusing
    // them opens a zero-width passage through the pinch. So merge exactly
    // along the degenerate edges themselves: union two coincident duals when
    // their zero-length connecting edge's sites are NOT an incident
    // point-segment pair — incident bisectors are the walls'/edges' own
    // perpendiculars at the junction, i.e. the boundaries between the
    // junction's angular sectors, and must keep the sides apart.
    std::map<Face_handle, int> faceSlot;
    std::vector<Point_2> slotPos;
    for (auto fit = sdg_.finite_faces_begin(); fit != sdg_.finite_faces_end(); ++fit) {
      Face_handle f = fit;
      faceSlot[f] = static_cast<int>(slotPos.size());
      slotPos.push_back(sdg_.primal(f));
    }
    std::vector<int> parent(slotPos.size());
    for (std::size_t i = 0; i < parent.size(); ++i) parent[i] = static_cast<int>(i);
    auto findRoot = [&](int x) {
      while (parent[x] != x) x = parent[x] = parent[parent[x]];
      return x;
    };
    // Near-equality, not exact: duals at a radius-0 junction are constructed
    // as the corner point itself (bit-exact), but duals at a positive-radius
    // degeneracy (e.g. four cotangent sites where a collinear boundary vertex's
    // seam meets the axis) are independently computed circumcenters that agree
    // only to ~1e-12 of the coordinate scale.
    const double mergeTol = 1e-9 * scale_;
    const double mergeTol2 = mergeTol * mergeTol;
    for (auto eit = sdg_.finite_edges_begin(); eit != sdg_.finite_edges_end(); ++eit) {
      Edge e = *eit;
      Face_handle f1 = e.first;
      Face_handle f2 = e.first->neighbor(e.second);
      auto i1 = faceSlot.find(f1), i2 = faceSlot.find(f2);
      if (i1 == faceSlot.end() || i2 == faceSlot.end()) continue;
      const Point_2& p1 = slotPos[i1->second];
      const Point_2& p2 = slotPos[i2->second];
      if (sqdist(p1, p2) > mergeTol2) continue;  // not (near-)zero-length
      if (isIncident(e.first->vertex(sdg_.ccw(e.second)),
                     e.first->vertex(sdg_.cw(e.second))))
        continue;  // sector boundary at a pinch — keep the sides apart
      parent[findRoot(i1->second)] = findRoot(i2->second);
    }
    std::map<int, int> rootNode;
    for (auto& [f, slot] : faceSlot) {
      const int r = findRoot(slot);
      auto ins = rootNode.emplace(r, static_cast<int>(nodePos_.size()));
      if (ins.second) {
        const Point_2& vp = slotPos[r];
        nodePos_.push_back(vp);
        // A Voronoi vertex coincident with a polygon corner sits on the boundary
        // (clearance 0); its incident edges are the axis's boundary stubs. Endpoint
        // attachment prefers to skip these in favour of the interior "spine".
        onBoundary_.push_back(boundaryVerts_.count(vp) != 0 ? 1 : 0);
      }
      faceNode_[f] = ins.first->second;
    }
    adj_.resize(nodePos_.size());

    for (auto eit = sdg_.finite_edges_begin(); eit != sdg_.finite_edges_end(); ++eit) {
      Edge e = *eit;
      Face_handle f1 = e.first;
      Face_handle f2 = e.first->neighbor(e.second);
      auto i1 = faceNode_.find(f1), i2 = faceNode_.find(f2);
      // An edge with an endpoint at infinity is an unbounded ray/line — always
      // exterior, never part of the interior medial axis.
      if (sdg_.is_infinite(f1) || sdg_.is_infinite(f2) ||
          i1 == faceNode_.end() || i2 == faceNode_.end())
        continue;
      // Coincident duals merged into one node: their connecting edge is a
      // zero-length degeneracy, not a graph edge.
      if (i1->second == i2->second) continue;

      Vertex_handle va = e.first->vertex(sdg_.ccw(e.second));
      Vertex_handle vb = e.first->vertex(sdg_.cw(e.second));

      CGAL::Object o = sdg_.primal(e);
      Segment_2 seg;
      CGAL::Parabola_segment_2<Gt_with> parc;
      std::vector<Point_2> poly;
      if (CGAL::assign(seg, o)) {
        poly.push_back(seg.source());
        poly.push_back(seg.target());
      } else if (CGAL::assign(parc, o)) {
        const Line_2& dl = parc.line();
        sample_parabola(parc.center(), to_double(dl.a()), to_double(dl.b()), to_double(dl.c()),
                        parc.p1, parc.p2, 16, poly);
      } else {
        continue;  // ray/line/unknown — unbounded, skip
      }
      if (poly.size() < 2) continue;

      // Interior test on a representative point: the midpoint of the polyline's
      // central sub-segment. For a straight edge (2 points) that is the true
      // midpoint; for a sampled parabola it is a near-on-curve central point.
      // (Sampling a raw polyline *vertex* is wrong — an endpoint is a Voronoi
      // vertex that often lies exactly on the boundary, where the even-odd test
      // is unstable, which would drop genuine interior edges and disconnect the
      // graph.)
      const std::size_t m = poly.size() / 2;
      const Point_2 mid((poly[m - 1].x() + poly[m].x()) / 2,
                        (poly[m - 1].y() + poly[m].y()) / 2);
      if (!fillIndex_.inside(mid.x(), mid.y())) continue;
      // Drop the degenerate incident bisector between a polygon/wall vertex and
      // one of its own incident edges (perpendicular touching the boundary at a
      // single point — not part of the skeleton).
      if (isIncident(va, vb)) continue;

      // Orient the polyline front->back as from-node->to-node.
      int from = i1->second, to = i2->second;
      if (sqdist(poly.front(), nodePos_[i1->second]) >
          sqdist(poly.front(), nodePos_[i2->second])) {
        from = i2->second;
        to = i1->second;
      }
      const int id = static_cast<int>(medialEdges_.size());
      const double w = polyline_len(poly);
      medialEdges_.push_back({from, to, w, poly});
      adj_[from].push_back({to, w, id, false, -1});
      adj_[to].push_back({from, w, id, true, -1});
      edgeLookup_[edge_key(sdg_, e)] = id;
    }
    dirty_ = false;
  }

  // True when one site is a point that is an endpoint of the other (a segment),
  // i.e. an incident bisector — exactly the JS isIncidentBisector() test, but
  // done with the sites' geometry directly (endpoints are shared exactly).
  bool isIncident(Vertex_handle va, Vertex_handle vb) const {
    if (sdg_.is_infinite(va) || sdg_.is_infinite(vb)) return false;
    auto test = [](const Site_2& pt, const Site_2& sg) -> bool {
      if (!pt.is_point() || !sg.is_segment()) return false;
      const Point_2 p = pt.point();
      return p == sg.source() || p == sg.target();
    };
    const Site_2 sa = va->site(), sb = vb->site();
    return test(sa, sb) || test(sb, sa);
  }

  // True when the straight connector a->b properly crosses any barrier — a
  // wall or a polygon boundary edge. Such a connector reaches its feature on
  // the far side of a wall, or through the exterior (near a narrow notch a
  // straight hop can leave the region and land in a different pocket of it) —
  // in both cases attaching the point to the wrong medial component, the
  // "no path even though it isn't blocked" bug. Endpoint touching is allowed:
  // points and features may lie exactly ON a boundary or wall (a fill lane's
  // end, a portal midpoint, a clearance-0 Voronoi vertex).
  bool connectorBlocked(const Point_2& a, const Point_2& b) const {
    // Grazing tolerance: ~1e-9 of the coordinate scale — far above the
    // floating-point residue of points constructed on boundary edges, far
    // below any real geometric separation.
    const double tol = 1e-9 * scale_;
    for (const auto& w : barriers_)
      if (segments_properly_cross(a, b, w.first, w.second, tol)) return true;
    return false;
  }

  // Add a bidirectional temporary edge between nodes u and v, with the polyline
  // uv oriented u->v (the v->u direction stores the reverse).
  void addTemp(std::vector<std::vector<Adj>>& g, std::vector<std::vector<Point_2>>& tempPolys,
               int u, int v, const std::vector<Point_2>& uv, double L) {
    const int k1 = static_cast<int>(tempPolys.size());
    tempPolys.push_back(uv);
    std::vector<Point_2> vu(uv.rbegin(), uv.rend());
    const int k2 = static_cast<int>(tempPolys.size());
    tempPolys.push_back(std::move(vu));
    g[u].push_back({v, L, -1, false, k1});
    g[v].push_back({u, L, -1, false, k2});
  }

  // Build the sub-arc of `poly` between two projections a and b (in either
  // order along the polyline), oriented from a.q to b.q.
  void buildArc(const std::vector<Point_2>& poly, const Proj& a, const Proj& b,
                std::vector<Point_2>& out) {
    if (a.seg <= b.seg) {
      out.push_back(a.q);
      for (int i = a.seg + 1; i <= b.seg; ++i) out.push_back(poly[i]);
      out.push_back(b.q);
    } else {
      out.push_back(a.q);
      for (int i = a.seg; i >= b.seg + 1; --i) out.push_back(poly[i]);
      out.push_back(b.q);
    }
  }

  // One endpoint attachment onto a split medial edge: the projection node id in
  // the working graph plus the projection itself (kept so findPath can join two
  // endpoints that split the same edge by the sub-arc between them).
  struct EdgeAttach { int q; Proj proj; };

  // Euclidean distance from p to a site (point or segment). Used to detect
  // nearest-site ties: when p lies exactly on a junction — a boundary reflex
  // corner, a wall endpoint, a T-junction — several sites are at the same
  // (often zero) distance and nearest_neighbor() breaks the tie arbitrarily.
  static double siteDist(const Site_2& s, const Point_2& p) {
    if (s.is_point()) return std::sqrt(sqdist(s.point(), p));
    const Point_2 a = s.source(), b = s.target();
    const double dx = b.x() - a.x(), dy = b.y() - a.y();
    const double len2 = dx * dx + dy * dy;
    double t = len2 > 0 ? ((p.x() - a.x()) * dx + (p.y() - a.y()) * dy) / len2 : 0;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    return std::sqrt(sqdist(Point_2(a.x() + t * dx, a.y() + t * dy), p));
  }

  // Attach a point to the medial graph. Finds every Voronoi cell whose closure
  // contains the point — the nearest site's, plus every site tied with it — and
  // adds a temporary connector to EVERY eligible medial feature bounding those
  // cells; Dijkstra then makes the destination-aware choice among them.
  //
  // Both halves matter. Enumerating tied cells means a point exactly on a
  // junction (a boundary reflex corner, a wall endpoint, a wall–boundary
  // T-junction) sees the features on *all* its sides, not the arbitrary side
  // nearest_neighbor()'s tie-break lands on — with walls, the arbitrary side
  // can be the wrong component, a spurious "no path". And attaching to every
  // eligible feature (rather than one nearest) matters because a single
  // connector is destination-blind: at a skeleton branch two features tie for
  // nearest, and committing to either detours every path headed the other way.
  //
  // The feature tiers are unchanged: interior features — edges whose endpoints
  // are both off the boundary, plus interior branch vertices — are preferred,
  // so connectors still jump to the skeleton's spine rather than a boundary
  // stub near a corner; boundary edges are used only when no interior feature
  // is eligible; and the wall-ignoring nearest edge stays the degenerate last
  // resort. Within the winning tier, every candidate gets a connector.
  //
  // Returns the point's node id. `attached` reports whether any connector was
  // added; `edgeAttach` maps each split medial edge id to its projection node.
  int connectPoint(double x, double y, std::vector<std::vector<Adj>>& g,
                   std::vector<std::vector<Point_2>>& tempPolys,
                   std::map<int, EdgeAttach>& edgeAttach, bool& attached) {
    const Point_2 p(x, y);
    const double INF = std::numeric_limits<double>::infinity();

    // Candidate features, deduped across the (possibly several) cells scanned.
    // std::map keeps iteration — and thus temp-node numbering — deterministic.
    std::set<int> seen;
    std::map<int, Proj> intEdges, anyEdges;  // medial edge id -> projection
    std::map<int, double> intVerts;          // graph node id -> squared distance
    // Last-resort fallback that ignores wall crossings, used only if every
    // candidate connector would cross a wall (keeps behaviour no worse than
    // before the crossing filter existed).
    int fbEdge = -1;
    Proj fbProj{INF, p, 0};

    // A connector that properly crosses a wall would attach the point to the
    // wall's far side — a different medial-graph component when the wall splits
    // the axis (a wall's cell straddles both of its sides, so its bounding
    // features do too) — so such a candidate is ineligible.
    auto consider = [&](int id) {
      if (!seen.insert(id).second) return;
      const MEdge& me = medialEdges_[id];
      const Proj pr = project_polyline(x, y, me.poly);
      if (pr.d2 < fbProj.d2) { fbProj = pr; fbEdge = id; }
      if (!connectorBlocked(p, pr.q)) {
        anyEdges.emplace(id, pr);
        if (!onBoundary_[me.from] && !onBoundary_[me.to]) intEdges.emplace(id, pr);
      }
      for (int n : {me.from, me.to}) {
        if (!onBoundary_[n] && !intVerts.count(n)) {
          const double d2 = sqdist(p, nodePos_[n]);
          if (!connectorBlocked(p, nodePos_[n])) intVerts.emplace(n, d2);
        }
      }
    };

    // The cells whose closure contains p: the nearest site's, plus — when p is
    // equidistant from several sites (exactly on a junction) — every tied
    // site's. The tied cells form a connected fan around p, so a BFS over
    // Delaunay adjacency starting at the nearest site reaches them all.
    if (sdg_.number_of_vertices() > 0) {
      Vertex_handle nv = sdg_.nearest_neighbor(p);
      if (nv != Vertex_handle() && !sdg_.is_infinite(nv)) {
        const double d0 = siteDist(nv->site(), p);
        const double tieTol = 1e-9 * (1.0 + std::fabs(x) + std::fabs(y) + d0);
        std::vector<Vertex_handle> cells{nv};
        std::set<const void*> visited{&*nv};
        for (std::size_t i = 0; i < cells.size(); ++i) {
          Vertex_circulator vc = sdg_.incident_vertices(cells[i]);
          if (vc == nullptr) continue;
          Vertex_circulator vdone = vc;
          do {
            Vertex_handle w = vc;
            if (!sdg_.is_infinite(w) && visited.insert(&*w).second &&
                siteDist(w->site(), p) <= d0 + tieTol)
              cells.push_back(w);
          } while (++vc != vdone);
        }
        for (Vertex_handle v : cells) {
          Edge_circulator ec = sdg_.incident_edges(v), edone = ec;
          if (ec != nullptr) {
            do {
              auto it = edgeLookup_.find(edge_key(sdg_, *ec));
              if (it != edgeLookup_.end()) consider(it->second);
            } while (++ec != edone);
          }
        }
      }
    }

    // Fallback: the cells offered no wall-clear edge (they touch no kept medial
    // edge, every connector crossed a wall, or the point is outside the
    // region). Scan every medial edge, then reduce each tier to its single
    // nearest candidate — the scan has no cell locality, and a global
    // multi-attach would tie the point to features across the whole region
    // through connectors only the wall test vets.
    if (anyEdges.empty()) {
      for (std::size_t id = 0; id < medialEdges_.size(); ++id)
        consider(static_cast<int>(id));
      auto reduceEdges = [](std::map<int, Proj>& m) {
        if (m.size() <= 1) return;
        auto best = m.begin();
        for (auto it = m.begin(); it != m.end(); ++it)
          if (it->second.d2 < best->second.d2) best = it;
        std::map<int, Proj> one;
        one.insert(*best);
        m.swap(one);
      };
      reduceEdges(intEdges);
      reduceEdges(anyEdges);
      if (intVerts.size() > 1) {
        auto best = intVerts.begin();
        for (auto it = intVerts.begin(); it != intVerts.end(); ++it)
          if (it->second < best->second) best = it;
        std::map<int, double> one;
        one.insert(*best);
        intVerts.swap(one);
      }
    }

    const int P = static_cast<int>(g.size());
    g.push_back({});
    attached = false;

    // Split a medial edge at the projection: node Q at q, straight connector
    // P->Q, and the two half-arcs Q->from and Q->to.
    auto splitAttach = [&](int id, const Proj& pr) {
      const MEdge& me = medialEdges_[id];
      const std::vector<Point_2>& poly = me.poly;
      // Sub-polylines: from-node..q and q..to-node.
      std::vector<Point_2> aPoly(poly.begin(), poly.begin() + pr.seg + 1);
      aPoly.push_back(pr.q);
      std::vector<Point_2> bPoly;
      bPoly.push_back(pr.q);
      for (std::size_t i = pr.seg + 1; i < poly.size(); ++i) bPoly.push_back(poly[i]);

      const int Q = static_cast<int>(g.size());
      g.push_back({});
      std::vector<Point_2> pq = {p, pr.q};
      addTemp(g, tempPolys, P, Q, pq, std::sqrt(pr.d2));
      std::vector<Point_2> qa(aPoly.rbegin(), aPoly.rend());  // q -> from
      addTemp(g, tempPolys, Q, me.from, qa, polyline_len(aPoly));
      addTemp(g, tempPolys, Q, me.to, bPoly, polyline_len(bPoly));  // q -> to
      edgeAttach.emplace(id, EdgeAttach{Q, pr});
      attached = true;
    };

    // Attach to every feature in the best available tier. The extra connectors
    // are a handful of temporary nodes per query — cheap — and give Dijkstra
    // the per-destination choice a single nearest attachment cannot make.
    if (!intEdges.empty() || !intVerts.empty()) {
      for (const auto& [n, d2] : intVerts) {
        std::vector<Point_2> pv = {p, nodePos_[n]};
        addTemp(g, tempPolys, P, n, pv, std::sqrt(d2));
        attached = true;
      }
      for (const auto& [id, pr] : intEdges) splitAttach(id, pr);
    } else if (!anyEdges.empty()) {
      for (const auto& [id, pr] : anyEdges) splitAttach(id, pr);
    } else if (fbEdge >= 0) {
      splitAttach(fbEdge, fbProj);
    }
    return P;
  }

  PF_SDG sdg_;
  std::vector<std::vector<Point_2>> fillRings_;
  FillIndex fillIndex_;  // banded interior test over the (fixed) fill rings
  std::set<Point_2, PointLess> boundaryVerts_;  // polygon corners + wall endpoints
  std::vector<std::pair<Point_2, Point_2>> barriers_;  // boundary edges + walls (connector tests)
  double scale_ = 1.0;  // max |coordinate| seen — sets the grazing tolerance
  bool dirty_;

  // Cached medial-axis graph (valid while !dirty_).
  std::vector<Point_2> nodePos_;
  std::vector<char> onBoundary_;  // per node: does it coincide with a polygon corner?
  std::vector<MEdge> medialEdges_;
  std::vector<std::vector<Adj>> adj_;
  std::map<Face_handle, int> faceNode_;
  std::unordered_map<std::pair<const void*, const void*>, int, EdgeKeyHash> edgeLookup_;
};

} // namespace

EMSCRIPTEN_BINDINGS(voron8) {
  emscripten::function("computeVoronoi", &compute_voronoi);
  emscripten::function("computeVoronoiNoIntersections", &compute_voronoi_no_intersections);

  emscripten::class_<MedialPathFinder>("MedialPathFinder")
      .constructor<emscripten::val, emscripten::val>()
      .function("addWall", &MedialPathFinder::addWall)
      .function("findPath", &MedialPathFinder::findPath)
      .function("debugGraph", &MedialPathFinder::debugGraph);
}
