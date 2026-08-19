import { describe, it, expect } from 'vitest';
import { mergeIntentions } from './IntentionMerger.js';
import { IntentionCode } from '../tools/GitCommit.js';

describe('mergeIntentions', () => {
  describe('analyzer = not_classified → trust agent', () => {
    it('feature + not_classified = feature', () => {
      expect(mergeIntentions(IntentionCode.Feature, 'not_classified')).toBe(IntentionCode.Feature);
    });
    it('bug + not_classified = bug', () => {
      expect(mergeIntentions(IntentionCode.Bug, 'not_classified')).toBe(IntentionCode.Bug);
    });
    it('plan + not_classified = plan', () => {
      expect(mergeIntentions(IntentionCode.Plan, 'not_classified')).toBe(IntentionCode.Plan);
    });
  });

  describe('analyzer = multiple → always multiple', () => {
    it('feature + multiple = multiple', () => {
      expect(mergeIntentions(IntentionCode.Feature, 'multiple')).toBe('multiple');
    });
    it('plan + multiple = multiple', () => {
      expect(mergeIntentions(IntentionCode.Plan, 'multiple')).toBe('multiple');
    });
  });

  describe('analyzer = code → compatible with feature/bug/refactor only', () => {
    it('feature + code = feature', () => {
      expect(mergeIntentions(IntentionCode.Feature, 'code')).toBe(IntentionCode.Feature);
    });
    it('bug + code = bug', () => {
      expect(mergeIntentions(IntentionCode.Bug, 'code')).toBe(IntentionCode.Bug);
    });
    it('refactor + code = refactor', () => {
      expect(mergeIntentions(IntentionCode.Refactor, 'code')).toBe(IntentionCode.Refactor);
    });
    it('test + code = multiple (code conflicts with test-only intent)', () => {
      expect(mergeIntentions(IntentionCode.Test, 'code')).toBe('multiple');
    });
    it('docs + code = multiple (code conflicts with docs-only intent)', () => {
      expect(mergeIntentions(IntentionCode.Docs, 'code')).toBe('multiple');
    });
    it('chore + code = multiple (code conflicts with chore-only intent)', () => {
      expect(mergeIntentions(IntentionCode.Chore, 'code')).toBe('multiple');
    });
    it('plan + code = multiple (code conflicts with plan-only intent)', () => {
      expect(mergeIntentions(IntentionCode.Plan, 'code')).toBe('multiple');
    });
  });

  describe('analyzer = test (supportive — subsumed by agent, overrides plan)', () => {
    it('feature + test = feature', () => {
      expect(mergeIntentions(IntentionCode.Feature, IntentionCode.Test)).toBe(IntentionCode.Feature);
    });
    it('bug + test = bug', () => {
      expect(mergeIntentions(IntentionCode.Bug, IntentionCode.Test)).toBe(IntentionCode.Bug);
    });
    it('refactor + test = refactor', () => {
      expect(mergeIntentions(IntentionCode.Refactor, IntentionCode.Test)).toBe(IntentionCode.Refactor);
    });
    it('test + test = test', () => {
      expect(mergeIntentions(IntentionCode.Test, IntentionCode.Test)).toBe(IntentionCode.Test);
    });
    it('docs + test = docs', () => {
      expect(mergeIntentions(IntentionCode.Docs, IntentionCode.Test)).toBe(IntentionCode.Docs);
    });
    it('chore + test = chore', () => {
      expect(mergeIntentions(IntentionCode.Chore, IntentionCode.Test)).toBe(IntentionCode.Chore);
    });
    it('plan + test = test (test overrides plan — plan work should not edit test files)', () => {
      expect(mergeIntentions(IntentionCode.Plan, IntentionCode.Test)).toBe(IntentionCode.Test);
    });
  });

  describe('analyzer = docs (supportive — subsumed by agent, overrides plan)', () => {
    it('feature + docs = feature', () => {
      expect(mergeIntentions(IntentionCode.Feature, IntentionCode.Docs)).toBe(IntentionCode.Feature);
    });
    it('refactor + docs = refactor', () => {
      expect(mergeIntentions(IntentionCode.Refactor, IntentionCode.Docs)).toBe(IntentionCode.Refactor);
    });
    it('docs + docs = docs', () => {
      expect(mergeIntentions(IntentionCode.Docs, IntentionCode.Docs)).toBe(IntentionCode.Docs);
    });
    it('plan + docs = docs (docs overrides plan — actual work is docs)', () => {
      expect(mergeIntentions(IntentionCode.Plan, IntentionCode.Docs)).toBe(IntentionCode.Docs);
    });
  });

  describe('analyzer = chore (supportive — subsumed by agent, overrides plan)', () => {
    it('feature + chore = feature', () => {
      expect(mergeIntentions(IntentionCode.Feature, IntentionCode.Chore)).toBe(IntentionCode.Feature);
    });
    it('chore + chore = chore', () => {
      expect(mergeIntentions(IntentionCode.Chore, IntentionCode.Chore)).toBe(IntentionCode.Chore);
    });
    it('plan + chore = chore (chore overrides plan — actual work is config changes)', () => {
      expect(mergeIntentions(IntentionCode.Plan, IntentionCode.Chore)).toBe(IntentionCode.Chore);
    });
  });

  describe('analyzer = plan → trust agent (plan is context, not a constraint)', () => {
    it('plan + plan = plan', () => {
      expect(mergeIntentions(IntentionCode.Plan, IntentionCode.Plan)).toBe(IntentionCode.Plan);
    });
    it('feature + plan = feature', () => {
      expect(mergeIntentions(IntentionCode.Feature, IntentionCode.Plan)).toBe(IntentionCode.Feature);
    });
    it('bug + plan = bug', () => {
      expect(mergeIntentions(IntentionCode.Bug, IntentionCode.Plan)).toBe(IntentionCode.Bug);
    });
    it('refactor + plan = refactor', () => {
      expect(mergeIntentions(IntentionCode.Refactor, IntentionCode.Plan)).toBe(IntentionCode.Refactor);
    });
    it('test + plan = test', () => {
      expect(mergeIntentions(IntentionCode.Test, IntentionCode.Plan)).toBe(IntentionCode.Test);
    });
    it('docs + plan = docs', () => {
      expect(mergeIntentions(IntentionCode.Docs, IntentionCode.Plan)).toBe(IntentionCode.Docs);
    });
    it('chore + plan = chore', () => {
      expect(mergeIntentions(IntentionCode.Chore, IntentionCode.Plan)).toBe(IntentionCode.Chore);
    });
  });
});
