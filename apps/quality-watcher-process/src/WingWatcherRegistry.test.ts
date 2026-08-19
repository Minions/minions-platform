import { describe, it, expect, vi } from 'vitest';
import { SignalType } from '@minions/quality-watcher';
import { WingWatcherRegistry } from './WingWatcherRegistry.js';
import { WingSignalWatchers } from './WingSignalWatchers.js';

describe('WingWatcherRegistry', () => {
  it('returns an all-pending status for a wing that was never started', () => {
    const registry = new WingWatcherRegistry();
    expect(registry.getStatus('never-started-wing')[SignalType.Tests].state).toBe('pending');
  });

  it('stop()/pause()/resume() on a never-started wing are no-ops, not errors', async () => {
    const registry = new WingWatcherRegistry();
    await expect(registry.stop('unknown')).resolves.toBeUndefined();
    await expect(registry.pause('unknown')).resolves.toBeUndefined();
    await expect(registry.resume('unknown')).resolves.toBeUndefined();
  });

  it('awaitStatus() on a never-started wing resolves immediately to the all-pending placeholder', async () => {
    const registry = new WingWatcherRegistry();
    const status = await registry.awaitStatus('unknown', 1000);
    expect(status[SignalType.Tests].state).toBe('pending');
  });

  it('awaitStatus() delegates to the wing\'s own WingSignalWatchers.awaitStatus()', async () => {
    const created: WingSignalWatchers[] = [];
    const registry = new WingWatcherRegistry(() => {
      const w = new WingSignalWatchers(undefined, () => []);
      created.push(w);
      return w;
    });
    await registry.start('wing-a', {});
    const spy = vi.spyOn(created[0], 'awaitStatus');

    await registry.awaitStatus('wing-a', 500);

    expect(spy).toHaveBeenCalledWith(500);
  });

  it('creates exactly one WingSignalWatchers per wing, reused across calls', async () => {
    const created: WingSignalWatchers[] = [];
    const registry = new WingWatcherRegistry(() => {
      const w = new WingSignalWatchers(undefined, () => []);
      created.push(w);
      return w;
    });

    await registry.start('wing-a', {});
    await registry.pause('wing-a');
    await registry.resume('wing-a');
    registry.getStatus('wing-a');

    expect(created).toHaveLength(1);
  });

  it('creates a separate WingSignalWatchers per distinct wing name', async () => {
    const created: WingSignalWatchers[] = [];
    const registry = new WingWatcherRegistry(() => {
      const w = new WingSignalWatchers(undefined, () => []);
      created.push(w);
      return w;
    });

    await registry.start('wing-a', {});
    await registry.start('wing-b', {});

    expect(created).toHaveLength(2);
  });

  it('unwedge() on a never-started wing is a no-op, returning no results', async () => {
    const registry = new WingWatcherRegistry();
    await expect(registry.unwedge('unknown', SignalType.Tests)).resolves.toEqual([]);
  });

  it('unwedge() delegates to the wing\'s own WingSignalWatchers.unwedge()', async () => {
    const created: WingSignalWatchers[] = [];
    const registry = new WingWatcherRegistry(() => {
      const w = new WingSignalWatchers(undefined, () => []);
      created.push(w);
      return w;
    });
    await registry.start('wing-a', {});
    const spy = vi.spyOn(created[0], 'unwedge');

    await registry.unwedge('wing-a', SignalType.Tests, 'local');

    expect(spy).toHaveBeenCalledWith(SignalType.Tests, 'local');
  });

  it('checkForWedges() fans out to every started wing, and is a no-op with none started', async () => {
    const created: WingSignalWatchers[] = [];
    const registry = new WingWatcherRegistry(() => {
      const w = new WingSignalWatchers(undefined, () => []);
      created.push(w);
      return w;
    });
    await expect(registry.checkForWedges(new Date())).resolves.toBeUndefined();

    await registry.start('wing-a', {});
    await registry.start('wing-b', {});
    const spies = created.map((w) => vi.spyOn(w, 'checkForWedges'));
    const now = new Date('2026-01-01T00:00:00Z');

    await registry.checkForWedges(now);

    for (const spy of spies) expect(spy).toHaveBeenCalledWith(now);
  });
});
