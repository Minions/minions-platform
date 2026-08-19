# Workflow: Create an execution plan

Invoke as: **"Based on what we have discussed, follow `.meta/workflows/create-plan.md`."**
Optionally name a base node: **"... make a sub-plan under `<nodeId>`. follow `.meta/workflows/create-plan.md`."**

This turns a design that already exists in the conversation into a reviewable plan tree using the `plan` MCP tool. "What we discussed" is the source of truth for the design; this doc governs only the *shape and quality* of the plan.

Each plan node is a **movement** — one clear shift in the product, implemented over multiple commits by an implementor who has **only that node** in context (plus the dependency guarantee in §7). They will not have had this conversation, and they will not see the parent or sibling nodes.

---

## 0. Sync first

Run `movement action=start` before reading code, so you plan against current `origin/main`.

## 1. Ground the plan in reality (do NOT skip)

Before writing nodes, investigate enough to:
- Confirm the design is sound and its assumptions hold against the actual code. If something contradicts how it was described in the discussion (e.g. a commit assumed to be a dead end is actually load-bearing), **surface the contradiction and stop** — don't encode a wrong assumption.
- Identify the distinct user/AI-observable experiences the design delivers (not its architectural layers). Size and sequence nodes around those experiences — what's genuinely independent, what's a hard prerequisite (§4).

Use read-only exploration subagents for breadth; keep the conclusions, not the file dumps.

**Investigate for understanding — not to transcribe implementation into the plan.** Small, illustrative code sketches that pin down intent are good (§5); what to avoid is exhaustive transcription — copied signatures, line numbers, file-by-file edit lists. Treat already-merged work as ordinary current product code, not as special "keep this" plan items.

## 2. Choose the parent

- **Base node given:** read it with `plan action=get-subtree itemId=<id>`. New movement nodes attach under it via `parentId=<id>`. If that node lacks a design-contract-level description (§3), augment its `details` with the contract via `plan action=update-item` — append, don't clobber.
- **No base node:** create a new root with `plan action=create-root`, whose `details` ARE the design contract (§3).

(Wing name is taken from the session; don't pass it.)

## 3. Write the design contract (the parent's details)

The parent is the human-facing overview and the record of settled direction, **and it must itself read as one complete, standalone node** — same rules as any node (§5): assume its children and their `requires` are gone by the time someone reads it (they will be, per §5 rule 4 and §7). Include: the **goal**, stated as the *target experience* — what a user (human or AI) can do or observe once this is fully realized, written as if describing the finished thing, not as a diff against today; **CONFIRMED decisions** (anything the product owner already settled — mark them CONFIRMED with "implement; do not re-litigate", so implementors don't re-ask); **invariants** to preserve; a **Tech design section** (§5b — the root defines an experience too, and needs to name whichever standing design doc(s) govern it, same as any child); the **global rules** (§6); and overall **acceptance**, stated purely in terms of the target experience.

**State intention, not inventory.** Keep any "current mechanism" background minimal and clearly load-bearing only for *your* reasoning while planning — do not let the contract accumulate a long list of "already true" facts about the codebase for children to lean on. Anything a child needs to rely on as true when it runs must be copied into that child's own `context` (§5) — the parent's background section is not a substitute and is not guaranteed to still be accurate by the time any given node executes (earlier nodes' prerequisites will have changed the code by then).

**Never describe the parent's acceptance as "the children below, done."** Don't write "once nodes X/Y/Z are merged" or count/enumerate children — that's a reference to nodes that won't exist when this is read (§5 rule 4 applies to a parent referencing its children exactly as it applies between siblings). State what the *finished, target experience* looks like, full stop, regardless of how it happens to be decomposed underneath.

The parent's text is for the human and for your own reference. **It is NOT visible to an implementor working a child** — so anything a child needs from it must be copied into that child's `context` (§5). Prefer the simplest mechanism that satisfies the design; don't encode speculative complexity.

## 4. Decompose into movement-sized nodes

A node = one **movement**: a coherent, shippable shift, implemented over **as many commits as it takes** (not one commit). Size deliberately:

- **Decompose along experience lines, not technical layers.** Ask "what new thing can a user (human, or an AI acting as a user of the MCP surface) *do or observe* when this node merges?" — a completed data model, storage resolver, or internal API is not an answer to that question by itself. Group whatever combination of data model + storage + API + rendering is needed to make ONE such answer true into a single node, even if that spans what feels like several architectural layers. Splitting "backend for X" and "UI for X" into separate nodes is only correct when the backend half is *itself* a complete, callable capability — e.g. an MCP action a human or AI user can invoke directly and see a real result from, not an internal function only the next node's code will call.
- **Each node costs a fresh implementor invocation, a merge, and a round of manual verification.** Don't create tiny nodes — that overhead dominates. Merge related work, **especially sequential steps and sequential architectural layers**, into one node.
- **A requires-chain of nodes, none of which is independently verifiable on its own, is a decomposition bug, not a sequencing detail.** If you find yourself writing `A requires B requires C` where B and C only matter because A needs them — and B and C have no user/AI-observable outcome of their own — that means A, B, and C are one movement wearing three hats. Merge them. Reserve `requires` for genuinely separate *experiences* that happen to have a hard technical dependency (§7), not for stages of building one experience.
- **Don't specify implementation.** State the *shift*, the design decisions/constraints it must honor, and the acceptance criteria. Assume the implementor will design the implementation, commit repeatedly, and finish.
- **If a node has obvious sub-steps — including "first the data/API layer, then the surface that uses it" — list them as an ordered list inside the node** — do not split them into separate nodes.
- A good node is independently verifiable *by exercising the product* — a human clicking through the UI, or an AI user driving the MCP surface end-to-end — not merely by tests passing internally. It should ideally leave the product working at its merge (use feature flags / additive changes where a shift would otherwise regress visible behavior).
- **Pure-infrastructure movements with no observable outcome are the exception, not a default.** Only split one out when it is *actually* consumed by multiple genuinely-independent later experience-nodes (not "the next node in the same chain," and not "will probably also help a future feature"). When in doubt, fold the infrastructure into the first experience node that needs it; a later node can extend it if real reuse materializes.
- **A parent is a bigger experience than the sum of its children — never the union of them.** Children are smaller experiences that light up incrementally *toward* the parent's goal; they are not required to exhaustively partition it. It is normal and expected for real work to remain against the parent (or a future child of it) even after every current child has shipped — don't force-fit "everything left to do" into today's children just so the parent can be considered fully covered. If, once you've listed the children you're confident about now, real scope clearly remains, that's fine — leave it to a later pass (a fresh `create-plan.md` run against the parent once more is known) rather than inventing a catch-all child to make the tree look complete.
- **A node's title is the experience/value delivered, not the technical thing built to deliver it.** Ask "what would a user say they can now do?" — not "what did the implementor add?" `View another repo's plan tree from the UI` is a title; `Repo selector for the plan view` is not (it names a widget, not the value it provides) — the widget belongs in `details`, not the title. Same test applies to the parent's own title.

## 5. Node authoring rules

Two fields, with distinct jobs:

- **`details`** — the node's own work: the shift, ordered sub-steps if obvious, constraints, and acceptance criteria. General background for this node also goes here.
- **`context`** — ancestor/shared knowledge this node needs, **duplicated** because the parent and siblings are invisible during implementation. Copy in the specific confirmed decisions, invariants, and working rules from the contract that this node depends on. If two nodes need the same fact, write it into both.

Rules for both fields:

1. **Self-contained for empty context.** An implementor has only this node. Everything needed to do it right, and not re-litigate settled direction, must be present here.
2. **Be concrete about what matters; suggest direction without over-specifying.** Aim for a balance: concrete on the design decisions and the shapes that pin down intent, open on the mechanics. Name the things you care about and show them — don't say "add a role," say "an `isMarkup: boolean` on `Part`/`LineItem`"; don't say "a computation that reads a total," sketch `ReferTo.RollupTotal(node, role)` with a one-line `compute() => node.total`. A few-line code example or a concrete signature is the right tool when it removes ambiguity. What to avoid is dictating the full implementation — exhaustive file-by-file edits, line numbers, copied signatures — that's the implementor's to design. If a thing genuinely doesn't matter to your intent, leave it open and say so.
3. **No identity in titles.** Titles are plain descriptions of the shift — no `T1 —`, no numbering, no ordering hints. Node IDs are the identity.
4. **Never reference another node** — not by ID, not by title, not by "the previous/next task." A required node is completed *and deleted* before this one runs, so any node ID written here is a guaranteed dangling reference. Duplicate the needed fact instead, and keep nodes orthogonal.
5. **Describe the codebase as it will be when this node runs** (present tense) — the dependency guarantee (§7) ensures prerequisites are done.
6. **Use real markdown.** Write ordered/sequential steps as an actual markdown ordered list — a blank line before the first item, one `1.` / `2.` / … per line — so they render as a list, not a run-on paragraph. Same for bullet lists.

## 5b. Tech design section (every node, including the root)

**Every node has a Tech design section in its `details`** — the root/parent contract (§3) and every child alike, not just leaves. Each node describes one experience; this section says which standing design doc(s) govern that experience and where to look in them, or says plainly that none applies. Omitting the section reads as an oversight; an explicit "none" is a decision `execute-movement.md` can act on directly (see that workflow's Tech design gate).

When a node's work is governed by a design document that exists independently of this conversation (produced via a doc-iteration loop, a prior planning pass, an ADR — anything with its own lifecycle), the section indexes the doc, it does not summarize it:

- Name the doc by path and state its role in one line (e.g. "the authoritative, evolving design for this mechanism").
- Give a bullet list of **deep links into the doc**: the section heading (and, where it sharpens the pointer, a specific type/term name inside it) an implementor needs for this node, each paired with a one-clause note of *why* it matters here — not what it says.
- **Never repeat the doc's content.** If a bullet could be copy-pasted out of the doc as a definition, a rule, or a decision, delete the restatement and point at the section instead. The doc is the single source of truth; a paraphrase here is a second copy that will drift the moment the doc iterates again — and design docs iterate.

If no standing design doc governs this node yet — the shift is small and obvious, or nothing has been designed — write `## Tech design` followed by a single line: `No standing tech design doc governs this node.` Don't leave the section out; a reader (human or `execute-movement.md`) needs to be able to tell "nobody's written this yet" apart from "this node forgot to say."

**Marking the last consumer, and retiring the doc.** When you create or touch a node that depends on a tech design doc, check whether any other node anywhere in the plan still depends on that same doc (not just siblings — search the whole tree). Whichever node is the last one left needing it states so in its Tech design section (e.g. "This is the last plan node that depends on this doc.") and takes responsibility for deleting the doc once nothing else needs it — the doc did its job of getting the design implemented and reviewed; keeping it around after nothing references it just invites drift.

**A node's children are always completed (and deleted) before the node itself — so a parent is normally the last consumer, not a child.** If both a parent and one or more of its children reference the same doc, the parent is the one still standing after every child is done; mark the last-consumer note and the cleanup responsibility on the **parent**, not on whichever child happens to run last. Only mark a child as the last consumer when no ancestor of it references the doc at all — in that case the child really is the final thing depending on it. On the parent, phrase the cleanup as part of its own contract (there may be no literal "What to build" list on a pure contract node): once no child remains that still needs the doc, delete it as part of closing out that parent. If a later planning pass adds a new node anywhere in the tree that also needs an already-marked-last doc, move the marker: strip it from wherever it was (`plan action=update-item`) and add it to the new last consumer, applying this same parent-over-child preference.

Format:

```
## Tech design

Read `docs/design/<name>.md` in full before starting — it is the authoritative,
evolving design for <what>. This node only needs, and should rely only on:

- **"<Section heading>"** — <one clause: why this node needs what's there>
- **`<TypeName>`/`<term>`** (in "<Section heading>") — <one clause>
- ...
```

Worked example:

```
## Tech design

Read `docs/design/commit-check-pipeline.md` in full before starting — it is
the authoritative, evolving design for this mechanism. This node only needs,
and should rely only on:

- **"Core abstractions"** — the `Evidence`/`Detector`/`Change`/`Recognizer`
  shapes this node implements.
- **"Combining changes"** — the exact `combine` rule for `text` edits this
  node's file-edit handling must follow.
- **"Hook points and registration"** — the `HookPoint`/`HandlerRegistration`
  shape; this node wires exactly one hook point.
- **"Relationship to existing systems"** — names the existing files this
  node migrates, and what's explicitly out of scope for it.
```

Last-consumer format (added to a node's Tech design section, on top of the bullets above):

```
This is the last plan node that depends on this doc. Once this node's other
work is verified complete, delete `docs/design/<name>.md` as this node's
final build step.
```

No-design-yet format:

```
## Tech design

No standing tech design doc governs this node.
```

## 5c. Worked example (good vs. bad)

Scenario: a lair wants richer multi-repo support in its plan tool — a UI to browse another repo's plan, cross-repo dependency links, and a cheaper bulk-read action.

**Bad parent contract** (inventory-heavy, union-of-children, self-referential):
> "The `plan` tool's storage is already keyed by repo, and `repo` is already wired on every action (list-roots, get-subtree, ...). This goal covers: (1) a repo selector in the UI, (2) cross-repo requires, (3) a get-leaves action. Acceptance: all three nodes below are merged."

Wrong on all three flaws: it's a fact-dump about today's code (stale the moment a prerequisite lands), its "goal" is really a table of contents for its children, and its acceptance is literally "the children are done" — a reference to nodes that won't exist when this is read.

**Good parent contract:**
> "Goal: a person or an AI agent working across a multi-repo lair can understand and navigate plan dependencies that cross repo boundaries as fluidly as same-repo ones — see another repo's plan from wherever they're looking, follow a dependency into another repo without losing context, and read large trees cheaply. CONFIRMED: cross-repo references are `{repo, itemId}`, bare `itemId` means same-repo. Acceptance: a user can go from any plan view to any named repo's plan tree, follow a cross-repo dependency and see real data (not an opaque reference), and pull a large tree's actionable items without paying for the whole tree's content." — Note this describes the *finished* thing; it doesn't name a UI selector, doesn't enumerate today's code, and doesn't say "the N nodes below."

**Bad child title:** `Repo selector for the plan view` — names the widget.
**Good child title:** `View another repo's plan tree from the UI` — names the experience; the selector is an implementation detail that belongs in `details`.

**Why the parent still has work after its children ship:** even once "view another repo's tree," "follow a cross-repo dependency," and "cheap bulk reads" each ship as their own child movement, the *parent's* full experience — cross-repo navigation feeling as fluid as same-repo navigation everywhere in the product — may still be missing pieces nobody scoped yet (e.g. search, or the movement/diff views, or notifications). That's fine: the parent isn't "done" just because its current children are. Leave it open rather than inventing a child to force closure.

## 6. Global rules to state in the contract (repo-specific)

Read `work/local/CLAUDE.md` and `docs/design/key-principles-quick-ref.md` and reflect the live rules. Typically:
- **Each node is its own movement** — synced and merged via the `movement` MCP tool, implemented over as many small commits as it takes, each green (build/test/typecheck/lint via `pnpm check-all`; full `pnpm check-all:full` before merge), then manually verified and merged after human approval. Never raw git for commit/merge.
- Test-first.
- Server-side libs are framework-free (no Vue, no reactive store). Reactivity is a UI-only concern
  inside `apps/throne-room`: plain Vue Composition API (`ref`/`computed`), no shared store.
- Update relevant docs within the movement that changes the behavior.
- Do **not** merge a movement until a human approves.

## 7. Create nodes, then wire HARD requirements only

1. Create the movement nodes: `plan action=add-children parentId=<root|base> children=[{title, details, context}, ...]`.
   - **Titles are immutable after creation, and the only way to remove a node is `complete-item` (which deletes it and absorbs to main).** Get titles and content right the first time.
2. Capture the returned IDs and set dependencies: `plan action=update-item itemId=<child> requires=[<ids>]`.
   - Add a `requires` link **only for a hard requirement**: this node cannot be correctly implemented, compiled, or tested until the other is complete.
   - **Do not** use `requires` for ordering, priority, sequencing preference, or "nicer first." There is no prioritization.
   - **Do not** use `requires` to stitch together stages of one experience that got over-split — that's a bug in decomposition (§4), fix it by merging the nodes, not by linking them.
   - The guarantee a link gives: when this node runs, the required node has been completed (and deleted). Nothing more.
   - Favor the minimal set that preserves correctness (transitive prerequisites need not be relisted), so the maximum number of nodes can run in parallel.

## 8. Leave it for review

- Do **not** set `approved`, `ready`, or `started`. Everything stays unapproved / unqueued / unstarted; the human approves.
- Commit the plan: `plan action=commit summary=<one line>`.
- Report back: the root/base ID, the child IDs with titles, and the dependency graph (what can start immediately, what unblocks what). State plainly that nothing is queued, pending review. Do not merge the movement.
