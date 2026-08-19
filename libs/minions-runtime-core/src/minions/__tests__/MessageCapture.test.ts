import { describe, it, expect } from 'vitest';
import { MessageCapture } from '../MessageCapture';

describe('MessageCapture', () => {
  it('creates interaction record with ID and timestamp', () => {
    const capture = new MessageCapture();
    const interaction = capture.startInteraction('user prompt here');

    // Use snapshot for structure verification (partial match)
    expect({
      userPrompt: interaction.userPrompt,
      status: interaction.status,
      responseBlocks: interaction.responseBlocks
    }).toMatchSnapshot();

    // Verify dynamic fields separately
    expect(interaction.id).toBeDefined();
    expect(interaction.timestamp).toBeGreaterThan(0);
  });

  it('separates user prompt from full request context', () => {
    const capture = new MessageCapture();
    const interaction = capture.startInteraction(
      'user prompt',
      'system context\nmore context\nuser prompt'
    );

    // Snapshot the key fields we care about
    expect({
      userPrompt: interaction.userPrompt,
      fullRequestContainsContext: interaction.fullRequest.includes('system context'),
      fullRequestContainsPrompt: interaction.fullRequest.includes('user prompt')
    }).toMatchSnapshot();
  });

  it('records response blocks of all types', () => {
    const capture = new MessageCapture();
    const interaction = capture.startInteraction('test');

    capture.addResponseBlock(interaction.id, {
      type: 'reasoning',
      content: 'thinking...'
    });
    capture.addResponseBlock(interaction.id, {
      type: 'tool_use',
      name: 'read_file',
      input: { path: '/test' }
    });
    capture.addResponseBlock(interaction.id, {
      type: 'tool_result',
      content: 'file contents'
    });
    capture.addResponseBlock(interaction.id, {
      type: 'message',
      content: 'response text'
    });

    capture.completeInteraction(interaction.id);

    const completed = capture.getInteraction(interaction.id);
    if (!completed) throw new Error('Expected completed interaction');

    // Snapshot the blocks (excluding timestamps which vary)
    expect({
      status: completed.status,
      blocks: completed.responseBlocks.map(b => ({
        type: b.type,
        content: b.content,
        name: b.name,
        input: b.input
      }))
    }).toMatchSnapshot();
  });

  it('stores interaction history per minion', () => {
    const capture = new MessageCapture();

    const int1 = capture.startInteraction('first prompt');
    capture.completeInteraction(int1.id);

    const int2 = capture.startInteraction('second prompt');
    capture.completeInteraction(int2.id);

    const history = capture.getAllInteractions();

    // Snapshot the key fields (excluding IDs and timestamps)
    expect({
      count: history.length,
      prompts: history.map(i => i.userPrompt),
      statuses: history.map(i => i.status)
    }).toMatchSnapshot();
  });
});
