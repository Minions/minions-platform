<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, onActivated, onDeactivated } from 'vue'
import { callMCPThroneRaw, getWorkRepoNames } from '../api/cabinet'
import type { PlanResult, PlanItemRecord, GsdFrame, GsdFrameType } from '@minions/mcp-types'
import { computeGsdLayouts, shortLabel } from '../plan/computeGsdLayout'
import type { GsdFrameLayout } from '../plan/computeGsdLayout'

// ── Data loading ──────────────────────────────────────────────────────────────

const items = ref<Record<string, PlanItemRecord>>({})
const rootIds = ref<string[]>([])
const frames = ref<GsdFrame[]>([])
const loading = ref(true)
const error = ref<string | null>(null)

async function loadAll() {
  loading.value = true
  error.value = null
  try {
    // No single "the" plan repo — the plan tool has no default `repo` for
    // non-wing resolution, so read every lair-registered work repo explicitly.
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
    rootIds.value = ids

    const subtrees = await Promise.all(
      ids.map(id => callMCPThroneRaw<PlanResult>('plan', { action: 'get-subtree', itemId: id, repo: rootRepo[id] }))
    )
    const merged: Record<string, PlanItemRecord> = {}
    for (const r of subtrees) {
      if (r.action === 'get-subtree' && r.subtree) Object.assign(merged, r.subtree.items)
    }
    items.value = merged

    // Ask Jarvis (the AI) to compute frames from the plan data
    const result = await callMCPThroneRaw<{ frames: GsdFrame[] }>('gsd_compute_frames', {
      items: merged,
      rootIds: ids,
    })
    frames.value = (result.frames ?? []).sort((a, b) => a.priority - b.priority)
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to load'
  } finally {
    loading.value = false
  }
}

onMounted(loadAll)

// ── Layout ────────────────────────────────────────────────────────────────────

const CX = 490, CY = 280, SVG_W = 980, SVG_H = 560

const frameLayouts = computed(() => computeGsdLayouts(frames.value, CX, CY))
const layoutMap = computed(() => Object.fromEntries(frameLayouts.value.map(l => [l.id, l])))
const frameMap = computed(() => Object.fromEntries(frames.value.map(f => [f.id, f])))

// ── Animation ─────────────────────────────────────────────────────────────────

const t = ref(0)
let raf = 0
let isVisible = true
const t0 = Date.now()

function startAnimation() {
  const loop = () => {
    if (!isVisible) return
    t.value = (Date.now() - t0) / 1000
    raf = requestAnimationFrame(loop)
  }
  raf = requestAnimationFrame(loop)
}

onMounted(startAnimation)
onUnmounted(() => cancelAnimationFrame(raf))
onActivated(() => { isVisible = true; startAnimation() })
onDeactivated(() => { isVisible = false; cancelAnimationFrame(raf) })

function spokeDot(layout: GsdFrameLayout) {
  const dx = layout.x - CX, dy = layout.y - CY
  const speed = 0.14
  const p = ((t.value * speed + layout.spokeDotOffset) % 1) * 0.78
  return { x: CX + dx * p, y: CY + dy * p }
}

const jarvisScale = computed(() => 1 + 0.06 * Math.sin(t.value * 1.2))

// ── Frame type config ─────────────────────────────────────────────────────────

interface FrameTypeConfig {
  label: string
  glyph: string
  color: string
  accent: string
}

const frameTypeConfig: Record<GsdFrameType, FrameTypeConfig> = {
  'unblock':   { label: 'UNBLOCK',    glyph: '⚡', color: '#ef4444', accent: '#fca5a5' },
  'refine':    { label: 'REFINE',     glyph: '◎', color: '#3b82f6', accent: '#93c5fd' },
  'pathfind':  { label: 'PATHFIND',   glyph: '⬡', color: '#f59e0b', accent: '#fbbf24' },
  'risk-scan': { label: 'RISK SCAN',  glyph: '→', color: '#a855f7', accent: '#d8b4fe' },
  'capture':   { label: 'CAPTURE',    glyph: '✦', color: '#22c55e', accent: '#86efac' },
}

// ── Sector hints ──────────────────────────────────────────────────────────────

const sectors = [
  { label: 'URGENT',  startDeg: -60,  endDeg: 60,  color: 'rgba(239,68,68,.05)'  },
  { label: 'BUILD',   startDeg: 60,   endDeg: 180, color: 'rgba(59,130,246,.04)' },
  { label: 'IMAGINE', startDeg: 180,  endDeg: 280, color: 'rgba(34,197,94,.04)'  },
  { label: 'TIME',    startDeg: 280,  endDeg: 360, color: 'rgba(168,85,247,.04)' },
]

function sectorPath(startDeg: number, endDeg: number, outerR: number): string {
  const s = startDeg * Math.PI / 180
  const e = endDeg * Math.PI / 180
  const x1 = Math.cos(s) * outerR, y1 = Math.sin(s) * outerR
  const x2 = Math.cos(e) * outerR, y2 = Math.sin(e) * outerR
  const large = endDeg - startDeg > 180 ? 1 : 0
  return `M 0,0 L ${x1},${y1} A ${outerR},${outerR} 0 ${large} 1 ${x2},${y2} Z`
}

// ── Shape paths ───────────────────────────────────────────────────────────────

function shapePath(shape: GsdFrameLayout['shape'], r: number): string {
  switch (shape) {
    case 'diamond': {
      const w = r * 0.82
      return `M 0,${-r} L ${w},0 L 0,${r} L ${-w},0 Z`
    }
    case 'hexagon': {
      const pts = Array.from({ length: 6 }, (_, i) => {
        const a = (i * 60 - 30) * Math.PI / 180
        return `${(r * Math.cos(a)).toFixed(1)},${(r * Math.sin(a)).toFixed(1)}`
      })
      return `M ${pts.join(' L ')} Z`
    }
    case 'shield': {
      const shieldPoints: Array<[number, number]> = [
        [0, -r], [r * 0.88, -r * 0.3], [r * 0.55, r * 0.95],
        [-r * 0.55, r * 0.95], [-r * 0.88, -r * 0.3],
      ]
      const pts = shieldPoints.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`)
      return `M ${pts.join(' L ')} Z`
    }
    case 'blob':
      return '' // rendered as <circle>
    case 'arrow': {
      const h = r * 0.55, tip = r * 1.1, back = -r * 0.9
      return `M ${back},${-h} L ${r * 0.3},${-h} L ${tip},0 L ${r * 0.3},${h} L ${back},${h} L ${back - r * 0.15},0 Z`
    }
  }
}

// ── Tooltip positioning ───────────────────────────────────────────────────────

function tooltipX(layout: GsdFrameLayout, w: number): number {
  return layout.x + layout.r + 14 + w < SVG_W
    ? layout.x + layout.r + 14
    : layout.x - layout.r - w - 14
}

function tooltipY(layout: GsdFrameLayout, h: number): number {
  return Math.max(8, Math.min(SVG_H - h - 8, layout.y - h / 2))
}

// ── Hover ─────────────────────────────────────────────────────────────────────

const hoveredId = ref<string | null>(null)
const hovFrame = computed(() => hoveredId.value ? frameMap.value[hoveredId.value] ?? null : null)
const hovLayout = computed(() => hoveredId.value ? layoutMap.value[hoveredId.value] ?? null : null)

// ── Frame session ─────────────────────────────────────────────────────────────

const selectedFrameId = ref<string | null>(null)
const frameItemIdx = ref(0)
const noteText = ref('')

const activeFrame = computed<GsdFrame | null>(() =>
  selectedFrameId.value ? frameMap.value[selectedFrameId.value] ?? null : null
)
const frameItems = computed(() =>
  activeFrame.value?.items
    .map(fi => items.value[fi.itemId])
    .filter((it): it is PlanItemRecord => it !== undefined) ?? []
)
const currentItem = computed(() => frameItems.value[frameItemIdx.value] ?? null)
const currentRole = computed(() => activeFrame.value?.items[frameItemIdx.value]?.role ?? 'chain')

function enterFrame(id: string) {
  selectedFrameId.value = id
  frameItemIdx.value = 0
  hoveredId.value = null
  noteText.value = ''
}
function exitFrame() { selectedFrameId.value = null }
function nextItem() { if (frameItemIdx.value < frameItems.value.length - 1) frameItemIdx.value++ }
function prevItem() { if (frameItemIdx.value > 0) frameItemIdx.value-- }

const roleLabel: Record<string, string> = {
  anchor: 'START HERE', chain: 'Then', context: 'Context',
}

// ── Stats ─────────────────────────────────────────────────────────────────────

const blockedCount = computed(() =>
  Object.values(items.value).filter(it => it.questions && it.questions.length > 0).length
)
const wipCount = computed(() =>
  Object.values(items.value).filter(it => it.started && !it.demoLink).length
)
const demoReadyCount = computed(() =>
  Object.values(items.value).filter(it => it.demoLink).length
)

const recommendedId = computed(() =>
  frames.value.find(f => f.type === 'unblock')?.id ?? frames.value[0]?.id ?? null
)
</script>

<template>
  <div style="position:relative;display:flex;flex-direction:column;height:100%;overflow:hidden;
    background:#040302;font-family:'Inter',system-ui,sans-serif;color:#c9bfb3">

    <!-- Loading -->
    <div v-if="loading" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
      background:#040302;z-index:100;flex-direction:column;gap:12px">
      <div style="font-size:18px;font-weight:700;color:#d4a017;font-family:'Georgia',serif">J</div>
      <div style="font-size:10px;color:#3a3530;letter-spacing:.1em">Jarvis is thinking…</div>
    </div>

    <!-- Error -->
    <div v-else-if="error" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
      background:#040302;z-index:100">
      <div style="text-align:center;max-width:400px;padding:24px">
        <div style="font-size:12px;color:#ef4444;margin-bottom:12px">{{ error }}</div>
        <button @click="loadAll" style="padding:8px 20px;background:transparent;border:1px solid rgba(239,68,68,.3);
          border-radius:4px;color:#ef4444;font-size:11px;cursor:pointer;font-family:inherit">Retry</button>
      </div>
    </div>

    <template v-else>

      <!-- ══ FRAME SESSION ══════════════════════════════════════════════════════ -->
      <transition name="session">
        <div v-if="selectedFrameId && activeFrame"
          style="position:absolute;inset:0;display:flex;flex-direction:column;z-index:50;background:#040302">

          <header style="height:44px;flex-shrink:0;background:#070503;border-bottom:1px solid rgba(255,200,100,.07);
            display:flex;align-items:center;justify-content:space-between;padding:0 24px">
            <div style="display:flex;align-items:center;gap:10px">
              <span style="font-size:13px;font-weight:700;color:#d4a017;font-family:'Georgia',serif">J</span>
              <span style="width:1px;height:16px;background:rgba(255,255,255,.07)"></span>
              <span :style="{
                fontSize: '9px', fontWeight: 700, letterSpacing: '.14em', textTransform: 'uppercase',
                padding: '3px 12px', borderRadius: '4px',
                background: `${frameTypeConfig[activeFrame.type].color}18`,
                color: frameTypeConfig[activeFrame.type].accent,
                border: `1px solid ${frameTypeConfig[activeFrame.type].color}30`,
              }">{{ frameTypeConfig[activeFrame.type].glyph }} {{ activeFrame.title }}</span>
              <span style="font-size:10px;color:rgba(255,255,255,.2)">{{ frameItemIdx + 1 }} / {{ frameItems.length }}</span>
            </div>
            <button @click="exitFrame"
              style="padding:5px 16px;background:transparent;border:1px solid rgba(255,200,100,.12);
                border-radius:4px;color:rgba(212,160,23,.5);font-size:10px;font-weight:700;
                letter-spacing:.1em;cursor:pointer;font-family:inherit;transition:color .15s"
              @mouseenter="($event.currentTarget as HTMLElement).style.color = '#d4a017'"
              @mouseleave="($event.currentTarget as HTMLElement).style.color = 'rgba(212,160,23,.5)'"
            >↑ All frames</button>
          </header>

          <div style="flex:1;min-height:0;display:flex;overflow:hidden">
            <!-- Sidebar -->
            <div style="width:220px;flex-shrink:0;border-right:1px solid rgba(255,200,100,.05);padding:20px 16px;overflow:auto">
              <!-- Jarvis rationale — high contrast, at the top -->
              <div style="padding:12px 14px;border-radius:6px;background:rgba(212,160,23,.06);
                border:1px solid rgba(212,160,23,.18);margin-bottom:16px">
                <div style="font-size:9px;color:rgba(212,160,23,.6);font-family:'Georgia',serif;margin-bottom:5px">Jarvis</div>
                <div style="font-size:11px;color:#c4a96a;font-family:'Georgia',serif;font-style:italic;line-height:1.6">
                  "{{ activeFrame.rationale }}"
                </div>
              </div>

              <div style="font-size:8.5px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;
                color:rgba(255,255,255,.15);margin-bottom:14px">This frame</div>
              <div v-for="(fi, idx) in activeFrame.items" :key="fi.itemId"
                @click="frameItemIdx = idx"
                style="padding:8px 10px;border-radius:5px;margin-bottom:4px;cursor:pointer;transition:all .14s"
                :style="{
                  background: idx === frameItemIdx ? `${frameTypeConfig[activeFrame.type].color}15` : 'transparent',
                  border: `1px solid ${idx === frameItemIdx ? frameTypeConfig[activeFrame.type].color + '30' : 'transparent'}`,
                  opacity: fi.role === 'context' ? 0.65 : fi.role === 'chain' ? 0.9 : 1,
                }"
              >
                <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px">
                  <span :style="{ fontSize: '7px', letterSpacing: '.1em', textTransform: 'uppercase',
                    color: idx === frameItemIdx ? frameTypeConfig[activeFrame.type].accent : 'rgba(255,255,255,.2)' }">
                    {{ roleLabel[fi.role] ?? fi.role }}
                  </span>
                  <span v-if="items[fi.itemId]?.questions?.length" style="margin-left:auto;font-size:8px;color:#ef4444">⚠</span>
                  <span v-else-if="items[fi.itemId]?.demoLink" style="margin-left:auto;font-size:8px;color:#a855f7">▶</span>
                </div>
                <div :style="{ fontSize: '11px', lineHeight: 1.3,
                  color: idx === frameItemIdx ? '#e2e8f0' : '#5a5450',
                  fontWeight: idx === frameItemIdx ? 600 : 400 }">
                  {{ items[fi.itemId]?.title ?? fi.itemId }}
                </div>
              </div>
              <!-- Jarvis rationale — top of sidebar, high contrast -->

            </div>

            <!-- Work area -->
            <div style="flex:1;overflow:auto;padding:32px 40px 28px;max-width:660px" v-if="currentItem">
              <transition name="brief" mode="out-in">
                <div :key="currentItem.id">
                  <!-- Blocked banner -->
                  <div v-if="currentItem.questions?.length"
                    style="margin-bottom:18px;padding:10px 16px;border-radius:5px;
                      background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.22);
                      display:flex;align-items:center;gap:10px">
                    <span style="font-size:12px;color:#ef4444">⚠</span>
                    <span style="font-size:11px;color:#f87171">
                      Blocked — {{ currentItem.questions.length }} open question{{ currentItem.questions.length > 1 ? 's' : '' }}
                    </span>
                  </div>
                  <!-- Demo-ready banner -->
                  <div v-else-if="currentItem.demoLink"
                    style="margin-bottom:18px;padding:10px 16px;border-radius:5px;
                      background:rgba(168,85,247,.08);border:1px solid rgba(168,85,247,.22);
                      display:flex;align-items:center;gap:10px">
                    <span style="font-size:12px;color:#a855f7">▶</span>
                    <span style="font-size:11px;color:#d8b4fe">Demo ready — awaiting review</span>
                    <a :href="currentItem.demoLink" target="_blank"
                      style="margin-left:auto;font-size:10px;color:#a855f7;text-decoration:none;opacity:.7">
                      Open demo →
                    </a>
                  </div>

                  <!-- Item header -->
                  <div style="display:flex;align-items:center;gap:10px;margin-bottom:20px">
                    <span :style="{
                      fontSize: '8.5px', fontWeight: 700, letterSpacing: '.16em', textTransform: 'uppercase',
                      padding: '3px 10px', borderRadius: '3px',
                      background: `${frameTypeConfig[activeFrame.type].color}18`,
                      color: frameTypeConfig[activeFrame.type].color,
                      border: `1px solid ${frameTypeConfig[activeFrame.type].color}35`,
                    }">{{ currentItem.type.toUpperCase() }}</span>
                    <span style="font-size:9px;color:rgba(255,255,255,.3);letter-spacing:.06em">
                      {{ currentRole.toUpperCase() }}
                    </span>
                    <span v-if="currentItem.started && !currentItem.demoLink"
                      style="font-size:8px;font-weight:700;letter-spacing:.12em;color:#f59e0b;
                        padding:2px 8px;border:1px solid rgba(245,158,11,.3);border-radius:3px">WIP</span>
                  </div>

                  <h1 style="font-size:26px;font-weight:700;color:#e8e0d6;line-height:1.25;margin:0 0 18px;letter-spacing:-.01em">
                    {{ currentItem.title }}
                  </h1>

                  <div style="margin-bottom:24px">
                    <textarea v-model="noteText"
                      placeholder="Your thoughts…"
                      rows="4"
                      style="width:100%;box-sizing:border-box;padding:16px 20px;resize:none;
                        background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);
                        border-radius:6px;color:#c9bfb3;font-size:13px;font-family:'Georgia',serif;
                        outline:none;line-height:1.7;caret-color:#d4a017"
                    ></textarea>
                  </div>

                  <div style="display:flex;align-items:center;gap:10px">
                    <button @click="nextItem" :style="{
                      padding: '12px 28px', borderRadius: '5px', border: 'none', cursor: 'pointer',
                      fontSize: '12px', fontWeight: 700, letterSpacing: '.05em', fontFamily: 'inherit',
                      background: `linear-gradient(135deg,${frameTypeConfig[activeFrame.type].color}bb,${frameTypeConfig[activeFrame.type].color})`,
                      color: '#fff',
                      boxShadow: `0 4px 20px ${frameTypeConfig[activeFrame.type].color}40`,
                    }">{{ currentItem.demoLink ? 'Review & next' : currentItem.questions?.length ? 'Decide & next' : 'Next' }}</button>
                    <button @click="nextItem"
                      style="padding:12px 18px;background:transparent;border:1px solid rgba(255,255,255,.08);
                        border-radius:5px;color:rgba(255,255,255,.25);font-size:11px;cursor:pointer;
                        letter-spacing:.06em;font-family:inherit">Skip</button>
                    <button v-if="frameItemIdx > 0" @click="prevItem"
                      style="padding:12px 14px;background:transparent;border:none;
                        color:rgba(255,255,255,.2);font-size:11px;cursor:pointer;font-family:inherit">← Back</button>
                  </div>
                </div>
              </transition>
            </div>

            <!-- Empty frame (capture with no items) -->
            <div v-else style="flex:1;display:flex;align-items:center;justify-content:center;padding:40px">
              <div style="text-align:center;max-width:420px">
                <div style="font-size:28px;color:#22c55e;margin-bottom:16px;opacity:.6">✦</div>
                <div style="font-size:18px;font-weight:600;color:#e8e0d6;margin-bottom:12px">{{ activeFrame.title }}</div>
                <div style="font-size:13px;color:#5a5045;font-family:'Georgia',serif;font-style:italic;line-height:1.7">
                  "{{ activeFrame.rationale }}"
                </div>
                <div style="margin-top:24px;font-size:11px;color:#3a3530;font-family:'Georgia',serif">
                  What do you want to build?
                </div>
              </div>
            </div>
          </div>
        </div>
      </transition>

      <!-- ══ RADIAL FRAME MAP ═══════════════════════════════════════════════════ -->
      <transition name="overview">
        <div v-if="!selectedFrameId" style="position:absolute;inset:0;display:flex;flex-direction:column">

          <!-- Jarvis header -->
          <header style="position:absolute;top:0;left:0;right:0;padding:16px 24px;z-index:10;
            display:flex;align-items:baseline;gap:10px;pointer-events:none">
            <span style="font-size:14px;font-weight:700;color:#d4a017;font-family:'Georgia',serif">Jarvis</span>
            <span style="width:4px;height:4px;border-radius:50%;background:#22c55e;
              box-shadow:0 0 5px #22c55e;display:inline-block;margin-bottom:2px;animation:hb 2.4s ease-in-out infinite"></span>
            <span style="font-size:11px;color:#3a3530;font-family:'Georgia',serif;font-style:italic">
              — {{ wipCount }} in progress · {{ blockedCount }} blocked · {{ demoReadyCount }} demo ready
            </span>
          </header>

          <!-- Empty state -->
          <div v-if="frames.length === 0"
            style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">
            <div style="text-align:center;opacity:.4">
              <div style="font-size:32px;margin-bottom:12px;color:#d4a017;font-family:'Georgia',serif">J</div>
              <div style="font-size:11px;color:#4a4030;font-family:'Georgia',serif;font-style:italic">
                "Nothing pressing right now. Good time to imagine something."
              </div>
            </div>
          </div>

          <!-- SVG map -->
          <svg v-else :viewBox="`0 0 ${SVG_W} ${SVG_H}`"
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
              <radialGradient id="bg-grad" cx="50%" cy="50%" r="60%">
                <stop offset="0%"   stop-color="#0a0806" stop-opacity="1"/>
                <stop offset="100%" stop-color="#020201" stop-opacity="1"/>
              </radialGradient>
              <radialGradient v-for="f in frames" :key="'fg' + f.id" :id="'fg-' + f.id" cx="50%" cy="50%" r="50%">
                <stop offset="0%"   :stop-color="frameTypeConfig[f.type].color" stop-opacity="0.55"/>
                <stop offset="100%" :stop-color="frameTypeConfig[f.type].color" stop-opacity="0.06"/>
              </radialGradient>
            </defs>

            <rect x="0" y="0" :width="SVG_W" :height="SVG_H" fill="url(#bg-grad)"/>

            <!-- Sector hints -->
            <g :transform="`translate(${CX},${CY})`" pointer-events="none">
              <path v-for="s in sectors" :key="s.label" :d="sectorPath(s.startDeg, s.endDeg, 340)" :fill="s.color"/>
            </g>

            <!-- Spokes + travelers -->
            <g pointer-events="none">
              <line v-for="fl in frameLayouts" :key="'sp' + fl.id"
                :x1="CX" :y1="CY" :x2="fl.x" :y2="fl.y"
                :stroke="frameMap[fl.id] ? frameTypeConfig[frameMap[fl.id]!.type].color : '#fff'"
                :stroke-opacity="hoveredId === fl.id ? 0.25 : 0.08"
                stroke-width="1" stroke-dasharray="4,8"
              />
              <circle v-for="fl in frameLayouts" :key="'sd' + fl.id"
                :cx="spokeDot(fl).x" :cy="spokeDot(fl).y" r="2.5"
                :fill="frameMap[fl.id] ? frameTypeConfig[frameMap[fl.id]!.type].accent : '#fff'"
                :fill-opacity="hoveredId === fl.id ? 0.9 : 0.35"
                filter="url(#or-glow)"
              />
            </g>

            <!-- Distance rings -->
            <g :transform="`translate(${CX},${CY})`" pointer-events="none">
              <circle r="160" fill="none" stroke="rgba(255,255,255,.025)" stroke-width="1" stroke-dasharray="2,12"/>
              <circle r="230" fill="none" stroke="rgba(255,255,255,.018)" stroke-width="1" stroke-dasharray="2,12"/>
              <circle r="300" fill="none" stroke="rgba(255,255,255,.012)" stroke-width="1" stroke-dasharray="2,12"/>
            </g>

            <!-- Jarvis center -->
            <g :transform="`translate(${CX},${CY})`" pointer-events="none">
              <circle r="60" fill="rgba(212,160,23,.08)" filter="url(#or-bloom)"/>
              <circle r="48" fill="none" stroke="rgba(212,160,23,.12)" stroke-width="1"/>
              <circle r="36" fill="none" stroke="rgba(212,160,23,.18)" stroke-width="1"/>
              <circle :r="22 * jarvisScale" fill="rgba(212,160,23,.15)"
                stroke="rgba(212,160,23,.5)" stroke-width="1.5" filter="url(#or-glow)"/>
              <text x="0" y="6" text-anchor="middle" font-size="16" font-weight="700"
                fill="#d4a017" font-family="'Georgia',serif" fill-opacity=".9">J</text>
              <text x="0" y="38" text-anchor="middle" font-size="7.5" fill="rgba(212,160,23,.35)"
                letter-spacing=".16em" font-family="'JetBrains Mono',monospace">JARVIS</text>
            </g>

            <!-- Frame nodes -->
            <g v-for="fl in frameLayouts" :key="fl.id">
              <g :transform="`translate(${fl.x},${fl.y})`"
                style="cursor:pointer"
                @mouseenter="hoveredId = fl.id"
                @mouseleave="hoveredId = null"
                @click.stop="enterFrame(fl.id)"
              >
                <circle :r="fl.r * 2.8"
                  :fill="`url(#fg-${fl.id})`"
                  :fill-opacity="hoveredId === fl.id ? 1 : 0.6"
                  filter="url(#or-bloom)"
                />
                <circle :r="fl.r + 8"
                  :fill="frameMap[fl.id] ? frameTypeConfig[frameMap[fl.id]!.type].color : '#fff'"
                  :fill-opacity="hoveredId === fl.id ? 0.14 : 0.06"
                  filter="url(#or-glow)"
                />
                <!-- Shape: arrow rotates radially, others are static -->
                <g :transform="fl.shape === 'arrow' ? `rotate(${fl.rotationDeg})` : ''">
                  <circle v-if="fl.shape === 'blob'" :r="fl.r"
                    :fill="frameMap[fl.id] ? frameTypeConfig[frameMap[fl.id]!.type].color : '#fff'"
                    :fill-opacity="hoveredId === fl.id ? 0.28 : 0.18"
                    :stroke="frameMap[fl.id] ? frameTypeConfig[frameMap[fl.id]!.type].accent : '#fff'"
                    :stroke-width="hoveredId === fl.id ? 2 : 1.5"
                    stroke-opacity="0.75" filter="url(#or-glow)"
                  />
                  <path v-else
                    :d="shapePath(fl.shape, fl.r)"
                    :fill="frameMap[fl.id] ? frameTypeConfig[frameMap[fl.id]!.type].color : '#fff'"
                    :fill-opacity="hoveredId === fl.id ? 0.28 : 0.18"
                    :stroke="frameMap[fl.id] ? frameTypeConfig[frameMap[fl.id]!.type].accent : '#fff'"
                    :stroke-width="hoveredId === fl.id ? 2 : 1.5"
                    stroke-opacity="0.75" filter="url(#or-glow)"
                  />
                </g>
                <!-- Glyph (counter-rotated for arrows so it stays upright) -->
                <text x="0" y="5" text-anchor="middle" dominant-baseline="middle"
                  :font-size="fl.r * 0.6"
                  :fill="frameMap[fl.id] ? frameTypeConfig[frameMap[fl.id]!.type].accent : '#fff'"
                  fill-opacity="0.9" filter="url(#or-glow)">
                  {{ frameMap[fl.id] ? frameTypeConfig[frameMap[fl.id]!.type].glyph : '' }}
                </text>
                <!-- Label placed radially away from center, short title only -->
                <text
                  :x="fl.labelDx" :y="fl.labelDy + 4"
                  :text-anchor="fl.textAnchor"
                  font-size="10"
                  :fill="frameMap[fl.id] ? frameTypeConfig[frameMap[fl.id]!.type].accent : '#fff'"
                  :fill-opacity="hoveredId === fl.id ? 0.95 : 0.5"
                  font-weight="600" font-family="'Inter',system-ui">
                  {{ shortLabel(frameMap[fl.id]?.title ?? '') }}
                </text>
                <text v-if="fl.id === recommendedId"
                  :x="fl.labelDx" :y="fl.labelDy - 9"
                  :text-anchor="fl.textAnchor"
                  font-size="7" fill="#d4a017" fill-opacity="0.7" letter-spacing=".12em"
                  font-family="'JetBrains Mono',monospace">RECOMMENDED</text>
              </g>
            </g>

            <!-- Hover tooltip -->
            <foreignObject v-if="hovFrame && hovLayout"
              :x="tooltipX(hovLayout, 240)"
              :y="tooltipY(hovLayout, 210)"
              width="240" height="210"
              style="pointer-events:none"
            >
              <div xmlns="http://www.w3.org/1999/xhtml"
                style="padding:14px 16px;border-radius:8px;
                  background:rgba(6,4,2,.94);backdrop-filter:blur(12px);
                  font-family:'Inter',system-ui,sans-serif;line-height:1;
                  box-shadow:0 8px 32px rgba(0,0,0,.8)"
                :style="{ border: `1px solid ${frameTypeConfig[hovFrame.type].color}35` }"
              >
                <div :style="{ fontSize: '7.5px', fontWeight: 700, letterSpacing: '.16em',
                  textTransform: 'uppercase', color: frameTypeConfig[hovFrame.type].accent, marginBottom: '8px' }">
                  {{ frameTypeConfig[hovFrame.type].glyph }} {{ frameTypeConfig[hovFrame.type].label }}
                </div>
                <div style="font-size:12px;font-weight:700;color:#e2e8f0;margin-bottom:8px;line-height:1.3">{{ hovFrame.title }}</div>
                <div style="font-size:10px;color:#6b6258;font-family:'Georgia',serif;font-style:italic;line-height:1.5;margin-bottom:10px">
                  "{{ hovFrame.rationale.length > 120 ? hovFrame.rationale.slice(0, 120) + '…' : hovFrame.rationale }}"
                </div>
                <div style="margin-bottom:8px;font-size:9px;color:rgba(255,255,255,.15)">{{ hovFrame.saving }}</div>
                <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:10px">
                  <span v-for="fi in hovFrame.items.slice(0, 4)" :key="fi.itemId"
                    style="font-size:9px;padding:2px 7px;border-radius:3px;line-height:1.4"
                    :style="{
                      background: `${frameTypeConfig[hovFrame.type].color}15`,
                      color: frameTypeConfig[hovFrame.type].accent,
                      border: `1px solid ${frameTypeConfig[hovFrame.type].color}25`,
                      opacity: fi.role === 'context' ? 0.6 : 1,
                    }"
                  >{{ (items[fi.itemId]?.title ?? fi.itemId).split(' ').slice(0, 4).join(' ') }}</span>
                </div>
                <div :style="{ fontSize: '9px', color: frameTypeConfig[hovFrame.type].accent, opacity: .7 }">↵ click to enter</div>
              </div>
            </foreignObject>
          </svg>

          <!-- Legend — bottom left -->
          <div style="position:absolute;bottom:18px;left:20px;pointer-events:none;z-index:10;
            display:flex;flex-direction:column;gap:5px">
            <div v-for="(cfg, type) in frameTypeConfig" :key="type"
              style="display:flex;align-items:center;gap:7px">
              <span :style="{ color: cfg.color, fontSize: '11px', lineHeight: 1 }">{{ cfg.glyph }}</span>
              <span :style="{ fontSize: '8.5px', letterSpacing: '.12em', textTransform: 'uppercase',
                color: cfg.accent, opacity: .55, fontFamily: '\'JetBrains Mono\',monospace' }">
                {{ cfg.label }}
              </span>
            </div>
          </div>
        </div>
      </transition>

    </template>
  </div>
</template>

<style scoped>
@keyframes hb {
  0%, 100% { transform: scale(1); opacity: 1; }
  35%       { transform: scale(1.55); opacity: .8; }
  65%       { transform: scale(1); }
}
.session-enter-active, .session-leave-active   { transition: opacity .22s, transform .22s; }
.session-enter-from, .session-leave-to         { opacity: 0; transform: scale(.97); }
.overview-enter-active, .overview-leave-active { transition: opacity .22s, transform .22s; }
.overview-enter-from, .overview-leave-to       { opacity: 0; transform: scale(1.02); }
.brief-enter-active, .brief-leave-active       { transition: opacity .16s, transform .16s; }
.brief-enter-from  { opacity: 0; transform: translateY(8px); }
.brief-leave-to    { opacity: 0; transform: translateY(-5px); }
</style>
