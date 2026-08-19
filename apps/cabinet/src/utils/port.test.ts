import { describe, it, expect } from 'vitest';
import { createServer } from 'net';
import { findAvailablePort } from './port.js';

describe('findAvailablePort', () => {
  it('finds available port starting from given port', async () => {
    const port = await findAvailablePort(40000);

    expect(port).toBeGreaterThanOrEqual(40000);
    expect(port).toBeLessThan(40100);
  });

  it('skips occupied ports and finds next available', async () => {
    // Create a server on port 40100
    const blockedServer = createServer();
    await new Promise<void>((resolve) => {
      blockedServer.listen(40100, () => resolve());
    });

    try {
      // Should find port 40101 since 40100 is occupied
      const port = await findAvailablePort(40100);

      expect(port).toBe(40101);
    } finally {
      blockedServer.close();
    }
  });

  it('skips multiple occupied ports', async () => {
    // Create servers on ports 40200, 40201, 40202
    const servers = [
      createServer(),
      createServer(),
      createServer()
    ];

    await Promise.all([
      new Promise<void>((resolve) => servers[0].listen(40200, () => resolve())),
      new Promise<void>((resolve) => servers[1].listen(40201, () => resolve())),
      new Promise<void>((resolve) => servers[2].listen(40202, () => resolve()))
    ]);

    try {
      // Should find port 40203
      const port = await findAvailablePort(40200);

      expect(port).toBe(40203);
    } finally {
      servers.forEach(s => s.close());
    }
  });

  it('throws error when no port available within max attempts', async () => {
    // Create servers on 5 consecutive ports
    const servers = Array.from({ length: 5 }, () => createServer());

    await Promise.all(
      servers.map((server, i) =>
        new Promise<void>((resolve) => server.listen(40300 + i, () => resolve()))
      )
    );

    try {
      // Try with maxAttempts=5, should fail since all are occupied
      await expect(
        findAvailablePort(40300, 5)
      ).rejects.toThrow('No available port found in range 40300-40304');
    } finally {
      servers.forEach(s => s.close());
    }
  });
});
