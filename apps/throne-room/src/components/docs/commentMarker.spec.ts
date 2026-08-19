import { describe, expect, it } from 'vitest';
import { matchCommentMarker } from './commentMarker';

describe('matchCommentMarker', () => {
  it('matches a basic @tag: comment marker', () => {
    expect(matchCommentMarker('@ai: this should be reworded')).toEqual({
      prefix: '@ai: ',
      tag: 'ai',
      text: 'this should be reworded',
    });
  });

  it('matches a @human: marker', () => {
    expect(matchCommentMarker('@human: which of the following do you want?')).toEqual({
      prefix: '@human: ',
      tag: 'human',
      text: 'which of the following do you want?',
    });
  });

  it('allows a tag with dashes/underscores/digits', () => {
    expect(matchCommentMarker('@review-bot_2: looks fine')).toEqual({
      prefix: '@review-bot_2: ',
      tag: 'review-bot_2',
      text: 'looks fine',
    });
  });

  it('matches even with no space after the colon', () => {
    expect(matchCommentMarker('@ai:no space here')).toEqual({
      prefix: '@ai:',
      tag: 'ai',
      text: 'no space here',
    });
  });

  it('matches with empty comment text', () => {
    expect(matchCommentMarker('@ai: ')).toEqual({
      prefix: '@ai: ',
      tag: 'ai',
      text: '',
    });
  });

  it('does not match plain paragraph text', () => {
    expect(matchCommentMarker('This is just a normal paragraph.')).toBeNull();
  });

  it('does not match an email-like mid-sentence @ without a leading position', () => {
    expect(matchCommentMarker('Contact me @ai: not at the start')).toBeNull();
  });

  it('does not match without a colon', () => {
    expect(matchCommentMarker('@ai this has no colon')).toBeNull();
  });

  it('does not match an empty string', () => {
    expect(matchCommentMarker('')).toBeNull();
  });
});
