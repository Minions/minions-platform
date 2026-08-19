/**
 * A comment is a place-anchored marker written as plain markdown text:
 * `@<tag>: <comment text>`, e.g. `@ai: rework this paragraph` or `@human: pick one`.
 * It lives at whatever block (paragraph/heading/etc.) it's written in — there is
 * no span/selection anchoring, so this is a pure text-pattern match, not a Mark.
 */
const COMMENT_MARKER_RE = /^(@([A-Za-z0-9_-]+):\s?)(.*)$/;

export interface CommentMarkerMatch {
  /** The full matched prefix, e.g. "@ai: " — this is what gets hidden behind the badge. */
  prefix: string;
  tag: string;
  text: string;
}

export function matchCommentMarker(blockText: string): CommentMarkerMatch | null {
  const match = COMMENT_MARKER_RE.exec(blockText);
  if (!match) return null;
  const [, prefix, tag, text] = match;
  return { prefix, tag, text };
}
