/**
 * Test to verify model is being set correctly in session creation
 */

const baseUrl = 'http://127.0.0.1:4096';

async function testSessionModel() {
  console.log('Testing session model configuration...\n');

  // Create session with explicit model
  console.log('Creating session with model: opencode/gpt-5-nano');
  const sessionResponse = await fetch(`${baseUrl}/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Model Test Session',
      model: 'opencode/gpt-5-nano'
    }),
  });

  if (!sessionResponse.ok) {
    console.error('Failed to create session:', sessionResponse.status);
    const errorText = await sessionResponse.text();
    console.error('Error:', errorText);
    return;
  }

  const sessionData = await sessionResponse.json();
  console.log('\nSession created:');
  console.log('  ID:', sessionData.id);
  console.log('  Full response:', JSON.stringify(sessionData, null, 2));

  // Try to send a simple message
  const messageResponse = await fetch(`${baseUrl}/session/${sessionData.id}/message`, {
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

  console.log('\nMessage response status:', messageResponse.status);

  if (!messageResponse.ok) {
    const errorText = await messageResponse.text();
    console.error('Message error:', errorText);
  } else {
    const messageData = await messageResponse.json();
    console.log('Message response:', JSON.stringify(messageData, null, 2));

    if (messageData.info) {
      console.log('\nResponse info:');
      console.log('  Model ID:', messageData.info.modelID);
      console.log('  Error:', messageData.info.error);
    }
  }
}

testSessionModel().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});

export {}
