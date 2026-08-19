import type { PlanItem } from '@minions/planner-types';
import type { ActivityRing, PlanDisplayStatus, PlanState } from './status-config';

/**
 * Fields needed to derive plan state / activity rings. Deliberately looser
 * than PlanItem (all optional) since callers may hold wire-format records
 * (e.g. PlanItemRecord from @minions/mcp-types) rather than the strict
 * backend type.
 */
interface PlanStateFields {
  approved?: false | true | 'tentative';
  ready?: boolean;
  started?: boolean;
  onPath?: boolean;
  demoLink?: string;
  questions?: string[];
}

/**
 * Derives the orb color: approval/readiness only. Fully independent of
 * whether the item is being actively worked on — see computeActivityRings
 * for that axis.
 */
export function computePlanState(item: PlanStateFields): PlanState {
  if (item.approved === false || item.approved === undefined) {
    return 'imagining';
  }
  if (item.ready) {
    return 'ready';
  }
  return 'done';
}

/**
 * Derives the set of activity rings drawn around the orb. Independent of
 * planState — a node in any plan state can carry any combination of rings.
 *
 * `implementing` supersedes `goal`: once a node is itself the claimed leaf
 * being worked on, it's redundant to also show it as merely "on the path to"
 * a goal.
 */
export function computeActivityRings(item: PlanStateFields): ActivityRing[] {
  const rings: ActivityRing[] = [];
  if (item.started) {
    rings.push('implementing');
  } else if (item.onPath) {
    rings.push('goal');
  }
  if (item.demoLink) {
    rings.push('to-demo');
  }
  if (item.questions && item.questions.length > 0) {
    rings.push('blocked');
  }
  return rings;
}

/**
 * Derives the display state of a plan item from its fields.
 * State is computed, never stored directly.
 *
 * Priority order:
 * 1. Blocked (overlay) — unanswered questions block all progress
 * 2. Demo Ready — work is complete and demonstrable
 * 3. WIP — execution has begun
 * 4. On Path — on the active path to a claimed leaf
 * 5. Ready — overlord has explicitly queued this for execution
 * 6. In Planning — not yet approved (approved=false)
 * 7. Tentatively Approved — AI-created, pending human full approval
 * 8. Plan Done — human-approved, not yet queued for execution
 */
export function computePlanDisplayState(item: PlanItem): PlanDisplayStatus {
  if (item.questions && item.questions.length > 0) {
    return 'blocked';
  }

  if (item.demoLink) {
    return 'demo-ready';
  }

  if (item.started) {
    return 'wip';
  }

  if (item.onPath) {
    return 'on-path';
  }

  if (item.ready) {
    return 'ready';
  }

  if (item.approved === false) {
    return 'in-planning';
  }

  if (item.approved === 'tentative') {
    return 'tentatively-approved';
  }

  return 'plan-done';
}
