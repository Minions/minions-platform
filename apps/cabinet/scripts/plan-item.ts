/// <reference types="node" />
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const [itemId, wing = 'workshop-00', port = '3434'] = process.argv.slice(2);
if (!itemId) {
  console.error('Usage: pnpm plan-item <item-id> [wing] [port]');
  process.exit(1);
}

const cabinetUrl = `http://localhost:${port}`;

const client = new Client({ name: 'plan-item-script', version: '0.0.1' }, { capabilities: {} });
const transport = new StreamableHTTPClientTransport(new URL(`${cabinetUrl}/mcp/henchery/${wing}`));
await client.connect(transport);

const result = await client.callTool({ name: 'plan', arguments: { action: 'get-subtree', itemId } });
await client.close();

const text = (result.content as Array<{ type: string; text?: string }>)?.[0]?.text;
if (text) {
  console.log(JSON.stringify(JSON.parse(text), null, 2));
}
