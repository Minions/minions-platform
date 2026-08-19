# Design Brief: GSD River — System Flow View

**View role:** System flow / flow-stop visualization  
**Prototype file:** `GsdRiver.vue`  
**Fidelity:** Medium. Particle animation works well; node positions are hardcoded; detail panel is minimal.

---

## Intent

The river makes the shape of the system visible at a glance — no reading required. Work flows left to right as water. The overlord reads the river like a weather map: is it flowing cleanly, or is something backing up?

**The core insight:** blockages are not just "blocked" items — they're friction in the whole flow. WIP piling up in the Active zone, demos waiting to drain, items stuck mid-stream — these all show as physical changes in the river's shape. A healthy system has a fast, narrow channel. A struggling system is wide, slow, and turbulent.

This view is complementary to the Oracle: the Oracle is for working *in* frames, the River is for seeing *across* the whole system at once.

---

## Visual System

### River geometry
- Flows **left → right** across the full viewport
- SVG viewBox: `0 0 1100 520` (or scaled to container)
- Channel runs between BANK_TOP (~90px) and BANK_BOT (~430px), center at ~260px
- **Channel width encodes stage health:** narrow = fast flow, wide = WIP piling up

### Stage zones (left → right)
| Zone | Color accent | Width behavior |
|------|-------------|---------------|
| IMAGINE | Indigo `#818cf8` | +12px per item |
| STAGED | Sky blue `#38bdf8` | +12px per item |
| READY | Green `#4ade80` | +12px per item |
| ACTIVE | Amber `#fbbf24` | +18px per item, +25px per *blocked* item |
| DONE | Purple `#c084fc` | Fixed ~75px wide |

Channel width is computed from item count per zone. The curve between zones is a smooth cubic bezier — the river's silhouette is organic, not stepped.

### River fill
- Linear gradient left→right: indigo → sky → green → amber → purple
- Opacity ~90%
- Top and bottom bank lines: `rgba(148,163,184,.18)` at 1.5px

### Particle system
- ~55 particles traveling left → right at varying speeds
- Particles spawn in stage zones; speed matches zone health:
  - Active zone: 0.35–0.85 units/frame (normal)
  - "Blocked" particles: 0.05–0.15 units/frame (slow, red-tinted)
  - Done zone: normal speed, glow filter applied
- ~35% of Active-zone particles are slow/red (representing blocked items sitting in the flow)
- Particles stay within the channel bounds, bounce off banks
- On right edge exit: respawn at a new random zone

### Blocked item treatment
- Blocked = property on an item in its actual stage (NOT a separate stage column)
- Blocked items in Active zone cause the channel to widen further (+25px each)
- A red translucent friction haze (radialGradient ellipse) drifts over the Active zone when blocked items present
- Slow red particles in the Active zone represent blocked work that won't move

### Item nodes on the river
- Small circles positioned within their stage zone, staggered by index
- Size: r=14 for critical priority, r=10 for normal
- **Blocked node treatment:**
  - Dark red fill (`#7f1d1d`) instead of zone accent
  - Red stroke (`#ef4444`) at 80% opacity
  - Dashed red outer ring (+7px, `stroke-dasharray="3,4"`) — item is visibly "stuck"
  - `⚠` glyph replaces normal type glyph
  - Label in `#f87171` instead of zone accent
- **Done nodes:** soft bloom halo (bloom filter, low opacity)
- **Critical nodes:** larger, white outer stroke, arrow pointing upward (dashed red line + arrowhead)
- **Label:** 2-word excerpt above node, zone accent color, 75% opacity

### Background
- Deep navy/black `#05080f`
- Few fixed star dots at low opacity
- Flow direction label: "FLOW →" in faint monospace at top

---

## Interaction Model

### Click a node
- Opens a floating panel at bottom-center (420px wide)
- Shows: type badge, area label, CRITICAL pill if applicable
- Blocked items: explains the blocker, shows "unblocks N items"
- Done items: "Demo ready — awaiting your review"
- "Open in frame →" button (links to Oracle session for that item)
- Click ✕ or click elsewhere to close

### No drag/pan/zoom
- The river is a read-only system health view; no spatial navigation needed
- The full pipeline is always visible in one viewport

---

## Zone label treatment
- 7.5px monospace uppercase, zone accent at 55% opacity
- Item count below label in slightly larger font at 30% opacity
- Positioned above the river (y=72/82), one per zone at zone center x

---

## Known Gaps & Build Decisions Needed

1. **Item positioning:** Currently hardcoded x/y per node. Production needs an algorithm: center items within their zone x-range, stagger vertically by index to avoid overlap.

2. **Zone width calculation:** Currently computed from static item array. Production must reactively compute from live plan data, triggering river shape recalculation.

3. **Bank path animation:** The river's silhouette changes when items move between stages. Production should animate the bank paths smoothly (transition the bezier control points) rather than snapping.

4. **Particle count scaling:** 55 particles is fixed. Should scale with data (more items = denser flow). Cap at ~80 for performance.

5. **Click-to-frame navigation:** "Open in frame →" in the detail panel should deep-link into the Oracle with that item pre-selected as the active session item.

6. **Feed integration:** The river should surface the same "awaiting you" interrupt feed as the Oracle, either as a sidebar or as a separate overlay button. Currently the river has no interrupt visibility.

7. **Done zone behavior:** Items in "done" are awaiting review (demos). The done zone being fixed-width is correct — demos shouldn't pile up visually, they should drain quickly. If done items accumulate, consider a visual signal (e.g., the done zone brightens).

8. **Stage labels:** "IMAGINE" doesn't match the plan's "in-planning" status name. Align stage names with the canonical status model in production.

---

## Canonical stage → status mapping

| River zone | Plan status |
|-----------|-------------|
| IMAGINE | in-planning (unapproved) |
| STAGED | tentatively-approved |
| READY | approved / ready for work |
| ACTIVE | wip (started) |
| DONE | demo-ready |

**Blocked** is not a stage — it's an overlay on any item in any stage that has an unanswered question.

---

## Prototype errors to fix in production

- Particle `spawn()` always picks a random stage — should weight toward stages with more items
- `updateParticles()` runs every frame even when the view is hidden — add visibility check
- Node positions use `Math.sin(i * 1.2)` for vertical offset which can place nodes outside the channel at narrow widths — clamp to channel bounds
- Item detail panel uses `position:absolute;bottom:20px` which overlaps zone labels at small viewport heights
- Zone widths recalculate synchronously on every render — memoize against item array hash
