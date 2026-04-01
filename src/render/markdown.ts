import type { Row } from '../types.js';

// ---------------------------------------------------------------------------
// Column configuration for markdownTable()
// ---------------------------------------------------------------------------

/**
 * Column definition for {@link markdownTable}.
 */
export interface MarkdownTableColumn {
  /** Row property to read (e.g. `'name'`, `'status'`). */
  key: string;
  /** Column header text displayed in the table. */
  header: string;
  /**
   * Optional per-cell formatter.  Receives the raw cell value and the full
   * row so formatters can derive display values from multiple fields.
   *
   * @example `(val) => String(val ?? '—')`
   * @example `(_, row) => \`[\${row.name}](\${row.slug}/DETAIL.md)\``
   */
  format?: (val: unknown, row: Row) => string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a YAML-style frontmatter block.
 * Automatically includes `generated_at` with the current ISO timestamp.
 *
 * @example
 * ```ts
 * frontmatter({ agent: 'Alice', skill_count: 5 })
 * // "---\ngenerated_at: 2026-03-27T...\nagent: Alice\nskill_count: 5\n---\n\n"
 * ```
 */
export function frontmatter(fields: Record<string, string | number | boolean>): string {
  const lines = [`generated_at: "${new Date().toISOString()}"`];
  for (const [key, val] of Object.entries(fields)) {
    lines.push(typeof val === 'string' ? `${key}: "${val}"` : `${key}: ${String(val)}`);
  }
  return `---\n${lines.join('\n')}\n---\n\n`;
}

/**
 * Generate a GitHub-Flavoured Markdown table from rows with explicit column
 * configuration.  Returns an empty string when `rows` is empty.
 *
 * @example
 * ```ts
 * markdownTable(rows, [
 *   { key: 'name',   header: 'Name' },
 *   { key: 'status', header: 'Status', format: (v) => String(v ?? '—') },
 * ])
 * ```
 */
export function markdownTable(rows: Row[], columns: MarkdownTableColumn[]): string {
  if (rows.length === 0 || columns.length === 0) return '';

  const header = '| ' + columns.map(c => c.header).join(' | ') + ' |';
  const separator = '| ' + columns.map(() => '---').join(' | ') + ' |';
  const body = rows.map(row => {
    const cells = columns.map(col => {
      const raw = row[col.key];
      return col.format ? col.format(raw, row) : String((raw ?? '') as string | number | boolean);
    });
    return '| ' + cells.join(' | ') + ' |';
  });

  return [header, separator, ...body].join('\n') + '\n';
}

/**
 * Generate a URL-safe slug from a display name.
 *
 * - Lowercases, strips diacritics, replaces non-alphanumeric runs with `-`,
 *   and trims leading/trailing hyphens.
 *
 * @example `slugify('My Agent Name')  // 'my-agent-name'`
 * @example `slugify('José García')    // 'jose-garcia'`
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')   // strip combining diacritics
    .replace(/\u0131/g, 'i')           // Turkish dotless i
    .replace(/[^a-z0-9]+/g, '-')       // non-alphanumeric → hyphen
    .replace(/(^-|-$)/g, '');          // trim leading/trailing hyphens
}

/**
 * Truncate content at a character budget.
 *
 * When `content.length > maxChars`, slices to `maxChars` and appends `notice`.
 * Returns `content` unchanged when the budget is not exceeded.
 *
 * @param content  - The rendered content to truncate
 * @param maxChars - Maximum character count
 * @param notice   - Appended after truncation (default: standard budget notice)
 */
export function truncate(
  content: string,
  maxChars: number,
  notice = '\n\n*[truncated — context budget exceeded]*',
): string {
  if (content.length <= maxChars) return content;
  return content.slice(0, maxChars) + notice;
}
