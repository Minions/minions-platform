/**
 * Glob Pattern Matching
 *
 * Simple glob matching supporting:
 * - * matches any characters except /
 * - ** matches any characters including /
 * - ? matches a single character except /
 */

/**
 * Converts a glob pattern to a regular expression.
 */
function globToRegex(pattern: string): RegExp {
  let regex = '';
  let i = 0;

  while (i < pattern.length) {
    const char = pattern[i];

    if (char === '*') {
      if (pattern[i + 1] === '*') {
        // ** matches anything including /
        regex += '.*';
        i += 2;
        // Skip optional trailing slash after **
        if (pattern[i] === '/') {
          i++;
        }
      } else {
        // * matches anything except /
        regex += '[^/]*';
        i++;
      }
    } else if (char === '?') {
      // ? matches single character except /
      regex += '[^/]';
      i++;
    } else if (char === '.') {
      // Escape dots
      regex += '\\.';
      i++;
    } else if (char === '/') {
      regex += '/';
      i++;
    } else {
      // Regular character
      regex += char;
      i++;
    }
  }

  return new RegExp(`^${regex}$`);
}

/**
 * Tests if a path matches a glob pattern.
 *
 * @param pattern - Glob pattern to match
 * @param path - Path to test
 * @returns True if the path matches the pattern
 */
export function globMatch(pattern: string, path: string): boolean {
  const regex = globToRegex(pattern);
  return regex.test(path);
}
