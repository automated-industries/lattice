import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SessionWriteOp = 'create' | 'update' | 'delete';

export interface SessionWriteEntry {
  id: string;
  timestamp: string;
  op: SessionWriteOp;
  table: string;
  target?: string;
  reason?: string;
  fields: Record<string, string>;
}

export interface SessionWriteParseResult {
  entries: SessionWriteEntry[];
  errors: { line: number; message: string }[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a deterministic entry ID from the given parameters.
 * Uses sha256 of `{op}:{table}:{target ?? ''}:{timestamp}` with the format
 * `{timestamp}-{agentName}-{6-char-hash}`.
 */
export function generateWriteEntryId(
  timestamp: string,
  agentName: string,
  op: string,
  table: string,
  target?: string,
): string {
  const payload = `${op}:${table}:${target ?? ''}:${timestamp}`;
  const hash = createHash('sha256').update(payload).digest('hex').slice(0, 6);
  return `${timestamp}-${agentName}-${hash}`;
}

/**
 * Parse all `type: write` entries from a SESSION.md file.
 * Non-write entries are silently skipped.
 */
export function parseSessionWrites(content: string): SessionWriteParseResult {
  const entries: SessionWriteEntry[] = [];
  const errors: { line: number; message: string }[] = [];

  // Split into raw blocks delimited by `---` … `---` … `===`
  const blocks = splitIntoBlocks(content);

  for (const block of blocks) {
    const result = parseBlock(block);
    if (result === null) continue; // not a write entry — skip silently
    if ('error' in result) {
      errors.push(result.error);
    } else {
      entries.push(result.entry);
    }
  }

  return { entries, errors };
}

// ---------------------------------------------------------------------------
// Internal — block splitting
// ---------------------------------------------------------------------------

interface RawBlock {
  /** Line number (1-based) of the opening `---` */
  startLine: number;
  headerLines: string[];
  bodyLines: string[];
}

function splitIntoBlocks(content: string): RawBlock[] {
  const lines = content.split('\n');
  const blocks: RawBlock[] = [];

  let i = 0;
  while (i < lines.length) {
    // Find opening `---`
    while (i < lines.length && lines[i]?.trim() !== '---') {
      i++;
    }
    if (i >= lines.length) break;

    const startLine = i + 1; // 1-based
    i++; // skip opening `---`

    // Collect header lines until closing `---`
    const headerLines: string[] = [];
    while (i < lines.length && lines[i]?.trim() !== '---') {
      headerLines.push(lines[i] ?? '');
      i++;
    }
    if (i >= lines.length) break; // malformed — no closing ---
    i++; // skip closing `---`

    // Collect body lines until `===`
    const bodyLines: string[] = [];
    while (i < lines.length && lines[i]?.trim() !== '===') {
      bodyLines.push(lines[i] ?? '');
      i++;
    }
    if (i < lines.length) i++; // skip `===`

    blocks.push({ startLine, headerLines, bodyLines });
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Internal — block parsing
// ---------------------------------------------------------------------------

type BlockParseResult =
  | null
  | { entry: SessionWriteEntry }
  | { error: { line: number; message: string } };

const TABLE_NAME_RE = /^[a-zA-Z0-9_]+$/;
const FIELD_NAME_RE = /^[a-zA-Z0-9_]+$/;
const KEY_VALUE_RE = /^([^:]+):\s*(.*)$/;

function parseBlock(block: RawBlock): BlockParseResult {
  // Parse header into a key→value map
  const header: Record<string, string> = {};
  for (const line of block.headerLines) {
    const m = KEY_VALUE_RE.exec(line);
    if (m) {
      header[(m[1] ?? '').trim()] = (m[2] ?? '').trim();
    }
  }

  // Only handle write entries
  if (header.type !== 'write') return null;

  const line = block.startLine;

  // Validate timestamp
  const timestamp = header.timestamp;
  if (!timestamp) {
    return { error: { line, message: 'Missing required field: timestamp' } };
  }

  // Validate op
  const rawOp = header.op;
  if (!rawOp) {
    return { error: { line, message: 'Missing required field: op' } };
  }
  if (rawOp !== 'create' && rawOp !== 'update' && rawOp !== 'delete') {
    return {
      error: { line, message: `Invalid op: "${rawOp}". Must be create, update, or delete` },
    };
  }
  const op = rawOp as SessionWriteOp;

  // Validate table
  const table = header.table;
  if (!table) {
    return { error: { line, message: 'Missing required field: table' } };
  }
  if (!TABLE_NAME_RE.test(table)) {
    return {
      error: { line, message: `Invalid table name: "${table}". Only [a-zA-Z0-9_] allowed` },
    };
  }

  // Validate target for update/delete
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty string must become undefined
  const target = header.target || undefined;
  if ((op === 'update' || op === 'delete') && !target) {
    return { error: { line, message: `Field "target" is required for op "${op}"` } };
  }

  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty string must become undefined
  const reason = header.reason || undefined;

  // Parse body fields (skip for delete)
  const fields: Record<string, string> = {};
  if (op !== 'delete') {
    for (const line of block.bodyLines) {
      const m = KEY_VALUE_RE.exec(line);
      if (!m) continue;
      const key = (m[1] ?? '').trim();
      const value = (m[2] ?? '').trim();
      if (!FIELD_NAME_RE.test(key)) continue; // invalid field name — ignore
      fields[key] = value;
    }
  }

  // Resolve or auto-generate ID
  const id = header.id ?? generateWriteEntryId(timestamp, 'agent', op, table, target);

  const entry: SessionWriteEntry = {
    id,
    timestamp,
    op,
    table,
    fields,
    ...(target !== undefined ? { target } : {}),
    ...(reason !== undefined ? { reason } : {}),
  };

  return { entry };
}
