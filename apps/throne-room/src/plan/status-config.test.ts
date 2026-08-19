import { describe, it, expect } from 'vitest';
import { PLAN_STATUS_CONFIG, type PlanDisplayStatus } from './status-config';

const ALL_STATUSES: PlanDisplayStatus[] = [
  'in-planning',
  'tentatively-approved',
  'ready',
  'on-path',
  'wip',
  'demo-ready',
  'blocked',
];

describe('PLAN_STATUS_CONFIG', () => {
  it('has an entry for every required display status', () => {
    for (const status of ALL_STATUSES) {
      expect(PLAN_STATUS_CONFIG[status]).toBeDefined();
    }
  });

  it.each(ALL_STATUSES)('%s has a non-empty label', (status) => {
    expect(PLAN_STATUS_CONFIG[status].label).toBeTruthy();
  });

  it.each(ALL_STATUSES)('%s has an icon for color-blind secondary indicator', (status) => {
    expect(PLAN_STATUS_CONFIG[status].icon).toBeTruthy();
  });

  it.each(ALL_STATUSES)('%s has background, text, and border Tailwind classes', (status) => {
    const config = PLAN_STATUS_CONFIG[status];
    expect(config.bgClass).toMatch(/^bg-/);
    expect(config.textClass).toMatch(/^text-/);
    expect(config.borderClass).toMatch(/^border-/);
  });

  it('blocked status uses red color family for high visibility', () => {
    expect(PLAN_STATUS_CONFIG['blocked'].bgClass).toContain('red');
    expect(PLAN_STATUS_CONFIG['blocked'].textClass).toContain('red');
    expect(PLAN_STATUS_CONFIG['blocked'].borderClass).toContain('red');
  });

  it('wip status uses warm color family (amber or orange)', () => {
    expect(PLAN_STATUS_CONFIG['wip'].bgClass).toMatch(/amber|orange/);
  });

  it('demo-ready status uses cool distinct color (purple or violet)', () => {
    expect(PLAN_STATUS_CONFIG['demo-ready'].bgClass).toMatch(/purple|violet/);
  });

  it('on-path status uses cyan color family for active-goal indication', () => {
    expect(PLAN_STATUS_CONFIG['on-path'].bgClass).toMatch(/cyan|sky|teal/);
  });

  it('in-planning uses italic text style as secondary non-color indicator', () => {
    expect(PLAN_STATUS_CONFIG['in-planning'].textStyle).toBe('italic');
  });

  it('all statuses except in-planning use normal text style', () => {
    for (const status of ALL_STATUSES.filter((s) => s !== 'in-planning')) {
      expect(PLAN_STATUS_CONFIG[status].textStyle).toBe('normal');
    }
  });
});
