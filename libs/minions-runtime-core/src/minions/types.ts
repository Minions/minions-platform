/**
 * Types for Minion infrastructure
 */

import type { MinionClient } from '@minions/hatchery';
import type { EventEmitter } from 'events';
import type { MessageCapture } from './MessageCapture.js';

/**
 * Minion status enum
 */
export enum MinionStatus {
  /** Minion is ready but not actively working */
  Idle = 'idle',
  /** Minion is actively processing a task */
  Working = 'working',
  /** Minion is waiting for external input (e.g., user question) */
  Blocked = 'blocked',
  /** Minion has terminated */
  Dead = 'dead'
}

/**
 * Re-export MinionClient from hatchery for convenience
 * Supported types: claude-code, anthropic-agentic, opencode, code-puppy, brainless
 */
export type { MinionClient };

/**
 * Message in a conversation
 */
export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

/**
 * Common interface for all minion executors.
 * All executors (HatcheryMinionAdapter, SimulatedMinionExecutor, etc.)
 * must implement this interface to ensure type-safe integration.
 */
export interface MinionExecutor extends EventEmitter {
  /** Start the executor/session */
  start(): Promise<void>;

  /** Send a message to the executor */
  sendMessage(message: string): Promise<void> | void;

  /** Stop the executor/session */
  stop(): void;

  /** Check if the executor is running */
  isRunning(): boolean;

  /** Get the message capture instance for debugging/introspection */
  getMessageCapture(): MessageCapture;
}

/**
 * Minion instance
 */
export interface Minion {
  /** Unique identifier for this minion */
  id: string;

  /** Client type of minion (from hatchery) */
  client: MinionClient;

  /** Current status */
  status: MinionStatus;

  /** Wing this minion belongs to */
  wingName: string;

  /** Conversation history */
  messageHistory: Message[];

  /** When the minion was created */
  created: number;

  /** Custom agent prompt */
  agentPrompt?: string;

  /** Session ID for conversation history persistence across process restarts */
  sessionId: string;

  /** Persistent message capture that survives across executor respawns */
  messageCapture: MessageCapture;

  /** Executor instance (not serialized in JSON responses) */
  executor?: MinionExecutor;
}

/**
 * Options for creating a new minion
 */
export interface CreateMinionOptions {
  /** Client type of minion (from hatchery) */
  client: MinionClient;

  /** Wing this minion belongs to */
  wingName: string;

  /** Custom agent prompt */
  agentPrompt?: string;

  /** Optional session ID (if not provided, one will be generated) */
  sessionId?: string;
}
