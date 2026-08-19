import { describe, it, expect } from 'vitest';
import { CodeExecutionSecretary } from './secretary';

describe('CodeExecutionSecretary', () => {
  it('initializes with inactive status and null lastActivity', () => {
    const secretary = new CodeExecutionSecretary();
    const status = secretary.getStatus();
    expect(status.isActive).toBe(false);
    expect(status.lastActivity).toBeNull();
  });
});
