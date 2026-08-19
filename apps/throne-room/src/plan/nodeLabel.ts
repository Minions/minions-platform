/**
 * Wraps a node title into up to `maxLines` lines of at most `maxCharsPerLine`
 * characters each, breaking on word boundaries so titles can be rendered below a
 * node instead of cramped inside its circle.
 *
 * - Words longer than the line budget are hard-split so a token never overflows.
 * - When the title doesn't fit in `maxLines`, the last line is ellipsised and the
 *   remainder dropped.
 * - An empty / whitespace-only title yields no lines.
 */
export function wrapLabel(title: string, maxCharsPerLine = 18, maxLines = 3): string[] {
  const raw = title.trim().split(/\s+/).filter(Boolean)
  if (raw.length === 0) return []

  // Pre-split overlong words so a single token never exceeds the line budget.
  const tokens: string[] = []
  for (const w of raw) {
    if (w.length <= maxCharsPerLine) {
      tokens.push(w)
    } else {
      for (let i = 0; i < w.length; i += maxCharsPerLine) tokens.push(w.slice(i, i + maxCharsPerLine))
    }
  }

  const lines: string[] = []
  let cur = ''
  for (const tok of tokens) {
    const candidate = cur ? `${cur} ${tok}` : tok
    if (candidate.length <= maxCharsPerLine) {
      cur = candidate
      continue
    }
    lines.push(cur)
    cur = tok
    if (lines.length === maxLines) {
      // Out of lines with content still pending → truncate the visible tail.
      return ellipsiseLast(lines, maxCharsPerLine)
    }
  }

  if (lines.length < maxLines) {
    lines.push(cur)
    return lines
  }
  return ellipsiseLast(lines, maxCharsPerLine)
}

function ellipsiseLast(lines: string[], maxCharsPerLine: number): string[] {
  const i = lines.length - 1
  const l = lines[i] ?? ''
  lines[i] = `${l.length >= maxCharsPerLine ? l.slice(0, maxCharsPerLine - 1) : l}…`
  return lines
}
