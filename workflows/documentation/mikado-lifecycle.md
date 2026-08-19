# How the Plan Tree Executes (Mikado Lifecycle)

This describes the mechanics every
other planning/execution workflow doc assumes but doesn't re-explain: what a leaf is, what
"complete" means, and why a node outlives its own children.

## The core loop

Many wings work in parallel, each an independent session running `execute-movement.md` or
`execute-unattended-movement.md`. Each invocation claims exactly one **leaf** — a node with no
remaining children and no unresolved `requires` — works it, then **deletes it**. Deletion IS
completion. There is no separate "mark complete" action; `plan action=delete-subtree` is the only
way a node is ever finished.

## Deletion cascades

Deleting a node can turn other nodes into leaves:

- Its **parent**, if this was the parent's last remaining child.
- Any node that had **`requires`** pointing at the now-deleted node, if this was the last
  unresolved requirement on that node.

The whole tree is consumed this way, one leaf at a time (many leaves in parallel across wings),
until nothing is left. There is no central scheduler beyond "whatever is currently a leaf is
claimable."

## A parent is not just documentation — it executes too

Once every child of a node is gone, **the node itself becomes a leaf** and gets claimed and
executed like any other. What "executed" means is whatever that node's own `details` (and Tech
design section) say to do:

- For an ordinary functionality node, this often means
  attempting the full goal itself: children made progress, but couldn't foresee everything, so the
  parent finishes up ("a parent is a bigger experience than the sum of its
  children").
- A node can be too big to finish in one session the moment it becomes a leaf. When that happens,
  the executor will either do one iteration at it directly or define a few first steps as new children and iterate them. In the first case, each session makes progress in the code without adding nodes to the plan. It just makes steady progress until one iteration actually completes the node. In the second case, the node gets visited several
  times, each time against a codebase that's advanced since the last visit bcaus children got dfined and then completed.
- A node written against a specific execution-time recipe — e.g.
  `.meta/workflows/plan-node-kinds/*.md` follows exactly what that
  recipe says instead of default execution. The recipe can do anything to the codebase and the
  plan tree. Howeever, all of them still follow the Mikado process, consuming tree nodes from the leaves up until everything is gone.

## Mid-execution decomposition is normal

Any node, while being executed — not just at authoring time — can discover it isn't actually
done and add new children instead of finishing (`execute-movement.md`'s Mikado section). This is
the expected shape, not a failure. It means the tree can grow live: a goal can look like it's
shrinking for many sessions and then produce a fresh burst of leaves when some node decides it
needs another pass. A node can also re-add children to itself repeatedly and remain undeleted for
many iterations — this is exactly the loop that acceptance test nodes use.

## Writing rules for any plan node

Because any node might be claimed long after its neighbors are written, because execution reads a
node without its ancestors or siblings, and because its children and dependencies are gone
(deleted) by the time it's actually executed:

- **Never reference another node** by ID or title — it's a guaranteed-dangling reference by the
  time anyone reads it.
- **Self-contained for empty context.** Whoever executes this node has only this node (plus its
  own `context` field). Everything needed to do it right must be present here.
- **Write the target state, present tense, not a diff.** Describe where the codebase should end up
  when this node runs, assuming nothing about its current state — not today's state, not a list of
  changes to make. The executor reads the actual code at execution time and works out its own path
  from current to target; narrating "what needs to change" only fights that.
- **`context` carries what surrounding nodes would have told this node.** Since a parent's or
  sibling's text won't be visible, copy in whatever specific fact this node needs from them.
- **No identity or numbering in titles.** Plain description of the target state — node IDs are the
  identity, not the title.
- **Real markdown lists for sequential/multiple items** — actual `1.`/`2.` or bullet syntax, not a
  run-on paragraph.

## Guidance
- **A parent is a bigger experience than the sum of its children, never the union of them.** Children are smaller experiences that light up incrementally *toward* the parent's goal; they are not required to exhaustively partition it. It is normal and expected for real work to remain against the parent (or a future child of it) even after every current child has shipped.
- **A node's title is the experience/value delivered, not the technical thing built to deliver it.** It answers "what would a user say they can now do?" not "what did the implementor add?" `View another repo's plan tree from the UI` is a title; `Repo selector for the plan view` is not (it names a widget, not the value it provides). The widget belongs in `details`, not the title.
