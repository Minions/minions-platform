import type { ItemType, NodePlacement, PlanItem, SubtreeIndex } from './types.js';
import type { NodeId } from './nodeId.js';

/**
 * Port: operations for reading and writing the plan tree.
 *
 * The plan is a forest of trees. Each top-level item is a root, stored
 * independently. Items are identified by stable hex IDs. Markdown content
 * is stored separately from structure so structure reads stay fast.
 *
 * Design contract:
 * - getItem() searches across all subtrees
 * - requires[] may reference items in any subtree (cross-tree deps are valid)
 * - Details/parentContext default to empty string; callers may omit them
 * - deleteItem() is recursive and idempotent for unknown IDs
 */
export interface IPlanStore {
  // ---- Root management ----

  /**
   * List IDs of all top-level (root) items, in priority order.
   * Items not present in the stored order are appended after ordered items.
   */
  listRoots(): Promise<NodeId[]>;

  /**
   * Set the priority order for root items.
   * IDs not in the list are treated as lower priority (appended after ordered items).
   * Passing an empty array clears explicit ordering.
   */
  setRootOrder(orderedRootIds: NodeId[]): Promise<void>;

  /** Create a new top-level item */
  createRoot(title: string): Promise<PlanItem>;

  // ---- Item access ----

  /** Get any item by ID, searching across all subtrees. Returns undefined if not found. */
  getItem(id: NodeId): Promise<PlanItem | undefined>;

  /** Get the complete subtree index for a root item. Returns undefined if not found. */
  getSubtree(rootId: NodeId): Promise<SubtreeIndex | undefined>;

  // ---- Tree structure ----

  /** Add a child item under the given parent. Throws if parent not found. */
  addChild(parentId: NodeId, title: string, type?: ItemType): Promise<PlanItem>;

  /** Delete an item and all its descendants. Idempotent for unknown IDs. */
  deleteItem(id: NodeId): Promise<void>;

  /**
   * Re-parent an item (and its entire subtree) under newParentId, or promote it
   * to a new top-level root when newParentId is null. Moving across roots
   * relocates the subtree's stored content (structure + markdown).
   *
   * Idempotent when the item is already at newParentId (no-op). Throws if the
   * item or new parent is not found, if newParentId is the item itself, or if
   * newParentId is one of the item's own descendants (which would create a cycle).
   */
  moveItem(itemId: NodeId, newParentId: NodeId | null): Promise<void>;

  // ---- Dependencies ----

  /** Record that itemId depends on dependsOnId. Idempotent. Throws if item not found. */
  addRequires(itemId: NodeId, dependsOnId: NodeId): Promise<void>;

  /** Remove a dependency. Throws if item not found. */
  removeRequires(itemId: NodeId, dependsOnId: NodeId): Promise<void>;

  /** Replace the entire requires list for an item. Throws if item not found. */
  setRequires(itemId: NodeId, requires: NodeId[]): Promise<void>;

  /**
   * Remove deletedId from requires arrays of every item across all roots.
   * Used after completing/deleting an item to clean up stale cross-subtree references.
   * Idempotent — safe to call even if deletedId is not referenced anywhere.
   */
  cleanupRequiresReferences(deletedId: NodeId): Promise<void>;

  // ---- Content ----

  /** Set the human-readable title for an item. Throws if item not found. */
  setTitle(itemId: NodeId, title: string): Promise<void>;

  /** Set the item type (task/fork/option). Throws if item not found. */
  setType(itemId: NodeId, type: ItemType): Promise<void>;

  /** Get the markdown details for an item. Returns '' if none exists. */
  getDetails(itemId: NodeId): Promise<string>;

  /** Set the markdown details for an item. Throws if item not found. */
  setDetails(itemId: NodeId, details: string): Promise<void>;

  /** Get the parent context markdown for an item. Returns '' if none exists. */
  getParentContext(itemId: NodeId): Promise<string>;

  /** Set the parent context markdown for an item. Throws if item not found. */
  setParentContext(itemId: NodeId, content: string): Promise<void>;

  /** Set the acceptance/verification criteria for an item. Throws if item not found. */
  setCriteria(itemId: NodeId, criteria: string[]): Promise<void>;

  // ---- Fork lifecycle ----

  /** Record that a fork is being actively explored, mapping optionId -> branchName. Throws if not found. */
  setExploring(forkId: NodeId, exploring: Record<string, string>): Promise<void>;

  /** Clear the exploring state from a fork after resolution. Throws if not found. */
  clearExploring(forkId: NodeId): Promise<void>;

  // ---- Questions ----

  /** Add a question ID to an item's questions list. Idempotent. Throws if item not found. */
  addQuestion(itemId: NodeId, questionId: string): Promise<void>;

  /** Remove a question ID from an item's questions list. Idempotent. Throws if item not found. */
  removeQuestion(itemId: NodeId, questionId: string): Promise<void>;

  // ---- Approval / lifecycle state ----

  /** Set the approved state for an item and all its descendants. Throws if item not found. */
  setApproved(itemId: NodeId, approved: false | true | 'tentative'): Promise<void>;

  /**
   * Set or clear the demo link for an item. Lair-owned; dangling by design —
   * never throws for an id absent from this store's own content (see
   * setClaimedBy). `rootIdHint` lets a caller that validated the id against
   * a different content view (e.g. a wing's own, pre-merge) tell this store
   * which root's claims.toml to write into; ignored once the id is found in
   * this store's own content, or once some existing claims.toml entry
   * already pins down the root.
   */
  setDemoLink(itemId: NodeId, demoLink: string | undefined, rootIdHint?: NodeId): Promise<void>;

  /** Set or clear this item's product-space placements (locations/flows it touches per space). Throws if item not found. */
  setPlaces(itemId: NodeId, places: Record<string, NodePlacement> | undefined): Promise<void>;

  /**
   * Set or clear the claimedBy identity on the leaf node being actively worked on.
   * Lair-owned; dangling by design — does NOT require the item to exist in this
   * store's own content view. That's what lets claim-node record a claim on a node
   * a wing just created locally but hasn't merged to main yet: existence is
   * validated one level up (PlanActionGroup.ts) against whichever content view is
   * appropriate — the calling wing's own when available, this store's otherwise —
   * before this is called. See `setDemoLink` for `rootIdHint`. Throws only if no
   * root can be resolved at all (id unknown everywhere, and no hint given).
   */
  setClaimedBy(
    itemId: NodeId,
    claimedBy: { wing: string; branch: string } | undefined,
    rootIdHint?: NodeId,
  ): Promise<void>;

  /**
   * Set the ready state for a single item (not recursive).
   * Only meaningful when approved is non-false; callers should ensure this.
   * Throws if item not found.
   */
  setReady(itemId: NodeId, ready: boolean): Promise<void>;

  /**
   * Sweep every root's claims.toml for entries whose id has no matching
   * content.toml entry in that same root. For each dangling entry that has
   * a claimedBy, `keepIfDangling` decides whether it's actually still valid
   * (e.g. the owning wing's own worktree still has the node — pending
   * merge, not stale) before it's dropped; return true to keep it. A
   * dangling entry with no claimedBy (demoLink only) is always dropped —
   * mark-demo only ever sets demoLink on an id already present in this
   * store's own content at the time, so a demoLink-only entry going
   * dangling can only mean the item was deleted afterward. Safe/cheap to
   * call opportunistically — a root with no dangling entries does no writes
   * and does not invoke `keepIfDangling` at all.
   */
  pruneDanglingClaims(
    keepIfDangling: (itemId: NodeId, claimedBy: { wing: string; branch: string }) => Promise<boolean>,
  ): Promise<{ prunedIds: NodeId[] }>;
}
