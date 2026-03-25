// Write-only parser (focused: parses only `type: write` entries)
export { parseSessionWrites, generateWriteEntryId } from './parser.js';
export type { SessionWriteEntry, SessionWriteOp, SessionWriteParseResult } from './parser.js';

// Full session entry parser (all types: event, learning, status, write, etc.)
export { parseSessionMD, parseMarkdownEntries, generateEntryId, validateEntryId } from './entries.js';
export type { SessionEntry, ParseResult, ParseError } from './entries.js';

// Write-entry application (DB-agnostic — pass your better-sqlite3 Database)
export { applyWriteEntry } from './apply.js';
export type { ApplyWriteResult } from './apply.js';

// Constants for Lattice-generated context files
export { READ_ONLY_HEADER } from './constants.js';
