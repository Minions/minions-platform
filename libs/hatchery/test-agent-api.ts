/**
 * Test if we can specify an agent when creating a session
 */

const baseUrl = 'http://127.0.0.1:4096';

async function testAgentAPI() {
  console.log('Testing agent parameter in session creation...\n');

  // Test 1: Try passing agent in session creation
  console.log('Test 1: Creating session with agent parameter');
  let response = await fetch(`${baseUrl}/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Agent Test Session',
      agent: 'hatchery-test'
    }),
  });

  let data = await response.json();
  console.log('Session created:', data.id);
  console.log('Session data:', JSON.stringify(data, null, 2));

  // Send a message to see what model it uses
  response = await fetch(`${baseUrl}/session/${data.id}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      parts: [{ type: 'text', text: 'say hello' }],
    }),
  });

  data = await response.json();
  console.log('\nMessage response:');
  console.log('Model ID:', data.info?.modelID);
  console.log('Provider ID:', data.info?.providerID);
  console.log('Has error:', !!data.info?.error);
  if (data.info?.error) {
    console.log('Error:', data.info.error);
  }
}

testAgentAPI().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});

export {}
