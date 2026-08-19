import type { NodeId } from './nodeId.js';
import { asNodeId } from './nodeId.js';

/** Type of a plan item */
export type ItemType = 'task' | 'fork' | 'option';

/**
 * A single item in the plan tree.
 *
 * Items form a tree via parent/children. Dependencies between items (partial
 * order within a subtree) are expressed via requires. Fork items track active
 * exploration branches via exploring.
 */
export interface PlanItem {
  /** Stable 8-char hex ID, generated at creation */
  id: NodeId;
  /** Human-readable title */
  title: string;
  /** task = normal work, fork = decision point, option = one branch of a fork */
  type: ItemType;
  /** ID of parent item, or null for root items */
  parent: NodeId | null;
  /** Ordered list of child item IDs */
  children: NodeId[];
  /** IDs of items this item depends on (must be done before this one starts) */
  requires: NodeId[];
  /** Fork items only: maps optionId -> branchName for active exploration */
  exploring?: Record<string, string>;
  /** Acceptance/verification criteria. Applicable to task/option types. */
  criteria: string[];
  /**
   * Overlord approval state. false=unapproved, true=approved, 'tentative'=AI-created
   * auto-approved. Also carries the old planning_done meaning (merged in: the two were
   * redundant) — approved !== false is "planning is done enough to proceed".
   */
  approved: false | true | 'tentative';
  /** Set by execution cell when work completes. Presence signals "Demo Ready" state. Lair-owned: only claim-node/unclaim-node/mark-demo write this. */
  demoLink?: string;
  /**
   * True when someone is actively working this node. Computed, not stored:
   * always equal to `claimedBy !== undefined`. Present on every PlanItem returned
   * by the store for API-shape compatibility, but there is no setter for it.
   */
  started: boolean;
  /**
   * True when this item is on the active path leading to a claimed leaf (or a leaf
   * that reached a demoable state). Does NOT mean this item is itself claimed.
   * Computed, not stored: derived from claimedBy/demoLink across the subtree
   * (see planPathLogic.ts's subtreeKeepsGoalPath). No setter for it.
   */
  onPath: boolean;
  /**
   * Set only on the leaf node that is actively being worked on; stores the wing and
   * branch doing the work. Lair-owned: only claim-node/unclaim-node write this.
   */
  claimedBy?: { wing: string; branch: string };
  /** IDs of open questions (ask-tool instances) that must be answered before this item can proceed. */
  questions: string[];
  /** True when the overlord has explicitly queued this item for execution. Only valid when approved is non-false. Cleared automatically when approved is set to false. */
  ready?: boolean;
  /**
   * Where this node sits in each product space, keyed by space kind
   * (e.g. 'user-flow', 'data-flow'). Locations and flows themselves live in the
   * stable space definitions (.meta/plan/.spaces/*.json); a node only records
   * which of them it touches.
   */
  places?: Record<string, NodePlacement>;
}

/** A node's footprint within one product space: the locations (and optionally flows) it touches. */
export interface NodePlacement {
  /** Location ids in the space this node touches. */
  locationIds: string[];
  /** Flow ids in the space this node participates in. */
  flowIds?: string[];
}

/**
 * The complete plan tree rooted at one top-level item.
 *
 * Stored as plan/{root}/content.toml (wing-owned: title, structure, criteria,
 * approved, ready, etc.) plus plan/{root}/claims.toml (lair-owned: claimedBy,
 * demoLink only) in the git-backed store, joined on read. A claims.toml entry
 * whose id isn't present in content.toml is dangling and silently dropped on
 * read — see WorktreePlanStore for why that's expected, not corruption. All
 * items in the subtree — including the root itself — live in the items map.
 */
export interface SubtreeIndex {
  /** ID of the root (top-level) item */
  root: NodeId;
  /** All items in this subtree, keyed by ID */
  items: Record<string, PlanItem>;
}

/**
 * Generate a new stable 8-char hex item ID.
 *
 * Uses the Web Crypto API (`globalThis.crypto`) rather than `node:crypto` —
 * this package is `platform:universal` (importable from browser code), and
 * `crypto.getRandomValues` is the one random-bytes source available in both
 * Node and browsers without an import.
 */
export function generateId(): NodeId {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(4));
  return asNodeId(Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(''));
}
