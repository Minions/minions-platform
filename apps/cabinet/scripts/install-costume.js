#!/usr/bin/env node

/**
 * Install Costume via MCP
 *
 * This script calls the cabinet MCP server to install a costume to a wing's closet.
 * Run this after starting the cabinet server with demo.js
 *
 * Usage:
 *   node scripts/install-costume.js [options]
 *
 * Options:
 *   --source-wing <name>     Wing containing the costume source (default: workshop-00)
 *   --costume-path <path>    Path within work/local (default: costumes/dev-and-check)
 *   --costume-name <name>    Name to install as (default: dev-and-check)
 *   --target-wing <name>     Wing to install into (default: cabinet-demo)
 *   --port <port>            Cabinet server port (default: 3000)
 *   --help                   Show this help message
 */

import { MCPClient } from './lib/mcp-client.js';

// Parse command line arguments
const args = process.argv.slice(2);
let sourceWing = 'workshop-00';
let costumePath = 'costumes/dev-and-check';
let costumeName = 'dev-and-check';
let targetWing = 'cabinet-demo';
let port = 3000;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--source-wing' && i + 1 < args.length) {
    sourceWing = args[i + 1];
    i++;
  } else if (args[i] === '--costume-path' && i + 1 < args.length) {
    costumePath = args[i + 1];
    i++;
  } else if (args[i] === '--costume-name' && i + 1 < args.length) {
    costumeName = args[i + 1];
    i++;
  } else if (args[i] === '--target-wing' && i + 1 < args.length) {
    targetWing = args[i + 1];
    i++;
  } else if (args[i] === '--port' && i + 1 < args.length) {
    port = parseInt(args[i + 1], 10);
    i++;
  } else if (args[i] === '--help') {
    console.log(`
Install Costume via MCP

This script calls the cabinet MCP server to install a costume to a wing's closet.
Run this after starting the cabinet server with demo.js

Usage:
  node scripts/install-costume.js [options]

Options:
  --source-wing <name>     Wing containing the costume source (default: workshop-00)
  --costume-path <path>    Path within work/local (default: costumes/dev-and-check)
  --costume-name <name>    Name to install as (default: dev-and-check)
  --target-wing <name>     Wing to install into (default: cabinet-demo)
  --port <port>            Cabinet server port (default: 3000)
  --help                   Show this help message
`);
    process.exit(0);
  }
}

console.log('='.repeat(70));
console.log('Installing Costume via Cabinet MCP');
console.log('='.repeat(70));
console.log();
console.log(`Source wing: ${sourceWing}`);
console.log(`Costume path: ${costumePath}`);
console.log(`Costume name: ${costumeName}`);
console.log(`Target wing: ${targetWing}`);
console.log(`Cabinet port: ${port}`);
console.log();

// Create MCP clients for each endpoint
const throneClient = new MCPClient({ port, path: '/mcp/throne' });
const conductorClient = new MCPClient({ port, path: '/mcp/conductor' });
const lairClient = new MCPClient({ port, path: '/mcp/lair' });

async function run() {
  try {
    // Step 1: Initialize MCP sessions
    console.log('Step 1: Initializing MCP sessions...');
    await Promise.all([
      throneClient.initialize({ name: 'cabinet-demo-installer-throne', version: '1.0.0' }),
      conductorClient.initialize({ name: 'cabinet-demo-installer-conductor', version: '1.0.0' }),
      lairClient.initialize({ name: 'cabinet-demo-installer-lair', version: '1.0.0' }),
    ]);

    console.log(`✓ Sessions initialized`);
    console.log();

    // Step 2: Check if target wing exists
    console.log('Step 2: Checking if target wing exists...');

    const lairState = await throneClient.callTool('lair_get_state', {}, 2);
    const targetWingExists = lairState.wings.some(w => w.name === targetWing);

    if (!targetWingExists) {
      console.log(`✗ Target wing "${targetWing}" does not exist`);
      console.log();
      console.log('Creating target wing...');

      await conductorClient.callTool('wings', {
        action: 'create',
        name: targetWing,
        workLocalRepo: 'minions',
        description: 'Demo wing for cabinet costume installation'
      }, 3);

      console.log(`✓ Created wing: ${targetWing}`);
    } else {
      console.log(`✓ Target wing exists: ${targetWing}`);
    }
    console.log();

    // Step 3: Install costume
    console.log('Step 3: Installing costume...');

    const installData = await lairClient.callTool('costumes_debug_install', {
      wingName: sourceWing,
      costumePath: costumePath,
      installedName: costumeName,
      targetWingName: targetWing
    }, 4);

    console.log(`✓ Costume installed successfully`);
    console.log();
    console.log('Installation details:');
    console.log(`  Closet path: ${installData.closetPath}`);
    if (installData.commandsPath) {
      console.log(`  Commands: ${installData.commandsPath}`);
    }
    if (installData.agentsPath) {
      console.log(`  Agents: ${installData.agentsPath}`);
    }
    if (installData.skillsPath) {
      console.log(`  Skills: ${installData.skillsPath}`);
    }
    console.log();
    console.log('='.repeat(70));
    console.log('Costume Installation Complete!');
    console.log('='.repeat(70));
    console.log();
    console.log(`The "${costumeName}" costume is now available in wing "${targetWing}"`);
    console.log();
    console.log('To list available missions:');
    console.log(`  Use MCP tool: missions with action: "list", wingName: "${targetWing}"`);
    console.log();
    console.log('To start the orchestrate mission:');
    console.log(`  Use MCP tool: missions with action: "start",`);
    console.log(`    wingName: "${targetWing}"`);
    console.log(`    costume: "${costumeName}"`);
    console.log(`    mission: "orchestrate"`);
    console.log();

  } catch (error) {
    console.error();
    console.error('✗ Error:', error.message);
    console.error();
    console.error('Make sure cabinet server is running (use: node scripts/demo.js)');
    process.exit(1);
  }
}

run();
