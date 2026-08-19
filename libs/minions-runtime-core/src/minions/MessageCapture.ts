import { randomUUID } from 'crypto';
import { ResponseBlock } from '@minions/mcp-types';

export interface RawInteraction {
  id: string;
  timestamp: number;
  userPrompt: string;          // User-level prompt only
  fullRequest: string;          // Complete request with context
  responseBlocks: ResponseBlock[];
  status: 'pending' | 'streaming' | 'completed' | 'error';
  error?: string;
}

export class MessageCapture {
  private interactions: Map<string, RawInteraction> = new Map();
  private history: RawInteraction[] = [];

  startInteraction(userPrompt: string, fullRequest?: string): RawInteraction {
    const interaction: RawInteraction = {
      id: randomUUID(),
      timestamp: Date.now(),
      userPrompt,
      fullRequest: fullRequest || userPrompt,
      responseBlocks: [],
      status: 'pending'
    };

    this.interactions.set(interaction.id, interaction);
    this.history.push(interaction);
    return interaction;
  }

  addResponseBlock(interactionId: string, block: ResponseBlock): void {
    const interaction = this.interactions.get(interactionId);
    if (!interaction) {
      throw new Error(`Interaction ${interactionId} not found`);
    }

    interaction.responseBlocks.push({
      ...block,
      timestamp: block.timestamp || Date.now()
    });

    interaction.status = 'streaming';
  }

  completeInteraction(interactionId: string, error?: string): void {
    const interaction = this.interactions.get(interactionId);
    if (!interaction) {
      throw new Error(`Interaction ${interactionId} not found`);
    }

    interaction.status = error ? 'error' : 'completed';
    if (error) {
      interaction.error = error;
    }

    this.interactions.delete(interactionId);
  }

  getInteraction(interactionId: string): RawInteraction | undefined {
    return this.interactions.get(interactionId) ||
           this.history.find(i => i.id === interactionId);
  }

  getAllInteractions(): RawInteraction[] {
    return this.history;
  }

  getActiveInteractions(): RawInteraction[] {
    return Array.from(this.interactions.values());
  }
}
