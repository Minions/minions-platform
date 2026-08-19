import type { IPlanStore } from './IPlanStore.js';
import { asNodeId } from './nodeId.js';
import type { describe as vitestDescribe, it as vitestIt, expect as vitestExpect, beforeEach as vitestBeforeEach } from 'vitest';

/** Shape of the vitest globals this suite depends on, typed without a runtime import. */
interface TestGlobals {
  describe: typeof vitestDescribe;
  it: typeof vitestIt;
  expect: typeof vitestExpect;
  beforeEach: typeof vitestBeforeEach;
}

/**
 * Contract tests for IPlanStore implementations.
 *
 * Both InMemoryPlanStore and WorktreePlanStore must pass all these tests.
 * Uses globalThis to access vitest globals so this module is safe to import
 * in production bundles without pulling in the test framework.
 */
export function runPlanStoreContractTests(
  name: string,
  createStore: () => Promise<IPlanStore>,
): void {
  const g = globalThis as unknown as TestGlobals;
  const describe = g.describe;
  const it = g.it;
  const expect = g.expect;
  const beforeEach = g.beforeEach;

  describe(`${name} IPlanStore contract`, () => {
    let store: IPlanStore;

    beforeEach(async () => {
      store = await createStore();
    });

    describe('listRoots / createRoot', () => {
      it('starts with no roots', async () => {
        expect(await store.listRoots()).toEqual([]);
      });

      it('createRoot returns a valid PlanItem', async () => {
        const item = await store.createRoot('My Task');
        expect(item.id).toBeTruthy();
        expect(item.title).toBe('My Task');
        expect(item.type).toBe('task');
        expect(item.parent).toBeNull();
        expect(item.children).toEqual([]);
        expect(item.requires).toEqual([]);
      });

      it('createRoot adds to listRoots', async () => {
        const item = await store.createRoot('Task A');
        expect(await store.listRoots()).toContain(item.id);
      });

      it('multiple roots are independent', async () => {
        const a = await store.createRoot('A');
        const b = await store.createRoot('B');
        const roots = await store.listRoots();
        expect(roots).toContain(a.id);
        expect(roots).toContain(b.id);
        expect(roots.length).toBe(2);
      });
    });

    describe('getItem', () => {
      it('returns undefined for unknown ID', async () => {
        expect(await store.getItem(asNodeId('nonexistent'))).toBeUndefined();
      });

      it('finds a root item by ID', async () => {
        const item = await store.createRoot('Task');
        const found = await store.getItem(item.id);
        expect(found?.id).toBe(item.id);
        expect(found?.title).toBe('Task');
      });

      it('finds a child item by ID', async () => {
        const root = await store.createRoot('Root');
        const child = await store.addChild(root.id, 'Child');
        const found = await store.getItem(child.id);
        expect(found?.id).toBe(child.id);
        expect(found?.title).toBe('Child');
      });
    });

    describe('getSubtree', () => {
      it('returns undefined for unknown root', async () => {
        expect(await store.getSubtree(asNodeId('nonexistent'))).toBeUndefined();
      });

      it('returns a subtree containing the root item', async () => {
        const root = await store.createRoot('Root');
        const subtree = await store.getSubtree(root.id);
        expect(subtree?.root).toBe(root.id);
        expect(subtree?.items[root.id]).toBeDefined();
      });
    });

    describe('addChild', () => {
      it('creates a child with default type task', async () => {
        const root = await store.createRoot('Root');
        const child = await store.addChild(root.id, 'Child');
        expect(child.type).toBe('task');
        expect(child.parent).toBe(root.id);
        expect(child.children).toEqual([]);
        expect(child.requires).toEqual([]);
      });

      it('child appears in parent children list', async () => {
        const root = await store.createRoot('Root');
        const child = await store.addChild(root.id, 'Child');
        const parent = await store.getItem(root.id);
        expect(parent?.children).toContain(child.id);
      });

      it('creates a child with explicit type', async () => {
        const root = await store.createRoot('Root');
        const fork = await store.addChild(root.id, 'Choose approach', 'fork');
        expect(fork.type).toBe('fork');
      });

      it('can nest children multiple levels deep', async () => {
        const root = await store.createRoot('Root');
        const child = await store.addChild(root.id, 'Child');
        const grandchild = await store.addChild(child.id, 'Grandchild');
        expect(grandchild.parent).toBe(child.id);
        const subtree = await store.getSubtree(root.id);
        expect(subtree?.items[grandchild.id]).toBeDefined();
      });

      it('throws for unknown parent', async () => {
        await expect(store.addChild(asNodeId('nonexistent'), 'Child')).rejects.toThrow();
      });
    });

    describe('deleteItem', () => {
      it('removes a root item and it disappears from listRoots', async () => {
        const root = await store.createRoot('Root');
        await store.deleteItem(root.id);
        expect(await store.getItem(root.id)).toBeUndefined();
        expect(await store.listRoots()).not.toContain(root.id);
      });

      it('removes child from parent children list', async () => {
        const root = await store.createRoot('Root');
        const child = await store.addChild(root.id, 'Child');
        await store.deleteItem(child.id);
        const parent = await store.getItem(root.id);
        expect(parent?.children).not.toContain(child.id);
      });

      it('recursively deletes all descendants', async () => {
        const root = await store.createRoot('Root');
        const child = await store.addChild(root.id, 'Child');
        const grandchild = await store.addChild(child.id, 'Grandchild');
        await store.deleteItem(child.id);
        expect(await store.getItem(grandchild.id)).toBeUndefined();
        expect(await store.getItem(child.id)).toBeUndefined();
        expect(await store.getItem(root.id)).toBeDefined();
      });

      it('is idempotent for unknown IDs', async () => {
        await expect(store.deleteItem(asNodeId('nonexistent'))).resolves.toBeUndefined();
      });

      it('removes deleted item from requires lists of surviving items', async () => {
        const root = await store.createRoot('Root');
        const a = await store.addChild(root.id, 'A');
        const b = await store.addChild(root.id, 'B');
        const c = await store.addChild(root.id, 'C');
        await store.addRequires(b.id, a.id);
        await store.addRequires(c.id, a.id);
        await store.deleteItem(a.id);
        const bItem = await store.getItem(b.id);
        const cItem = await store.getItem(c.id);
        expect(bItem?.requires).not.toContain(a.id);
        expect(cItem?.requires).not.toContain(a.id);
      });
    });

    describe('setTitle', () => {
      it('changes the title, retrievable via getItem', async () => {
        const root = await store.createRoot('Old');
        await store.setTitle(root.id, 'New');
        const item = await store.getItem(root.id);
        expect(item?.title).toBe('New');
      });

      it('throws for unknown item', async () => {
        await expect(store.setTitle(asNodeId('nonexistent'), 'x')).rejects.toThrow();
      });
    });

    describe('setType', () => {
      it('changes the type, retrievable via getItem', async () => {
        const root = await store.createRoot('Root');
        const child = await store.addChild(root.id, 'Child');
        expect(child.type).toBe('task');
        await store.setType(child.id, 'fork');
        const item = await store.getItem(child.id);
        expect(item?.type).toBe('fork');
      });

      it('throws for unknown item', async () => {
        await expect(store.setType(asNodeId('nonexistent'), 'fork')).rejects.toThrow();
      });
    });

    describe('moveItem', () => {
      it('reparents within the same root', async () => {
        const root = await store.createRoot('Root');
        const a = await store.addChild(root.id, 'A');
        const b = await store.addChild(root.id, 'B');
        const child = await store.addChild(a.id, 'Child');
        await store.moveItem(child.id, b.id);
        const moved = await store.getItem(child.id);
        expect(moved?.parent).toBe(b.id);
        const aItem = await store.getItem(a.id);
        const bItem = await store.getItem(b.id);
        expect(aItem?.children).not.toContain(child.id);
        expect(bItem?.children).toContain(child.id);
      });

      it('moves a subtree with its descendants within the same root', async () => {
        const root = await store.createRoot('Root');
        const a = await store.addChild(root.id, 'A');
        const b = await store.addChild(root.id, 'B');
        const child = await store.addChild(a.id, 'Child');
        const grandchild = await store.addChild(child.id, 'Grandchild');
        await store.moveItem(child.id, b.id);
        const gc = await store.getItem(grandchild.id);
        expect(gc?.parent).toBe(child.id);
        const subtree = await store.getSubtree(root.id);
        expect(subtree?.items[grandchild.id]).toBeDefined();
      });

      it('moves a subtree across roots, preserving content', async () => {
        const rootA = await store.createRoot('Root A');
        const rootB = await store.createRoot('Root B');
        const a = await store.addChild(rootA.id, 'A');
        const child = await store.addChild(a.id, 'Child');
        await store.setDetails(child.id, 'child details');
        await store.setParentContext(child.id, 'child context');
        await store.moveItem(a.id, rootB.id);
        // Now under rootB
        const subtreeB = await store.getSubtree(rootB.id);
        expect(subtreeB?.items[a.id]).toBeDefined();
        expect(subtreeB?.items[child.id]).toBeDefined();
        expect((await store.getItem(a.id))?.parent).toBe(rootB.id);
        // Gone from rootA
        const subtreeA = await store.getSubtree(rootA.id);
        expect(subtreeA?.items[a.id]).toBeUndefined();
        expect(subtreeA?.items[child.id]).toBeUndefined();
        // Content survived the move
        expect(await store.getDetails(child.id)).toBe('child details');
        expect(await store.getParentContext(child.id)).toBe('child context');
      });

      it('promotes an item to a new top-level root when newParentId is null', async () => {
        const root = await store.createRoot('Root');
        const a = await store.addChild(root.id, 'A');
        const child = await store.addChild(a.id, 'Child');
        await store.moveItem(a.id, null);
        expect(await store.listRoots()).toContain(a.id);
        expect((await store.getItem(a.id))?.parent).toBeNull();
        expect((await store.getItem(child.id))?.parent).toBe(a.id);
        const rootItem = await store.getItem(root.id);
        expect(rootItem?.children).not.toContain(a.id);
      });

      it('demotes a root under a parent in another root', async () => {
        const rootA = await store.createRoot('Root A');
        const rootB = await store.createRoot('Root B');
        const target = await store.addChild(rootB.id, 'Target');
        await store.moveItem(rootA.id, target.id);
        expect(await store.listRoots()).not.toContain(rootA.id);
        expect((await store.getItem(rootA.id))?.parent).toBe(target.id);
        const targetItem = await store.getItem(target.id);
        expect(targetItem?.children).toContain(rootA.id);
      });

      it('is a no-op when the item is already at the requested parent', async () => {
        const root = await store.createRoot('Root');
        const child = await store.addChild(root.id, 'Child');
        await store.moveItem(child.id, root.id);
        expect((await store.getItem(child.id))?.parent).toBe(root.id);
        const rootItem = await store.getItem(root.id);
        expect(rootItem?.children.filter((c) => c === child.id).length).toBe(1);
      });

      it('throws when moving an item under itself', async () => {
        const root = await store.createRoot('Root');
        const child = await store.addChild(root.id, 'Child');
        await expect(store.moveItem(child.id, child.id)).rejects.toThrow();
      });

      it('throws when moving an item under one of its own descendants', async () => {
        const root = await store.createRoot('Root');
        const a = await store.addChild(root.id, 'A');
        const child = await store.addChild(a.id, 'Child');
        await expect(store.moveItem(a.id, child.id)).rejects.toThrow();
      });

      it('throws for unknown item', async () => {
        const root = await store.createRoot('Root');
        await expect(store.moveItem(asNodeId('nonexistent'), root.id)).rejects.toThrow();
      });

      it('throws for unknown new parent', async () => {
        const root = await store.createRoot('Root');
        const child = await store.addChild(root.id, 'Child');
        await expect(store.moveItem(child.id, asNodeId('nonexistent'))).rejects.toThrow();
      });
    });

    describe('setRequires', () => {
      it('replaces the entire requires list', async () => {
        const root = await store.createRoot('Root');
        const a = await store.addChild(root.id, 'A');
        const b = await store.addChild(root.id, 'B');
        const c = await store.addChild(root.id, 'C');
        await store.addRequires(c.id, a.id);
        await store.setRequires(c.id, [b.id]);
        const cItem = await store.getItem(c.id);
        expect(cItem?.requires).toEqual([b.id]);
        expect(cItem?.requires).not.toContain(a.id);
      });

      it('can clear requires by passing empty array', async () => {
        const root = await store.createRoot('Root');
        const a = await store.addChild(root.id, 'A');
        const b = await store.addChild(root.id, 'B');
        await store.addRequires(b.id, a.id);
        await store.setRequires(b.id, []);
        const bItem = await store.getItem(b.id);
        expect(bItem?.requires).toEqual([]);
      });

      it('throws for unknown item', async () => {
        await expect(store.setRequires(asNodeId('nonexistent'), [])).rejects.toThrow();
      });
    });

    describe('cleanupRequiresReferences', () => {
      it('removes the ID from requires of items in the same root', async () => {
        const root = await store.createRoot('Root');
        const a = await store.addChild(root.id, 'A');
        const b = await store.addChild(root.id, 'B');
        await store.addRequires(b.id, a.id);
        await store.cleanupRequiresReferences(a.id);
        const bItem = await store.getItem(b.id);
        expect(bItem?.requires).not.toContain(a.id);
      });

      it('removes the ID from requires of items in a different root', async () => {
        const rootA = await store.createRoot('Root A');
        const rootB = await store.createRoot('Root B');
        const a = await store.addChild(rootA.id, 'A');
        const b = await store.addChild(rootB.id, 'B');
        await store.addRequires(b.id, a.id);
        await store.cleanupRequiresReferences(a.id);
        const bItem = await store.getItem(b.id);
        expect(bItem?.requires).not.toContain(a.id);
      });

      it('is idempotent when the ID is not referenced anywhere', async () => {
        await expect(store.cleanupRequiresReferences(asNodeId('nonexistent'))).resolves.toBeUndefined();
      });

      it('only removes the specified ID, leaving other requires intact', async () => {
        const root = await store.createRoot('Root');
        const a = await store.addChild(root.id, 'A');
        const b = await store.addChild(root.id, 'B');
        const c = await store.addChild(root.id, 'C');
        await store.addRequires(c.id, a.id);
        await store.addRequires(c.id, b.id);
        await store.cleanupRequiresReferences(a.id);
        const cItem = await store.getItem(c.id);
        expect(cItem?.requires).not.toContain(a.id);
        expect(cItem?.requires).toContain(b.id);
      });
    });

    describe('addRequires / removeRequires', () => {
      it('adds a dependency between siblings', async () => {
        const root = await store.createRoot('Root');
        const a = await store.addChild(root.id, 'A');
        const b = await store.addChild(root.id, 'B');
        await store.addRequires(b.id, a.id);
        const bItem = await store.getItem(b.id);
        expect(bItem?.requires).toContain(a.id);
      });

      it('is idempotent (no duplicate requires)', async () => {
        const root = await store.createRoot('Root');
        const a = await store.addChild(root.id, 'A');
        const b = await store.addChild(root.id, 'B');
        await store.addRequires(b.id, a.id);
        await store.addRequires(b.id, a.id);
        const bItem = await store.getItem(b.id);
        expect(bItem?.requires.filter((r) => r === a.id).length).toBe(1);
      });

      it('removes a dependency', async () => {
        const root = await store.createRoot('Root');
        const a = await store.addChild(root.id, 'A');
        const b = await store.addChild(root.id, 'B');
        await store.addRequires(b.id, a.id);
        await store.removeRequires(b.id, a.id);
        const bItem = await store.getItem(b.id);
        expect(bItem?.requires).not.toContain(a.id);
      });

      it('throws for unknown item in addRequires', async () => {
        const root = await store.createRoot('Root');
        const a = await store.addChild(root.id, 'A');
        await expect(store.addRequires(asNodeId('nonexistent'), a.id)).rejects.toThrow();
      });

      it('throws for unknown item in removeRequires', async () => {
        await expect(
          store.removeRequires(asNodeId('nonexistent'), asNodeId('anything')),
        ).rejects.toThrow();
      });
    });

    describe('getDetails / setDetails', () => {
      it('returns empty string for a new item', async () => {
        const root = await store.createRoot('Root');
        expect(await store.getDetails(root.id)).toBe('');
      });

      it('stores and retrieves details', async () => {
        const root = await store.createRoot('Root');
        await store.setDetails(root.id, '# Hello\n\nContent here.');
        expect(await store.getDetails(root.id)).toBe('# Hello\n\nContent here.');
      });

      it('updates existing details', async () => {
        const root = await store.createRoot('Root');
        await store.setDetails(root.id, 'first');
        await store.setDetails(root.id, 'second');
        expect(await store.getDetails(root.id)).toBe('second');
      });

      it('throws for unknown item in setDetails', async () => {
        await expect(
          store.setDetails(asNodeId('nonexistent'), 'content'),
        ).rejects.toThrow();
      });
    });

    describe('getParentContext / setParentContext', () => {
      it('returns empty string for a new item', async () => {
        const root = await store.createRoot('Root');
        expect(await store.getParentContext(root.id)).toBe('');
      });

      it('stores and retrieves parent context', async () => {
        const root = await store.createRoot('Root');
        await store.setParentContext(root.id, '# Context\n\nParent info.');
        expect(await store.getParentContext(root.id)).toBe('# Context\n\nParent info.');
      });

      it('updates existing parent context', async () => {
        const root = await store.createRoot('Root');
        await store.setParentContext(root.id, 'first');
        await store.setParentContext(root.id, 'second');
        expect(await store.getParentContext(root.id)).toBe('second');
      });

      it('throws for unknown item in setParentContext', async () => {
        await expect(
          store.setParentContext(asNodeId('nonexistent'), 'content'),
        ).rejects.toThrow();
      });
    });

    describe('setCriteria', () => {
      it('sets criteria on an item, retrievable via getItem', async () => {
        const root = await store.createRoot('Root');
        await store.setCriteria(root.id, ['criterion 1', 'criterion 2']);
        const item = await store.getItem(root.id);
        expect(item?.criteria).toEqual(['criterion 1', 'criterion 2']);
      });

      it('throws for unknown item', async () => {
        await expect(
          store.setCriteria(asNodeId('nonexistent'), ['criterion']),
        ).rejects.toThrow();
      });

      it('can be cleared by passing empty array', async () => {
        const root = await store.createRoot('Root');
        await store.setCriteria(root.id, ['criterion']);
        await store.setCriteria(root.id, []);
        const item = await store.getItem(root.id);
        expect(item?.criteria).toEqual([]);
      });
    });

    describe('setExploring / clearExploring', () => {
      it('sets fork exploration state', async () => {
        const root = await store.createRoot('Root');
        const fork = await store.addChild(root.id, 'Choose', 'fork');
        await store.setExploring(fork.id, {
          opt1: 'branch-a',
          opt2: 'branch-b',
        });
        const item = await store.getItem(fork.id);
        expect(item?.exploring).toEqual({ opt1: 'branch-a', opt2: 'branch-b' });
      });

      it('clears fork exploration state', async () => {
        const root = await store.createRoot('Root');
        const fork = await store.addChild(root.id, 'Choose', 'fork');
        await store.setExploring(fork.id, { opt1: 'branch-a' });
        await store.clearExploring(fork.id);
        const item = await store.getItem(fork.id);
        expect(item?.exploring).toBeUndefined();
      });

      it('throws for unknown item in setExploring', async () => {
        await expect(store.setExploring(asNodeId('nonexistent'), {})).rejects.toThrow();
      });

      it('throws for unknown item in clearExploring', async () => {
        await expect(store.clearExploring(asNodeId('nonexistent'))).rejects.toThrow();
      });
    });

    describe('setRootOrder / listRoots ordering', () => {
      it('listRoots returns all roots when no order is set', async () => {
        const a = await store.createRoot('A');
        const b = await store.createRoot('B');
        const roots = await store.listRoots();
        expect(roots).toContain(a.id);
        expect(roots).toContain(b.id);
      });

      it('listRoots returns roots in priority order after setRootOrder', async () => {
        const a = await store.createRoot('A');
        const b = await store.createRoot('B');
        const c = await store.createRoot('C');
        await store.setRootOrder([c.id, a.id, b.id]);
        const roots = await store.listRoots();
        expect(roots[0]).toBe(c.id);
        expect(roots[1]).toBe(a.id);
        expect(roots[2]).toBe(b.id);
      });

      it('unordered roots are appended after ordered roots', async () => {
        const a = await store.createRoot('A');
        const b = await store.createRoot('B');
        const c = await store.createRoot('C');
        await store.setRootOrder([b.id]);
        const roots = await store.listRoots();
        expect(roots[0]).toBe(b.id);
        expect(roots).toContain(a.id);
        expect(roots).toContain(c.id);
      });

      it('setRootOrder with empty array clears explicit ordering', async () => {
        const a = await store.createRoot('A');
        const b = await store.createRoot('B');
        await store.setRootOrder([b.id, a.id]);
        await store.setRootOrder([]);
        const roots = await store.listRoots();
        expect(roots).toContain(a.id);
        expect(roots).toContain(b.id);
      });
    });

    describe('addQuestion / removeQuestion', () => {
      it('adds a question ID to an item', async () => {
        const root = await store.createRoot('Root');
        await store.addQuestion(root.id, 'q-001');
        const item = await store.getItem(root.id);
        expect(item?.questions).toContain('q-001');
      });

      it('is idempotent (no duplicate question IDs)', async () => {
        const root = await store.createRoot('Root');
        await store.addQuestion(root.id, 'q-001');
        await store.addQuestion(root.id, 'q-001');
        const item = await store.getItem(root.id);
        expect(item?.questions?.filter((q) => q === 'q-001').length).toBe(1);
      });

      it('can add multiple question IDs', async () => {
        const root = await store.createRoot('Root');
        await store.addQuestion(root.id, 'q-001');
        await store.addQuestion(root.id, 'q-002');
        const item = await store.getItem(root.id);
        expect(item?.questions).toContain('q-001');
        expect(item?.questions).toContain('q-002');
      });

      it('removes a question ID from an item', async () => {
        const root = await store.createRoot('Root');
        await store.addQuestion(root.id, 'q-001');
        await store.removeQuestion(root.id, 'q-001');
        const item = await store.getItem(root.id);
        expect(item?.questions ?? []).not.toContain('q-001');
      });

      it('throws for unknown item in addQuestion', async () => {
        await expect(store.addQuestion(asNodeId('nonexistent'), 'q-001')).rejects.toThrow();
      });

      it('throws for unknown item in removeQuestion', async () => {
        await expect(store.removeQuestion(asNodeId('nonexistent'), 'q-001')).rejects.toThrow();
      });
    });

    describe('setApproved', () => {
      it('sets approved to false on a single item', async () => {
        const root = await store.createRoot('Root');
        await store.setApproved(root.id, false);
        const item = await store.getItem(root.id);
        expect(item?.approved).toBe(false);
      });

      it('sets approved to tentative on a single item', async () => {
        const root = await store.createRoot('Root');
        await store.setApproved(root.id, 'tentative');
        const item = await store.getItem(root.id);
        expect(item?.approved).toBe('tentative');
      });

      it('applies approved recursively to all descendants', async () => {
        const root = await store.createRoot('Root');
        const child = await store.addChild(root.id, 'Child');
        const grandchild = await store.addChild(child.id, 'Grandchild');
        await store.setApproved(root.id, false);
        const rootItem = await store.getItem(root.id);
        const childItem = await store.getItem(child.id);
        const grandchildItem = await store.getItem(grandchild.id);
        expect(rootItem?.approved).toBe(false);
        expect(childItem?.approved).toBe(false);
        expect(grandchildItem?.approved).toBe(false);
      });

      it('only updates subtree of the given item, not siblings', async () => {
        const root = await store.createRoot('Root');
        const a = await store.addChild(root.id, 'A');
        const b = await store.addChild(root.id, 'B');
        await store.setApproved(b.id, true);
        await store.setApproved(a.id, false);
        const bItem = await store.getItem(b.id);
        expect(bItem?.approved).toBe(true);
      });

      it('throws for unknown item', async () => {
        await expect(store.setApproved(asNodeId('nonexistent'), false)).rejects.toThrow();
      });
    });

    describe('setReady', () => {
      it('sets ready to true on a single item', async () => {
        const root = await store.createRoot('Root');
        await store.setReady(root.id, true);
        const item = await store.getItem(root.id);
        expect(item?.ready).toBe(true);
      });

      it('clears ready when set to false', async () => {
        const root = await store.createRoot('Root');
        await store.setReady(root.id, true);
        await store.setReady(root.id, false);
        const item = await store.getItem(root.id);
        expect(item?.ready).toBeFalsy();
      });

      it('does not affect siblings or descendants', async () => {
        const root = await store.createRoot('Root');
        const child = await store.addChild(root.id, 'Child');
        await store.setReady(child.id, true);
        const rootItem = await store.getItem(root.id);
        expect(rootItem?.ready).toBeFalsy();
      });

      it('setApproved(false) clears ready on descendants', async () => {
        const root = await store.createRoot('Root');
        const child = await store.addChild(root.id, 'Child');
        await store.setReady(root.id, true);
        await store.setReady(child.id, true);
        await store.setApproved(root.id, false);
        const rootItem = await store.getItem(root.id);
        const childItem = await store.getItem(child.id);
        expect(rootItem?.ready).toBeFalsy();
        expect(childItem?.ready).toBeFalsy();
      });

      it('throws for unknown item', async () => {
        await expect(store.setReady(asNodeId('nonexistent'), true)).rejects.toThrow();
      });
    });

    describe('setDemoLink', () => {
      it('sets a demo link on an item', async () => {
        const root = await store.createRoot('Root');
        await store.setDemoLink(root.id, 'http://example.com/demo');
        const item = await store.getItem(root.id);
        expect(item?.demoLink).toBe('http://example.com/demo');
      });

      it('clears the demo link when passed undefined', async () => {
        const root = await store.createRoot('Root');
        await store.setDemoLink(root.id, 'http://example.com/demo');
        await store.setDemoLink(root.id, undefined);
        const item = await store.getItem(root.id);
        expect(item?.demoLink).toBeUndefined();
      });

      // No "throws when totally unresolvable" case here (unlike setClaimedBy's
      // rootIdHint variant): whether that's even possible is adapter-specific
      // (WorktreePlanStore needs a root directory to write into and can fail
      // to find one; InMemoryPlanStore's claims are a flat map with no root
      // concept, so it never throws) — not part of the shared contract.
    });

    describe('setPlaces', () => {
      it('sets product-space placements on an item', async () => {
        const root = await store.createRoot('Root');
        await store.setPlaces(root.id, {
          'user-flow': { locationIds: ['verify', 'review'], flowIds: ['new-feature'] },
          'data-flow': { locationIds: ['cabinet', 'browser'] },
        });
        const item = await store.getItem(root.id);
        expect(item?.places?.['user-flow']).toEqual({ locationIds: ['verify', 'review'], flowIds: ['new-feature'] });
        expect(item?.places?.['data-flow']).toEqual({ locationIds: ['cabinet', 'browser'] });
      });

      it('clears placements when passed undefined', async () => {
        const root = await store.createRoot('Root');
        await store.setPlaces(root.id, { 'user-flow': { locationIds: ['a'] } });
        await store.setPlaces(root.id, undefined);
        const item = await store.getItem(root.id);
        expect(item?.places).toBeUndefined();
      });

      it('throws for unknown item', async () => {
        await expect(store.setPlaces(asNodeId('nonexistent'), { 'user-flow': { locationIds: [] } })).rejects.toThrow();
      });
    });

    describe('started / onPath (computed, not settable)', () => {
      it('started is true iff claimedBy is set', async () => {
        const root = await store.createRoot('Root');
        expect((await store.getItem(root.id))?.started).toBe(false);
        await store.setClaimedBy(root.id, { wing: 'workshop-01', branch: 'l/x/w/workshop-01' });
        expect((await store.getItem(root.id))?.started).toBe(true);
        await store.setClaimedBy(root.id, undefined);
        expect((await store.getItem(root.id))?.started).toBe(false);
      });

      it('onPath is true for an item or any ancestor of a claimed descendant', async () => {
        const root = await store.createRoot('Root');
        const child = await store.addChild(root.id, 'Child');
        const grandchild = await store.addChild(child.id, 'Grandchild');
        expect((await store.getItem(root.id))?.onPath).toBe(false);
        await store.setClaimedBy(grandchild.id, { wing: 'workshop-01', branch: 'b' });
        expect((await store.getItem(grandchild.id))?.onPath).toBe(true);
        expect((await store.getItem(child.id))?.onPath).toBe(true);
        expect((await store.getItem(root.id))?.onPath).toBe(true);
      });

      it('onPath survives a claim release when the item has a demoLink', async () => {
        const root = await store.createRoot('Root');
        await store.setClaimedBy(root.id, { wing: 'workshop-01', branch: 'b' });
        await store.setDemoLink(root.id, 'http://example.com/demo');
        await store.setClaimedBy(root.id, undefined);
        expect((await store.getItem(root.id))?.onPath).toBe(true);
      });

      it('onPath does not extend to unrelated siblings', async () => {
        const root = await store.createRoot('Root');
        const a = await store.addChild(root.id, 'A');
        const b = await store.addChild(root.id, 'B');
        await store.setClaimedBy(a.id, { wing: 'workshop-01', branch: 'b' });
        expect((await store.getItem(b.id))?.onPath).toBe(false);
      });
    });

    describe('setClaimedBy', () => {
      it('sets claimedBy on an item', async () => {
        const root = await store.createRoot('Root');
        await store.setClaimedBy(root.id, { wing: 'workshop-01', branch: 'l/x/w/workshop-01' });
        const item = await store.getItem(root.id);
        expect(item?.claimedBy).toEqual({ wing: 'workshop-01', branch: 'l/x/w/workshop-01' });
      });

      it('clears claimedBy when set to undefined', async () => {
        const root = await store.createRoot('Root');
        await store.setClaimedBy(root.id, { wing: 'workshop-01', branch: 'l/x/w/workshop-01' });
        await store.setClaimedBy(root.id, undefined);
        const item = await store.getItem(root.id);
        expect(item?.claimedBy).toBeUndefined();
      });

      it('does not affect siblings or descendants', async () => {
        const root = await store.createRoot('Root');
        const child = await store.addChild(root.id, 'Child');
        await store.setClaimedBy(child.id, { wing: 'workshop-01', branch: 'l/x/w/workshop-01' });
        const rootItem = await store.getItem(root.id);
        expect(rootItem?.claimedBy).toBeUndefined();
      });

      it('does NOT throw for an id not yet in this store, given a rootIdHint — the create-then-claim case', async () => {
        const root = await store.createRoot('Root');
        await expect(
          store.setClaimedBy(asNodeId('not-yet-merged'), { wing: 'w', branch: 'b' }, root.id),
        ).resolves.toBeUndefined();
      });

      it('a claim on an id not present in this store\'s content is invisible via getItem (dropped as dangling)', async () => {
        const root = await store.createRoot('Root');
        await store.setClaimedBy(asNodeId('not-yet-merged'), { wing: 'w', branch: 'b' }, root.id);
        expect(await store.getItem(asNodeId('not-yet-merged'))).toBeUndefined();
      });
    });

    describe('pruneDanglingClaims', () => {
      it('does nothing when there are no dangling claims', async () => {
        const root = await store.createRoot('Root');
        await store.setClaimedBy(root.id, { wing: 'w', branch: 'b' });
        const { prunedIds } = await store.pruneDanglingClaims(async () => true);
        expect(prunedIds).toEqual([]);
        expect((await store.getItem(root.id))?.claimedBy).toBeDefined();
      });

      it('drops a dangling claimedBy entry when keepIfDangling says no', async () => {
        const root = await store.createRoot('Root');
        const child = await store.addChild(root.id, 'Child');
        await store.setClaimedBy(child.id, { wing: 'w', branch: 'b' });
        await store.deleteItem(child.id);
        const { prunedIds } = await store.pruneDanglingClaims(async () => false);
        expect(prunedIds).toContain(child.id);
      });

      it('keeps a dangling claimedBy entry when keepIfDangling says yes (pending-merge case)', async () => {
        const root = await store.createRoot('Root');
        const child = await store.addChild(root.id, 'Child');
        await store.setClaimedBy(child.id, { wing: 'w', branch: 'b' });
        await store.deleteItem(child.id);
        const { prunedIds } = await store.pruneDanglingClaims(async () => true);
        expect(prunedIds).not.toContain(child.id);
      });

      it('always drops a dangling demoLink-only entry, without asking keepIfDangling', async () => {
        const root = await store.createRoot('Root');
        const child = await store.addChild(root.id, 'Child');
        await store.setDemoLink(child.id, 'http://example.com/demo');
        await store.deleteItem(child.id);
        let asked = false;
        const { prunedIds } = await store.pruneDanglingClaims(async () => {
          asked = true;
          return true;
        });
        expect(prunedIds).toContain(child.id);
        expect(asked).toBe(false);
      });
    });
  });
}
