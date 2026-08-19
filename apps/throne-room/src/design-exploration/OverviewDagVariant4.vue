<script setup lang="ts">
/**
 * DAG Variant 4 — "Living Cosmos" (v2)
 * - Card-sized nodes with visible text
 * - Product area regions (translucent ellipse blobs)
 * - Minions cluster in cells near nodes, scatter on hover
 * - Dead drops travel between minion positions, not along plan edges
 * - Ghost fork nodes are clearly distinct (hollow dashed rings)
 * - Visible edge connections with arrows
 * - Pan (drag) + zoom (scroll)
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'

type Status = 'in-planning' | 'tentatively-approved' | 'ready' | 'wip' | 'demo-ready' | 'blocked'
const SC: Record<Status, { glow: string; dim: string; label: string; icon: string }> = {
  'in-planning':          { glow: '#64748b', dim: '#0f172a', label: 'Lore',    icon: '◌' },
  'tentatively-approved': { glow: '#3b82f6', dim: '#1e3a5f', label: 'Staged',  icon: '◈' },
  'ready':                { glow: '#22c55e', dim: '#14532d', label: 'Ready',   icon: '✓' },
  'wip':                  { glow: '#f59e0b', dim: '#451a03', label: 'Active',  icon: '↻' },
  'demo-ready':           { glow: '#a855f7', dim: '#3b1d5e', label: 'Done',    icon: '▶' },
  'blocked':              { glow: '#ef4444', dim: '#450a0a', label: 'Blocked', icon: '⚠' },
}

// Product areas — parts of the system under construction
const areas = [
  { id: 'security', label: 'PLATFORM SECURITY', color: '#ef4444', cx: 310, cy: 310, rx: 235, ry: 245 },
  { id: 'infra',    label: 'INFRASTRUCTURE',    color: '#f59e0b', cx: 580, cy: 285, rx: 195, ry: 185 },
  { id: 'devtools', label: 'DEVELOPER TOOLS',   color: '#3b82f6', cx: 960, cy: 305, rx: 210, ry: 225 },
]

interface N {
  id: string; label: string; sub?: string; status: Status
  x: number; y: number; r: number
  ghost?: boolean; minions?: number; question?: string; demoReady?: boolean
  areas?: string[]
}
interface E { from: string; to: string; type: 'tree' | 'req' | 'fork' }

const nodes: N[] = [
  { id:'ra',  label:'Platform',     sub:'Hardening',     status:'wip',                  x:190,  y:305, r:50, minions:3, areas:['security','infra'] },
  { id:'a1',  label:'API Security', sub:'Audit',         status:'demo-ready',           x:425,  y:142, r:38, demoReady:true, areas:['security'] },
  { id:'a2',  label:'Rate',         sub:'Limiting',      status:'wip',                  x:465,  y:310, r:40, minions:2, areas:['infra','security'] },
  { id:'a3',  label:'Auth',         sub:'Middleware',    status:'blocked',              x:388,  y:490, r:34, question:'Which auth standard?', areas:['security'] },
  { id:'a2a', label:'Redis',        sub:'Integration',   status:'ready',                x:655,  y:215, r:28, areas:['infra'] },
  { id:'a2b', label:'Config',       sub:'Schema',        status:'in-planning',          x:660,  y:390, r:25, areas:['infra'] },
  // Ghost fork timelines — hollow dashed, no fill
  { id:'f1',  label:'via OAuth2',   status:'tentatively-approved', x:550, y:450, r:17, ghost:true },
  { id:'f2',  label:'via JWT',      status:'tentatively-approved', x:550, y:540, r:17, ghost:true },
  { id:'rb',  label:'Developer',    sub:'Experience',    status:'ready',                x:875,  y:310, r:46, areas:['devtools'] },
  { id:'b1',  label:'CLI',          sub:'Tooling',       status:'tentatively-approved', x:1030, y:205, r:29, areas:['devtools'] },
  { id:'b2',  label:'API',          sub:'Docs',          status:'demo-ready',           x:1045, y:405, r:31, demoReady:true, areas:['devtools','security'] },
]
const nodeMap = Object.fromEntries(nodes.map(n => [n.id, n]))

const edges: E[] = [
  { from:'ra',  to:'a1',  type:'tree' }, { from:'ra',  to:'a2',  type:'tree' },
  { from:'ra',  to:'a3',  type:'tree' }, { from:'a2',  to:'a2a', type:'tree' },
  { from:'a2',  to:'a2b', type:'tree' }, { from:'rb',  to:'b1',  type:'tree' },
  { from:'rb',  to:'b2',  type:'tree' },
  { from:'a1',  to:'b2',  type:'req'  },
  { from:'a3',  to:'f1',  type:'fork' }, { from:'a3',  to:'f2',  type:'fork' },
]

// ── Minion cell definitions ─────────────────────────────────────────────────
interface MinionDef {
  nodeId: string; idx: number
  nestX: number; nestY: number
  wiggleFreq: number; wiggleAmp: number; phase: number
  scatterDx: number; scatterDy: number
}
const minionDefs: MinionDef[] = []
// Cluster minions in a small cell below-left of each node
const cellAngles = [2.1, 2.45, 1.75]
for (const n of nodes.filter(nd => nd.minions && !nd.ghost)) {
  for (let i = 0; i < (n.minions ?? 0); i++) {
    const a = cellAngles[i] ?? (2.1 + i * 0.3)
    const d = n.r + 16 + (i % 2) * 7
    minionDefs.push({
      nodeId: n.id, idx: i,
      nestX: Math.cos(a) * d,
      nestY: Math.sin(a) * d,
      wiggleFreq: 1.1 + i * 0.25,
      wiggleAmp:  2.5 + i * 0.5,
      phase:      i * 1.4,
      scatterDx:  Math.cos(a + 0.4 - i * 0.3) * (60 + i * 25),
      scatterDy:  Math.sin(a + 0.4 - i * 0.3) * (60 + i * 25),
    })
  }
}

// ── Animation loop ──────────────────────────────────────────────────────────
const t = ref(0)
let raf = 0
const t0 = Date.now()
onMounted(() => {
  const loop = () => { t.value = (Date.now() - t0) / 1000; raf = requestAnimationFrame(loop) }
  raf = requestAnimationFrame(loop)
})
onUnmounted(() => cancelAnimationFrame(raf))

// Pulsing visual radius
function vr(n: N): number {
  if (n.ghost) return n.r
  if (n.status === 'blocked')    return n.r + 3.5 * Math.abs(Math.sin(t.value * 2.8))
  if (n.status === 'wip')        return n.r + 2.0 * Math.abs(Math.sin(t.value * 1.3))
  if (n.status === 'demo-ready') return n.r + 1.5 * Math.abs(Math.sin(t.value * 0.65))
  return n.r
}

// ── Hover / scatter ─────────────────────────────────────────────────────────
const hoveredId  = ref<string | null>(null)
const hoverAt: Record<string, number> = {}
function onHoverEnter(id: string) { hoveredId.value = id; hoverAt[id] = t.value }
function onHoverLeave()           { hoveredId.value = null }

function minionPos(def: MinionDef) {
  const n  = nodeMap[def.nodeId]
  const wx = Math.sin(t.value * def.wiggleFreq        + def.phase) * def.wiggleAmp
  const wy = Math.cos(t.value * def.wiggleFreq * 0.71 + def.phase) * def.wiggleAmp
  const bx = n.x + def.nestX + wx
  const by = n.y + def.nestY + wy

  if (hoveredId.value === def.nodeId) {
    const elapsed = Math.max(0, t.value - (hoverAt[def.nodeId] ?? t.value))
    // Quick burst, exponential decay → minions creep back
    const s = elapsed * 85 * Math.exp(-elapsed * 1.4)
    return { x: bx + def.scatterDx / 80 * s, y: by + def.scatterDy / 80 * s }
  }
  return { x: bx, y: by }
}

// Dead drops fly between minion positions on different nodes
const deadDrops = [
  { fn:'ra', fi:0, tn:'a2', ti:0, off:0.00, spd:0.27 },
  { fn:'a2', fi:1, tn:'ra', ti:2, off:0.45, spd:0.23 },
  { fn:'ra', fi:1, tn:'a2', ti:0, off:0.72, spd:0.30 },
]
function dropPos(d: typeof deadDrops[0]) {
  const fd = minionDefs.find(m => m.nodeId === d.fn && m.idx === d.fi)
  const td = minionDefs.find(m => m.nodeId === d.tn && m.idx === d.ti)
  const fn = nodeMap[d.fn], tn = nodeMap[d.tn]
  const fp = fd ? minionPos(fd) : { x: fn.x, y: fn.y }
  const tp = td ? minionPos(td) : { x: tn.x, y: tn.y }
  const p  = (t.value * d.spd + d.off) % 1
  return { x: fp.x + (tp.x - fp.x) * p, y: fp.y + (tp.y - fp.y) * p, p }
}

// ── Edge path clipped to node boundaries ────────────────────────────────────
function ep(e: E): string {
  const f = nodeMap[e.from], to = nodeMap[e.to]
  const dx = to.x - f.x, dy = to.y - f.y
  const dist = Math.sqrt(dx * dx + dy * dy)
  if (dist < 1) return ''
  const nx = dx / dist, ny = dy / dist
  const x1 = f.x  + nx * (vr(f)  + 2)
  const y1 = f.y  + ny * (vr(f)  + 2)
  const x2 = to.x - nx * (vr(to) + 9)
  const y2 = to.y - ny * (vr(to) + 9)
  const cx = (x1 + x2) / 2 + ny * dist * 0.06
  const cy = (y1 + y2) / 2 - nx * dist * 0.06
  return `M ${x1},${y1} Q ${cx},${cy} ${x2},${y2}`
}

// ── Pan / Zoom ───────────────────────────────────────────────────────────────
// Start zoomed in (detailed view is default); user scrolls out to see full canvas
const vb = ref({ x: -20, y: 30, w: 820, h: 508 })
const panning = ref(false)
const panStart = ref({ mx: 0, my: 0, bx: 0, by: 0 })

const viewBoxStr = computed(() => `${vb.value.x} ${vb.value.y} ${vb.value.w} ${vb.value.h}`)

function onWheel(e: WheelEvent) {
  e.preventDefault()
  const el = e.currentTarget as SVGSVGElement
  const rect = el.getBoundingClientRect()
  const { x, y, w, h } = vb.value
  const cx = (e.clientX - rect.left) / rect.width  * w + x
  const cy = (e.clientY - rect.top)  / rect.height * h + y
  const fac = e.deltaY > 0 ? 1.1 : 0.91
  const nw = Math.min(1800, Math.max(280, w * fac))
  const nh = nw * (h / w)
  vb.value = { x: cx - (cx - x) * nw / w, y: cy - (cy - y) * nh / h, w: nw, h: nh }
}

function onPanDown(e: MouseEvent) {
  if (e.button !== 0) return
  panning.value = true
  panStart.value = { mx: e.clientX, my: e.clientY, bx: vb.value.x, by: vb.value.y }
}
function onPanMove(e: MouseEvent) {
  if (!panning.value) return
  const el = document.getElementById('cosmos-svg') as SVGSVGElement | null
  if (!el) return
  const rect = el.getBoundingClientRect()
  const dx = (e.clientX - panStart.value.mx) / rect.width  * vb.value.w
  const dy = (e.clientY - panStart.value.my) / rect.height * vb.value.h
  vb.value = { ...vb.value, x: panStart.value.bx - dx, y: panStart.value.by - dy }
}
function onPanUp() { panning.value = false }

// ── Selection / feed ─────────────────────────────────────────────────────────
const selId    = ref<string | null>(null)
const selNode  = computed(() => selId.value ? nodeMap[selId.value] : null)
const feedOpen = ref(true)
const noteText = ref('')
let dragMoved  = false  // distinguish click vs drag

function onSvgDown(e: MouseEvent) { dragMoved = false; onPanDown(e) }
function onSvgMove(e: MouseEvent) { if (panning.value) { dragMoved = true; onPanMove(e) } }
function onNodeClick(n: N)        { if (!dragMoved) selId.value = selId.value === n.id ? null : n.id }

const alerts = [
  { status: 'blocked'    as Status, id:'a3', label:'Auth middleware',    msg:'Awaiting your answer',  ago:'2m' },
  { status: 'demo-ready' as Status, id:'a1', label:'API security audit', msg:'Ready for your review', ago:'9m' },
  { status: 'demo-ready' as Status, id:'b2', label:'API docs',           msg:'Ready for your review', ago:'1h' },
]
</script>

<template>
  <div
    style="position:relative;width:100%;height:100%;overflow:hidden;background:#020509;font-family:'Inter',system-ui,sans-serif"
    @mousemove="onSvgMove" @mouseup="onPanUp"
  >
    <!-- Nebula atmosphere -->
    <div style="position:absolute;inset:0;pointer-events:none">
      <div v-for="(c,i) in [
        {cx:'22%',cy:'42%',col:'rgba(245,158,11,.028)',r:'40%'},
        {cx:'75%',cy:'52%',col:'rgba(34,197,94,.022)',r:'36%'},
        {cx:'52%',cy:'16%',col:'rgba(168,85,247,.018)',r:'32%'},
        {cx:'90%',cy:'24%',col:'rgba(59,130,246,.022)',r:'30%'},
      ]" :key="i"
        :style="`position:absolute;left:${c.cx};top:${c.cy};width:${c.r};height:${c.r};
          transform:translate(-50%,-50%);border-radius:50%;
          background:radial-gradient(ellipse,${c.col} 0%,transparent 70%);`"
      ></div>
    </div>

    <!-- Main SVG canvas -->
    <svg
      id="cosmos-svg"
      :viewBox="viewBoxStr"
      style="position:absolute;inset:0;width:100%;height:100%"
      :style="{ cursor: panning ? 'grabbing' : 'grab' }"
      @click.self="selId = null"
      @wheel.prevent="onWheel"
      @mousedown="onSvgDown"
    >
      <defs>
        <filter id="bloom" x="-200%" y="-200%" width="500%" height="500%">
          <feGaussianBlur stdDeviation="16"/>
        </filter>
        <filter id="glow" x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="5" result="b"/>
          <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
        <filter id="glow-xs" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="2.5" result="b"/>
          <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
        <radialGradient v-for="n in nodes.filter(n=>!n.ghost)" :key="'g'+n.id" :id="'ng-'+n.id" cx="32%" cy="28%" r="72%">
          <stop offset="0%"   :stop-color="SC[n.status].glow" stop-opacity="0.6"/>
          <stop offset="100%" :stop-color="SC[n.status].dim"  stop-opacity="0.97"/>
        </radialGradient>
        <!-- Arrow markers per status -->
        <marker id="arr-tree" markerWidth="6" markerHeight="5" refX="6" refY="2.5" orient="auto">
          <polygon points="0 0,6 2.5,0 5" fill="rgba(148,163,184,0.5)"/>
        </marker>
        <marker id="arr-req" markerWidth="6" markerHeight="5" refX="6" refY="2.5" orient="auto">
          <polygon points="0 0,6 2.5,0 5" fill="rgba(139,92,246,0.7)"/>
        </marker>
      </defs>

      <!-- ── Product area regions ──────────────────────────────────────────── -->
      <g v-for="area in areas" :key="area.id" pointer-events="none">
        <ellipse
          :cx="area.cx" :cy="area.cy" :rx="area.rx" :ry="area.ry"
          :fill="area.color" fill-opacity="0.035"
          :stroke="area.color" stroke-opacity="0.14" stroke-width="1.5"
          stroke-dasharray="8,8"
        />
        <text
          :x="area.cx" :y="area.cy - area.ry + 16"
          text-anchor="middle" font-size="8.5" :fill="area.color" fill-opacity="0.32"
          font-family="'JetBrains Mono',monospace" letter-spacing="0.14em"
        >{{ area.label }}</text>
      </g>

      <!-- Root cluster divider -->
      <line x1="680" y1="40" x2="680" y2="620"
        stroke="rgba(255,255,255,.02)" stroke-width="1" stroke-dasharray="2,10"
        pointer-events="none"/>

      <!-- ── Bloom halos ────────────────────────────────────────────────────── -->
      <circle v-for="n in nodes.filter(n => !n.ghost && n.status !== 'in-planning')" :key="'h'+n.id"
        :cx="n.x" :cy="n.y" :r="n.r * 3.2"
        :fill="SC[n.status].glow"
        :fill-opacity="n.status==='blocked'?0.065:n.status==='wip'?0.055:0.04"
        filter="url(#bloom)" pointer-events="none"
      />

      <!-- ── Edges ──────────────────────────────────────────────────────────── -->
      <!-- Tree edges — clearly visible -->
      <path v-for="e in edges.filter(e=>e.type==='tree')" :key="'et'+e.from+e.to"
        :d="ep(e)"
        :stroke="SC[nodeMap[e.to].status].glow"
        stroke-opacity="0.38" stroke-width="2"
        fill="none" marker-end="url(#arr-tree)"
        pointer-events="none"
      />
      <!-- Requires cross-link -->
      <path v-for="e in edges.filter(e=>e.type==='req')" :key="'er'+e.from+e.to"
        :d="ep(e)"
        stroke="#8b5cf6" stroke-opacity="0.55" stroke-width="1.8"
        stroke-dasharray="6,4" fill="none" marker-end="url(#arr-req)"
        pointer-events="none"
      />
      <!-- Fork ghost edges — faint dashed -->
      <path v-for="e in edges.filter(e=>e.type==='fork')" :key="'ef'+e.from+e.to"
        :d="ep(e)"
        stroke="#3b82f6" stroke-opacity="0.18" stroke-width="1"
        stroke-dasharray="3,8" fill="none"
        pointer-events="none"
      />

      <!-- Fork label -->
      <text x="412" y="482" font-size="7.5" fill="#3b82f6" fill-opacity="0.28"
        font-family="'JetBrains Mono',monospace" letter-spacing="0.14em"
        pointer-events="none">DECISION FORK</text>

      <!-- ── Ghost fork nodes — hollow dashed rings, very faint ───────────── -->
      <g v-for="n in nodes.filter(n=>n.ghost)" :key="'ghost-'+n.id"
        style="cursor:pointer" pointer-events="all"
        @mousedown.stop
        @click.stop="onNodeClick(n)"
      >
        <!-- Outer dashed ring -->
        <circle :cx="n.x" :cy="n.y" :r="n.r + 5"
          fill="none"
          :stroke="SC[n.status].glow" stroke-opacity="0.12"
          stroke-width="1" stroke-dasharray="4,6"
        />
        <!-- Inner hollow circle -->
        <circle :cx="n.x" :cy="n.y" :r="n.r"
          fill="rgba(59,130,246,0.04)"
          stroke="#3b82f6" stroke-opacity="0.22" stroke-width="1"
          stroke-dasharray="3,5"
        />
        <!-- Label -->
        <text :x="n.x" :y="n.y + n.r + 12"
          text-anchor="middle" font-size="8" fill="#3b82f6" fill-opacity="0.3"
          font-family="'Inter',system-ui" font-style="italic">{{ n.label }}</text>
      </g>

      <!-- ── Real nodes ─────────────────────────────────────────────────────── -->
      <g v-for="n in nodes.filter(n=>!n.ghost)" :key="n.id"
        style="cursor:pointer"
        @mousedown.stop
        @click.stop="onNodeClick(n)"
        @mouseenter="onHoverEnter(n.id)"
        @mouseleave="onHoverLeave()"
      >
        <!-- Selection ring -->
        <circle v-if="selId === n.id"
          :cx="n.x" :cy="n.y" :r="vr(n) + 11"
          fill="none" :stroke="SC[n.status].glow"
          stroke-width="1.5" stroke-opacity="0.65"
          stroke-dasharray="4,4" filter="url(#glow)"
        />
        <!-- Outer soft halo ring -->
        <circle :cx="n.x" :cy="n.y" :r="vr(n) + 7"
          :fill="SC[n.status].glow" fill-opacity="0.09"
          filter="url(#glow)"
        />
        <!-- Core sphere -->
        <circle :cx="n.x" :cy="n.y" :r="vr(n)"
          :fill="'url(#ng-'+n.id+')'"
          :stroke="SC[n.status].glow" stroke-width="1.8" stroke-opacity="0.9"
        />
        <!-- Status icon -->
        <text :x="n.x" :y="n.y - (n.sub ? 10 : 4)"
          text-anchor="middle" dominant-baseline="middle"
          :font-size="Math.min(n.r * 0.38, 14)"
          :fill="SC[n.status].glow" fill-opacity="0.9"
          filter="url(#glow-xs)"
        >{{ SC[n.status].icon }}</text>
        <!-- Label line 1 -->
        <text :x="n.x" :y="n.y + (n.sub ? 4 : 8)"
          text-anchor="middle" dominant-baseline="middle"
          :font-size="Math.min(n.r * 0.3, 12.5)"
          :fill="SC[n.status].glow" fill-opacity="0.95"
          font-weight="700" filter="url(#glow-xs)"
        >{{ n.label }}</text>
        <!-- Label line 2 (sub) -->
        <text v-if="n.sub" :x="n.x" :y="n.y + 15"
          text-anchor="middle" dominant-baseline="middle"
          :font-size="Math.min(n.r * 0.28, 11.5)"
          :fill="SC[n.status].glow" fill-opacity="0.8"
          font-weight="600" filter="url(#glow-xs)"
        >{{ n.sub }}</text>
        <!-- Status label below node -->
        <text :x="n.x" :y="n.y + vr(n) + 14"
          text-anchor="middle" :font-size="n.r >= 34 ? 9 : 8.5"
          :fill="SC[n.status].glow" fill-opacity="0.5"
          font-family="'Inter',system-ui" letter-spacing="0.06em"
        >{{ SC[n.status].label }}</text>
      </g>

      <!-- ── Minion sparks (cells, scatter on hover) ───────────────────────── -->
      <g v-for="def in minionDefs" :key="'m'+def.nodeId+def.idx" pointer-events="none">
        <circle
          :cx="minionPos(def).x" :cy="minionPos(def).y" r="3"
          :fill="SC[nodeMap[def.nodeId].status].glow" fill-opacity="0.95"
          filter="url(#glow-xs)"
        />
        <circle
          :cx="minionPos(def).x" :cy="minionPos(def).y" r="5.5"
          :fill="SC[nodeMap[def.nodeId].status].glow" fill-opacity="0.18"
        />
      </g>

      <!-- ── Dead drops flying between minions ─────────────────────────────── -->
      <g v-for="(dd,i) in deadDrops" :key="'dd'+i" pointer-events="none">
        <g v-if="dropPos(dd).p > 0.03 && dropPos(dd).p < 0.96">
          <circle :cx="dropPos(dd).x" :cy="dropPos(dd).y" r="5.5"
            fill="#e2e8f0" fill-opacity="0.1"/>
          <circle :cx="dropPos(dd).x" :cy="dropPos(dd).y" r="2.2"
            fill="#e2e8f0" fill-opacity="0.82" filter="url(#glow-xs)"/>
        </g>
      </g>
    </svg>

    <!-- ── Live feed panel ────────────────────────────────────────────────── -->
    <transition name="feed">
      <div v-if="feedOpen"
        style="position:absolute;top:16px;left:16px;width:220px;z-index:20;
          background:rgba(4,7,16,.9);backdrop-filter:blur(14px);
          border:1px solid rgba(255,255,255,.07);border-radius:8px;overflow:hidden;
          box-shadow:0 8px 32px rgba(0,0,0,.6)"
      >
        <div style="padding:9px 12px;border-bottom:1px solid rgba(255,255,255,.06);display:flex;align-items:center;justify-content:space-between">
          <div style="display:flex;align-items:center;gap:7px">
            <!-- Heartbeat dot (scale pulse, not opacity blink) -->
            <span style="width:6px;height:6px;border-radius:50%;background:#ef4444;display:inline-block;
              box-shadow:0 0 6px #ef4444;animation:heartbeat 1.8s ease-in-out infinite"></span>
            <span style="font-size:9px;font-weight:700;letter-spacing:.15em;text-transform:uppercase;color:#475569">Awaiting You</span>
          </div>
          <button @click="feedOpen=false" style="background:none;border:none;color:#334155;cursor:pointer;font-size:12px;line-height:1;padding:0">✕</button>
        </div>
        <div v-for="a in alerts" :key="a.id"
          style="padding:9px 12px;border-bottom:1px solid rgba(255,255,255,.04);cursor:pointer;display:flex;align-items:flex-start;gap:8px;transition:background .15s"
          :style="selId === a.id ? { background:'rgba(255,255,255,.04)' } : {}"
          @click="selId = a.id; feedOpen = false"
          @mouseenter="($event.currentTarget as HTMLElement).style.background='rgba(255,255,255,.04)'"
          @mouseleave="($event.currentTarget as HTMLElement).style.background= selId === a.id ? 'rgba(255,255,255,.04)' : ''"
        >
          <span :style="`width:6px;height:6px;border-radius:50%;background:${SC[a.status].glow};
            flex-shrink:0;margin-top:3px;display:block;box-shadow:0 0 7px ${SC[a.status].glow};`"></span>
          <div style="flex:1;min-width:0">
            <div style="font-size:11px;font-weight:600;color:#94a3b8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ a.label }}</div>
            <div style="font-size:10px;color:#334155;margin-top:1px">{{ a.msg }}</div>
          </div>
          <span style="font-size:9px;color:#1e293b;flex-shrink:0;padding-top:1px">{{ a.ago }}</span>
        </div>
        <div style="padding:6px 12px;font-size:9px;color:#1e293b;letter-spacing:.05em">3 items need you · rest is handled</div>
      </div>
    </transition>
    <button v-if="!feedOpen" @click="feedOpen=true"
      style="position:absolute;top:16px;left:16px;z-index:20;
        background:rgba(4,7,16,.9);backdrop-filter:blur(8px);
        border:1px solid rgba(239,68,68,.3);color:#ef4444;
        padding:6px 12px;border-radius:6px;cursor:pointer;
        font-size:10px;font-weight:700;letter-spacing:.1em;font-family:inherit;
        box-shadow:0 0 14px rgba(239,68,68,.18);animation:heartbeat 2.2s ease-in-out infinite"
    >⚠ 3 AWAITING</button>

    <!-- ── Node detail panel ─────────────────────────────────────────────── -->
    <transition name="panel">
      <div v-if="selNode"
        style="position:absolute;top:0;right:0;bottom:0;width:292px;z-index:30;
          background:rgba(4,7,16,.94);backdrop-filter:blur(18px);
          border-left:1px solid rgba(255,255,255,.07);
          display:flex;flex-direction:column;overflow:hidden;
          box-shadow:-8px 0 36px rgba(0,0,0,.45)"
      >
        <div style="padding:16px 18px 14px;border-bottom:1px solid rgba(255,255,255,.06)">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px">
            <div style="flex:1;min-width:0">
              <span :style="`display:inline-block;font-size:9px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;
                padding:2px 8px;border-radius:3px;margin-bottom:8px;
                background:${SC[selNode.status].dim}bb;color:${SC[selNode.status].glow};
                border:1px solid ${SC[selNode.status].glow}33;`">
                {{ SC[selNode.status].label }}
              </span>
              <div style="font-size:16px;font-weight:700;color:#e2e8f0;line-height:1.3;word-break:break-word">
                {{ selNode.label }}{{ selNode.sub ? ' ' + selNode.sub : '' }}
              </div>
            </div>
            <button @click="selId=null" style="background:none;border:none;color:#334155;cursor:pointer;font-size:15px;flex-shrink:0;margin-top:2px">✕</button>
          </div>
          <div v-if="selNode.minions" style="margin-top:10px;display:flex;align-items:center;gap:6px">
            <div style="display:flex;gap:3px">
              <span v-for="i in selNode.minions" :key="i"
                :style="`width:7px;height:7px;border-radius:50%;display:inline-block;
                  background:${SC[selNode.status].glow};
                  box-shadow:0 0 5px ${SC[selNode.status].glow};
                  animation:rp ${1.2+i*0.3}s ease-in-out infinite;`">
              </span>
            </div>
            <span style="font-size:10px;color:#475569">{{ selNode.minions }} minion{{ selNode.minions > 1 ? 's' : '' }} on this</span>
          </div>
        </div>

        <div v-if="selNode.question"
          style="margin:14px 18px 0;padding:12px 14px;background:rgba(239,68,68,.07);border:1px solid rgba(239,68,68,.18);border-radius:6px">
          <div style="font-size:9px;font-weight:700;letter-spacing:.12em;color:#ef4444;margin-bottom:6px">⚠ YOUR ANSWER NEEDED</div>
          <div style="font-size:12px;color:#fca5a5;line-height:1.4;margin-bottom:10px">{{ selNode.question }}</div>
          <div style="display:flex;gap:6px">
            <button style="flex:1;padding:7px;background:rgba(239,68,68,.18);border:1px solid rgba(239,68,68,.3);color:#f87171;border-radius:4px;font-size:10px;font-weight:700;cursor:pointer;letter-spacing:.06em;font-family:inherit">ANSWER</button>
            <button style="flex:1;padding:7px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);color:#64748b;border-radius:4px;font-size:10px;font-weight:700;cursor:pointer;letter-spacing:.06em;font-family:inherit">DELEGATE</button>
          </div>
        </div>

        <div v-if="selNode.demoReady"
          style="margin:14px 18px 0;padding:12px 14px;background:rgba(168,85,247,.07);border:1px solid rgba(168,85,247,.18);border-radius:6px">
          <div style="font-size:9px;font-weight:700;letter-spacing:.12em;color:#a855f7;margin-bottom:8px">▶ READY FOR YOUR EYES</div>
          <button style="width:100%;padding:9px;background:linear-gradient(135deg,#6d28d9,#a855f7);border:none;color:#fff;border-radius:4px;font-size:11px;font-weight:700;cursor:pointer;letter-spacing:.04em;font-family:inherit;box-shadow:0 0 18px rgba(168,85,247,.3)">
            WATCH DEMO
          </button>
        </div>

        <div style="margin:14px 18px 0;padding:12px 14px;background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.06);border-radius:6px">
          <div style="font-size:9px;font-weight:700;letter-spacing:.12em;color:#334155;margin-bottom:8px">DROP A NOTE · MINIONS WILL FLOCK</div>
          <textarea v-model="noteText" placeholder="Describe what needs doing… a minion will pick it up."
            rows="3"
            style="width:100%;box-sizing:border-box;padding:8px 10px;resize:none;
              background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);
              border-radius:4px;color:#94a3b8;font-size:11px;font-family:inherit;outline:none;line-height:1.5"
          ></textarea>
          <button :disabled="!noteText.trim()"
            style="margin-top:6px;width:100%;padding:7px;
              background:rgba(245,158,11,.12);border:1px solid rgba(245,158,11,.25);
              color:#f59e0b;border-radius:4px;font-size:10px;font-weight:700;cursor:pointer;
              letter-spacing:.06em;font-family:inherit"
            @click="noteText=''"
          >SUMMON MINION</button>
        </div>

        <div style="margin:14px 18px 0;padding:10px 14px;background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.06);border-radius:6px">
          <div style="font-size:9px;font-weight:700;letter-spacing:.12em;color:#334155;margin-bottom:8px">CONNECTED NODES</div>
          <div v-for="e in edges.filter(e=>e.from===selNode?.id||e.to===selNode?.id).slice(0,4)" :key="e.from+e.to"
            style="display:flex;align-items:center;gap:8px;padding:4px 0;cursor:pointer"
            @click="selId = e.from===selNode?.id ? e.to : e.from"
          >
            <span :style="`width:6px;height:6px;border-radius:50%;flex-shrink:0;
              background:${SC[nodeMap[e.from===selNode?.id?e.to:e.from].status].glow};`"></span>
            <span style="font-size:11px;color:#64748b">{{ nodeMap[e.from===selNode.id?e.to:e.from].label }}</span>
            <span style="font-size:9px;color:#1e293b;margin-left:auto">{{ e.type==='req'?'requires':e.type==='fork'?'fork':(e.from===selNode.id?'→':'←') }}</span>
          </div>
        </div>

        <div style="flex:1"></div>
        <div style="padding:10px 18px;border-top:1px solid rgba(255,255,255,.05);display:flex;align-items:center;justify-content:space-between">
          <span style="font-size:9px;color:#1e293b;letter-spacing:.06em">CLICK CANVAS TO DESELECT</span>
          <button @click="selId=null" style="font-size:9px;color:#334155;background:none;border:none;cursor:pointer;letter-spacing:.08em;font-family:inherit">ZOOM OUT</button>
        </div>
      </div>
    </transition>

    <!-- Status legend -->
    <div style="position:absolute;bottom:16px;left:16px;display:flex;gap:14px;align-items:center;z-index:10">
      <div v-for="(cfg, st) in SC" :key="st" style="display:flex;align-items:center;gap:5px">
        <span :style="`width:7px;height:7px;border-radius:50%;display:inline-block;background:${cfg.glow};box-shadow:0 0 4px ${cfg.glow};`"></span>
        <span style="font-size:9px;color:#1e293b;letter-spacing:.04em">{{ cfg.label }}</span>
      </div>
    </div>

    <!-- Hint -->
    <div v-if="!selNode" style="position:absolute;bottom:16px;right:16px;z-index:10">
      <span style="font-size:9px;color:#1e293b;letter-spacing:.07em">SCROLL TO ZOOM · DRAG TO PAN · HOVER TO SCATTER</span>
    </div>
  </div>
</template>

<style scoped>
@keyframes rp        { 0%,100%{opacity:1}      50%{opacity:.4}  }
@keyframes heartbeat { 0%,100%{transform:scale(1)} 30%{transform:scale(1.5)} 60%{transform:scale(1)} }

.feed-enter-active,  .feed-leave-active  { transition: opacity .2s, transform .2s; }
.feed-enter-from,    .feed-leave-to      { opacity:0; transform:translateX(-8px); }
.panel-enter-active, .panel-leave-active { transition: opacity .25s, transform .25s; }
.panel-enter-from,   .panel-leave-to     { opacity:0; transform:translateX(16px); }
</style>
