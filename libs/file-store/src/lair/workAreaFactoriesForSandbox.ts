/**
 * Adapter detection for `WorkAreaFactories` (design doc §4.2, end of
 * section). `createLair(sandbox, workAreaFactories)` needs adapter-specific
 * factories
 * (`createDiskWorkAreaFactories`/`createInMemoryWorkAreaFactories`), but a
 * caller holding only a `Sandbox` (the port-level interface) has no
 * structural way to tell which adapter built it — neither `Sandbox` nor
 * `BareRepository` carries an adapter discriminant (`BareRepository.kind` is
 * always `"bare-repository"` on both adapters). Only code inside this
 * package can tell the two apart (via `instanceof` against the concrete,
 * unexported `DiskSandbox`/`InMemorySandbox` classes), so that detection has
 * to live here rather than being re-implemented by every caller that only
 * has a `Sandbox` in hand (e.g. `libs/movement-branching`'s
 * `MovementActionGroup`, which constructs its own `Lair` per action call
 * from an `ActionContext.lair: Sandbox` it did not itself create).
 */

import { DiskSandbox } from "../adapters/disk/DiskSandbox.js";
import { createDiskWorkAreaFactories } from "../adapters/disk/index.js";
import { InMemorySandbox } from "../adapters/memory/InMemorySandbox.js";
import { createInMemoryWorkAreaFactories } from "../adapters/memory/index.js";
import type { Sandbox } from "../port/Sandbox.js";
import type { Directory } from "../port/types.js";
import type { WorkAreaFactories } from "./SiteWorkArea.js";

/**
 * Resolves the right `WorkAreaFactories` for whichever adapter actually
 * backs `sandbox` — `createDiskWorkAreaFactories(scratchRoot)` for a real
 * `DiskSandbox`, `createInMemoryWorkAreaFactories(scratchRoot.path)` for a
 * simulated `InMemorySandbox`. Throws for any other `Sandbox` implementation
 * (there are only two today).
 *
 * @param scratchRoot - Real (or simulated) directory worktrees created for
 *   movements/mirrors/scratch work are nested under — same requirement as
 *   `createDiskWorkAreaFactories`/`createInMemoryWorkAreaFactories`
 *   individually.
 */
export function createWorkAreaFactoriesForSandbox(sandbox: Sandbox, scratchRoot: Directory): WorkAreaFactories {
  if (sandbox instanceof DiskSandbox) {
    return createDiskWorkAreaFactories(scratchRoot);
  }
  if (sandbox instanceof InMemorySandbox) {
    return createInMemoryWorkAreaFactories(scratchRoot.path);
  }
  throw new Error(
    "createWorkAreaFactoriesForSandbox(): sandbox is neither a DiskSandbox nor an InMemorySandbox — " +
      "no WorkAreaFactories known for this Sandbox implementation.",
  );
}
