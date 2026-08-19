<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import type { ProductSpace, SpaceLocation, LocationKind } from '../plan/productSpace'
import { flowPoints } from '../plan/productSpace'
import { boundsOf, fitTransform, catmullRomPath } from '../plan/flowGeometry'

interface PlacedNode {
  id: string
  title: string
  /** Colour carrying the node's status. */
  color: string
  /** Location ids this node touches in this space. */
  locationIds: string[]
  /** Flow ids this node participates in (for flow-trace dimming). */
  flowIds: string[]
}

const props = defineProps<{ space: ProductSpace; placedNodes?: PlacedNode[] }>()

const SVG_W = 1400
const SVG_H = 750

// Tint locations by their role in a data flow; user-flow actions are neutral.
const KIND_COLOR: Record<LocationKind, string> = {
  action:    '#7dd3fc',
  source:    '#34d399',
  transform: '#fbbf24',
  sink:      '#60a5fa',
}

// ── Pan / zoom transform ──────────────────────────────────────────────────────
const tx = ref(0)
const ty = ref(0)
const scale = ref(1)
const svgRef = ref<SVGSVGElement | null>(null)

function fit() {
  const box = boundsOf(props.space.locations, 130)
  const t = fitTransform(box, SVG_W, SVG_H, 60)
  tx.value = t.tx; ty.value = t.ty; scale.value = t.scale
}
onMounted(fit)
watch(() => props.space, fit)

function toView(e: MouseEvent): { x: number; y: number } {
  const rect = svgRef.value?.getBoundingClientRect()
  if (!rect) return { x: 0, y: 0 }
  return { x: ((e.clientX - rect.left) / rect.width) * SVG_W, y: ((e.clientY - rect.top) / rect.height) * SVG_H }
}

const panning = ref(false)
let last = { x: 0, y: 0 }
function onDown(e: MouseEvent) {
  if (e.button !== 0) return
  panning.value = true
  last = toView(e)
}
function onMove(e: MouseEvent) {
  if (!panning.value) return
  const p = toView(e)
  tx.value += p.x - last.x
  ty.value += p.y - last.y
  last = p
}
function onUp() { panning.value = false }
function onWheel(e: WheelEvent) {
  e.preventDefault()
  const p = toView(e)
  const ns = Math.max(0.15, Math.min(4, scale.value * (e.deltaY > 0 ? 0.9 : 1.1)))
  tx.value = p.x - (p.x - tx.value) * (ns / scale.value)
  ty.value = p.y - (p.y - ty.value) * (ns / scale.value)
  scale.value = ns
}

// ── Flow rendering ────────────────────────────────────────────────────────────
const hoverFlow = ref<string | null>(null)
const pinnedFlow = ref<string | null>(null)
const activeFlow = computed(() => pinnedFlow.value ?? hoverFlow.value)

const flowRender = computed(() =>
  props.space.flows.map(f => ({
    id: f.id,
    label: f.label,
    color: f.color,
    d: catmullRomPath(flowPoints(props.space, f)),
    dim: activeFlow.value !== null && activeFlow.value !== f.id,
    // duration scales with route length so longer journeys feel longer
    dur: Math.max(4, f.path.length * 1.6),
  }))
)

// A location is highlighted when it lies on the active flow.
const activeLocationIds = computed<Set<string>>(() => {
  if (!activeFlow.value) return new Set()
  const f = props.space.flows.find(fl => fl.id === activeFlow.value)
  return new Set(f?.path ?? [])
})

function locDim(l: SpaceLocation): boolean {
  return activeFlow.value !== null && !activeLocationIds.value.has(l.id)
}

function toggleFlow(id: string) {
  pinnedFlow.value = pinnedFlow.value === id ? null : id
}

// ── Placed plan nodes ─────────────────────────────────────────────────────────
function shortTitle(title: string): string {
  const head = (title.split(' — ')[0] ?? title).split(' (')[0] ?? title
  return head.length <= 30 ? head : head.slice(0, 29) + '…'
}

// Position each placed node at the centroid of the locations it touches, fanning
// out nodes that share a centroid so they don't stack.
const placedRender = computed(() => {
  const locById = new Map(props.space.locations.map(l => [l.id, l]))
  const seen = new Map<string, number>()
  return (props.placedNodes ?? []).map(n => {
    const pts = n.locationIds.map(id => locById.get(id)).filter((l): l is SpaceLocation => !!l)
    const base = pts.length
      ? { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length }
      : { x: 0, y: 0 }
    const key = `${Math.round(base.x / 50)},${Math.round(base.y / 50)}`
    const i = seen.get(key) ?? 0
    seen.set(key, i + 1)
    const ang = i * 2.39996 // golden angle spread
    const r = i === 0 ? 0 : 70 + i * 8
    const label = shortTitle(n.title)
    return {
      id: n.id,
      label,
      color: n.color,
      pts,
      x: base.x + Math.cos(ang) * r,
      y: base.y + Math.sin(ang) * r,
      w: Math.max(70, label.length * 7.4 + 26),
      dim: activeFlow.value !== null && !n.flowIds.includes(activeFlow.value),
    }
  })
})
</script>

<template>
  <div style="position:absolute;inset:0;overflow:hidden;user-select:none"
    @mousemove="onMove" @mouseup="onUp" @mouseleave="onUp">

    <!-- Title -->
    <div style="position:absolute;top:16px;left:50%;transform:translateX(-50%);z-index:5;text-align:center;pointer-events:none">
      <div style="font-size:13px;font-weight:700;letter-spacing:.16em;color:#e2e8f0">{{ space.title.toUpperCase() }}</div>
      <div style="font-size:11px;color:#64748b;margin-top:3px;letter-spacing:.03em">{{ space.caption }}</div>
    </div>

    <svg ref="svgRef" :viewBox="`0 0 ${SVG_W} ${SVG_H}`"
      style="position:absolute;inset:0;width:100%;height:100%"
      :style="{cursor:panning?'grabbing':'grab'}"
      @mousedown="onDown" @wheel.prevent="onWheel">
      <defs>
        <filter id="fs-glow" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
        <filter id="fs-soft" x="-120%" y="-120%" width="340%" height="340%"><feGaussianBlur stdDeviation="9"/></filter>
        <marker v-for="f in flowRender" :key="'m'+f.id" :id="'fs-arr-'+f.id"
          markerWidth="9" markerHeight="7" refX="6" refY="3.5" orient="auto">
          <polygon points="0 0, 9 3.5, 0 7" :fill="f.color"/>
        </marker>
      </defs>

      <g :transform="`translate(${tx},${ty}) scale(${scale})`">
        <!-- Flow routes -->
        <g v-for="f in flowRender" :key="'flow'+f.id" :opacity="f.dim ? 0.12 : 1">
          <!-- soft underglow -->
          <path :d="f.d" :stroke="f.color" stroke-width="10" fill="none" stroke-opacity="0.18"
            stroke-linecap="round" stroke-linejoin="round" filter="url(#fs-soft)"/>
          <!-- core route with direction arrows at each location -->
          <path :id="'fs-path-'+f.id" :d="f.d" :stroke="f.color" stroke-width="3" fill="none"
            stroke-opacity="0.92" stroke-linecap="round" stroke-linejoin="round"
            :marker-mid="`url(#fs-arr-${f.id})`" :marker-end="`url(#fs-arr-${f.id})`"/>
          <!-- travelling pulse to convey traversal -->
          <circle v-if="!f.dim" :r="5" :fill="f.color" filter="url(#fs-glow)">
            <animateMotion :dur="f.dur + 's'" repeatCount="indefinite" rotate="auto">
              <mpath :href="'#fs-path-'+f.id"/>
            </animateMotion>
          </circle>
        </g>

        <!-- Locations -->
        <g v-for="l in space.locations" :key="l.id" :opacity="locDim(l) ? 0.25 : 1"
          :style="`transition:opacity .2s`">
          <!-- halo -->
          <circle :cx="l.x" :cy="l.y" r="34" :fill="KIND_COLOR[l.kind]" fill-opacity="0.08" filter="url(#fs-soft)"/>
          <!-- shape by kind: source=circle, transform=diamond, sink=square, action=circle -->
          <circle v-if="l.kind==='action'||l.kind==='source'" :cx="l.x" :cy="l.y" r="17"
            fill="#0b1220" :stroke="KIND_COLOR[l.kind]" stroke-width="2.4"/>
          <rect v-else-if="l.kind==='transform'" :x="l.x-16" :y="l.y-16" width="32" height="32"
            :transform="`rotate(45 ${l.x} ${l.y})`" fill="#0b1220" :stroke="KIND_COLOR[l.kind]" stroke-width="2.4"/>
          <rect v-else :x="l.x-15" :y="l.y-15" width="30" height="30" rx="4"
            fill="#0b1220" :stroke="KIND_COLOR[l.kind]" stroke-width="2.4"/>
          <!-- inner dot -->
          <circle :cx="l.x" :cy="l.y" r="4" :fill="KIND_COLOR[l.kind]"/>
          <!-- label -->
          <text :x="l.x" :y="l.y + 36" text-anchor="middle" dominant-baseline="middle"
            font-size="15" font-weight="700" fill="#f1f5f9"
            stroke="#020509" stroke-width="3.5" stroke-linejoin="round" style="paint-order:stroke">
            {{ l.label }}
          </text>
          <!-- kind tag for data-flow -->
          <text v-if="space.kind==='data-flow'" :x="l.x" :y="l.y + 53" text-anchor="middle"
            font-size="10" letter-spacing="0.12em" :fill="KIND_COLOR[l.kind]" fill-opacity="0.8"
            stroke="#020509" stroke-width="2.5" stroke-linejoin="round" style="paint-order:stroke">
            {{ l.kind.toUpperCase() }}
          </text>
        </g>

        <!-- Placed plan nodes — pills tethered to the locations they touch -->
        <g v-for="p in placedRender" :key="'placed'+p.id" :opacity="p.dim ? 0.18 : 1" pointer-events="none"
          :style="`transition:opacity .2s`">
          <!-- tethers to each touched location -->
          <line v-for="(loc,li) in p.pts" :key="li" :x1="p.x" :y1="p.y" :x2="loc.x" :y2="loc.y"
            :stroke="p.color" stroke-opacity="0.45" stroke-width="1.5" stroke-dasharray="2,5"/>
          <!-- pill -->
          <rect :x="p.x - p.w/2" :y="p.y - 15" :width="p.w" height="30" rx="15"
            fill="#0b1220" :stroke="p.color" stroke-width="2"/>
          <circle :cx="p.x - p.w/2 + 13" :cy="p.y" r="4" :fill="p.color"/>
          <text :x="p.x + 7" :y="p.y" text-anchor="middle" dominant-baseline="middle"
            font-size="13" font-weight="700" fill="#f1f5f9">{{ p.label }}</text>
        </g>
      </g>
    </svg>

    <!-- Flow legend -->
    <div style="position:absolute;top:64px;right:16px;z-index:6;display:flex;flex-direction:column;gap:4px;
      background:rgba(4,7,16,.9);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.12);
      border-radius:8px;padding:10px 12px;min-width:170px">
      <div style="font-size:10px;font-weight:700;letter-spacing:.14em;color:#64748b;margin-bottom:2px">FLOWS</div>
      <button v-for="f in flowRender" :key="'leg'+f.id"
        @click="toggleFlow(f.id)" @mouseenter="hoverFlow=f.id" @mouseleave="hoverFlow=null"
        :style="`display:flex;align-items:center;gap:9px;background:${pinnedFlow===f.id?'rgba(255,255,255,.07)':'transparent'};
          border:none;border-radius:5px;padding:5px 7px;cursor:pointer;font-family:inherit;text-align:left;
          opacity:${f.dim?0.4:1};transition:opacity .15s`">
        <span :style="`width:14px;height:3px;border-radius:2px;flex-shrink:0;background:${f.color};box-shadow:0 0 7px ${f.color}`"/>
        <span style="font-size:12px;font-weight:600;color:#cbd5e1;white-space:nowrap">{{ f.label }}</span>
      </button>
      <div style="font-size:10px;color:#475569;margin-top:4px;line-height:1.4">hover/click a flow to trace it</div>
    </div>

    <!-- Prototype hint -->
    <div style="position:absolute;bottom:44px;left:50%;transform:translateX(-50%);z-index:6;pointer-events:none">
      <span style="font-size:11px;color:#475569;letter-spacing:.05em">
        prototype · seeded by AI guess · plan &amp; code nodes get laid onto this space next
      </span>
    </div>
  </div>
</template>
