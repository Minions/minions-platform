# Design Brief: Living Cosmos — Plan Overview

**View role:** Plan overview / spatial DAG navigation  
**Prototype file:** `OverviewDagVariant4.vue`  
**Fidelity:** Medium. Functional prototype with hardcoded sample data and known layout/interaction gaps.

---

## Intent

The plan overview is a living universe. Roots are star clusters. Items are celestial bodies. The overlord navigates at two speeds: zoomed out to sense the overall shape and health of everything in flight, or zoomed into a node to take action on it.

The key design principle: **the view itself communicates system state without requiring the overlord to read anything.** Glowing nodes, orbiting minion sparks, animated dead drops, and pulsing blocked nodes all carry information visually before a word is read.

---

## Visual System

### Background & atmosphere
- Deep space background (`#020509`)
- Nebula-style radial gradient clouds per product area (very subtle, ~3% opacity)
- Fixed star field — static context, not noise

### Product area regions
- Translucent dashed ellipses clustering nodes by the part of the system they affect
- A node in multiple areas sits at the overlap — visualizes cross-cutting concerns
- Area label in matching color at top of ellipse, very low opacity (~30%)

### Node design
- Spherical gradient fill (highlight at 32% cx, 28% cy) — 3D sphere appearance
- Size encodes importance: root nodes ~50px, leaf nodes ~25px
- Status encodes color: gold=WIP, purple=demo-ready, red=blocked, green=ready, blue=staged, grey=lore
- Text: status icon + 2-line label inside the sphere, status label underneath
- Pulsing radius: blocked nodes throb fast (+3.5px), WIP nodes breathe slowly (+2px)

### Edges
- Tree edges: solid, colored to destination node status, 38% opacity, 2px, arrow marker
- Requires cross-links: purple dashed, 55% opacity, 1.8px
- Fork ghost edges: faint blue dashed, 18% opacity — "potential timelines"

### Ghost fork nodes
- Hollow dashed rings (NOT filled spheres) — clearly not real nodes
- Blue stroke, ~4% fill opacity — ghostly, distinct from all real nodes
- Label in italic blue, 30% opacity

### Minion sparks
- Small dots (r=3) clustered in a "cell" below-left of their node, wiggling in place
- On hover: burst outward (exponential decay scatter), creep back over ~2 seconds
- Color matches node status

### Dead drops
- White particles flying between minion positions on different nodes (not along plan edges)
- Simple linear lerp, ~0.27 units/sec, multiple with staggered offsets

### Bloom/glow filters
- `bloom` (stdDeviation=16): large soft halos behind active nodes
- `glow` (stdDeviation=5): crisp glow for rings and icons
- `glow-xs` (stdDeviation=2.5): text and small elements

---

## Interaction Model

### Pan and zoom
- Default view: zoomed in (detail-first). Nodes large enough to read.
- Scroll to zoom (centered on cursor). Drag to pan.
- Zoom range: ~280px wide (deep zoom) to ~1800px wide (full overview)
- Hint: "SCROLL TO ZOOM · DRAG TO PAN · HOVER TO SCATTER"

### Node selection
- Click any node: opens right-side detail panel (slides in, 292px)
- Click again or click canvas background: deselects
- Distinguish click vs drag: `dragMoved` flag

### Detail panel (right side)
- Status badge + full node title
- Active minion indicators (pulsing dots + count)
- **Blocked:** question text + ANSWER and DELEGATE action buttons
- **Demo-ready:** WATCH DEMO gradient button
- **All nodes:** "DROP A NOTE · MINIONS WILL FLOCK" textarea + SUMMON MINION button
- Connected nodes list (click to navigate)
- "CLICK CANVAS TO DESELECT" footer

### Feed panel (top-left, collapsible)
- Shows items awaiting the overlord (blocked decisions, demo-ready)
- Click an alert → selects that node and closes the feed
- Heartbeat dot (scale pulse, not opacity blink)
- Collapses to a "⚠ N AWAITING" pill button

---

## Known Gaps & Build Decisions Needed

1. **Layout algorithm:** Node positions are currently hardcoded. Production needs a layout algorithm (force-directed or hierarchical). Position computation must be stable across re-renders.

2. **Node overlap with area regions:** When areas overlap, nodes at the boundary need to stay visually clear. Current prototype has no handling for this.

3. **Text readability at zoom-out:** Node labels become unreadable when zoomed far out. Production should hide labels below a zoom threshold and show only status color + icon.

4. **Minion count:** Currently static. Production should reflect actual minion assignment from the system.

5. **Dead drop routing:** Currently flies point-to-point between nodes. Should follow actual communication paths (minion-to-minion across adjacent nodes in the plan graph).

6. **Fork/timeline nodes:** Ghost nodes shown as potential timelines for blocked decisions. In production, these should be actual option children of fork plan nodes. The visual treatment (hollow dashed ring, label in italic) should be preserved.

7. **Detail panel actions:** ANSWER/DELEGATE/WATCH DEMO/SUMMON MINION are stubs. Wire to plan API and messaging.

8. **Real-time updates:** Animation loop (rAF) is already reactive. When plan data changes (node status updates, minion arrivals), the SVG re-renders correctly. The only non-trivial part is position updates when nodes are added/removed — this requires the layout algorithm.

---

## Color palette

| Status | Color | Usage |
|--------|-------|-------|
| in-planning | `#64748b` | Lore — slate grey |
| tentatively-approved | `#3b82f6` | Staged — blue |
| ready | `#22c55e` | Ready — green |
| wip | `#f59e0b` | Active — amber/gold |
| demo-ready | `#a855f7` | Done — purple |
| blocked | `#ef4444` | Blocked — red |

Background glow/dim variants derived from same hue family (low saturation darks for the dim stop of the radialGradient).

---

## Prototype errors to fix in production

- Node text can overlap when nodes are close together
- Feed panel hover state uses inline style mutation (should use reactive state)
- `minionPos` computed per-frame in the animation loop — fine for now, will need memoization at scale
- Area region ellipses are hardcoded shapes; need to be derived from node positions
