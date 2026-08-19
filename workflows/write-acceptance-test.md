# Writing an Approval-Test Plan Node Well

Guidance for AUTHORING a recurring acceptance-test plan node (see `.meta/workflows/approval-test.md`
for how such a node is EXECUTED once written). Read that file first if you haven't — this one
assumes you already know the loop shape (findings become sibling nodes added to `requires`; the
node completes on a run that finds nothing new).

## Structural rules (carried over from this repo's general plan-node conventions)

- **The node must stand alone.** No references to other plan-node IDs or titles in its own prose —
  those nodes can be deleted (completed) before this one runs again. If you need to explain a
  related concept, inline it. Cross-referencing a stable FILE (like `.meta/workflows/approval-test.md`
  itself) is fine — files aren't deleted the way plan nodes are.
- **Point at `.meta/workflows/approval-test.md` for the loop mechanics; don't re-describe them.**
  The node's own text should only carry what's specific to THIS test.
- **Do not inline a "known issues" checklist.** The node's `requires` list of standalone finding
  nodes IS that data. A prose checklist duplicating it will drift out of sync (findings get fixed,
  new ones appear) and nobody will remember to update both places. If a run needs to know what's
  already been found, that's what `requires` is for.
- **Findings are SIBLING nodes, not children.** They need to survive and be independently
  claimable/fixable while the test node itself sits unclaimed waiting on them. Each finding node
  must itself be standalone (its own repro, its own decision-needed, its own acceptance criteria)
  — write it as if the test node that discovered it might not exist anymore by the time someone
  reads it.
- **Plain titles.** No prefixes like "Known diff:", no IDs, no meta-commentary in the title — just
  a plain description of what the finding is, the same way you'd title any other piece of work.

## The most important rule: don't write a walkthrough

The instinct when documenting a test is to write exact steps — "click X, change Y from A to B,
check Z equals W." Resist it. A scripted walkthrough only ever finds the specific things its
author already knew to look for; it can't find anything else, and worse, it teaches the executing
agent to confirm a checklist rather than actually look at the product. It also goes stale the
moment the UI changes shape.

## Do write an exploration guide

Instead, structure the node around three things:

1. **Places to look** — parts of the product/screens/surfaces worth visiting. Not "click the
   Foundations page," but "every granularity of cost display, including detail/breakdown panels
   that show the same underlying numbers a different way" — point at the KIND of surface, not one
   specific instance of it.
2. **User goals and flows to attempt** — things a real user of the product would try to do, described
   at the level of intent ("build a component whose formula references another component, including
   a multi-hop chain" or "try to move a component from one classification to another by whatever
   means the UI actually offers") rather than literal click sequences. Let the executing agent pick
   its own concrete model, values, and exact steps — that's what makes each run explore a different
   corner of the state space instead of retracing the same path. Focus on larger user goals, not just small concrete actions ("verify every kind of refernce, every way that components can be not visible in the estimate, and using intermdiate nodes to calculate partial values that don't appar in the report").
3. **Principles to maintain** — properties that should hold, stated generally enough to catch things
   you haven't thought of yet ("any total shown in more than one place must reconcile," "an edit
   must never leave the display stuck on a wrong value," "a category the app derives from current
   state must reflect CURRENT state, not be frozen from when it was first computed"). These are the
   invariants; violating any of them is a finding regardless of which specific goal/flow surfaced it.

Operational facts (how to reach the environment, how to log in, what's reachable given current
flag/config state) go in a separate Setup/Environment section — they're logistics, not things to
look for, and shouldn't be phrased as principles or goals.

## Validate the test's own sensitivity before trusting it

Don't just write the node and assume it works — check that it actually finds things, the same way
you'd test any other piece of work:

1. **Seed it with real findings first**, if you have any (from a code audit, a bug report, a unit
   test gap) — file them as the standalone sibling nodes the loop expects, so there's something
   concrete to validate against.
2. **Run a code-exploration pass, separately from the live/UI pass.** Some differences (frozen
   state, classification logic, rounding behavior) are easier to find by reading two implementations
   side by side than by clicking around and hoping to trigger them. Have that pass look for things
   BEYOND whatever you already know, not just re-confirm it.
3. **Run the procedure with a genuinely fresh agent** — one with no prior knowledge of the specific
   findings you're seeding against, given only the node's own text (and this file / approval-test.md
   if it needs the mechanics). Its findings are the real signal: do they include all of the ones you seeded,
   independently rediscovered? What patterns arise in the ones that it misses?
4. **When a fresh run misses something you know about, don't just add a spoiler.** Ask why it
   missed it — is there a whole PLACE TO LOOK it never visited, a GOAL it never attempted, or a
   PRINCIPLE too narrow to imply that check? Broaden the node at that level of generality instead of
   inserting the specific missed scenario. That keeps the fix generalizable — a broadened principle
   or goal tends to surface OTHER related issues too, not just the one you already knew about,
   which is the whole point.
5. **Iterate with more fresh runs** until independent agents, given nothing but the node's own text,
   consistently rediscover all of the seeded findings on their own, plus at least
   occasionally something new. A test that only ever finds exactly the seeded set and nothing more
   is probably still too narrow or too close to a spoiler; a test that reliably turns up new,
   plausible findings each run is a good sign the "places/goals/principles" framing is doing its job.
6. **When a run confirms a finding live, put the elaboration in the FINDING node, not the test
   node** — exact repro, what made it worse or different than expected, severity. The test node
   stays generic and reusable across runs; the finding node accumulates the specific evidence.

## Sanity checks before calling a node done

- Could someone with zero context on this specific effort pick up the node and run it? (No jargon,
  no unexplained abbreviations, no assumed familiarity with a specific bug.)
- Does every "principle" read as something that could be violated in a way you HAVEN'T already
  thought of? If a principle can only ever catch the one bug you had in mind when writing it, it's
  really a spoiler wearing a principle's clothing — generalize it.
- Is anything in the node's text actually a known finding in disguise (a "known limitation" callout,
  a "watch out for X" aside)? Move it to a finding node (filed in `requires`) instead, per
  `approval-test.md` — the test node itself should read the same whether zero or a dozen findings
  are currently open against it. And then generalize it to something that would re-discover that finding plus many others similar to it. The generality and sensitivity of the test is more important than the finding.
