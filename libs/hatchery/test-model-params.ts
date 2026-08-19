/**
 * Test different model parameter formats
 */

const baseUrl = 'http://127.0.0.1:4096';

async function testModelParams() {
  console.log('Testing different model parameter formats...\n');

  // Test 1: model parameter
  console.log('Test 1: {model: "opencode/gpt-5-nano"}');
  let response = await fetch(`${baseUrl}/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Test 1',
      model: 'opencode/gpt-5-nano'
    }),
  });
  let data = await response.json();
  console.log('Session created:', data.id);

  // Send message to see what model it uses
  response = await fetch(`${baseUrl}/session/${data.id}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      parts: [{ type: 'text', text: 'test' }],
    }),
  });
  data = await response.json();
  console.log('Model used:', data.info?.modelID);
  console.log('Provider used:', data.info?.providerID);
  console.log('');

  // Test 2: modelID parameter
  console.log('Test 2: {modelID: "opencode/gpt-5-nano"}');
  response = await fetch(`${baseUrl}/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Test 2',
      modelID: 'opencode/gpt-5-nano'
    }),
  });
  data = await response.json();
  console.log('Session created:', data.id);

  response = await fetch(`${baseUrl}/session/${data.id}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      parts: [{ type: 'text', text: 'test' }],
    }),
  });
  data = await response.json();
  console.log('Model used:', data.info?.modelID);
  console.log('Provider used:', data.info?.providerID);
  console.log('');

  // Test 3: Both model and provider
  console.log('Test 3: {modelID: "gpt-5-nano", providerID: "zen"}');
  response = await fetch(`${baseUrl}/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Test 3',
      modelID: 'gpt-5-nano',
      providerID: 'zen'
    }),
  });
  data = await response.json();
  console.log('Session created:', data.id);

  response = await fetch(`${baseUrl}/session/${data.id}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      parts: [{ type: 'text', text: 'test' }],
    }),
  });
  data = await response.json();
  console.log('Model used:', data.info?.modelID);
  console.log('Provider used:', data.info?.providerID);
  console.log('');

  // Test 4: Just gpt-5-nano
  console.log('Test 4: {modelID: "gpt-5-nano"}');
  response = await fetch(`${baseUrl}/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Test 4',
      modelID: 'gpt-5-nano'
    }),
  });
  data = await response.json();
  console.log('Session created:', data.id);

  response = await fetch(`${baseUrl}/session/${data.id}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      parts: [{ type: 'text', text: 'test' }],
    }),
  });
  data = await response.json();
  console.log('Model used:', data.info?.modelID);
  console.log('Provider used:', data.info?.providerID);
}

testModelParams().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});

export {}
