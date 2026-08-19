import { describe, it, expect } from 'vitest';
import { generateWingClaudeMd } from '../src/lair/wing-template.js';

describe('generateWingClaudeMd', () => {
  describe('plan tool calls use the wing name from options', () => {
    const content = generateWingClaudeMd({ wingName: 'my-wing', lairName: 'test-lair' });

    it('includes the wing name in plan action=list-roots call', () => {
      expect(content).toContain('plan action=list-roots wingName=my-wing');
    });

    it('includes the wing name in plan action=get-subtree call', () => {
      expect(content).toContain('plan action=get-subtree wingName=my-wing');
    });

    it('includes the wing name in plan action=delete-subtree call', () => {
      expect(content).toContain('plan action=delete-subtree wingName=my-wing');
    });
  });
});
