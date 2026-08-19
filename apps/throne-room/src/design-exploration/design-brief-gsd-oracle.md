# Design Brief: GSD Oracle — Attention & Operational View

**View role:** Operational / attention-optimized / GSD (Get Stuff Done)  
**Prototype file:** `GsdOracle.vue`  
**Fidelity:** Medium. Spatial map works; session flow is complete; frame curation logic is hardcoded.

---

## Intent

This is the overlord's primary working view. The job is to protect attention — make it easy to do the right work at the right time without administrative overhead.

**The core insight:** the overlord has different kinds of work (responding to minion requests, creating new things, focusing on one feature, clearing a queue) and different moods. The UI should match the work to the moment, not force everything into the same interaction pattern.

**Jarvis** is the butler figure. He curates frames — bundles of related work — and explains *why* these items belong together and what working them together achieves. He holds back items that don't belong in the current frame. He speaks in plain language.

---

## Two-Mode Architecture

### Mode 1: Frame Map (overview)
Full-viewport SVG showing Jarvis at center, frames arranged radially. This is the "look up" moment — choosing what to focus on next.

### Mode 2: Frame Session (focus)
Narrow single-item work view. Everything else hidden. Jarvis sidebar. "↑ All frames" to return.

The transition between modes is intentional — zooming in and out of focus.

---

## Frame Map Visual System

### Jarvis center
- Gold glowing orb (`#d4a017`) with slow breathing pulse (scale animation)
- Letter "J" in Georgia serif
- Spoke lines radiate outward to each frame, with traveling dots

### Frame nodes
- **Position:** Radial from center. Distance = urgency (closer = more important, more reachable)
- **Angle zones:** Space is divided loosely by frame type — URGENT (right), BUILD (bottom), IMAGINE (left), TIME (top). Very faint colored sector wedges, barely visible (~4% opacity).
- **Shape encodes frame type:**
  - `interrupt-sprint` → Diamond (sharp, urgent, angular)
  - `area-focus` → Hexagon (structural, tessellating)
  - `feature-deep-dive` → Pentagon/shield (pointed, focused)
  - `imagine-session` → Circle/blob (soft, open, no corners)
  - `timeline-focus` → Arrow/chevron (directional, temporal)
- **Fill:** Frame color at 18–28% opacity, stroke at 75% opacity
- **Glow:** Bloom halo behind each node, intensifies on hover
- **Label:** Frame title fragment below node; type glyph inside; time estimate in monospace

### Spoke travelers
- Small dots (r=2.5) traveling outward from Jarvis along each spoke
- Speed: ~0.14 units/sec, staggered offsets per frame
- Intensify (opacity 0.9 vs 0.35) when frame is hovered

### Distance rings
- Faint dashed concentric circles at r=160, 230, 300 — visual reference for "how close"
- Very subtle: 1.2–2.5% opacity

### Hover tooltip (foreignObject)
- Appears near hovered frame node, positioned by quadrant (never off-screen)
- Shows: frame type badge, title, rationale excerpt in italic Georgia, item badges, "↵ click to enter"
- Background: `rgba(6,4,2,.94)` with blur

### Recommended frame
- The frame Jarvis most recommends sits at shortest distance (most reachable)
- "RECOMMENDED" label appears above it in gold

---

## Frame Types

| Type | Label | Shape | Color | Purpose |
|------|-------|-------|-------|---------|
| `interrupt-sprint` | INTERRUPT SPRINT | Diamond | Red `#ef4444` | Clear a batch of team requests together |
| `area-focus` | AREA FOCUS | Hexagon | Amber `#f59e0b` | Everything touching one part of the product |
| `feature-deep-dive` | FEATURE DEEP-DIVE | Shield | Blue `#3b82f6` | One feature, all types (decisions + demos + planning) |
| `imagine-session` | IMAGINE SESSION | Blob/circle | Green `#22c55e` | Related creative work, no operational obligations |
| `timeline-focus` | TIMELINE FOCUS | Arrow | Purple `#a855f7` | How something develops across time phases |

---

## Frame Session (Focus Mode)

### Header
- Minimal: Jarvis initial "J" + frame type pill + item counter
- Single "↑ All frames" button — the only escape

### Progress sidebar (left, 220px)
- Item list for the frame, with role labels (START HERE / Then / Context)
- Opacity varies by role (anchor=1, chain=0.9, context=0.65)
- Jarvis's rationale excerpt (120 chars) in italic Georgia at bottom

### Work area (main)
- Item type badge + area label + CRITICAL pill (if applicable)
- Blocked banner: red panel with blocker reason + "unblocks N items" 
- Large h1 title
- Context/body text in Georgia serif, left-bordered blockquote style
- **Decision:** option cards (click to select, button activates on selection)
- **Create/Question:** large textarea with Georgia font, gold caret
- Action buttons: primary action (labeled by type), Skip, Back, time estimate

### Item type verbs
- decision → "Decide & next"
- demo → "Review & next"  
- create → "Log & next"
- question → "Answer & next"

---

## Blocked Item Treatment

Blocked is a **property**, not a stage. A blocked item sits in its actual stage (active, staged, etc.) with:
- Red warning banner at top of work area: "Blocked — [reason]"
- ⚠ badge in the sidebar item list
- The item is still in the frame because the decision that unblocks it is often *in the same frame*

---

## Jarvis Voice Guidelines

Jarvis speaks in the first person in short italic sentences. He explains the *why* of each grouping:
- "I grouped these because…"
- "Working them together means…"
- "This one is the load-bearing call right now."
- "I've muted the operational queue. You have clear space."

In production, Jarvis notes should be generated from the plan graph (upstream/downstream relationships, idle engineer counts, etc.). In the prototype they are hardcoded.

---

## Known Gaps & Build Decisions Needed

1. **Frame curation logic:** Currently hardcoded. In production, Jarvis needs to analyze the plan graph — find connected subgraphs, identify the critical path, cluster by area, detect when a decision unblocks N items. This is the most complex piece to productionize.

2. **Dynamic frame composition:** Frames should update when plan state changes (items completed, new items added). The frame map needs to re-layout.

3. **Frame map layout engine:** Frame positions are hardcoded. In production, should compute positions based on urgency ranking, frame type, and number of items. The radial + sector logic should be algorithmic.

4. **Session item sequence:** Currently a simple ordered array. Jarvis should sequence items optimally within a frame (critical path first, then dependencies, then context).

5. **Jarvis voice:** The briefing text is hand-written. In production, this should be generated from structured plan data using an LLM call. The data shape (rationale, saving, items with roles) is already designed.

6. **Action stubs:** DECIDE/REVIEW/LOG/ANSWER buttons are stubs. Wire to plan API (marking items complete, answering questions, triggering demos).

7. **Mood integration:** The prototype had a mood dial concept that was removed in favor of frames. Consider whether mood (IMAGINE / UNBLOCK / SHIP / BREATHE) should be a secondary layer on top of the frame map, or a filter on frame recommendations.

---

## Prototype errors to fix in production

- `foreignObject` tooltips may clip on small viewports (needs bounds check)
- Sector label positions are hardcoded (URGENT/BUILD/IMAGINE/TIME text at fixed SVG coords)
- Spoke dot animation uses `requestAnimationFrame` continuously even when hidden — pause when not visible
- Session sidebar uses inline style mutation for hover states — convert to reactive state
