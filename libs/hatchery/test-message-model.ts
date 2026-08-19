/**
 * Test passing model in message request instead of session creation
 */

const baseUrl = 'http://127.0.0.1:4096';

async function testMessageModel() {
  console.log('Testing model in message request...\n');

  // Create session without model
  const sessionResponse = await fetch(`${baseUrl}/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Message Model Test',
    }),
  });

  const sessionData = await sessionResponse.json();
  console.log('Session created:', sessionData.id);

  // Test 1: Pass model in message body
  console.log('\nTest 1: Passing model in message body');
  let response = await fetch(`${baseUrl}/session/${sessionData.id}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      parts: [{ type: 'text', text: 'say hello' }],
      model: 'opencode/gpt-5-nano'
    }),
  });

  let data = await response.json();
  console.log('Model used:', data.info?.modelID);
  console.log('Provider used:', data.info?.providerID);
  console.log('Has error:', !!data.info?.error);

  // Test 2: Pass modelID in message body
  console.log('\nTest 2: Passing modelID in message body');
  response = await fetch(`${baseUrl}/session/${sessionData.id}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      parts: [{ type: 'text', text: 'say hello' }],
      modelID: 'opencode/gpt-5-nano'
    }),
  });

  data = await response.json();
  console.log('Model used:', data.info?.modelID);
  console.log('Provider used:', data.info?.providerID);
  console.log('Has error:', !!data.info?.error);

  // Test 3: Pass model in parts
  console.log('\nTest 3: Passing model with providerID');
  response = await fetch(`${baseUrl}/session/${sessionData.id}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      parts: [{ type: 'text', text: 'say hello' }],
      modelID: 'gpt-5-nano',
      providerID: 'opencode'
    }),
  });

  data = await response.json();
  console.log('Model used:', data.info?.modelID);
  console.log('Provider used:', data.info?.providerID);
  console.log('Has error:', !!data.info?.error);
}

testMessageModel().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});

export {}
