/**
 * Thin Express wiring only — every response body is built by a plain,
 * unit-tested function/class (health.ts, WingSignalWatchers.ts,
 * WingWatcherRegistry.ts). Nothing here has its own unit test; it's covered
 * once by manually starting the process and curling it (see the manual
 * verification note in the movement commit for this slice). Keep it that
 * way: if you need to change response *content* or start/stop/pause/resume
 * *behavior*, change the class it delegates to, not this file — that's what
 * lets this file stay untested without needing re-verification on every
 * change.
 */
import express, { type Express } from 'express';
import { toWireQualityStatus, SignalType } from '@minions/quality-watcher';
import { buildHealthResponse } from './health.js';
import { WingWatcherRegistry } from './WingWatcherRegistry.js';

const SIGNAL_TYPES: string[] = Object.values(SignalType);

/** How often to run the Tier 1 wedge check (SignalWedgeMonitor) across every watched wing. */
const WEDGE_CHECK_INTERVAL_MS = 15_000;

export function createServer(): Express {
  const app = express();
  app.use(express.json());

  const registry = new WingWatcherRegistry();
  const wedgeCheckTimer = setInterval(() => {
    registry.checkForWedges(new Date()).catch((err: unknown) => {
      console.error('[quality-watcher-process] wedge check failed:', err);
    });
  }, WEDGE_CHECK_INTERVAL_MS);
  wedgeCheckTimer.unref();

  app.get('/health', (_req, res) => {
    res.json(buildHealthResponse());
  });

  app.post('/wings/:wingName/start', (req, res) => {
    const body = req.body as { repoPaths?: Record<string, string> };
    registry
      .start(req.params.wingName, body.repoPaths ?? {})
      .then(() => res.json({ ok: true }))
      .catch((err: unknown) => {
        console.error(`[quality-watcher-process] failed to start watching wing ${req.params.wingName}:`, err);
        res.status(500).json({ error: 'Failed to start' });
      });
  });

  app.post('/wings/:wingName/stop', (req, res) => {
    registry
      .stop(req.params.wingName)
      .then(() => res.json({ ok: true }))
      .catch((err: unknown) => {
        console.error(`[quality-watcher-process] failed to stop watching wing ${req.params.wingName}:`, err);
        res.status(500).json({ error: 'Failed to stop' });
      });
  });

  app.post('/wings/:wingName/pause', (req, res) => {
    registry
      .pause(req.params.wingName)
      .then(() => res.json({ ok: true }))
      .catch((err: unknown) => {
        console.error(`[quality-watcher-process] failed to pause wing ${req.params.wingName}:`, err);
        res.status(500).json({ error: 'Failed to pause' });
      });
  });

  app.post('/wings/:wingName/resume', (req, res) => {
    registry
      .resume(req.params.wingName)
      .then(() => res.json({ ok: true }))
      .catch((err: unknown) => {
        console.error(`[quality-watcher-process] failed to resume wing ${req.params.wingName}:`, err);
        res.status(500).json({ error: 'Failed to resume' });
      });
  });

  app.get('/wings/:wingName/status', (req, res) => {
    const maxWaitMs = Number(req.query.maxWaitMs);
    const statusPromise = Number.isFinite(maxWaitMs) && maxWaitMs > 0
      ? registry.awaitStatus(req.params.wingName, maxWaitMs)
      : Promise.resolve(registry.getStatus(req.params.wingName));
    statusPromise
      .then((status) => res.json(toWireQualityStatus(status)))
      .catch((err: unknown) => {
        console.error(`[quality-watcher-process] failed to read status for wing ${req.params.wingName}:`, err);
        res.status(500).json({ error: 'Failed to read status' });
      });
  });

  // Tier 2 (see docs/design/quality-watcher-process-redesign.md): cabinet's
  // own staleness backstop calls this when it notices a signal that looks
  // stuck, naming the wing + signal (and optionally the specific repo — see
  // WingSignalWatchers.unwedge's own doc comment for why `repo` is
  // optional). Delegates straight into the same Tier-1 recovery ladder
  // Tier 1's own periodic wedge check drives, so a signal that's actually
  // healthy is always a safe no-op.
  app.post('/unwedge', (req, res) => {
    const body = req.body as { wing?: unknown; signalType?: unknown; repo?: unknown };
    if (typeof body.wing !== 'string' || typeof body.signalType !== 'string' || !SIGNAL_TYPES.includes(body.signalType)) {
      res.status(400).json({ error: 'wing (string) and signalType (a valid SignalType) are required' });
      return;
    }
    if (body.repo !== undefined && typeof body.repo !== 'string') {
      res.status(400).json({ error: 'repo, when given, must be a string' });
      return;
    }
    registry
      .unwedge(body.wing, body.signalType as SignalType, body.repo)
      .then((results) => res.json({ ok: true, results }))
      .catch((err: unknown) => {
        console.error(`[quality-watcher-process] unwedge failed for wing ${body.wing}, signal ${String(body.signalType)}:`, err);
        res.status(500).json({ error: 'Failed to unwedge' });
      });
  });

  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[quality-watcher-process] server error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
