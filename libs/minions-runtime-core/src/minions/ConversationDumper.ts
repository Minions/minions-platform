import type { Directory, File } from '@minions/file-store';
import type { Minion } from './types.js';

/**
 * Dumps conversation history to file when minion dies
 */
export class ConversationDumper {
  private readonly wingsDir: Directory;

  constructor(wingsDir: Directory) {
    this.wingsDir = wingsDir;
  }

  /**
   * Dump conversation history to JSON file
   * @returns The dump file
   */
  async dump(minion: Minion): Promise<File> {
    // Generate filename with minion ID and timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `minion-${minion.id}-${timestamp}.json`;

    // Save to wing's private/global worktree
    // Navigate: wings/[wingName]/private/global/conversations
    const wingResult = await this.wingsDir.child(minion.wingName);
    if (!wingResult.found) {
      throw new Error(`Wing not found: ${minion.wingName}`);
    }
    const wingNode = wingResult.node;
    if (!wingNode.is('directory')) {
      throw new Error(`Wing is not a directory: ${minion.wingName}`);
    }
    const wingDir = wingNode as Directory;

    // Create nested directories: private/global/conversations
    const privateDir = await wingDir.createDirectory('private');
    const globalDir = await privateDir.createDirectory('global');
    const conversationsDir = await globalDir.createDirectory('conversations');

    // Create dump data
    const dumpData = {
      minionId: minion.id,
      client: minion.client,
      status: minion.status,
      wingName: minion.wingName,
      created: minion.created,
      dumpedAt: Date.now(),
      agentPrompt: minion.agentPrompt,
      messageHistory: minion.messageHistory
    };

    // Write to file (pretty-printed)
    const file = await conversationsDir.createFile(filename, JSON.stringify(dumpData, null, '\t'));

    return file;
  }
}
