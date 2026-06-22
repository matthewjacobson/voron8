// Intersection detection for the `assumeNoIntersections` fast path.
//
// The without-intersections segment Delaunay traits requires that no two input
// segments meet anywhere other than at a shared endpoint. CGAL does not enforce
// this (it silently drops an offending segment), so voron8 checks it here first.
//
// `findSegmentConflict` is a Shamos–Hoey sweep: O((n + k) log n) for n segments
// reporting the first conflict (vs. the O(n²) all-pairs scan it replaces). The
// status structure is an AVL tree of the segments currently crossing the sweep
// line, ordered by their y there; a conflict can only occur between segments
// that are adjacent in that order at some event, so each insertion/removal
// tests just its new neighbours. Every candidate pair is checked with the exact
// `segmentsConflict` predicate, which permits a shared endpoint but rejects a
// proper crossing, a T-junction, or a collinear overlap — exactly the
// configurations the traits cannot handle.

export type Pt = [number, number];
export interface Seg {
  a: Pt;
  b: Pt;
}

const cross = (o: Pt, p: Pt, q: Pt): number =>
  (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);

const samePt = (p: Pt, q: Pt): boolean => p[0] === q[0] && p[1] === q[1];

/** True if `p` lies strictly in the interior of segment a–b (collinear, between, not an endpoint). */
function strictlyInside(a: Pt, b: Pt, p: Pt): boolean {
  if (cross(a, b, p) !== 0) return false;
  if (samePt(p, a) || samePt(p, b)) return false;
  return (
    Math.min(a[0], b[0]) <= p[0] && p[0] <= Math.max(a[0], b[0]) &&
    Math.min(a[1], b[1]) <= p[1] && p[1] <= Math.max(a[1], b[1])
  );
}

/**
 * True when two segments intersect anywhere other than at a shared endpoint —
 * i.e. a proper crossing, a T-junction (an endpoint on the other's interior), or
 * a collinear overlap. These are exactly the configurations the
 * without-intersections traits cannot handle. Touching at a common endpoint
 * (as consecutive polygon/polyline edges do) is allowed and returns false.
 */
export function segmentsConflict(s: Seg, t: Seg): boolean {
  const d1 = cross(t.a, t.b, s.a);
  const d2 = cross(t.a, t.b, s.b);
  const d3 = cross(s.a, s.b, t.a);
  const d4 = cross(s.a, s.b, t.b);
  // Proper crossing: each segment strictly straddles the other's supporting line.
  if (((d1 > 0) !== (d2 > 0)) && d1 !== 0 && d2 !== 0 &&
      ((d3 > 0) !== (d4 > 0)) && d3 !== 0 && d4 !== 0) {
    return true;
  }
  // Collinear overlap or T-junction: an endpoint sits inside the other segment.
  return (
    strictlyInside(t.a, t.b, s.a) || strictlyInside(t.a, t.b, s.b) ||
    strictlyInside(s.a, s.b, t.a) || strictlyInside(s.a, s.b, t.b)
  );
}

// ---------------------------------------------------------------------------
// Internal segment record and AVL status structure
// ---------------------------------------------------------------------------

interface ISeg {
  a: Pt;        // original endpoints (for the conflict predicate)
  b: Pt;
  // Non-vertical segments only: left endpoint (smaller x), right endpoint, slope.
  lx: number; ly: number; rx: number; ry: number; slope: number;
  vertical: boolean;
  ylo: number; yhi: number;  // vertical segments only
  id: number;
  node: AvlNode | null;      // its node while in the status tree
}

interface AvlNode {
  seg: ISeg;
  left: AvlNode | null;
  right: AvlNode | null;
  parent: AvlNode | null;
  h: number;
}

const height = (n: AvlNode | null): number => (n ? n.h : 0);
const fix = (n: AvlNode): void => { n.h = 1 + Math.max(height(n.left), height(n.right)); };

/**
 * AVL tree of active non-vertical segments, ordered by y at the current sweep
 * position. Between any two events (and before the first conflict) no two active
 * segments cross, so this order is stable and the tree stays valid; the
 * comparator is therefore free to evaluate y at the live `sweepX`.
 */
class Status {
  private root: AvlNode | null = null;
  sweepX = 0;

  private yAt(s: ISeg): number {
    return s.ly + ((s.ry - s.ly) * (this.sweepX - s.lx)) / (s.rx - s.lx);
  }

  /** Order two segments at the sweep line: by y, then by slope (the order just to
   *  the right of a shared point), then by id so the order is strict. */
  private cmp(a: ISeg, b: ISeg): number {
    const ya = this.yAt(a), yb = this.yAt(b);
    if (ya !== yb) return ya < yb ? -1 : 1;
    if (a.slope !== b.slope) return a.slope < b.slope ? -1 : 1;
    return a.id - b.id;
  }

  private rotateLeft(x: AvlNode): AvlNode {
    const y = x.right as AvlNode;
    x.right = y.left;
    if (y.left) y.left.parent = x;
    y.parent = x.parent;
    if (!x.parent) this.root = y;
    else if (x.parent.left === x) x.parent.left = y;
    else x.parent.right = y;
    y.left = x;
    x.parent = y;
    fix(x); fix(y);
    return y;
  }

  private rotateRight(x: AvlNode): AvlNode {
    const y = x.left as AvlNode;
    x.left = y.right;
    if (y.right) y.right.parent = x;
    y.parent = x.parent;
    if (!x.parent) this.root = y;
    else if (x.parent.left === x) x.parent.left = y;
    else x.parent.right = y;
    y.right = x;
    x.parent = y;
    fix(x); fix(y);
    return y;
  }

  private retrace(from: AvlNode | null): void {
    let n = from;
    while (n) {
      fix(n);
      const bf = height(n.left) - height(n.right);
      if (bf > 1) {
        if (height(n.left!.left) < height(n.left!.right)) this.rotateLeft(n.left!);
        n = this.rotateRight(n);
      } else if (bf < -1) {
        if (height(n.right!.right) < height(n.right!.left)) this.rotateRight(n.right!);
        n = this.rotateLeft(n);
      }
      n = n.parent;
    }
  }

  insert(seg: ISeg): AvlNode {
    const node: AvlNode = { seg, left: null, right: null, parent: null, h: 1 };
    seg.node = node;
    if (!this.root) { this.root = node; return node; }
    let cur: AvlNode | null = this.root;
    let parent = this.root;
    while (cur) { parent = cur; cur = this.cmp(seg, cur.seg) < 0 ? cur.left : cur.right; }
    node.parent = parent;
    if (this.cmp(seg, parent.seg) < 0) parent.left = node; else parent.right = node;
    this.retrace(parent);
    return node;
  }

  remove(node: AvlNode): void {
    // If the node has two children, move its in-order successor's segment up
    // into it (keeping that segment's node pointer correct) and splice out the
    // successor node, which has at most one child.
    let target = node;
    if (node.left && node.right) {
      let s = node.right;
      while (s.left) s = s.left;
      node.seg = s.seg;
      node.seg.node = node;
      target = s;
    }
    const child = target.left ?? target.right;
    const p = target.parent;
    if (child) child.parent = p;
    if (!p) this.root = child;
    else if (p.left === target) p.left = child; else p.right = child;
    this.retrace(p);
  }

  static pred(node: AvlNode): AvlNode | null {
    if (node.left) { let n = node.left; while (n.right) n = n.right; return n; }
    let n: AvlNode = node, p = node.parent;
    while (p && p.left === n) { n = p; p = p.parent; }
    return p;
  }

  static succ(node: AvlNode): AvlNode | null {
    if (node.right) { let n = node.right; while (n.left) n = n.left; return n; }
    let n: AvlNode = node, p = node.parent;
    while (p && p.right === n) { n = p; p = p.parent; }
    return p;
  }

  /** The first node whose y at the sweep line is >= `yval` (in-order). */
  lowerBound(yval: number): AvlNode | null {
    let n = this.root, res: AvlNode | null = null;
    while (n) {
      if (this.yAt(n.seg) >= yval) { res = n; n = n.left; } else n = n.right;
    }
    return res;
  }

  yOf(seg: ISeg): number { return this.yAt(seg); }
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

interface Event { x: number; rank: number; seg: ISeg; }

function toISeg(s: Seg, id: number): ISeg | null {
  if (samePt(s.a, s.b)) return null;  // degenerate (zero-length) — encloses nothing
  const base = {
    a: s.a, b: s.b, id, node: null,
    vertical: false, lx: 0, ly: 0, rx: 0, ry: 0, slope: 0, ylo: 0, yhi: 0,
  };
  if (s.a[0] === s.b[0]) {
    return { ...base, vertical: true,
      ylo: Math.min(s.a[1], s.b[1]), yhi: Math.max(s.a[1], s.b[1]) };
  }
  const [l, r] = s.a[0] < s.b[0] ? [s.a, s.b] : [s.b, s.a];
  return { ...base, lx: l[0], ly: l[1], rx: r[0], ry: r[1],
    slope: (r[1] - l[1]) / (r[0] - l[0]) };
}

/**
 * Return the first pair of input segments that cross or overlap (conflict), or
 * `null` if the set is conflict-free. Segments touching only at a shared
 * endpoint are not a conflict.
 */
export function findSegmentConflict(segs: Seg[]): [Seg, Seg] | null {
  const isegs: ISeg[] = [];
  for (let i = 0; i < segs.length; i++) {
    const s = toISeg(segs[i], i);
    if (s) isegs.push(s);
  }

  // Event ranking at equal x: insert starts (0) before testing verticals (1)
  // before removing ends (2), so a vertical sees every segment active at its x.
  const events: Event[] = [];
  for (const s of isegs) {
    if (s.vertical) {
      events.push({ x: s.a[0], rank: 1, seg: s });
    } else {
      events.push({ x: s.lx, rank: 0, seg: s });
      events.push({ x: s.rx, rank: 2, seg: s });
    }
  }
  events.sort((p, q) => (p.x !== q.x ? p.x - q.x : p.rank - q.rank));

  const status = new Status();
  let vertGroupX = NaN;
  let vertGroup: ISeg[] = [];

  for (const ev of events) {
    const s = ev.seg;
    if (ev.rank === 0) {
      // Left endpoint: insert and check the two new neighbours.
      status.sweepX = s.lx;
      const node = status.insert(s);
      const p = Status.pred(node), q = Status.succ(node);
      if (p && segmentsConflict(s, p.seg)) return [s, p.seg];
      if (q && segmentsConflict(s, q.seg)) return [s, q.seg];
    } else if (ev.rank === 2) {
      // Right endpoint: its former neighbours become adjacent — check that pair.
      status.sweepX = s.rx;
      const node = s.node;
      if (!node) continue;
      const p = Status.pred(node), q = Status.succ(node);
      status.remove(node);
      s.node = null;
      if (p && q && segmentsConflict(p.seg, q.seg)) return [p.seg, q.seg];
    } else {
      // Vertical: it occupies no x-interval, so it never enters the status.
      status.sweepX = s.a[0];
      if (s.a[0] !== vertGroupX) { vertGroupX = s.a[0]; vertGroup = []; }
      for (const u of vertGroup) if (segmentsConflict(s, u)) return [s, u];
      vertGroup.push(s);
      // Any active segment whose y here lies in the vertical's span conflicts
      // (it crosses the vertical's interior, or touches an endpoint — the
      // predicate decides which).
      let n = status.lowerBound(s.ylo);
      while (n && status.yOf(n.seg) <= s.yhi) {
        if (segmentsConflict(s, n.seg)) return [s, n.seg];
        n = Status.succ(n);
      }
    }
  }
  return null;
}

/** O(n²) reference implementation — used only to validate the sweep in tests. */
export function findSegmentConflictBruteForce(segs: Seg[]): [Seg, Seg] | null {
  for (let i = 0; i < segs.length; i++) {
    if (samePt(segs[i].a, segs[i].b)) continue;
    for (let j = i + 1; j < segs.length; j++) {
      if (samePt(segs[j].a, segs[j].b)) continue;
      if (segmentsConflict(segs[i], segs[j])) return [segs[i], segs[j]];
    }
  }
  return null;
}
