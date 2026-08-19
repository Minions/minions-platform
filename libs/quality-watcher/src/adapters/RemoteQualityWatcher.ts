/**
 * HTTP client implementation of `IQualityWatcher` — talks to a wing's quality
 * signals hosted in the separate `quality-watcher-process`
 * (docs/design/quality-watcher-process-redesign.md), instead of running them
 * in-process the way `WingQualityWatcher` does. Selected in place of
 * `WingQualityWatcher` behind the `HIGHER_PERF_QUALITY_WATCHER` feature flag.
 *
 * `getStatus()` must be synchronous (see `IQualityWatcher`'s contract), so
 * this caches the last-known `QualityStatus` in memory and returns that;
 * `awaitStatus()` is what actually performs the HTTP round trip and
 * refreshes the cache. Before the first `awaitStatus()` call, `getStatus()`
 * returns an all-`pending` placeholder — the same "nothing has run yet"
 * value a real watcher's own signal runners start at.
 *
 * Also exposes `pause()`/`resume()` — not part of `IQualityWatcher` (see
 * `ISignalRunner.pause`'s doc comment for why this is a general, optional
 * capability rather than a required one): called directly by the movement
 * wiring around `movement start`/`merge`/`promote`, never through the
 * interface. Errors from any of `start`/`stop`/`pause`/`resume` propagate to
 * the caller as-is — this class is an honest client, not a best-effort one;
 * best-effort/catch-and-log semantics belong at whichever call site
 * specifically wants them (see `MCPServer`'s movement context wiring).
 */
import { allPendingQualityStatus, applyWarningPolicy, type QualityStatus } from '../QualityStatus.js';
import { fromWireQualityStatus, type WireQualityStatus } from '../QualityStatusWireFormat.js';
import type { IQualityWatcher } from '../IQualityWatcher.js';

/** Pure — the one place a per-wing watcher-process URL is built, so client and any future test agree on its shape. */
export function buildWingUrl(baseUrl: string, wingName: string, path: string): string {
  return `${baseUrl}/wings/${encodeURIComponent(wingName)}/${path}`;
}

/** Pure — the status URL specifically (kept as its own export since it's the one GET among otherwise-POST wing actions). `maxWaitMs`, when positive, tells the server to actually wait for a settled result (see WingSignalWatchers.awaitStatus) rather than answering with whatever's cached immediately. */
export function buildStatusUrl(baseUrl: string, wingName: string, maxWaitMs?: number): string {
  const url = buildWingUrl(baseUrl, wingName, 'status');
  return maxWaitMs && maxWaitMs > 0 ? `${url}?maxWaitMs=${encodeURIComponent(maxWaitMs)}` : url;
}

/** Pure — turns a fetch Response's parsed JSON body into a `QualityStatus`, or throws a descriptive error for a non-OK response. Doesn't itself call fetch, so it's testable without a real server or mocked fetch. */
export function parseStatusResponse(ok: boolean, statusCode: number, body: unknown): QualityStatus {
  if (!ok) {
    throw new Error(`quality-watcher-process returned HTTP ${statusCode}`);
  }
  return fromWireQualityStatus(body as WireQualityStatus);
}

/** Pure — throws a descriptive error for a non-OK response to one of the POST wing actions (start/stop/pause/resume). */
export function assertOkWingAction(action: string, ok: boolean, statusCode: number): void {
  if (!ok) {
    throw new Error(`quality-watcher-process ${action} returned HTTP ${statusCode}`);
  }
}

export class RemoteQualityWatcher implements IQualityWatcher {
  private running = false;
  private cachedStatus: QualityStatus;

  constructor(
    readonly wingName: string,
    private readonly baseUrl: string,
    private readonly repoPaths: Record<string, string>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.cachedStatus = allPendingQualityStatus(new Date());
  }

  async start(): Promise<void> {
    if (this.running) {
      throw new Error('Watcher is already running');
    }
    const response = await this.fetchImpl(buildWingUrl(this.baseUrl, this.wingName, 'start'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoPaths: this.repoPaths }),
    });
    assertOkWingAction('start', response.ok, response.status);
    this.running = true;
  }

  async stop(): Promise<void> {
    const response = await this.fetchImpl(buildWingUrl(this.baseUrl, this.wingName, 'stop'), { method: 'POST' });
    assertOkWingAction('stop', response.ok, response.status);
    this.running = false;
  }

  /** See the class doc comment — not part of `IQualityWatcher`. */
  async pause(): Promise<void> {
    const response = await this.fetchImpl(buildWingUrl(this.baseUrl, this.wingName, 'pause'), { method: 'POST' });
    assertOkWingAction('pause', response.ok, response.status);
  }

  /** See the class doc comment — not part of `IQualityWatcher`. */
  async resume(): Promise<void> {
    const response = await this.fetchImpl(buildWingUrl(this.baseUrl, this.wingName, 'resume'), { method: 'POST' });
    assertOkWingAction('resume', response.ok, response.status);
  }

  getStatus(treatWarningsAsWarnings = false): QualityStatus {
    return applyWarningPolicy(this.cachedStatus, treatWarningsAsWarnings);
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * `maxWaitMs`, when given, is passed to the watcher process as a query
   * param it actually waits on server-side (see
   * `WingSignalWatchers.awaitStatus`) — the same "wait for a real settled
   * result, not whatever's cached" contract `QualityWatcher.awaitStatus`
   * provides in-process, just over HTTP instead of in-memory.
   */
  async awaitStatus(maxWaitMs?: number, treatWarningsAsWarnings = false): Promise<QualityStatus> {
    const response = await this.fetchImpl(buildStatusUrl(this.baseUrl, this.wingName, maxWaitMs));
    const body = await response.json();
    this.cachedStatus = parseStatusResponse(response.ok, response.status, body);
    return applyWarningPolicy(this.cachedStatus, treatWarningsAsWarnings);
  }
}
