/**
 * Entry point — thin process bootstrapping only, not unit tested (see the
 * note atop server.ts). Listens on an OS-assigned port (0) so cabinet never
 * needs to coordinate a fixed port with this process, and announces the
 * assigned port back to cabinet as a single JSON line on stdout:
 * `{"type":"listening","port":N}`. Cabinet's spawn logic reads stdout until
 * it sees a line that parses to that shape.
 */
import { createServer } from './server.js';

const app = createServer();
const server = app.listen(0, '127.0.0.1', () => {
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : undefined;
  if (port === undefined) {
    console.error('[quality-watcher-process] failed to resolve listening port');
    process.exit(1);
  }
  console.log(JSON.stringify({ type: 'listening', port }));
});

function shutdown(): void {
  server.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
