/**
 * SharedBrowserService — the cabinet's owner of a single, long-lived shared Chrome
 * for its lair.
 *
 * The cabinet runs one process per lair and serves every wing in that lair. This
 * service idempotently ensures exactly one shared Chrome (CDP-debuggable,
 * persistent per-lair profile) is running and hands wings the `browserUrl` they
 * attach to with `chrome-devtools-mcp --browserUrl …`. Concurrent requests from
 * multiple wings collapse to a single launch (single-flight); a second request
 * reuses the running browser.
 *
 * Port is not stable — we just need a free one. We start at a base port and walk
 * upward past any occupied port (a foreign process, or another lair's Chrome).
 * The chosen port and the launched browser's CDP identity are persisted (in the
 * cabinet's lair config) so a later call recognizes *our* lair's Chrome and never
 * accidentally attaches to a different lair's Chrome that happens to expose the
 * same CDP toolset on a nearby port.
 *
 * The lifecycle logic lives here as pure domain code; talking to the OS (spawning
 * Chrome, finding a free port), the network (probing CDP), and persistence are
 * delegated to injected adapters so the behavior is testable with in-process fakes.
 */

/** Result of probing a port for a CDP endpoint. */
export type ProbeResult =
  | { status: 'chrome'; browserId: string }
  | { status: 'foreign' }
  | { status: 'down' };

/** Spawns the shared Chrome process. */
export interface ChromeLauncher {
  launch(opts: { port: number; userDataDir: string; headless: boolean }): Promise<void>;
}

/** Probes a port to determine whether a CDP Chrome is reachable there. */
export interface BrowserProbe {
  probe(port: number): Promise<ProbeResult>;
}

/** Persisted identity of this lair's shared Chrome. */
export interface SharedBrowserState {
  port: number;
  /** The CDP browser GUID — stable for the life of one Chrome process. */
  browserId: string;
}

/** Reads/writes the persisted shared-browser state (the cabinet's lair config). */
export interface SharedBrowserStore {
  get(): Promise<SharedBrowserState | null>;
  set(state: SharedBrowserState): Promise<void>;
}

export interface SharedBrowserConfig {
  /** Port to start searching from; the actual port may differ if it's occupied. */
  basePort: number;
  /** Persistent, per-lair user-data-dir so auth/localStorage are shared across the lair's wings. */
  userDataDir: string;
}

export interface SharedBrowserInfo {
  /** The URL wings pass to `chrome-devtools-mcp --browserUrl`. */
  browserUrl: string;
  /** True when an already-running shared Chrome was reused; false when launched. */
  reused: boolean;
}

interface PollOptions {
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface SharedBrowserDeps {
  launcher: ChromeLauncher;
  probe: BrowserProbe;
  store: SharedBrowserStore;
  /** Returns the first port >= startPort that is free to bind. */
  findFreePort: (startPort: number) => Promise<number>;
  poll?: PollOptions;
}

const DEFAULT_POLL_INTERVAL_MS = 200;
const DEFAULT_POLL_TIMEOUT_MS = 15000;

/** What MCP callers need — lets the tool handler depend on an interface. */
export interface SharedBrowserProvider {
  ensureRunning(opts?: { headless?: boolean }): Promise<SharedBrowserInfo>;
}

export class SharedBrowserService implements SharedBrowserProvider {
  private inflight: Promise<SharedBrowserInfo> | null = null;

  constructor(
    private readonly config: SharedBrowserConfig,
    private readonly deps: SharedBrowserDeps,
  ) {}

  /**
   * Ensure this lair's shared Chrome is up and return its connection info.
   * Idempotent and single-flight: concurrent callers share one launch, and a
   * later caller reuses the running browser.
   */
  ensureRunning(opts: { headless?: boolean } = {}): Promise<SharedBrowserInfo> {
    if (this.inflight) return this.inflight;
    this.inflight = this.doEnsure(opts).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private urlFor(port: number): string {
    return `http://127.0.0.1:${port}`;
  }

  private async doEnsure(opts: { headless?: boolean }): Promise<SharedBrowserInfo> {
    // Reuse our lair's Chrome only if the persisted identity still matches what's
    // running on the remembered port — never attach to a foreign or other-lair browser.
    const persisted = await this.deps.store.get();
    if (persisted) {
      const result = await this.deps.probe.probe(persisted.port);
      if (result.status === 'chrome' && result.browserId === persisted.browserId) {
        return { browserUrl: this.urlFor(persisted.port), reused: true };
      }
    }

    const port = await this.deps.findFreePort(this.config.basePort);
    await this.deps.launcher.launch({
      port,
      userDataDir: this.config.userDataDir,
      headless: opts.headless ?? false,
    });
    const browserId = await this.waitForChrome(port);
    await this.deps.store.set({ port, browserId });
    return { browserUrl: this.urlFor(port), reused: false };
  }

  /** Poll until our freshly-launched Chrome answers CDP; return its browser identity. */
  private async waitForChrome(port: number): Promise<string> {
    const poll = this.deps.poll ?? {};
    const interval = poll.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const timeout = poll.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
    const sleep = poll.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

    const deadline = Date.now() + timeout;
    for (;;) {
      const result = await this.deps.probe.probe(port);
      if (result.status === 'chrome') return result.browserId;
      if (Date.now() >= deadline) {
        throw new Error(
          `Shared Chrome on port ${port} did not become reachable within ${timeout}ms after launch.`,
        );
      }
      await sleep(interval);
    }
  }
}
