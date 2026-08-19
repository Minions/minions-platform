import { FileType } from '../../risk/ChangeAnalyzer.js';
import { hashContent } from '../apply.js';
import { getFileClassification } from '../detectors/FileClassifierDetector.js';
import type { PipelineContext, Recognizer, Verdict, Evidence, TextChange, AdviceChange } from '../types.js';

/**
 * A comment counts as "explains something non-obvious" (and is kept) if it
 * contains any of these markers. Anything else that merely restates the
 * identifiers on the very next line is low-value.
 */
const NON_OBVIOUS_MARKERS = [
  'because', 'workaround', 'hack', 'note:', 'important', 'constraint',
  'invariant', 'bug', 'todo', 'fixme', 'why', 'caution', 'warning', 'see ',
  'https://', 'http://',
];

const LINE_COMMENT = /^(\s*)\/\/\s*(.+?)\s*$/;

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .replace(/[_-]/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4),
  );
}

/** Heuristic stand-in for an AI judgment call — see docs/design/commit-check-pipeline.md. */
function restatesNextLine(commentText: string, nextLine: string): boolean {
  const lower = commentText.toLowerCase();
  if (NON_OBVIOUS_MARKERS.some((m) => lower.includes(m))) return false;

  const commentWords = tokenize(commentText);
  if (commentWords.size === 0) return false;

  const codeWords = tokenize(nextLine);
  if (codeWords.size === 0) return false;

  let overlap = 0;
  for (const w of commentWords) if (codeWords.has(w)) overlap++;
  return overlap / commentWords.size >= 0.5;
}

interface FoundComment {
  lineStart: number;
  lineEnd: number;
  text: string;
}

function findLowValueComments(content: string): FoundComment[] {
  const lines = content.split('\n');
  const found: FoundComment[] = [];
  let offset = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineLength = line.length + (i < lines.length - 1 ? 1 : 0); // +1 for '\n', except possibly last line
    const match = LINE_COMMENT.exec(line);
    const nextLine = lines[i + 1];

    if (match && nextLine !== undefined && nextLine.trim().length > 0 && !LINE_COMMENT.exec(nextLine)) {
      if (restatesNextLine(match[2], nextLine)) {
        found.push({ lineStart: offset, lineEnd: offset + lineLength, text: match[2] });
      }
    }

    offset += lineLength;
  }

  return found;
}

/**
 * AI-tier Recognizer: strips comments that don't clear a high bar (explains
 * something non-obvious) as a first-class text edit, plus advice explaining
 * what was removed and why. See docs/design/commit-check-pipeline.md
 * "Why this exists".
 */
export class CommentQualityRecognizer implements Recognizer {
  readonly id = 'comment-quality';
  readonly kind = 'ai' as const;

  async recognize(ctx: PipelineContext, evidence: Evidence[]): Promise<Verdict> {
    const classification = getFileClassification(evidence);
    const changes: (TextChange | AdviceChange)[] = [];
    let removedCount = 0;

    for (const file of ctx.changedFiles) {
      if (classification && classification[file] !== FileType.Code) continue;

      const found = await ctx.worktree.child(file);
      if (!found.found || found.node.kind !== 'file') continue;

      const content = await found.node.read();
      const baseContentHash = hashContent(content);
      const lowValueComments = findLowValueComments(content);

      for (const comment of lowValueComments) {
        changes.push({
          kind: 'text',
          producer: this.id,
          value: { file, baseContentHash, range: [comment.lineStart, comment.lineEnd], replacement: '' },
        });
        removedCount++;
      }
    }

    if (removedCount > 0) {
      changes.push({
        kind: 'advice',
        producer: this.id,
        value: {
          message: `${removedCount} comment${removedCount === 1 ? '' : 's'} removed — restated the adjacent code, no caller-relevant invariant.`,
          priority: 5,
        },
      });
    }

    return { changes };
  }
}
