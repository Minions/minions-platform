import type { Worktree, Directory } from '@minions/file-store';
import { generateId, asNodeId } from '@minions/planner-types';
import type { ItemType, NodePlacement, PlanItem, SubtreeIndex, IPlanStore, NodeId } from '@minions/planner-types';
import { subtreeKeepsGoalPath } from '../../planPathLogic.js';
import { serializeContent, parseContent, serializeClaims, parseClaims, type ContentFields, type ClaimFields } from './planToml.js';

/**
 * IPlanStore backed by a file-store Worktree or Directory.
 *
 * Accepts either a Worktree (for git-tracked use) or a plain Directory
 * (for reading plans that live inside an existing repo checkout).
 *
 * Layout within planDir:
 *
 *   {planDir}/
 *     _root-order.json    ← optional: ordered list of root IDs for priority
 *     {rootId}/           ← one subdirectory per top-level item
 *       content.toml      ← wing-owned durable content for every item in the subtree
 *       claims.toml       ← lair-owned coordination state (claimedBy, demoLink) — only
 *                            for items that currently have one or the other set
 *       {itemId}.md       ← markdown content for each item in the subtree
 *
 * content.toml and claims.toml are deliberately separate files, written by
 * disjoint sets of operations (content.toml: create-root/add-children/
 * delete-subtree/move-node/update-item/etc, run from a wing's own movement
 * branch; claims.toml: claim-node/unclaim-node/mark-demo, run against the
 * lair's plan/main mirror and absorbed immediately) — see the design note in
 * SubtreeIndex's doc comment. A claims.toml entry whose id has no matching
 * content.toml entry is a *dangling claim*, not corruption: it can mean the
 * item was completed/deleted after being claimed (stale — resolved by the
 * next pruneDanglingClaims sweep), or that a wing claimed a node it just
 * created locally, not yet merged to main (pending merge — must NOT be
 * pruned). Distinguishing the two is the caller's job (see
 * PlanActionGroup.ts's claim/unclaim/mark-demo bodies); this store just
 * tolerates and exposes dangling entries and provides the sweep primitive.
 * Every read (getItem/getSubtree) silently drops claims that don't match a
 * live content id — the join only ever visits ids present in content.toml.
 */
export class WorktreePlanStore implements IPlanStore {
  constructor(private readonly planDir: Worktree | Directory) {}

  // ---- private helpers ----

  private async getRootDir(
    rootId: NodeId,
  ): Promise<Worktree | Directory | undefined> {
    const planDir = this.planDir;
    if (planDir.kind === 'worktree') {
      const result = await planDir.child(rootId);
      if (!result.found || result.node.kind !== 'worktree') return undefined;
      return result.node;
    } else {
      const result = await planDir.child(rootId);
      if (!result.found || result.node.kind !== 'directory') return undefined;
      return result.node;
    }
  }

  private async readTextFile(rootDir: Worktree | Directory, name: string): Promise<string | undefined> {
    const result = await rootDir.child(name);
    if (!result.found || result.node.kind !== 'file') return undefined;
    return result.node.read();
  }

  private async writeTextFile(rootDir: Worktree | Directory, name: string, content: string): Promise<void> {
    const result = await rootDir.child(name);
    if (result.found && result.node.kind === 'file') {
      await result.node.write(content);
    } else {
      await rootDir.createFile(name, content);
    }
  }

  private async readContent(rootId: NodeId): Promise<{ order: NodeId[]; items: Record<string, ContentFields> } | undefined> {
    const rootDir = await this.getRootDir(rootId);
    if (!rootDir) return undefined;
    const text = await this.readTextFile(rootDir, 'content.toml');
    if (text === undefined) return undefined;
    return parseContent(text);
  }

  private async writeContent(
    rootDir: Worktree | Directory,
    order: NodeId[],
    items: Record<string, ContentFields>,
  ): Promise<void> {
    await this.writeTextFile(rootDir, 'content.toml', serializeContent(order, items));
  }

  private async readClaims(rootId: NodeId): Promise<Record<string, ClaimFields>> {
    const rootDir = await this.getRootDir(rootId);
    if (!rootDir) return {};
    const text = await this.readTextFile(rootDir, 'claims.toml');
    if (text === undefined) return {};
    return parseClaims(text);
  }

  private async writeClaims(rootDir: Worktree | Directory, claims: Record<string, ClaimFields>): Promise<void> {
    await this.writeTextFile(rootDir, 'claims.toml', serializeClaims(claims));
  }

  /** Join content + claims for one root into the full PlanItem shape, computing started/onPath. */
  private join(rootId: NodeId, order: NodeId[], content: Record<string, ContentFields>, claims: Record<string, ClaimFields>): SubtreeIndex {
    const items: Record<string, PlanItem> = {};
    for (const id of order) {
      const c = content[id];
      if (!c) continue;
      const claim = claims[id];
      items[id] = {
        id: asNodeId(id),
        title: c.title,
        type: c.type,
        parent: c.parent,
        children: c.children,
        requires: c.requires,
        exploring: c.exploring,
        criteria: c.criteria,
        approved: c.approved,
        questions: c.questions,
        ready: c.ready,
        places: c.places,
        claimedBy: claim?.claimedBy,
        demoLink: claim?.demoLink,
        started: claim?.claimedBy !== undefined,
        onPath: false,
      };
    }
    for (const id of order) {
      if (!items[id]) continue;
      items[id].onPath = subtreeKeepsGoalPath(id, items);
    }
    return { root: rootId, items };
  }

  private async findContentRootForItem(
    itemId: NodeId,
  ): Promise<{ rootId: NodeId; order: NodeId[]; items: Record<string, ContentFields> } | undefined> {
    // Try itemId as a root directly first — the common case (root-level
    // lookups, e.g. the initial plan load) resolves with a single direct
    // read instead of scanning every root.
    const direct = await this.readContent(itemId);
    if (direct) return { rootId: itemId, ...direct };

    const roots = await this.listRoots();
    const found = await Promise.all(
      roots.map(async (rootId) => ({ rootId, content: await this.readContent(rootId) })),
    );
    for (const { rootId, content } of found) {
      if (content?.items[itemId] !== undefined) {
        return { rootId, ...content };
      }
    }
    return undefined;
  }

  private async readRootOrder(): Promise<NodeId[]> {
    const result = await this.planDir.child('_root-order.json');
    if (!result.found || result.node.kind !== 'file') return [];
    return JSON.parse(await result.node.read()) as NodeId[];
  }

  private async writeRootOrder(order: NodeId[]): Promise<void> {
    const content = JSON.stringify(order, null, 2);
    const result = await this.planDir.child('_root-order.json');
    if (result.found && result.node.kind === 'file') {
      await result.node.write(content);
    } else {
      await this.planDir.createFile('_root-order.json', content);
    }
  }

  private async deleteRootDir(rootId: NodeId): Promise<void> {
    const planDir = this.planDir;
    if (planDir.kind === 'worktree') {
      await planDir.deleteChild(rootId, true);
    } else {
      const result = await planDir.child(rootId);
      if (result.found && result.node.kind === 'directory') {
        await result.node.delete(true);
      }
    }
  }

  private collectIds(items: Record<string, { children: NodeId[] }>, id: NodeId): NodeId[] {
    const result: NodeId[] = [id];
    const item = items[id];
    if (item) {
      for (const childId of item.children) {
        result.push(...this.collectIds(items, childId));
      }
    }
    return result;
  }

  // ---- IPlanStore ----

  async listRoots(): Promise<NodeId[]> {
    const planDir = this.planDir;
    const dirs =
      planDir.kind === 'worktree'
        ? (await planDir.children()).filter((c): c is Worktree => c.kind === 'worktree')
        : (await planDir.children()).filter((c): c is Directory => c.kind === 'directory');

    // A "root" is a directory with a content.toml. A directory that only has
    // a leftover claims.toml (e.g. the root itself was deleted, but a claim
    // in its subtree is still dangling, pending sweep) is not a real root.
    // Uses children() rather than child('content.toml') deliberately: the
    // in-memory file-store's child() can report a just-deleted file as still
    // found (it also consults git's committed-tree view, which children()
    // does not) — children() is the one that correctly reflects a deletion.
    const dirChildrenLists = await Promise.all(dirs.map((dir) => dir.children()));
    const all: NodeId[] = [];
    dirs.forEach((dir, i) => {
      if (dirChildrenLists[i].some((c) => c.kind === 'file' && c.name === 'content.toml')) all.push(asNodeId(dir.name));
    });

    const order = await this.readRootOrder();
    if (order.length === 0) return all;
    const ordered = order.filter((id) => all.includes(id));
    const remaining = all.filter((id) => !order.includes(id));
    return [...ordered, ...remaining];
  }

  async setRootOrder(orderedRootIds: NodeId[]): Promise<void> {
    await this.writeRootOrder(orderedRootIds);
  }

  async createRoot(title: string): Promise<PlanItem> {
    const id = generateId();
    const contentFields: ContentFields = {
      title,
      type: 'task',
      parent: null,
      children: [],
      requires: [],
      criteria: [],
      approved: false,
      questions: [],
    };

    const planDir = this.planDir;
    const rootDir = await planDir.createDirectory(id);

    await this.writeContent(rootDir, [id], { [id]: contentFields });
    await rootDir.createFile(`${id}.md`, '');
    await rootDir.createFile(`${id}.context.md`, '');

    return this.itemFromContent(id, contentFields);
  }

  private itemFromContent(id: NodeId, c: ContentFields, claim?: ClaimFields): PlanItem {
    return {
      id: asNodeId(id),
      title: c.title,
      type: c.type,
      parent: c.parent,
      children: c.children,
      requires: c.requires,
      exploring: c.exploring,
      criteria: c.criteria,
      approved: c.approved,
      questions: c.questions,
      ready: c.ready,
      places: c.places,
      claimedBy: claim?.claimedBy,
      demoLink: claim?.demoLink,
      started: claim?.claimedBy !== undefined,
      onPath: Boolean(claim?.claimedBy) || Boolean(claim?.demoLink),
    };
  }

  async getItem(id: NodeId): Promise<PlanItem | undefined> {
    const found = await this.findContentRootForItem(id);
    if (!found) return undefined;
    const claims = await this.readClaims(found.rootId);
    const subtree = this.join(found.rootId, found.order, found.items, claims);
    return subtree.items[id];
  }

  async getSubtree(rootId: NodeId): Promise<SubtreeIndex | undefined> {
    const content = await this.readContent(rootId);
    if (!content) return undefined;
    const claims = await this.readClaims(rootId);
    return this.join(rootId, content.order, content.items, claims);
  }

  async addChild(
    parentId: NodeId,
    title: string,
    type: ItemType = 'task',
  ): Promise<PlanItem> {
    const found = await this.findContentRootForItem(parentId);
    if (!found) throw new Error(`Parent item not found: ${parentId}`);

    const { rootId, order, items } = found;
    const id = generateId();
    const contentFields: ContentFields = {
      title,
      type,
      parent: asNodeId(parentId),
      children: [],
      requires: [],
      criteria: [],
      approved: false,
      questions: [],
    };
    items[id] = contentFields;
    items[parentId].children = [...items[parentId].children, id];
    order.push(id);

    const rootDir = await this.getRootDir(rootId);
    if (!rootDir) throw new Error(`Root directory not found: ${rootId}`);

    await this.writeContent(rootDir, order, items);
    await rootDir.createFile(`${id}.md`, '');
    await rootDir.createFile(`${id}.context.md`, '');

    return this.itemFromContent(id, contentFields);
  }

  async deleteItem(id: NodeId): Promise<void> {
    const found = await this.findContentRootForItem(id);
    if (!found) return;

    const { rootId, order, items } = found;
    const item = items[id];
    if (!item) return;

    if (item.parent !== null) {
      const parent = items[item.parent];
      if (parent) {
        parent.children = parent.children.filter((c) => c !== id);
      }
    }

    const toDeleteSet = new Set(this.collectIds(items, id));

    for (const [itemId, it] of Object.entries(items)) {
      if (!toDeleteSet.has(asNodeId(itemId))) {
        it.requires = it.requires.filter((r) => !toDeleteSet.has(r));
      }
    }

    const rootDir = await this.getRootDir(rootId);
    if (!rootDir) return;

    for (const itemId of toDeleteSet) {
      const fileResult = await rootDir.child(`${itemId}.md`);
      if (fileResult.found && fileResult.node.kind === 'file') {
        await fileResult.node.delete();
      }
      const contextResult = await rootDir.child(`${itemId}.context.md`);
      if (contextResult.found && contextResult.node.kind === 'file') {
        await contextResult.node.delete();
      }
    }
    for (const itemId of toDeleteSet) {
      delete items[itemId];
    }

    if (id === rootId) {
      // Deleting the root itself: content.toml goes away entirely (that's
      // what makes listRoots() stop reporting this as a root), but the
      // directory and claims.toml are deliberately left in place — any live
      // claim in this subtree becomes a dangling entry, cleaned up by the
      // next pruneDanglingClaims sweep, exactly like a non-root deletion.
      // Destroying claims.toml outright here would silently drop claim
      // records instead of letting the same sweep/dangling machinery handle
      // them uniformly.
      await this.deleteContentFile(rootDir, 'content.toml');
    } else {
      const newOrder = order.filter((oid) => !toDeleteSet.has(oid));
      await this.writeContent(rootDir, newOrder, items);
      // claims.toml is intentionally left untouched here too — see above.
    }
  }

  private async readContentFile(
    rootDir: Worktree | Directory,
    name: string,
  ): Promise<string> {
    const result = await rootDir.child(name);
    if (result.found && result.node.kind === 'file') return result.node.read();
    return '';
  }

  private async deleteContentFile(
    rootDir: Worktree | Directory,
    name: string,
  ): Promise<void> {
    const result = await rootDir.child(name);
    if (result.found && result.node.kind === 'file') await result.node.delete();
  }

  async moveItem(itemId: NodeId, newParentId: NodeId | null): Promise<void> {
    const source = await this.findContentRootForItem(itemId);
    if (!source) throw new Error(`Item not found: ${itemId}`);
    const { rootId: sourceRootId, order: sourceOrder, items: sourceItems } = source;
    const item = sourceItems[itemId];

    if (item.parent === (newParentId ?? null)) return;

    if (newParentId !== null && newParentId === itemId) {
      throw new Error('Cannot move an item under itself');
    }

    const movingIds = this.collectIds(sourceItems, itemId);
    if (newParentId !== null && movingIds.includes(newParentId)) {
      throw new Error('Cannot move an item under one of its own descendants');
    }

    let target: { rootId: NodeId; order: NodeId[]; items: Record<string, ContentFields> } | undefined;
    if (newParentId !== null) {
      target = await this.findContentRootForItem(newParentId);
      if (!target) throw new Error(`New parent not found: ${newParentId}`);
    }

    const sourceRootDir = await this.getRootDir(sourceRootId);
    if (!sourceRootDir) throw new Error(`Root directory not found: ${sourceRootId}`);

    if (item.parent !== null) {
      const oldParent = sourceItems[item.parent];
      if (oldParent) {
        oldParent.children = oldParent.children.filter((c) => c !== itemId);
      }
    }

    // Same-root reparent: only content changes; content files (and any
    // claims — same root either way) stay put.
    if (newParentId !== null && target && target.rootId === sourceRootId) {
      item.parent = asNodeId(newParentId);
      sourceItems[newParentId].children = [...sourceItems[newParentId].children, asNodeId(itemId)];
      await this.writeContent(sourceRootDir, sourceOrder, sourceItems);
      return;
    }

    // Cross-root move or promotion: snapshot markdown content before relocating files.
    // Note: a live claims.toml entry for a moved id is NOT carried across —
    // it stays keyed under the old root and becomes dangling there, cleaned
    // up by the next sweep. Moving a currently-claimed node is expected to
    // be rare enough that this is an acceptable gap rather than something
    // worth complicating the move path for.
    const mdContents = new Map<NodeId, { details: string; context: string }>();
    for (const id of movingIds) {
      mdContents.set(id, {
        details: await this.readContentFile(sourceRootDir, `${id}.md`),
        context: await this.readContentFile(sourceRootDir, `${id}.context.md`),
      });
    }
    const movedItems: Record<string, ContentFields> = {};
    for (const id of movingIds) movedItems[id] = sourceItems[id];

    if (newParentId === null) {
      movedItems[itemId].parent = null;
      const planDir = this.planDir;
      const newRootDir = await planDir.createDirectory(itemId);
      await this.writeContent(newRootDir, movingIds, movedItems);
      for (const id of movingIds) {
        const c = mdContents.get(id);
        await newRootDir.createFile(`${id}.md`, c?.details ?? '');
        await newRootDir.createFile(`${id}.context.md`, c?.context ?? '');
      }
    } else if (target) {
      movedItems[itemId].parent = asNodeId(newParentId);
      const targetRootDir = await this.getRootDir(target.rootId);
      if (!targetRootDir) throw new Error(`Root directory not found: ${target.rootId}`);
      for (const id of movingIds) target.items[id] = movedItems[id];
      target.items[newParentId].children = [...target.items[newParentId].children, asNodeId(itemId)];
      const targetOrder = target.order;
      const newOrder = [...targetOrder, ...movingIds.filter((id) => !targetOrder.includes(id))];
      await this.writeContent(targetRootDir, newOrder, target.items);
      for (const id of movingIds) {
        const c = mdContents.get(id);
        await targetRootDir.createFile(`${id}.md`, c?.details ?? '');
        await targetRootDir.createFile(`${id}.context.md`, c?.context ?? '');
      }
    }

    if (itemId === sourceRootId) {
      await this.deleteRootDir(sourceRootId);
      const order = await this.readRootOrder();
      if (order.includes(sourceRootId)) {
        await this.writeRootOrder(order.filter((r) => r !== sourceRootId));
      }
    } else {
      for (const id of movingIds) {
        await this.deleteContentFile(sourceRootDir, `${id}.md`);
        await this.deleteContentFile(sourceRootDir, `${id}.context.md`);
        delete sourceItems[id];
      }
      const newOrder = sourceOrder.filter((id) => !movingIds.includes(id));
      await this.writeContent(sourceRootDir, newOrder, sourceItems);
    }
  }

  async addRequires(itemId: NodeId, dependsOnId: NodeId): Promise<void> {
    const found = await this.findContentRootForItem(itemId);
    if (!found) throw new Error(`Item not found: ${itemId}`);

    const { rootId, order, items } = found;
    const item = items[itemId];
    if (!item.requires.includes(asNodeId(dependsOnId))) {
      item.requires = [...item.requires, asNodeId(dependsOnId)];
    }

    const rootDir = await this.getRootDir(rootId);
    if (!rootDir) throw new Error(`Root directory not found: ${rootId}`);
    await this.writeContent(rootDir, order, items);
  }

  async removeRequires(itemId: NodeId, dependsOnId: NodeId): Promise<void> {
    const found = await this.findContentRootForItem(itemId);
    if (!found) throw new Error(`Item not found: ${itemId}`);

    const { rootId, order, items } = found;
    items[itemId].requires = items[itemId].requires.filter((r) => r !== dependsOnId);

    const rootDir = await this.getRootDir(rootId);
    if (!rootDir) throw new Error(`Root directory not found: ${rootId}`);
    await this.writeContent(rootDir, order, items);
  }

  async setRequires(itemId: NodeId, requires: NodeId[]): Promise<void> {
    const found = await this.findContentRootForItem(itemId);
    if (!found) throw new Error(`Item not found: ${itemId}`);

    const { rootId, order, items } = found;
    items[itemId].requires = requires.map(asNodeId);

    const rootDir = await this.getRootDir(rootId);
    if (!rootDir) throw new Error(`Root directory not found: ${rootId}`);
    await this.writeContent(rootDir, order, items);
  }

  async cleanupRequiresReferences(deletedId: NodeId): Promise<void> {
    const roots = await this.listRoots();
    for (const rootId of roots) {
      const rootDir = await this.getRootDir(rootId);
      if (!rootDir) continue;
      const content = await this.readContent(rootId);
      if (!content) continue;
      let modified = false;
      for (const item of Object.values(content.items)) {
        if (item.requires.includes(asNodeId(deletedId))) {
          item.requires = item.requires.filter((r) => r !== deletedId);
          modified = true;
        }
      }
      if (modified) {
        await this.writeContent(rootDir, content.order, content.items);
      }
    }
  }

  async setTitle(itemId: NodeId, title: string): Promise<void> {
    const found = await this.findContentRootForItem(itemId);
    if (!found) throw new Error(`Item not found: ${itemId}`);

    const { rootId, order, items } = found;
    items[itemId].title = title;

    const rootDir = await this.getRootDir(rootId);
    if (!rootDir) throw new Error(`Root directory not found: ${rootId}`);
    await this.writeContent(rootDir, order, items);
  }

  async setType(itemId: NodeId, type: ItemType): Promise<void> {
    const found = await this.findContentRootForItem(itemId);
    if (!found) throw new Error(`Item not found: ${itemId}`);

    const { rootId, order, items } = found;
    items[itemId].type = type;

    const rootDir = await this.getRootDir(rootId);
    if (!rootDir) throw new Error(`Root directory not found: ${rootId}`);
    await this.writeContent(rootDir, order, items);
  }

  async getDetails(itemId: NodeId): Promise<string> {
    const found = await this.findContentRootForItem(itemId);
    if (!found) return '';

    const rootDir = await this.getRootDir(found.rootId);
    if (!rootDir) return '';

    const result = await rootDir.child(`${itemId}.md`);
    if (!result.found || result.node.kind !== 'file') return '';
    return result.node.read();
  }

  async setDetails(itemId: NodeId, details: string): Promise<void> {
    const found = await this.findContentRootForItem(itemId);
    if (!found) throw new Error(`Item not found: ${itemId}`);

    const rootDir = await this.getRootDir(found.rootId);
    if (!rootDir) throw new Error(`Root directory not found: ${found.rootId}`);

    await this.writeTextFile(rootDir, `${itemId}.md`, details);
  }

  async getParentContext(itemId: NodeId): Promise<string> {
    const found = await this.findContentRootForItem(itemId);
    if (!found) return '';

    const rootDir = await this.getRootDir(found.rootId);
    if (!rootDir) return '';

    const result = await rootDir.child(`${itemId}.context.md`);
    if (!result.found || result.node.kind !== 'file') return '';
    return result.node.read();
  }

  async setParentContext(itemId: NodeId, content: string): Promise<void> {
    const found = await this.findContentRootForItem(itemId);
    if (!found) throw new Error(`Item not found: ${itemId}`);

    const rootDir = await this.getRootDir(found.rootId);
    if (!rootDir) throw new Error(`Root directory not found: ${found.rootId}`);

    await this.writeTextFile(rootDir, `${itemId}.context.md`, content);
  }

  async setCriteria(itemId: NodeId, criteria: string[]): Promise<void> {
    const found = await this.findContentRootForItem(itemId);
    if (!found) throw new Error(`Item not found: ${itemId}`);

    const { rootId, order, items } = found;
    items[itemId].criteria = [...criteria];

    const rootDir = await this.getRootDir(rootId);
    if (!rootDir) throw new Error(`Root directory not found: ${rootId}`);
    await this.writeContent(rootDir, order, items);
  }

  async setExploring(
    forkId: NodeId,
    exploring: Record<string, string>,
  ): Promise<void> {
    const found = await this.findContentRootForItem(forkId);
    if (!found) throw new Error(`Item not found: ${forkId}`);

    const { rootId, order, items } = found;
    items[forkId].exploring = { ...exploring };

    const rootDir = await this.getRootDir(rootId);
    if (!rootDir) throw new Error(`Root directory not found: ${rootId}`);
    await this.writeContent(rootDir, order, items);
  }

  async clearExploring(forkId: NodeId): Promise<void> {
    const found = await this.findContentRootForItem(forkId);
    if (!found) throw new Error(`Item not found: ${forkId}`);

    const { rootId, order, items } = found;
    delete items[forkId].exploring;

    const rootDir = await this.getRootDir(rootId);
    if (!rootDir) throw new Error(`Root directory not found: ${rootId}`);
    await this.writeContent(rootDir, order, items);
  }

  async addQuestion(itemId: NodeId, questionId: string): Promise<void> {
    const found = await this.findContentRootForItem(itemId);
    if (!found) throw new Error(`Item not found: ${itemId}`);

    const { rootId, order, items } = found;
    const item = items[itemId];
    if (!item.questions.includes(questionId)) {
      item.questions = [...item.questions, questionId];
    }

    const rootDir = await this.getRootDir(rootId);
    if (!rootDir) throw new Error(`Root directory not found: ${rootId}`);
    await this.writeContent(rootDir, order, items);
  }

  async removeQuestion(itemId: NodeId, questionId: string): Promise<void> {
    const found = await this.findContentRootForItem(itemId);
    if (!found) throw new Error(`Item not found: ${itemId}`);

    const { rootId, order, items } = found;
    const item = items[itemId];
    item.questions = item.questions.filter((q) => q !== questionId);

    const rootDir = await this.getRootDir(rootId);
    if (!rootDir) throw new Error(`Root directory not found: ${rootId}`);
    await this.writeContent(rootDir, order, items);
  }

  async setApproved(itemId: NodeId, approved: false | true | 'tentative'): Promise<void> {
    const found = await this.findContentRootForItem(itemId);
    if (!found) throw new Error(`Item not found: ${itemId}`);

    const { rootId, order, items } = found;
    const toUpdate = this.collectIds(items, itemId);
    for (const id of toUpdate) {
      items[id].approved = approved;
      if (approved === false) {
        items[id].ready = false;
      }
    }

    const rootDir = await this.getRootDir(rootId);
    if (!rootDir) throw new Error(`Root directory not found: ${rootId}`);
    await this.writeContent(rootDir, order, items);
  }

  async setReady(itemId: NodeId, ready: boolean): Promise<void> {
    const found = await this.findContentRootForItem(itemId);
    if (!found) throw new Error(`Item not found: ${itemId}`);

    const { rootId, order, items } = found;
    items[itemId].ready = ready;

    const rootDir = await this.getRootDir(rootId);
    if (!rootDir) throw new Error(`Root directory not found: ${rootId}`);
    await this.writeContent(rootDir, order, items);
  }

  async setPlaces(
    itemId: NodeId,
    places: Record<string, NodePlacement> | undefined,
  ): Promise<void> {
    const found = await this.findContentRootForItem(itemId);
    if (!found) throw new Error(`Item not found: ${itemId}`);

    const { rootId, order, items } = found;
    items[itemId].places = places;

    const rootDir = await this.getRootDir(rootId);
    if (!rootDir) throw new Error(`Root directory not found: ${rootId}`);
    await this.writeContent(rootDir, order, items);
  }

  // ---- claims.toml (lair-owned; see class doc comment) ----

  async setClaimedBy(
    itemId: NodeId,
    claimedBy: { wing: string; branch: string } | undefined,
    rootIdHint?: NodeId,
  ): Promise<void> {
    const rootId = await this.resolveClaimRoot(itemId, rootIdHint);
    if (!rootId) throw new Error(`No root to attach a claim for unknown item: ${itemId}`);
    const rootDir = await this.getRootDir(rootId);
    if (!rootDir) throw new Error(`Root directory not found: ${rootId}`);
    const claims = await this.readClaims(rootId);
    if (claimedBy === undefined) {
      if (claims[itemId]) delete claims[itemId].claimedBy;
    } else {
      claims[itemId] = { ...claims[itemId], claimedBy };
    }
    await this.writeClaims(rootDir, claims);
  }

  async setDemoLink(itemId: NodeId, demoLink: string | undefined, rootIdHint?: NodeId): Promise<void> {
    const rootId = await this.resolveClaimRoot(itemId, rootIdHint);
    if (!rootId) throw new Error(`No root to attach a demo link for unknown item: ${itemId}`);
    const rootDir = await this.getRootDir(rootId);
    if (!rootDir) throw new Error(`Root directory not found: ${rootId}`);
    const claims = await this.readClaims(rootId);
    if (demoLink === undefined) {
      if (claims[itemId]) delete claims[itemId].demoLink;
    } else {
      claims[itemId] = { ...claims[itemId], demoLink };
    }
    await this.writeClaims(rootDir, claims);
  }

  /**
   * Deliberately does NOT require the id to be present in *this* store's
   * own content.toml — a dangling claim (pending-merge or already-stale) is
   * valid by design here; existence validation happens against whichever
   * content view is appropriate before calling this (see
   * PlanActionGroup.ts's claim-node, which validates against the calling
   * wing's own content when the node may not be merged to the lair mirror
   * yet). Resolution order: (1) this store's own content, if it has the id;
   * (2) `rootIdHint`, when the caller already knows the root from a
   * different content view (only used if that root directory actually
   * exists here — a wing-created id whose *root* also hasn't merged yet has
   * no directory to claim into, and is out of scope for this store); (3)
   * an existing claims.toml entry for the id, if one is already there (e.g.
   * mark-demo following an earlier claim-node call).
   */
  private async resolveClaimRoot(itemId: NodeId, rootIdHint?: NodeId): Promise<NodeId | undefined> {
    const found = await this.findContentRootForItem(itemId);
    if (found) return found.rootId;
    if (rootIdHint && (await this.getRootDir(rootIdHint))) return rootIdHint;
    const roots = await this.allDirIds();
    for (const rootId of roots) {
      const claims = await this.readClaims(rootId);
      if (claims[itemId]) return rootId;
    }
    return undefined;
  }

  /**
   * Every subdirectory of planDir, regardless of whether it has a
   * content.toml — unlike listRoots(), which only reports "real" roots.
   * Needed by pruneDanglingClaims: a directory whose root item was itself
   * deleted (content.toml removed, claims.toml deliberately left behind —
   * see deleteItem) is invisible to listRoots() but must still be swept.
   */
  private async allDirIds(): Promise<NodeId[]> {
    const planDir = this.planDir;
    const dirs =
      planDir.kind === 'worktree'
        ? (await planDir.children()).filter((c): c is Worktree => c.kind === 'worktree')
        : (await planDir.children()).filter((c): c is Directory => c.kind === 'directory');
    return dirs.map((d) => asNodeId(d.name));
  }

  async pruneDanglingClaims(
    keepIfDangling: (itemId: NodeId, claimedBy: { wing: string; branch: string }) => Promise<boolean>,
  ): Promise<{ prunedIds: NodeId[] }> {
    const prunedIds: NodeId[] = [];
    const dirIds = await this.allDirIds();
    for (const rootId of dirIds) {
      const rootDir = await this.getRootDir(rootId);
      if (!rootDir) continue;
      const content = (await this.readContent(rootId)) ?? { order: [], items: {} };
      const claims = await this.readClaims(rootId);
      if (Object.keys(claims).length === 0) continue;

      let changed = false;
      for (const id of Object.keys(claims)) {
        if (content.items[id]) continue;
        const entry = claims[id];
        if (entry.claimedBy) {
          const keep = await keepIfDangling(asNodeId(id), entry.claimedBy);
          if (keep) continue;
        }
        delete claims[id];
        prunedIds.push(asNodeId(id));
        changed = true;
      }
      if (changed) await this.writeClaims(rootDir, claims);
    }
    return { prunedIds };
  }
}
