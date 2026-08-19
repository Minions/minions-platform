import { describe, it, expect } from 'vitest';
import type { PlanItem } from '@minions/planner-types';
import { asNodeId } from '@minions/planner-types';
import { computeActivityRings, computePlanDisplayState, computePlanState } from './computePlanDisplayState';

function makeItem(overrides: Partial<PlanItem> = {}): PlanItem {
  return {
    id: asNodeId('test1234'),
    title: 'Test item',
    type: 'task',
    parent: null,
    children: [],
    requires: [],
    criteria: [],
    approved: true,
    started: false,
    onPath: false,
    questions: [],
    ...overrides,
  };
}

describe('computePlanDisplayState', () => {
  describe('base states (no blocking questions)', () => {
    it('returns "demo-ready" when demoLink is set', () => {
      expect(computePlanDisplayState(makeItem({ demoLink: 'http://example.com' }))).toBe('demo-ready');
    });

    it('returns "wip" when started is true', () => {
      expect(computePlanDisplayState(makeItem({ started: true }))).toBe('wip');
    });

    it('returns "in-planning" when approved is false', () => {
      expect(computePlanDisplayState(makeItem({ approved: false }))).toBe('in-planning');
    });

    it('returns "tentatively-approved" when approved is "tentative"', () => {
      expect(computePlanDisplayState(makeItem({ approved: 'tentative' }))).toBe('tentatively-approved');
    });

    it('returns "plan-done" when approved is true', () => {
      expect(computePlanDisplayState(makeItem({ approved: true }))).toBe('plan-done');
    });

    it('returns "ready" when ready is true (and approved is non-false)', () => {
      expect(computePlanDisplayState(makeItem({ approved: true, ready: true }))).toBe('ready');
      expect(computePlanDisplayState(makeItem({ approved: 'tentative', ready: true }))).toBe('ready');
    });

  });

  describe('blocked overlay', () => {
    it('returns "blocked" when item has unanswered questions', () => {
      expect(computePlanDisplayState(makeItem({ questions: ['q1'] }))).toBe('blocked');
    });

    it('overrides demo-ready with blocked when questions exist', () => {
      expect(computePlanDisplayState(makeItem({ demoLink: 'http://example.com', questions: ['q1'] }))).toBe('blocked');
    });

    it('overrides wip with blocked when questions exist', () => {
      expect(computePlanDisplayState(makeItem({ started: true, questions: ['q1'] }))).toBe('blocked');
    });

    it('overrides in-planning with blocked when questions exist', () => {
      expect(computePlanDisplayState(makeItem({ approved: false, questions: ['q1'] }))).toBe('blocked');
    });

    it('does not block when questions array is empty', () => {
      expect(computePlanDisplayState(makeItem({ questions: [] }))).toBe('plan-done');
    });
  });

  describe('state priority', () => {
    it('demo-ready takes priority over wip', () => {
      expect(computePlanDisplayState(makeItem({ demoLink: 'http://example.com', started: true }))).toBe('demo-ready');
    });

    it('wip takes priority over approved state', () => {
      expect(computePlanDisplayState(makeItem({ started: true, approved: false }))).toBe('wip');
    });
  });
});

describe('computePlanState (orb colour — independent of activity)', () => {
  it('returns "imagining" when not approved', () => {
    expect(computePlanState(makeItem({ approved: false }))).toBe('imagining');
  });

  it('returns "done" when approved and not ready', () => {
    expect(computePlanState(makeItem({ approved: true, ready: false }))).toBe('done');
    expect(computePlanState(makeItem({ approved: 'tentative' }))).toBe('done');
  });

  it('returns "ready" when approved and ready', () => {
    expect(computePlanState(makeItem({ approved: true, ready: true }))).toBe('ready');
  });

  it('is unaffected by started, onPath, demoLink, or questions', () => {
    expect(computePlanState(makeItem({
      approved: true, ready: true, started: true, onPath: true,
      demoLink: 'http://example.com', questions: ['q1'],
    }))).toBe('ready');
    expect(computePlanState(makeItem({
      approved: false, started: true, onPath: true,
      demoLink: 'http://example.com', questions: ['q1'],
    }))).toBe('imagining');
  });
});

describe('computeActivityRings (independent, combinable rings)', () => {
  it('returns no rings for a plain unclaimed, unblocked item', () => {
    expect(computeActivityRings(makeItem())).toEqual([]);
  });

  it('includes "goal" when onPath and not started', () => {
    expect(computeActivityRings(makeItem({ onPath: true }))).toEqual(['goal']);
  });

  it('includes "implementing" instead of "goal" when started', () => {
    expect(computeActivityRings(makeItem({ onPath: true, started: true }))).toEqual(['implementing']);
  });

  it('includes "to-demo" alongside "implementing"', () => {
    expect(computeActivityRings(makeItem({ started: true, demoLink: 'http://example.com' })))
      .toEqual(['implementing', 'to-demo']);
  });

  it('includes "to-demo" alongside "goal" (unclaimed but reached demo)', () => {
    expect(computeActivityRings(makeItem({ onPath: true, demoLink: 'http://example.com' })))
      .toEqual(['goal', 'to-demo']);
  });

  it('includes "blocked" combined with any other ring', () => {
    expect(computeActivityRings(makeItem({ started: true, demoLink: 'http://example.com', questions: ['q1'] })))
      .toEqual(['implementing', 'to-demo', 'blocked']);
  });

  it('is unaffected by approved/ready', () => {
    expect(computeActivityRings(makeItem({ approved: false, ready: false, started: true })))
      .toEqual(['implementing']);
  });
});
