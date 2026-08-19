/**
 * Lazily spawns and owns the single `quality-watcher-process` child process
 * for this cabinet instance (one per lair — see
 * docs/design/quality-watcher-process-redesign.md), and resolves the base
 * URL to reach it once it announces its listening port.
 *
 * Also owns Tier 3 of the design's three-tier crash/wedge resilience: a
 * whole-process liveness check with two independent triggers feeding the
 * *same* respawn path — this is one recovery mechanism, not two:
 *   - **Crash**: the child's own OS-level `exit` event — it's simply gone.
 *   - **Hang**: a periodic `GET /health` poll (`HEARTBEAT_INTERVAL_MS`)
 *     against the process's own base URL, each with its own timeout
 *     (`HEARTBEAT_TIMEOUT_MS`); the process is declared hung after
 *     `HEARTBEAT_MISS_THRESHOLD` consecutive misses (timeout, non-2xx, or a
 *     network error), not on the first one — a single slow tick under load
 *     is not the emergency this exists to catch.
 *
 * On either, this respawns the whole process via the same `stop()`/
 * `ensureStarted()` primitives a caller would use manually, and notifies
 * subscribers so callers holding stale per-wing clients (built against the
 * old base URL) know to react — see `MCPServer`'s subscriptions for the
 * real cache-invalidation/re-attach logic:
 *   - `onCrash` fires synchronously the moment a failure is detected, before
 *     any respawn attempt — the signal to stop trusting anything already
 *     built against the dead/unresponsive process. (Named for the more
 *     common trigger; fires for a detected hang too.)
 *   - `onRespawn` fires once a replacement process is confirmed listening —
 *     the signal it's safe to rebuild against the new base URL.
 *
 * Behind `HIGHER_PERF_QUALITY_WATCHER`; used by
 * `MCPServer.getOrCreateQualityWatcher` to construct per-wing
 * `RemoteQualityWatcher` clients against the returned base URL.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Minimal shape this needs from a spawned child process — same shape ProcessWatchSignalRunner depends on, for the same reason (testable without a real process). */
export type SpawnedProcess = {
  stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): void } | null;
  stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): void } | null;
  kill(): void;
  /** Fires when the OS process actually exits, for any reason — including a deliberate `kill()`. Distinguishing "we killed it on purpose" from "it crashed" is this file's job, not the caller's. */
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
};

const STARTUP_TIMEOUT_MS = 30_000;
/** How many of the most recent stdout/stderr lines to retain for post-crash diagnostics. Small — this is "enough for a human/agent to see what it was doing right before it died," not a log archive. */
const RECENT_OUTPUT_LINES = 50;

/**
 * How often to poll `GET /health` once a process is up, and how long to
 * wait for any one poll before counting it a miss. `WEDGE_CHECK_INTERVAL_MS`
 * (Tier 1, `apps/quality-watcher-process/src/server.ts`) is the only
 * existing numeric precedent for a periodic liveness-style check in this
 * system — matched here rather than invented from scratch. The design doc
 * mandates no specific values for this tier.
 */
const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 5_000;
/** Consecutive misses (timeout, non-2xx, or a network error) before declaring the process hung — one slow/failed tick under load is not, by itself, the emergency this exists to catch. */
const HEARTBEAT_MISS_THRESHOLD = 2;

/** What triggered an emergency respawn — surfaced to subscribers and `getLastEmergency()`. */
export type EmergencyReason = 'crash' | 'hang';

export type CrashInfo = {
  reason: EmergencyReason;
};

export type RespawnInfo = {
  reason: EmergencyReason;
  /** The new base URL to reach the freshly-spawned process at. */
  baseUrl: string;
};

export type EmergencyRecord = {
  reason: EmergencyReason;
  at: Date;
  /** Recent stdout/stderr output captured up to the moment of the failure, for a human/agent investigating afterward. */
  recentOutput: string[];
};

/**
 * Pure — resolves the built watcher-process entry point from the `apps/`
 * directory both it and cabinet live under. Exported for testing.
 *
 * `.cjs`, not `.js`: the app's package.json is `"type": "module"`, but its
 * dependency tree (express, and transitively cross-spawn via
 * @minions/quality-watcher) contains dynamic `require()` calls that
 * esbuild's ESM bundle output can't safely shim — confirmed by actually
 * running the built ESM output, which threw `Dynamic require of "..." is
 * not supported` at startup. Building as CJS instead (this app's
 * `package.json` build script) and giving the output a `.cjs` extension
 * makes Node treat it as CommonJS regardless of the package's own `"type"`,
 * sidestepping the whole class of bundling issue.
 */
export function resolveQualityWatcherProcessEntry(appsDir: string): string {
  return path.join(appsDir, 'quality-watcher-process', 'dist', 'main.cjs');
}

/**
 * Pure — parses one line of the child's stdout for its startup announcement
 * (`{"type":"listening","port":N}`, see apps/quality-watcher-process/src/main.ts).
 * Returns undefined for any other line (including partial JSON, other log
 * output, or garbage) rather than throwing, since stdout may carry other
 * lines before or after the announcement.
 */
export function parseListeningAnnouncement(line: string): number | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (
    parsed !== null &&
    typeof parsed === 'object' &&
    (parsed as Record<string, unknown>)['type'] === 'listening' &&
    typeof (parsed as Record<string, unknown>)['port'] === 'number'
  ) {
    return (parsed as Record<string, unknown>)['port'] as number;
  }
  return undefined;
}

/**
 * `HIGHER_PERF_QUALITY_WATCHER` is dev-only for now (see
 * docs/design/quality-watcher-process-redesign.md), and dev mode always
 * runs cabinet from source (vite-node — see apps/cabinet/scripts/dev-server.mjs),
 * which preserves this file's real `apps/cabinet/src/quality/` location, so
 * walking up four directories from it reaches `apps/`. This assumption
 * needs revisiting (resolve `apps/` some other way — e.g. from a known repo
 * root — rather than counting directory levels from this file) before the
 * flag is ever turned on for a built/bundled prod cabinet, whose bundling
 * strategy may not preserve this file's source-tree depth.
 */
function defaultSpawnProcess(): SpawnedProcess {
  const appsDir = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');
  const entryPath = resolveQualityWatcherProcessEntry(appsDir);
  return spawn(process.execPath, [entryPath]);
}

export class QualityWatcherProcessClient {
  private starting: Promise<string> | null = null;
  private child: SpawnedProcess | null = null;
  private recentOutput: string[] = [];
  /** Whatever partial line hasn't seen a trailing `\n` yet, across `recordOutput` calls — the same "buffer, split, keep the remainder" shape `start()` already uses to reassemble the listening announcement. */
  private outputLineBuffer = '';
  private lastEmergency: EmergencyRecord | undefined;
  private readonly crashListeners = new Set<(info: CrashInfo) => void>();
  private readonly respawnListeners = new Set<(info: RespawnInfo) => void>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatMisses = 0;

  constructor(
    private readonly spawnProcess: () => SpawnedProcess = defaultSpawnProcess,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  /** Spawns the process on first call; every later call returns the same in-flight/resolved promise. */
  async ensureStarted(): Promise<string> {
    if (!this.starting) {
      this.starting = this.start();
    }
    return this.starting;
  }

  stop(): void {
    this.stopHeartbeat();
    this.child?.kill();
    this.child = null;
    this.starting = null;
  }

  /** Subscribe to the moment a crash or detected hang is detected, before any respawn attempt — the signal to stop trusting anything built against the dead/unresponsive process. Returns an unsubscribe function. */
  onCrash(listener: (info: CrashInfo) => void): () => void {
    this.crashListeners.add(listener);
    return () => this.crashListeners.delete(listener);
  }

  /** Subscribe to a confirmed successful respawn (Tier 3) — the signal it's safe to rebuild against the new base URL. Returns an unsubscribe function. */
  onRespawn(listener: (info: RespawnInfo) => void): () => void {
    this.respawnListeners.add(listener);
    return () => this.respawnListeners.delete(listener);
  }

  /** The most recent emergency respawn, if any have happened since this client was constructed. */
  getLastEmergency(): EmergencyRecord | undefined {
    return this.lastEmergency;
  }

  /** Recent stdout/stderr output, oldest first, one complete line per entry (reassembled across chunk boundaries) — for diagnostics, independent of whether an emergency has fired. If a line is still being written when this is called, it's included as-is (unterminated) rather than dropped. */
  getRecentOutput(): string[] {
    return this.outputLineBuffer.length > 0 ? [...this.recentOutput, this.outputLineBuffer] : [...this.recentOutput];
  }

  private recordOutput(chunk: string): void {
    this.outputLineBuffer += chunk;
    const lines = this.outputLineBuffer.split('\n');
    this.outputLineBuffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.length === 0) continue;
      this.recentOutput.push(line);
      if (this.recentOutput.length > RECENT_OUTPUT_LINES) {
        this.recentOutput.shift();
      }
    }
  }

  private start(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const child = this.spawnProcess();
      this.child = child;

      const timeout = setTimeout(() => {
        reject(new Error(`quality-watcher-process did not report a listening port within ${STARTUP_TIMEOUT_MS}ms`));
      }, STARTUP_TIMEOUT_MS);

      let buffer = '';
      child.stdout?.on('data', (chunk) => {
        const text = chunk.toString();
        this.recordOutput(text);
        buffer += text;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const port = parseListeningAnnouncement(line);
          if (port !== undefined) {
            clearTimeout(timeout);
            const baseUrl = `http://127.0.0.1:${port}`;
            this.startHeartbeat(baseUrl, child);
            resolve(baseUrl);
            return;
          }
        }
      });
      child.stderr?.on('data', (chunk) => {
        const text = chunk.toString();
        console.error('[quality-watcher-process]', text);
        this.recordOutput(text);
      });
      child.on('exit', (code, signal) => {
        // Every child gets its own listener closure capturing `child` by
        // identity. `stop()`/a later `start()` can replace `this.child`
        // (or null it) well before this process's OS-level exit actually
        // lands — kill() is async, and can lag further under load or on
        // Windows. Comparing identity, not a shared "did we mean to stop"
        // boolean, is what tells a stale exit from an already-replaced or
        // already-stopped child apart from a real unexpected exit of the
        // *current* child: by the time a stale one fires, `this.child` is
        // never still `=== child`, whether because stop() nulled it (no
        // restart yet) or a later start() moved it on to a newer child.
        if (this.child !== child) return;
        this.triggerEmergencyRespawn('crash', `exited unexpectedly (code=${code}, signal=${signal})`, false);
      });
    });
  }

  /** (Re)starts the heartbeat poll against `baseUrl`, replacing any timer from a previous process. `forChild` is captured by every tick's identity guard (see `checkHeartbeat`) so a stale tick from an already-replaced process can never affect the current one. Unref'd so it never keeps the cabinet process alive on its own. */
  private startHeartbeat(baseUrl: string, forChild: SpawnedProcess): void {
    this.stopHeartbeat();
    this.heartbeatMisses = 0;
    this.heartbeatTimer = setInterval(() => {
      this.checkHeartbeat(baseUrl, forChild).catch((err: unknown) => {
        console.error('[quality-watcher-process] heartbeat check itself threw (treating as a miss already handled internally):', err);
      });
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  /**
   * One heartbeat tick: poll `${baseUrl}/health`, bounded by
   * `HEARTBEAT_TIMEOUT_MS`. A single miss just increments the counter — only
   * `HEARTBEAT_MISS_THRESHOLD` *consecutive* misses declares the process
   * hung, so one slow tick under real load doesn't trigger a whole-process
   * replace (that's what Tier 1/2 exist to absorb for individual signals;
   * this tier stays an emergency-only last resort).
   *
   * `forChild` is the process this specific tick was launched against,
   * captured at `startHeartbeat` time. `stopHeartbeat()` only clears the
   * interval — it can't cancel a tick already awaiting `fetchImpl` (up to
   * `HEARTBEAT_TIMEOUT_MS`). Without this guard, a tick against a process
   * that crashed (or was replaced by a hang-triggered respawn) mid-flight
   * would resolve *after* `startHeartbeat` already reset `heartbeatMisses`
   * for the new process, and its miss would count against the new process's
   * fresh counter instead of being discarded — a genuinely healthy
   * freshly-respawned process could then get killed by what is really its
   * own first real miss, tipped over the threshold by a stale leftover.
   * Bailing here, before any mutation, before both the counter update and
   * `triggerEmergencyRespawn`, is what closes that window — same identity-
   * comparison pattern the exit listener already uses for its own stale-
   * event guard.
   */
  private async checkHeartbeat(baseUrl: string, forChild: SpawnedProcess): Promise<void> {
    let ok = false;
    try {
      const res = await this.fetchImpl(`${baseUrl}/health`, { signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS) });
      ok = res.ok;
    } catch {
      ok = false;
    }

    if (this.child !== forChild) return; // stale tick — the process it was about has already moved on

    if (ok) {
      this.heartbeatMisses = 0;
      return;
    }
    this.heartbeatMisses += 1;
    if (this.heartbeatMisses < HEARTBEAT_MISS_THRESHOLD) return;

    this.stopHeartbeat();
    this.triggerEmergencyRespawn(
      'hang',
      `did not respond to ${HEARTBEAT_MISS_THRESHOLD} consecutive health checks ` +
        `(${HEARTBEAT_TIMEOUT_MS}ms timeout each) at ${baseUrl}`,
      true
    );
  }

  /**
   * The whole-process emergency path (Tier 3), shared by both triggers
   * (crash detection and hang detection): surfaces a loud alert, retains
   * what the process was last doing, notifies `onCrash` subscribers
   * immediately (so they can stop trusting anything built against the
   * dead/unresponsive process before a single more request lands), and
   * respawns via the same `stop()`/`ensureStarted()` a manual caller would
   * use — deliberately one recovery mechanism, not a second one per
   * trigger. Any caller that calls `ensureStarted()` again while the
   * respawn is in flight (e.g. a request arriving mid-failure) joins this
   * same in-flight promise via `ensureStarted()`'s existing single-flight
   * memoization, rather than getting a stale answer or spawning a
   * duplicate.
   *
   * @param killCurrentChild For a crash, the child is already gone — killing
   * it again is a harmless no-op at best. For a detected hang, the process
   * is still alive (just unresponsive), so it must be explicitly killed
   * here or it would keep running orphaned alongside its replacement.
   */
  private triggerEmergencyRespawn(reason: EmergencyReason, detail: string, killCurrentChild: boolean): void {
    const recentOutput = this.getRecentOutput();
    this.lastEmergency = { reason, at: new Date(), recentOutput };
    console.error(
      '\n🔥🔥🔥 QUALITY CHECKING IS ON FIRE 🔥🔥🔥\n' +
        `quality-watcher-process ${detail}.\n` +
        'Every wing using it just lost live quality checking. Attempting automatic respawn now.\n' +
        `Recent output before the failure:\n${recentOutput.join('\n')}\n`
    );
    this.stopHeartbeat();
    if (killCurrentChild) this.child?.kill();
    this.child = null;
    this.starting = null;

    for (const listener of this.crashListeners) listener({ reason });

    this.ensureStarted()
      .then((baseUrl) => {
        console.error(`[quality-watcher-process] respawned successfully at ${baseUrl}.`);
        for (const listener of this.respawnListeners) listener({ reason, baseUrl });
      })
      .catch((err: unknown) => {
        console.error('[quality-watcher-process] automatic respawn FAILED — quality checking remains down:', err);
      });
  }
}
