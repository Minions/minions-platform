import type { PlanItemRecord } from '@minions/mcp-types';

export interface NodePosition {
  x: number;
  y: number;
  layer: number;
}

export interface LayoutOptions {
  width: number;
  height: number;
  marginX: number;
  marginY: number;
}

const DEFAULT_OPTIONS: LayoutOptions = {
  width: 1200,
  height: 700,
  marginX: 120,
  marginY: 80,
};

// ── Tidy tree subtree layout (Reingold–Tilford / Walker, Buchheim linear-time) ─

export interface TidyTreeOptions extends LayoutOptions {
  /** Minimum gap between the centres of adjacent nodes (siblings or cousins). */
  nodeSpacing: number;
  /** Gap between successive depth levels. */
  levelSpacing: number;
  /**
   * Layout axis. 'vertical' grows downward (depth → y, breadth → x — the classic
   * tidy tree). 'horizontal' grows rightward (depth → x, breadth → y), which
   * keeps deep trees free of the camera's vertical-perspective foreshortening.
   */
  orientation: 'vertical' | 'horizontal';
}

const DEFAULT_TIDY_OPTIONS: TidyTreeOptions = {
  ...DEFAULT_OPTIONS,
  nodeSpacing: 200,
  levelSpacing: 240,
  orientation: 'vertical',
};

/** Internal mutable node used by the Buchheim–Walker passes. */
interface TidyNode {
  id: string;
  children: TidyNode[];
  parent: TidyNode | null;
  /** 1-based index among siblings (0 for the root). */
  number: number;
  prelim: number;
  mod: number;
  change: number;
  shift: number;
  ancestor: TidyNode;
  thread: TidyNode | null;
}

/**
 * Builds a spanning tree rooted at rootId, following children then requires and
 * skipping already-visited nodes. The plan graph is a DAG (shared children,
 * cross-tree requires); the layout needs a tree, so each node is attached under
 * the first parent that reaches it. Non-tree edges are still drawn by the view.
 */
function buildSpanningTree(
  items: Record<string, PlanItemRecord>,
  rootId: string,
): TidyNode | null {
  if (!items[rootId]) return null;
  const visited = new Set<string>();

  const make = (id: string, parent: TidyNode | null, number: number): TidyNode => {
    const node: TidyNode = {
      id, children: [], parent, number,
      prelim: 0, mod: 0, change: 0, shift: 0,
      ancestor: null as unknown as TidyNode, thread: null,
    };
    node.ancestor = node;
    visited.add(id);
    const neighbors = [...(items[id]?.children ?? []), ...(items[id]?.requires ?? [])]
      .filter(c => !!items[c] && !visited.has(c));
    let i = 1;
    for (const c of neighbors) {
      if (visited.has(c)) continue; // a sibling earlier in this list may have claimed it
      node.children.push(make(c, node, i++));
    }
    return node;
  };

  return make(rootId, null, 0);
}

const nextLeft = (v: TidyNode): TidyNode | null => (v.children.length ? v.children[0] : v.thread);
const nextRight = (v: TidyNode): TidyNode | null => (v.children.length ? v.children[v.children.length - 1] : v.thread);

function moveSubtree(wm: TidyNode, wp: TidyNode, shift: number): void {
  const subtrees = wp.number - wm.number;
  wp.change -= shift / subtrees;
  wp.shift += shift;
  wm.change += shift / subtrees;
  wp.prelim += shift;
  wp.mod += shift;
}

function executeShifts(v: TidyNode): void {
  let shift = 0;
  let change = 0;
  for (let i = v.children.length - 1; i >= 0; i--) {
    const w = v.children[i];
    w.prelim += shift;
    w.mod += shift;
    change += w.change;
    shift += w.shift + change;
  }
}

function ancestor(vim: TidyNode, v: TidyNode, defaultAncestor: TidyNode): TidyNode {
  return vim.ancestor.parent === v.parent ? vim.ancestor : defaultAncestor;
}

function apportion(v: TidyNode, defaultAncestor: TidyNode, distance: number): TidyNode {
  const w = leftSibling(v);
  if (!w || !v.parent) return defaultAncestor;

  let vip: TidyNode = v;
  let vop: TidyNode = v;
  let vim: TidyNode = w;
  let vom: TidyNode = v.parent.children[0];
  let sip = vip.mod;
  let sop = vop.mod;
  let sim = vim.mod;
  let som = vom.mod;

  let nr = nextRight(vim);
  let nl = nextLeft(vip);
  while (nr && nl) {
    const nlVom = nextLeft(vom);
    const nrVop = nextRight(vop);
    if (!nlVom || !nrVop) break;
    vim = nr;
    vip = nl;
    vom = nlVom;
    vop = nrVop;
    vop.ancestor = v;
    const shift = vim.prelim + sim - (vip.prelim + sip) + distance;
    if (shift > 0) {
      moveSubtree(ancestor(vim, v, defaultAncestor), v, shift);
      sip += shift;
      sop += shift;
    }
    sim += vim.mod;
    sip += vip.mod;
    som += vom.mod;
    sop += vop.mod;
    nr = nextRight(vim);
    nl = nextLeft(vip);
  }
  if (nr && !nextRight(vop)) {
    vop.thread = nr;
    vop.mod += sim - sop;
  }
  if (nl && !nextLeft(vom)) {
    vom.thread = nl;
    vom.mod += sip - som;
    defaultAncestor = v;
  }
  return defaultAncestor;
}

function leftSibling(v: TidyNode): TidyNode | null {
  if (!v.parent) return null;
  const sibs = v.parent.children;
  const i = sibs.indexOf(v);
  return i > 0 ? sibs[i - 1] : null;
}

function firstWalk(v: TidyNode, distance: number): void {
  if (v.children.length === 0) {
    const w = leftSibling(v);
    v.prelim = w ? w.prelim + distance : 0;
    return;
  }
  let defaultAncestor = v.children[0];
  for (const w of v.children) {
    firstWalk(w, distance);
    defaultAncestor = apportion(w, defaultAncestor, distance);
  }
  executeShifts(v);
  const midpoint = (v.children[0].prelim + v.children[v.children.length - 1].prelim) / 2;
  const w = leftSibling(v);
  if (w) {
    v.prelim = w.prelim + distance;
    v.mod = v.prelim - midpoint;
  } else {
    v.prelim = midpoint;
  }
}

function secondWalk(
  v: TidyNode,
  modSum: number,
  depth: number,
  opts: TidyTreeOptions,
  out: Record<string, NodePosition>,
): void {
  const along = v.prelim + modSum; // position along the breadth axis
  const across = depth * opts.levelSpacing; // position along the depth axis
  out[v.id] = opts.orientation === 'vertical'
    ? { x: along, y: across, layer: depth }
    : { x: across, y: along, layer: depth };
  for (const w of v.children) secondWalk(w, modSum + v.mod, depth + 1, opts, out);
}

/**
 * Computes a tidy tree layout for a plan subtree.
 *
 * Uses the Reingold–Tilford algorithm generalised to n-ary trees by Walker and
 * corrected to run in linear time by Buchheim, Jünger & Leipert (2002). The
 * result guarantees that nodes never overlap, that siblings (and cousins from
 * different parents) keep at least `nodeSpacing` apart, and that every parent is
 * centred over its children — so deeply-nested trees spread out evenly instead
 * of crowding the way a radial layout does at small radii.
 *
 * Positions are centred on the canvas so the existing camera-fit can frame them.
 */
export function computeTidyTreeLayout(
  items: Record<string, PlanItemRecord>,
  rootId: string,
  options: Partial<TidyTreeOptions> = {},
): Record<string, NodePosition> {
  const root = buildSpanningTree(items, rootId);
  if (!root) return {};
  const opts = { ...DEFAULT_TIDY_OPTIONS, ...options };

  firstWalk(root, opts.nodeSpacing);
  const out: Record<string, NodePosition> = {};
  secondWalk(root, -root.prelim, 0, opts, out);

  // Centre the whole drawing on the canvas centre.
  const xs = Object.values(out).map(p => p.x);
  const ys = Object.values(out).map(p => p.y);
  const midX = (Math.min(...xs) + Math.max(...xs)) / 2;
  const midY = (Math.min(...ys) + Math.max(...ys)) / 2;
  const cx = opts.width / 2;
  const cy = opts.height / 2;
  for (const p of Object.values(out)) {
    p.x += cx - midX;
    p.y += cy - midY;
  }
  return out;
}

/**
 * Places root nodes radially around the canvas centre.
 *
 * N roots are evenly distributed on a circle, starting from the top (12 o'clock)
 * and proceeding clockwise. The radius grows with N to keep nodes from overlapping.
 */
export function computeRootRadialLayout(
  rootIds: string[],
  options: Partial<LayoutOptions> = {},
): Record<string, NodePosition> {
  if (rootIds.length === 0) return {};

  const opts = { ...DEFAULT_OPTIONS, ...options };
  const { width, height } = opts;
  const cx = width / 2;
  const cy = height / 2;
  const n = rootIds.length;
  const result: Record<string, NodePosition> = {};

  if (n === 1) {
    result[rootIds[0]] = { x: cx, y: cy, layer: 0 };
    return result;
  }

  // Radius so nodes don't overlap in *projected* space at camD=1500, FOCAL=900.
  // nodeR=65 matches the overview baseRadius in LivingCosmos; factor 1.5 adds breathing room.
  const nodeR = 65, camDRef = 1500, focalRef = 900;
  const minRadius = n > 1 ? (nodeR * camDRef * 2.25) / (focalRef * Math.sin(Math.PI / n)) : 0;
  const radius = Math.max(260, minRadius);

  rootIds.forEach((id, i) => {
    // Start at top (−π/2), proceed clockwise
    const angle = (2 * Math.PI * i) / n - Math.PI / 2;
    result[id] = {
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
      layer: 0,
    };
  });

  return result;
}

export interface FitCamOptions {
  /** Canvas size the projection targets. */
  width: number;
  height: number;
  /** Perspective focal length. */
  focal: number;
  /** Camera tilt (radians) — matches the projection used to render. */
  tilt: number;
  /** Horizontal/vertical padding kept clear of node centres (room for node + labels). */
  marginX: number;
  marginY: number;
  /** Lower bound for the returned distance (never zoom in closer than this). */
  minCamD: number;
}

/**
 * Smallest camera distance that keeps every laid-out node inside the viewport.
 *
 * A radial layout grows its radius with node count, so a fixed camera distance
 * only frames a handful of nodes — beyond that the ring projects entirely
 * off-screen and nothing is visible. The render projects a data point (px,py)
 * about the canvas centre as:
 *
 *   depth  = (py - cy)·sin(tilt) + camD
 *   screenX = cx + (px - cx)·focal/depth
 *   screenY = cy − (py - cy)·cos(tilt)·focal/depth
 *
 * Requiring |screenX − cx| ≤ HX and |screenY − cy| ≤ HY and solving each for
 * camD gives a per-node lower bound; the max over all nodes is the answer.
 * Increasing camD only shrinks the projection (monotonic), so the per-node max
 * is exact, not an over-estimate.
 */
export function fitRadialCamDistance(
  positions: Record<string, NodePosition>,
  options: FitCamOptions,
): number {
  const { width, height, focal, tilt, marginX, marginY, minCamD } = options;
  const cx = width / 2, cy = height / 2;
  const sinT = Math.sin(tilt), cosT = Math.cos(tilt);
  const HX = width / 2 - marginX;
  const HY = height / 2 - marginY;
  let needed = minCamD;
  for (const p of Object.values(positions)) {
    const dx = p.x - cx, dy = p.y - cy;
    needed = Math.max(
      needed,
      (Math.abs(dx) * focal) / HX - dy * sinT,
      (Math.abs(dy) * cosT * focal) / HY - dy * sinT,
    );
  }
  return needed;
}

/**
 * Places root nodes in a comfortable 2D scatter — no strict hierarchy.
 *
 * For 1–4 roots: single horizontal row. For 5+: two rows, with the shorter row centred.
 * All positions land within the canvas bounds.
 */
export function computeRootScatterLayout(
  rootIds: string[],
  options: Partial<LayoutOptions> = {},
): Record<string, NodePosition> {
  if (rootIds.length === 0) return {};

  const opts = { ...DEFAULT_OPTIONS, ...options };
  const { width, height, marginX, marginY } = opts;

  const n = rootIds.length;
  const result: Record<string, NodePosition> = {};

  if (n === 1) {
    result[rootIds[0]] = { x: width / 2, y: height / 2, layer: 0 };
    return result;
  }

  // cols = n for small counts, ceil(n/2) for larger — keeps aspect ratio balanced
  const cols = n <= 4 ? n : Math.ceil(n / 2);
  const rows = Math.ceil(n / cols);
  const innerW = width - 2 * marginX;
  const innerH = height - 2 * marginY;

  // spacing between nodes assuming a full row
  const spacing = cols > 1 ? innerW / (cols - 1) : 0;

  rootIds.forEach((id, i) => {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const itemsInRow = row === rows - 1 ? n - row * cols : cols;

    // Centre a partial last row by computing its actual span and offsetting left start
    const rowSpan = itemsInRow > 1 ? (itemsInRow - 1) * spacing : 0;
    const rowStartX = marginX + (innerW - rowSpan) / 2;
    const x = rowStartX + col * spacing;
    const y = rows === 1 ? height / 2 : marginY + (row / (rows - 1)) * innerH;

    result[id] = { x, y, layer: 0 };
  });

  return result;
}

/**
 * Places root nodes on a roomy, roughly 16:9 grid centred on the canvas.
 *
 * Unlike computeRootRadialLayout (one big ring, whose centre is wasted and whose
 * circumference forces a far camera as N grows), the grid packs roots densely and
 * uniformly: every node gets the same generous cell, so titles below each node
 * have room and neighbours never overlap. The camera-fit then frames the whole
 * grid. A partial last row is centred.
 *
 * Cell size is fixed in data space (not derived from the canvas) so spacing stays
 * constant regardless of root count — the camera zooms to contain it.
 */
export function computeRootGridLayout(
  rootIds: string[],
  options: Partial<LayoutOptions> = {},
): Record<string, NodePosition> {
  if (rootIds.length === 0) return {};

  const opts = { ...DEFAULT_OPTIONS, ...options };
  const cx = opts.width / 2;
  const cy = opts.height / 2;
  const n = rootIds.length;
  const result: Record<string, NodePosition> = {};

  if (n === 1) {
    result[rootIds[0]] = { x: cx, y: cy, layer: 0 };
    return result;
  }

  // Cell sized for a node (r≈65, diameter 130) plus a 3-line title beneath it.
  const CELL_W = 300;
  const CELL_H = 290;

  // Bias toward more columns than rows to suit a wide (16:9) viewport.
  const cols = Math.max(1, Math.ceil(Math.sqrt(n * 1.6)));
  const rows = Math.ceil(n / cols);
  const gridH = (rows - 1) * CELL_H;

  rootIds.forEach((id, i) => {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const itemsInRow = row === rows - 1 ? n - row * cols : cols;
    const rowSpan = (itemsInRow - 1) * CELL_W;
    const x = cx - rowSpan / 2 + col * CELL_W;
    const y = cy - gridH / 2 + row * CELL_H;
    result[id] = { x, y, layer: 0 };
  });

  return result;
}

export interface RegionBox {
  /** Grouping key this region represents (e.g. a lifecycle stage). */
  key: string;
  /** Region centre in data space. */
  cx: number;
  cy: number;
  /** Half-extents of the region boundary in data space. */
  rx: number;
  ry: number;
}

export interface RegionLayoutResult {
  positions: Record<string, NodePosition>;
  regions: RegionBox[];
}

/**
 * Places roots into distinct spatial *regions* — one per group — each region a
 * small grid of its members, with the regions themselves arranged on a meta-grid.
 *
 * This is the half-step toward product-area regions: today the caller groups by
 * whatever dimension it has (lifecycle stage); later the same shape can carry
 * product areas. Grouping is supplied by the caller (kept pure here), and the
 * result includes a boundary box per region so the view can draw + label it.
 *
 * Region slots are uniformly sized to the largest region so they tile cleanly.
 * Empty groups are dropped. Partial last rows (of both nodes and regions) centre.
 */
export function computeRootRegionLayout(
  groups: Array<{ key: string; rootIds: string[] }>,
  options: Partial<LayoutOptions> = {},
): RegionLayoutResult {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const cx0 = opts.width / 2;
  const cy0 = opts.height / 2;

  const nonEmpty = groups.filter(g => g.rootIds.length > 0);
  if (nonEmpty.length === 0) return { positions: {}, regions: [] };

  const CELL_W = 300;
  const CELL_H = 290;
  const REGION_PAD = 110; // breathing room between the node grid and the region edge
  const REGION_GAP = 150; // gap between adjacent region slots

  // 1. Lay each region's roots out in a local grid centred on its own origin.
  const local = nonEmpty.map(g => {
    const n = g.rootIds.length;
    const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
    const rows = Math.ceil(n / cols);
    const gridH = (rows - 1) * CELL_H;
    const offsets = g.rootIds.map((id, i) => {
      const row = Math.floor(i / cols);
      const col = i % cols;
      const itemsInRow = row === rows - 1 ? n - row * cols : cols;
      const rowSpan = (itemsInRow - 1) * CELL_W;
      return { id, dx: -rowSpan / 2 + col * CELL_W, dy: -gridH / 2 + row * CELL_H };
    });
    const rx = ((cols - 1) * CELL_W) / 2 + REGION_PAD;
    const ry = gridH / 2 + REGION_PAD;
    return { key: g.key, offsets, rx, ry };
  });

  // 2. Place region slots on a meta-grid, uniformly sized to the largest region.
  const slotRx = Math.max(...local.map(r => r.rx));
  const slotRy = Math.max(...local.map(r => r.ry));
  const slotW = slotRx * 2 + REGION_GAP;
  const slotH = slotRy * 2 + REGION_GAP;

  const rcols = Math.max(1, Math.ceil(Math.sqrt(local.length)));
  const rrows = Math.ceil(local.length / rcols);
  const metaH = (rrows - 1) * slotH;

  const positions: Record<string, NodePosition> = {};
  const regions: RegionBox[] = [];

  local.forEach((r, idx) => {
    const row = Math.floor(idx / rcols);
    const col = idx % rcols;
    const regionsInRow = row === rrows - 1 ? local.length - row * rcols : rcols;
    const rowSpan = (regionsInRow - 1) * slotW;
    const rcx = cx0 - rowSpan / 2 + col * slotW;
    const rcy = cy0 - metaH / 2 + row * slotH;
    for (const o of r.offsets) positions[o.id] = { x: rcx + o.dx, y: rcy + o.dy, layer: 0 };
    regions.push({ key: r.key, cx: rcx, cy: rcy, rx: r.rx, ry: r.ry });
  });

  return { positions, regions };
}

/**
 * Computes a top-down hierarchical layout for multiple plan trees shown as one graph.
 *
 * Each root gets its own horizontal band. Within a band, nodes are layered by BFS
 * depth from that root and distributed evenly. Bands are placed side-by-side so that
 * cross-tree requires edges naturally span between them.
 */
export function computeMultiRootLayout(
  items: Record<string, PlanItemRecord>,
  rootIds: string[],
  options: Partial<LayoutOptions> = {},
): Record<string, NodePosition> {
  if (rootIds.length === 0) return {};

  const opts = { ...DEFAULT_OPTIONS, ...options };
  const { width, height, marginX, marginY } = opts;

  // BFS layers for each tree
  const treeLayers = rootIds.map((rootId) => {
    const layers = new Map<string, number>();
    if (!items[rootId]) return { layers, byLayer: new Map<number, string[]>() };

    const queue: Array<{ id: string; layer: number }> = [{ id: rootId, layer: 0 }];
    layers.set(rootId, 0);
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) break;
      const { id, layer } = next;
      const node = items[id];
      if (!node) continue;
      for (const childId of node.children ?? []) {
        if (!layers.has(childId) && items[childId]) {
          layers.set(childId, layer + 1);
          queue.push({ id: childId, layer: layer + 1 });
        }
      }
    }

    const byLayer = new Map<number, string[]>();
    for (const [id, layer] of layers) {
      const ids = byLayer.get(layer);
      if (ids) {
        ids.push(id);
      } else {
        byLayer.set(layer, [id]);
      }
    }

    return { layers, byLayer };
  });

  const globalMaxDepth = Math.max(
    1,
    ...treeLayers.map((t) =>
      t.byLayer.size > 0 ? Math.max(...t.byLayer.keys()) : 0,
    ),
  );

  const totalInnerWidth = width - 2 * marginX;
  const bandWidth = totalInnerWidth / rootIds.length;
  const bandInnerPad = Math.min(40, bandWidth * 0.08);

  const result: Record<string, NodePosition> = {};

  treeLayers.forEach(({ byLayer }, treeIndex) => {
    const bandLeft = marginX + treeIndex * bandWidth;

    for (const [layerNum, ids] of byLayer) {
      const y =
        globalMaxDepth === 0
          ? marginY + (height - 2 * marginY) / 2
          : marginY + (layerNum / globalMaxDepth) * (height - 2 * marginY);

      for (let i = 0; i < ids.length; i++) {
        const x =
          ids.length === 1
            ? bandLeft + bandWidth / 2
            : bandLeft + bandInnerPad + (i / (ids.length - 1)) * (bandWidth - 2 * bandInnerPad);
        result[ids[i]] = { x, y, layer: layerNum };
      }
    }
  });

  return result;
}

/**
 * Computes a hierarchical top-down layout for a plan DAG.
 *
 * Assigns each node a layer equal to its BFS depth from the root,
 * then distributes nodes within each layer evenly across the x axis.
 * Only nodes reachable from rootId via the children relation are positioned.
 */
export function computeDagLayout(
  items: Record<string, PlanItemRecord>,
  rootId: string,
  options: Partial<LayoutOptions> = {},
): Record<string, NodePosition> {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  // BFS to assign layers, visiting each node once (handles diamond graphs)
  const layers = new Map<string, number>();
  const queue: Array<{ id: string; layer: number }> = [{ id: rootId, layer: 0 }];
  layers.set(rootId, 0);

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    const { id, layer } = next;
    const node = items[id];
    if (!node) continue;
    for (const childId of node.children ?? []) {
      if (!layers.has(childId)) {
        layers.set(childId, layer + 1);
        queue.push({ id: childId, layer: layer + 1 });
      }
    }
  }

  // Group node IDs by layer
  const byLayer = new Map<number, string[]>();
  for (const [id, layer] of layers) {
    const ids = byLayer.get(layer);
    if (ids) {
      ids.push(id);
    } else {
      byLayer.set(layer, [id]);
    }
  }

  const maxLayer = byLayer.size > 1 ? Math.max(...byLayer.keys()) : 0;
  const { width, height, marginX, marginY } = opts;

  const result: Record<string, NodePosition> = {};

  for (const [layer, ids] of byLayer) {
    const y =
      maxLayer === 0
        ? marginY + (height - 2 * marginY) / 2
        : marginY + (layer / maxLayer) * (height - 2 * marginY);

    for (let i = 0; i < ids.length; i++) {
      const x =
        ids.length === 1
          ? marginX + (width - 2 * marginX) / 2
          : marginX + (i / (ids.length - 1)) * (width - 2 * marginX);
      result[ids[i]] = { x, y, layer };
    }
  }

  return result;
}
