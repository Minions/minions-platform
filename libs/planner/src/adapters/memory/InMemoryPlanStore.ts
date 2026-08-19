import { generateId, asNodeId } from '@minions/planner-types';
import type { ItemType, NodePlacement, PlanItem, SubtreeIndex, IPlanStore, NodeId } from '@minions/planner-types';
import { subtreeKeepsGoalPath } from '../../planPathLogic.js';

interface ContentItem {
  id: NodeId;
  title: string;
  type: ItemType;
  parent: NodeId | null;
  children: NodeId[];
  requires: NodeId[];
  exploring?: Record<string, string>;
  criteria: string[];
  approved: false | true | 'tentative';
  questions: string[];
  ready?: boolean;
  places?: Record<string, NodePlacement>;
}

interface ContentSubtree {
  root: NodeId;
  items: Record<string, ContentItem>;
}

interface ClaimEntry {
  claimedBy?: { wing: string; branch: string };
  demoLink?: string;
}

/**
 * In-memory IPlanStore implementation.
 *
 * Mirrors WorktreePlanStore's content/claims split conceptually (a `claims`
 * map keyed by item id, independent of the content subtrees, joined on
 * read) even though there's no real git/wing boundary in memory to make
 * that split load-bearing — this keeps the two adapters' observable
 * behavior identical (dangling claims tolerated and pruned the same way),
 * which is what the shared contract tests (@minions/planner-types's contracts.ts) rely on.
 * Returns structuredClone copies so callers cannot mutate internal state.
 */
export class InMemoryPlanStore implements IPlanStore {
  private readonly subtrees = new Map<NodeId, ContentSubtree>();
  private readonly itemToRoot = new Map<NodeId, NodeId>();
  private readonly claims = new Map<NodeId, ClaimEntry>();
  private readonly details = new Map<NodeId, string>();
  private readonly parentContexts = new Map<NodeId, string>();
  private rootOrder: NodeId[] = [];

  private findSubtree(itemId: NodeId): ContentSubtree | undefined {
    const rootId = this.itemToRoot.get(itemId);
    if (!rootId) return undefined;
    return this.subtrees.get(rootId);
  }

  private join(subtree: ContentSubtree): SubtreeIndex {
    const items: Record<string, PlanItem> = {};
    for (const [id, c] of Object.entries(subtree.items)) {
      const claim = this.claims.get(asNodeId(id));
      items[id] = {
        ...structuredClone(c),
        claimedBy: claim?.claimedBy ? structuredClone(claim.claimedBy) : undefined,
        demoLink: claim?.demoLink,
        started: claim?.claimedBy !== undefined,
        onPath: false,
      };
    }
    for (const id of Object.keys(items)) {
      items[id].onPath = subtreeKeepsGoalPath(id, items);
    }
    return { root: subtree.root, items };
  }

  async listRoots(): Promise<NodeId[]> {
    const all = Array.from(this.subtrees.keys());
    const ordered = this.rootOrder.filter((id) => all.includes(id));
    const remaining = all.filter((id) => !this.rootOrder.includes(id));
    return [...ordered, ...remaining];
  }

  async setRootOrder(orderedRootIds: NodeId[]): Promise<void> {
    this.rootOrder = [...orderedRootIds];
  }

  async createRoot(title: string): Promise<PlanItem> {
    const id = generateId();
    const item: ContentItem = {
      id,
      title,
      type: 'task',
      parent: null,
      children: [],
      requires: [],
      criteria: [],
      approved: false,
      questions: [],
    };
    const subtree: ContentSubtree = { root: id, items: { [id]: item } };
    this.subtrees.set(id, subtree);
    this.itemToRoot.set(id, id);
    return this.join(subtree).items[id];
  }

  async getItem(id: NodeId): Promise<PlanItem | undefined> {
    const subtree = this.findSubtree(id);
    if (!subtree?.items[id]) return undefined;
    return this.join(subtree).items[id];
  }

  async getSubtree(rootId: NodeId): Promise<SubtreeIndex | undefined> {
    const subtree = this.subtrees.get(rootId);
    return subtree ? this.join(subtree) : undefined;
  }

  async addChild(
    parentId: NodeId,
    title: string,
    type: ItemType = 'task',
  ): Promise<PlanItem> {
    const subtree = this.findSubtree(parentId);
    if (!subtree) throw new Error(`Parent item not found: ${parentId}`);

    const id = generateId();
    const item: ContentItem = {
      id,
      title,
      type,
      parent: asNodeId(parentId),
      children: [],
      requires: [],
      criteria: [],
      approved: false,
      questions: [],
    };
    subtree.items[id] = item;
    subtree.items[parentId].children.push(id);
    this.itemToRoot.set(id, subtree.root);
    return this.join(subtree).items[id];
  }

  async deleteItem(id: NodeId): Promise<void> {
    const subtree = this.findSubtree(id);
    if (!subtree) return;

    const item = subtree.items[id];
    if (!item) return;

    if (item.parent !== null) {
      const parent = subtree.items[item.parent];
      if (parent) {
        parent.children = parent.children.filter((c) => c !== id);
      }
    }

    const toDelete = new Set(this.collectDescendants(subtree, id));

    for (const [itemId, it] of Object.entries(subtree.items)) {
      if (!toDelete.has(asNodeId(itemId))) {
        it.requires = it.requires.filter((r) => !toDelete.has(r));
      }
    }

    for (const itemId of toDelete) {
      delete subtree.items[itemId];
      this.itemToRoot.delete(itemId);
      this.details.delete(itemId);
      this.parentContexts.delete(itemId);
      // claims are intentionally left in place — dangling, cleaned up by
      // pruneDanglingClaims, matching WorktreePlanStore (see its class doc).
    }

    if (id === subtree.root) {
      this.subtrees.delete(id);
    }
  }

  async moveItem(itemId: NodeId, newParentId: NodeId | null): Promise<void> {
    const sourceSubtree = this.findSubtree(itemId);
    if (!sourceSubtree) throw new Error(`Item not found: ${itemId}`);
    const item = sourceSubtree.items[itemId];

    if (item.parent === (newParentId ?? null)) return;

    if (newParentId !== null && newParentId === itemId) {
      throw new Error('Cannot move an item under itself');
    }

    const movingIds = this.collectDescendants(sourceSubtree, itemId);
    if (newParentId !== null && movingIds.includes(newParentId)) {
      throw new Error('Cannot move an item under one of its own descendants');
    }

    let targetSubtree: ContentSubtree | undefined;
    if (newParentId !== null) {
      targetSubtree = this.findSubtree(newParentId);
      if (!targetSubtree) throw new Error(`New parent not found: ${newParentId}`);
    }

    if (item.parent !== null) {
      const oldParent = sourceSubtree.items[item.parent];
      if (oldParent) {
        oldParent.children = oldParent.children.filter((c) => c !== itemId);
      }
    }

    if (newParentId !== null && targetSubtree && targetSubtree.root === sourceSubtree.root) {
      item.parent = asNodeId(newParentId);
      targetSubtree.items[newParentId].children.push(asNodeId(itemId));
      return;
    }

    if (newParentId === null) {
      const newIndex: ContentSubtree = { root: asNodeId(itemId), items: {} };
      for (const id of movingIds) {
        newIndex.items[id] = sourceSubtree.items[id];
        delete sourceSubtree.items[id];
        this.itemToRoot.set(id, itemId);
      }
      newIndex.items[itemId].parent = null;
      this.subtrees.set(itemId, newIndex);
    } else if (targetSubtree) {
      for (const id of movingIds) {
        targetSubtree.items[id] = sourceSubtree.items[id];
        delete sourceSubtree.items[id];
        this.itemToRoot.set(id, targetSubtree.root);
      }
      targetSubtree.items[itemId].parent = asNodeId(newParentId);
      targetSubtree.items[newParentId].children.push(asNodeId(itemId));
    }

    if (itemId === sourceSubtree.root) {
      this.subtrees.delete(sourceSubtree.root);
      this.rootOrder = this.rootOrder.filter((r) => r !== sourceSubtree.root);
    }
  }

  private collectDescendants(subtree: ContentSubtree, id: NodeId): NodeId[] {
    const result: NodeId[] = [id];
    const item = subtree.items[id];
    if (item) {
      for (const childId of item.children) {
        result.push(...this.collectDescendants(subtree, childId));
      }
    }
    return result;
  }

  async addRequires(itemId: NodeId, dependsOnId: NodeId): Promise<void> {
    const subtree = this.findSubtree(itemId);
    if (!subtree) throw new Error(`Item not found: ${itemId}`);
    const item = subtree.items[itemId];
    if (!item.requires.includes(asNodeId(dependsOnId))) {
      item.requires.push(asNodeId(dependsOnId));
    }
  }

  async removeRequires(itemId: NodeId, dependsOnId: NodeId): Promise<void> {
    const subtree = this.findSubtree(itemId);
    if (!subtree) throw new Error(`Item not found: ${itemId}`);
    const item = subtree.items[itemId];
    item.requires = item.requires.filter((r) => r !== dependsOnId);
  }

  async setRequires(itemId: NodeId, requires: NodeId[]): Promise<void> {
    const subtree = this.findSubtree(itemId);
    if (!subtree) throw new Error(`Item not found: ${itemId}`);
    subtree.items[itemId].requires = requires.map(asNodeId);
  }

  async cleanupRequiresReferences(deletedId: NodeId): Promise<void> {
    for (const subtree of this.subtrees.values()) {
      for (const item of Object.values(subtree.items)) {
        if (item.requires.includes(asNodeId(deletedId))) {
          item.requires = item.requires.filter((r) => r !== deletedId);
        }
      }
    }
  }

  async setTitle(itemId: NodeId, title: string): Promise<void> {
    const subtree = this.findSubtree(itemId);
    if (!subtree) throw new Error(`Item not found: ${itemId}`);
    subtree.items[itemId].title = title;
  }

  async setType(itemId: NodeId, type: ItemType): Promise<void> {
    const subtree = this.findSubtree(itemId);
    if (!subtree) throw new Error(`Item not found: ${itemId}`);
    subtree.items[itemId].type = type;
  }

  async getDetails(itemId: NodeId): Promise<string> {
    return this.details.get(itemId) ?? '';
  }

  async setDetails(itemId: NodeId, details: string): Promise<void> {
    const subtree = this.findSubtree(itemId);
    if (!subtree) throw new Error(`Item not found: ${itemId}`);
    this.details.set(itemId, details);
  }

  async getParentContext(itemId: NodeId): Promise<string> {
    return this.parentContexts.get(itemId) ?? '';
  }

  async setParentContext(itemId: NodeId, content: string): Promise<void> {
    const subtree = this.findSubtree(itemId);
    if (!subtree) throw new Error(`Item not found: ${itemId}`);
    this.parentContexts.set(itemId, content);
  }

  async setCriteria(itemId: NodeId, criteria: string[]): Promise<void> {
    const subtree = this.findSubtree(itemId);
    if (!subtree) throw new Error(`Item not found: ${itemId}`);
    const item = subtree.items[itemId];
    item.criteria = [...criteria];
  }

  async setExploring(
    forkId: NodeId,
    exploring: Record<string, string>,
  ): Promise<void> {
    const subtree = this.findSubtree(forkId);
    if (!subtree) throw new Error(`Item not found: ${forkId}`);
    subtree.items[forkId].exploring = { ...exploring };
  }

  async clearExploring(forkId: NodeId): Promise<void> {
    const subtree = this.findSubtree(forkId);
    if (!subtree) throw new Error(`Item not found: ${forkId}`);
    delete subtree.items[forkId].exploring;
  }

  async addQuestion(itemId: NodeId, questionId: string): Promise<void> {
    const subtree = this.findSubtree(itemId);
    if (!subtree) throw new Error(`Item not found: ${itemId}`);
    const item = subtree.items[itemId];
    if (!item.questions.includes(questionId)) {
      item.questions.push(questionId);
    }
  }

  async removeQuestion(itemId: NodeId, questionId: string): Promise<void> {
    const subtree = this.findSubtree(itemId);
    if (!subtree) throw new Error(`Item not found: ${itemId}`);
    const item = subtree.items[itemId];
    item.questions = item.questions.filter((q) => q !== questionId);
  }

  async setApproved(itemId: NodeId, approved: false | true | 'tentative'): Promise<void> {
    const subtree = this.findSubtree(itemId);
    if (!subtree) throw new Error(`Item not found: ${itemId}`);
    const toUpdate = this.collectDescendants(subtree, itemId);
    for (const id of toUpdate) {
      subtree.items[id].approved = approved;
      if (approved === false) {
        subtree.items[id].ready = false;
      }
    }
  }

  async setReady(itemId: NodeId, ready: boolean): Promise<void> {
    const subtree = this.findSubtree(itemId);
    if (!subtree) throw new Error(`Item not found: ${itemId}`);
    subtree.items[itemId].ready = ready;
  }

  async setDemoLink(itemId: NodeId, demoLink: string | undefined): Promise<void> {
    const existing = this.claims.get(itemId) ?? {};
    if (demoLink === undefined) {
      const { claimedBy } = existing;
      if (claimedBy) this.claims.set(itemId, { claimedBy });
      else this.claims.delete(itemId);
    } else {
      this.claims.set(itemId, { ...existing, demoLink });
    }
  }

  async setPlaces(
    itemId: NodeId,
    places: Record<string, NodePlacement> | undefined,
  ): Promise<void> {
    const subtree = this.findSubtree(itemId);
    if (!subtree) throw new Error(`Item not found: ${itemId}`);
    subtree.items[itemId].places = places;
  }

  async setClaimedBy(itemId: NodeId, claimedBy: { wing: string; branch: string } | undefined): Promise<void> {
    const existing = this.claims.get(itemId) ?? {};
    if (claimedBy === undefined) {
      const { demoLink } = existing;
      if (demoLink !== undefined) this.claims.set(itemId, { demoLink });
      else this.claims.delete(itemId);
    } else {
      this.claims.set(itemId, { ...existing, claimedBy });
    }
  }

  async pruneDanglingClaims(
    keepIfDangling: (itemId: NodeId, claimedBy: { wing: string; branch: string }) => Promise<boolean>,
  ): Promise<{ prunedIds: NodeId[] }> {
    const prunedIds: NodeId[] = [];
    for (const [id, entry] of Array.from(this.claims.entries())) {
      if (this.itemToRoot.has(id)) continue; // present in content, not dangling
      if (entry.claimedBy) {
        const keep = await keepIfDangling(id, entry.claimedBy);
        if (keep) continue;
      }
      this.claims.delete(id);
      prunedIds.push(id);
    }
    return { prunedIds };
  }
}
