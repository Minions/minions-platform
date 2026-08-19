import { describe, it, expect } from 'vitest';
import { subtreeKeepsGoalPath } from './planPathLogic.js';
import type { PlanItem } from '@minions/planner-types';
import { asNodeId } from '@minions/planner-types';

function item(
  overrides: Partial<Omit<PlanItem, 'id' | 'parent' | 'children' | 'requires'>> & {
    id: string;
    parent?: string | null;
    children?: string[];
    requires?: string[];
  },
): PlanItem {
  return {
    title: overrides.id,
    type: 'task',
    criteria: [],
    approved: false,
    started: false,
    onPath: false,
    questions: [],
    ...overrides,
    id: asNodeId(overrides.id),
    parent: overrides.parent != null ? asNodeId(overrides.parent) : null,
    children: (overrides.children ?? []).map(asNodeId),
    requires: (overrides.requires ?? []).map(asNodeId),
  };
}

describe('subtreeKeepsGoalPath', () => {
  it('returns false for a leaf with no claim and no demoLink (abandoned)', () => {
    const items = { leaf: item({ id: 'leaf' }) };
    expect(subtreeKeepsGoalPath('leaf', items)).toBe(false);
  });

  it('returns true for a leaf that is still claimed', () => {
    const items = { leaf: item({ id: 'leaf', claimedBy: { wing: 'w', branch: 'b' } }) };
    expect(subtreeKeepsGoalPath('leaf', items)).toBe(true);
  });

  it('returns true for a leaf with a demoLink, even after its claim was released', () => {
    const items = { leaf: item({ id: 'leaf', demoLink: 'http://localhost/demo' }) };
    expect(subtreeKeepsGoalPath('leaf', items)).toBe(true);
  });

  it('returns true for an ancestor whose descendant still has a demoLink', () => {
    const items = {
      root: item({ id: 'root', children: ['leaf'] }),
      leaf: item({ id: 'leaf', parent: 'root', demoLink: 'http://localhost/demo' }),
    };
    expect(subtreeKeepsGoalPath('root', items)).toBe(true);
  });

  it('returns false for an ancestor whose only descendant was abandoned (no claim, no demo)', () => {
    const items = {
      root: item({ id: 'root', children: ['leaf'] }),
      leaf: item({ id: 'leaf', parent: 'root' }),
    };
    expect(subtreeKeepsGoalPath('root', items)).toBe(false);
  });

  it('returns false for an unknown id', () => {
    expect(subtreeKeepsGoalPath('missing', {})).toBe(false);
  });
});
