import { beforeEach, describe, expect, it } from 'vitest';
import { ConversationDumper } from './ConversationDumper.js';
import { type Minion, MinionStatus } from './types.js';
import { createInMemorySandbox, type Sandbox, type Directory } from '@minions/file-store';
import { MessageCapture } from './MessageCapture.js';

describe('ConversationDumper', () => {
  let sandbox: Sandbox;
  let wingsDir: Directory;
  let dumper: ConversationDumper;

  beforeEach(async () => {
    // Create in-memory sandbox with wings directory
    sandbox = createInMemorySandbox();
    wingsDir = await sandbox.root.createDirectory('wings');
    // Pre-create the wing directories for tests
    await wingsDir.createDirectory('test-wing');
    await wingsDir.createDirectory('my-wing');
    dumper = new ConversationDumper(wingsDir);
  });

  describe('dump', () => {
    it('creates dump file with correct content', async () => {
      const minion: Minion = {
        id: 'test-minion-1',
        client: 'claude-code',
        status: MinionStatus.Dead,
        wingName: 'test-wing',
        messageHistory: [
          { role: 'user', content: 'Hello', timestamp: 1000 },
          { role: 'assistant', content: 'Hi!', timestamp: 2000 },
        ],
        created: 500,
        sessionId: 'session-1',
        messageCapture: new MessageCapture(),
      };

      const dumpFile = await dumper.dump(minion);

      // Verify file exists and read content
      const content = await dumpFile.read();
      const data = JSON.parse(content);

      expect(data.minionId).toBe('test-minion-1');
      expect(data.client).toBe('claude-code');
      expect(data.wingName).toBe('test-wing');
      expect(data.messageHistory).toHaveLength(2);
      expect(data.messageHistory[0].content).toBe('Hello');
    });

    it('includes all minion metadata', async () => {
      const minion: Minion = {
        id: 'test-minion-2',
        client: 'anthropic-agentic',
        status: MinionStatus.Dead,
        wingName: 'test-wing',
        messageHistory: [],
        created: 1000,
        agentPrompt: 'Custom prompt',
        sessionId: 'session-2',
        messageCapture: new MessageCapture(),
      };

      const dumpFile = await dumper.dump(minion);
      const content = await dumpFile.read();
      const data = JSON.parse(content);

      expect(data.created).toBe(1000);
      expect(data.dumpedAt).toBeGreaterThan(0);
      expect(data.agentPrompt).toBe('Custom prompt');
    });

    it('generates unique filename with timestamp', async () => {
      const minion: Minion = {
        id: 'test-minion-3',
        client: 'claude-code',
        status: MinionStatus.Dead,
        wingName: 'test-wing',
        messageHistory: [],
        created: 1000,
        sessionId: 'session-3',
        messageCapture: new MessageCapture(),
      };

      const dumpFile = await dumper.dump(minion);

      expect(dumpFile.name).toContain('minion-test-minion-3');
      expect(dumpFile.name).toMatch(/\d{4}-\d{2}-\d{2}/); // Contains date
    });

    it('creates conversations directory if needed', async () => {
      const minion: Minion = {
        id: 'test-minion-4',
        client: 'claude-code',
        status: MinionStatus.Dead,
        wingName: 'test-wing',
        messageHistory: [],
        created: 1000,
        sessionId: 'session-4',
        messageCapture: new MessageCapture(),
      };

      await dumper.dump(minion);

      // Verify directory structure was created
      const wingResult = await wingsDir.child('test-wing');
      expect(wingResult.found).toBe(true);
      if (wingResult.found && wingResult.node.is('directory')) {
        const privateResult = await (wingResult.node as Directory).child('private');
        expect(privateResult.found).toBe(true);
      }
    });

    it('creates pretty-printed JSON', async () => {
      const minion: Minion = {
        id: 'test-minion-5',
        client: 'claude-code',
        status: MinionStatus.Dead,
        wingName: 'test-wing',
        messageHistory: [{ role: 'user', content: 'Test', timestamp: 1000 }],
        created: 500,
        sessionId: 'session-5',
        messageCapture: new MessageCapture(),
      };

      const dumpFile = await dumper.dump(minion);
      const content = await dumpFile.read();

      // Check for indentation (pretty-printed)
      expect(content).toContain('\n\t');
      expect(content).toContain('"minionId"');
    });

    /**
     * CRITICAL REGRESSION TEST
     * Verifies dumps are saved to wing's private/global worktree,
     * NOT to lairRoot/private/global (which is a bare repo without a worktree).
     *
     * Bug history:
     * - Previous implementation tried to save to private/global first
     * - private/global is a bare repo, cannot write files there
     * - This caused dumps to fail or be saved to the wrong location
     */
    it('saves to wing private/global conversations directory', async () => {
      const minion: Minion = {
        id: 'test-minion-6',
        client: 'claude-code',
        status: MinionStatus.Dead,
        wingName: 'my-wing',
        messageHistory: [],
        created: 1000,
        sessionId: 'session-6',
        messageCapture: new MessageCapture(),
      };

      const dumpFile = await dumper.dump(minion);

      // Verify the file is in the correct location
      // Navigate to: wings/my-wing/private/global/conversations
      const myWingResult = await wingsDir.child('my-wing');
      expect(myWingResult.found).toBe(true);
      if (myWingResult.found && myWingResult.node.is('directory')) {
        const privateResult = await (myWingResult.node as Directory).child('private');
        expect(privateResult.found).toBe(true);
        if (privateResult.found && privateResult.node.is('directory')) {
          const globalResult = await (privateResult.node as Directory).child('global');
          expect(globalResult.found).toBe(true);
          if (globalResult.found && globalResult.node.is('directory')) {
            const convResult = await (globalResult.node as Directory).child('conversations');
            expect(convResult.found).toBe(true);
            if (convResult.found && convResult.node.is('directory')) {
              const fileResult = await (convResult.node as Directory).child(dumpFile.name);
              expect(fileResult.found).toBe(true);
            }
          }
        }
      }

      // Verify file content
      const content = await dumpFile.read();
      const data = JSON.parse(content);
      expect(data.minionId).toBe('test-minion-6');
    });
  });
});
