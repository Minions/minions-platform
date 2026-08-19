import { describe, it, expect } from 'vitest';
import { buildServerInstructions, PRODUCT_NAME } from './serverIdentity.js';

describe('buildServerInstructions', () => {
  it('states PRODUCTION, the lair it controls, and points to a dev server for debugging', () => {
    const instructions = buildServerInstructions({ isDevMode: false, lairName: 'minions-nabu' });

    expect(instructions).toMatch(/PRODUCTION/);
    expect(instructions).toContain('minions-nabu');
    expect(instructions).toMatch(/does not support hot module reload/i);
    expect(instructions).toMatch(/not developing new cabinet capabilities/i);
    expect(instructions).toMatch(/use a dev-mode server for debugging/i);
  });

  it('states DEV mode, HMR, and the wing it controls', () => {
    const instructions = buildServerInstructions({ isDevMode: true, wingName: 'workshop-03' });

    expect(instructions).toMatch(/DEV mode/);
    expect(instructions).toMatch(/hot module reload/i);
    expect(instructions).toContain('workshop-03');
  });

  it('states the server\'s general purpose regardless of mode', () => {
    const prod = buildServerInstructions({ isDevMode: false, lairName: 'x' });
    const dev = buildServerInstructions({ isDevMode: true, wingName: 'y' });

    expect(prod).toMatch(/plan, movement, docs, and wing-management tools/);
    expect(dev).toMatch(/plan, movement, docs, and wing-management tools/);
  });

  it('falls back gracefully when lairName/wingName is unknown', () => {
    expect(buildServerInstructions({ isDevMode: false })).toContain('an unknown lair');
    expect(buildServerInstructions({ isDevMode: true })).toContain('an unknown wing');
  });

  it('exposes the product name as a constant for reuse in serverInfo.name', () => {
    expect(PRODUCT_NAME).toBe('Minions Platform');
  });
});
