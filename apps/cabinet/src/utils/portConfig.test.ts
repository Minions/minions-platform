import { describe, it, expect, beforeEach } from 'vitest';
import { createInMemorySandbox, type Directory, type File } from '@minions/file-store';
import { readCabinetPort, writeCabinetPort } from './portConfig.js';

describe('portConfig', () => {
  let lairDir: Directory;

  beforeEach(() => {
    const sandbox = createInMemorySandbox();
    lairDir = sandbox.root;
  });

  describe('readCabinetPort', () => {
    it('returns null when config file does not exist', async () => {
      const port = await readCabinetPort(lairDir);
      expect(port).toBeNull();
    });

    it('reads port from existing config file', async () => {
      await lairDir.createFile('cabinet.config.json', JSON.stringify({ port: 3434 }));

      const port = await readCabinetPort(lairDir);
      expect(port).toBe(3434);
    });

    it('returns null when config file is invalid JSON', async () => {
      await lairDir.createFile('cabinet.config.json', 'not valid json');

      const port = await readCabinetPort(lairDir);
      expect(port).toBeNull();
    });

    it('returns null when config file is missing port field', async () => {
      await lairDir.createFile('cabinet.config.json', JSON.stringify({ other: 'field' }));

      const port = await readCabinetPort(lairDir);
      expect(port).toBeNull();
    });
  });

  describe('writeCabinetPort', () => {
    it('creates config file with port', async () => {
      await writeCabinetPort(lairDir, 3434);

      const result = await lairDir.child('cabinet.config.json');
      expect(result.found).toBe(true);
      if (result.found && result.node.is('file')) {
        const content = await (result.node as File).read();
        const config = JSON.parse(content);
        expect(config.port).toBe(3434);
      }
    });

    it('overwrites existing config file', async () => {
      await writeCabinetPort(lairDir, 3434);
      await writeCabinetPort(lairDir, 3500);

      const result = await lairDir.child('cabinet.config.json');
      if (result.found && result.node.is('file')) {
        const content = await (result.node as File).read();
        const config = JSON.parse(content);
        expect(config.port).toBe(3500);
      }
    });
  });

  describe('round-trip', () => {
    it('writes and reads back the same port', async () => {
      await writeCabinetPort(lairDir, 4242);
      const port = await readCabinetPort(lairDir);
      expect(port).toBe(4242);
    });
  });
});
