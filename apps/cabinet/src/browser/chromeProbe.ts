import type { ProbeResult } from './SharedBrowserService.js';

/** Extract the stable CDP browser GUID from a webSocketDebuggerUrl. */
export function browserIdFromWsUrl(wsUrl: string): string {
  const match = /\/devtools\/browser\/(.+)$/.exec(wsUrl);
  return match ? match[1] : wsUrl;
}

/**
 * Interpret a CDP `/json/version` HTTP response. A valid response (with the
 * `Browser` and `webSocketDebuggerUrl` fields) means a CDP Chrome is up; we carry
 * its browser identity so callers can tell *our* lair's Chrome from another's.
 * Anything else answering on the port is a foreign occupant we must not clobber.
 */
export function interpretVersion(ok: boolean, body: unknown): ProbeResult {
  if (ok && body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    if (typeof b.webSocketDebuggerUrl === 'string' && typeof b.Browser === 'string') {
      return { status: 'chrome', browserId: browserIdFromWsUrl(b.webSocketDebuggerUrl) };
    }
  }
  return { status: 'foreign' };
}

/**
 * Probe a port for a CDP endpoint by GETting `http://127.0.0.1:<port>/json/version`.
 * Connection refused / timeout → `down` (nothing reachable on this port); something
 * answering that isn't CDP → `foreign`; a CDP Chrome → `chrome` with its identity.
 */
export async function probeChrome(port: number, timeoutMs = 1000): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: controller.signal });
    let body: unknown = null;
    try {
      body = await resp.json();
    } catch {
      body = null;
    }
    return interpretVersion(resp.ok, body);
  } catch {
    // ECONNREFUSED, abort, etc. — nothing reachable on this port.
    return { status: 'down' };
  } finally {
    clearTimeout(timer);
  }
}
