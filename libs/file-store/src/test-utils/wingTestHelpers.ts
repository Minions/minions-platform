import type { Directory } from '../port';
import type { Wing, Lair, WorkArea, Scratchpad, WorkAreaFactories, RepoAlias } from '../lair';
import { asWingName, createWorkArea, createScratchpad } from '../lair';

/**
 * Options for creating a test Wing
 */
export interface CreateTestWingOptions {
  /** Wing name */
  name: string;
  /** Root directory for the wing */
  root: Directory;
  /** Lair instance (required - create with createLair(sandbox)) */
  lair: Lair;
  /** Whether closet exists (defaults to true) */
  closetExists?: boolean;
  /**
   * Optional `WorkAreaFactories` (design doc §4.2/§4.3), e.g.
   * `createWorkAreaFactoriesForSandbox(sandbox, scratchRoot)`. Powers the
   * `workAreaLocal()`/`workAreaGlobal()`/`workAreaNamed()`/
   * `privateWorkAreaGlobal()` accessors below — mirrors
   * `LairWing.requireWorkAreaFactories()`'s real behavior: omitting this
   * makes those four accessors throw the same "was constructed without
   * WorkAreaFactories" error a real `Wing` built via `createLair(sandbox)`
   * (no factories) would. `scratchpad()` needs no factories, same as the
   * real implementation.
   */
  workAreaFactories?: WorkAreaFactories;
}

/**
 * Create a test Wing object with minimal implementation.
 * Useful for testing components that depend on Wing but don't need full functionality.
 *
 * @param options - Configuration options for the test wing
 * @returns A Wing object suitable for testing
 *
 * @example
 * ```typescript
 * const sandbox = createDiskSandbox('/test/path');
 * const wing = createTestWing({
 *   name: 'test-wing',
 *   root: sandbox.root
 * });
 * ```
 */
export function createTestWing(options: CreateTestWingOptions): Wing {
  const { name, root, lair, closetExists = true, workAreaFactories } = options;
  // Lair is required - callers must create and pass it
  if (!lair) {
    throw new Error('createTestWing requires a lair parameter. Create one with createLair(sandbox) and pass it in.');
  }
  const wingLair = lair;

  function requireWorkAreaFactories(): WorkAreaFactories {
    if (!workAreaFactories) {
      throw new Error(
        `Wing '${name}' was constructed without WorkAreaFactories — pass one to createTestWing() ` +
          `to use the design-doc-§4.2 WorkArea-returning accessors (workAreaLocal/workAreaGlobal/` +
          `workAreaNamed/privateWorkAreaGlobal). scratchpad() needs no factories and always works.`,
      );
    }
    return workAreaFactories;
  }

  return {
    name: asWingName(name),
    root,
    lair: wingLair,
    closet: async () => {
      if (closetExists === false) {
        throw new Error('Closet not found');
      }
      const result = await root.child('closet');
      if (result.found && result.node.kind === 'directory') {
        return result.node;
      }
      throw new Error('Closet not found');
    },
    workLocal: async () => ({ found: false, exists: false }),
    workGlobal: async () => ({ found: false, exists: false }),
    privateLocal: async () => ({ found: false, exists: false }),
    privateGlobal: async () => ({ found: false, exists: false }),
    info: async () => {
      throw new Error('Not implemented');
    },
    setupWorkLocal: async () => {
      throw new Error('Not implemented');
    },
    setupWorkGlobal: async () => {
      throw new Error('Not implemented');
    },
    setupPrivateLocal: async () => {
      throw new Error('Not implemented');
    },
    setupPrivateGlobal: async () => {
      throw new Error('Not implemented');
    },
    claudeMd: async () => {
      throw new Error('Not implemented');
    },
    setupInfoLink: async () => {
      throw new Error('Not implemented');
    },
    setupClosetLink: async () => {
      throw new Error('Not implemented');
    },
    workNamed: async () => ({ exists: false }),
    namedWorkNames: async () => [],
    addWorkNamed: async () => {
      throw new Error('Not implemented');
    },
    removeWorkNamed: async () => {
      throw new Error('Not implemented');
    },
    // WorkArea/Scratchpad accessors (design doc §4.2). Genuinely
    // implemented, mirroring `LairWing`'s own real implementation exactly:
    // each derives from the corresponding raw accessor (`this.workLocal()`
    // etc.) rather than a fixed stub, so a test that overrides one of those
    // accessors (e.g. `{ ...createTestWing(...), workLocal: async () =>
    // ({ exists: true, worktree }) }`, the established pattern in
    // `closetUtils.test.ts`) transparently changes what the corresponding
    // WorkArea accessor sees too — using method-shorthand (not arrow
    // functions) here is load-bearing for that: `this` resolves to
    // whatever object the method is actually called on (a later spread
    // copy included), the same dynamic-dispatch semantics
    // `LairWing`'s real class methods get for free.
    async workAreaLocal(this: Wing): Promise<WorkArea> {
      const workArea = await this.workAreaLocalIfExists();
      if (!workArea) {
        throw new Error(`Wing '${name}' has no work/local worktree set up — call setupWorkLocal first`);
      }
      return workArea;
    },
    async workAreaLocalIfExists(this: Wing): Promise<WorkArea | undefined> {
      const result = await this.workLocal();
      if (!result.exists) return undefined;
      return createWorkArea(result.worktree.repository, result.worktree, requireWorkAreaFactories());
    },
    async workAreaGlobal(this: Wing): Promise<WorkArea> {
      const result = await this.workGlobal();
      if (!result.exists) {
        throw new Error(`Wing '${name}' has no work/global worktree set up — call setupWorkGlobal first`);
      }
      return createWorkArea(result.worktree.repository, result.worktree, requireWorkAreaFactories());
    },
    async workAreaNamed(this: Wing, workAreaNamedArg: RepoAlias): Promise<WorkArea | undefined> {
      const result = await this.workNamed(workAreaNamedArg);
      if (!result.exists) return undefined;
      // Only "worktree"/"junction-worktree" have a real worktree (and thus a
      // repo) to attach a Trunk/Movement to — a plain "junction" doesn't.
      if (result.kind === 'junction') return undefined;
      return createWorkArea(result.worktree.repository, result.worktree, requireWorkAreaFactories());
    },
    async namedWorkPath(this: Wing, namedWorkPathArg: RepoAlias): Promise<string | undefined> {
      const result = await this.workNamed(namedWorkPathArg);
      return result.exists ? result.path : undefined;
    },
    async privateWorkAreaGlobal(this: Wing): Promise<WorkArea> {
      const result = await this.privateGlobal();
      if (!result.exists) {
        throw new Error(`Wing '${name}' has no private/global worktree set up — call setupPrivateGlobal first`);
      }
      return createWorkArea(result.worktree.repository, result.worktree, requireWorkAreaFactories());
    },
    async scratchpad(this: Wing): Promise<Scratchpad> {
      const result = await this.privateLocal();
      if (!result.exists) {
        throw new Error(`Wing '${name}' has no private/local worktree set up — call setupPrivateLocal first`);
      }
      return createScratchpad(result.worktree.repository, result.worktree);
    },
    // Genuinely implemented, mirroring `LairWing.discardWorkAreas()` exactly
    // (same reasoning as the WorkArea accessors above): derives from
    // `this.workLocal()`/etc rather than a fixed no-op, so a test that
    // overrides one of those accessors also gets correct teardown behavior
    // for it. With every accessor at its default stub (nothing exists), this
    // is a no-op — matching a wing with nothing set up.
    async discardWorkAreas(this: Wing): Promise<void> {
      const workLocalResult = await this.workLocal();
      if (workLocalResult.exists) {
        await workLocalResult.worktree.repository.removeWorktree(workLocalResult.worktree);
      }

      const workGlobalResult = await this.workGlobal();
      if (workGlobalResult.exists) {
        await workGlobalResult.worktree.repository.removeWorktree(workGlobalResult.worktree);
      }

      const namedWorkNames = await this.namedWorkNames();
      for (const workName of namedWorkNames) {
        await this.removeWorkNamed(workName);
      }

      const privateLocalResult = await this.privateLocal();
      if (privateLocalResult.exists) {
        await privateLocalResult.worktree.repository.removeWorktree(privateLocalResult.worktree);
      }

      const privateGlobalResult = await this.privateGlobal();
      if (privateGlobalResult.exists) {
        await privateGlobalResult.worktree.repository.removeWorktree(privateGlobalResult.worktree);
      }
    },
  } as Wing;
}
