/**
 * Test if we can create an agent via the HTTP API
 */

const baseUrl = 'http://127.0.0.1:4096';

async function testAgentCreate() {
  console.log('Testing agent creation via HTTP API...\n');

  // Try GET /agent to list agents
  console.log('1. Listing existing agents...');
  try {
    const response = await fetch(`${baseUrl}/agent`, { method: 'GET' });
    console.log('Status:', response.status);
    if (response.ok) {
      const data = await response.json();
      console.log('Agents:', JSON.stringify(data, null, 2));
    } else {
      console.log('Error:', await response.text());
    }
  } catch (error) {
    console.log('Error:', error instanceof Error ? error.message : String(error));
  }

  // Try POST /agent to create agent
  console.log('\n2. Creating agent via POST /agent...');
  try {
    const response = await fetch(`${baseUrl}/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'hatchery-test',
        model: 'opencode/gpt-5-nano',
        description: 'Test agent for hatchery integration tests'
      }),
    });
    console.log('Status:', response.status);
    const data = await response.json();
    console.log('Response:', JSON.stringify(data, null, 2));
  } catch (error) {
    console.log('Error:', error instanceof Error ? error.message : String(error));
  }

  // Try POST /config/agent
  console.log('\n3. Creating agent via POST /config/agent...');
  try {
    const response = await fetch(`${baseUrl}/config/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'hatchery-test',
        model: 'opencode/gpt-5-nano',
        description: 'Test agent for hatchery integration tests'
      }),
    });
    console.log('Status:', response.status);
    const data = await response.json();
    console.log('Response:', JSON.stringify(data, null, 2));
  } catch (error) {
    console.log('Error:', error instanceof Error ? error.message : String(error));
  }
}

testAgentCreate().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});

export {}
