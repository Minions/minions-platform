import { STAGE_LABEL } from './stageLabels'

/**
 * Plan item display status and visual configuration.
 *
 * Colors are chosen to meet WCAG AA contrast (≥4.5:1) and are
 * color-blind safe. Each status also has a secondary non-color
 * indicator (icon and/or text style) for protanopia/deuteranopia.
 *
 * Contrast ratios (approximate, light mode):
 *   in-planning:          slate-700 on slate-100  ≈ 9.9:1
 *   tentatively-approved: blue-700  on blue-50    ≈ 8.6:1
 *   plan-done:            emerald-700 on emerald-50 ≈ 7.5:1
 *   ready:                lime-800  on lime-50    ≈ 8.1:1
 *   wip:                  amber-800 on amber-100  ≈ 8.9:1
 *   demo-ready:           purple-800 on purple-100 ≈ 11.3:1
 *   blocked:              red-800   on red-100    ≈ 9.0:1
 */

export type PlanDisplayStatus =
  | 'in-planning'
  | 'tentatively-approved'
  | 'plan-done'
  | 'ready'
  | 'on-path'
  | 'wip'
  | 'demo-ready'
  | 'blocked';

export interface StatusDisplayConfig {
  /** Human-readable label */
  label: string;
  /** Tailwind background class */
  bgClass: string;
  /** Tailwind text color class */
  textClass: string;
  /** Tailwind border color class */
  borderClass: string;
  /**
   * Lucide icon name for the secondary color-blind-safe indicator.
   * Used alongside color so that status is distinguishable by shape/icon alone.
   */
  icon: string;
  /** Text style as an additional non-color distinguisher for in-planning */
  textStyle: 'italic' | 'normal';
}

/**
 * Visual configuration for each plan display status.
 * Use this as the single source of truth for status colors and icons
 * across both the overview (DAG) and kanban views.
 */
export const PLAN_STATUS_CONFIG: Record<PlanDisplayStatus, StatusDisplayConfig> = {
  'in-planning': {
    label: STAGE_LABEL['in-planning'],
    bgClass: 'bg-slate-100',
    textClass: 'text-slate-700',
    borderClass: 'border-slate-400',
    icon: 'circle-dashed', // hollow dashed circle — unapproved feel
    textStyle: 'italic', // secondary indicator: italic = not yet committed
  },
  'tentatively-approved': {
    label: STAGE_LABEL['tentatively-approved'],
    bgClass: 'bg-blue-50',
    textClass: 'text-blue-700',
    borderClass: 'border-blue-300',
    icon: 'eye', // "under review / being watched"
    textStyle: 'normal',
  },
  'plan-done': {
    label: STAGE_LABEL['plan-done'],
    bgClass: 'bg-blue-50',
    textClass: 'text-blue-700',
    borderClass: 'border-blue-300',
    icon: 'eye', // same visual treatment as tentatively-approved
    textStyle: 'normal',
  },
  'ready': {
    label: STAGE_LABEL['ready'],
    bgClass: 'bg-lime-50',
    textClass: 'text-lime-800',
    borderClass: 'border-lime-400',
    icon: 'zap', // hot and queued for execution
    textStyle: 'normal',
  },
  'on-path': {
    label: STAGE_LABEL['on-path'],
    bgClass: 'bg-cyan-50',
    textClass: 'text-cyan-700',
    borderClass: 'border-cyan-400',
    icon: 'target', // aiming at a goal
    textStyle: 'normal',
  },
  'wip': {
    label: STAGE_LABEL['wip'],
    bgClass: 'bg-amber-100',
    textClass: 'text-amber-800',
    borderClass: 'border-amber-500',
    icon: 'loader-2', // spinner — conveys active motion
    textStyle: 'normal',
  },
  'demo-ready': {
    label: STAGE_LABEL['demo-ready'],
    bgClass: 'bg-purple-100',
    textClass: 'text-purple-800',
    borderClass: 'border-purple-500',
    icon: 'play-circle', // play button — ready to present
    textStyle: 'normal',
  },
  'blocked': {
    label: STAGE_LABEL['blocked'],
    bgClass: 'bg-red-100',
    textClass: 'text-red-800',
    borderClass: 'border-red-500',
    icon: 'alert-triangle', // warning — urgency
    textStyle: 'normal',
  },
};

/**
 * Plan state: the orb's color. Independent of whether anyone is actively
 * working on the item — approval/readiness and activity are separate axes.
 */
export type PlanState = 'imagining' | 'done' | 'ready';

export interface PlanStateDisplayConfig {
  label: string;
  bgClass: string;
  textClass: string;
  borderClass: string;
  icon: string;
}

export const PLAN_STATE_CONFIG: Record<PlanState, PlanStateDisplayConfig> = {
  imagining: {
    label: 'Imagining',
    bgClass: 'bg-slate-100',
    textClass: 'text-slate-700',
    borderClass: 'border-slate-400',
    icon: 'circle-dashed',
  },
  done: {
    label: 'Done',
    bgClass: 'bg-blue-50',
    textClass: 'text-blue-700',
    borderClass: 'border-blue-300',
    icon: 'eye',
  },
  ready: {
    label: 'Ready',
    bgClass: 'bg-lime-50',
    textClass: 'text-lime-800',
    borderClass: 'border-lime-400',
    icon: 'zap',
  },
};

/**
 * Activity rings: independent, combinable indicators drawn around the orb.
 * A node can be several of these at once — e.g. blocked AND to-demo.
 * `implementing` supersedes `goal` for the same node (see computeActivityRings):
 * once a node is the actively-implemented leaf, it no longer also renders as
 * a plain goal-path node.
 */
export type ActivityRing = 'goal' | 'implementing' | 'to-demo' | 'blocked';

export interface ActivityRingDisplayConfig {
  label: string;
  color: string;
  icon: string;
}

export const ACTIVITY_RING_CONFIG: Record<ActivityRing, ActivityRingDisplayConfig> = {
  goal: {
    label: 'Goal',
    color: '#06b6d4',
    icon: 'target',
  },
  implementing: {
    label: 'Implementing',
    color: '#f59e0b',
    icon: 'loader-2',
  },
  'to-demo': {
    label: 'To Demo',
    color: '#a855f7',
    icon: 'play-circle',
  },
  blocked: {
    label: 'Blocked',
    color: '#ef4444',
    icon: 'alert-triangle',
  },
};
