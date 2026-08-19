/**
 * Builds the MCP `initialize` handshake's identity fields — `serverInfo.name`
 * and `instructions` — so a client (human or model) can tell, from the very
 * first response of a session, whether it's talking to production or a wing's
 * dev instance, and self-correct if it's the wrong one.
 */

export const PRODUCT_NAME = 'Minions Platform';

const PURPOSE =
  'Cabinet is the Minions Platform backend, exposing plan, movement, docs, and wing-management tools over MCP.';

export interface ServerIdentityOptions {
  isDevMode: boolean;
  /** Lair directory name (production instances control one whole lair). */
  lairName?: string;
  /** Wing name (dev instances control one wing within a lair). */
  wingName?: string;
}

export function buildServerInstructions(opts: ServerIdentityOptions): string {
  if (opts.isDevMode) {
    const wing = opts.wingName ?? 'an unknown wing';
    return (
      `${PURPOSE} This instance is running in DEV mode, with hot module reload, ` +
      `controlling wing "${wing}". Code changes made in that wing's checkout are reflected here live.`
    );
  }

  const lair = opts.lairName ?? 'an unknown lair';
  return (
    `${PURPOSE} This instance is running in PRODUCTION, controlling lair "${lair}". ` +
    'It does not support hot module reload and is meant for running production activities, ' +
    'not developing new cabinet capabilities. Use a dev-mode server for debugging.'
  );
}
