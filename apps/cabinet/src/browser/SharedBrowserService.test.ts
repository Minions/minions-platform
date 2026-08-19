import { describe, it, expect } from 'vitest';
import {
  SharedBrowserService,
  type ChromeLauncher,
  type BrowserProbe,
  type SharedBrowserStore,
  type SharedBrowserState,
} from './SharedBrowserService.js';

/**
 * In-process fake of the real multi-lair Chrome world. Models, per port, whether
 * a CDP Chrome is running there (and its browser identity), and whether the port
 * is otherwise occupied by a foreign process. The launcher "starts" Chrome by
 * registering a fresh browser identity on the chosen port; findFreePort honors
 * both kinds of occupancy. No mocks — the fake faithfully simulates the OS/CDP.
 */
class FakeWorld {
  /** port -> CDP browserId of a running Chrome on that port */
  readonly chromes = new Map<number, string>();
  /** ports held by a foreign (non-Chrome) process */
  readonly foreign = new Set<number>();
  readonly launches: Array<{ port: number; userDataDir: string; headless: boolean }> = [];
  stored: SharedBrowserState | null = null;
  private nextId = 1;

  private gate: Promise<void> | null = null;
  private releaseGate: (() => void) | null = null;
  openGate(): void {
    this.gate = new Promise<void>((resolve) => { this.releaseGate = resolve; });
  }
  release(): void {
    this.releaseGate?.();
  }

  readonly store: SharedBrowserStore = {
    get: async () => this.stored,
    set: async (s) => { this.stored = { ...s }; },
  };

  readonly probe: BrowserProbe = {
    probe: async (port) => {
      const id = this.chromes.get(port);
      if (id) return { status: 'chrome', browserId: id };
      if (this.foreign.has(port)) return { status: 'foreign' };
      return { status: 'down' };
    },
  };

  readonly launcher: ChromeLauncher = {
    launch: async (opts) => {
      this.launches.push(opts);
      if (this.gate) await this.gate;
      this.chromes.set(opts.port, `gid-${this.nextId++}`);
    },
  };

  readonly findFreePort = async (start: number): Promise<number> => {
    let p = start;
    while (this.foreign.has(p) || this.chromes.has(p)) p++;
    return p;
  };
}

const BASE = 9333;
const config = { basePort: BASE, userDataDir: '/lair/.shared-browser/profile' };
const fastPoll = { pollIntervalMs: 1, pollTimeoutMs: 1000, sleep: () => Promise.resolve() };

function makeService(world: FakeWorld) {
  return new SharedBrowserService(config, {
    launcher: world.launcher,
    probe: world.probe,
    store: world.store,
    findFreePort: world.findFreePort,
    poll: fastPoll,
  });
}

describe('SharedBrowserService', () => {
  it('launches Chrome on the base port when nothing is running, and persists its identity', async () => {
    const world = new FakeWorld();
    const svc = makeService(world);

    const info = await svc.ensureRunning();

    expect(info).toEqual({ browserUrl: `http://127.0.0.1:${BASE}`, reused: false });
    expect(world.launches).toEqual([{ port: BASE, userDataDir: config.userDataDir, headless: false }]);
    expect(world.stored).toEqual({ port: BASE, browserId: 'gid-1' });
  });

  it('reuses our running Chrome when the persisted identity still matches', async () => {
    const world = new FakeWorld();
    world.chromes.set(BASE, 'gid-existing');
    world.stored = { port: BASE, browserId: 'gid-existing' };
    const svc = makeService(world);

    const info = await svc.ensureRunning();

    expect(info).toEqual({ browserUrl: `http://127.0.0.1:${BASE}`, reused: true });
    expect(world.launches).toHaveLength(0);
  });

  it('a second wing reuses the browser the first wing started', async () => {
    const world = new FakeWorld();
    const svc = makeService(world);

    const first = await svc.ensureRunning();
    const second = await svc.ensureRunning();

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(world.launches).toHaveLength(1);
  });

  it('relaunches when our persisted Chrome has died', async () => {
    const world = new FakeWorld();
    world.stored = { port: BASE, browserId: 'gid-dead' }; // nothing running on BASE now
    const svc = makeService(world);

    const info = await svc.ensureRunning();

    expect(info.reused).toBe(false);
    expect(world.launches).toHaveLength(1);
    expect(world.stored?.browserId).not.toBe('gid-dead');
  });

  it('does not attach to another lair\'s Chrome on our old port — picks a new free port', async () => {
    const world = new FakeWorld();
    // Our config remembers BASE, but a different lair's Chrome now occupies BASE.
    world.stored = { port: BASE, browserId: 'ours-old' };
    world.chromes.set(BASE, 'other-lair');
    const svc = makeService(world);

    const info = await svc.ensureRunning();

    expect(info.browserUrl).toBe(`http://127.0.0.1:${BASE + 1}`);
    expect(info.reused).toBe(false);
    expect(world.launches).toEqual([{ port: BASE + 1, userDataDir: config.userDataDir, headless: false }]);
    // The other lair's Chrome on BASE is left untouched.
    expect(world.chromes.get(BASE)).toBe('other-lair');
  });

  it('skips a foreign occupant on the base port and launches on the next free port', async () => {
    const world = new FakeWorld();
    world.foreign.add(BASE);
    const svc = makeService(world);

    const info = await svc.ensureRunning();

    expect(info.browserUrl).toBe(`http://127.0.0.1:${BASE + 1}`);
    expect(world.launches).toEqual([{ port: BASE + 1, userDataDir: config.userDataDir, headless: false }]);
  });

  it('passes the headless flag through to the launcher', async () => {
    const world = new FakeWorld();
    const svc = makeService(world);

    await svc.ensureRunning({ headless: true });

    expect(world.launches[0]?.headless).toBe(true);
  });

  it('launches only once when two wings ask concurrently (single-flight)', async () => {
    const world = new FakeWorld();
    world.openGate();
    const svc = makeService(world);

    const p1 = svc.ensureRunning();
    const p2 = svc.ensureRunning();
    world.release();
    const [a, b] = await Promise.all([p1, p2]);

    expect(world.launches).toHaveLength(1);
    expect(a.browserUrl).toBe(`http://127.0.0.1:${BASE}`);
    expect(b.browserUrl).toBe(`http://127.0.0.1:${BASE}`);
  });

  it('times out if Chrome never becomes reachable after launch', async () => {
    const world = new FakeWorld();
    const stuckLauncher: ChromeLauncher = {
      launch: async (opts) => { world.launches.push(opts); }, // never registers a chrome
    };
    const svc = new SharedBrowserService(config, {
      launcher: stuckLauncher,
      probe: world.probe,
      store: world.store,
      findFreePort: world.findFreePort,
      poll: { pollIntervalMs: 1, pollTimeoutMs: 5, sleep: () => Promise.resolve() },
    });

    await expect(svc.ensureRunning()).rejects.toThrow(/did not become reachable/i);
  });
});
