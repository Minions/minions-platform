/**
 * Test script to understand OpenCode API format
 */

const baseUrl = 'http://127.0.0.1:4097';

async function testAPI() {
  console.log('Testing OpenCode API...\n');

  // Test 1: Create session
  console.log('1. Creating session...');
  const sessionResponse = await fetch(`${baseUrl}/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Test Session' }),
  });

  console.log('Session response status:', sessionResponse.status);
  const sessionData = await sessionResponse.json();
  console.log('Session data:', JSON.stringify(sessionData, null, 2));

  if (!sessionData.id) {
    console.error('Failed to get session ID');
    return;
  }

  const sessionId = sessionData.id;
  console.log('\nSession ID:', sessionId);

  // Test 2: Try different message formats
  console.log('\n2. Testing message formats...\n');

  // Format 1: Simple role/content (Claude-like)
  console.log('Format 1: {role, content}');
  try {
    const response1 = await fetch(`${baseUrl}/session/${sessionId}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        role: 'user',
        content: 'Say hello',
      }),
    });
    console.log('Status:', response1.status);
    if (!response1.ok) {
      const error = await response1.text();
      console.log('Error:', error);
    } else {
      const data = await response1.json();
      console.log('Success:', JSON.stringify(data, null, 2));
    }
  } catch (error) {
    console.log('Error:', error instanceof Error ? error.message : String(error));
  }

  // Format 2: parts array with type/text
  console.log('\nFormat 2: {parts: [{type, text}]}');
  try {
    const response2 = await fetch(`${baseUrl}/session/${sessionId}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parts: [
          {
            type: 'text',
            text: 'Say hello',
          },
        ],
      }),
    });
    console.log('Status:', response2.status);
    if (!response2.ok) {
      const error = await response2.text();
      console.log('Error:', error);
    } else {
      const data = await response2.json();
      console.log('Success:', JSON.stringify(data, null, 2));
    }
  } catch (error) {
    console.log('Error:', error instanceof Error ? error.message : String(error));
  }

  // Format 3: Just content string
  console.log('\nFormat 3: {content: "text"}');
  try {
    const response3 = await fetch(`${baseUrl}/session/${sessionId}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'Say hello',
      }),
    });
    console.log('Status:', response3.status);
    if (!response3.ok) {
      const error = await response3.text();
      console.log('Error:', error);
    } else {
      const data = await response3.json();
      console.log('Success:', JSON.stringify(data, null, 2));
    }
  } catch (error) {
    console.log('Error:', error instanceof Error ? error.message : String(error));
  }

  // Format 4: Just message string
  console.log('\nFormat 4: {message: "text"}');
  try {
    const response4 = await fetch(`${baseUrl}/session/${sessionId}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Say hello',
      }),
    });
    console.log('Status:', response4.status);
    if (!response4.ok) {
      const error = await response4.text();
      console.log('Error:', error);
    } else {
      const data = await response4.json();
      console.log('Success:', JSON.stringify(data, null, 2));
    }
  } catch (error) {
    console.log('Error:', error instanceof Error ? error.message : String(error));
  }

  // Format 5: Just text string
  console.log('\nFormat 5: {text: "text"}');
  try {
    const response5 = await fetch(`${baseUrl}/session/${sessionId}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Say hello',
      }),
    });
    console.log('Status:', response5.status);
    if (!response5.ok) {
      const error = await response5.text();
      console.log('Error:', error);
    } else {
      const data = await response5.json();
      console.log('Success:', JSON.stringify(data, null, 2));
    }
  } catch (error) {
    console.log('Error:', error instanceof Error ? error.message : String(error));
  }
}

testAPI().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});

export {}
