# Execute One Movement

One movement = one merge to main.

## Parameters

You are given a **goal node** — a plan item ID you are working toward. Your task is to make one increment of progress by selecting, claiming, and making progress towards a **target node**: one unclaimed leaf within the goal subtree. Others work in parallel on sibling nodes; eventually some invocation completes the goal.

- **Goal node**: the plan item ID you were given. You do not complete it in one movement; you contribute toward it.
- **Target node**: the specific leaf node you claim and work on this movement. You may or may not complete it in one movement; you complete one theme of it, which may be enough to finish it. Always a descendant of, a prereq for, (or equal to) the goal node.

## 0. Before Starting

1. `movement action=start`
2. Call the `quality_status` MCP tool (see "General Rules" below for how it behaves and its caveats). Fix any pre-existing failures in their own movement before starting planned work. Follow the regular process, but your target node is basically "whatever `quality_status` is reporting as failing," and you can skip the plan-related parts of the process.

## 1. Mikado: Find and Claim a Target Node

Repeat until you have a claimed target node:

1. Call `plan action=claim-leaf goalId=[goal-node-id]` to get the best node for you to claim. This will return a node; this is the `target-node` for this iteration.
2. Can you define a concrete before/after state and an observable invariant for this node right now — browser-visible, or MCP-server-visible (a specific tool call + observable result/side effect) for tool/backend changes? Do the minimum investigation to answer the question. DO NOT solve the node, just decide if you could evaluate whether a solution was complete. Make this evaluation quickly to avoid races with parallel workers.
	- **Yes** — this is your target node. Proceed to phase 2: Execute.
	- **No, and the gap looks narrower than the node description implies (most of the work already exists)** — do NOT split. Splitting to shrink a node you could otherwise just finish wastes a whole decompose/merge/re-claim round trip for no reason. Investigate enough to convince yourself the remaining gap is real and small, then finish the *entire* node in this movement instead — see "Encourage bigger movements, not smaller ones" below for what "finish" requires.
	- **No, genuinely** (the node is too large or tangles independent concerns) — decompose:
		1. **First, look for requires-narrowing opportunities.** For every node B that has the current node in its requires list: does B actually depend on this entire node, or only on a specific piece of it? If only a piece: (a) extract that piece as a sub-item, (b) replace the current node in B's requires list with that sub-item, (c) B will now be free to proceed as soon as the new child is done, without waiting on the rest of this node. Prefer this style of decomposition whenever it applies — it unlocks work sooner.
		2. **If no requires-narrowing applies, decompose for parallelization.** Identify sub-items that don't depend on each other and add no requires links between them — wings can then work them simultaneously.
		3. In either case: sub-items need not fully decompose the node. Once they're done, completing the rest should be easier. Give each new child its own Tech design section (`.meta/workflows/create-plan.md` §5b) — usually the same doc reference as this node, or "No standing tech design doc governs this node" if the child is pure mechanical prerequisite work.
		4. `plan action=add-children parentId=[target-node-id] children=[...]`
		5. For each requires adjustment from step 1: `plan action=update-item itemId=[B-id] requires=[...]`
		6. `plan action=commit summary="decompose [target-node-id]"`
		7. `movement action=merge type=plan summary="decompose [target-node-id]" description="..."` — **required before claiming any new child.** `claim-leaf` will only claim leaves that are on main. This is a plan-only merge (no code changes) — safe to merge straight through without Section 3's verify/review/sign-off gate.
		8. `plan action=claim-leaf goalId=[target-node-id]` — get the best subleaf from those that you just created.
		9. Return to step 1 (the beginning of this phase).

### Encourage bigger movements, not smaller ones

A movement that lands exactly one commit is usually too small — it wastes the verify/review/sign-off round trip on too little. Aim for a movement to contain a couple of commits' worth of real progress, gated by one test: **is the change actually used by the time you stop?**

- If, at the point you'd otherwise stop, the change you just wrote is "library-internal," "not yet wired up," "no MCP action calls it yet," or any equivalent of that — the movement is **not done**. Keep going: claim (or, if it's a sibling already on the goal path, just continue into) whichever node makes your change actually get exercised through a real caller, and keep working until it is.
- If finishing the current node still leaves you in that unused state, that is a signal the plan was **over-decomposed** — the node boundary was drawn somewhere that doesn't correspond to a real, independently-shippable increment. Don't stop to re-decompose for its own sake: claim the very next node that consumes what you built (same subtree, same session) and keep going until the code is used by something real — a caller, a test that exercises it end-to-end, an MCP action, a startup path — before you move to Section 3.
- This is about real usage, not busywork: a unit test that calls your new function directly to prove it behaves correctly is good practice but does not by itself satisfy "used" — it still stands alone. "Used" means something that already exists for its own independent reason (an existing caller, an existing MCP action, an existing startup flow) now actually depends on your change.

## 2. Execute

### Tech design gate (before defining scope)

Read the target node's `details`. Per `.meta/workflows/create-plan.md` §5b, it should have a **Tech design** section. Decide which case applies before doing anything else:

- **Section says "No standing tech design doc governs this node"** — this node was deliberately scoped without one. Proceed to "Define scope first."
- **Section names doc(s)** — read every named doc section in full before scoping (not just the linked headings; the doc may have moved on since the plan node was written). If the section says this node is the last consumer, deleting the doc is one of this movement's normal build steps — not a separate movement. Proceed to "Define scope first."
- **Section is missing entirely** (an older node, or a gap in how it was planned) — do not guess at the design. Make a judgment call:
  - **Small, obvious step**: the codebase already makes the design self-evident — a clear, small extension of an existing, well-established pattern, with no real decision left open. Tell the human, in chat, the design you infer from the code and the specific changes you're about to make — concrete enough that they could object to something specific, not "I'll figure it out." If they agree it's small and correct, record what you told them and their agreement in this node's `details` (`plan action=update-item`), then proceed straight into "Define scope first" — no separate tech-design movement needed.
  - **Otherwise** — the node needs real design decisions, more than one plausible approach exists, or you're not confident calling it obvious — stop. Do not write product code this movement. Go to "Creating a missing tech design doc," below.

### Creating a missing tech design doc

1. Pick a doc path under `docs/design/` (reuse an existing doc if this node extends an already-documented design; a fresh file otherwise).
2. Run the blended iteration loop (`costumes/dev-and-check/src/briefings/pattern-iterate.md`) against that doc: `goal` = a design sufficient to implement this node's target experience, `quality: internal`, `doc: <the path>`. Follow that workflow's modes (word vomit / interview / doc review / diff review) to surface the human's initial ideas, ask the questions only they can answer, and iterate the document — the same back-and-forth an existing design doc like `commit-check-pipeline.md` already went through, if this node extends it.
3. Once the iteration loop reaches its exit condition, update this node's `details` to add the Tech design section (`.meta/workflows/create-plan.md` §5b format) pointing at the doc you just wrote or extended.
4. `plan action=commit summary="add tech design for [experience], no code yet"`.
5. `movement action=merge type=docs summary=... description=...` — this movement contains only the design doc and the plan update, no product code.
6. **STOP.** Do not proceed to implementation in this session. The human re-invokes you with a fresh context to actually execute the node, now that it has a tech design.

### Define scope first

Before writing any code:

1. State which theme of the target node this movement covers.
2. **Before state**: what the app (or tool) does right now.
3. **After state**: what additionally works after this merges.
4. **Browser + MCP invariant**: exactly what to navigate to (or call), what to do, and what to observe. This repo has two first-class observable surfaces — use whichever fit (often both, for a change that flows end-to-end):
	- **Browser-visible (throne-room and any other UI)**: exactly what to navigate to in the UI, what to do, and what to observe.
	- **MCP server invariant**: for changes to an MCP tool/action (e.g. `movement`, `plan`), exactly which action(s) to call, with what params, and what result/side effect to observe (a specific return shape, a git ref advancing, a file appearing at a specific path, an error message changing) — same rigor as a browser invariant, just driven through the MCP tool call surface instead of a page.
5. **Prod impact**: does this movement have any chance of altering code that prod executes? When in doubt, yes.

If you can't write a concrete browser + MCP invariant, the scope is wrong — split it or expand it until you can.

### Discovering prerequisite work mid-node (Mikado)

While scoping — or partway through executing — you will often discover that this node can't be finished yet: some preliminary work has to land first. (Typical shape: the change you want to make is blocked because something still depends on the old path, so that dependency must move to the new path before you can proceed.) This is the expected Mikado outcome, not a failure. When it happens:

1. **Immediately create child nodes for the prerequisite work.** One child per independent piece; add no `requires` links between siblings that don't depend on each other, so wings can work them in parallel. Give each child its own Tech design section (`.meta/workflows/create-plan.md` §5b) — usually the same doc reference as this node, or "No standing tech design doc governs this node" if it's pure mechanical prerequisite work. `plan action=add-children parentId=[this-node] children=[...]`. Record the discovery on this node (`plan action=update-item itemId=[this-node] description=...`): what you found, why it blocks, and what remains here once the children land.
2. **Do whatever part of this node is genuinely safe right now — if any.** Sometimes a slice is already unblocked (e.g. code that is dead regardless of the children) and you can land it in its own commit. Often nothing is safely doable yet — that is fine; don't force it. Be especially wary of changes the test suite still pins to the old path; those belong with the prerequisite work, not now.
3. **Then go straight to verify/approve/merge/stop.** Do not try to push the blocked part through in this session. Merging the decomposition (plus any safe slice) now lets the next invocation start fresh on the first child with a clean context. This node gets completed later, by a re-invocation, once its children have landed.

### Rules (apply to every commit)

- **Test-first.** Write failing tests, then the code that passes them.
- **One logical change per commit.** One rename, one capability added. Note: the commit tool will always commit all changes in the repo. So do one logical shift, get it working, and then commit everything.
- **Type-check green at every commit.** For cascading type changes: widen to `A | B` and commit, migrate one site (and whatever is required to make it type-check correctly) per commit, narrow back and commit.
- **No partial wiring.** Don't leave unreachable code paths or half-connected bridges. Temporary bridges get `// @deprecated — removed in [node-id]`.
- **Note surprises before acting.** If the code differs materially from the node description, write down what you found and what you'll do.
- **Avoid comments wherever possible.** Only write one when there's something about the function that every caller needs to know and that isn't obvious from reading its code (a hidden constraint, a non-obvious invariant, a workaround for a specific bug). Never comment what the code already says.
- **Prefer a class over an object literal with computed (getter) properties.** An object literal is for fixed data; once a property needs to be computed at read time, that's a class with a getter method, not a `{ get foo() {...} }` literal.

### Commit loop

1. Write failing tests for the next logical change. Optionally confirm they're actually red via `quality_status` before moving on (see "General Rules") — same purpose as reading the test runner's own failure output, just through the watcher.
2. Write the code that passes them.
3. Call the `quality_status` MCP tool (see "General Rules" below for how it behaves and its caveats — in particular, give it a couple of seconds after your edit before checking). Fix all failures before continuing.
4. `movement action=commit` — not raw git. If this fails, STOP and get the human.
5. Should this movement end? End if either:
	- The next work chunk does not use the info in the current context (so it would be better from a clean context).
	- The just-completed chunk unlocks parallel work — merging now unblocks other wings sooner.

	 If either condition holds, proceed to step 3. Otherwise, return to step 1 of this loop.

## 3. Verify, Review, and Clean Up

**Note:** steps 1–5 below describe the general shape of manual verification (launch it, exercise the golden path, escalate toward prod fidelity if relevant). The concrete commands/URLs/auth flow are project-specific — fill them in from that project's own dev-environment docs (in this repo, see `work/local/CLAUDE.md`'s "Running the Dev Environment" section) rather than assuming another project's setup (e.g. Supabase local data, `demo_flags`/`prod_flags`, a `staging.eolus.ai` deploy, or a `playwright:login` script) exists here. If this repo has no preview/staging tier or scripted login yet, skip the steps that don't apply and say so — don't invent one.

1. For UI-surfaced changes, launch the app(s) this movement touches using the project's actual dev command (this repo: `pnpm dev` from `work/local`, which starts the cabinet backend on port 3000 and the throne-room frontend on port 5173 together — see `work/local/CLAUDE.md`). Open the relevant UI in the Playwright MCP browser. If it requires auth and no scripted local-login exists, say so in chat and ask the human how to proceed rather than assuming a flow that isn't there. For MCP-tool-surfaced changes (e.g. `movement`/`plan` actions with no direct UI), skip the browser and drive the actual MCP tool calls instead (step 2's MCP-invariant bullet) — no server "launch" is needed since the cabinet's MCP endpoints are the thing under test.
2. Verify all that apply:
	- **Core golden-path flows render** (UI changes): open the relevant view(s) for this repo/product and confirm they load without errors (define the specific flow per-movement — e.g. for a plan-tree UI change: the plan tree loads and renders the affected nodes).
	- **Reactivity** (UI changes): change an input relevant to this movement, confirm the UI updates promptly and correctly.
	- **MCP invariants** (tool/backend changes): actually call the affected action(s) (e.g. `movement action=merge`, `plan action=claim-node`) with representative params and confirm the observable result/side effect matches the invariant defined in Section 2 step 4 — a return value, a git ref, a file on disk, an error message. Don't just typecheck/unit-test the handler in isolation if the invariant is about real end-to-end tool behavior; call the tool for real, the same way a browser check drives the real UI.
	- **Movement changes and invariants**: confirm the specific behaviors defined in step 2 of Section 2 ("Define scope first").
3. If a preview tier exists and this change impacts something visible there, repeat the checks against it. Note what auth/session model it uses (or that none exists yet) rather than assuming another project's OTP/session-caching behavior.
4. For any error: fix it in its own commit, then return to step 2.
5. If prod-impacting and a prod-fidelity local server exists, repeat the checks against it. If this repo has no such tier yet, note that explicitly instead of skipping silently. Only push to real staging when validating deploy infrastructure itself (routing/redirects/edge functions/CDN headers) — never for ordinary feature or reactivity checks — and only if a staging environment actually exists for this project.
6. Identify and summarize all changes. Categorize each change into one of 3 categories: intentional UI change, computation / data / value change, or design change. Keep this summary in mind for now — every category needs sign-off, not just UI ones.
7. **Prepare to showcase any user-visible or tool-visible change to the human.** If this movement introduced or changed anything visible in the UI (not just "intentional new" UI — any screen a human would look at to judge the change, including a bugfix that only changes existing behavior) **or** anything observable through an MCP tool call:
	- For each distinct UI (that needs to be seen in a different place or with different data), leave a Playwright MCP browser **open** and navigated to the exact spot where the change is visible, in the state that shows it off (whatever it takes to make the change on-screen without further clicks).
	- For an MCP-tool-only change with no UI surface, "showcase" means the summary (step 8) includes the exact tool call(s) + params you ran and the exact observed result/side effect — the equivalent of a screenshot, in tool-call form. You don't need to leave anything "open," but do capture the before/after evidence (e.g. relevant file contents, git log, or tool response) in the summary, not just "tests passed."
	- Pick whichever server tier best demonstrates a UI change (dev-local, preview, prod-fidelity — whichever exist for this project). Keep that server running.
	- Do **not** close this browser (or kill its server) during cleanup — that is the whole point. Note in the summary exactly which URL/port the browser is pointed at and what to look at.
	- If the change has no UI-visible **and** no MCP-observable surface at all (e.g. pure internal refactor with no externally-callable behavior change, or a code fix that was already merged and this movement only verifies/documents it), say so explicitly in the summary instead of leaving a browser open — don't fake a demo that isn't there.
8. **Always output the full set of changes for the human, no matter how small.** This step is mandatory for every movement — a one-line bugfix gets the same sign-off gate as a feature. Write out, in the chat (not just in a commit message):
	- Every commit on the branch and what each one changed.
	- For UI-visible changes: the exact navigation steps to see it (matching the browser you left open in step 7).
	- For MCP-tool-visible changes: the exact tool call(s)/params you ran to verify it and the exact result/evidence observed.
	- For non-UI, non-tool changes (computation/data/value, design/architecture choices, refactors): what changed, why, and what you decided along the way that a human might want to weigh in on or veto.
	- Which verification tiers you checked (dev always; preview/prod-fidelity only where those tiers exist and are relevant) and what you observed on each.
	- Any decisions you made that differed from the node's plan, or any judgment calls (e.g. "this looked already-fixed, so I only verified rather than re-implementing") that the human should confirm.
9. After the summary is written, nudge the human: `.meta/workflows/say.ps1 "<wing-name> is ready for review"` (attention-only — the review details live in the summary, not the `say`).
10. **Wait for explicit approval or rejection. Do not proceed to step 11 (let alone Section 4's merge) until the human has explicitly approved.** This applies unconditionally — there is no bugfix small enough, no finding "already fixed on main" obvious enough, to skip this gate. If the human asks for changes, perform them and restart this verify, review, and clean up section once done. If the human rejects the approach entirely, stop and get direction before doing anything further.
11. Review remaining nodes in the subtree. Update any that your work changes — forward-looking only, no history. DO NOT mention the node ID that you just finished; marking it complete will delete it. So inline any critical information, especially anything that changes the plan.
12. If this movement was enough to complete a node, then `plan action=complete-item itemId=...` for the finished node. If not, then `plan action=update-item itemId=[node-id] description=[...]`. Record what is done and what remains within this node.
13. If you flipped any local config/flag to point dev at a shared or production data source for verification, change it back now. You MUST NOT commit a change that leaves dev connected to a shared/production resource. (Prefer a dedicated preview tier when one exists — it hits real data without touching dev's own config, so this step is usually a no-op. This repo has no such flag today.)
14. `plan action=commit summary="complete [node-id], update subtree"`

## 4. Merge

**Gate: do not run this section until step 3.10's explicit human approval has been received in this session.** Approval from a prior movement, or an assumption that "this is too small to need sign-off," does not satisfy the gate — get it again, every time.

1. `movement action=merge`
2. **STOP.** Do not start the next movement in the same session. The human will re-invoke you with a fresh context.

## General Rules

- **`say.ps1` calls attention only — it never carries information.** Assume that whenever you `say` something, the human is focused on another task; a `say` message's sole job is to tell them that something here is waiting for them to read. Always write the actual information (what to do, which port, what to review, what went wrong) in the summary/chat *first*, then fire a short, generic nudge — e.g. `.meta/workflows/say.ps1 "workshop-03 needs you"`. Keep every `say` under a handful of words: identify the wing and that you need them, nothing more. Use it whenever you need timely attention — things went wrong, you need auth, or you need a time-sensitive response — and then wait for them to come read.
- **When tooling breaks, fix the tooling — now, not as a follow-up.** If a script or dev tool fails (e.g. `dev:full` migration handling, a verification helper), stop and fix the tool itself rather than improvising a one-off workaround to keep going on your prior task. A workaround just leaves the breakage for the next session.
- When something is unclear, ask the human instead of guessing. State the question, then state the possibilities that you see. Pick one as your recommendation. Then supply reasons in favor of each option (including those you didn't choose), and the reasons for your recommendation. Then ask what I want to select.
- **Prefer the `quality_status` MCP tool over `pnpm check-all:full`.** `quality_status` reads a continuously-running background watcher (`tests`/`types`/`lint`/`oxlint`/`customLint` — see `docs/design/custom-lint-gate.md` for the last one) instead of spawning a fresh full-workspace check, so once it's settled a call is near-instant instead of taking minutes. No args needed — it's wing-scoped via the session. Two things to know before relying on it:
  - **Debounce lag.** The watcher waits ~1s of quiet after a file change before it even starts re-checking. A call made *immediately* after saving an edit can return a stale pre-edit result. Give it a couple of seconds after finishing an edit before checking, and if any signal still shows `running`, that's normal — call again a few seconds later rather than treating it as a hang.
  - It's also fast enough to use as a **confirmation step**, not just a final gate — e.g. after writing a failing test, call it to confirm the test is actually red before writing the fix, the same way you'd read a test's own failure output.
  - Reach for `pnpm check-all:full` only when `quality_status` itself seems unavailable or unreliable (tool not registered yet, or its reported state doesn't match what you observe by hand) — treat that as a tooling problem to flag and fix (see the rule above), not something to silently route around.
