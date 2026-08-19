/**
 * Test if we can specify model in session creation or message
 */

const baseUrl = 'http://127.0.0.1:4096';

async function testModelSelection() {
  console.log('Testing model selection in OpenCode API...\n');

  // Test 1: Try passing model in session creation
  console.log('1. Creating session with model in body...');
  try {
    const response = await fetch(`${baseUrl}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Test Session',
        model: 'opencode/gpt-5-nano'
      }),
    });
    console.log('Status:', response.status);
    const data = await response.json();
    console.log('Response:', JSON.stringify(data, null, 2));
  } catch (error) {
    console.log('Error:', error instanceof Error ? error.message : String(error));
  }

  console.log('\n2. Creating session with modelID in body...');
  try {
    const response = await fetch(`${baseUrl}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Test Session 2',
        modelID: 'opencode/gpt-5-nano'
      }),
    });
    console.log('Status:', response.status);
    const data = await response.json();
    console.log('Response:', JSON.stringify(data, null, 2));
  } catch (error) {
    console.log('Error:', error instanceof Error ? error.message : String(error));
  }
}

testModelSelection().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});

export {}
