import { describe, it, expect } from 'vitest';
import type { MinionMessage, UserMessage, TextMessage, ThinkingMessage, ToolUseMessage, ToolResultMessage, ErrorMessage, StatusMessage } from '../../src/domain/MinionMessage';

describe('Spec S1.2: MinionMessage Domain Type', () => {
  it('can create user message', () => {
    const msg: UserMessage = {
      type: 'user',
      content: 'Hello, minion!',
      timestamp: Date.now()
    };

    expect(msg.type).toBe('user');
    expect(msg.content).toBe('Hello, minion!');
    expect(msg.timestamp).toBeGreaterThan(0);
  });

  it('can create text message (assistant response)', () => {
    const msg: TextMessage = {
      type: 'text',
      content: 'Hello, human!',
      timestamp: Date.now()
    };

    expect(msg.type).toBe('text');
    expect(msg.content).toBe('Hello, human!');
  });

  it('can create tool_use message', () => {
    const msg: ToolUseMessage = {
      type: 'tool_use',
      id: 'tool-123',
      name: 'read_file',
      input: { path: '/foo/bar.ts' },
      timestamp: Date.now()
    };

    expect(msg.type).toBe('tool_use');
    expect(msg.name).toBe('read_file');
    expect(msg.id).toBe('tool-123');
  });

  it('can create tool_result message', () => {
    const msg: ToolResultMessage = {
      type: 'tool_result',
      tool_use_id: 'abc123',
      content: 'File contents here',
      timestamp: Date.now()
    };

    expect(msg.type).toBe('tool_result');
    expect(msg.tool_use_id).toBe('abc123');
  });

  it('can create status message', () => {
    const msg: StatusMessage = {
      type: 'status',
      status: 'System notification',
      timestamp: Date.now()
    };

    expect(msg.type).toBe('status');
    expect(msg.status).toBe('System notification');
  });

  it('accepts optional metadata', () => {
    const msg: UserMessage = {
      type: 'user',
      content: 'Test',
      timestamp: Date.now(),
      metadata: {
        source: 'test',
        priority: 'high'
      }
    };

    expect(msg.metadata?.source).toBe('test');
    expect(msg.metadata?.priority).toBe('high');
  });

  it('MinionMessage union covers all types', () => {
    const messages: MinionMessage[] = [
      { type: 'user', content: 'user msg', timestamp: Date.now() },
      { type: 'text', content: 'text msg', timestamp: Date.now() },
      { type: 'thinking', content: 'thinking', timestamp: Date.now() },
      { type: 'tool_use', id: 't1', name: 'tool', input: {}, timestamp: Date.now() },
      { type: 'tool_result', tool_use_id: 't1', content: 'result', timestamp: Date.now() },
      { type: 'error', error: { message: 'oops' }, timestamp: Date.now() },
      { type: 'status', status: 'ok', timestamp: Date.now() },
    ];

    expect(messages).toHaveLength(7);
  });

  it('can create thinking message', () => {
    const msg: ThinkingMessage = {
      type: 'thinking',
      content: 'I am thinking...',
      timestamp: Date.now()
    };

    expect(msg.type).toBe('thinking');
    expect(msg.content).toBe('I am thinking...');
  });

  it('can create error message', () => {
    const msg: ErrorMessage = {
      type: 'error',
      error: {
        message: 'Something went wrong',
        code: 'rate_limit'
      },
      timestamp: Date.now()
    };

    expect(msg.type).toBe('error');
    expect(msg.error.message).toBe('Something went wrong');
    expect(msg.error.code).toBe('rate_limit');
  });
});
