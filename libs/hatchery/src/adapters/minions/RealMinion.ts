import { Effect } from 'effect';
import type { IMinion, MessageFilter, MinionSpec, MinionMessage } from '@minions/domain-types';
import { ReconfigureError, workbenchToSyntheticHistory } from '@minions/domain-types';
import type { ExecutableGadget, ToolResult } from '@minions/gadgets';
import type { IMinionClient } from '../../ports/IMinionClient';
import type { Costume } from '../../domain';
import type { MinionSpecWithExtensions } from '../../domain/MinionSpecExtensions';

/**
 * Real minion implementation that wraps an IMinionClient
 *
 * RealMinion delegates all communication to the underlying client (Claude Code, Anthropic, etc.)
 * It provides the IMinion interface while the client handles the actual communication protocol.
 */
export class RealMinion implements IMinion {
  readonly id: string;
  readonly spec: MinionSpec;
  private _costume?: Costume;
  private _status: 'processing' | 'waiting' | 'dead' = 'waiting';
  private client: IMinionClient;
  private readonly executableGadgets: ExecutableGadget[];
  constructor(spec: MinionSpec, client: IMinionClient, executableGadgets?: ExecutableGadget[]) {
    this.spec = spec;
    this.client = client;
    this._costume = spec.costume;
    this.executableGadgets = executableGadgets ?? [];
    this.id = `real-${Math.random().toString(36).substring(2, 11)}`;
  }

  /**
   * Get current processing status
   */
  get status(): 'processing' | 'waiting' | 'dead' {
    return this._status;
  }

  /**
   * Get current costume configuration
   */
  get costume(): Costume | undefined {
    return this._costume;
  }

  /**
   * Get workbench for shared context
   */
  get workbench() {
    return (this.spec as MinionSpecWithExtensions).workbench;
  }

  async send(message: MinionMessage): Promise<void> {
    this._status = 'processing';
    await this.client.send(message);
  }

  receive(filter?: MessageFilter): AsyncIterableIterator<MinionMessage> {
    // For now, we don't support filtering at the RealMinion level
    // The client's receive() returns all messages
    // TODO: Implement filtering by wrapping the client's iterator
    if (filter) {
      return this.filteredReceive(filter);
    }
    return this.client.receive();
  }

  private async *filteredReceive(filter: MessageFilter): AsyncIterableIterator<MinionMessage> {
    const types = filter.types || (filter.type ? [filter.type] : null);

    for await (const message of this.client.receive()) {
      if (!types || types.includes(message.type)) {
        yield message;
      }
    }
  }

  /**
   * IMinion interface: Reconfigure the minion with a new costume
   *
   * Completely replaces the current costume with the provided costume.
   * This is a complete replacement operation - no merging or blending.
   *
   * Validates that model is not changed (throws ReconfigureError if attempted).
   *
   * IMPORTANT: This restarts the underlying client with the new configuration.
   * Conversation history is NOT preserved across reconfigures.
   *
   * @param costume - Complete costume to replace the current costume with
   * @returns Effect that succeeds with void or fails with ReconfigureError
   */
  reconfigure(costume: Costume): Effect.Effect<void, ReconfigureError, never> {
    return Effect.gen(this, function* () {
      // If no costume exists yet, we can't reconfigure
      if (!this._costume) {
        return yield* Effect.fail(
          new ReconfigureError({
            reason: 'Cannot reconfigure minion without initial costume',
            minionId: this.id,
          })
        );
      }

      // Note: Model changes are allowed - the client will be restarted with the new model
      // This enables switching between models (e.g., sonnet for coding, haiku for simple tasks)

      // Update internal costume state
      this._costume = costume;

      // Build new spec with costume fields
      const newSpec = this.buildSpecFromCostume(costume);

      // Restart client with new configuration
      yield* Effect.tryPromise({
        try: async () => {
          await this.client.stop();
          await this.client.start(newSpec);
        },
        catch: (error) => new ReconfigureError({
          reason: `Failed to restart client: ${error}`,
          minionId: this.id,
        }),
      });

      return yield* Effect.succeed(undefined);
    });
  }

  /**
   * Build a new MinionSpec from a costume
   *
   * Combines the original spec's non-costume fields with the new costume's fields.
   * Preserves workbench reference and regenerates syntheticHistory if applicable.
   */
  private buildSpecFromCostume(costume: Costume): MinionSpec {
    const originalSpec = this.spec as MinionSpecWithExtensions;

    // Build base spec
    const newSpec: MinionSpecWithExtensions = {
      // Preserve original non-costume fields
      client: this.spec.client,
      wing: this.spec.wing,
      useBuiltInSystemPrompt: false, // Custom prompt from costume

      // Apply costume fields
      model: costume.model,
      agentPrompt: costume.systemPrompt,
      tools: costume.gadgets,

      // Preserve original metadata
      name: this.spec.name,
      metadata: this.spec.metadata,

      // Store new costume reference
      costume: costume,
    };

    // Preserve workbench reference from original spec
    if (originalSpec.workbench) {
      newSpec.workbench = originalSpec.workbench;

      // Regenerate syntheticHistory if costume has injectFacts
      if (costume.injectFacts && costume.injectFacts.length > 0) {
        newSpec.syntheticHistory = workbenchToSyntheticHistory(
          originalSpec.workbench,
          costume.injectFacts
        );
      }
    }

    return newSpec;
  }

  kill(): void {
    this._status = 'dead';
    this.client.kill();
  }

  interrupt(): void {
    this.client.interrupt();
  }

  /**
   * Execute a gadget by name with the provided input
   *
   * This method looks up the gadget by tool name and executes it synchronously,
   * returning the ToolResult. The Effect is run immediately and blocks until
   * complete.
   *
   * @param toolName - Name of the tool/gadget to execute
   * @param input - Input parameters for the gadget
   * @returns Effect that produces ToolResult (never fails)
   */
  executeGadget(toolName: string, input: unknown): Effect.Effect<ToolResult, never, never> {
    const gadget = this.executableGadgets.find(g => g.tool.name === toolName);

    if (!gadget) {
      return Effect.succeed({
        success: false,
        error: `No executable gadget found with name: ${toolName}`
      });
    }

    return gadget.execute(input);
  }
}
