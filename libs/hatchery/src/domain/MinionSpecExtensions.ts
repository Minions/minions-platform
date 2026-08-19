import type { MinionSpec, MinionMessage, IWorkbench } from '@minions/domain-types';
import type { ExecutableGadget } from '@minions/gadgets';

/**
 * MinionSpec fields that hatchery reads but does not itself declare on the
 * base MinionSpec (from @minions/domain-types).
 *
 * These fields are populated by upstream callers - most notably
 * @minions/conductor's `ExtendedMinionSpec` - before the spec reaches
 * hatchery. Hatchery cannot import that type directly (conductor depends on
 * hatchery, so importing it back would create a circular dependency), so it
 * declares the subset of extension fields it actually consumes here instead.
 */
export interface MinionSpecWithExtensions extends MinionSpec {
  /**
   * Workbench containing shared contextual knowledge (see IMinion.workbench).
   */
  workbench?: IWorkbench;

  /**
   * Messages to deliver to the first receive() subscriber before any live
   * messages, used to inject prior context (e.g. workbench facts/files).
   */
  syntheticHistory?: MinionMessage[];

  /**
   * Executable gadgets with mission context, consumed by BrainlessMinion's
   * default back-side co-routine and production hatcheries.
   */
  executableGadgets?: ExecutableGadget[];
}
