/**
 * Minimal, hand-rolled TOML codec scoped exactly to this store's two file
 * shapes (content.toml / claims.toml). Not a general TOML parser — it only
 * needs to round-trip what its own serializer emits, since these files are
 * never hand-authored or produced by any other tool. Deliberately avoids an
 * external TOML dependency: we can't verify a library's exact formatting
 * (multi-line array style, trailing commas, key ordering) without vendoring
 * it, and that formatting IS the point — see the trailing-comma comment on
 * writeStringArray below.
 *
 * String values are escaped via JSON.stringify — TOML basic-string escaping
 * (backslash, quote, control chars) is a strict subset of JSON's, so a
 * JSON-escaped string is always a valid TOML basic string for the text we
 * actually store (item titles, criteria, ids). Parsing mirrors this: a
 * quoted value is decoded with JSON.parse.
 */

type TomlTable = Record<string, unknown>;

function escStr(s: string): string {
  return JSON.stringify(s);
}

function escKey(k: string): string {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k);
}

/**
 * Serialize a string array. Non-empty arrays are always multi-line with a
 * trailing comma on every element, INCLUDING the last one. That's what makes
 * appending a new element a pure insertion after an unchanged line, instead
 * of also having to rewrite the previous last line to add its comma — the
 * exact mechanical cause of the merge conflicts this format replaces.
 */
function writeStringArray(arr: readonly string[], indent: string): string {
  if (arr.length === 0) return '[]';
  const lines = arr.map((v) => `${indent}  ${escStr(v)},`);
  return `[\n${lines.join('\n')}\n${indent}]`;
}

/** Table path segments joined for a `[a.b.c]` header, quoting segments that need it. */
function header(path: string[]): string {
  return `[${path.map(escKey).join('.')}]`;
}

/**
 * Write one table's scalar/array fields as `key = value` lines, in a fixed
 * field order (stable output — no incidental reordering between writes).
 * `fields` lists [key, value] pairs; a value of `undefined` skips the line
 * entirely (means "field absent", TOML has no null literal).
 */
function writeFields(fields: Array<[string, unknown]>, indent = ''): string[] {
  const lines: string[] = [];
  for (const [key, value] of fields) {
    if (value === undefined) continue;
    if (typeof value === 'string') {
      lines.push(`${indent}${escKey(key)} = ${escStr(value)}`);
    } else if (typeof value === 'boolean') {
      lines.push(`${indent}${escKey(key)} = ${value}`);
    } else if (Array.isArray(value)) {
      lines.push(`${indent}${escKey(key)} = ${writeStringArray(value as string[], indent)}`);
    } else {
      throw new Error(`toml.ts: unsupported field value for "${key}": ${JSON.stringify(value)}`);
    }
  }
  return lines;
}

export interface TomlBlock {
  /** Table header path, e.g. ['items', 'abc123'] or ['items', 'abc123', 'exploring']. */
  path: string[];
  /** Ordered scalar/array fields for this table. Empty array still emits the bare header. */
  fields: Array<[string, unknown]>;
}

/** Render a full document from an ordered list of table blocks. */
export function stringifyToml(blocks: TomlBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    const lines = [header(block.path), ...writeFields(block.fields)];
    parts.push(lines.join('\n'));
  }
  return parts.length ? parts.join('\n\n') + '\n' : '';
}

/**
 * Parse a document written by stringifyToml back into a nested plain-object
 * tree keyed by table path, e.g. `{ items: { abc123: { title: '...',
 * exploring: { opt1: '...' } } } }`. Only understands: `[a.b.c]` headers,
 * `key = "string"`, `key = true/false`, `key = []`, and the multi-line
 * trailing-comma string array form this module's own writer produces.
 */
export function parseToml(text: string): TomlTable {
  const root: TomlTable = {};
  let current: TomlTable = root;
  const lines = text.split('\n');
  let i = 0;

  const getTable = (path: string[]): TomlTable => {
    let node = root;
    for (const seg of path) {
      const existing = node[seg];
      if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
        node = existing as TomlTable;
      } else {
        const fresh: TomlTable = {};
        node[seg] = fresh;
        node = fresh;
      }
    }
    return node;
  };

  const parseHeaderPath = (raw: string): string[] => {
    // raw is the text between [ and ], dot-separated, each segment either
    // bare (^[A-Za-z0-9_-]+$) or a JSON-quoted string.
    const segs: string[] = [];
    let rest = raw.trim();
    while (rest.length > 0) {
      if (rest.startsWith('"')) {
        const end = findJsonStringEnd(rest);
        segs.push(JSON.parse(rest.slice(0, end)) as string);
        rest = rest.slice(end).replace(/^\./, '');
      } else {
        const m = /^([A-Za-z0-9_-]+)\.?/.exec(rest);
        if (!m) throw new Error(`toml.ts: malformed table header segment: ${raw}`);
        segs.push(m[1]);
        rest = rest.slice(m[0].length);
      }
    }
    return segs;
  };

  const parseKey = (raw: string): string =>
    raw.startsWith('"') ? (JSON.parse(raw) as string) : raw;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    i++;
    if (trimmed === '') continue;

    const headerMatch = /^\[(.+)\]$/.exec(trimmed);
    if (headerMatch) {
      current = getTable(parseHeaderPath(headerMatch[1]));
      continue;
    }

    const eq = trimmed.indexOf(' = ');
    if (eq === -1) throw new Error(`toml.ts: malformed line: ${trimmed}`);
    const key = parseKey(trimmed.slice(0, eq));
    const valueText = trimmed.slice(eq + 3);

    if (valueText === '[]') {
      current[key] = [];
    } else if (valueText === '[') {
      const arr: string[] = [];
      while (i < lines.length) {
        const arrLine = lines[i].trim();
        i++;
        if (arrLine === ']') break;
        const withoutComma = arrLine.endsWith(',') ? arrLine.slice(0, -1) : arrLine;
        arr.push(JSON.parse(withoutComma) as string);
      }
      current[key] = arr;
    } else if (valueText === 'true' || valueText === 'false') {
      current[key] = valueText === 'true';
    } else if (valueText.startsWith('"')) {
      current[key] = JSON.parse(valueText) as string;
    } else {
      throw new Error(`toml.ts: unsupported value: ${valueText}`);
    }
  }

  return root;
}

function findJsonStringEnd(s: string): number {
  // s starts with a `"`. Walk to the matching unescaped closing quote.
  let j = 1;
  while (j < s.length) {
    if (s[j] === '\\') { j += 2; continue; }
    if (s[j] === '"') return j + 1;
    j++;
  }
  throw new Error(`toml.ts: unterminated string: ${s}`);
}
