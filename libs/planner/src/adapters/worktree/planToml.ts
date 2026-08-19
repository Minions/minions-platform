import { asNodeId } from '@minions/planner-types';
import type { ItemType, NodePlacement, NodeId } from '@minions/planner-types';
import { parseToml, stringifyToml, type TomlBlock } from './toml.js';

/** content.toml's per-item shape: everything about PlanItem except the lair-owned claim fields. */
export interface ContentFields {
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

/** claims.toml's per-item shape: the two lair-owned, dangling-tolerant fields. */
export interface ClaimFields {
  claimedBy?: { wing: string; branch: string };
  demoLink?: string;
}

type TomlTable = Record<string, unknown>;

export function serializeContent(order: NodeId[], items: Record<string, ContentFields>): string {
  const blocks: TomlBlock[] = [];
  for (const id of order) {
    const it = items[id];
    if (!it) continue;
    blocks.push({
      path: ['items', id],
      fields: [
        ['title', it.title],
        ['type', it.type],
        ['parent', it.parent ?? undefined],
        ['children', it.children],
        ['requires', it.requires],
        ['criteria', it.criteria],
        ['approved', it.approved],
        ['questions', it.questions],
        ['ready', it.ready],
      ],
    });
    if (it.exploring && Object.keys(it.exploring).length > 0) {
      blocks.push({ path: ['items', id, 'exploring'], fields: Object.entries(it.exploring) });
    }
    if (it.places) {
      for (const [kind, p] of Object.entries(it.places)) {
        blocks.push({
          path: ['items', id, 'places', kind],
          fields: [
            ['locationIds', p.locationIds],
            ['flowIds', p.flowIds],
          ],
        });
      }
    }
  }
  return stringifyToml(blocks);
}

export function parseContent(text: string): { order: NodeId[]; items: Record<string, ContentFields> } {
  const root = parseToml(text);
  const itemsTable = (root['items'] as TomlTable | undefined) ?? {};
  const order: NodeId[] = [];
  const items: Record<string, ContentFields> = {};
  for (const [id, rawUnknown] of Object.entries(itemsTable)) {
    const raw = rawUnknown as TomlTable;
    order.push(asNodeId(id));
    const placesRaw = raw['places'] as TomlTable | undefined;
    let places: Record<string, NodePlacement> | undefined;
    if (placesRaw) {
      places = {};
      for (const [kind, pUnknown] of Object.entries(placesRaw)) {
        const p = pUnknown as TomlTable;
        places[kind] = {
          locationIds: (p['locationIds'] as string[] | undefined) ?? [],
          flowIds: p['flowIds'] as string[] | undefined,
        };
      }
    }
    items[id] = {
      title: (raw['title'] as string | undefined) ?? '',
      type: (raw['type'] as ItemType | undefined) ?? 'task',
      parent: raw['parent'] !== undefined ? asNodeId(raw['parent'] as string) : null,
      children: ((raw['children'] as string[] | undefined) ?? []).map(asNodeId),
      requires: ((raw['requires'] as string[] | undefined) ?? []).map(asNodeId),
      exploring: raw['exploring'] as Record<string, string> | undefined,
      criteria: (raw['criteria'] as string[] | undefined) ?? [],
      approved: (raw['approved'] as false | true | 'tentative' | undefined) ?? false,
      questions: (raw['questions'] as string[] | undefined) ?? [],
      ready: raw['ready'] as boolean | undefined,
      places,
    };
  }
  return { order, items };
}

export function serializeClaims(items: Record<string, ClaimFields>): string {
  const blocks: TomlBlock[] = [];
  for (const [id, c] of Object.entries(items)) {
    if (!c.claimedBy && c.demoLink === undefined) continue;
    blocks.push({
      path: ['items', id],
      fields: c.demoLink !== undefined ? [['demoLink', c.demoLink]] : [],
    });
    if (c.claimedBy) {
      blocks.push({
        path: ['items', id, 'claimedBy'],
        fields: [
          ['wing', c.claimedBy.wing],
          ['branch', c.claimedBy.branch],
        ],
      });
    }
  }
  return stringifyToml(blocks);
}

export function parseClaims(text: string): Record<string, ClaimFields> {
  const root = parseToml(text);
  const itemsTable = (root['items'] as TomlTable | undefined) ?? {};
  const result: Record<string, ClaimFields> = {};
  for (const [id, rawUnknown] of Object.entries(itemsTable)) {
    const raw = rawUnknown as TomlTable;
    const claimedByRaw = raw['claimedBy'] as TomlTable | undefined;
    result[id] = {
      demoLink: raw['demoLink'] as string | undefined,
      claimedBy: claimedByRaw
        ? { wing: claimedByRaw['wing'] as string, branch: claimedByRaw['branch'] as string }
        : undefined,
    };
  }
  return result;
}
