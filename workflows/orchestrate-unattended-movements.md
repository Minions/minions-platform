# Orchestrate Unattended Movements

Goal: given a plan goal-node ID (and, if given, an iteration/movement budget), drive a sequence of
builder sub-agents — normally **one builder per plan node** — through
`.meta/workflows/steps/execute-unattended-movement.md`, checkpointing each builder's work with an
independent critic, and deciding **yourself** when enough related work has accumulated to merge —
until the goal node's subtree is empty or the budget is exhausted.

Read `.meta/workflows/documentation/mikado-lifecycle.md` first if you haven't — it explains why "subtree is
empty" is the right completion signal (deletion cascades) and why the goal node itself may end up
as one of the leaves a builder claims.

## The core shift: you own movement boundaries; a builder owns one node

Two related but separate defaults:

- **A movement is not "one plan node."** You decide when a movement merges. Default to long
  movements: bundle all the generally-related work you can into one movement — spanning multiple
  plan nodes — before you call merge. A movement that merges after one node is the failure mode
  this document exists to prevent.
- **A builder is normally one plan node.** Keep a builder alive for the entire node it claimed —
  across as many checkpoints as that node takes — and only start a fresh builder when it moves to
  the *next* node. This keeps each builder's context focused on one problem instead of
  accumulating unrelated history across nodes. The movement itself does **not** end when the
  builder does; the next builder picks up in the same still-open movement.

Concretely: **only you call `movement action=merge`, directly, via the `mcp__cabinet__movement`
tool.** Never ask a builder to merge. A builder never merges, is never told it's approved to merge,
and never has to make that call itself — it only commits, checkpoints, and waits. This also removes
the risk of a builder merging before you've actually reviewed it.

## Per-invocation loop

1. Launch one builder sub-agent and give it the goal node — or resume your existing one if it's still
   working the same node (see "Within one node: checkpoints" below). For a fresh launch, prompt it
   verbatim, nothing else: "Follow `.meta/workflows/steps/execute-unattended-movement.md` to make progress on
   `<goal-node-id>`." If this is not the first builder of an open movement, add: "This
   movement is already open and your branch already has committed work on it; do not run
   `movement action=start` — go straight to claiming your target node." Notes:
   * The builder will choose its own leaf to claim; you don't need to choose for it.
   * Only run one builder at a time in the wing, as every commit will pick up all changes, so multiple builders will always collide.
2. Wait for a **checkpoint report**. The builder pauses and reports whenever it believes it has
   accomplished something checkpoint-worthy: fully connected and wired up, with a visible change,
   implementing the target design, and verified working — see
   `.meta/workflows/steps/execute-unattended-movement.md` for the exact bar. This may or may not
   complete the whole node; a node can take several checkpoints.
3. Run the Checkpoint Review sub-loop below on every such report.
4. Once a checkpoint is approved, decide what happens next:
   - **If the node isn't done yet**: normally, tell the same builder to keep going (more
     checkpoints on the same node). Only start a fresh builder mid-node if you or the builder
     judge that a clean context would genuinely work better than continuity at this exact point
     (see "When to reset mid-node" below) — this is the exception, not the default.
   - **If the node is done**: that builder's job is finished. Decide whether to merge now (see
     "Closing a movement") or extend the movement into the next node with a **new** builder (see
     "Moving to the next node").
5. If the builder reports blocked, errored, or an infra failure instead of a checkpoint: diagnose
   and respond directly to that same builder. Do not launch a second agent on the same node.
6. If the builder reports it has nothing left to claim (or nothing appropriately related): close
   the movement if it isn't already closed, then go to step 7.
7. `plan action=get-leaves itemId=<goal-node-id>`. If the subtree still has work and budget
   remains, go to step 1. Otherwise stop and report a final summary.

## Checkpoint Review sub-loop (every time a builder reports a goal accomplished)

1. Get the commit range since the *last checkpoint* — not since movement start. Each checkpoint
   review only needs to cover what's new since the last one you already had reviewed and approved.
2. Spawn one independent reviewer sub-agent. Give it
   `.meta/workflows/steps/review-movement-checkpoint.md`, the commit range, and enough context about
   what changed and why for it to judge it (same as you'd give any fresh reader). It must not read
   the plan system. Its job is to critique the *code*, not the process the builder used to produce
   it — don't ask it to police commit cadence or workflow adherence.
3. If it finds real issues: relay them to the builder, ask it to address them in place, and wait
   for the next checkpoint report. This round does not count as approval; return to step 1.
4. If it finds nothing significant: the checkpoint is approved. Return to step 4 of the
   per-invocation loop above.
5. Stop the reviewer sub-agent once its verdict is delivered.

## Within one node: checkpoints

A single node's builder will typically report several checkpoints before the node is fully done —
each one is a burst of the small-step commit cycle (see the builder's own workflow), not a single
commit. Between an approved checkpoint and the next one, keep the same builder session going: tell
it to continue straight into its next chunk of the same node. No merge, no fresh agent, no
`movement action=start` — the branch and the builder's own understanding of the node are both
exactly where they were left.

### When to reset mid-node (the exception, not the default)

Occasionally, either you or the builder itself will judge that continuing with accumulated context
is worse than a clean start, even though the node isn't done — e.g. the builder's context has
grown noisy from a long exploratory detour, or a just-landed checkpoint happens to leave the node
in a clean, well-isolated state that a fresh reader could pick up faster than explaining the
detour's history. When that happens: let the current builder finish its checkpoint report and
plan-node bookkeeping, then start a **new** builder for the *same* node (not a new movement) — tell
it plainly that this node is partially done, point it at the node's own `details` (which the prior
builder should have updated with what's done and what remains), and let it read the actual code
rather than trying to reconstruct the missing history. This is deliberately rare — most nodes
should see exactly one builder from claim to completion.

## Moving to the next node (new builder, same movement)

When a node is fully done and you're extending the movement rather than closing it: start a
**fresh** builder for the next node, in the same still-open movement (per the note in step 1 of the
per-invocation loop — no `movement action=start`, the branch carries forward). This is the normal
way a movement grows: node → new builder → node → new builder → … until you decide to close.

## Closing a movement (you decide, then you merge — no builder is ever involved in this)

Merge when, in your judgment, no more directly-related work remains for this movement to
reasonably pick up next — not reflexively after every finished node. This is a judgment call; lean
toward longer movements. Signals that favor closing now:

- The next available leaf is a different code area or theme than what this movement has been
  doing.
- Nothing else under the goal is currently claimable (blocked on `requires`, needs human input, or
  claimed by another wing).

Signals that do **not** justify closing on their own: "this node is done," "it's been a few nodes
already," "the change is small." Completeness of an individual node is not a reason to stop
bundling — only a genuine change of theme, or a real practical limit, is.

When you decide to close:

1. Get the full commit range for the whole movement (since the branch's actual base, not just the
   last checkpoint) — e.g. `git log origin/main..HEAD --oneline`.
2. You already have per-checkpoint reviewer approvals covering every commit in that range — you do
   not need one more holistic pass unless the accumulated scope is now large enough that a "does
   this all still hang together" sanity check is warranted. Your judgment.
3. Call `movement action=merge` yourself, directly, via `mcp__cabinet__movement`. Do not ask any
   builder to do it, and do not wait for one to volunteer.
4. Independently verify: `git fetch origin main` + `git log origin/main` shows the merged commits.
   Never trust a bare "merge succeeded" return value.
5. Decide whether the next node's builder continues in a new movement right away (`movement
   action=start` first to resync since the branch moved, then claim the next target node) or
   whether to pause and report. Your call, same relatedness heuristics as above.

## Standing rules

- Stop each sub-agent's background task once it's done with; don't let finished ones accumulate.
- Always independently verify your own merges against `origin/main` after calling merge yourself —
  don't just trust the tool call's return value.
- If an MCP server or other infra is unreachable: back off with increasing delays between
  retries; do not poll tightly. Resume once it's back.
- `oxlint` failures block commit and merge like any other quality_status signal — do not treat
  them as advisory-only, and do not tell reviewers to ignore them.
- If a builder reports a node's work done but didn't mark the plan node complete, tell it to do so
  before it stops, or do it yourself (`plan action=delete-subtree`) if that builder session is no
  longer available.
- Never approve a checkpoint without an independent reviewer pass, regardless of how small the
  change looks.
- Never merge without the per-checkpoint reviewer approvals already covering every commit in the
  range you're about to merge.
- Prefer sending a found issue back to the same builder to fix within its current checkpoint over
  starting a separate investigation.
