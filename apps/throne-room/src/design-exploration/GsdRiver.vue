<script setup lang="ts">
/**
 * GSD — "The River"
 *
 * Work flows left→right as water. You read the shape of the system:
 *   healthy  = fast, narrow, bright channel
 *   WIP pile = wide, slow, pooling water
 *   blocked  = boulders mid-stream, pooling visible upstream
 *   done     = calm eddy at the right bank
 *
 * No cards. Flow stops are the primary visual.
 */
import { ref, onMounted, onUnmounted, computed } from 'vue'

// blocked is NOT a stage — it's a property on an item that is in some stage
type Stage = 'imagine' | 'staged' | 'ready' | 'active' | 'done'
type ItemType = 'decision' | 'demo' | 'question' | 'create'
type Priority = 'critical' | 'normal' | 'low'

interface Item {
  id: string; label: string; area: string; areaColor: string
  stage: Stage; type: ItemType; priority: Priority
  blocked?: boolean; unblocks?: number
}

const items: Item[] = [
  { id:'c1',  label:'Threat monitoring vision',  area:'Security',  areaColor:'#ef4444', stage:'imagine',  type:'create',   priority:'low'      },
  { id:'c2',  label:'CLI command structure',      area:'Dev Tools', areaColor:'#3b82f6', stage:'imagine',  type:'create',   priority:'low'      },
  { id:'s1',  label:'Redis integration',          area:'Infra',     areaColor:'#f59e0b', stage:'staged',   type:'question', priority:'normal'   },
  { id:'s2',  label:'CLI tooling',                area:'Dev Tools', areaColor:'#3b82f6', stage:'staged',   type:'decision', priority:'normal'   },
  { id:'r1',  label:'Config schema',              area:'Infra',     areaColor:'#f59e0b', stage:'ready',    type:'question', priority:'normal'   },
  { id:'a1',  label:'Platform hardening',         area:'Security',  areaColor:'#ef4444', stage:'active',   type:'question', priority:'normal'   },
  { id:'a2',  label:'Rate limiting',              area:'Infra',     areaColor:'#f59e0b', stage:'active',   type:'question', priority:'normal',   blocked:true },
  // auth middleware is active (work started) but blocked on a decision
  { id:'bl1', label:'Auth middleware',            area:'Security',  areaColor:'#ef4444', stage:'active',   type:'decision', priority:'critical', blocked:true, unblocks:3 },
  // CLI plugin: staged but blocked — can't proceed to ready without the decision
  { id:'bl2', label:'CLI plugin architecture',    area:'Dev Tools', areaColor:'#3b82f6', stage:'staged',   type:'decision', priority:'normal',   blocked:true },
  { id:'d1',  label:'API security audit',         area:'Security',  areaColor:'#ef4444', stage:'done',     type:'demo',     priority:'normal'   },
  { id:'d2',  label:'API docs draft',             area:'Dev Tools', areaColor:'#3b82f6', stage:'done',     type:'demo',     priority:'normal'   },
]

// ── River geometry ────────────────────────────────────────────────────────────
// The river runs left to right. Each "zone" has an x range and a flow width.
// Active zone widens when items are piling up (inc. blocked items stuck there).
const W = 1100, H = 520
const BANK_TOP = 90, BANK_BOT = 430

const zones = [
  { id:'imagine' as Stage, x:20,   w:130, label:'IMAGINE',  col:'#4f46e5', accent:'#818cf8' },
  { id:'staged'  as Stage, x:170,  w:140, label:'STAGED',   col:'#0369a1', accent:'#38bdf8' },
  { id:'ready'   as Stage, x:330,  w:130, label:'READY',    col:'#15803d', accent:'#4ade80' },
  { id:'active'  as Stage, x:480,  w:210, label:'ACTIVE',   col:'#b45309', accent:'#fbbf24' },
  { id:'done'    as Stage, x:710,  w:160, label:'DONE',     col:'#6d28d9', accent:'#c084fc' },
]

// Channel widens with item count. Blocked items in active cause extra widening — they're stuck.
function channelWidth(z: typeof zones[0]): number {
  const inZone   = items.filter(i => i.stage === z.id)
  const blocked  = inZone.filter(i => i.blocked).length
  if (z.id === 'active') return 110 + inZone.length * 18 + blocked * 25
  if (z.id === 'done')   return 75
  return 55 + inZone.length * 12 + blocked * 14
}

// Build SVG path for river bank (top and bottom) as a smooth bezier
function riverPath(top: boolean): string {
  const mid = (BANK_TOP + BANK_BOT) / 2
  const pts = zones.map(z => {
    const cw = channelWidth(z)
    const cx = z.x + z.w / 2
    return { x: cx, y: top ? mid - cw/2 : mid + cw/2 }
  })
  // Add start/end points
  const all = [
    { x: 0, y: top ? BANK_TOP : BANK_BOT },
    ...pts,
    { x: W, y: top ? BANK_TOP : BANK_BOT },
  ]
  let d = `M ${all[0].x},${all[0].y}`
  for (let i = 1; i < all.length; i++) {
    const prev = all[i-1], cur = all[i]
    const mx = (prev.x + cur.x) / 2
    d += ` C ${mx},${prev.y} ${mx},${cur.y} ${cur.x},${cur.y}`
  }
  return d
}

// Particle system — particles travel left→right at varying speeds
interface Particle { x: number; y: number; vx: number; stage: Stage; col: string; r: number; opacity: number }
const particles = ref<Particle[]>([])
const PARTICLE_COUNT = 55

function spawnParticle(): Particle {
  const stage = (['imagine','staged','ready','active','done'] as Stage[])[Math.floor(Math.random()*5)]
  const zone = zones.find(z => z.id === stage) ?? zones[0]
  const mid = (BANK_TOP + BANK_BOT) / 2
  const cw = channelWidth(zone)
  // Active zone has many blocked items — some particles are slow/stuck
  const hasBlocked = stage === 'active' && Math.random() < 0.35
  return {
    x: zone.x + Math.random() * zone.w,
    y: mid + (Math.random() - .5) * cw * .8,
    vx: hasBlocked ? 0.05 + Math.random()*.1 : stage === 'active' ? .35 + Math.random()*.5 : .6 + Math.random()*.9,
    stage, col: hasBlocked ? '#f87171' : zone.accent,
    r: 2.5 + Math.random() * 2,
    opacity: .45 + Math.random() * .45,
  }
}

// Init
for (let i = 0; i < PARTICLE_COUNT; i++) particles.value.push(spawnParticle())

// ── Animation ─────────────────────────────────────────────────────────────────
const t  = ref(0)
let raf  = 0
const t0 = Date.now()

function updateParticles() {
  const mid = (BANK_TOP + BANK_BOT) / 2
  particles.value = particles.value.map(p => {
    let { x, y, vx, r, opacity } = p
    // Find channel at this x
    const zone = zones.reduce((best, z) => {
      const zx = z.x + z.w/2
      return Math.abs(zx - x) < Math.abs((best.x + best.w/2) - x) ? z : best
    }, zones[0])
    const cw = channelWidth(zone)
    const topY = mid - cw/2
    const botY = mid + cw/2
    // Keep in channel
    if (y < topY + 4) y = topY + 4 + Math.random()*3
    if (y > botY - 4) y = botY - 4 - Math.random()*3
    // Red-tinted slow particles stay slow (simulate blocked items)
    const isSlowParticle = vx < 0.2
    const newVx = isSlowParticle ? Math.max(vx * 0.97, 0.04) : Math.min(vx * 1.003, 2.2)
    x += newVx
    // Slight vertical drift
    y += (Math.random() - .5) * .8
    // Reset when off right edge
    if (x > W + 10) return spawnParticle()
    return { x, y, vx:newVx, stage:zone.id, col:zone.accent, r, opacity }
  })
}

onMounted(() => {
  const loop = () => {
    t.value = (Date.now() - t0) / 1000
    updateParticles()
    raf = requestAnimationFrame(loop)
  }
  raf = requestAnimationFrame(loop)
})
onUnmounted(() => cancelAnimationFrame(raf))

// ── Item nodes on the river ───────────────────────────────────────────────────
interface NodePos { item: Item; x: number; y: number }
const nodePositions = computed((): NodePos[] => {
  const mid = (BANK_TOP + BANK_BOT) / 2
  const stageItems: Record<string, Item[]> = {}
  for (const z of zones) stageItems[z.id] = items.filter(i => i.stage === z.id)
  return zones.flatMap(z => {
    const list = stageItems[z.id] ?? []
    const cw = channelWidth(z)
    return list.map((item, i) => ({
      item,
      x: z.x + z.w/2 + (i - (list.length-1)/2) * 28,
      y: mid + (Math.sin(i * 1.2) * cw * .28),
    }))
  })
})

// ── Blocked friction: active zone widens with blocked items ──────────────────
const activeZone   = zones.find(z => z.id === 'active') ?? zones[0]
const blockerCount = items.filter(i => i.blocked).length

// ── Selection ─────────────────────────────────────────────────────────────────
const selItem = ref<Item | null>(null)
function nodeColor(item: Item) {
  const z = zones.find(z => z.id === item.stage)
  return z?.accent ?? '#94a3b8'
}
const typeGlyph: Record<string, string> = { decision:'⚖', demo:'▶', question:'?', create:'✦' }

const copiedId = ref<string | null>(null)
async function copyId(id: string) {
  try {
    await navigator.clipboard.writeText(id)
    copiedId.value = id
    setTimeout(() => { if (copiedId.value === id) copiedId.value = null }, 1500)
  } catch { /**/ }
}
</script>

<template>
  <div style="position:relative;width:100%;height:100%;overflow:hidden;
    background:#05080f;font-family:'Inter',system-ui,sans-serif">

    <!-- River SVG -->
    <svg :viewBox="`0 0 ${W} ${H}`" style="position:absolute;inset:0;width:100%;height:100%">
      <defs>
        <filter id="riv-glow" x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="4" result="b"/>
          <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
        <filter id="riv-bloom" x="-200%" y="-200%" width="500%" height="500%">
          <feGaussianBlur stdDeviation="12"/>
        </filter>
        <filter id="riv-soft" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="3"/>
        </filter>
        <!-- River gradient: lighter at center, darker at banks -->
        <linearGradient id="river-fill" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%"   stop-color="#1e3a5f" stop-opacity="0.8"/>
          <stop offset="18%"  stop-color="#164e63" stop-opacity="0.85"/>
          <stop offset="36%"  stop-color="#14532d" stop-opacity="0.8"/>
          <stop offset="58%"  stop-color="#451a03" stop-opacity="0.88"/>
          <stop offset="78%"  stop-color="#3b1d5e" stop-opacity="0.82"/>
          <stop offset="100%" stop-color="#1a0a2e" stop-opacity="0.7"/>
        </linearGradient>
        <!-- Friction halo for blocked items inside active zone -->
        <radialGradient id="friction-halo" cx="50%" cy="50%" r="55%">
          <stop offset="0%"  stop-color="#ef4444" stop-opacity="0.14"/>
          <stop offset="100%" stop-color="#ef4444" stop-opacity="0"/>
        </radialGradient>
        <clipPath id="river-clip">
          <path :d="riverPath(true) + ' L ' + W + ',' + BANK_BOT + ' L 0,' + BANK_BOT + ' Z'"/>
        </clipPath>
      </defs>

      <!-- Background stars -->
      <circle v-for="s in [[60,40],[200,25],[480,60],[700,30],[950,55],[1050,20],[80,500],[300,490],[650,510],[900,480]]"
        :key="s[0]" :cx="s[0]" :cy="s[1]" r="1" fill="#fff" fill-opacity=".12"/>

      <!-- Zone labels above river -->
      <g v-for="z in zones" :key="'lbl'+z.id">
        <text
          :x="z.x + z.w/2" :y="72"
          text-anchor="middle" font-size="7.5" font-weight="700"
          :fill="z.accent" fill-opacity=".55" letter-spacing=".14em"
          font-family="'JetBrains Mono',monospace"
        >{{ z.label }}</text>
        <!-- Zone count -->
        <text :x="z.x + z.w/2" :y="82" text-anchor="middle" font-size="9"
          :fill="z.accent" fill-opacity=".3">{{ items.filter(i=>i.stage===z.id).length }}</text>
      </g>

      <!-- River body fill -->
      <path :d="riverPath(true) + ' L ' + W + ',' + BANK_BOT + ' L 0,' + BANK_BOT + ' Z'"
        fill="url(#river-fill)" opacity=".9"/>

      <!-- River top bank line -->
      <path :d="riverPath(true)" fill="none" stroke="rgba(148,163,184,.18)" stroke-width="1.5"/>
      <!-- River bottom bank line -->
      <path :d="riverPath(false)" fill="none" stroke="rgba(148,163,184,.18)" stroke-width="1.5"/>

      <!-- Friction cloud: red translucent haze over active zone when items are blocked there -->
      <ellipse v-if="blockerCount > 0"
        :cx="activeZone.x + activeZone.w * 0.55" :cy="(BANK_TOP+BANK_BOT)/2"
        :rx="activeZone.w * 0.65 + blockerCount * 14"
        :ry="channelWidth(activeZone)/2 * 0.7"
        fill="url(#friction-halo)" filter="url(#riv-soft)"
      />

      <!-- Flow particles -->
      <g clip-path="url(#river-clip)">
        <circle v-for="(p, i) in particles" :key="'p'+i"
          :cx="p.x" :cy="p.y" :r="p.r"
          :fill="p.col" :fill-opacity="p.opacity"
          :filter="p.stage==='done' ? 'url(#riv-glow)' : ''"
        />
      </g>

      <!-- Item nodes on the river -->
      <g v-for="np in nodePositions" :key="'n'+np.item.id"
        style="cursor:pointer"
        @click="selItem = selItem?.id===np.item.id ? null : np.item"
      >
        <!-- Bloom halo for done items -->
        <circle v-if="np.item.stage==='done'"
          :cx="np.x" :cy="np.y" r="22"
          :fill="nodeColor(np.item)" fill-opacity="0.08"
          filter="url(#riv-bloom)"
        />
        <!-- Blocked friction ring (pulsing outer ring — item is stuck in place) -->
        <circle v-if="np.item.blocked"
          :cx="np.x" :cy="np.y"
          :r="(np.item.priority==='critical' ? 14 : 10) + 7"
          fill="none" stroke="#ef4444"
          stroke-width="1.5" stroke-opacity="0.55"
          stroke-dasharray="3,4"
          filter="url(#riv-glow)"
        />
        <!-- Node circle — blocked items use red tint -->
        <circle :cx="np.x" :cy="np.y"
          :r="np.item.priority==='critical' ? 14 : 10"
          :fill="np.item.blocked ? '#7f1d1d' : nodeColor(np.item)"
          :fill-opacity="selItem?.id===np.item.id ? 1 : 0.82"
          :stroke="np.item.blocked ? '#ef4444' : nodeColor(np.item)"
          :stroke-width="np.item.priority==='critical' ? 2 : 1"
          :stroke-opacity="np.item.blocked ? 0.8 : 0.6"
          filter="url(#riv-glow)"
        />
        <!-- Type glyph — ⚠ for blocked overtakes normal glyph -->
        <text :x="np.x" :y="np.y + 4"
          text-anchor="middle" font-size="8"
          :fill="np.item.blocked ? '#fca5a5' : '#fff'" fill-opacity=".9">
          {{ np.item.blocked ? '⚠' : typeGlyph[np.item.type] }}
        </text>
        <!-- Label -->
        <text :x="np.x" :y="np.y - (np.item.priority==='critical'?18:14)"
          text-anchor="middle" font-size="8"
          :fill="np.item.blocked ? '#f87171' : nodeColor(np.item)" fill-opacity=".75"
          font-weight="600">{{ np.item.label.split(' ').slice(0,2).join(' ') }}</text>
      </g>

      <!-- CRITICAL decision arrow pointing up from river -->
      <g v-for="np in nodePositions.filter(n=>n.item.priority==='critical')" :key="'crit'+np.item.id">
        <path :d="`M ${np.x},${np.y-16} L ${np.x},${np.y-34}`"
          stroke="#ef4444" stroke-width="1.5" stroke-dasharray="3,3" opacity=".6"
          marker-end="url(#crit-arr)"/>
      </g>
      <defs>
        <marker id="crit-arr" markerWidth="5" markerHeight="5" refX="2.5" refY="2.5" orient="auto">
          <polygon points="0 5,2.5 0,5 5" fill="#ef4444" opacity=".7"/>
        </marker>
      </defs>

      <!-- Right bank: done pool -->
      <text x="970" y="460" text-anchor="middle" font-size="8" fill="#c084fc" fill-opacity=".35"
        font-family="'JetBrains Mono',monospace" letter-spacing=".12em">SHIPS</text>

      <!-- Flow direction arrow -->
      <path d="M 20,50 L 1080,50" stroke="rgba(148,163,184,.08)" stroke-width="1"/>
      <text x="550" y="47" text-anchor="middle" font-size="7.5" fill="rgba(148,163,184,.2)"
        letter-spacing=".15em" font-family="'JetBrains Mono',monospace">FLOW →</text>

    </svg>

    <!-- Item detail panel -->
    <transition name="riv-panel">
      <div v-if="selItem"
        style="position:absolute;bottom:20px;left:50%;transform:translateX(-50%);
          width:420px;z-index:30;
          background:rgba(5,8,15,.93);backdrop-filter:blur(16px);
          border-radius:10px;overflow:hidden;
          box-shadow:0 8px 40px rgba(0,0,0,.7)"
        :style="{ border: `1px solid ${nodeColor(selItem)}30` }"
      >
        <div style="display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid rgba(255,255,255,.06)">
          <span :style="{ fontSize:'12px', color: nodeColor(selItem) }">{{ typeGlyph[selItem.type] }}</span>
          <span :style="{ fontSize:'8px', fontWeight:700, letterSpacing:'.14em', textTransform:'uppercase', color: selItem.areaColor }">{{ selItem.area }}</span>
          <span v-if="selItem.priority==='critical'"
            style="font-size:7px;font-weight:700;letter-spacing:.1em;color:#ef4444;
              padding:1px 7px;border:1px solid rgba(239,68,68,.35);border-radius:3px">CRITICAL</span>
          <button @click="selItem=null" style="margin-left:auto;background:none;border:none;color:#475569;cursor:pointer;font-size:12px">✕</button>
        </div>
        <div style="padding:14px 18px">
          <div style="font-size:15px;font-weight:700;color:#e2e8f0;margin-bottom:6px">{{ selItem.label }}</div>
          <span @click="copyId(selItem.id)"
            :style="`display:inline-block;font-size:11px;font-family:'JetBrains Mono',monospace;cursor:copy;padding:2px 8px;border-radius:3px;border:1px solid;margin-bottom:8px;transition:color .15s,background .15s,border-color .15s;${copiedId===selItem.id?'color:#4ade80;border-color:rgba(74,222,128,.3);background:rgba(74,222,128,.08)':'color:#64748b;border-color:rgba(255,255,255,.1);background:rgba(255,255,255,.04)'}`"
            :title="copiedId===selItem.id?'Copied!':'Click to copy ID'">{{ copiedId===selItem.id ? '✓ copied' : selItem.id }}</span>
          <div v-if="selItem.blocked" style="font-size:11px;color:#fca5a5;margin-bottom:10px">
            ⚠ Blocked — waiting for a decision{{ selItem.unblocks ? `. Unblocks ${selItem.unblocks} downstream items.` : '.' }}
          </div>
          <div v-if="selItem.stage==='done'" style="font-size:11px;color:#c084fc;margin-bottom:10px">
            ▶ Demo ready — awaiting your review
          </div>
          <div style="display:flex;gap:8px">
            <button style="flex:1;padding:8px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);
              border-radius:5px;color:#94a3b8;font-size:10px;font-weight:700;cursor:pointer;letter-spacing:.06em;font-family:inherit">
              Open in frame →
            </button>
          </div>
        </div>
      </div>
    </transition>

    <!-- Legend -->
    <div style="position:absolute;top:16px;right:20px;display:flex;flex-direction:column;gap:6px;z-index:10">
      <div style="font-size:8px;color:rgba(255,255,255,.2);letter-spacing:.14em;text-transform:uppercase;margin-bottom:2px">FLOW MAP</div>
      <div style="font-size:9px;color:rgba(255,255,255,.2);display:flex;align-items:center;gap:6px">
        <span style="display:inline-block;width:32px;height:2px;background:linear-gradient(to right,rgba(148,163,184,.1),rgba(148,163,184,.4))"></span>
        narrow = fast flow
      </div>
      <div style="font-size:9px;color:rgba(239,68,68,.5);display:flex;align-items:center;gap:6px">
        <span style="display:inline-block;width:32px;height:6px;background:rgba(239,68,68,.3);border-radius:2px"></span>
        wide = WIP piling up
      </div>
      <div style="font-size:9px;color:rgba(239,68,68,.6);display:flex;align-items:center;gap:6px">
        <span style="font-size:12px">⚠</span> boulder = blocked
      </div>
    </div>

    <!-- Hint -->
    <div style="position:absolute;bottom:20px;right:20px;font-size:9px;color:rgba(255,255,255,.15);letter-spacing:.07em">
      CLICK A NODE TO INSPECT
    </div>

  </div>
</template>

<style scoped>
.riv-panel-enter-active, .riv-panel-leave-active { transition: opacity .2s, transform .2s; }
.riv-panel-enter-from, .riv-panel-leave-to       { opacity:0; transform:translateX(-50%) translateY(12px); }
</style>
