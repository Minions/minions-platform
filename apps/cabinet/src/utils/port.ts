import { createServer } from 'net';

/**
 * Check if a port is available
 */
async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();

    server.once('error', () => {
      resolve(false);
    });

    server.once('listening', () => {
      server.close();
      resolve(true);
    });

    server.listen(port);
  });
}

/**
 * Find an available port starting from the given port
 * Increments until an available port is found
 *
 * @param startPort - Port to start searching from
 * @param maxAttempts - Maximum number of ports to try (default: 100)
 * @returns The first available port found
 * @throws Error if no port is available within maxAttempts
 */
export async function findAvailablePort(
  startPort: number,
  maxAttempts = 100
): Promise<number> {
  for (let i = 0; i < maxAttempts; i++) {
    const port = startPort + i;
    if (await isPortAvailable(port)) {
      return port;
    }
  }

  throw new Error(
    `No available port found in range ${startPort}-${startPort + maxAttempts - 1}`
  );
}
