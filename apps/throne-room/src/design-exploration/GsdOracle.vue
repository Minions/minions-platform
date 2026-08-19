<script setup lang="ts">
/**
 * GSD — "The Oracle" v4: Spatial Frame Map
 *
 * Jarvis's curated frames arranged radially in SVG space.
 * Distance from center = importance (closer = more urgent).
 * Shape = frame type (diamond=interrupt, hex=area, shield=feature, blob=imagine, arrow=timeline).
 * Spoke lines carry traveling dots toward each frame.
 * Hover reveals a foreignObject tooltip. Click enters the session.
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'

type Stage    = 'imagine' | 'staged' | 'ready' | 'active' | 'done'
type ItemType = 'decision' | 'demo' | 'question' | 'create'
type Priority = 'critical' | 'normal' | 'low'
type FrameType = 'interrupt-sprint' | 'area-focus' | 'imagine-session' | 'feature-deep-dive' | 'timeline-focus'

interface Item {
  id: string; label: string; area: string; areaColor: string
  stage: Stage; type: ItemType; priority: Priority
  blocked?: boolean; blockedBy?: string; unblocks?: number
  note?: string; timeEst?: string
}

const allItems: Item[] = [
  { id:'dec-auth',   label:'Auth standard decision',   area:'Security',  areaColor:'#ef4444', stage:'active', type:'decision',  priority:'critical', blocked:true, blockedBy:'Waiting on your call', unblocks:3, timeEst:'3 min' },
  { id:'dec-plugin', label:'CLI plugin architecture',  area:'Dev Tools',  areaColor:'#3b82f6', stage:'staged', type:'decision',  priority:'normal',   blocked:true, blockedBy:'Builder-4 can\'t proceed', note:'First-party or extensible from day one?' },
  { id:'demo-sec',   label:'API Security Audit',       area:'Security',  areaColor:'#ef4444', stage:'done',   type:'demo',      priority:'normal',   unblocks:1,   note:'"Everything clean." — Sentinel-9', timeEst:'5 min' },
  { id:'demo-docs',  label:'API Docs first draft',     area:'Dev Tools',  areaColor:'#3b82f6', stage:'done',   type:'demo',      priority:'normal',   note:'"Hold publish til auth decided?" — Scribe-3', timeEst:'8 min' },
  { id:'q-redis',    label:'Redis config sign-off',    area:'Infra',     areaColor:'#f59e0b', stage:'ready',  type:'question',  priority:'normal',   timeEst:'1 min' },
  { id:'c-cli',      label:'CLI command structure',    area:'Dev Tools',  areaColor:'#3b82f6', stage:'imagine',type:'create',    priority:'low',      note:'Greenfield — shape the first keystroke feel', timeEst:'open-ended' },
  { id:'c-monitor',  label:'Threat monitoring vision', area:'Security',  areaColor:'#ef4444', stage:'imagine',type:'create',    priority:'low',      note:'Live suspicious-activity view — what triggers your attention?', timeEst:'20–40 min' },
  { id:'c-onboard',  label:'Dev onboarding flow',      area:'Dev Tools',  areaColor:'#3b82f6', stage:'imagine',type:'create',    priority:'low',      note:'First 10 minutes of a new contributor — what should they experience?' },
  { id:'a-platform', label:'Platform Hardening',       area:'Security',  areaColor:'#ef4444', stage:'active', type:'question',  priority:'normal' },
  { id:'a-rate',     label:'Rate Limiting',            area:'Infra',     areaColor:'#f59e0b', stage:'active', type:'question',  priority:'normal', blocked:true, blockedBy:'Waiting for Redis sign-off' },
]

interface FrameItem { itemId: string; role: 'anchor' | 'chain' | 'context' }
interface JarvisFrame {
  id: string; type: FrameType; title: string; rationale: string; saving: string
  color: string; accent: string; items: FrameItem[]; timeEst: string
}

const frames: JarvisFrame[] = [
  {
    id:'f-interrupt', type:'interrupt-sprint',
    title:'Clear the interrupt queue',
    rationale:'One decision is blocking 3 engineers. Two demos are waiting for your eyes. A quick sign-off. All team requests — doing them together means everyone gets unstuck at once.',
    saving:'Unblocks 4 idle tasks, closes 2 completed workstreams',
    color:'#ef4444', accent:'#fca5a5', timeEst:'~20 min',
    items:[{itemId:'dec-auth',role:'anchor'},{itemId:'demo-sec',role:'chain'},{itemId:'demo-docs',role:'chain'},{itemId:'q-redis',role:'context'}],
  },
  {
    id:'f-security', type:'area-focus',
    title:'Security area: close the loop',
    rationale:'Auth decision → platform hardening → audit sign-off → imagine what comes next. Three things connected — working them together keeps you in one mental context.',
    saving:'All security work resolved in one pass',
    color:'#f59e0b', accent:'#fbbf24', timeEst:'~35 min',
    items:[{itemId:'dec-auth',role:'anchor'},{itemId:'demo-sec',role:'chain'},{itemId:'a-platform',role:'chain'},{itemId:'c-monitor',role:'context'}],
  },
  {
    id:'f-devtools', type:'feature-deep-dive',
    title:'Developer Tools: full pass',
    rationale:'CLI, docs, and onboarding are three sides of the same thing — what it feels like to be a new developer here. The plugin decision shapes all three. Design them together and you get coherence.',
    saving:'Coherent DX instead of three disconnected calls',
    color:'#3b82f6', accent:'#93c5fd', timeEst:'~1–1.5 hr',
    items:[{itemId:'dec-plugin',role:'anchor'},{itemId:'demo-docs',role:'chain'},{itemId:'c-cli',role:'chain'},{itemId:'c-onboard',role:'context'}],
  },
  {
    id:'f-imagine', type:'imagine-session',
    title:'Open canvas: platform character',
    rationale:'CLI feel, threat monitoring, dev onboarding — none are in-flight yet. What kind of platform are you building? The team will build whatever you envision. Pure imagination, no obligations.',
    saving:'Shapes 3+ future workstreams with one creative session',
    color:'#22c55e', accent:'#86efac', timeEst:'30 min – 2 hr',
    items:[{itemId:'c-cli',role:'anchor'},{itemId:'c-monitor',role:'chain'},{itemId:'c-onboard',role:'chain'}],
  },
  {
    id:'f-timeline', type:'timeline-focus',
    title:'Security posture: now → hardened',
    rationale:'Auth decision today → platform hardening completes → rate limiting clears → audit signed off → threat monitoring built. You\'re at step one. Make the call and watch the sequence play out.',
    saving:'Full security hardening sequence visible and unblocked',
    color:'#a855f7', accent:'#d8b4fe', timeEst:'Decision now, weeks to complete',
    items:[{itemId:'dec-auth',role:'anchor'},{itemId:'a-platform',role:'chain'},{itemId:'a-rate',role:'chain'},{itemId:'demo-sec',role:'chain'},{itemId:'c-monitor',role:'context'}],
  },
]

const frameTypeConfig: Record<FrameType, { label:string; glyph:string }> = {
  'interrupt-sprint':  { label:'INTERRUPT SPRINT',  glyph:'⚡' },
  'area-focus':        { label:'AREA FOCUS',         glyph:'◎'  },
  'imagine-session':   { label:'IMAGINE SESSION',    glyph:'✦'  },
  'feature-deep-dive': { label:'FEATURE DEEP-DIVE',  glyph:'⬡'  },
  'timeline-focus':    { label:'TIMELINE FOCUS',     glyph:'→'  },
}

// ── Spatial layout ─────────────────────────────────────────────────────────────
// SVG viewBox 0 0 980 560, center at (490, 280)
// Distance from center = urgency (closer = more important)
// Shape = frame type
const CX = 490, CY = 280, SVG_W = 980, SVG_H = 560

interface FrameLayout {
  id: string; x: number; y: number; r: number
  shape: 'diamond' | 'hexagon' | 'shield' | 'blob' | 'arrow'
  spokeDotOffset: number
}

const frameLayouts: FrameLayout[] = [
  // interrupt-sprint: closest (most urgent), upper-right, diamond
  { id:'f-interrupt', x:648, y:148, r:34, shape:'diamond',  spokeDotOffset:0.0  },
  // area-focus: mid, lower-right, hexagon
  { id:'f-security',  x:710, y:400, r:30, shape:'hexagon',  spokeDotOffset:0.22 },
  // feature-deep-dive: mid, lower-left, shield
  { id:'f-devtools',  x:290, y:440, r:28, shape:'shield',   spokeDotOffset:0.44 },
  // imagine-session: furthest, left, blob (circle)
  { id:'f-imagine',   x:168, y:210, r:26, shape:'blob',     spokeDotOffset:0.66 },
  // timeline-focus: upper-left, arrow
  { id:'f-timeline',  x:330, y: 82, r:27, shape:'arrow',    spokeDotOffset:0.88 },
]
const layoutMap = Object.fromEntries(frameLayouts.map(l => [l.id, l]))

// SVG shape paths (centered at 0,0)
function shapePath(shape: FrameLayout['shape'], r: number): string {
  switch (shape) {
    case 'diamond': {
      const w = r * 0.82
      return `M 0,${-r} L ${w},0 L 0,${r} L ${-w},0 Z`
    }
    case 'hexagon': {
      const pts = Array.from({length:6}, (_,i) => {
        const a = (i * 60 - 30) * Math.PI / 180
        return `${(r * Math.cos(a)).toFixed(1)},${(r * Math.sin(a)).toFixed(1)}`
      })
      return `M ${pts.join(' L ')} Z`
    }
    case 'shield': {
      // Pentagon: flat top, pointed bottom
      const shieldPoints: Array<[number, number]> = [
        [0, -r], [r*0.88, -r*0.3], [r*0.55, r*0.95], [-r*0.55, r*0.95], [-r*0.88, -r*0.3],
      ]
      const pts = shieldPoints.map(([x,y]) => `${x.toFixed(1)},${y.toFixed(1)}`)
      return `M ${pts.join(' L ')} Z`
    }
    case 'blob':
      // Organic soft circle — just a circle, handled separately
      return ''
    case 'arrow': {
      // Chevron/arrow pointing right
      const h = r * 0.55, tip = r * 1.1, back = -r * 0.9
      return `M ${back},${-h} L ${r*0.3},${-h} L ${tip},0 L ${r*0.3},${h} L ${back},${h} L ${back-r*0.15},0 Z`
    }
  }
}

// ── Animation ──────────────────────────────────────────────────────────────────
const t = ref(0)
let raf = 0
const t0 = Date.now()
onMounted(() => {
  const loop = () => { t.value = (Date.now() - t0) / 1000; raf = requestAnimationFrame(loop) }
  raf = requestAnimationFrame(loop)
})
onUnmounted(() => cancelAnimationFrame(raf))

// Spoke traveling dot position (lerps center → frame)
function spokeDot(layout: FrameLayout) {
  const dx = layout.x - CX, dy = layout.y - CY
  const speed = 0.14
  const p = ((t.value * speed + layout.spokeDotOffset) % 1) * 0.78
  return { x: CX + dx * p, y: CY + dy * p }
}

// Subtle Jarvis center pulse scale
const jarvisScale = computed(() => 1 + 0.06 * Math.sin(t.value * 1.2))

// ── Sector background hints ───────────────────────────────────────────────────
// Very faint wedge arcs showing mood zones
const sectors = [
  { label:'URGENT',   startDeg:-60,  endDeg:60,   color:'rgba(239,68,68,.05)'   },
  { label:'BUILD',    startDeg:60,   endDeg:180,  color:'rgba(59,130,246,.04)'  },
  { label:'IMAGINE',  startDeg:180,  endDeg:280,  color:'rgba(34,197,94,.04)'   },
  { label:'TIME',     startDeg:280,  endDeg:360,  color:'rgba(168,85,247,.04)'  },
]

function sectorPath(startDeg: number, endDeg: number, outerR: number): string {
  const s = startDeg * Math.PI / 180, e = endDeg * Math.PI / 180
  const x1 = Math.cos(s) * outerR, y1 = Math.sin(s) * outerR
  const x2 = Math.cos(e) * outerR, y2 = Math.sin(e) * outerR
  const large = endDeg - startDeg > 180 ? 1 : 0
  return `M 0,0 L ${x1},${y1} A ${outerR},${outerR} 0 ${large} 1 ${x2},${y2} Z`
}

// ── Hover & selection ─────────────────────────────────────────────────────────
const hoveredId = ref<string | null>(null)
const hovFrame  = computed(() => hoveredId.value ? frames.find(f => f.id === hoveredId.value) : null)
const hovLayout = computed(() => hoveredId.value ? layoutMap[hoveredId.value] : null)

// Tooltip quadrant: position the foreignObject so it doesn't go off-edge
function tooltipX(layout: FrameLayout): number {
  return layout.x < CX ? layout.x + layout.r + 14 : layout.x - layout.r - 254
}
function tooltipY(layout: FrameLayout): number {
  return Math.max(8, Math.min(SVG_H - 200, layout.y - 90))
}

const itemMap    = Object.fromEntries(allItems.map(i => [i.id, i]))
const typeGlyph: Record<ItemType, string> = { decision:'⚖', demo:'▶', question:'?', create:'✦' }
const typeColor: Record<ItemType, string> = { decision:'#f59e0b', demo:'#a855f7', question:'#ef4444', create:'#22c55e' }

// ── Frame session ─────────────────────────────────────────────────────────────
const selectedFrame = ref<string | null>(null)
const frameItemIdx  = ref(0)
const noteText      = ref('')
const activeFrame   = computed(() => frames.find(f => f.id === selectedFrame.value))
const frameItems    = computed(() => activeFrame.value?.items.map(fi => itemMap[fi.itemId]).filter(Boolean) ?? [])
const currentItem   = computed(() => frameItems.value[frameItemIdx.value])

function enterFrame(id: string) { selectedFrame.value = id; frameItemIdx.value = 0; hoveredId.value = null }
function exitFrame() { selectedFrame.value = null }
function nextItem()  { if (frameItemIdx.value < frameItems.value.length - 1) frameItemIdx.value++ }
function prevItem()  { if (frameItemIdx.value > 0) frameItemIdx.value-- }

const roleStyle: Record<string, { opacity:number; label:string }> = {
  anchor:  { opacity:1,    label:'Start here' },
  chain:   { opacity:0.90, label:'Then'       },
  context: { opacity:0.65, label:'Context'    },
}

const blockedCount  = allItems.filter(i => i.blocked).length
const criticalCount = allItems.filter(i => i.priority === 'critical').length
const doneCount     = allItems.filter(i => i.stage === 'done').length
</script>

<template>
  <div style="position:relative;display:flex;flex-direction:column;height:100vh;overflow:hidden;
    background:#040302;font-family:'Inter',system-ui,sans-serif;color:#c9bfb3">

    <!-- ══ FRAME SESSION ═══════════════════════════════════════════════════════ -->
    <transition name="session">
      <div v-if="selectedFrame && activeFrame"
        style="position:absolute;inset:0;display:flex;flex-direction:column;z-index:50;background:#040302">

        <header style="height:44px;flex-shrink:0;background:#070503;border-bottom:1px solid rgba(255,200,100,.07);
          display:flex;align-items:center;justify-content:space-between;padding:0 24px">
          <div style="display:flex;align-items:center;gap:10px">
            <span style="font-size:13px;font-weight:700;color:#d4a017;font-family:'Georgia',serif">J</span>
            <span style="width:1px;height:16px;background:rgba(255,255,255,.07)"></span>
            <span :style="{
              fontSize:'9px', fontWeight:700, letterSpacing:'.14em', textTransform:'uppercase',
              padding:'3px 12px', borderRadius:'4px',
              background:`${activeFrame.color}18`, color:activeFrame.accent,
              border:`1px solid ${activeFrame.color}30`
            }">{{ frameTypeConfig[activeFrame.type].glyph }} {{ activeFrame.title }}</span>
            <span style="font-size:10px;color:rgba(255,255,255,.2)">{{ frameItemIdx+1 }} / {{ frameItems.length }}</span>
          </div>
          <button @click="exitFrame"
            style="padding:5px 16px;background:transparent;border:1px solid rgba(255,200,100,.12);
              border-radius:4px;color:rgba(212,160,23,.5);font-size:10px;font-weight:700;
              letter-spacing:.1em;cursor:pointer;font-family:inherit;transition:color .15s"
            @mouseenter="($event.currentTarget as HTMLElement).style.color='#d4a017'"
            @mouseleave="($event.currentTarget as HTMLElement).style.color='rgba(212,160,23,.5)'"
          >↑ All frames</button>
        </header>

        <div style="flex:1;min-height:0;display:flex;overflow:hidden">
          <!-- Progress sidebar -->
          <div style="width:220px;flex-shrink:0;border-right:1px solid rgba(255,200,100,.05);padding:20px 16px;overflow:auto">
            <div style="font-size:8.5px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;
              color:rgba(255,255,255,.15);margin-bottom:14px">This frame</div>
            <div v-for="(fi, idx) in activeFrame.items" :key="fi.itemId"
              @click="frameItemIdx = idx"
              style="padding:8px 10px;border-radius:5px;margin-bottom:4px;cursor:pointer;transition:all .14s"
              :style="{
                background: idx===frameItemIdx ? `${activeFrame.color}15` : 'transparent',
                border: `1px solid ${idx===frameItemIdx ? activeFrame.color+'30' : 'transparent'}`,
                opacity: roleStyle[fi.role].opacity,
              }"
            >
              <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px">
                <span :style="{ fontSize:'9px', color: typeColor[itemMap[fi.itemId]?.type ?? 'question'] }">{{ typeGlyph[itemMap[fi.itemId]?.type ?? 'question'] }}</span>
                <span :style="{ fontSize:'7px', letterSpacing:'.1em', textTransform:'uppercase', color: idx===frameItemIdx ? activeFrame.accent : 'rgba(255,255,255,.2)' }">{{ roleStyle[fi.role].label }}</span>
                <span v-if="itemMap[fi.itemId]?.blocked" style="margin-left:auto;font-size:8px;color:#ef4444">⚠</span>
              </div>
              <div :style="{ fontSize:'11px', lineHeight:1.3, color: idx===frameItemIdx?'#e2e8f0':'#5a5450', fontWeight: idx===frameItemIdx?600:400 }">{{ itemMap[fi.itemId]?.label }}</div>
            </div>
            <div style="margin-top:20px;padding:12px 14px;border-radius:6px;background:rgba(212,160,23,.04);border:1px solid rgba(212,160,23,.1)">
              <div style="font-size:9px;color:rgba(212,160,23,.4);font-family:'Georgia',serif;margin-bottom:6px">Jarvis on this frame</div>
              <div style="font-size:10px;color:#5a5045;font-family:'Georgia',serif;font-style:italic;line-height:1.55">"{{ activeFrame.rationale.slice(0,120) }}{{ activeFrame.rationale.length>120?'…':'' }}"</div>
            </div>
          </div>

          <!-- Item work area -->
          <div style="flex:1;overflow:auto;padding:32px 40px 28px;max-width:660px" v-if="currentItem">
            <transition name="brief" mode="out-in">
              <div :key="currentItem.id">
                <div v-if="currentItem.blocked"
                  style="margin-bottom:18px;padding:10px 16px;border-radius:5px;
                    background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.22);
                    display:flex;align-items:center;gap:10px">
                  <span style="font-size:12px;color:#ef4444">⚠</span>
                  <span style="font-size:11px;color:#f87171">Blocked — {{ currentItem.blockedBy }}</span>
                  <span v-if="currentItem.unblocks" style="margin-left:auto;font-size:10px;color:#ef4444;opacity:.7">unblocks {{ currentItem.unblocks }} items</span>
                </div>
                <div style="display:flex;align-items:center;gap:10px;margin-bottom:20px">
                  <span :style="{ fontSize:'8.5px', fontWeight:700, letterSpacing:'.16em', textTransform:'uppercase', padding:'3px 10px', borderRadius:'3px', background:`${typeColor[currentItem.type]}18`, color:typeColor[currentItem.type], border:`1px solid ${typeColor[currentItem.type]}35` }">{{ typeGlyph[currentItem.type] }} {{ currentItem.type.toUpperCase() }}</span>
                  <span :style="{ fontSize:'9px', color:currentItem.areaColor, opacity:.7, letterSpacing:'.06em' }">{{ currentItem.area }}</span>
                  <span v-if="currentItem.priority==='critical'" style="font-size:8px;font-weight:700;letter-spacing:.12em;color:#ef4444;padding:2px 8px;border:1px solid rgba(239,68,68,.3);border-radius:3px">CRITICAL</span>
                </div>
                <h1 style="font-size:26px;font-weight:700;color:#e8e0d6;line-height:1.25;margin:0 0 18px;letter-spacing:-.01em">{{ currentItem.label }}</h1>
                <div v-if="currentItem.note" style="font-size:14px;color:#8c8078;line-height:1.7;margin-bottom:24px;font-family:'Georgia',serif;padding:18px 22px;background:rgba(255,255,255,.02);border-left:2px solid rgba(255,200,100,.1);border-radius:0 6px 6px 0">{{ currentItem.note }}</div>
                <div v-if="currentItem.type==='create'||currentItem.type==='question'" style="margin-bottom:24px">
                  <textarea v-model="noteText"
                    :placeholder="currentItem.type==='create' ? 'Start designing… Jarvis will turn it into a plan.' : 'Your answer…'"
                    rows="5"
                    style="width:100%;box-sizing:border-box;padding:16px 20px;resize:none;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);border-radius:6px;color:#c9bfb3;font-size:13px;font-family:'Georgia',serif;outline:none;line-height:1.7;caret-color:#d4a017"
                  ></textarea>
                </div>
                <div style="display:flex;align-items:center;gap:10px">
                  <button @click="nextItem" :style="{ padding:'12px 28px', borderRadius:'5px', border:'none', cursor:'pointer', fontSize:'12px', fontWeight:700, letterSpacing:'.05em', fontFamily:'inherit', background:`linear-gradient(135deg,${typeColor[currentItem.type]}bb,${typeColor[currentItem.type]})`, color:'#fff', boxShadow:`0 4px 20px ${typeColor[currentItem.type]}40` }">
                    {{ currentItem.type==='demo'?'Review & next':currentItem.type==='decision'?'Decide & next':currentItem.type==='create'?'Log & next':'Answer & next' }}
                  </button>
                  <button @click="nextItem" style="padding:12px 18px;background:transparent;border:1px solid rgba(255,255,255,.08);border-radius:5px;color:rgba(255,255,255,.25);font-size:11px;cursor:pointer;letter-spacing:.06em;font-family:inherit">Skip</button>
                  <button v-if="frameItemIdx>0" @click="prevItem" style="padding:12px 14px;background:transparent;border:none;color:rgba(255,255,255,.2);font-size:11px;cursor:pointer;font-family:inherit">← Back</button>
                  <div style="flex:1"></div>
                  <span v-if="currentItem.timeEst" style="font-size:10px;color:rgba(255,255,255,.16)">{{ currentItem.timeEst }}</span>
                </div>
              </div>
            </transition>
          </div>
        </div>
      </div>
    </transition>

    <!-- ══ RADIAL FRAME MAP (overview) ════════════════════════════════════════ -->
    <transition name="overview">
      <div v-if="!selectedFrame" style="position:absolute;inset:0;display:flex;flex-direction:column">

        <!-- Jarvis header — minimal, lets the map breathe -->
        <header style="position:absolute;top:0;left:0;right:0;padding:16px 24px;z-index:10;
          display:flex;align-items:baseline;gap:10px;pointer-events:none">
          <span style="font-size:14px;font-weight:700;color:#d4a017;font-family:'Georgia',serif">Jarvis</span>
          <span style="width:4px;height:4px;border-radius:50%;background:#22c55e;
            box-shadow:0 0 5px #22c55e;display:inline-block;margin-bottom:2px;
            animation:hb 2.4s ease-in-out infinite;pointer-events:none"></span>
          <span style="font-size:11px;color:#3a3530;font-family:'Georgia',serif;font-style:italic">
            — {{ criticalCount }} critical · {{ blockedCount }} blocked · {{ doneCount }} ready to close
          </span>
        </header>

        <!-- Full-viewport SVG map -->
        <svg :viewBox="`0 0 ${SVG_W} ${SVG_H}`"
          style="position:absolute;inset:0;width:100%;height:100%"
          @click.self="hoveredId = null"
        >
          <defs>
            <filter id="or-glow" x="-80%" y="-80%" width="260%" height="260%">
              <feGaussianBlur stdDeviation="5" result="b"/>
              <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
            </filter>
            <filter id="or-bloom" x="-200%" y="-200%" width="500%" height="500%">
              <feGaussianBlur stdDeviation="18"/>
            </filter>
            <filter id="or-soft" x="-60%" y="-60%" width="220%" height="220%">
              <feGaussianBlur stdDeviation="8"/>
            </filter>
            <radialGradient id="bg-grad" cx="50%" cy="50%" r="60%">
              <stop offset="0%"   stop-color="#0a0806" stop-opacity="1"/>
              <stop offset="100%" stop-color="#020201" stop-opacity="1"/>
            </radialGradient>
            <!-- Per-frame glow gradients -->
            <radialGradient v-for="f in frames" :key="'fg'+f.id" :id="'fg-'+f.id" cx="50%" cy="50%" r="50%">
              <stop offset="0%"   :stop-color="f.color" stop-opacity="0.55"/>
              <stop offset="100%" :stop-color="f.color" stop-opacity="0.06"/>
            </radialGradient>
          </defs>

          <!-- Background -->
          <rect x="0" y="0" :width="SVG_W" :height="SVG_H" fill="url(#bg-grad)"/>

          <!-- Sector mood zones (very faint wedges) -->
          <g :transform="`translate(${CX},${CY})`" opacity="1" pointer-events="none">
            <path v-for="s in sectors" :key="s.label"
              :d="sectorPath(s.startDeg, s.endDeg, 340)"
              :fill="s.color"
            />
          </g>

          <!-- Sector labels at perimeter -->
          <g pointer-events="none">
            <text x="830" y="290" font-size="8" fill="rgba(239,68,68,.18)" font-family="'JetBrains Mono',monospace" letter-spacing=".14em">URGENT →</text>
            <text x="490" y="540" text-anchor="middle" font-size="8" fill="rgba(59,130,246,.15)" font-family="'JetBrains Mono',monospace" letter-spacing=".12em">← BUILD</text>
            <text x="60"  y="290" font-size="8" fill="rgba(34,197,94,.15)" font-family="'JetBrains Mono',monospace" letter-spacing=".12em">IMAGINE →</text>
            <text x="490" y="28"  text-anchor="middle" font-size="8" fill="rgba(168,85,247,.15)" font-family="'JetBrains Mono',monospace" letter-spacing=".12em">← TIME →</text>
          </g>

          <!-- Spoke lines (center → each frame) -->
          <g pointer-events="none">
            <line v-for="fl in frameLayouts" :key="'sp'+fl.id"
              :x1="CX" :y1="CY" :x2="fl.x" :y2="fl.y"
              :stroke="frames.find(f=>f.id===fl.id)?.color ?? '#fff'"
              :stroke-opacity="hoveredId===fl.id ? 0.25 : 0.08"
              stroke-width="1"
              stroke-dasharray="4,8"
            />
            <!-- Traveling dots along spokes -->
            <circle v-for="fl in frameLayouts" :key="'sd'+fl.id"
              :cx="spokeDot(fl).x" :cy="spokeDot(fl).y" r="2.5"
              :fill="frames.find(f=>f.id===fl.id)?.accent ?? '#fff'"
              :fill-opacity="hoveredId===fl.id ? 0.9 : 0.35"
              filter="url(#or-glow)"
            />
          </g>

          <!-- Distance rings (faint reference circles) -->
          <g :transform="`translate(${CX},${CY})`" pointer-events="none">
            <circle r="160" fill="none" stroke="rgba(255,255,255,.025)" stroke-width="1" stroke-dasharray="2,12"/>
            <circle r="230" fill="none" stroke="rgba(255,255,255,.018)" stroke-width="1" stroke-dasharray="2,12"/>
            <circle r="300" fill="none" stroke="rgba(255,255,255,.012)" stroke-width="1" stroke-dasharray="2,12"/>
          </g>

          <!-- ── Jarvis center ──────────────────────────────────────────────── -->
          <g :transform="`translate(${CX},${CY})`" pointer-events="none">
            <!-- Bloom -->
            <circle r="60" fill="rgba(212,160,23,.08)" filter="url(#or-bloom)"/>
            <!-- Pulse rings -->
            <circle r="48" fill="none" stroke="rgba(212,160,23,.12)" stroke-width="1"/>
            <circle r="36" fill="none" stroke="rgba(212,160,23,.18)" stroke-width="1"/>
            <!-- Core -->
            <circle :r="22 * jarvisScale" fill="rgba(212,160,23,.15)"
              stroke="rgba(212,160,23,.5)" stroke-width="1.5" filter="url(#or-glow)"/>
            <!-- Letter -->
            <text x="0" y="6" text-anchor="middle" font-size="16" font-weight="700"
              fill="#d4a017" font-family="'Georgia',serif" fill-opacity=".9">J</text>
            <!-- Label -->
            <text x="0" y="38" text-anchor="middle" font-size="7.5" fill="rgba(212,160,23,.35)"
              letter-spacing=".16em" font-family="'JetBrains Mono',monospace">JARVIS</text>
          </g>

          <!-- ── Frame nodes ─────────────────────────────────────────────────── -->
          <g v-for="fl in frameLayouts" :key="fl.id">
            <g :transform="`translate(${fl.x},${fl.y})`"
              style="cursor:pointer"
              @mouseenter="hoveredId = fl.id"
              @mouseleave="hoveredId = null"
              @click.stop="enterFrame(fl.id)"
            >
              <!-- Bloom halo -->
              <circle :r="fl.r * 2.8"
                :fill="`url(#fg-${fl.id})`"
                :fill-opacity="hoveredId===fl.id ? 1 : 0.6"
                filter="url(#or-bloom)"
              />
              <!-- Outer glow ring -->
              <circle :r="fl.r + 8"
                :fill="frames.find(f=>f.id===fl.id)?.color ?? '#fff'"
                :fill-opacity="hoveredId===fl.id ? 0.14 : 0.06"
                filter="url(#or-glow)"
              />
              <!-- Shape: blob = circle, others = path -->
              <circle v-if="fl.shape==='blob'"
                :r="fl.r"
                :fill="frames.find(f=>f.id===fl.id)?.color ?? '#fff'"
                :fill-opacity="hoveredId===fl.id ? 0.28 : 0.18"
                :stroke="frames.find(f=>f.id===fl.id)?.accent ?? '#fff'"
                :stroke-width="hoveredId===fl.id ? 2 : 1.5"
                stroke-opacity="0.75"
                filter="url(#or-glow)"
              />
              <path v-else
                :d="shapePath(fl.shape, fl.r)"
                :fill="frames.find(f=>f.id===fl.id)?.color ?? '#fff'"
                :fill-opacity="hoveredId===fl.id ? 0.28 : 0.18"
                :stroke="frames.find(f=>f.id===fl.id)?.accent ?? '#fff'"
                :stroke-width="hoveredId===fl.id ? 2 : 1.5"
                stroke-opacity="0.75"
                filter="url(#or-glow)"
              />
              <!-- Type glyph -->
              <text x="0" y="5" text-anchor="middle" dominant-baseline="middle"
                :font-size="fl.r * 0.6"
                :fill="frames.find(f=>f.id===fl.id)?.accent ?? '#fff'"
                fill-opacity="0.9" filter="url(#or-glow)">
                {{ frameTypeConfig[frames.find(f=>f.id===fl.id)?.type ?? 'interrupt-sprint'].glyph }}
              </text>
              <!-- Frame title below node -->
              <text x="0" :y="fl.r + 16" text-anchor="middle"
                :font-size="10"
                :fill="frames.find(f=>f.id===fl.id)?.accent ?? '#fff'"
                :fill-opacity="hoveredId===fl.id ? 0.9 : 0.45"
                font-weight="600" font-family="'Inter',system-ui">
                {{ frames.find(f=>f.id===fl.id)?.title.split(':')[0].split('–')[0].trim() }}
              </text>
              <!-- Time estimate -->
              <text x="0" :y="fl.r + 28" text-anchor="middle" font-size="8"
                :fill="frames.find(f=>f.id===fl.id)?.color ?? '#fff'"
                fill-opacity="0.35" font-family="'JetBrains Mono',monospace" letter-spacing=".06em">
                {{ frames.find(f=>f.id===fl.id)?.timeEst }}
              </text>
              <!-- Recommended marker (first frame = closest = recommended) -->
              <text v-if="fl.id==='f-interrupt'" x="0" :y="-fl.r - 10" text-anchor="middle"
                font-size="7" fill="#d4a017" fill-opacity="0.7" letter-spacing=".12em"
                font-family="'JetBrains Mono',monospace">RECOMMENDED</text>
            </g>
          </g>

          <!-- ── Hover tooltip (foreignObject) ─────────────────────────────── -->
          <foreignObject v-if="hovFrame && hovLayout"
            :x="tooltipX(hovLayout)"
            :y="tooltipY(hovLayout)"
            width="240" height="220"
            style="pointer-events:none"
          >
            <div xmlns="http://www.w3.org/1999/xhtml"
              style="padding:14px 16px;border-radius:8px;
                background:rgba(6,4,2,.94);backdrop-filter:blur(12px);
                font-family:'Inter',system-ui,sans-serif;line-height:1;
                box-shadow:0 8px 32px rgba(0,0,0,.8)"
              :style="{ border: `1px solid ${hovFrame.color}35` }"
            >
              <div :style="{ fontSize:'7.5px', fontWeight:700, letterSpacing:'.16em', textTransform:'uppercase', color:hovFrame.accent, marginBottom:'8px' }">
                {{ frameTypeConfig[hovFrame.type].glyph }} {{ frameTypeConfig[hovFrame.type].label }}
              </div>
              <div style="font-size:12px;font-weight:700;color:#e2e8f0;margin-bottom:8px;line-height:1.3">{{ hovFrame.title }}</div>
              <div style="font-size:10px;color:#6b6258;font-family:'Georgia',serif;font-style:italic;line-height:1.5;margin-bottom:10px">
                "{{ hovFrame.rationale.slice(0,110) }}…"
              </div>
              <!-- Item dots -->
              <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:10px">
                <span v-for="fi in hovFrame.items" :key="fi.itemId"
                  style="font-size:9px;padding:2px 7px;border-radius:3px;line-height:1.4"
                  :style="{
                    background: `${typeColor[itemMap[fi.itemId]?.type ?? 'question']}18`,
                    color: typeColor[itemMap[fi.itemId]?.type ?? 'question'],
                    border: `1px solid ${typeColor[itemMap[fi.itemId]?.type ?? 'question']}30`,
                    opacity: fi.role==='context' ? 0.6 : 1,
                  }"
                >{{ typeGlyph[itemMap[fi.itemId]?.type ?? 'question'] }} {{ (itemMap[fi.itemId]?.label ?? '').split(' ').slice(0,3).join(' ') }}</span>
              </div>
              <div :style="{ fontSize:'9px', color:hovFrame.accent, opacity:.7 }">↵ click to enter</div>
            </div>
          </foreignObject>
        </svg>

        <!-- Bottom: Jarvis voice line -->
        <div style="position:absolute;bottom:20px;left:50%;transform:translateX(-50%);
          text-align:center;pointer-events:none;z-index:10">
          <div style="font-size:11px;color:#4a4030;font-family:'Georgia',serif;font-style:italic">
            "Hover any frame to see what's inside — click to enter."
          </div>
        </div>
      </div>
    </transition>

  </div>
</template>

<style scoped>
@keyframes hb { 0%,100%{transform:scale(1);opacity:1} 35%{transform:scale(1.55);opacity:.8} 65%{transform:scale(1)} }

.session-enter-active, .session-leave-active   { transition:opacity .22s, transform .22s; }
.session-enter-from, .session-leave-to         { opacity:0; transform:scale(.97); }
.overview-enter-active, .overview-leave-active { transition:opacity .22s, transform .22s; }
.overview-enter-from, .overview-leave-to       { opacity:0; transform:scale(1.02); }
.brief-enter-active, .brief-leave-active       { transition:opacity .16s, transform .16s; }
.brief-enter-from   { opacity:0; transform:translateY(8px); }
.brief-leave-to     { opacity:0; transform:translateY(-5px); }
</style>
