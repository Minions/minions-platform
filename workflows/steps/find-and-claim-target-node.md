# Find and Claim a Target Node

Repeat until you have a claimed target node:

1. `plan action=claim-leaf goalId=[goal-node-id]` — returns the best available leaf, already claimed for you. If you already hold a claim under this goal, it returns that same node again, so this call is always safe to repeat.
2. Can you define a concrete before/after state and a browser invariant for this node right now? Do the minimum investigation to answer the question. DO NOT solve the node, just decide if you could evaluate whether a solution was complete. Make this evaluation quickly to avoid races with parallel workers.
	- **Yes** — this is your target node. If this is the true start of your movement, `movement action=start` — begin your actual movement branch. If you're continuing an already-open movement (e.g. claiming a second or later target node in the same unattended movement, with no merge since your last checkpoint), skip this — your branch is already where you left it. Either way, proceed to phase 2: Execute.
	- **No** — decompose:
        1. **First, look for requires-narrowing opportunities.** For every node B that has the current node in its requires list: does B actually depend on this entire node, or only on a specific piece of it? If only a piece: (a) extract that piece as a sub-item, (b) replace the current node in B's requires list with that sub-item, (c) B will now be free to proceed as soon as the new child is done, without waiting on the rest of this node. Prefer this style of decomposition whenever it applies — it unlocks work sooner.
        2. **If no requires-narrowing applies, decompose for parallelization.** Identify sub-items that don't depend on each other and add no requires links between them — wings can then work them simultaneously.
        3. In either case: sub-items need not fully decompose the node. Once they're done, completing the rest should be easier.
        4. `plan action=add-children parentId=[node-id] children=[...]`
        5. For each requires adjustment from step 1: `plan action=update-item itemId=[B-id] requires=[...]`
        6. Return to step 1 (the beginning of this phase).
