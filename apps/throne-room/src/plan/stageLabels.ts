/**
 * Canonical human-readable labels for every planning stage.
 *
 * Two parallel systems use stages — river zones (SystemFlow) and plan display
 * statuses (LivingCosmos / status-config). Both derive their labels from here
 * so they never desync.
 *
 * River zone IDs:        imagine | plan-done | ready | in-goal | active | done
 * Plan display statuses: in-planning | tentatively-approved | plan-done | ready | on-path | wip | demo-ready | blocked
 */

export const STAGE_LABEL = {
  // ── River zone IDs ────────────────────────────────────────────────────────
  'imagine':    'To Imagine',
  'plan-done':  'Plan Done',
  'ready':      'Ready',
  'in-goal':    'Active Goal',
  'active':     'Active Implementation',
  'done':       'To Demo',

  // ── Plan display status IDs (mapped to the same stage labels) ─────────────
  'in-planning':          'To Imagine',
  'tentatively-approved': 'Plan Done',
  // 'plan-done' already covered above
  // 'ready' already covered above
  'on-path':              'Active Goal',
  'wip':                  'Active Implementation',
  'demo-ready':           'To Demo',
  'blocked':              'Blocked',   // condition, not a stage — kept distinct
} as const satisfies Record<string, string>

export type StageKey = keyof typeof STAGE_LABEL
