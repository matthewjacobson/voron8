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
#include <unordered_map>
#include <unordered_set>
#include <cstdint>
#include <vector>
#include <utility>

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

} // namespace

EMSCRIPTEN_BINDINGS(voron8) {
  emscripten::function("computeVoronoi", &compute_voronoi);
  emscripten::function("computeVoronoiNoIntersections", &compute_voronoi_no_intersections);
}
