<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { marked } from 'marked'
import { callMCPThroneRaw, callMCPHenchery, getWorkRepoNames } from '../api/cabinet'
import type { PlanResult } from '@minions/mcp-types'
import { computeRootRadialLayout, computeRootGridLayout, computeTidyTreeLayout, fitRadialCamDistance } from '../plan/computeDagLayout'
import type { NodePosition } from '../plan/computeDagLayout'
import { wrapLabel } from '../plan/nodeLabel'
import type { ProductSpace } from '../plan/productSpace'
import FlowSpaceView from './FlowSpaceView.vue'
import type { ActivityRing, PlanDisplayStatus, PlanState } from '../plan/status-config'
import { STAGE_LABEL } from '../plan/stageLabels'
import { computePlanState, computeActivityRings } from '../plan/computePlanDisplayState'
import type { PlanItemRecord } from '@minions/mcp-types'
import { RouterLink } from 'vue-router'
import { usePlanOps } from '../plan/usePlanOps'

const { record: recordOp } = usePlanOps()

const SC: Record<PlanDisplayStatus, { glow: string; dim: string; label: string; icon: string }> = {
  'in-planning':          { glow: '#64748b', dim: '#0f172a', label: STAGE_LABEL['in-planning'],          icon: '◌' },
  'tentatively-approved': { glow: '#3b82f6', dim: '#1e3a5f', label: STAGE_LABEL['tentatively-approved'], icon: '◈' },
  'plan-done':            { glow: '#3b82f6', dim: '#1e3a5f', label: STAGE_LABEL['plan-done'],            icon: '◈' },
  'ready':                { glow: '#84cc16', dim: '#1a2e05', label: STAGE_LABEL['ready'],                icon: '▶' },
  'on-path':              { glow: '#06b6d4', dim: '#0c2840', label: STAGE_LABEL['on-path'],              icon: '◎' },
  'wip':                  { glow: '#f59e0b', dim: '#451a03', label: STAGE_LABEL['wip'],                  icon: '↻' },
  'demo-ready':           { glow: '#a855f7', dim: '#3b1d5e', label: STAGE_LABEL['demo-ready'],           icon: '★' },
  'blocked':              { glow: '#ef4444', dim: '#450a0a', label: STAGE_LABEL['blocked'],              icon: '⚠' },
}

// Orb color — plan state only (approved/ready). Independent of activity.
const PS: Record<PlanState, { glow: string; dim: string; label: string; icon: string }> = {
  imagining: { glow: '#64748b', dim: '#0f172a', label: 'Imagining', icon: '◌' },
  done:      { glow: '#3b82f6', dim: '#1e3a5f', label: 'Done',      icon: '◈' },
  ready:     { glow: '#84cc16', dim: '#1a2e05', label: 'Ready',     icon: '▶' },
}

// Activity rings — drawn around the orb, independent of and combinable with each other.
const RING: Record<ActivityRing, { color: string; label: string; icon: string }> = {
  blocked:      { color: '#ef4444', label: 'Blocked',      icon: '⚠' },
  'to-demo':    { color: '#a855f7', label: 'To Demo',      icon: '★' },
  implementing: { color: '#f59e0b', label: 'Implementing', icon: '↻' },
  goal:         { color: '#06b6d4', label: 'Goal',         icon: '◎' },
}
const RING_ORDER: ActivityRing[] = ['blocked', 'to-demo', 'implementing', 'goal']

const ORBIT_PRIORITY: PlanDisplayStatus[] = ['blocked', 'demo-ready', 'wip', 'on-path']
const ORBIT_SPEEDS  = [0.85, 0.42, 0.58, 0.28]
const ORBIT_PHASES  = [0, Math.PI * 0.6, Math.PI * 1.2, Math.PI * 1.8]

function itemStatus(item: PlanItemRecord): PlanDisplayStatus {
  if (item.questions && item.questions.length > 0) return 'blocked'
  if (item.demoLink) return 'demo-ready'
  if (item.started) return 'wip'
  if (item.onPath) return 'on-path'
  if (item.ready) return 'ready'
  if (item.approved === false || item.approved === undefined) return 'in-planning'
  if (item.approved === 'tentative') return 'tentatively-approved'
  return 'plan-done'
}

// ── 3D Camera constants ───────────────────────────────────────────────────────

const CAM_TILT = Math.PI * 22 / 180
const sinT = Math.sin(CAM_TILT)
const cosT = Math.cos(CAM_TILT)
const FOCAL = 900
const SVG_W = 1400
const SVG_H = 750

// Fixed camD values matched to the radial layout formula (see computeRootRadialLayout).
// Overview: 1500 keeps projected node separation > node diameter for up to 12 roots.
// Subgraph: 1400 keeps 3-layer trees on screen.
const OVERVIEW_CAM_D = 1500
const SUBGRAPH_CAM_D = 1400

// ── Data ──────────────────────────────────────────────────────────────────────

const rootIds = ref<string[]>([])
const items = ref<Record<string, PlanItemRecord>>({})
const loadedSpaces = ref<Record<string, ProductSpace>>({})
// Which lair-registered work repo each MAIN-tree item lives in — the plan
// tool has no default `repo` for non-wing resolution, so every single-item
// call (get-subtree/update-item/delete-subtree) on a MAIN item
// must look its repo up here rather than omitting `repo`.
const itemRepo = ref<Record<string, string>>({})
const loading = ref(true)
const error = ref<string | null>(null)
const camD = ref(OVERVIEW_CAM_D)
const lookX = ref(SVG_W / 2)
const lookY = ref(SVG_H / 2)

// ── Root layout mode ──────────────────────────────────────────────────────────
// 'regions' groups roots into labelled areas (the half-step toward product-area
// regions — grouped by lifecycle stage for now). 'grid' is a tidy, dense grid.
// 'ring' is the original single circle. Persisted so the choice sticks.
// Flow modes render the product-space map (FlowSpaceView); grid/ring render the
// cosmos. 'user-flow' / 'data-flow' are the real "regions of the product".
type LayoutMode = 'user-flow' | 'data-flow' | 'grid' | 'ring'
const LAYOUT_MODES: Array<{ id: LayoutMode; label: string }> = [
  { id: 'user-flow', label: 'USER FLOWS' },
  { id: 'data-flow', label: 'DATA FLOWS' },
  { id: 'grid', label: 'GRID' },
  { id: 'ring', label: 'RING' },
]
const VALID_MODES = new Set<LayoutMode>(['user-flow', 'data-flow', 'grid', 'ring'])
function loadLayoutMode(): LayoutMode {
  const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('cosmos-layout-mode') : null
  return saved && VALID_MODES.has(saved as LayoutMode) ? (saved as LayoutMode) : 'grid'
}
const layoutMode = ref<LayoutMode>(loadLayoutMode())
const isFlowMode = computed(() => layoutMode.value === 'user-flow' || layoutMode.value === 'data-flow')
// The on-disk space definition (.meta/plan/.spaces/*.json via the cabinet).
// Null until loaded or if no definition exists for this lens yet.
const flowSpace = computed<ProductSpace | null>(() => {
  if (layoutMode.value !== 'user-flow' && layoutMode.value !== 'data-flow') return null
  return loadedSpaces.value[layoutMode.value] ?? null
})
const spacesLoaded = ref(false)

// Plan nodes that have been placed in the active flow space, with the locations/
// flows they touch. Colour carries their existing status.
const placedFlowNodes = computed(() => {
  const space = flowSpace.value
  if (!space) return []
  const out: Array<{ id: string; title: string; color: string; locationIds: string[]; flowIds: string[] }> = []
  for (const item of Object.values(items.value)) {
    const place = item.places?.[space.kind]
    if (!place || !(place.locationIds?.length)) continue
    out.push({
      id: item.id,
      title: item.title,
      color: SC[itemStatus(item)].glow,
      locationIds: place.locationIds,
      flowIds: place.flowIds ?? [],
    })
  }
  return out
})
function setLayoutMode(mode: LayoutMode) {
  layoutMode.value = mode
  try { localStorage.setItem('cosmos-layout-mode', mode) } catch { /**/ }
  if (!focusedRootId.value && !isFlowMode.value) frameOverview()
}

// MAIN aggregates plan/main across every lair-registered work repo — there is
// no single "the" plan repo (a lair can register any number of them), so we
// fetch the repo list once, then list-roots/get-subtree per repo explicitly.
// An experiment scope instead targets exactly one repo (the one it was
// created in) at its variation's trunkBranch, via the `trunk` param plan
// list-roots/get-subtree/sync gained alongside `repo`.
function freshenPlanMirrorsInBackground(repoNames: string[], trunk?: string) {
  for (const repo of repoNames) {
    // oxlint-disable-next-line no-empty-function -- best-effort background refresh; a failed sync just leaves the mirror stale until the next one
    void callMCPThroneRaw<{ action: string }>('plan', { action: 'sync', repo, ...(trunk ? { trunk } : {}) }).catch(() => {})
  }
}

/**
 * Loads root/subtree items for the current scope (MAIN, or an experiment
 * variation's own trunk) into items/mainItems. Split out from loadAll so
 * changing scope doesn't re-fetch wings/experiments/spaces every time.
 */
async function loadScopeItems() {
  loading.value = true; error.value = null
  try {
    const scope = currentScope.value
    const repoNames = scope ? [scope.repo] : await getWorkRepoNames()
    freshenPlanMirrorsInBackground(repoNames, scope?.variation.trunkBranch)
    const perRepoRoots = await Promise.all(
      repoNames.map(repo => callMCPThroneRaw<PlanResult>('plan', {
        action: 'list-roots', repo, ...(scope ? { trunk: scope.variation.trunkBranch } : {}),
      }))
    )
    const ids: string[] = []
    const rootRepo: Record<string, string> = {}
    perRepoRoots.forEach((listResult, i) => {
      if (listResult.action !== 'list-roots') return
      for (const r of listResult.roots) { ids.push(r.id); rootRepo[r.id] = repoNames[i] }
    })
    rootIds.value = ids
    const subtrees = await Promise.all(
      ids.map(id => callMCPThroneRaw<PlanResult>('plan', {
        action: 'get-subtree', itemId: id, includeDetails: true, repo: rootRepo[id],
        ...(scope ? { trunk: scope.variation.trunkBranch } : {}),
      }))
    )
    const merged: Record<string, PlanItemRecord> = {}
    const repoOfItem: Record<string, string> = {}
    subtrees.forEach((r, i) => {
      if (r.action !== 'get-subtree' || !r.subtree) return
      Object.assign(merged, r.subtree.items)
      for (const itemId of Object.keys(r.subtree.items)) repoOfItem[itemId] = rootRepo[ids[i]]
    })
    items.value = merged
    itemRepo.value = repoOfItem
    mainItems.value = { ...merged }
    mainRootIds.value = [...ids]
    frameOverview()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to load plans'
  } finally { loading.value = false }
}

const repoNames = ref<string[]>([])

async function loadAll() {
  repoNames.value = await getWorkRepoNames()
  await Promise.all([loadScopeItems(), loadExperiments(repoNames.value), loadWings()])
  loadSpaces(repoNames.value[0])
}

// Load product-space definitions from disk (via the cabinet). Falls back silently
// to the in-code seed (see flowSpace) if unavailable. Spaces are a single
// cross-cutting definition, not per-item, so they're read from one repo
// (the first lair-registered work repo) rather than merged across all of them.
async function loadSpaces(repo?: string) {
  if (!repo) { spacesLoaded.value = true; return }
  try {
    const r = await callMCPThroneRaw<PlanResult>('plan', { action: 'get-spaces', repo })
    if (r.action === 'get-spaces' && r.spaces) {
      loadedSpaces.value = r.spaces as unknown as Record<string, ProductSpace>
    }
  } catch { /* leaves an empty-state in flow modes */ }
  finally { spacesLoaded.value = true }
}

onMounted(loadAll)

// ── Projection ────────────────────────────────────────────────────────────────

function project(px: number, py: number): { x: number; y: number; scale: number } | null {
  const dx = px - lookX.value, dy = py - lookY.value
  const depth = dy * sinT + camD.value
  if (depth < 1) return null
  const s = FOCAL / depth
  return { x: SVG_W / 2 + dx * s, y: SVG_H / 2 - dy * cosT * s, scale: s }
}

// ── Pan animation ─────────────────────────────────────────────────────────────

let panAnimId = 0
function smoothPanTo(targetLX: number, targetLY: number, ms = 380) {
  cancelAnimationFrame(panAnimId)
  const startLX = lookX.value, startLY = lookY.value, t0 = Date.now()
  const tick = () => {
    const p = Math.min(1, (Date.now() - t0) / ms)
    const e = 1 - (1 - p) ** 3
    lookX.value = startLX + (targetLX - startLX) * e
    lookY.value = startLY + (targetLY - startLY) * e
    if (p < 1) panAnimId = requestAnimationFrame(tick)
  }
  panAnimId = requestAnimationFrame(tick)
}

// ── View mode ─────────────────────────────────────────────────────────────────

const focusedRootId = ref<string | null>(null)

function zoomInto(id: string) {
  focusedRootId.value = id; selId.value = null
  frameFocusedRoot(id)
}

/**
 * Frames a focused subtree on its root at a fixed, legible zoom rather than
 * fitting the whole tree.
 *
 * A deep tidy tree is far larger than the viewport; fitting all of it shrinks
 * nodes until they pile on top of one another. Instead we hold a comfortable
 * zoom where node spacing stays readable and anchor on the root — the natural
 * orientation point — so the user can pan/scroll along the branches to explore.
 * The root is biased toward the left third so the tree, which flows rightward
 * (and downward) from it, has room to be seen.
 */
function frameFocusedRoot(id: string): void {
  camD.value = SUBGRAPH_CAM_D
  const rp = dataLayout.value[id]
  if (!rp) { lookX.value = SVG_W / 2; lookY.value = SVG_H / 2; return }
  // Place the root ~22% from the left edge; keep it vertically centred (the tidy
  // layout already centres the root within its subtree's breadth).
  lookX.value = rp.x + 0.28 * SVG_W * camD.value / FOCAL
  lookY.value = rp.y
}

function backToOverview() {
  focusedRootId.value = null; selId.value = null
  frameOverview()
}

/**
 * Camera distance that keeps every root node inside the viewport.
 *
 * computeRootRadialLayout grows the ring radius with the root count to avoid
 * overlap, so a fixed camD only fits a handful of roots — beyond that the ring
 * projects entirely off-screen. fitRadialCamDistance solves for the minimum camD
 * that keeps the whole ring on screen. Floored at OVERVIEW_CAM_D so the original
 * look is preserved for a small number of roots.
 */
function fitOverviewCamD(): number {
  return fitRadialCamDistance(overviewLayout.value, {
    width: SVG_W, height: SVG_H, focal: FOCAL, tilt: CAM_TILT,
    marginX: 150, marginY: 120, minCamD: OVERVIEW_CAM_D,
  })
}

/**
 * Frames the overview camera for the active layout, centred on the canvas.
 *
 * Ring fits the whole circle on screen (its historical behaviour). Grid and
 * Regions instead hold a comfortable fixed zoom so nodes stay legible — the
 * layout deliberately extends past the viewport and the user pans to explore,
 * guided by the off-screen edge indicators.
 */
function frameOverview(): void {
  lookX.value = SVG_W / 2
  lookY.value = SVG_H / 2
  camD.value = layoutMode.value === 'ring' ? fitOverviewCamD() : OVERVIEW_CAM_D
}

// ── Layout ────────────────────────────────────────────────────────────────────

function reachableItems(rootId: string): Record<string, PlanItemRecord> {
  const visited = new Set<string>(), q = [rootId]
  while (q.length) {
    const id = q.shift()
    if (id === undefined || visited.has(id)) continue
    visited.add(id)
    const item = items.value[id]
    if (item) {
      for (const c of [...(item.children ?? []), ...(item.requires ?? [])]) q.push(c)
    }
    // In overlay mode, also traverse the main version's edges so removed items are reachable
    if (overlayWing.value) {
      const mainItem = mainItems.value[id]
      if (mainItem) {
        for (const c of [...(mainItem.children ?? []), ...(mainItem.requires ?? [])]) q.push(c)
      }
    }
  }
  const out: Record<string, PlanItemRecord> = {}
  for (const id of visited) {
    if (!items.value[id]) continue
    if (overlayWing.value && mainItems.value[id]) {
      // Merge children/requires from both versions so removed items get positioned by the layout
      const main = mainItems.value[id], wing = items.value[id]
      const allChildren = [...new Set([...(main.children ?? []), ...(wing.children ?? [])])]
      const allRequires = [...new Set([...(main.requires ?? []), ...(wing.requires ?? [])])]
      out[id] = { ...wing, children: allChildren, requires: allRequires }
    } else {
      out[id] = items.value[id]
    }
  }
  return out
}

// Active overview layout for the chosen mode (grid or ring). Flow modes render
// the product-space map instead and don't use this.
const overviewLayout = computed<Record<string, NodePosition>>(() => {
  const opts = { width: SVG_W, height: SVG_H, marginX: 0, marginY: 0 }
  if (layoutMode.value === 'grid') return computeRootGridLayout(rootIds.value, opts)
  return computeRootRadialLayout(rootIds.value, opts)
})

// ── Off-screen indicators ─────────────────────────────────────────────────────
// Clamp a ray from the viewport centre to the inset viewport rectangle, so a
// marker can sit on the edge pointing toward off-screen content.
function clampToEdge(px: number, py: number, inset: number): { x: number; y: number; angle: number } | null {
  const cx = SVG_W / 2, cy = SVG_H / 2
  const dx = px - cx, dy = py - cy
  if (dx === 0 && dy === 0) return null
  const hx = SVG_W / 2 - inset, hy = SVG_H / 2 - inset
  const k = Math.max(Math.abs(dx) / hx, Math.abs(dy) / hy)
  return { x: cx + dx / k, y: cy + dy / k, angle: Math.atan2(dy, dx) }
}

function isOnScreen(x: number, y: number): boolean {
  return x >= 0 && x <= SVG_W && y >= 0 && y <= SVG_H
}

interface EdgeMarker { x: number; y: number; angle: number; color: string; count: number }

// One arrow per off-screen root, deduplicated by edge cell so a cluster of
// off-screen nodes in the same direction reads as a single arrow + count.
const edgeNodeMarkers = computed<EdgeMarker[]>(() => {
  if (focusedRootId.value) return []
  const cells = new Map<string, EdgeMarker & { rank: number }>()
  for (const id of rootIds.value) {
    const pp = projectedPositions.value[id]
    if (!pp || isOnScreen(pp.x, pp.y)) continue
    const e = clampToEdge(pp.x, pp.y, 30)
    if (!e) continue
    const status = items.value[id] ? itemStatus(items.value[id]) : 'in-planning'
    const rank = ORBIT_PRIORITY.includes(status) ? ORBIT_PRIORITY.indexOf(status) : 99
    const key = `${Math.round(e.x / 38)},${Math.round(e.y / 38)}`
    const cell = cells.get(key)
    if (!cell) cells.set(key, { x: e.x, y: e.y, angle: e.angle, color: SC[status].glow, count: 1, rank })
    else {
      cell.count++
      if (rank < cell.rank) { cell.rank = rank; cell.color = SC[status].glow }
    }
  }
  return [...cells.values()]
})


const dataLayout = computed(() => {
  if (focusedRootId.value) {
    return computeTidyTreeLayout(reachableItems(focusedRootId.value), focusedRootId.value, {
      width: SVG_W, height: SVG_H, marginX: 0, marginY: 0, orientation: 'horizontal',
    })
  }
  return overviewLayout.value
})

const projectedPositions = computed<Record<string, { x: number; y: number; scale: number }>>(() => {
  const out: Record<string, { x: number; y: number; scale: number }> = {}
  for (const [id, dp] of Object.entries(dataLayout.value)) {
    const p = project(dp.x, dp.y)
    if (p) out[id] = p
  }
  return out
})

function baseRadius(id: string): number {
  if (!focusedRootId.value) return 65  // overview: sized for camD=1500 non-overlap
  const layer = dataLayout.value[id]?.layer ?? 2
  if (layer === 0) return 68; if (layer === 1) return 50; return 38
}
function nodeRadius(id: string): number { return baseRadius(id) }

// Near-constant label font size: large enough to read, gently scaled to node size.
function labelFs(r: number): number {
  return Math.max(12.5, Math.min(r * 0.32, 19))
}

// ── Ensure selected node is visible ──────────────────────────────────────────

function ensureNodeVisible(id: string) {
  const dp = dataLayout.value[id], pp = projectedPositions.value[id]
  if (!dp || !pp) return
  const r = nodeRadius(id) + 24
  if (pp.x < r + 50 || pp.x > SVG_W * 0.46 - r - 30 || pp.y < r + 50 || pp.y > SVG_H - r - 50) {
    smoothPanTo(dp.x + SVG_W * 0.25 * camD.value / FOCAL, dp.y)
  }
}

// ── Display nodes ─────────────────────────────────────────────────────────────

interface DisplayNode {
  item: PlanItemRecord; id: string; status: PlanDisplayStatus
  planState: PlanState; rings: ActivityRing[]
  x: number; y: number; r: number; isGhost: boolean; labelLines: string[]
}

const displayItems = computed<Record<string, PlanItemRecord>>(() =>
  focusedRootId.value ? reachableItems(focusedRootId.value) : items.value
)

const displayNodes = computed<DisplayNode[]>(() =>
  Object.values(displayItems.value)
    .filter(item => projectedPositions.value[item.id])
    .map(item => {
      const p = projectedPositions.value[item.id]
      return { item, id: item.id, status: itemStatus(item),
        planState: computePlanState(item), rings: computeActivityRings(item),
        x: p.x, y: p.y,
        r: nodeRadius(item.id), isGhost: item.type === 'option',
        labelLines: wrapLabel(item.title, 20, 3) }
    })
)

// ── Edges ─────────────────────────────────────────────────────────────────────

const treeEdges = computed(() => {
  const edges: Array<{ from: string; to: string }> = []
  for (const item of Object.values(displayItems.value))
    for (const c of item.children ?? [])
      if (projectedPositions.value[item.id] && projectedPositions.value[c])
        edges.push({ from: item.id, to: c })
  return edges
})

const requiresEdges = computed(() => {
  if (!focusedRootId.value) return []
  const edges: Array<{ from: string; to: string }> = []
  for (const item of Object.values(displayItems.value))
    for (const r of item.requires ?? [])
      if (projectedPositions.value[item.id] && projectedPositions.value[r])
        edges.push({ from: item.id, to: r })
  return edges
})

const overviewStubs = computed<Array<{ x1: number; y1: number; x2: number; y2: number; color: string }>>(() => {
  if (focusedRootId.value) return []
  const stubs: Array<{ x1: number; y1: number; x2: number; y2: number; color: string }> = []
  for (const rootId of rootIds.value) {
    const pp = projectedPositions.value[rootId], dp = dataLayout.value[rootId]
    if (!pp || !dp) continue
    const node = items.value[rootId], childCount = node?.children?.length ?? 0
    if (childCount === 0) continue
    if (!node) continue
    const color = SC[itemStatus(node)].glow, r = nodeRadius(rootId), spreadRad = Math.PI * 0.65
    for (let i = 0; i < childCount; i++) {
      const tv = childCount === 1 ? 0.5 : i / (childCount - 1)
      const angle = Math.atan2(SVG_H / 2 - dp.y, SVG_W / 2 - dp.x) - spreadRad / 2 + tv * spreadRad
      const ep = project(dp.x + Math.cos(angle) * 140, dp.y + Math.sin(angle) * 140)
      if (!ep) continue
      const nx = pp.x - ep.x, ny = pp.y - ep.y, dist = Math.sqrt(nx*nx + ny*ny)
      if (dist < 1) continue
      stubs.push({ x1: pp.x-(nx/dist)*(r+2), y1: pp.y-(ny/dist)*(r+2), x2: ep.x, y2: ep.y, color })
    }
  }
  return stubs
})


// ── Orbital arcs ──────────────────────────────────────────────────────────────

const itemRootMap = computed<Record<string, string>>(() => {
  const map: Record<string, string> = {}
  for (const rootId of rootIds.value) {
    const q = [rootId]
    while (q.length) {
      const id = q.shift()
      if (id === undefined || map[id]) continue
      map[id] = rootId
      for (const c of items.value[id]?.children ?? []) q.push(c)
    }
  }
  return map
})

const rootOrbits = computed<Record<string, PlanDisplayStatus[]>>(() => {
  if (focusedRootId.value) return {}
  const found: Record<string, Set<PlanDisplayStatus>> = {}
  for (const [id, rootId] of Object.entries(itemRootMap.value)) {
    if (id === rootId) continue
    const s = itemStatus(items.value[id])
    if (ORBIT_PRIORITY.includes(s)) { if (!found[rootId]) found[rootId] = new Set(); found[rootId].add(s) }
  }
  const out: Record<string, PlanDisplayStatus[]> = {}
  for (const [rid, ss] of Object.entries(found)) out[rid] = ORBIT_PRIORITY.filter(s => ss.has(s)).slice(0, 3)
  return out
})

function orbitalArcPath(cx: number, cy: number, r: number, angle: number): string {
  const span = Math.PI * 0.44, end = angle + span
  return `M ${cx+Math.cos(angle)*r},${cy+Math.sin(angle)*r} A ${r},${r} 0 0 1 ${cx+Math.cos(end)*r},${cy+Math.sin(end)*r}`
}

// ── Edge paths ────────────────────────────────────────────────────────────────

function ep(fromId: string, toId: string): string {
  const f = projectedPositions.value[fromId], tgt = projectedPositions.value[toId]
  if (!f || !tgt) return ''
  const dx = tgt.x-f.x, dy = tgt.y-f.y, dist = Math.sqrt(dx*dx+dy*dy)
  if (dist < 1) return ''
  const nx = dx/dist, ny = dy/dist, fr = nodeRadius(fromId), tr = nodeRadius(toId)
  const x1 = f.x+nx*(fr+2), y1 = f.y+ny*(fr+2), x2 = tgt.x-nx*(tr+12), y2 = tgt.y-ny*(tr+12)
  return `M ${x1},${y1} Q ${(x1+x2)/2+ny*dist*.06},${(y1+y2)/2-nx*dist*.06} ${x2},${y2}`
}

// ── Animation loop ────────────────────────────────────────────────────────────

const t = ref(0)
let raf = 0
const t0 = Date.now()
onMounted(() => { const loop = () => { t.value=(Date.now()-t0)/1000; raf=requestAnimationFrame(loop) }; raf=requestAnimationFrame(loop) })
onUnmounted(() => { cancelAnimationFrame(raf); cancelAnimationFrame(panAnimId) })

function vr(id: string, rings: ActivityRing[]): number {
  const r = nodeRadius(id)
  if (rings.includes('blocked'))      return r + 4.5*Math.abs(Math.sin(t.value*2.8))
  if (rings.includes('implementing')) return r + 3.0*Math.abs(Math.sin(t.value*1.3))
  if (rings.includes('to-demo'))      return r + 2.0*Math.abs(Math.sin(t.value*.65))
  return r
}

// ── Pan / Zoom ────────────────────────────────────────────────────────────────

const panning = ref(false)
const panStart = ref({ mx:0,my:0,lx:0,ly:0,d:0,rw:1,rh:1 })
let dragMoved = false

function onSvgMouseDown(e: MouseEvent) {
  if (e.button!==0) return; cancelAnimationFrame(panAnimId); dragMoved=false; panning.value=true
  const rect = (document.getElementById('cosmos-svg') as SVGSVGElement|null)?.getBoundingClientRect()
  panStart.value = { mx:e.clientX,my:e.clientY,lx:lookX.value,ly:lookY.value,d:camD.value,rw:rect?.width??1,rh:rect?.height??1 }
}
function onSvgMouseMove(e: MouseEvent) {
  if (!panning.value) return; dragMoved=true
  const { mx,my,lx,ly,d,rw,rh } = panStart.value
  lookX.value = lx - (e.clientX-mx)/rw*SVG_W*d/FOCAL
  lookY.value = ly + (e.clientY-my)/rh*SVG_H*d/(cosT*FOCAL)
}
function onSvgMouseUp() { panning.value=false; dragMoved=false }
function onWheel(e: WheelEvent) { e.preventDefault(); camD.value=Math.max(150,Math.min(4000,camD.value*(e.deltaY>0?1.12:.89))) }

// ── Selection / feed ──────────────────────────────────────────────────────────

const selId = ref<string|null>(null)
const selNode = computed(() => selId.value ? items.value[selId.value] : null)
const selPlanState = computed(() => selNode.value ? computePlanState(selNode.value) : 'done' as PlanState)
const selRings = computed(() => selNode.value ? computeActivityRings(selNode.value) : [] as ActivityRing[])
const feedOpen = ref(true)
const selDetails = ref(''); const selContext = ref(''); const selDetailsLoading = ref(false)

const parsedDetails = computed(() => {
  if (!selDetails.value) return ''
  try { const r = marked.parse(selDetails.value); return typeof r==='string'?r:'' } catch { return selDetails.value }
})

const parsedContext = computed(() => {
  if (!selContext.value) return ''
  try { const r = marked.parse(selContext.value); return typeof r==='string'?r:'' } catch { return selContext.value }
})

async function loadDetails(id: string) {
  selDetailsLoading.value=true; selDetails.value=''; selContext.value=''
  try {
    const r = overlayWing.value
      ? await callMCPHenchery<PlanResult>(overlayWing.value, 'plan', {action:'get-subtree',itemId:id})
      : await callMCPThroneRaw<PlanResult>('plan', {action:'get-subtree',itemId:id,repo:itemRepo.value[id]})
    if(r.action==='get-subtree') {
      selDetails.value=r.details??''
      selContext.value=r.parentContext??''
    }
  }
  catch{/**/} finally { selDetailsLoading.value=false }
}

function onNodeClick(id: string) {
  if (dragMoved) return
  if (!focusedRootId.value && rootIds.value.includes(id)) { zoomInto(id); return }
  if (selId.value===id) { selId.value=null; selDetails.value='' }
  else { selId.value=id; loadDetails(id); ensureNodeVisible(id) }
}

const feedAlerts = computed(() =>
  Object.values(items.value).filter(i=>(i.questions?.length??0)>0||!!i.demoLink).slice(0,5).map(i => {
    const s=itemStatus(i); return { id:i.id,status:s,label:i.title.slice(0,30), msg:s==='blocked'?'Awaiting your answer':'Ready for your review' }
  })
)

const connectedNodes = computed(() => {
  if (!selNode.value) return []
  const sn = selNode.value, r: Array<{ id:string;title:string;relation:string }> = []
  for (const c of sn.children??[]) if (items.value[c]) r.push({id:c,title:items.value[c].title,relation:'→ child'})
  for (const c of sn.requires??[]) if (items.value[c]) r.push({id:c,title:items.value[c].title,relation:'requires'})
  return r.slice(0,8)
})

watch(selId, (newId, oldId) => {
  if (!newId && oldId) {
    const dp = dataLayout.value[oldId]
    if (dp) smoothPanTo(dp.x, dp.y)
  }
})

const copiedId = ref<string | null>(null)
async function copyId(id: string) {
  try {
    await navigator.clipboard.writeText(id)
    copiedId.value = id
    setTimeout(() => { if (copiedId.value === id) copiedId.value = null }, 1500)
  } catch { /**/ }
}

const approving = ref(false)

async function refreshSubtree(id: string) {
  const r = await callMCPThroneRaw<PlanResult>('plan', { action: 'get-subtree', itemId: id, repo: itemRepo.value[id] })
  if (r.action === 'get-subtree' && r.subtree) {
    items.value = { ...items.value, ...r.subtree.items }
    mainItems.value = { ...mainItems.value, ...r.subtree.items }
  }
}

async function setApproved(id: string, approved: true | false | 'tentative') {
  if (approving.value) return
  approving.value = true
  try {
    await callMCPThroneRaw('plan', { action: 'update-item', itemId: id, approved, repo: itemRepo.value[id] })
    await refreshSubtree(id)
    const title = items.value[id]?.title ?? id
    if (approved !== false) recordOp(approved === true ? 'approve' : 'plan-done', title)
  } catch (e) {
    console.error('Failed to set approval:', e)
  } finally {
    approving.value = false
  }
}

async function setReady(id: string, ready: boolean) {
  if (approving.value) return
  approving.value = true
  try {
    await callMCPThroneRaw('plan', { action: 'update-item', itemId: id, ready, repo: itemRepo.value[id] })
    await refreshSubtree(id)
  } catch (e) {
    console.error('Failed to set ready:', e)
  } finally {
    approving.value = false
  }
}

const completing = ref(false)

async function completeItem(id: string) {
  if (completing.value) return
  completing.value = true
  try {
    await callMCPThroneRaw('plan', { action: 'delete-subtree', itemId: id, repo: itemRepo.value[id] })
    if (selId.value === id) selId.value = null
    await loadAll()
  } catch (e) {
    console.error('Failed to complete item:', e)
  } finally {
    completing.value = false
  }
}

// ── Field-level diff for selected node ─────────────────────────────────────────

const selDiffStatus = computed<'added' | 'removed' | 'modified' | 'unchanged' | null>(() => {
  if (!overlayWing.value || !selId.value) return null
  return diffStatus.value[selId.value] ?? null
})

type FieldDiff<T> = { main: T; wing: T } | null

const nodeDiff = computed<{
  title: FieldDiff<string>
  type: FieldDiff<string>
  parent: FieldDiff<string | null>
  requires: { added: string[]; removed: string[] } | null
  details: FieldDiff<string>
  parentContext: FieldDiff<string>
  approved: FieldDiff<PlanItemRecord['approved']>
  ready: FieldDiff<boolean | undefined>
  started: FieldDiff<boolean | undefined>
  onPath: FieldDiff<boolean | undefined>
  claimedBy: FieldDiff<PlanItemRecord['claimedBy']>
  demoLink: FieldDiff<string | undefined>
  questions: { added: string[]; removed: string[] } | null
  exploring: FieldDiff<Record<string, string> | undefined>
} | null>(() => {
  if (!overlayWing.value || !selId.value) return null
  if (selDiffStatus.value !== 'modified') return null
  const m = mainItems.value[selId.value]
  const w = wingItems.value[selId.value]
  if (!m || !w) return null

  const mainReqs = new Set(m.requires ?? [])
  const wingReqs = new Set(w.requires ?? [])
  const addedReqs = (w.requires ?? []).filter(r => !mainReqs.has(r))
  const removedReqs = (m.requires ?? []).filter(r => !wingReqs.has(r))

  const mainQs = new Set(m.questions ?? [])
  const wingQs = new Set(w.questions ?? [])
  const addedQs = (w.questions ?? []).filter(q => !mainQs.has(q))
  const removedQs = (m.questions ?? []).filter(q => !wingQs.has(q))

  return {
    title:         m.title !== w.title ? { main: m.title, wing: w.title } : null,
    type:          m.type !== w.type ? { main: m.type, wing: w.type } : null,
    parent:        m.parent !== w.parent ? { main: m.parent, wing: w.parent } : null,
    requires:      addedReqs.length || removedReqs.length ? { added: addedReqs, removed: removedReqs } : null,
    details:       (m.details ?? '') !== (w.details ?? '') ? { main: m.details ?? '', wing: w.details ?? '' } : null,
    parentContext: (m.parentContext ?? '') !== (w.parentContext ?? '') ? { main: m.parentContext ?? '', wing: w.parentContext ?? '' } : null,
    approved:      m.approved !== w.approved ? { main: m.approved, wing: w.approved } : null,
    ready:         m.ready !== w.ready ? { main: m.ready, wing: w.ready } : null,
    started:       m.started !== w.started ? { main: m.started, wing: w.started } : null,
    onPath:        m.onPath !== w.onPath ? { main: m.onPath, wing: w.onPath } : null,
    claimedBy:     JSON.stringify(m.claimedBy) !== JSON.stringify(w.claimedBy) ? { main: m.claimedBy, wing: w.claimedBy } : null,
    demoLink:      m.demoLink !== w.demoLink ? { main: m.demoLink, wing: w.demoLink } : null,
    questions:     addedQs.length || removedQs.length ? { added: addedQs, removed: removedQs } : null,
    exploring:     JSON.stringify(m.exploring) !== JSON.stringify(w.exploring) ? { main: m.exploring, wing: w.exploring } : null,
  }
})

// ── Branch overlay ─────────────────────────────────────────────────────────────

const overlayWing = ref<string | null>(null)
const overlayLoading = ref(false)
const mainItems = ref<Record<string, PlanItemRecord>>({})
const mainRootIds = ref<string[]>([])
const wingItems = ref<Record<string, PlanItemRecord>>({})
const availableWings = ref<Array<{ name: string; branch: string }>>([])
const wingDropdownOpen = ref(false)
const wingDropdownBtn = ref<HTMLElement | null>(null)
const wingMenuPos = ref({ top: 0, left: 0 })

// Dropdown panels here are teleported to <body> (see template) so an open
// panel always paints above every other floating control, regardless of
// DOM/sibling order — two same-z-index absolutely-positioned selector
// buttons next to each other would otherwise have the later one's whole
// stacking context (panel included) paint over the earlier one's panel.
function toggleWingDropdown() {
  if (!wingDropdownOpen.value && wingDropdownBtn.value) {
    const r = wingDropdownBtn.value.getBoundingClientRect()
    wingMenuPos.value = { top: r.bottom + 6, left: r.left }
  }
  wingDropdownOpen.value = !wingDropdownOpen.value
}

// ── Experiment scope ─────────────────────────────────────────────────────────
// MAIN is the default/"none" experiment (scope = null). Choosing a variation
// re-targets loadScopeItems at that variation's own trunk-level plan/<trunk>
// mirror instead of plan/main, and narrows the wing-overlay list (below) to
// that variation's member wings.

interface ExperimentVariation { slug: string; trunkBranch: string; wings: string[] }
interface ExperimentRecord { id: string; status: 'open' | 'completing' | 'resolved'; variations: ExperimentVariation[]; winner: string | null }

const experiments = ref<Array<ExperimentRecord & { repo: string }>>([])
const scopeExperimentId = ref<string | null>(null)
const scopeSlug = ref<string | null>(null)
const scopeDropdownOpen = ref(false)
const scopeDropdownBtn = ref<HTMLElement | null>(null)
const scopeMenuPos = ref({ top: 0, left: 0 })

function toggleScopeDropdown() {
  if (!scopeDropdownOpen.value && scopeDropdownBtn.value) {
    const r = scopeDropdownBtn.value.getBoundingClientRect()
    scopeMenuPos.value = { top: r.bottom + 6, left: r.left }
  }
  scopeDropdownOpen.value = !scopeDropdownOpen.value
}

const currentScope = computed<{ repo: string; experiment: ExperimentRecord; variation: ExperimentVariation } | null>(() => {
  if (!scopeExperimentId.value) return null
  const experiment = experiments.value.find(e => e.id === scopeExperimentId.value)
  const variation = experiment?.variations.find(v => v.slug === scopeSlug.value)
  return experiment && variation ? { repo: experiment.repo, experiment, variation } : null
})

// Wings offered by the overlay dropdown (below): every plan-having wing when
// scope is MAIN (unchanged historical behavior), or just the current
// variation's member wings when an experiment scope is active.
const scopedWings = computed(() => {
  const scope = currentScope.value
  if (!scope) return availableWings.value
  const members = new Set(scope.variation.wings)
  return availableWings.value.filter(w => members.has(w.name))
})

async function loadExperiments(repoNames: string[]) {
  try {
    const perRepo = await Promise.all(
      repoNames.map(repo => callMCPThroneRaw<{ action: string; experiments: ExperimentRecord[] }>('experiments', { action: 'list', repo }))
    )
    const all: Array<ExperimentRecord & { repo: string }> = []
    perRepo.forEach((r, i) => {
      if (r.action !== 'list') return
      for (const e of r.experiments) all.push({ ...e, repo: repoNames[i] })
    })
    experiments.value = all
  } catch { /* leaves scope picker MAIN-only */ }
}

// Manual "start experiment" form — the conductor will do this automatically
// eventually, but until it exists this is the only way to cut variation
// trunk branches for a plan fork.
const newExperimentOpen = ref(false)
const newExperimentId = ref('')
const newExperimentVariations = ref('')
const newExperimentRepo = ref('')
const newExperimentBusy = ref(false)
const newExperimentError = ref<string | null>(null)

function toggleNewExperimentForm() {
  newExperimentOpen.value = !newExperimentOpen.value
  newExperimentError.value = null
  if (newExperimentOpen.value && !newExperimentRepo.value) newExperimentRepo.value = repoNames.value[0] ?? ''
}

async function createNewExperiment() {
  const id = newExperimentId.value.trim()
  const slugs = [...new Set(newExperimentVariations.value.split(',').map(s => s.trim()).filter(Boolean))]
  const repo = newExperimentRepo.value
  if (!id) { newExperimentError.value = 'Experiment id is required'; return }
  if (slugs.length === 0) { newExperimentError.value = 'At least one variation slug is required'; return }
  if (!repo) { newExperimentError.value = 'No repo available to create the experiment in'; return }

  newExperimentBusy.value = true
  newExperimentError.value = null
  try {
    await callMCPThroneRaw<{ action: string }>('experiments', {
      action: 'create', id, repo, variations: slugs.map(slug => ({ slug })),
    })
    newExperimentId.value = ''
    newExperimentVariations.value = ''
    newExperimentOpen.value = false
    await loadExperiments(repoNames.value)
    setScope(id, slugs[0])
  } catch (e) {
    newExperimentError.value = e instanceof Error ? e.message : 'Failed to create experiment'
  } finally {
    newExperimentBusy.value = false
  }
}

async function setScope(experimentId: string | null, slug: string | null) {
  scopeExperimentId.value = experimentId
  scopeSlug.value = slug
  scopeDropdownOpen.value = false
  clearOverlay()
  await loadScopeItems()
}

type DiffStatus = 'added' | 'removed' | 'modified' | 'unchanged'

function requiresKey(r: string[]): string {
  return [...r].sort().join(',')
}

const diffStatus = computed<Record<string, DiffStatus>>(() => {
  if (!overlayWing.value) return {}
  const result: Record<string, DiffStatus> = {}
  for (const id of Object.keys(wingItems.value)) {
    if (!mainItems.value[id]) {
      result[id] = 'added'
    } else {
      const m = mainItems.value[id], w = wingItems.value[id]
      const changed =
        m.title !== w.title ||
        m.type !== w.type ||
        (m.details ?? '') !== (w.details ?? '') ||
        (m.parentContext ?? '') !== (w.parentContext ?? '') ||
        m.parent !== w.parent ||
        requiresKey(m.requires ?? []) !== requiresKey(w.requires ?? [])
      result[id] = changed ? 'modified' : 'unchanged'
    }
  }
  for (const id of Object.keys(mainItems.value)) {
    if (!wingItems.value[id]) result[id] = 'removed'
  }
  return result
})

async function loadWings() {
  try {
    const r = await callMCPThroneRaw<PlanResult>('plan', { action: 'list-wings' })
    if (r.action === 'list-wings') availableWings.value = r.wings
  } catch { /**/ }
}

async function loadWingOverlay(wingName: string) {
  overlayLoading.value = true
  try {
    const listResult = await callMCPHenchery<PlanResult>(wingName, 'plan', { action: 'list-roots' })
    if (listResult.action !== 'list-roots') return
    const ids = listResult.roots.map(r => r.id)
    const subtrees = await Promise.all(
      ids.map(id => callMCPHenchery<PlanResult>(wingName, 'plan', { action: 'get-subtree', itemId: id, includeDetails: true }))
    )
    const merged: Record<string, PlanItemRecord> = {}
    for (const r of subtrees) {
      if (r.action === 'get-subtree' && r.subtree) Object.assign(merged, r.subtree.items)
    }
    wingItems.value = merged
    const unionIds = [...mainRootIds.value, ...ids.filter(id => !mainRootIds.value.includes(id))]
    rootIds.value = unionIds
    items.value = { ...mainItems.value, ...merged }
    overlayWing.value = wingName
    if (!focusedRootId.value) frameOverview()
  } catch (e) {
    console.error('Failed to load wing overlay:', e)
  } finally {
    overlayLoading.value = false
  }
}

function clearOverlay() {
  overlayWing.value = null
  wingItems.value = {}
  items.value = { ...mainItems.value }
  rootIds.value = [...mainRootIds.value]
  if (!focusedRootId.value) frameOverview()
}
</script>

<template>
  <div style="position:relative;width:100%;height:100%;min-height:500px;overflow:hidden;background:#020509;font-family:'Inter',system-ui,sans-serif;user-select:none"
    @mousemove="onSvgMouseMove" @mouseup="onSvgMouseUp">

    <div v-if="loading" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;z-index:50;background:#020509">
      <span style="color:#94a3b8;font-size:15px;letter-spacing:.1em">LOADING…</span>
    </div>
    <div v-else-if="error" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">
      <span style="color:#ef4444;font-size:14px">{{ error }}</span>
    </div>

    <!-- Nebula -->
    <div style="position:absolute;inset:0;pointer-events:none" v-if="!loading && !error">
      <div v-for="(c,i) in [{cx:'22%',cy:'60%',col:'rgba(245,158,11,.032)',r:'45%'},{cx:'75%',cy:'38%',col:'rgba(34,197,94,.024)',r:'40%'},{cx:'50%',cy:'18%',col:'rgba(168,85,247,.02)',r:'35%'}]" :key="i"
        :style="`position:absolute;left:${c.cx};top:${c.cy};width:${c.r};height:${c.r};transform:translate(-50%,-50%);border-radius:50%;background:radial-gradient(ellipse,${c.col} 0%,transparent 70%)`"/>
    </div>

    <button v-if="focusedRootId&&!loading" @click="backToOverview"
      style="position:absolute;top:16px;left:16px;z-index:25;background:rgba(4,7,16,.9);backdrop-filter:blur(8px);
        border:1px solid rgba(255,255,255,.2);color:#e2e8f0;padding:8px 18px;border-radius:6px;
        cursor:pointer;font-size:13px;font-weight:700;letter-spacing:.08em;font-family:inherit">
      ← ALL PLANS
    </button>

    <!-- Experiment scope selector — MAIN is the default/"none" experiment -->
    <div v-if="!loading&&!error&&!isFlowMode" style="position:absolute;top:64px;left:16px;z-index:26;font-family:inherit">
      <button ref="scopeDropdownBtn" @click="toggleScopeDropdown"
        :style="`background:rgba(4,7,16,.9);backdrop-filter:blur(8px);
          border:1px solid ${currentScope?'rgba(168,85,247,.4)':'rgba(255,255,255,.12)'};
          color:${currentScope?'#c084fc':'#64748b'};padding:6px 13px;border-radius:6px;cursor:pointer;
          font-size:10px;font-weight:700;letter-spacing:.12em;font-family:inherit;
          display:flex;align-items:center;gap:7px`">
        <span>⬡</span>
        <span>{{ currentScope ? `${currentScope.experiment.id.toUpperCase()} / ${currentScope.variation.slug.toUpperCase()}` : 'MAIN' }}</span>
        <span style="font-size:8px;opacity:.5">▾</span>
      </button>
    </div>
    <Teleport to="body">
      <div v-if="scopeDropdownOpen" :style="`position:fixed;top:${scopeMenuPos.top}px;left:${scopeMenuPos.left}px;min-width:240px;
        background:rgba(4,7,16,.97);backdrop-filter:blur(14px);border:1px solid rgba(255,255,255,.12);
        border-radius:7px;overflow:hidden;box-shadow:0 8px 24px rgba(0,0,0,.7);z-index:1000;font-family:inherit`">
        <div @click="setScope(null,null)"
          :style="`padding:9px 14px;cursor:pointer;font-size:11px;font-weight:700;letter-spacing:.1em;
            color:${!currentScope?'#c084fc':'#94a3b8'};border-bottom:1px solid rgba(255,255,255,.07);
            display:flex;align-items:center;gap:9px`"
          @mouseenter="($event.currentTarget as HTMLElement).style.background='rgba(255,255,255,.05)'"
          @mouseleave="($event.currentTarget as HTMLElement).style.background=''">
          <span :style="`width:6px;height:6px;border-radius:50%;background:${!currentScope?'#c084fc':'#334155'};flex-shrink:0`"/>
          MAIN
        </div>
        <template v-for="exp in experiments" :key="exp.id">
          <div v-for="v in exp.variations" :key="`${exp.id}/${v.slug}`"
            @click="setScope(exp.id, v.slug)"
            :style="`padding:9px 14px;cursor:pointer;font-size:11px;
              color:${scopeExperimentId===exp.id&&scopeSlug===v.slug?'#c084fc':'#e2e8f0'};display:flex;flex-direction:column;gap:3px`"
            @mouseenter="($event.currentTarget as HTMLElement).style.background='rgba(255,255,255,.05)'"
            @mouseleave="($event.currentTarget as HTMLElement).style.background=''">
            <span style="font-weight:700;letter-spacing:.08em">{{ exp.id.toUpperCase() }} / {{ v.slug.toUpperCase() }}</span>
            <span style="font-size:10px;color:#475569;font-family:'JetBrains Mono',monospace">{{ v.trunkBranch }} · {{ exp.status }}</span>
          </div>
        </template>
        <div v-if="experiments.length===0" style="padding:10px 14px;font-size:11px;color:#475569;font-style:italic">
          No experiments in progress
        </div>

        <div style="border-top:1px solid rgba(255,255,255,.07)">
          <div v-if="!newExperimentOpen" @click="toggleNewExperimentForm"
            style="padding:9px 14px;cursor:pointer;font-size:11px;font-weight:700;letter-spacing:.08em;color:#4ade80"
            @mouseenter="($event.currentTarget as HTMLElement).style.background='rgba(255,255,255,.05)'"
            @mouseleave="($event.currentTarget as HTMLElement).style.background=''">
            + NEW EXPERIMENT
          </div>
          <div v-else style="padding:10px 14px 12px;display:flex;flex-direction:column;gap:7px" @click.stop>
            <input v-model="newExperimentId" placeholder="experiment id"
              style="background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.15);border-radius:4px;
                color:#e2e8f0;padding:6px 8px;font-size:11px;font-family:inherit;outline:none"/>
            <input v-model="newExperimentVariations" placeholder="variation slugs, comma-separated (e.g. a, b)"
              style="background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.15);border-radius:4px;
                color:#e2e8f0;padding:6px 8px;font-size:11px;font-family:inherit;outline:none"/>
            <select v-if="repoNames.length>1" v-model="newExperimentRepo"
              style="background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.15);border-radius:4px;
                color:#e2e8f0;padding:6px 8px;font-size:11px;font-family:inherit;outline:none">
              <option v-for="r in repoNames" :key="r" :value="r">{{ r }}</option>
            </select>
            <div v-if="newExperimentError" style="font-size:10px;color:#ef4444">{{ newExperimentError }}</div>
            <div style="display:flex;gap:8px">
              <button @click="createNewExperiment" :disabled="newExperimentBusy"
                style="flex:1;background:rgba(74,222,128,.15);border:1px solid rgba(74,222,128,.4);border-radius:4px;
                  color:#4ade80;padding:6px 0;font-size:10px;font-weight:700;letter-spacing:.08em;cursor:pointer;font-family:inherit">
                {{ newExperimentBusy ? 'CREATING…' : 'CREATE' }}
              </button>
              <button @click="toggleNewExperimentForm" :disabled="newExperimentBusy"
                style="background:transparent;border:1px solid rgba(255,255,255,.15);border-radius:4px;
                  color:#94a3b8;padding:6px 10px;font-size:10px;font-weight:700;letter-spacing:.08em;cursor:pointer;font-family:inherit">
                CANCEL
              </button>
            </div>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Wing overlay selector — TRUNK (the current scope's own aggregate) or one of its member wings -->
    <div v-if="!loading&&!error&&!isFlowMode" style="position:absolute;top:104px;left:16px;z-index:26;font-family:inherit">
      <button ref="wingDropdownBtn" @click="toggleWingDropdown"
        :style="`background:rgba(4,7,16,.9);backdrop-filter:blur(8px);
          border:1px solid ${overlayWing?'rgba(34,197,94,.4)':'rgba(255,255,255,.12)'};
          color:${overlayWing?'#4ade80':'#64748b'};padding:6px 13px;border-radius:6px;cursor:pointer;
          font-size:10px;font-weight:700;letter-spacing:.12em;font-family:inherit;
          display:flex;align-items:center;gap:7px`">
        <span>◎</span>
        <span>{{ overlayWing ? overlayWing.toUpperCase() : 'TRUNK' }}</span>
        <span v-if="overlayLoading" style="opacity:.6">…</span>
        <span v-else style="font-size:8px;opacity:.5">▾</span>
      </button>
    </div>
    <Teleport to="body">
      <div v-if="wingDropdownOpen" :style="`position:fixed;top:${wingMenuPos.top}px;left:${wingMenuPos.left}px;min-width:220px;
        background:rgba(4,7,16,.97);backdrop-filter:blur(14px);border:1px solid rgba(255,255,255,.12);
        border-radius:7px;overflow:hidden;box-shadow:0 8px 24px rgba(0,0,0,.7);z-index:1000;font-family:inherit`">
        <div @click="clearOverlay();wingDropdownOpen=false"
          :style="`padding:9px 14px;cursor:pointer;font-size:11px;font-weight:700;letter-spacing:.1em;
            color:${!overlayWing?'#4ade80':'#94a3b8'};border-bottom:1px solid rgba(255,255,255,.07);
            display:flex;align-items:center;gap:9px`"
          @mouseenter="($event.currentTarget as HTMLElement).style.background='rgba(255,255,255,.05)'"
          @mouseleave="($event.currentTarget as HTMLElement).style.background=''">
          <span :style="`width:6px;height:6px;border-radius:50%;background:${!overlayWing?'#4ade80':'#334155'};flex-shrink:0`"/>
          TRUNK
        </div>
        <div v-for="w in scopedWings" :key="w.name"
          @click="loadWingOverlay(w.name);wingDropdownOpen=false"
          :style="`padding:9px 14px;cursor:pointer;font-size:11px;
            color:${overlayWing===w.name?'#4ade80':'#e2e8f0'};display:flex;flex-direction:column;gap:3px`"
          @mouseenter="($event.currentTarget as HTMLElement).style.background='rgba(255,255,255,.05)'"
          @mouseleave="($event.currentTarget as HTMLElement).style.background=''">
          <span style="font-weight:700;letter-spacing:.08em">{{ w.name.toUpperCase() }}</span>
          <span style="font-size:10px;color:#475569;font-family:'JetBrains Mono',monospace">{{ w.branch }}</span>
          </div>
          <div v-if="scopedWings.length===0" style="padding:10px 14px;font-size:11px;color:#475569;font-style:italic">
            {{ currentScope ? 'No wings assigned to this variation' : 'No wings with plan data' }}
          </div>
      </div>
    </Teleport>

    <!-- Overlay banner -->
    <div v-if="overlayWing&&!loading&&!isFlowMode"
      style="position:absolute;top:16px;left:50%;transform:translateX(-50%);z-index:15;
        background:rgba(34,197,94,.08);backdrop-filter:blur(8px);
        border:1px solid rgba(34,197,94,.28);color:#4ade80;
        padding:6px 18px;border-radius:6px;font-size:10px;font-weight:700;
        letter-spacing:.13em;pointer-events:none;white-space:nowrap">
      OVERLAY · {{ overlayWing.toUpperCase() }} · {{ availableWings.find(w=>w.name===overlayWing)?.branch ?? '' }}
    </div>

    <div v-if="!focusedRootId&&!loading&&!error&&displayNodes.length>0&&!overlayWing&&!isFlowMode"
      style="position:absolute;top:18px;left:50%;transform:translateX(-50%);z-index:15;
        font-size:12px;color:#94a3b8;letter-spacing:.12em;pointer-events:none;font-weight:600">
      CLICK A PLAN TO EXPLORE
    </div>

    <!-- Product-space map (user-flow / data-flow modes) -->
    <FlowSpaceView v-if="!loading&&!error&&flowSpace" :space="flowSpace" :placed-nodes="placedFlowNodes" />

    <!-- Flow-mode empty / loading state (no in-code seed) -->
    <div v-if="!loading&&!error&&isFlowMode&&!flowSpace"
      style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;text-align:center;pointer-events:none">
      <span v-if="!spacesLoaded" style="color:#94a3b8;font-size:14px;letter-spacing:.1em">LOADING SPACE…</span>
      <template v-else>
        <span style="color:#94a3b8;font-size:14px;letter-spacing:.06em">No {{ layoutMode==='user-flow' ? 'user-flow' : 'data-flow' }} space defined yet</span>
        <span style="color:#475569;font-size:12px">Define it in <code style="font-family:'JetBrains Mono',monospace">.meta/plan/.spaces/{{ layoutMode==='user-flow' ? 'user-flows' : 'data-flows' }}.json</code></span>
      </template>
    </div>

    <!-- SVG canvas -->
    <svg v-if="!loading&&!error&&!isFlowMode" id="cosmos-svg" :viewBox="`0 0 ${SVG_W} ${SVG_H}`"
      style="position:absolute;inset:0;width:100%;height:100%"
      :style="{cursor:panning?'grabbing':'grab'}"
      @click.self="selId=null" @wheel.prevent="onWheel" @mousedown="onSvgMouseDown">
      <defs>
        <filter id="lc-bloom" x="-200%" y="-200%" width="500%" height="500%"><feGaussianBlur stdDeviation="22"/></filter>
        <filter id="lc-glow" x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="7" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
        <filter id="lc-glow-xs" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
        <radialGradient v-for="n in displayNodes.filter(n=>!n.isGhost)" :key="'g'+n.id" :id="'lc-ng-'+n.id" cx="32%" cy="28%" r="72%">
          <stop offset="0%"   :stop-color="PS[n.planState].glow" stop-opacity="0.5"/>
          <stop offset="100%" :stop-color="PS[n.planState].dim"  stop-opacity="0.98"/>
        </radialGradient>
        <marker id="lc-arr-tree" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
          <polygon points="0 0,8 3,0 6" fill="rgba(148,163,184,0.6)"/>
        </marker>
      </defs>

      <!-- Depth lines -->
      <g pointer-events="none" opacity="0.04">
        <line v-for="gy in [0.22,0.38,0.54,0.7,0.84]" :key="'gy'+gy" x1="0" :y1="SVG_H*gy" :x2="SVG_W" :y2="SVG_H*gy" stroke="white" stroke-width="0.8"/>
      </g>

      <!-- Overview: tendrils -->
      <g v-if="!focusedRootId" pointer-events="none">
        <line v-for="(s,si) in overviewStubs" :key="'s'+si" :x1="s.x1" :y1="s.y1" :x2="s.x2" :y2="s.y2"
          :stroke="s.color" stroke-width="2" stroke-linecap="round" stroke-opacity="0.28"/>
      </g>

      <!-- Overview: orbital arcs -->
      <g v-if="!focusedRootId" pointer-events="none">
        <template v-for="rootId in rootIds" :key="'orb-'+rootId">
          <template v-for="(status,ai) in (rootOrbits[rootId]??[])" :key="'a-'+rootId+'-'+status">
            <circle v-if="projectedPositions[rootId]"
              :cx="projectedPositions[rootId].x" :cy="projectedPositions[rootId].y"
              :r="nodeRadius(rootId)+18+ai*16"
              fill="none" :stroke="SC[status].glow" stroke-width="0.8" stroke-opacity="0.16"/>
            <path v-if="projectedPositions[rootId]"
              :d="orbitalArcPath(projectedPositions[rootId].x,projectedPositions[rootId].y, nodeRadius(rootId)+18+ai*16, t*ORBIT_SPEEDS[ai]+ORBIT_PHASES[ai])"
              :stroke="SC[status].glow" stroke-width="4.5" stroke-linecap="round" fill="none"
              stroke-opacity="0.9" filter="url(#lc-glow-xs)"/>
          </template>
        </template>
      </g>

      <!-- Subgraph: tree edges -->
      <g v-if="focusedRootId" pointer-events="none">
        <path v-for="e in treeEdges" :key="'t'+e.from+e.to" :d="ep(e.from,e.to)"
          :stroke="SC[itemStatus(items[e.to])].glow" stroke-opacity="0.45" stroke-width="2.5"
          fill="none" marker-end="url(#lc-arr-tree)"/>
      </g>

      <!-- Subgraph: requires edges (dashed) -->
      <g v-if="focusedRootId" pointer-events="none">
        <path v-for="e in requiresEdges" :key="'req-'+e.from+e.to" :d="ep(e.from,e.to)"
          stroke="#8b5cf6" stroke-opacity="0.55" stroke-width="2" stroke-dasharray="7,5"
          fill="none" marker-end="url(#lc-arr-tree)"/>
      </g>

      <!-- Bloom halos -->
      <circle v-for="n in displayNodes.filter(n=>!n.isGhost&&n.planState!=='imagining')" :key="'h'+n.id"
        :cx="n.x" :cy="n.y" :r="n.r*3.2" :fill="PS[n.planState].glow"
        :fill-opacity="n.rings.includes('blocked')?.09:n.rings.includes('implementing')?.07:.055"
        filter="url(#lc-bloom)" pointer-events="none"/>

      <!-- Overlay diff rings -->
      <g v-if="overlayWing" pointer-events="none">
        <circle v-for="n in displayNodes.filter(n=>diffStatus[n.id]&&diffStatus[n.id]!=='unchanged')" :key="'diff'+n.id"
          :cx="n.x" :cy="n.y" :r="vr(n.id,n.rings)+15"
          fill="none"
          :stroke="diffStatus[n.id]==='added'?'#22c55e':diffStatus[n.id]==='removed'?'#ef4444':'#f59e0b'"
          stroke-width="2" stroke-opacity="0.9" stroke-dasharray="4,4"
          filter="url(#lc-glow-xs)"/>
      </g>

      <!-- Ghost option nodes -->
      <g v-for="n in displayNodes.filter(n=>n.isGhost)" :key="'g'+n.id"
        style="cursor:pointer" @mousedown.stop @click.stop="onNodeClick(n.id)">
        <circle :cx="n.x" :cy="n.y" :r="n.r+6" fill="none" stroke="#3b82f6" stroke-opacity="0.14" stroke-width="1.2" stroke-dasharray="5,7"/>
        <circle :cx="n.x" :cy="n.y" :r="n.r" fill="rgba(59,130,246,0.04)" stroke="#3b82f6" stroke-opacity="0.24" stroke-width="1.2" stroke-dasharray="3,6"/>
        <text v-for="(line,li) in n.labelLines" :key="'gl'+li"
          :x="n.x" :y="n.y + (li - (n.labelLines.length-1)/2)*(labelFs(n.r)+3)"
          text-anchor="middle" dominant-baseline="middle"
          :font-size="labelFs(n.r)" fill="#60a5fa" fill-opacity="0.55" font-style="italic"
          stroke="#020509" :stroke-width="labelFs(n.r)*0.22" stroke-linejoin="round"
          style="paint-order:stroke">{{ line }}</text>
      </g>

      <!-- Real nodes -->
      <g v-for="n in displayNodes.filter(n=>!n.isGhost)" :key="n.id"
        :style="`cursor:pointer${overlayWing&&diffStatus[n.id]==='removed'?';opacity:0.38':''}`"
        @mousedown.stop @click.stop="onNodeClick(n.id)">
        <circle v-if="selId===n.id" :cx="n.x" :cy="n.y" :r="vr(n.id,n.rings)+16"
          fill="none" :stroke="PS[n.planState].glow" stroke-width="2.2" stroke-opacity="0.8" stroke-dasharray="5,5" filter="url(#lc-glow)"/>
        <circle :cx="n.x" :cy="n.y" :r="vr(n.id,n.rings)+10" :fill="PS[n.planState].glow" fill-opacity="0.11" filter="url(#lc-glow)"/>
        <circle :cx="n.x" :cy="n.y" :r="vr(n.id,n.rings)" :fill="'url(#lc-ng-'+n.id+')'" :stroke="PS[n.planState].glow" stroke-width="2.2" stroke-opacity="0.95"/>

        <!-- Activity rings — independent, combinable indicators around the orb.
             Plan state (orb colour) says what it IS; these say what's HAPPENING to it. -->
        <circle v-for="(ring,ri) in n.rings" :key="'ring'+ring"
          :cx="n.x" :cy="n.y" :r="vr(n.id,n.rings)+7+ri*6"
          fill="none" :stroke="RING[ring].color" stroke-width="1.8" stroke-opacity="0.85" pointer-events="none"/>

        <!-- Title — wrapped, centred on the circle centre with a dark halo for
             contrast. State is conveyed by the node's colour, so no icon or
             status-label text competes for the centre. -->
        <text v-for="(line,li) in n.labelLines" :key="'lbl'+li"
          :x="n.x" :y="n.y + (li - (n.labelLines.length-1)/2)*(labelFs(n.r)+3)"
          text-anchor="middle" dominant-baseline="middle"
          :font-size="labelFs(n.r)" fill="#f1f5f9" font-weight="700"
          stroke="#020509" :stroke-width="labelFs(n.r)*0.22" stroke-linejoin="round"
          style="paint-order:stroke">
          {{ line }}
        </text>

        <!-- Item ID — click to copy — single short line just below the circle -->
        <text :x="n.x" :y="n.y + n.r + 16"
          text-anchor="middle" font-size="12"
          :fill="copiedId===n.id ? '#4ade80' : '#94a3b8'"
          font-family="'JetBrains Mono',monospace"
          style="cursor:copy" @click.stop="copyId(n.id)">
          {{ copiedId===n.id ? '✓ copied' : n.id }}
        </text>

        <!-- Overview outer ring hint -->
        <circle v-if="!focusedRootId&&rootIds.includes(n.id)"
          :cx="n.x" :cy="n.y" :r="n.r+24"
          fill="none" :stroke="PS[n.planState].glow" stroke-width="1.2" stroke-opacity="0.16" stroke-dasharray="3,10" pointer-events="none"/>
      </g>

      <!-- Off-screen indicators — arrows + region chips pinned to the viewport edge -->
      <g v-if="!focusedRootId" pointer-events="none">
        <g v-for="(m,mi) in edgeNodeMarkers" :key="'em'+mi">
          <path d="M0,-8 L13,0 L0,8 Z"
            :transform="`translate(${m.x},${m.y}) rotate(${m.angle*180/Math.PI})`"
            :fill="m.color" fill-opacity="0.92" stroke="#020509" stroke-width="1.5" stroke-linejoin="round"
            filter="url(#lc-glow-xs)"/>
          <text v-if="m.count>1" :x="m.x - Math.cos(m.angle)*17" :y="m.y - Math.sin(m.angle)*17"
            text-anchor="middle" dominant-baseline="central" font-size="11" font-weight="700"
            :fill="m.color" stroke="#020509" stroke-width="3" stroke-linejoin="round" style="paint-order:stroke">
            {{ m.count }}
          </text>
        </g>
      </g>
    </svg>

    <!-- Feed -->
    <transition name="feed">
      <div v-if="feedOpen&&feedAlerts.length>0&&!loading&&!isFlowMode"
        style="position:absolute;top:16px;right:16px;width:260px;z-index:20;
          background:rgba(4,7,16,.95);backdrop-filter:blur(14px);
          border:1px solid rgba(255,255,255,.12);border-radius:8px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,.6)">
        <div style="padding:11px 16px;border-bottom:1px solid rgba(255,255,255,.08);display:flex;align-items:center;justify-content:space-between">
          <div style="display:flex;align-items:center;gap:9px">
            <span style="width:8px;height:8px;border-radius:50%;background:#ef4444;display:inline-block;box-shadow:0 0 8px #ef4444;animation:lc-heartbeat 1.8s ease-in-out infinite"/>
            <span style="font-size:11px;font-weight:700;letter-spacing:.15em;text-transform:uppercase;color:#94a3b8">Awaiting You</span>
          </div>
          <button @click="feedOpen=false" style="background:none;border:none;color:#64748b;cursor:pointer;font-size:15px;padding:0">✕</button>
        </div>
        <div v-for="a in feedAlerts" :key="a.id"
          style="padding:11px 16px;border-bottom:1px solid rgba(255,255,255,.05);cursor:pointer;display:flex;align-items:flex-start;gap:10px"
          @click="selId=a.id; feedOpen=false"
          @mouseenter="($event.currentTarget as HTMLElement).style.background='rgba(255,255,255,.05)'"
          @mouseleave="($event.currentTarget as HTMLElement).style.background=''">
          <span :style="`width:8px;height:8px;border-radius:50%;background:${SC[a.status].glow};flex-shrink:0;margin-top:4px;display:block;box-shadow:0 0 9px ${SC[a.status].glow}`"/>
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:600;color:#e2e8f0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ a.label }}</div>
            <div style="font-size:11px;color:#64748b;margin-top:2px">{{ a.msg }}</div>
          </div>
        </div>
      </div>
    </transition>
    <button v-if="!feedOpen&&feedAlerts.length>0&&!loading&&!isFlowMode" @click="feedOpen=true"
      style="position:absolute;top:16px;right:16px;z-index:20;background:rgba(4,7,16,.92);
        border:1px solid rgba(239,68,68,.35);color:#ef4444;padding:8px 16px;border-radius:6px;
        cursor:pointer;font-size:12px;font-weight:700;letter-spacing:.1em;font-family:inherit;
        animation:lc-heartbeat 2.2s ease-in-out infinite">
      ⚠ {{ feedAlerts.length }} AWAITING
    </button>

    <!-- Node detail panel — 50% wide, 3-zone layout -->
    <transition name="panel">
      <div v-if="selNode&&!loading"
        :style="`position:absolute;top:0;right:0;bottom:0;width:50%;z-index:30;
          background:rgba(4,7,16,.97);backdrop-filter:blur(20px);display:flex;flex-direction:column;
          overflow:hidden;box-shadow:-12px 0 42px rgba(0,0,0,.6);
          border-left:2px solid ${selDiffStatus==='added'?'#4ade80':selDiffStatus==='removed'?'#ef4444':selDiffStatus==='modified'?'#fb923c':'rgba(255,255,255,.12)'}`">

        <!-- HEADER -->
        <div style="padding:22px 26px 18px;border-bottom:1px solid rgba(255,255,255,.08);flex-shrink:0">

          <!-- Overlay diff banner -->
          <div v-if="selDiffStatus&&selDiffStatus!=='unchanged'" :style="`margin-bottom:12px;padding:5px 10px;border-radius:4px;font-size:10px;font-weight:700;letter-spacing:.14em;display:inline-flex;align-items:center;gap:7px;
            ${selDiffStatus==='added'?'background:rgba(74,222,128,.1);color:#4ade80;border:1px solid rgba(74,222,128,.3)':selDiffStatus==='removed'?'background:rgba(239,68,68,.1);color:#ef4444;border:1px solid rgba(239,68,68,.3)':'background:rgba(251,146,60,.1);color:#fb923c;border:1px solid rgba(251,146,60,.3)'}`">
            <span>{{ selDiffStatus==='added'?'✦':selDiffStatus==='removed'?'✕':'◈' }}</span>
            <span>{{ selDiffStatus==='added'?'ADDED IN WING':selDiffStatus==='removed'?'REMOVED IN WING':'MODIFIED IN WING' }}</span>
          </div>

          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:14px">
            <div style="flex:1;min-width:0">
              <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:12px">
                <!-- Orb colour: plan state (imagining / done / ready) -->
                <span :style="`display:inline-block;font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;
                  padding:4px 12px;border-radius:4px;
                  background:${PS[selPlanState].dim}cc;color:${PS[selPlanState].glow};border:1px solid ${PS[selPlanState].glow}44`">
                  {{ PS[selPlanState].label }}
                </span>
                <!-- Rings: independent, combinable activity indicators -->
                <span v-for="ring in selRings" :key="ring"
                  :style="`display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;
                    padding:3px 9px;border-radius:4px;color:${RING[ring].color};border:1px solid ${RING[ring].color}44;background:${RING[ring].color}18`">
                  <span>{{ RING[ring].icon }}</span>{{ RING[ring].label }}
                </span>
              </div>
              <!-- Title with diff -->
              <div v-if="nodeDiff?.title" style="margin-bottom:4px;font-size:12px;color:#ef4444;text-decoration:line-through;opacity:.7;word-break:break-word">{{ nodeDiff.title.main }}</div>
              <div :style="`font-size:20px;font-weight:700;line-height:1.3;word-break:break-word;${nodeDiff?.title?'color:#4ade80':'color:#f1f5f9'}`">{{ selNode.title }}</div>
            </div>
            <button @click="selId=null" style="background:none;border:none;color:#64748b;cursor:pointer;font-size:20px;flex-shrink:0;margin-top:4px;line-height:1">✕</button>
          </div>

          <!-- ID + type row -->
          <div style="margin-top:10px;font-size:11px;font-family:'JetBrains Mono',monospace;letter-spacing:.04em;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            <span @click="copyId(selNode.id)"
              :style="`cursor:copy;padding:2px 6px;border-radius:3px;transition:color .15s,background .15s;${copiedId===selNode.id?'color:#4ade80;background:rgba(74,222,128,.1)':'color:#64748b;'}`"
              :title="copiedId===selNode.id?'Copied!':'Click to copy ID'">{{ copiedId===selNode.id ? '✓ copied' : selNode.id }}</span>
            <span style="color:#334155">·</span>
            <!-- Type with diff -->
            <span v-if="nodeDiff?.type" style="color:#ef4444;text-decoration:line-through;opacity:.7">{{ nodeDiff.type.main }}</span>
            <span v-if="nodeDiff?.type" style="color:#334155">→</span>
            <span :style="nodeDiff?.type?'color:#4ade80':'color:#475569'">{{ selNode.type }}</span>
          </div>

          <!-- claimedBy -->
          <div v-if="selNode.claimedBy||nodeDiff?.claimedBy" style="margin-top:8px">
            <!-- old claimedBy (removed or changed) -->
            <div v-if="nodeDiff?.claimedBy&&nodeDiff.claimedBy.main" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;opacity:.6;text-decoration:line-through;margin-bottom:4px">
              <span style="font-size:10px;font-weight:700;letter-spacing:.12em;color:#ef4444;text-transform:uppercase">Claimed by</span>
              <span style="font-size:11px;font-family:'JetBrains Mono',monospace;color:#ef4444;padding:2px 8px;border-radius:3px;border:1px solid rgba(239,68,68,.3)">{{ nodeDiff.claimedBy.main.wing }}</span>
              <span style="font-size:11px;font-family:'JetBrains Mono',monospace;color:#ef4444">{{ nodeDiff.claimedBy.main.branch }}</span>
            </div>
            <!-- current claimedBy -->
            <div v-if="selNode.claimedBy" :style="`display:flex;align-items:center;gap:8px;flex-wrap:wrap;${nodeDiff?.claimedBy?'color:#4ade80':''}`">
              <span :style="`font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;${nodeDiff?.claimedBy?'color:#4ade80':'color:#06b6d4'}`">Claimed by</span>
              <RouterLink :to="'/wings/' + selNode.claimedBy.wing"
                :style="`font-size:11px;font-family:'JetBrains Mono',monospace;text-decoration:none;padding:2px 8px;border-radius:3px;transition:background .15s;
                  ${nodeDiff?.claimedBy?'color:#4ade80;border:1px solid rgba(74,222,128,.3);background:rgba(74,222,128,.08)':'color:#06b6d4;border:1px solid rgba(6,182,212,.3);background:rgba(6,182,212,.08)'}`"
                @mouseenter="($event.currentTarget as HTMLElement).style.background=nodeDiff?.claimedBy?'rgba(74,222,128,.18)':'rgba(6,182,212,.18)'"
                @mouseleave="($event.currentTarget as HTMLElement).style.background=nodeDiff?.claimedBy?'rgba(74,222,128,.08)':'rgba(6,182,212,.08)'">
                {{ selNode.claimedBy.wing }}
              </RouterLink>
              <span :style="`font-size:11px;font-family:'JetBrains Mono',monospace;${nodeDiff?.claimedBy?'color:#86efac':'color:#475569'}`">{{ selNode.claimedBy.branch }}</span>
            </div>
          </div>
        </div>

        <!-- SCROLLABLE BODY -->
        <div style="flex:1;overflow-y:auto;padding:0 26px 26px">

          <!-- Blocked -->
          <div v-if="selNode.questions&&selNode.questions.length>0"
            :style="`margin-top:20px;padding:16px 18px;border-radius:8px;
              ${nodeDiff?.questions?'background:rgba(251,146,60,.08);border:1px solid rgba(251,146,60,.3)':'background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.22)'}`">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:9px">
              <div style="font-size:11px;font-weight:700;letter-spacing:.12em;color:#ef4444">⚠ YOUR ANSWER NEEDED</div>
              <span v-if="nodeDiff?.questions" style="font-size:10px;font-weight:700;letter-spacing:.1em;padding:2px 7px;border-radius:3px;background:rgba(251,146,60,.12);color:#fb923c;border:1px solid rgba(251,146,60,.3)">CHANGED</span>
            </div>
            <div style="font-size:14px;color:#fca5a5;line-height:1.5;margin-bottom:8px">
              {{ selNode.questions.length }} open question{{ selNode.questions.length>1?'s':'' }} blocking this item
            </div>
            <div v-if="nodeDiff?.questions" style="font-size:11px;margin-bottom:10px;display:flex;flex-direction:column;gap:3px">
              <div v-for="q in nodeDiff.questions.added" :key="q" style="color:#4ade80;font-family:'JetBrains Mono',monospace">+ {{ q }}</div>
              <div v-for="q in nodeDiff.questions.removed" :key="q" style="color:#ef4444;text-decoration:line-through;font-family:'JetBrains Mono',monospace">− {{ q }}</div>
            </div>
            <div style="display:flex;gap:9px">
              <button style="flex:1;padding:10px;background:rgba(239,68,68,.18);border:1px solid rgba(239,68,68,.35);color:#fca5a5;border-radius:6px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit">ANSWER</button>
              <button style="flex:1;padding:10px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);color:#94a3b8;border-radius:6px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit">DELEGATE</button>
            </div>
          </div>
          <!-- Questions removed in wing -->
          <div v-else-if="nodeDiff?.questions&&nodeDiff.questions.removed.length>0"
            style="margin-top:20px;padding:12px 16px;background:rgba(239,68,68,.05);border:1px solid rgba(239,68,68,.15);border-radius:8px">
            <div style="font-size:11px;font-weight:700;letter-spacing:.12em;color:#ef4444;margin-bottom:6px">QUESTIONS RESOLVED IN WING</div>
            <div v-for="q in nodeDiff.questions.removed" :key="q" style="font-size:11px;color:#ef4444;text-decoration:line-through;font-family:'JetBrains Mono',monospace;opacity:.7">− {{ q }}</div>
          </div>

          <!-- Demo ready -->
          <div v-if="selNode.demoLink"
            :style="`margin-top:20px;padding:16px 18px;border-radius:8px;
              ${nodeDiff?.demoLink?'background:rgba(251,146,60,.08);border:1px solid rgba(251,146,60,.3)':'background:rgba(168,85,247,.08);border:1px solid rgba(168,85,247,.22)'}`">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
              <div style="font-size:11px;font-weight:700;letter-spacing:.12em;color:#a855f7">▶ READY FOR YOUR EYES</div>
              <span v-if="nodeDiff?.demoLink" style="font-size:10px;font-weight:700;letter-spacing:.1em;padding:2px 7px;border-radius:3px;background:rgba(251,146,60,.12);color:#fb923c;border:1px solid rgba(251,146,60,.3)">CHANGED</span>
            </div>
            <div v-if="nodeDiff?.demoLink?.main" style="font-size:11px;color:#ef4444;text-decoration:line-through;font-family:'JetBrains Mono',monospace;margin-bottom:6px;word-break:break-all;opacity:.7">{{ nodeDiff.demoLink.main }}</div>
            <a :href="selNode.demoLink" target="_blank" rel="noopener"
              style="display:block;width:100%;padding:12px;background:linear-gradient(135deg,#6d28d9,#a855f7);color:#fff;border-radius:6px;font-size:14px;font-weight:700;cursor:pointer;text-align:center;text-decoration:none;box-shadow:0 0 24px rgba(168,85,247,.4)">
              WATCH DEMO
            </a>
          </div>
          <!-- Demo link removed in wing -->
          <div v-else-if="nodeDiff?.demoLink&&nodeDiff.demoLink.main"
            style="margin-top:20px;padding:12px 16px;background:rgba(239,68,68,.05);border:1px solid rgba(239,68,68,.15);border-radius:8px">
            <div style="font-size:11px;font-weight:700;letter-spacing:.12em;color:#ef4444;margin-bottom:6px">DEMO LINK REMOVED IN WING</div>
            <div style="font-size:11px;color:#ef4444;text-decoration:line-through;font-family:'JetBrains Mono',monospace;opacity:.7;word-break:break-all">{{ nodeDiff.demoLink.main }}</div>
          </div>

          <!-- Explore subgraph -->
          <div v-if="!focusedRootId&&selNode&&rootIds.includes(selNode.id)"
            style="margin-top:20px;padding:16px 18px;background:rgba(59,130,246,.06);border:1px solid rgba(59,130,246,.18);border-radius:8px">
            <button @click="zoomInto(selNode.id)"
              style="width:100%;padding:12px;background:rgba(59,130,246,.18);border:1px solid rgba(59,130,246,.35);color:#93c5fd;border-radius:6px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit">
              EXPLORE SUBGRAPH →
            </button>
          </div>

          <!-- Approval / readiness — plan state only. Deliberately independent of
               activity (goal/implementing/blocked/to-demo, shown as rings up in the
               header): the overlord can approve or (un)ready any node regardless of
               whether a minion has claimed it or targeted it as a goal. -->
          <div v-if="selNode"
            :style="`margin-top:20px;padding:14px 18px;border-radius:8px;
              background:${PS[selPlanState].dim}33;border:1px solid ${PS[selPlanState].glow}33`">
            <div :style="`font-size:11px;font-weight:700;letter-spacing:.12em;margin-bottom:10px;color:${PS[selPlanState].glow}`">
              {{ PS[selPlanState].icon }} {{ PS[selPlanState].label.toUpperCase() }}
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <!-- Not yet approved: only action is to approve -->
              <button v-if="selNode.approved===false||selNode.approved===undefined"
                @click="setApproved(selNode!.id, true)" :disabled="approving"
                :style="`flex:1;padding:7px 10px;border:none;border-radius:6px;font-size:11px;font-weight:700;
                  cursor:${approving?'not-allowed':'pointer'};font-family:inherit;opacity:${approving?0.5:1};
                  background:linear-gradient(135deg,#3730a3,#818cf8);color:#fff`">
                {{ approving ? 'SAVING…' : 'APPROVE' }}
              </button>

              <template v-else>
                <!-- Tentatively (AI) approved: offer to make it a full human approval -->
                <button v-if="selNode.approved==='tentative'"
                  @click="setApproved(selNode!.id, true)" :disabled="approving"
                  :style="`flex:1;padding:7px 10px;border:none;border-radius:6px;font-size:11px;font-weight:700;
                    cursor:${approving?'not-allowed':'pointer'};font-family:inherit;opacity:${approving?0.5:1};
                    background:linear-gradient(135deg,#065f46,#22c55e);color:#fff`">
                  {{ approving ? 'SAVING…' : 'FULL APPROVE' }}
                </button>

                <!-- Ready toggle -->
                <button v-if="!selNode.ready" @click="setReady(selNode!.id, true)" :disabled="approving"
                  :style="`flex:1;padding:7px 10px;border:none;border-radius:6px;font-size:11px;font-weight:700;
                    cursor:${approving?'not-allowed':'pointer'};font-family:inherit;opacity:${approving?0.5:1};
                    background:linear-gradient(135deg,#1a2e05,#84cc16);color:#fff`">
                  {{ approving ? 'SAVING…' : 'MAKE READY' }}
                </button>
                <button v-else @click="setReady(selNode!.id, false)" :disabled="approving"
                  :style="`flex:1;padding:7px 10px;border:1px solid rgba(100,116,139,.3);border-radius:6px;font-size:11px;font-weight:700;
                    cursor:${approving?'not-allowed':'pointer'};font-family:inherit;opacity:${approving?0.5:1};
                    background:rgba(15,23,42,.6);color:#94a3b8`">
                  {{ approving ? 'SAVING…' : 'UN-READY' }}
                </button>

                <!-- Un-approve is always available once approved, regardless of activity -->
                <button @click="setApproved(selNode!.id, false)" :disabled="approving"
                  :style="`flex:1;padding:7px 10px;border:1px solid rgba(100,116,139,.3);border-radius:6px;font-size:11px;font-weight:700;
                    cursor:${approving?'not-allowed':'pointer'};font-family:inherit;opacity:${approving?0.5:1};
                    background:rgba(15,23,42,.6);color:#94a3b8`">
                  {{ approving ? 'SAVING…' : 'UN-APPROVE' }}
                </button>
              </template>
            </div>
          </div>

          <!-- Complete item — deletes this node (and its whole subtree) from the
               plan. Available to the overlord on any node, backed by the same
               delete-subtree action wings use to signal finished work. -->
          <div v-if="selNode" style="margin-top:12px">
            <button @click="completeItem(selNode!.id)" :disabled="completing"
              :style="`width:100%;padding:10px;border:1px solid rgba(239,68,68,.35);border-radius:6px;
                font-size:12px;font-weight:700;letter-spacing:.08em;font-family:inherit;
                cursor:${completing?'not-allowed':'pointer'};opacity:${completing?0.5:1};
                background:rgba(239,68,68,.12);color:#fca5a5`">
              {{ completing ? 'COMPLETING…' : 'COMPLETE ITEM' }}
            </button>
          </div>

          <!-- Context markdown (ancestor context) -->
          <div v-if="selDetailsLoading" style="margin-top:20px;font-size:13px;color:#64748b;letter-spacing:.06em">
            LOADING…
          </div>
          <template v-else-if="selNode&&selNode.parent!==null">
            <!-- Non-root: always render the context section -->
            <div :style="`margin-top:20px;padding:16px 18px;border-radius:8px;
              ${nodeDiff?.parentContext?'background:rgba(251,146,60,.06);border:1px solid rgba(251,146,60,.25)':parsedContext?'background:rgba(6,182,212,.04);border:1px solid rgba(6,182,212,.12)':'background:rgba(239,68,68,.07);border:1px solid rgba(239,68,68,.3)'}`">
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
                <div :style="`font-size:11px;font-weight:700;letter-spacing:.12em;${parsedContext?'color:#06b6d4':'color:#ef4444'}`">CONTEXT</div>
                <div style="font-size:10px;color:#334155;letter-spacing:.06em">from ancestors</div>
                <span v-if="nodeDiff?.parentContext" style="font-size:10px;font-weight:700;letter-spacing:.1em;padding:2px 7px;border-radius:3px;background:rgba(251,146,60,.12);color:#fb923c;border:1px solid rgba(251,146,60,.3)">CHANGED</span>
                <span v-if="!parsedContext&&!nodeDiff?.parentContext" style="font-size:10px;font-weight:700;letter-spacing:.1em;padding:2px 7px;border-radius:3px;background:rgba(239,68,68,.12);color:#ef4444;border:1px solid rgba(239,68,68,.3)">MISSING</span>
              </div>
              <div v-if="!parsedContext&&!nodeDiff?.parentContext"
                style="font-size:13px;color:#fca5a5;line-height:1.6">
                ⚠ No context set. An implementor working on this node in isolation has no background to act from.
                Set <code style="font-size:11px;background:rgba(239,68,68,.1);padding:1px 5px;border-radius:3px">parentContext</code> via <code style="font-size:11px;background:rgba(239,68,68,.1);padding:1px 5px;border-radius:3px">update-item</code>.
                If context is truly not needed, use "N/A" with a brief explanation.
              </div>
              <div v-else-if="nodeDiff?.parentContext&&!parsedContext" style="font-size:12px;color:#94a3b8;font-style:italic">(empty in wing)</div>
              <div v-else class="plan-md" v-html="parsedContext"/>
            </div>
          </template>

          <!-- Details markdown -->
          <div v-if="!selDetailsLoading&&(parsedDetails||nodeDiff?.details)"
            :style="`margin-top:20px;padding:16px 18px;border-radius:8px;
              ${nodeDiff?.details?'background:rgba(251,146,60,.06);border:1px solid rgba(251,146,60,.25)':'background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08)'}`">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
              <div style="font-size:11px;font-weight:700;letter-spacing:.12em;color:#94a3b8">DETAILS</div>
              <span v-if="nodeDiff?.details" style="font-size:10px;font-weight:700;letter-spacing:.1em;padding:2px 7px;border-radius:3px;background:rgba(251,146,60,.12);color:#fb923c;border:1px solid rgba(251,146,60,.3)">CHANGED</span>
            </div>
            <div v-if="nodeDiff?.details&&!parsedDetails" style="font-size:12px;color:#94a3b8;font-style:italic">(empty in wing)</div>
            <div v-else class="plan-md" v-html="parsedDetails"/>
          </div>

          <!-- Node state — exposes all fields not shown elsewhere -->
          <div style="margin-top:20px;padding:16px 18px;background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.06);border-radius:8px">
            <div style="font-size:11px;font-weight:700;letter-spacing:.12em;color:#475569;margin-bottom:10px">NODE STATE</div>
            <div style="display:flex;flex-direction:column;gap:6px;font-size:12px;font-family:'JetBrains Mono',monospace">

              <!-- approved -->
              <div style="display:flex;align-items:center;gap:8px">
                <span style="color:#334155;min-width:80px">approved</span>
                <span v-if="nodeDiff?.approved" style="color:#ef4444;text-decoration:line-through;opacity:.7">{{ String(nodeDiff.approved.main ?? 'undefined') }}</span>
                <span v-if="nodeDiff?.approved" style="color:#334155">→</span>
                <span :style="nodeDiff?.approved?'color:#4ade80':'color:#64748b'">{{ String(selNode.approved ?? 'undefined') }}</span>
              </div>

              <!-- ready -->
              <div style="display:flex;align-items:center;gap:8px">
                <span style="color:#334155;min-width:80px">ready</span>
                <span v-if="nodeDiff?.ready" style="color:#ef4444;text-decoration:line-through;opacity:.7">{{ String(nodeDiff.ready.main ?? 'false') }}</span>
                <span v-if="nodeDiff?.ready" style="color:#334155">→</span>
                <span :style="nodeDiff?.ready?'color:#4ade80':'color:#64748b'">{{ String(selNode.ready ?? false) }}</span>
              </div>

              <!-- started -->
              <div style="display:flex;align-items:center;gap:8px">
                <span style="color:#334155;min-width:80px">started</span>
                <span v-if="nodeDiff?.started" style="color:#ef4444;text-decoration:line-through;opacity:.7">{{ String(nodeDiff.started.main ?? 'false') }}</span>
                <span v-if="nodeDiff?.started" style="color:#334155">→</span>
                <span :style="nodeDiff?.started?'color:#4ade80':'color:#64748b'">{{ String(selNode.started ?? false) }}</span>
              </div>

              <!-- onPath -->
              <div style="display:flex;align-items:center;gap:8px">
                <span style="color:#334155;min-width:80px">onPath</span>
                <span v-if="nodeDiff?.onPath" style="color:#ef4444;text-decoration:line-through;opacity:.7">{{ String(nodeDiff.onPath.main ?? 'false') }}</span>
                <span v-if="nodeDiff?.onPath" style="color:#334155">→</span>
                <span :style="nodeDiff?.onPath?'color:#4ade80':'color:#64748b'">{{ String(selNode.onPath ?? false) }}</span>
              </div>

              <!-- parent -->
              <div style="display:flex;align-items:center;gap:8px">
                <span style="color:#334155;min-width:80px">parent</span>
                <span v-if="nodeDiff?.parent" style="color:#ef4444;text-decoration:line-through;opacity:.7">{{ nodeDiff.parent.main ?? 'null' }}</span>
                <span v-if="nodeDiff?.parent" style="color:#334155">→</span>
                <span :style="`cursor:${selNode.parent?'pointer':'default'};${nodeDiff?.parent?'color:#4ade80':'color:#64748b'}`"
                  @click="selNode.parent&&items[selNode.parent]?selId=selNode.parent:null"
                  :title="selNode.parent&&items[selNode.parent]?'Click to navigate':undefined">
                  {{ selNode.parent ?? 'null' }}
                </span>
              </div>

              <!-- exploring (forks only) -->
              <template v-if="selNode.type==='fork'||(nodeDiff?.exploring&&(nodeDiff.exploring.main||nodeDiff.exploring.wing))">
                <div style="display:flex;align-items:flex-start;gap:8px">
                  <span style="color:#334155;min-width:80px;padding-top:1px">exploring</span>
                  <div style="flex:1">
                    <template v-if="nodeDiff?.exploring">
                      <!-- old exploring map -->
                      <div v-if="nodeDiff.exploring.main&&Object.keys(nodeDiff.exploring.main).length" style="margin-bottom:4px">
                        <div v-for="(branch,optId) in nodeDiff.exploring.main" :key="'me'+optId" style="color:#ef4444;text-decoration:line-through;opacity:.7;font-size:11px">{{ optId }}: {{ branch }}</div>
                      </div>
                      <!-- new exploring map -->
                      <div v-if="nodeDiff.exploring.wing&&Object.keys(nodeDiff.exploring.wing).length">
                        <div v-for="(branch,optId) in nodeDiff.exploring.wing" :key="'we'+optId" style="color:#4ade80;font-size:11px">{{ optId }}: {{ branch }}</div>
                      </div>
                      <div v-if="!nodeDiff.exploring.wing||!Object.keys(nodeDiff.exploring.wing).length" style="color:#4ade80;font-size:11px">null</div>
                    </template>
                    <template v-else>
                      <span v-if="!selNode.exploring||!Object.keys(selNode.exploring).length" style="color:#64748b">null</span>
                      <div v-else v-for="(branch,optId) in selNode.exploring" :key="optId" style="color:#64748b;font-size:11px">{{ optId }}: {{ branch }}</div>
                    </template>
                  </div>
                </div>
              </template>

            </div>
          </div>

        </div>

        <!-- PRE-REQS FOOTER — sticky at bottom of panel -->
        <div v-if="connectedNodes.length>0||(nodeDiff?.requires&&(nodeDiff.requires.added.length||nodeDiff.requires.removed.length))"
          style="flex-shrink:0;border-top:1px solid rgba(255,255,255,.1);
            background:rgba(4,7,16,.8);max-height:240px;overflow-y:auto">
          <div style="padding:12px 26px 6px;display:flex;align-items:center;gap:8px">
            <div style="font-size:11px;font-weight:700;letter-spacing:.12em;color:#94a3b8">PRE-REQS</div>
            <span v-if="nodeDiff?.requires" style="font-size:10px;font-weight:700;letter-spacing:.1em;padding:2px 7px;border-radius:3px;background:rgba(251,146,60,.12);color:#fb923c;border:1px solid rgba(251,146,60,.3)">CHANGED</span>
          </div>
          <div style="padding:0 26px 14px">
            <!-- requires: removed in wing -->
            <div v-for="rid in (nodeDiff?.requires?.removed??[])" :key="'r-'+rid"
              style="display:flex;align-items:center;gap:12px;padding:7px 0;border-bottom:1px solid rgba(255,255,255,.04);opacity:.6">
              <span style="width:9px;height:9px;border-radius:50%;flex-shrink:0;background:#ef4444;box-shadow:0 0 6px #ef4444"/>
              <span style="font-size:13px;color:#ef4444;text-decoration:line-through;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ items[rid]?.title ?? rid }}</span>
              <span style="font-size:11px;color:#ef4444;flex-shrink:0;font-family:'JetBrains Mono',monospace">requires −</span>
            </div>
            <!-- requires: added in wing -->
            <div v-for="rid in (nodeDiff?.requires?.added??[])" :key="'r+'+rid"
              style="display:flex;align-items:center;gap:12px;padding:7px 0;border-bottom:1px solid rgba(255,255,255,.04)">
              <span style="width:9px;height:9px;border-radius:50%;flex-shrink:0;background:#4ade80;box-shadow:0 0 6px #4ade80"/>
              <span style="font-size:13px;color:#4ade80;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ items[rid]?.title ?? rid }}</span>
              <span style="font-size:11px;color:#4ade80;flex-shrink:0;font-family:'JetBrains Mono',monospace">requires +</span>
            </div>
            <!-- existing connected nodes (children + unchanged requires) -->
            <div v-for="cn in connectedNodes" :key="cn.id"
              :style="`display:flex;align-items:center;gap:12px;padding:7px 0;cursor:pointer;border-bottom:1px solid rgba(255,255,255,.04);
                ${nodeDiff?.requires&&cn.relation==='requires'?'opacity:.5':''}`"
              @click="selId=cn.id; ensureNodeVisible(cn.id)"
              @mouseenter="($event.currentTarget as HTMLElement).style.background='rgba(255,255,255,.04)'"
              @mouseleave="($event.currentTarget as HTMLElement).style.background=''">
              <span :style="`width:9px;height:9px;border-radius:50%;flex-shrink:0;background:${SC[itemStatus(items[cn.id])].glow};box-shadow:0 0 6px ${SC[itemStatus(items[cn.id])].glow}`"/>
              <span style="font-size:13px;color:#cbd5e1;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ cn.title }}</span>
              <span style="font-size:11px;color:#64748b;flex-shrink:0;font-family:'JetBrains Mono',monospace">{{ cn.relation }}</span>
            </div>
          </div>
        </div>

      </div>
    </transition>

    <!-- Legend: orb colour = plan state, rings = activity (independent, combinable) -->
    <div v-if="!loading&&!error&&!isFlowMode"
      style="position:absolute;bottom:16px;left:16px;display:flex;gap:18px;align-items:center;z-index:10;flex-wrap:wrap">
      <div style="display:flex;gap:14px;align-items:center">
        <div v-for="(cfg,st) in PS" :key="'ps-'+st" style="display:flex;align-items:center;gap:7px">
          <span :style="`width:9px;height:9px;border-radius:50%;display:inline-block;background:${cfg.glow};box-shadow:0 0 6px ${cfg.glow}`"/>
          <span style="font-size:11px;color:#94a3b8;letter-spacing:.04em">{{ cfg.label }}</span>
        </div>
      </div>
      <span style="width:1px;height:14px;background:rgba(255,255,255,.14);display:inline-block"/>
      <div style="display:flex;gap:14px;align-items:center">
        <div v-for="ring in RING_ORDER" :key="'ring-'+ring" style="display:flex;align-items:center;gap:7px">
          <span :style="`width:9px;height:9px;border-radius:50%;display:inline-block;border:1.6px solid ${RING[ring].color};background:transparent`"/>
          <span style="font-size:11px;color:#94a3b8;letter-spacing:.04em">{{ RING[ring].label }}</span>
        </div>
      </div>
    </div>

    <!-- Layout-mode toggle (overview only) -->
    <div v-if="!focusedRootId&&!loading&&!error"
      style="position:absolute;bottom:14px;left:50%;transform:translateX(-50%);z-index:20;
        display:flex;flex-direction:column;align-items:center;gap:5px">
      <div style="display:flex;gap:4px;background:rgba(4,7,16,.9);backdrop-filter:blur(8px);
        border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:4px;box-shadow:0 6px 20px rgba(0,0,0,.5)">
        <button v-for="m in LAYOUT_MODES" :key="m.id" @click="setLayoutMode(m.id)"
          :style="`padding:6px 15px;border:none;border-radius:6px;cursor:pointer;font-family:inherit;
            font-size:11px;font-weight:700;letter-spacing:.1em;transition:background .15s,color .15s;
            ${layoutMode===m.id?'background:rgba(99,102,241,.28);color:#c7d2fe':'background:transparent;color:#64748b'}`">
          {{ m.label }}
        </button>
      </div>
    </div>

    <!-- Zoom hint -->
    <div v-if="!selNode&&!loading&&!error&&!isFlowMode" style="position:absolute;bottom:16px;right:16px;z-index:10">
      <span style="font-size:11px;color:#64748b;letter-spacing:.07em">SCROLL TO ZOOM · DRAG TO PAN</span>
    </div>
  </div>
</template>

<style scoped>
@keyframes lc-heartbeat { 0%,100%{transform:scale(1)} 30%{transform:scale(1.5)} 60%{transform:scale(1)} }
.feed-enter-active,  .feed-leave-active  { transition: opacity .2s, transform .2s; }
.feed-enter-from,    .feed-leave-to      { opacity:0; transform:translateX(8px); }
.panel-enter-active, .panel-leave-active { transition: opacity .28s, transform .28s; }
.panel-enter-from,   .panel-leave-to     { opacity:0; transform:translateX(20px); }

.plan-md { font-size: 14px; color: #94a3b8; line-height: 1.8; }
.plan-md :deep(h1), .plan-md :deep(h2), .plan-md :deep(h3),
.plan-md :deep(h4), .plan-md :deep(h5), .plan-md :deep(h6) {
  color: #e2e8f0; font-weight: 700; margin: 16px 0 8px; line-height: 1.3;
}
.plan-md :deep(h1) { font-size: 18px; }
.plan-md :deep(h2) { font-size: 16px; }
.plan-md :deep(h3) { font-size: 14px; color: #cbd5e1; }
.plan-md :deep(h4), .plan-md :deep(h5), .plan-md :deep(h6) { font-size: 13px; color: #cbd5e1; }
.plan-md :deep(p) { margin: 8px 0; }
.plan-md :deep(ul), .plan-md :deep(ol) { padding-left: 20px; margin: 8px 0; }
.plan-md :deep(ul) { list-style-type: disc; }
.plan-md :deep(ol) { list-style-type: decimal; }
.plan-md :deep(ul ul) { list-style-type: circle; }
.plan-md :deep(li) { margin: 5px 0; color: #cbd5e1; }
.plan-md :deep(li)::marker { color: #64748b; }
.plan-md :deep(li > ul), .plan-md :deep(li > ol) { margin: 2px 0; }
.plan-md :deep(li.task-list-item) { list-style-type: none; margin-left: -20px; }
.plan-md :deep(input[type="checkbox"]) { margin-right: 6px; accent-color: #60a5fa; }
.plan-md :deep(code) {
  background: rgba(255,255,255,.08); padding: 2px 7px; border-radius: 4px;
  font-size: 12px; font-family: 'JetBrains Mono', monospace; color: #e2e8f0;
}
.plan-md :deep(pre) {
  background: rgba(255,255,255,.05); padding: 14px; border-radius: 7px;
  overflow-x: auto; margin: 10px 0; border: 1px solid rgba(255,255,255,.08);
}
.plan-md :deep(pre code) { background: none; padding: 0; font-size: 12px; }
.plan-md :deep(strong) { color: #e2e8f0; font-weight: 700; }
.plan-md :deep(em) { color: #94a3b8; font-style: italic; }
.plan-md :deep(del) { color: #64748b; text-decoration: line-through; }
.plan-md :deep(a) { color: #60a5fa; text-decoration: none; }
.plan-md :deep(a:hover) { text-decoration: underline; }
.plan-md :deep(blockquote) {
  border-left: 3px solid rgba(255,255,255,.2); padding-left: 16px; margin: 10px 0; color: #64748b;
}
.plan-md :deep(table) { width: 100%; border-collapse: collapse; margin: 10px 0; font-size: 13px; }
.plan-md :deep(th) { color: #e2e8f0; font-weight: 700; padding: 8px 12px; border-bottom: 1px solid rgba(255,255,255,.14); text-align: left; }
.plan-md :deep(td) { padding: 6px 12px; border-bottom: 1px solid rgba(255,255,255,.05); color: #94a3b8; }
.plan-md :deep(hr) { border: none; border-top: 1px solid rgba(255,255,255,.1); margin: 14px 0; }
.plan-md :deep(img) { max-width: 100%; border-radius: 6px; margin: 8px 0; }
</style>
