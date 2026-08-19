/**
 * Test script to understand OpenCode response format
 */

const baseUrl = 'http://127.0.0.1:4096';

async function testResponse() {
  console.log('Testing OpenCode response format...\n');

  // Create session
  const sessionResponse = await fetch(`${baseUrl}/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Test Session' }),
  });

  const sessionData = await sessionResponse.json();
  const sessionId = sessionData.id;
  console.log('Session ID:', sessionId);

  // Send message with correct format
  console.log('\nSending message with parts array...');
  const messageResponse = await fetch(`${baseUrl}/session/${sessionId}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      parts: [
        {
          type: 'text',
          text: 'Say exactly "test response" and nothing else',
        },
      ],
    }),
  });

  console.log('Response status:', messageResponse.status);
  console.log('Response headers:', Object.fromEntries(messageResponse.headers.entries()));

  const responseText = await messageResponse.text();
  console.log('\nRaw response:');
  console.log(responseText);

  // Try to parse as JSON
  try {
    const responseData = JSON.parse(responseText);
    console.log('\nParsed JSON:');
    console.log(JSON.stringify(responseData, null, 2));
  } catch (error) {
    console.log('\nNot JSON or parse error:', error instanceof Error ? error.message : String(error));
  }
}

testResponse().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});

export {}
