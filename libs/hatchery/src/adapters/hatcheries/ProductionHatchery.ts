import type { IHatchery } from '../../ports/IHatchery';
import type { MinionSpec, IMinion } from '@minions/domain-types';
import type { IMinionClient } from '../../ports/IMinionClient';
import { RealMinion } from '../minions/RealMinion';
import { ClaudeCodeClient } from '../clients/ClaudeCodeClient';
import { OpenCodeClient } from '../clients/OpenCodeClient';
import { extractExecutableGadgets } from './helpers';
import type { Lair } from '@minions/file-store';

/**
 * Production hatchery that creates real minions with actual AI clients
 *
 * Creates minions using real client implementations based on the spec's client type:
 * - 'claude-code' -> ClaudeCodeClient
 * - 'opencode' -> OpenCodeClient
 * - 'anthropic-agentic' -> AnthropicAgenticClient (TODO)
 * - 'code-puppy' -> CodePuppyClient (TODO)
 */
export class ProductionHatchery implements IHatchery {
  private lair: Lair | undefined;

  constructor(lair?: Lair) {
    this.lair = lair;
  }

  async spawn(spec: MinionSpec): Promise<IMinion> {
    // Create the appropriate client based on spec.client
    let client: IMinionClient;

    switch (spec.client) {
      case 'claude-code':
        client = new ClaudeCodeClient();
        break;

      case 'opencode':
        if (!this.lair) {
          throw new Error('OpenCodeClient requires a Lair - provide one in the ProductionHatchery constructor');
        }
        client = new OpenCodeClient(this.lair);
        break;

      case 'anthropic-agentic':
        throw new Error('AnthropicAgenticClient not yet implemented');

      case 'code-puppy':
        throw new Error('CodePuppyClient not yet implemented');

      case 'brainless':
        throw new Error('Use ZombieHatchery for brainless minions');

      default:
        throw new Error(`Unknown client type: ${spec.client}`);
    }

    // Start the client
    await client.start(spec);

    // Extract executable gadgets from spec (if it's an ExtendedMinionSpec)
    const executableGadgets = extractExecutableGadgets(spec);

    // Wrap in RealMinion with executable gadgets
    return new RealMinion(spec, client, executableGadgets);
  }
}
