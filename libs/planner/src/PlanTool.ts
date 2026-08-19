import { asNodeId } from '@minions/planner-types';
import type { IPlanStore, ItemType, PlanItem, SubtreeIndex } from '@minions/planner-types';

export type PlanAction =
  | 'list-roots'
  | 'get-subtree'
  | 'delete-subtree'
  | 'add-children'
  | 'get-details'
  | 'set-details'
  | 'set-parent-context'
  | 'set-criteria'
  | 'set-demo-link';

type PlanItemView = Omit<PlanItem, 'children' | 'requires'> & {
  children?: string[];
  requires?: string[];
};

interface ItemDetailView {
  id: string;
  title: string;
  type: ItemType;
  criteria?: string[];
  details: string;
  parentContext: string;
}

export interface SubtreeView {
  root: string;
  items: Record<string, PlanItemView>;
}

function filterSubtree(subtree: SubtreeIndex): SubtreeView {
  const items: Record<string, PlanItemView> = {};
  for (const [id, item] of Object.entries(subtree.items)) {
    const view: PlanItemView = {
      id: item.id, title: item.title, type: item.type, parent: item.parent,
      criteria: item.criteria, approved: item.approved, started: item.started,
      onPath: item.onPath, claimedBy: item.claimedBy, questions: item.questions,
    };
    if (item.children.length > 0) view.children = item.children;
    if (item.requires.length > 0) view.requires = item.requires;
    if (item.exploring) view.exploring = item.exploring;
    if (item.demoLink) view.demoLink = item.demoLink;
    items[id] = view;
  }
  return { root: subtree.root, items };
}

export type PlanToolResult =
  | { roots: Array<{ id: string; title: string }> }
  | SubtreeView
  | ItemDetailView
  | null
  | { success: boolean; error?: string };

/**
 * Dispatch a plan tool call to an IPlanStore.
 * Called by the MCP server when it receives a 'plan' tool invocation.
 */
export async function handlePlanTool(
  store: IPlanStore,
  args: Record<string, unknown>,
): Promise<PlanToolResult> {
  const action = args['action'] as string;

  switch (action) {
    case 'list-roots': {
      const rootIds = await store.listRoots();
      const roots = await Promise.all(
        rootIds.map(async (id) => {
          const item = await store.getItem(id);
          return { id, title: item?.title ?? id };
        }),
      );
      return { roots };
    }

    case 'get-subtree': {
      const itemId = asNodeId(args['itemId'] as string);
      if (!itemId) throw new Error('get-subtree requires itemId');
      const subtree = await store.getSubtree(itemId);
      return subtree ? filterSubtree(subtree) : null;
    }

    case 'delete-subtree': {
      try {
        const itemId = asNodeId(args['itemId'] as string);
        if (!itemId) throw new Error('delete-subtree requires itemId');
        await store.deleteItem(itemId);
        return { success: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    }

    case 'add-children': {
      try {
        const itemId = asNodeId(args['itemId'] as string);
        if (!itemId) throw new Error('add-children requires itemId');
        const children = args['children'] as Array<{ title: string; type?: ItemType; criteria?: string[] }>;
        if (!Array.isArray(children) || children.length === 0) {
          throw new Error('add-children requires a non-empty children array');
        }
        for (const child of children) {
          const newItem = await store.addChild(itemId, child.title, child.type);
          if (child.criteria && child.criteria.length > 0) {
            await store.setCriteria(newItem.id, child.criteria);
          }
        }
        return { success: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    }

    case 'get-details': {
      const itemId = asNodeId(args['itemId'] as string);
      if (!itemId) throw new Error('get-details requires itemId');
      const item = await store.getItem(itemId);
      if (!item) return null;
      const [details, parentContext] = await Promise.all([
        store.getDetails(itemId),
        store.getParentContext(itemId),
      ]);
      const view: ItemDetailView = {
        id: item.id,
        title: item.title,
        type: item.type,
        details,
        parentContext,
      };
      if (item.criteria && item.criteria.length > 0) view.criteria = item.criteria;
      return view;
    }

    case 'set-details': {
      try {
        const itemId = asNodeId(args['itemId'] as string);
        if (!itemId) throw new Error('set-details requires itemId');
        const details = args['details'] as string;
        if (typeof details !== 'string') throw new Error('set-details requires details string');
        await store.setDetails(itemId, details);
        return { success: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    }

    case 'set-parent-context': {
      try {
        const itemId = asNodeId(args['itemId'] as string);
        if (!itemId) throw new Error('set-parent-context requires itemId');
        const parentContext = args['parentContext'] as string;
        if (typeof parentContext !== 'string') throw new Error('set-parent-context requires parentContext string');
        await store.setParentContext(itemId, parentContext);
        return { success: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    }

    case 'set-criteria': {
      try {
        const itemId = asNodeId(args['itemId'] as string);
        if (!itemId) throw new Error('set-criteria requires itemId');
        const criteria = args['criteria'] as string[];
        if (!Array.isArray(criteria)) throw new Error('set-criteria requires criteria array');
        await store.setCriteria(itemId, criteria);
        return { success: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    }

    default:
      throw new Error(`Unknown plan action: ${action}`);
  }
}
