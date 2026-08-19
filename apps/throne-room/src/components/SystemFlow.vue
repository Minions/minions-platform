<script setup lang="ts">
/**
 * System Flow — River View
 *
 * Work flows left→right as water. Channel width encodes zone health:
 *   wide = healthy (at or under HEALTHY_WIP), narrow = crowded (too many items)
 *
 * Read-only system health view. Complements the Oracle.
 */
import { ref, computed, onMounted, onUnmounted, onActivated, onDeactivated } from 'vue'
import { marked } from 'marked'
import { callMCPThroneRaw, getWorkRepoNames } from '../api/cabinet'
import type { PlanResult, PlanItemRecord } from '@minions/mcp-types'
import {
  RIVER_ZONES,
  RIVER_BANK_TOP,
  RIVER_BANK_BOT,
  RIVER_MID,
  STANDARD_WIDTH,
  classifyItemZone,
  isItemBlocked,
  computeChannelWidth,
  computeNodePositions,
  shouldShowItem,
  findDownstreamDeps,
} from '../plan/computeRiverLayout'
import type { RiverZone } from '../plan/computeRiverLayout'
import { usePlanOps } from '../plan/usePlanOps'

const { record: recordOp } = usePlanOps()
import { STAGE_LABEL } from '../plan/stageLabels'

// ── Container sizing — SVG uses actual pixel dimensions as its coordinate space ─

const svgContainer = ref<HTMLDivElement | null>(null)
const cW = ref(1100)  // container width px
const cH = ref(520)   // container height px

// Scale factors from design space (1100 × 520) to actual container
const sx = computed(() => cW.value / 1100)
const sy = computed(() => cH.value / 520)

// Zones with x/w scaled to actual container pixels
const scaledZones = computed(() =>
  RIVER_ZONES.map(z => ({ ...z, x: z.x * sx.value, w: z.w * sx.value }))
)

// Scaled geometric constants
const sMid    = computed(() => RIVER_MID     * sy.value)
const sBankT  = computed(() => RIVER_BANK_TOP * sy.value)
const sBankB  = computed(() => RIVER_BANK_BOT * sy.value)

// ── Data loading ──────────────────────────────────────────────────────────────

const items = ref<Record<string, PlanItemRecord>>({})
const loading = ref(true)
const error = ref<string | null>(null)
// Which lair-registered work repo each item lives in — the plan tool has no
// default `repo` for non-wing resolution, so every single-item call
// (get-subtree/update-item) must look its repo up here.
const itemRepo = ref<Record<string, string>>({})

async function loadAll() {
  loading.value = true
  error.value = null
  try {
    // No single "the" plan repo — read every lair-registered work repo explicitly.
    const repoNames = await getWorkRepoNames()
    const perRepoRoots = await Promise.all(
      repoNames.map(repo => callMCPThroneRaw<PlanResult>('plan', { action: 'list-roots', repo }))
    )
    const ids: string[] = []
    const rootRepo: Record<string, string> = {}
    perRepoRoots.forEach((listResult, i) => {
      if (listResult.action !== 'list-roots') return
      for (const r of listResult.roots) { ids.push(r.id); rootRepo[r.id] = repoNames[i] }
    })
    const subtrees = await Promise.all(
      ids.map(id => callMCPThroneRaw<PlanResult>('plan', { action: 'get-subtree', itemId: id, repo: rootRepo[id] }))
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
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to load'
  } finally {
    loading.value = false
  }
}

// ── Zone layout derived from live data ────────────────────────────────────────

// All items per zone (unfiltered) — used for channel width so crowding counts hidden items too.
const allItemsByZone = computed(() => {
  const groups: Record<string, PlanItemRecord[]> = Object.fromEntries(RIVER_ZONES.map(z => [z.id, []]))
  for (const item of Object.values(items.value)) {
    groups[classifyItemZone(item)].push(item)
  }
  return groups
})

// Displayed items — only those that crossed a stage boundary from their parent.
const itemsByZone = computed(() => {
  const groups: Record<string, PlanItemRecord[]> = Object.fromEntries(RIVER_ZONES.map(z => [z.id, []]))
  for (const item of Object.values(items.value)) {
    if (!shouldShowItem(item, items.value)) continue
    groups[classifyItemZone(item)].push(item)
  }
  return groups
})

// Channel widths in design-space units (STANDARD_WIDTH = 390 at HEALTHY_WIP)
const channelWidths = computed(() =>
  Object.fromEntries(
    RIVER_ZONES.map(z => [z.id, computeChannelWidth(z, allItemsByZone.value[z.id] ?? [])])
  ) as Record<string, number>
)

// Channel widths scaled to container pixels
const scaledCW = computed(() =>
  Object.fromEntries(
    RIVER_ZONES.map(z => [z.id, channelWidths.value[z.id] * sy.value])
  ) as Record<string, number>
)

const nodeR = computed(() => 10 * Math.min(sx.value, sy.value))

const nodePositions = computed(() =>
  computeNodePositions(scaledZones.value, itemsByZone.value, scaledCW.value, sMid.value, nodeR.value)
)

const blockerCount = computed(() => Object.values(items.value).filter(isItemBlocked).length)

// Downstream deps of the selected item that are visible as nodes in the river
const downstreamDepLines = computed(() => {
  const sel = selItem.value
  if (!sel) return []
  const deps = findDownstreamDeps(sel, items.value)
  const depIds = new Set(deps.map(d => d.id))
  const selPos = nodePositions.value.find(np => np.item.id === sel.id)
  if (!selPos) return []
  return nodePositions.value
    .filter(np => depIds.has(np.item.id))
    .map(np => ({ from: selPos, to: np, accent: nodeAccent(np.item) }))
})

/** Flowing bezier from `a` to `b`, curving horizontally like water moving downstream. */
function depLinePath(
  a: { x: number; y: number },
  b: { x: number; y: number },
): string {
  const mx = (a.x + b.x) / 2
  return `M ${a.x},${a.y} C ${mx},${a.y} ${mx},${b.y} ${b.x},${b.y}`
}

const scaledActiveZone = computed(() => scaledZones.value.find(z => z.id === 'active') ?? scaledZones.value[0])

// ── River path generation ─────────────────────────────────────────────────────

function bankPoints(top: boolean) {
  const pts = scaledZones.value.map(z => {
    const cw = scaledCW.value[z.id] ?? STANDARD_WIDTH * sy.value
    return { x: z.x + z.w / 2, y: top ? sMid.value - cw / 2 : sMid.value + cw / 2 }
  })
  const endY = top ? sBankT.value : sBankB.value
  return [{ x: 0, y: endY }, ...pts, { x: cW.value, y: endY }]
}

function bezierThrough(pts: { x: number; y: number }[], move = true): string {
  const first = pts[0]
  let d = move ? `M ${first.x},${first.y}` : `L ${first.x},${first.y}`
  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i - 1], cur = pts[i]
    const mx = (prev.x + cur.x) / 2
    d += ` C ${mx},${prev.y} ${mx},${cur.y} ${cur.x},${cur.y}`
  }
  return d
}

function riverPath(top: boolean): string { return bezierThrough(bankPoints(top)) }

/** Closed shape: top bank left→right then bottom bank right→left. Fill stays inside channel. */
function riverShapePath(): string {
  const top = bankPoints(true)
  const bot = [...bankPoints(false)].reverse()
  return bezierThrough(top) + ' ' + bezierThrough(bot, false) + ' Z'
}

const riverClipPath = computed(() => riverShapePath())

// ── Particle system ───────────────────────────────────────────────────────────

interface Particle {
  x: number; y: number; vx: number
  zoneId: string; col: string; r: number; opacity: number
  slow: boolean
}

const MAX_PARTICLES = 80
const particles = ref<Particle[]>([])

function spawnParticle(): Particle {
  const zones = scaledZones.value
  const weights = zones.map(z => Math.max(1, (itemsByZone.value[z.id] ?? []).length))
  const total = weights.reduce((a, b) => a + b, 0)
  let rand = Math.random() * total
  let chosenZone = zones[0]
  for (let i = 0; i < zones.length; i++) {
    rand -= weights[i]
    if (rand <= 0) { chosenZone = zones[i]; break }
  }
  const cw = scaledCW.value[chosenZone.id] ?? STANDARD_WIDTH * sy.value
  const slow = chosenZone.id === 'active' && Math.random() < 0.35
  const speedScale = sx.value
  return {
    x: chosenZone.x + Math.random() * chosenZone.w,
    y: sMid.value + (Math.random() - 0.5) * cw * 0.8,
    vx: slow
      ? (0.05 + Math.random() * 0.1) * speedScale
      : chosenZone.id === 'active'
        ? (0.35 + Math.random() * 0.5) * speedScale
        : (0.6 + Math.random() * 0.9) * speedScale,
    zoneId: chosenZone.id,
    col: slow ? '#f87171' : chosenZone.accent,
    r: 2.5 + Math.random() * 2,
    opacity: 0.45 + Math.random() * 0.45,
    slow,
  }
}

function initParticles() {
  const count = Math.min(MAX_PARTICLES, Math.max(30, 10 + Object.values(items.value).length * 4))
  particles.value = Array.from({ length: count }, spawnParticle)
}

function updateParticles() {
  const zones = scaledZones.value
  particles.value = particles.value.map(p => {
    let { x, y, vx } = p
    const zone = zones.reduce((best, z) =>
      Math.abs(z.x + z.w / 2 - x) < Math.abs(best.x + best.w / 2 - x) ? z : best
    )
    const cw = scaledCW.value[zone.id] ?? STANDARD_WIDTH * sy.value
    const topY = sMid.value - cw / 2 + 4
    const botY = sMid.value + cw / 2 - 4
    if (y < topY) y = topY + Math.random() * 3
    if (y > botY) y = botY - Math.random() * 3
    const newVx = p.slow ? Math.max(vx * 0.97, 0.04) : Math.min(vx * 1.003, 2.2 * sx.value)
    x += newVx
    y += (Math.random() - 0.5) * 0.8
    if (x > cW.value + 10) return spawnParticle()
    return { ...p, x, y, vx: newVx, zoneId: zone.id, col: p.slow ? '#f87171' : zone.accent }
  })
}

// ── Animation ─────────────────────────────────────────────────────────────────

let raf = 0
let isVisible = true

function startAnimation() {
  const loop = () => {
    if (!isVisible) return
    updateParticles()
    raf = requestAnimationFrame(loop)
  }
  raf = requestAnimationFrame(loop)
}

onMounted(() => {
  const observer = new ResizeObserver(entries => {
    const rect = entries[0]?.contentRect
    if (rect) { cW.value = rect.width; cH.value = rect.height }
  })
  if (svgContainer.value) observer.observe(svgContainer.value)
  onUnmounted(() => observer.disconnect())
  loadAll()
  initParticles()
  startAnimation()
})
onUnmounted(() => cancelAnimationFrame(raf))
onActivated(() => { isVisible = true; startAnimation() })
onDeactivated(() => { isVisible = false; cancelAnimationFrame(raf) })

// ── Selection ─────────────────────────────────────────────────────────────────

const selItem = ref<PlanItemRecord | null>(null)
const selItemDetails = ref<string | null>(null)
const selItemDetailsLoading = ref(false)

async function selectItem(item: PlanItemRecord) {
  if (selItem.value?.id === item.id) {
    selItem.value = null
    selItemDetails.value = null
    return
  }
  selItem.value = item
  selItemDetails.value = null
  selItemDetailsLoading.value = true
  try {
    const result = await callMCPThroneRaw<PlanResult>('plan', { action: 'get-subtree', itemId: item.id, repo: itemRepo.value[item.id] })
    if (result.action === 'get-subtree') selItemDetails.value = result.details || ''
  } finally {
    selItemDetailsLoading.value = false
  }
}

function nodeAccent(item: PlanItemRecord): string {
  const zone = classifyItemZone(item)
  return RIVER_ZONES.find(z => z.id === zone)?.accent ?? '#94a3b8'
}

function nodeRadius(_item: PlanItemRecord): number { return nodeR.value }

const TYPE_GLYPH: Record<string, string> = { task: '✦', fork: '⑂', option: '◎' }

const BRIEFING_PATH = 'costumes/dev-and-check/src/briefings/one-plan-iteration.md'

interface ActionGuidance {
  type: 'claude-cmd' | 'info' | 'demo'
  message: string
  command?: string
}

function actionGuidance(item: PlanItemRecord): ActionGuidance {
  const zone = classifyItemZone(item)
  if (zone === 'imagine') {
    return { type: 'info', message: 'Not yet approved — approve this item to move it to Plan Done.' }
  }
  if (zone === 'plan-done') {
    if (item.approved === 'tentative') {
      return { type: 'info', message: 'Tentatively approved by the planning system — full-approve or mark Ready to queue for execution.' }
    }
    return { type: 'info', message: 'Planning complete and approved — mark Ready to queue for execution, or drag to Ready →' }
  }
  if (zone === 'ready') {
    return {
      type: 'claude-cmd',
      message: 'Ready to implement. Open Claude Code in a wing and give it this command:',
      command: `Read ${BRIEFING_PATH} and follow it on ${item.id}`,
    }
  }
  if (zone === 'in-goal') {
    return {
      type: 'claude-cmd',
      message: 'Claimed — a minion has this in scope. If stalled, open Claude Code in a wing:',
      command: `Read ${BRIEFING_PATH} and follow it on ${item.id}`,
    }
  }
  if (zone === 'active') {
    return { type: 'info', message: 'Implementation is actively in progress.' }
  }
  // done
  if (item.demoLink) {
    return { type: 'demo', message: 'Demo ready — click to review.', command: item.demoLink }
  }
  return { type: 'info', message: 'Completed and awaiting review.' }
}

async function copyCommand(text: string) {
  await navigator.clipboard.writeText(text)
}

function openUrl(url: string) {
  window.open(url, '_blank')
}

// ── Stage transitions ─────────────────────────────────────────────────────────

const transitioning = ref<string | null>(null)

/** Zone an item can be advanced to by the user, or null if not actionable. */
function advanceTarget(item: PlanItemRecord): RiverZone | null {
  const z = classifyItemZone(item)
  if (z === 'imagine') return 'plan-done'
  if (z === 'plan-done') return 'ready'
  return null
}

async function refreshItem(id: string) {
  const r = await callMCPThroneRaw<PlanResult>('plan', { action: 'get-subtree', itemId: id, repo: itemRepo.value[id] })
  if (r.action === 'get-subtree' && r.subtree) {
    items.value = { ...items.value, ...r.subtree.items }
    if (selItem.value?.id === id) selItem.value = items.value[id] ?? null
  }
}

async function doSetApproved(id: string, approved: true | false | 'tentative') {
  if (transitioning.value) return
  transitioning.value = id
  try {
    await callMCPThroneRaw('plan', { action: 'update-item', itemId: id, approved, repo: itemRepo.value[id] })
    await refreshItem(id)
    const title = items.value[id]?.title ?? id
    if (approved !== false) recordOp(approved === true ? 'approve' : 'plan-done', title)
  } catch (e) {
    console.error('Failed to set approval:', e)
  } finally {
    transitioning.value = null
  }
}

async function doSetReady(id: string, ready: boolean) {
  if (transitioning.value) return
  transitioning.value = id
  try {
    await callMCPThroneRaw('plan', { action: 'update-item', itemId: id, ready, repo: itemRepo.value[id] })
    await refreshItem(id)
  } catch (e) {
    console.error('Failed to set ready:', e)
  } finally {
    transitioning.value = null
  }
}

// ── Drag to advance ───────────────────────────────────────────────────────────

const dragItem = ref<PlanItemRecord | null>(null)
const dragPos = ref<{ x: number; y: number } | null>(null)
const dragOverZone = ref<string | null>(null)
let dragMoved = false

function startDrag(item: PlanItemRecord, e: MouseEvent) {
  if (!advanceTarget(item) || transitioning.value) return
  const container = svgContainer.value
  if (!container) return
  e.stopPropagation()
  dragItem.value = item
  dragMoved = false
  const rect = container.getBoundingClientRect()
  dragPos.value = { x: e.clientX - rect.left, y: e.clientY - rect.top }

  const onMove = (ev: MouseEvent) => {
    dragMoved = true
    const r = container.getBoundingClientRect()
    const x = ev.clientX - r.left
    const y = ev.clientY - r.top
    dragPos.value = { x, y }
    const z = scaledZones.value.find(z => x >= z.x && x < z.x + z.w)
    dragOverZone.value = z?.id ?? null
  }

  const onUp = (ev: MouseEvent) => {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    const r = container.getBoundingClientRect()
    const x = ev.clientX - r.left
    const z = scaledZones.value.find(z => x >= z.x && x < z.x + z.w)
    const target = advanceTarget(item)
    if (dragMoved && z && z.id === target) {
      if (target === 'plan-done') {
        doSetApproved(item.id, true)
      } else if (target === 'ready') {
        doSetReady(item.id, true)
      }
    } else if (!dragMoved) {
      selectItem(item)
    }
    dragItem.value = null
    dragPos.value = null
    dragOverZone.value = null
    dragMoved = false
  }

  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}

// Star dots scaled to container
const starDots = computed(() =>
  [[60,40],[200,25],[480,60],[700,30],[950,55],[1050,20],[80,500],[300,490],[650,510],[900,480]]
    .map(([x, y]) => [x * sx.value, y * sy.value] as [number, number])
)

// Font sizes scaled by sy so text stays proportional
const fs = computed(() => ({
  zone: 7.5 * sy.value,
  count: 9 * sy.value,
  glyph: 8 * sy.value,
  label: 8 * sy.value,
  flow: 7.5 * sy.value,
}))

</script>

<template>
  <div ref="svgContainer" style="position:relative;width:100%;height:100%;overflow:hidden;
    background:#05080f;font-family:'Inter',system-ui,sans-serif"
    @click="selItem = null; selItemDetails = null"
  >

    <!-- Loading state -->
    <div v-if="loading"
      style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">
      <span style="font-size:11px;color:rgba(148,163,184,.4);letter-spacing:.12em">LOADING FLOW MAP…</span>
    </div>

    <!-- Error state -->
    <div v-else-if="error"
      style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">
      <span style="font-size:11px;color:#ef4444;letter-spacing:.08em">{{ error }}</span>
    </div>

    <!-- River SVG — viewBox matches container pixels so 1 SVG unit = 1 CSS px, no letterboxing -->
    <svg v-else :viewBox="`0 0 ${cW} ${cH}`" style="position:absolute;inset:0;width:100%;height:100%">
      <defs>
        <filter id="sf-glow" x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="4" result="b"/>
          <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
        <filter id="sf-bloom" x="-200%" y="-200%" width="500%" height="500%">
          <feGaussianBlur stdDeviation="12"/>
        </filter>
        <filter id="sf-soft" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="3"/>
        </filter>
        <linearGradient id="sf-river-fill" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%"   stop-color="#1e3a5f" stop-opacity="0.8"/>
          <stop offset="18%"  stop-color="#164e63" stop-opacity="0.85"/>
          <stop offset="36%"  stop-color="#14532d" stop-opacity="0.8"/>
          <stop offset="58%"  stop-color="#451a03" stop-opacity="0.88"/>
          <stop offset="78%"  stop-color="#3b1d5e" stop-opacity="0.82"/>
          <stop offset="100%" stop-color="#1a0a2e" stop-opacity="0.7"/>
        </linearGradient>
        <radialGradient id="sf-friction-halo" cx="50%" cy="50%" r="55%">
          <stop offset="0%"   stop-color="#ef4444" stop-opacity="0.14"/>
          <stop offset="100%" stop-color="#ef4444" stop-opacity="0"/>
        </radialGradient>
        <clipPath id="sf-river-clip">
          <path :d="riverClipPath"/>
        </clipPath>
        <marker id="sf-crit-arr" markerWidth="5" markerHeight="5" refX="2.5" refY="2.5" orient="auto">
          <polygon points="0 5,2.5 0,5 5" fill="#ef4444" opacity=".7"/>
        </marker>
      </defs>

      <!-- Background stars -->
      <circle v-for="s in starDots" :key="s[0]"
        :cx="s[0]" :cy="s[1]" r="1" fill="#fff" fill-opacity=".12"/>

      <!-- Flow direction label -->
      <path :d="`M ${20*sx},${22*sy} L ${1080*sx},${22*sy}`" stroke="rgba(148,163,184,.12)" stroke-width="1"/>
      <text :x="cW/2" :y="20*sy" text-anchor="middle" :font-size="fs.flow" fill="rgba(148,163,184,.45)"
        letter-spacing=".15em" font-family="'JetBrains Mono',monospace">FLOW →</text>

      <!-- Zone labels above river -->
      <g v-for="z in scaledZones" :key="'lbl-' + z.id">
        <text
          :x="z.x + z.w / 2" :y="45*sy"
          text-anchor="middle" :font-size="fs.zone" font-weight="700"
          :fill="z.accent" fill-opacity=".85" letter-spacing=".14em"
          font-family="'JetBrains Mono',monospace"
        >{{ z.label }}</text>
        <text :x="z.x + z.w / 2" :y="57*sy" text-anchor="middle" :font-size="fs.count"
          :fill="z.accent" fill-opacity=".7">
          {{ (allItemsByZone[z.id] ?? []).length }}
        </text>
      </g>

      <!-- River body fill — uses closed shape so fill stays inside the channel -->
      <path :d="riverShapePath()" fill="url(#sf-river-fill)" opacity=".9"/>

      <!-- Bank lines -->
      <path :d="riverPath(true)"  fill="none" stroke="rgba(148,163,184,.18)" stroke-width="1.5"/>
      <path :d="riverPath(false)" fill="none" stroke="rgba(148,163,184,.18)" stroke-width="1.5"/>

      <!-- Friction haze over active zone when blocked items present -->
      <ellipse v-if="blockerCount > 0"
        :cx="scaledActiveZone.x + scaledActiveZone.w * 0.55" :cy="sMid"
        :rx="scaledActiveZone.w * 0.65 + blockerCount * 14 * sx"
        :ry="(scaledCW['active'] ?? STANDARD_WIDTH * sy) / 2 * 0.7"
        fill="url(#sf-friction-halo)" filter="url(#sf-soft)"
      />

      <!-- Flow particles (clipped to river channel) -->
      <g clip-path="url(#sf-river-clip)">
        <circle v-for="(p, i) in particles" :key="'p' + i"
          :cx="p.x" :cy="p.y" :r="p.r"
          :fill="p.col" :fill-opacity="p.opacity"
          :filter="p.zoneId === 'done' ? 'url(#sf-glow)' : ''"
        />
      </g>

      <!-- Downstream dependency lines (selected item → its already-flowing deps) -->
      <g v-if="selItem" clip-path="url(#sf-river-clip)">
        <path v-for="line in downstreamDepLines" :key="'dl-' + line.to.item.id"
          :d="depLinePath(line.from, line.to)"
          fill="none"
          :stroke="line.accent"
          stroke-width="1.5"
          stroke-opacity="0.55"
          stroke-dasharray="5,4"
        />
      </g>

      <!-- Drop zone highlight during drag -->
      <rect v-if="dragItem && dragOverZone && dragOverZone === advanceTarget(dragItem)"
        :x="scaledZones.find(z => z.id === dragOverZone)!.x" y="0"
        :width="scaledZones.find(z => z.id === dragOverZone)!.w" :height="cH"
        :fill="RIVER_ZONES.find(z => z.id === dragOverZone)!.accent"
        fill-opacity="0.15" rx="0"
      />

      <!-- Ghost node during drag -->
      <g v-if="dragItem && dragPos" style="pointer-events:none">
        <circle
          :cx="dragPos.x" :cy="dragPos.y" :r="nodeR * 1.3"
          :fill="nodeAccent(dragItem)" fill-opacity="0.55"
          filter="url(#sf-glow)"
        />
        <text :x="dragPos.x" :y="dragPos.y + fs.glyph * 0.4"
          text-anchor="middle" :font-size="fs.glyph" fill="#fff" fill-opacity=".7">
          {{ TYPE_GLYPH[dragItem.type] ?? '✦' }}
        </text>
      </g>

      <!-- Item nodes -->
      <g v-for="np in nodePositions" :key="'n-' + np.item.id"
        :style="`cursor:${advanceTarget(np.item) ? 'grab' : 'pointer'};
          opacity:${dragItem?.id === np.item.id ? 0.35 : 1}`"
        @mousedown.stop="startDrag(np.item, $event)"
        @click.stop="advanceTarget(np.item) ? undefined : selectItem(np.item)"
      >
        <!-- Bloom halo for done items -->
        <circle v-if="classifyItemZone(np.item) === 'done'"
          :cx="np.x" :cy="np.y" :r="22 * sy"
          :fill="nodeAccent(np.item)" fill-opacity="0.08"
          filter="url(#sf-bloom)"
        />
        <!-- Dashed ring for blocked items -->
        <circle v-if="isItemBlocked(np.item)"
          :cx="np.x" :cy="np.y" :r="nodeRadius(np.item) + 7 * Math.min(sx,sy)"
          fill="none" stroke="#ef4444"
          stroke-width="1.5" stroke-opacity="0.55"
          stroke-dasharray="3,4"
          filter="url(#sf-glow)"
        />
        <!-- Node circle -->
        <circle
          :cx="np.x" :cy="np.y" :r="nodeRadius(np.item)"
          :fill="isItemBlocked(np.item) ? '#7f1d1d' : nodeAccent(np.item)"
          :fill-opacity="selItem?.id === np.item.id ? 1 : 0.82"
          :stroke="isItemBlocked(np.item) ? '#ef4444' : nodeAccent(np.item)"
          stroke-width="1"
          :stroke-opacity="isItemBlocked(np.item) ? 0.8 : 0.6"
          filter="url(#sf-glow)"
        />
        <!-- Glyph — ⚠ for blocked -->
        <text :x="np.x" :y="np.y + fs.glyph * 0.4"
          text-anchor="middle" :font-size="fs.glyph"
          :fill="isItemBlocked(np.item) ? '#fca5a5' : '#fff'" fill-opacity=".9">
          {{ isItemBlocked(np.item) ? '⚠' : (TYPE_GLYPH[np.item.type] ?? '✦') }}
        </text>
        <!-- Label: first 2 words of title -->
        <text :x="np.x" :y="np.y - nodeRadius(np.item) - 4"
          text-anchor="middle" :font-size="fs.label"
          :fill="isItemBlocked(np.item) ? '#f87171' : nodeAccent(np.item)"
          fill-opacity=".75" font-weight="600">
          {{ np.item.title.split(' ').slice(0, 2).join(' ') }}
        </text>
      </g>

    </svg>

    <!-- Item detail panel -->
    <transition name="sf-panel">
      <div v-if="selItem"
        style="position:absolute;bottom:20px;left:50%;transform:translateX(-50%);
          width:540px;max-height:520px;z-index:30;display:flex;flex-direction:column;
          background:rgba(5,8,15,.96);backdrop-filter:blur(20px);
          border-radius:12px;overflow:hidden;
          box-shadow:0 12px 50px rgba(0,0,0,.8)"
        :style="{ border: `1px solid ${nodeAccent(selItem)}40` }"
        @click.stop
      >
        <!-- Header -->
        <div style="display:flex;align-items:center;gap:10px;padding:12px 16px;
          border-bottom:1px solid rgba(255,255,255,.07);flex-shrink:0">
          <span :style="{ fontSize:'12px', color: nodeAccent(selItem) }">
            {{ TYPE_GLYPH[selItem.type] ?? '✦' }}
          </span>
          <span style="font-size:8px;font-weight:700;letter-spacing:.12em;text-transform:uppercase"
            :style="{ color: nodeAccent(selItem) }">
            {{ STAGE_LABEL[classifyItemZone(selItem)] }}
          </span>
          <span v-if="isItemBlocked(selItem)"
            style="font-size:7px;font-weight:700;letter-spacing:.1em;color:#ef4444;
              padding:1px 7px;border:1px solid rgba(239,68,68,.4);border-radius:3px">
            BLOCKED
          </span>
          <button @click="selItem = null; selItemDetails = null"
            style="margin-left:auto;background:none;border:none;color:#64748b;cursor:pointer;
              font-size:13px;line-height:1;padding:2px 4px"
            title="Close">✕</button>
        </div>

        <!-- Title -->
        <div style="padding:12px 16px 0;flex-shrink:0">
          <div style="font-size:14px;font-weight:700;color:#e2e8f0;line-height:1.35">
            {{ selItem.title }}
          </div>
          <div v-if="isItemBlocked(selItem)"
            style="font-size:10px;color:#fca5a5;margin-top:6px">
            ⚠ Blocked — {{ selItem.questions?.length ?? 0 }} open question{{ (selItem.questions?.length ?? 0) !== 1 ? 's' : '' }}
          </div>
        </div>

        <!-- Details (scrollable) -->
        <div style="flex:1;overflow-y:auto;padding:10px 16px;min-height:0" class="sf-md">
          <div v-if="selItemDetailsLoading"
            style="font-size:10px;color:rgba(148,163,184,.4);font-style:italic">
            Loading…
          </div>
          <div v-else-if="selItemDetails"
            v-html="marked(selItemDetails)"
          />
          <div v-else style="font-size:10px;color:rgba(148,163,184,.35);font-style:italic">
            No details recorded.
          </div>
        </div>

        <!-- Downstream deps — prerequisites already flowing ahead of this item -->
        <div v-if="downstreamDepLines.length > 0"
          style="padding:8px 16px;border-top:1px solid rgba(255,255,255,.06);flex-shrink:0">
          <div style="font-size:8px;font-weight:700;letter-spacing:.12em;color:rgba(148,163,184,.5);
            text-transform:uppercase;margin-bottom:6px">Already flowing downstream</div>
          <div v-for="line in downstreamDepLines" :key="'dep-' + line.to.item.id"
            style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
            <span :style="{ color: line.accent, fontSize: '9px' }">→</span>
            <span style="font-size:10px;color:#94a3b8;flex:1;min-width:0;
              overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
              {{ line.to.item.title }}
            </span>
            <span style="font-size:8px;font-weight:700;letter-spacing:.08em;padding:1px 6px;
              border-radius:3px;flex-shrink:0"
              :style="{ color: line.accent, background: line.accent + '18', border: `1px solid ${line.accent}30` }">
              {{ STAGE_LABEL[classifyItemZone(line.to.item)] }}
            </span>
          </div>
        </div>

        <!-- Action footer -->
        <div style="padding:12px 16px;border-top:1px solid rgba(255,255,255,.06);flex-shrink:0">
          <!-- Imagine → Approve -->
          <template v-if="classifyItemZone(selItem) === 'imagine'">
            <div style="font-size:10px;color:rgba(148,163,184,.6);margin-bottom:8px">
              Approve this item and all descendants — moves them to Plan Done.
              <span style="color:rgba(148,163,184,.4)"> Or drag the node to Plan Done →</span>
            </div>
            <button
              :disabled="!!transitioning"
              :style="`width:100%;padding:8px;border:none;border-radius:5px;font-size:10px;
                font-weight:700;letter-spacing:.06em;font-family:inherit;
                cursor:${transitioning?'not-allowed':'pointer'};
                opacity:${transitioning===selItem.id?0.5:1};
                background:rgba(129,140,248,.15);border:1px solid rgba(129,140,248,.35);color:#a5b4fc`"
              @click.stop="doSetApproved(selItem.id, true)"
            >{{ transitioning === selItem.id ? 'SAVING…' : 'APPROVE' }}</button>
          </template>
          <!-- Plan Done → Ready (or un-approve) -->
          <template v-else-if="classifyItemZone(selItem) === 'plan-done'">
            <div style="font-size:10px;color:rgba(148,163,184,.6);margin-bottom:8px">
              <span v-if="selItem.approved === 'tentative'">Tentatively approved — full-approve or mark Ready. </span>
              <span v-else>Planning complete — mark Ready to queue for execution. </span>
              <span style="color:rgba(148,163,184,.4)">Or drag the node to Ready →</span>
            </div>
            <div style="display:flex;flex-direction:column;gap:6px">
              <button v-if="selItem.approved === 'tentative'"
                :disabled="!!transitioning"
                :style="`width:100%;padding:7px;border:none;border-radius:5px;font-size:10px;
                  font-weight:700;letter-spacing:.06em;font-family:inherit;
                  cursor:${transitioning?'not-allowed':'pointer'};
                  opacity:${transitioning===selItem.id?0.5:1};
                  background:rgba(34,197,94,.12);border:1px solid rgba(34,197,94,.3);color:#4ade80`"
                @click.stop="doSetApproved(selItem.id, true)"
              >{{ transitioning === selItem.id ? 'SAVING…' : 'FULL APPROVE' }}</button>
              <button
                :disabled="!!transitioning"
                :style="`width:100%;padding:7px;border:none;border-radius:5px;font-size:10px;
                  font-weight:700;letter-spacing:.06em;font-family:inherit;
                  cursor:${transitioning?'not-allowed':'pointer'};
                  opacity:${transitioning===selItem.id?0.5:1};
                  background:rgba(132,204,22,.12);border:1px solid rgba(132,204,22,.3);color:#a3e635`"
                @click.stop="doSetReady(selItem.id, true)"
              >{{ transitioning === selItem.id ? 'SAVING…' : 'MAKE READY' }}</button>
              <button
                :disabled="!!transitioning"
                :style="`width:100%;padding:6px;border-radius:5px;font-size:9px;
                  font-weight:700;letter-spacing:.06em;font-family:inherit;
                  cursor:${transitioning?'not-allowed':'pointer'};
                  opacity:${transitioning===selItem.id?0.5:1};
                  background:rgba(15,23,42,.6);border:1px solid rgba(100,116,139,.25);color:#64748b`"
                @click.stop="doSetApproved(selItem.id, false)"
              >{{ transitioning === selItem.id ? 'SAVING…' : 'UN-APPROVE → TO IMAGINE' }}</button>
            </div>
          </template>
          <!-- Ready zone — un-ready or un-approve -->
          <template v-else-if="classifyItemZone(selItem) === 'ready' && actionGuidance(selItem).type !== 'claude-cmd'">
            <div style="font-size:10px;color:rgba(148,163,184,.6);margin-bottom:8px">
              Queued for execution.
            </div>
            <div style="display:flex;flex-direction:column;gap:6px">
              <button
                :disabled="!!transitioning"
                :style="`width:100%;padding:6px;border-radius:5px;font-size:9px;
                  font-weight:700;letter-spacing:.06em;font-family:inherit;
                  cursor:${transitioning?'not-allowed':'pointer'};
                  opacity:${transitioning===selItem.id?0.5:1};
                  background:rgba(15,23,42,.6);border:1px solid rgba(100,116,139,.25);color:#64748b`"
                @click.stop="doSetReady(selItem.id, false)"
              >{{ transitioning === selItem.id ? 'SAVING…' : 'UN-READY → PLAN DONE' }}</button>
              <button
                :disabled="!!transitioning"
                :style="`width:100%;padding:6px;border-radius:5px;font-size:9px;
                  font-weight:700;letter-spacing:.06em;font-family:inherit;
                  cursor:${transitioning?'not-allowed':'pointer'};
                  opacity:${transitioning===selItem.id?0.5:1};
                  background:rgba(15,23,42,.6);border:1px solid rgba(100,116,139,.25);color:#64748b`"
                @click.stop="doSetApproved(selItem.id, false)"
              >{{ transitioning === selItem.id ? 'SAVING…' : 'UN-APPROVE → TO IMAGINE' }}</button>
            </div>
          </template>
          <!-- Claude command (ready zone) -->
          <template v-else-if="actionGuidance(selItem).type === 'claude-cmd'">
            <div style="font-size:10px;color:#94a3b8;margin-bottom:6px">
              {{ actionGuidance(selItem).message }}
            </div>
            <div style="display:flex;align-items:stretch;gap:6px">
              <code style="flex:1;display:block;padding:8px 10px;
                background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);
                border-radius:5px;font-size:10px;color:#e2e8f0;font-family:'JetBrains Mono',monospace;
                word-break:break-all;line-height:1.5">
                {{ actionGuidance(selItem).command }}
              </code>
              <button
                style="padding:0 10px;background:rgba(255,255,255,.07);
                  border:1px solid rgba(255,255,255,.12);border-radius:5px;
                  color:#94a3b8;font-size:10px;cursor:pointer;white-space:nowrap;font-family:inherit"
                @click="copyCommand(actionGuidance(selItem).command!)"
              >Copy</button>
            </div>
          </template>
          <template v-else-if="actionGuidance(selItem).type === 'demo'">
            <button
              style="width:100%;padding:8px;background:rgba(192,132,252,.1);
                border:1px solid rgba(192,132,252,.3);border-radius:5px;
                color:#c084fc;font-size:10px;font-weight:700;cursor:pointer;
                letter-spacing:.06em;font-family:inherit"
              @click="openUrl(actionGuidance(selItem).command!)"
            >▶ Open Demo →</button>
          </template>
          <template v-else>
            <div style="font-size:10px;color:rgba(148,163,184,.6)">
              {{ actionGuidance(selItem).message }}
            </div>
          </template>
        </div>
      </div>
    </transition>

    <!-- Legend -->
    <div style="position:absolute;top:16px;right:20px;display:flex;flex-direction:column;
      gap:6px;z-index:10">
      <div style="font-size:8px;color:rgba(255,255,255,.5);letter-spacing:.14em;
        text-transform:uppercase;margin-bottom:2px">FLOW MAP</div>
      <div style="font-size:9px;color:rgba(255,255,255,.5);display:flex;align-items:center;gap:6px">
        <span style="display:inline-block;width:32px;height:6px;
          background:linear-gradient(to right,rgba(148,163,184,.4),rgba(148,163,184,.75))"></span>
        wide = healthy flow
      </div>
      <div style="font-size:9px;color:rgba(239,68,68,.75);display:flex;align-items:center;gap:6px">
        <span style="display:inline-block;width:32px;height:2px;
          background:rgba(239,68,68,.75)"></span>
        narrow = crowded / backed up
      </div>
      <div style="font-size:9px;color:rgba(239,68,68,.8);display:flex;align-items:center;gap:6px">
        <span style="font-size:12px">⚠</span> boulder = blocked
      </div>
    </div>


  </div>
</template>

<style scoped>
.sf-panel-enter-active, .sf-panel-leave-active { transition: opacity .2s, transform .2s; }
.sf-panel-enter-from, .sf-panel-leave-to       { opacity: 0; transform: translateX(-50%) translateY(12px); }

/* Markdown content rendered inside the card details panel */
.sf-md :deep(h1), .sf-md :deep(h2), .sf-md :deep(h3) {
  color: #cbd5e1; font-weight: 700; margin: 10px 0 4px;
}
.sf-md :deep(h1) { font-size: 13px; }
.sf-md :deep(h2) { font-size: 12px; }
.sf-md :deep(h3) { font-size: 11px; letter-spacing: .04em; text-transform: uppercase; color: #64748b; }
.sf-md :deep(p)  { font-size: 11px; color: #94a3b8; line-height: 1.6; margin: 0 0 8px; }
.sf-md :deep(ul), .sf-md :deep(ol) { padding-left: 16px; margin: 0 0 8px; }
.sf-md :deep(li) { font-size: 11px; color: #94a3b8; line-height: 1.6; margin-bottom: 2px; }
.sf-md :deep(code) {
  font-family: 'JetBrains Mono', monospace; font-size: 10px;
  background: rgba(255,255,255,.06); border-radius: 3px; padding: 1px 5px; color: #e2e8f0;
}
.sf-md :deep(pre) {
  background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.08);
  border-radius: 5px; padding: 8px 10px; overflow-x: auto; margin: 0 0 8px;
}
.sf-md :deep(pre code) { background: none; padding: 0; }
.sf-md :deep(a) { color: #60a5fa; }
.sf-md :deep(strong) { color: #cbd5e1; font-weight: 600; }
.sf-md :deep(blockquote) {
  border-left: 2px solid rgba(148,163,184,.3); margin: 0 0 8px;
  padding-left: 10px; color: #64748b; font-style: italic;
}
.sf-md :deep(hr) { border: none; border-top: 1px solid rgba(255,255,255,.07); margin: 8px 0; }
</style>
