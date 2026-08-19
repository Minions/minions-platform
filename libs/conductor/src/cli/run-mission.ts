#!/usr/bin/env node
/**
 * CLI Entry Point: Run a mission
 *
 * Phase 0 implementation that runs existing markdown missions
 * by sending a slash command to a Claude Code minion.
 *
 * Usage:
 *   npx tsx run-mission.ts --mission <name> --wing <path> [--model <model>] [--json]
 *
 * Examples:
 *   npx tsx run-mission.ts --mission refactor --wing /path/to/wing
 *   npx tsx run-mission.ts --mission assess-readiness --wing ./wing --json
 */

import { ProductionHatchery } from '@minions/hatchery';
import { TrivialRunner } from '../adapters/TrivialRunner';
import type { MissionEvent } from '../domain/MissionEvents';
import { createDiskSandbox, createLair } from '@minions/file-store';

interface CliArgs {
  mission: string;
  wing: string;
  model?: string;
  json: boolean;
  help: boolean;
}

function parseArgs(args: string[]): CliArgs {
  const result: CliArgs = {
    mission: '',
    wing: '',
    json: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case '--mission':
      case '-m':
        result.mission = args[++i] || '';
        break;
      case '--wing':
      case '-w':
        result.wing = args[++i] || '';
        break;
      case '--model':
        result.model = args[++i] || '';
        break;
      case '--json':
      case '-j':
        result.json = true;
        break;
      case '--help':
      case '-h':
        result.help = true;
        break;
    }
  }

  return result;
}

function printUsage(): void {
  console.log(`
Conductor CLI - Run a mission

Usage:
  run-mission --mission <name> --wing <path> [options]

Options:
  --mission, -m <name>    Mission name (required, sent as /<name>)
  --wing, -w <path>       Wing path where the mission runs (required)
  --model <model>         Model to use (default: claude-sonnet-4-20250514)
  --json, -j              Output events as JSON (one per line)
  --help, -h              Show this help message

Examples:
  run-mission --mission refactor --wing /path/to/wing
  run-mission -m assess-readiness -w ./wing --json
`);
}

function formatEvent(event: MissionEvent, json: boolean): string {
  if (json) {
    return JSON.stringify(event);
  }

  const time = new Date(event.timestamp).toISOString().slice(11, 19);

  switch (event.type) {
    case 'started':
      return `[${time}] 🚀 Mission "${event.missionName}" started`;
    case 'completed':
      return `[${time}] ✅ ${event.summary || 'Mission completed'}`;
    case 'failed':
      return `[${time}] ❌ Mission failed: ${event.error.message}`;
    case 'cancelled':
      return `[${time}] ⏹️  Mission cancelled: ${event.reason || 'no reason'}`;
    case 'progress':
      return `[${time}] 📝 ${event.message}`;
    case 'log': {
      const icons = { debug: '🔍', info: 'ℹ️ ', warn: '⚠️ ', error: '❌' };
      return `[${time}] ${icons[event.level]} ${event.message}`;
    }
    case 'minion-spawned':
      return `[${time}] 🤖 Minion spawned: ${event.minionId}`;
    case 'minion-message':
      return `[${time}] 💬 [${event.messageType}] ${formatContent(event.content)}`;
    case 'minion-completed':
      return `[${time}] 🏁 Minion ${event.minionId} completed`;
    default:
      return `[${time}] ${JSON.stringify(event)}`;
  }
}

function formatContent(content: unknown): string {
  if (typeof content === 'string') {
    const preview = content.slice(0, 80);
    return preview + (content.length > 80 ? '...' : '');
  }
  return JSON.stringify(content).slice(0, 80);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    process.exit(0);
  }

  if (!args.mission) {
    console.error('Error: --mission is required');
    printUsage();
    process.exit(1);
  }

  if (!args.wing) {
    console.error('Error: --wing is required');
    printUsage();
    process.exit(1);
  }

  // Create runner with production hatchery
  // Create sandbox and lair for hatchery
  const sandbox = createDiskSandbox(args.wing);
  const lair = createLair(sandbox);

  const hatchery = new ProductionHatchery(lair);
  const runner = new TrivialRunner(hatchery);

  // Start the mission
  const handle = await runner.start({
    missionName: args.mission,
    wing: args.wing,
    model: args.model,
  });

  // Subscribe to all events and print them
  const eventTypes = [
    'started',
    'completed',
    'failed',
    'cancelled',
    'progress',
    'log',
    'minion-spawned',
    'minion-message',
    'minion-completed',
  ] as const;

  for (const eventType of eventTypes) {
    handle.on(eventType, (event) => {
      console.log(formatEvent(event, args.json));
    });
  }

  // Handle Ctrl+C
  process.on('SIGINT', () => {
    console.log('\nCancelling mission...');
    handle.cancel('User interrupted');
  });

  // Wait for completion
  try {
    await handle.completion;
    process.exit(0);
  } catch (error) {
    if (error instanceof Error && error.message.includes('cancelled')) {
      process.exit(130); // Standard exit code for SIGINT
    }
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
