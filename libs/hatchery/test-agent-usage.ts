/**
 * Test using the hatchery-test agent in a session
 */

const baseUrl = 'http://127.0.0.1:4096';

/**
 * Shape of an agent entry returned by GET /agent.
 *
 * This is untrusted external HTTP response JSON (the OpenCode API), so only
 * the fields this script actually reads are declared.
 */
interface OpenCodeAgent {
  name: string;
  model?: string;
  description?: string;
}

async function testAgentUsage() {
  console.log('Testing hatchery-test agent...\n');

  // List agents to confirm hatchery-test exists
  console.log('1. Listing agents...');
  const agentsResponse = await fetch(`${baseUrl}/agent`);
  const agents = await agentsResponse.json() as OpenCodeAgent[];
  const hatcheryAgent = agents.find((a) => a.name === 'hatchery-test');

  if (hatcheryAgent) {
    console.log('✓ Found hatchery-test agent:');
    console.log('  Model:', hatcheryAgent.model || 'not specified');
    console.log('  Description:', hatcheryAgent.description || 'not specified');
  } else {
    console.log('✗ hatchery-test agent NOT found');
    console.log('Available agents:', agents.map((a) => a.name).join(', '));
  }

  // Create session with agent
  console.log('\n2. Creating session with agent="hatchery-test"...');
  const sessionResponse = await fetch(`${baseUrl}/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Agent Test',
      agent: 'hatchery-test'
    }),
  });

  const sessionData = await sessionResponse.json();
  console.log('Session created:', sessionData.id);

  // Send a message
  console.log('\n3. Sending message...');
  const messageResponse = await fetch(`${baseUrl}/session/${sessionData.id}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      parts: [{ type: 'text', text: 'say hello' }],
    }),
  });

  const messageData = await messageResponse.json();
  console.log('Model used:', messageData.info?.modelID);
  console.log('Provider used:', messageData.info?.providerID);
  console.log('Has error:', !!messageData.info?.error);

  if (messageData.info?.error) {
    console.log('Error:', messageData.info.error);
  } else {
    console.log('✓ Success! Message sent without error');
    if (messageData.parts?.length > 0) {
      console.log('Response:', messageData.parts[0].text.substring(0, 100));
    }
  }
}

testAgentUsage().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});

export {}
