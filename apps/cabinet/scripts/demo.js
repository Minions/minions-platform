#!/usr/bin/env node

/**
 * Cabinet Demo Script
 *
 * This script automates the demo setup process:
 * 1. Creates or verifies a demo wing exists
 * 2. Starts the cabinet MCP server in dev mode
 * 3. Installs the dev-and-check costume to the wing's closet
 * 4. Outputs MCP connection instructions
 *
 * Usage:
 *   node scripts/demo.js [options]
 *
 * Options:
 *   --wing-name <name>  Name for the demo wing (default: cabinet-demo)
 *   --port <port>       Port for cabinet server (default: 3000)
 *   --help              Show this help message
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Parse command line arguments
const args = process.argv.slice(2);
let wingName = 'cabinet-demo';
let port = 3000;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--wing-name' && i + 1 < args.length) {
    wingName = args[i + 1];
    i++;
  } else if (args[i] === '--port' && i + 1 < args.length) {
    port = parseInt(args[i + 1], 10);
    i++;
  } else if (args[i] === '--help') {
    console.log(`
Cabinet Demo Script

This script automates the demo setup process:
1. Creates or verifies a demo wing exists
2. Starts the cabinet MCP server in dev mode
3. Installs the dev-and-check costume to the wing's closet
4. Outputs MCP connection instructions

Usage:
  node scripts/demo.js [options]

Options:
  --wing-name <name>  Name for the demo wing (default: cabinet-demo)
  --port <port>       Port for cabinet server (default: 3000)
  --help              Show this help message
`);
    process.exit(0);
  }
}

// Determine lair root - go up from apps/cabinet/scripts to wings/workshop-00 then to lair root
const cabinetDir = resolve(__dirname, '..');
const workLocalDir = resolve(cabinetDir, '../..');
const workshopWingDir = resolve(workLocalDir, '../..');
const wingsDir = resolve(workshopWingDir, '..');
const lairRoot = resolve(wingsDir, '..');

console.log('='.repeat(70));
console.log('Cabinet Demo Setup');
console.log('='.repeat(70));
console.log();
console.log(`Lair root: ${lairRoot}`);
console.log(`Wing name: ${wingName}`);
console.log(`Port: ${port}`);
console.log();

// Set environment variables for cabinet
process.env.LAIR_ROOT = lairRoot;
process.env.CABINET_PORT = port.toString();

console.log('Starting cabinet server in dev mode...');
console.log('(Cabinet will handle wing creation and costume installation)');
console.log();

// Start cabinet in dev mode
const cabinetProcess = spawn('pnpm', ['dev'], {
  cwd: cabinetDir,
  stdio: 'inherit',
  shell: true,
  env: process.env
});

// Handle process exit
cabinetProcess.on('exit', (code) => {
  console.log(`\nCabinet server exited with code ${code}`);
  process.exit(code || 0);
});

// Handle Ctrl+C gracefully
process.on('SIGINT', () => {
  console.log('\nShutting down cabinet server...');
  cabinetProcess.kill('SIGINT');
});

// Wait a bit for server to start, then show connection instructions
setTimeout(() => {
  console.log();
  console.log('='.repeat(70));
  console.log('MCP Connection Instructions');
  console.log('='.repeat(70));
  console.log();
  console.log('Cabinet MCP server is running. Available endpoints:');
  console.log(`  /mcp/henchery  - http://localhost:${port}/mcp/henchery  (movement tools for minions)`);
  console.log(`  /mcp/lair      - http://localhost:${port}/mcp/lair      (archive + costume tools)`);
  console.log(`  /mcp/conductor - http://localhost:${port}/mcp/conductor (wing + minion + mission tools)`);
  console.log(`  /mcp/throne    - http://localhost:${port}/mcp/throne    (read-only state + question tools)`);
  console.log();
  console.log('To connect from Claude Desktop or other MCP clients:');
  console.log();
  console.log('1. Add this configuration to your MCP client (choose the endpoint for your use case):');
  console.log();
  console.log('   {');
  console.log('     "mcpServers": {');
  console.log('       "cabinet": {');
  console.log(`         "url": "http://localhost:${port}/mcp/conductor"`);
  console.log('       }');
  console.log('     }');
  console.log('   }');
  console.log();
  console.log('2. Available MCP tools include:');
  console.log('   - lair_get_state: Get lair configuration and wings');
  console.log('   - wings_create: Create a new wing');
  console.log('   - costumes_debug_install: Install costume to wing closet');
  console.log('   - mission_start: Start a mission from an installed costume');
  console.log('   - And many more...');
  console.log();
  console.log('3. To install dev-and-check costume automatically:');
  console.log('   Run this command in a new terminal:');
  console.log();
  console.log(`     node scripts/install-costume.js --target-wing ${wingName} --port ${port}`);
  console.log();
  console.log('   Or manually use MCP tool: costumes_debug_install');
  console.log('   Parameters:');
  console.log('     - wingName: "workshop-00" (source wing with costume)');
  console.log('     - costumePath: "costumes/dev-and-check"');
  console.log('     - installedName: "dev-and-check"');
  console.log(`     - targetWingName: "${wingName}" (target wing for debug install)`);
  console.log();
  console.log('Press Ctrl+C to stop the server');
  console.log('='.repeat(70));
  console.log();
}, 3000);
