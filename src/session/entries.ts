import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single parsed SESSION.md entry.
 *
 * The `type` field holds the resolved entry type (from the built-in set or
 * custom types supplied via {@link SessionParseOptions}).
 * When `type === 'write'`, the op/table/target/reason/fields fields are set.
 */
export interface SessionEntry {
  id: string;
  type: string;
  timestamp: string;
  body: string;
  project?: string;
  task?: string;
  tags?: string[];
  severity?: string;
  target_agent?: string;
  target_table?: string;
  /** Only present when type === 'write' */
  op?: 'create' | 'update' | 'delete';
  table?: string;
  target?: string;
  reason?: string;
  fields?: Record<string, string>;
}

export interface ParseError {
  line: number;
  message: string;
}

export interface ParseResult {
  entries: SessionEntry[];
  errors: ParseError[];
  /** Byte offset after the last fully parsed entry — used for incremental parsing. */
  lastOffset: number;
}

// ---------------------------------------------------------------------------
// Parse options
// ---------------------------------------------------------------------------

/**
 * Options for {@link parseSessionMD} and {@link parseMarkdownEntries}.
 *
 * All fields are optional — omitting them preserves the default behaviour
 * (built-in type set + built-in aliases), so existing callers are unaffected.
 */
export interface SessionParseOptions {
  /**
   * Set of valid entry type names.
   * - Omit (or `undefined`) → use {@link DEFAULT_ENTRY_TYPES}.
   * - `null` → accept **any** type string without validation.
   * - Provide a custom `Set<string>` to restrict to your own taxonomy.
   */
  validTypes?: Set<string> | null;

  /**
   * Map of non-standard type names to their canonical form.
   * - Omit (or `undefined`) → use {@link DEFAULT_TYPE_ALIASES}.
   * - `null` → disable alias resolution.
   * - Provide a custom `Record<string, string>` for your own aliases.
   */
  typeAliases?: Record<string, string> | null;
}

// ---------------------------------------------------------------------------
// Built-in defaults (exported so consumers can extend or reuse)
// ---------------------------------------------------------------------------

/**
 * Default set of valid entry types shipped with latticesql.
 * Suitable for LLM-agent context systems; override via {@link SessionParseOptions.validTypes}.
 */
export const DEFAULT_ENTRY_TYPES: ReadonlySet<string> = new Set([
  'event', 'learning', 'status', 'correction', 'discovery', 'metric', 'handoff', 'write',
]);

/**
 * Default type aliases shipped with latticesql.
 * Maps commonly-seen alternative names to their canonical type.
 * Override via {@link SessionParseOptions.typeAliases}.
 */
export const DEFAULT_TYPE_ALIASES: Readonly<Record<string, string>> = {
  task_completion: 'event',
  completion: 'event',
  heartbeat: 'status',
  bug: 'discovery',
  fix: 'event',
  deploy: 'event',
  note: 'event',
};

const FIELD_NAME_RE = /^[a-zA-Z0-9_]+$/;

// ---------------------------------------------------------------------------
// Public API — YAML block parser
// ---------------------------------------------------------------------------

/**
 * Parse SESSION.md YAML-delimited entries starting at `startOffset` bytes.
 *
 * Each entry looks like:
 * ```
 * ---
 * id: 2026-03-12T15:30:42Z-agent-b-a1b2c3
 * type: event
 * timestamp: 2026-03-12T15:30:42Z
 * ---
 * Entry body text here.
 * ===
 * ```
 *
 * Pass {@link SessionParseOptions} to customise which entry types are accepted
 * and how aliases are resolved. Defaults match the built-in type set.
 */
export function parseSessionMD(content: string, startOffset = 0, options?: SessionParseOptions): ParseResult {
  const entries: SessionEntry[] = [];
  const errors: ParseError[] = [];

  const text = content.slice(startOffset);
  const lines = text.split('\n');

  let i = 0;
  let currentByteOffset = startOffset;

  while (i < lines.length) {
    const currentLine = lines[i] ?? '';
    if (currentLine.trim() !== '---') {
      currentByteOffset += Buffer.byteLength(currentLine + '\n', 'utf-8');
      i++;
      continue;
    }

    const entryStartLine = i;
    currentByteOffset += Buffer.byteLength((lines[i] ?? '') + '\n', 'utf-8');
    i++;

    const headers: Record<string, string> = {};
    let foundHeaderClose = false;

    while (i < lines.length) {
      const line = lines[i] ?? '';
      currentByteOffset += Buffer.byteLength(line + '\n', 'utf-8');

      if (line.trim() === '---') {
        foundHeaderClose = true;
        i++;
        break;
      }

      const match = /^(\w+):\s*(.+)$/.exec(line);
      if (match) {
        headers[match[1] ?? ''] = (match[2] ?? '').trim();
      }
      i++;
    }

    if (!foundHeaderClose) {
      errors.push({ line: entryStartLine + 1, message: 'Entry header never closed (missing ---)' });
      break;
    }

    const bodyLines: string[] = [];

    while (i < lines.length) {
      const line = lines[i] ?? '';

      if (line.trim() === '===') {
        currentByteOffset += Buffer.byteLength(line + '\n', 'utf-8');
        i++;
        break;
      }

      if (line.trim() === '---' && bodyLines.length > 0) {
        const nextLine = lines[i + 1];
        if (nextLine && /^\w+:\s*.+$/.test(nextLine)) {
          break;
        }
      }

      bodyLines.push(line);
      currentByteOffset += Buffer.byteLength(line + '\n', 'utf-8');
      i++;
    }

    const body = bodyLines.join('\n').trim();

    const rawType = headers.type ?? '';
    const resolvedType = normalizeType(rawType, options);

    if (!resolvedType) {
      errors.push({ line: entryStartLine + 1, message: `Unknown entry type: ${rawType}` });
      continue;
    }
    if (!headers.timestamp) {
      errors.push({ line: entryStartLine + 1, message: 'Missing required header: timestamp' });
      continue;
    }
    if (!body) {
      errors.push({ line: entryStartLine + 1, message: 'Entry has empty body' });
      continue;
    }

    const entryId = headers.id ?? generateEntryId(headers.timestamp, 'agent', body);

    let tags: string[] | undefined;
    if (headers.tags) {
      const tagMatch = /^\[(.+)\]$/.exec(headers.tags);
      if (tagMatch) {
        tags = (tagMatch[1] ?? '').split(',').map(t => t.trim());
      }
    }

    // For write entries, parse body as key:value field pairs
    let writeFields: Record<string, string> | undefined;
    if (resolvedType === 'write' && headers.op !== 'delete') {
      writeFields = {};
      for (const line of body.split('\n')) {
        const m = /^([^:]+):\s*(.*)$/.exec(line);
        if (!m) continue;
        const key = (m[1] ?? '').trim();
        if (!FIELD_NAME_RE.test(key)) continue;
        writeFields[key] = (m[2] ?? '').trim();
      }
    }

    const newEntry: SessionEntry = { id: entryId, type: resolvedType, timestamp: headers.timestamp, body };
    if (headers.project) newEntry.project = headers.project;
    if (headers.task) newEntry.task = headers.task;
    if (tags) newEntry.tags = tags;
    if (headers.severity) newEntry.severity = headers.severity;
    if (headers.target_agent) newEntry.target_agent = headers.target_agent;
    if (headers.target_table) newEntry.target_table = headers.target_table;
    if (resolvedType === 'write') {
      if (headers.op) newEntry.op = headers.op as 'create' | 'update' | 'delete';
      if (headers.table) newEntry.table = headers.table;
      if (headers.target) newEntry.target = headers.target;
      if (headers.reason) newEntry.reason = headers.reason;
      newEntry.fields = writeFields ?? {};
    }
    entries.push(newEntry);
  }

  return { entries, errors, lastOffset: currentByteOffset };
}

// ---------------------------------------------------------------------------
// Public API — Markdown heading parser
// ---------------------------------------------------------------------------

/**
 * Parse free-form Markdown SESSION.md entries written as
 * `## {timestamp} — {description}` headings rather than YAML blocks.
 *
 * Runs alongside `parseSessionMD`; the two parsers are merged by caller.
 */
export function parseMarkdownEntries(
  content: string,
  agentName: string,
  startOffset = 0,
  options?: SessionParseOptions,
): ParseResult {
  const entries: SessionEntry[] = [];
  const errors: ParseError[] = [];

  const text = content.slice(startOffset);
  const lines = text.split('\n');

  const headingPattern = /^##\s+([\dT:.Z-]{10,})\s*(?:[—–-]{1,2}\s*(.+))?$/;

  let currentByteOffset = startOffset;
  const entryStarts: {
    lineIdx: number;
    timestamp: string;
    headingType: string;
    offset: number;
  }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const match = headingPattern.exec(lines[i] ?? '');
    if (match) {
      entryStarts.push({
        lineIdx: i,
        timestamp: match[1] ?? '',
        headingType: (match[2] ?? '').trim(),
        offset: currentByteOffset,
      });
    }
    currentByteOffset += Buffer.byteLength((lines[i] ?? '') + '\n', 'utf-8');
  }

  for (let e = 0; e < entryStarts.length; e++) {
    const start = entryStarts[e];
    if (!start) continue;
    const nextStart = entryStarts[e + 1];
    const bodyStartLine = start.lineIdx + 1;
    const bodyEndLine = nextStart ? nextStart.lineIdx : lines.length;

    const bodyLines = lines.slice(bodyStartLine, bodyEndLine);

    let bodyType: string | null = null;
    const filteredBody: string[] = [];
    for (const line of bodyLines) {
      const typeMatch = /^\*\*type:\*\*\s*(.+)/i.exec(line);
      if (typeMatch && !bodyType) {
        bodyType = (typeMatch[1] ?? '').trim();
      } else {
        filteredBody.push(line);
      }
    }

    const body = filteredBody.join('\n').trim();
    if (!body) {
      errors.push({ line: start.lineIdx + 1, message: 'Markdown entry has empty body' });
      continue;
    }

    const rawType = bodyType ?? (start.headingType || 'event');
    const resolvedType = normalizeType(rawType, options) ?? 'event';

    const id = generateEntryId(start.timestamp, agentName, body);

    entries.push({
      id,
      type: resolvedType,
      timestamp: start.timestamp,
      body,
    });
  }

  return { entries, errors, lastOffset: currentByteOffset };
}

// ---------------------------------------------------------------------------
// Public API — ID helpers
// ---------------------------------------------------------------------------

/**
 * Generate a content-addressed entry ID.
 * Format: `{timestamp}-{agentName}-{6-char-sha256-prefix}`
 */
export function generateEntryId(timestamp: string, agentName: string, body: string): string {
  const hash = createHash('sha256').update(body).digest('hex').slice(0, 6);
  return `${timestamp}-${agentName.toLowerCase()}-${hash}`;
}

/**
 * Validate that an entry ID's hash suffix matches its body.
 */
export function validateEntryId(id: string, body: string): boolean {
  const parts = id.split('-');
  if (parts.length < 4) return false;

  const hash = parts[parts.length - 1] ?? '';
  if (hash.length !== 6) return false;

  const expectedHash = createHash('sha256').update(body).digest('hex').slice(0, 6);
  return hash === expectedHash;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function normalizeType(raw: string, options?: SessionParseOptions): string | null {
  const lower = raw.toLowerCase().trim();
  if (!lower) return null;

  const validTypes = options?.validTypes === undefined ? DEFAULT_ENTRY_TYPES : options.validTypes;
  const aliases = options?.typeAliases === undefined ? DEFAULT_TYPE_ALIASES : options.typeAliases;

  // When validTypes is null, accept any type string
  if (validTypes === null) {
    // Still apply aliases if available
    if (aliases) {
      const normalized = lower.replace(/-/g, '_');
      if (aliases[normalized]) return aliases[normalized];
    }
    return lower;
  }

  if (validTypes.has(lower)) return lower;

  if (aliases) {
    const normalized = lower.replace(/-/g, '_');
    if (aliases[normalized]) return aliases[normalized];
    for (const alias of Object.keys(aliases)) {
      if (normalized.startsWith(alias)) return aliases[alias] ?? null;
    }
  }

  return null;
}
