# Approval-Test Gate (Recurring Acceptance Test)

This file is only ever read from inside `execute-movement.md`'s Phase 2 (Execute) — after that workflow's Mikado phase has already picked THIS node as the claimed target. In general, work exactly as the other workflow specifies. This file only covers what's DIFFERENT about executing a node whose job is "run a recurring test," instead of "write code."

A node pointing here is a **recurring acceptance test**: a procedure (Playwright/manual-driving procedure, code audit, whatever fits the node) that gets re-run periodically, whose "done" state is "the last run found nothing to fix," not "the work is finished once." The node's own `details` carries everything specific to ITS test (what to run, what principles/invariants to check, its own inlined "known issues" checklist) — that's the part `execute-movement.md`'s standalone-node convention already requires. This file is just the decision logic for what to do with the result.

## Unsupported test scenarios

**Hard navigation (full page reload, typed/pasted URL, closing and reopening the tab) is NOT a
supported use case.** It always tears down the entire JS session state — every in-memory object and
Vue reactivity graph is destroyed and rebuilt from scratch; nothing survives across it by design. A test procedure that drives a hard navigation and then asserts on anything other than
"the browser's own native beforeunload prompt appeared" is testing something this app makes no
promise about. Any finding produced by a hard-navigation test step is invalid — do not file it as a
sibling node. Only in-app navigation (router-link clicks, programmatic router pushes, in-app buttons)
is in scope for guard/dirty-state/persistence checks.

## What to actually do, now that you're executing this node

1. **Run the test procedure exactly as the node's `details` describe it.** Don't skip steps, don't stop at the first thing you notice — go through the whole thing.
2. **Zero findings** (every principle/check in the node held, nothing to report): that's this movement's logical step. Call `plan complete-item` on this node. There is likely no source-code diff to commit — that's fine, the plan-state change is the change. Carry on into `execute-movement.md`'s normal verify/merge steps from here.
3. **Any findings at all** (even one): do not fix them now, and do not complete this node. This is the same shape as `execute-movement.md`'s "Discovering prerequisite work mid-node (Mikado)" section. Treat it that way, with one difference: instead of adding CHILDREN to this node, add standalone, pre-req SIBLING nodes (same parent as this node) via `plan add-children` on the parent, since this test node isn't being decomposed away — it needs to survive, unclaimed, so it can be picked up and re-run later once the findings clear. Concretely:
   a. File EACH finding as its own new sibling plan node. Write it standalone per this repo's convention — no references to other plan nodes; inline whatever a future reader/fixer needs
   (exact repro steps, expected vs. observed, decision needed, acceptance criteria).
   b. Set this node's `requires` to the current list plus every new sibling's ID (read the existing list first — `update-item`'s `requires` replaces the whole list, it doesn't merge).
   c. Ensure this node's own `details` DOES NOT include a "known issues" checklist. That would duplicate the better data in the plan structure and just create possible problems.
   d. `unclaim-node` this node. Do not leave it claimed and blocked — that misrepresents it as active work, when really it's now waiting on the findings you just filed.
   e. Commit the plan changes (this is the "safe slice" for this movement — there may be nothing else to commit). Then go straight into `execute-movement.md`'s verify/merge steps, same as that Mikado section says: don't try to push further work on this node's original goal in this same session.
4. Expect step 3 to happen many times before step 2 ever does — that's the normal shape of this gate, not a problem to solve. Each pass narrows the findings list; the test only ever completes on a run with nothing left to find.
