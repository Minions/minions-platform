# Define Scope, and the No-Groundwork-Without-a-Caller Requirement

### Define scope first

Before writing any code:

1. State which theme of the target node this movement covers.
2. **Before state**: what the app does right now.
3. **After state**: what additionally works after this merges.
4. **Browser-visible changes and invariants**: exactly what to navigate to, what to do, and what to observe.
5. **Prod impact**: does this movement have any chance of altering code that prod executes? When in doubt, yes.

If you can't write a concrete browser invariant, the scope is wrong — split it or expand it until you can.

### No groundwork without a caller — hard requirement, checked before you may report this done

**This unit of work (a movement or checkpoint) may not complete with any uncalled (dead) code.** Every new type, class, function, or module it adds must, by the time you report completion, either:

- have a real caller — an existing manager, UI path, or startup flow that already exists for its own independent reason and now actually depends on the new code (a unit test that only calls the new function directly to prove it behaves correctly does **not** count as a caller, even if it passes); or
- be wired in behind a feature flag if it's not yet ready for unconditional use; or
- be deleted.

There is no fourth option. "Describe the shape as data, wire it up later" is exactly the pattern this forbids: it defers the hard integration problem to a future movement, produces work nobody can meaningfully browser-verify, and hides design flaws that only surface once something real calls the code.

**Before you report this done, explicitly check every file you added or touched: does every new export have a real caller?** If a target node's natural scope is genuinely "add a new abstraction" with no natural caller yet, widen the current scope to also wire in the first caller — even if that pulls in part of what looked like a later node's work — or delete what you added and fold it into whichever future work actually needs it. Do not leave it dangling "for the next session to wire up."

**When a node calls for introducing a new abstraction, sequence it caller-first, not abstraction-first.** Concretely, in order:

1. **If the change would need to touch multiple places, or there's no good single place for it yet, remodel first — without adding any new capability.** Don't add abstractions here; just reshape/consolidate the existing code so the change sites are brought together.
2. **Add the new capability directly and explicitly, test-first.** Not a new abstraction — just the code that does the new thing, even if it's ugly or lands in the wrong file, wired against the real caller.
3. **Then refactor/remodel to extract the abstraction** — shaped by how the code actually turned out to work in detail, not by how you guessed it would look beforehand.

This is always better than the reverse order — design the abstraction first, wire it in second, then discover and fix integration bugs, then reshape the abstraction to the shape the problem actually needed. Abstraction-first guesses at a shape before anything real has exercised it; caller-first derives the shape from what the real caller actually needs, and the refactor step is safe because the behavior is already pinned by tests written against the real integration. **If you're about to write `interface`/`class` for something with no caller yet, stop — go make some existing caller do the thing first, however inelegantly, then extract.**
