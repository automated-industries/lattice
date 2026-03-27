// Write-only parser (focused: parses only `type: write` entries)
export { parseSessionWrites, generateWriteEntryId } from './parser.js';
export type { SessionWriteEntry, SessionWriteOp, SessionWriteParseResult } from './parser.js';

// Full session entry parser (all types — configurable via SessionParseOptions)
export { parseSessionMD, parseMarkdownEntries, generateEntryId, validateEntryId, DEFAULT_ENTRY_TYPES, DEFAULT_TYPE_ALIASES } from './entries.js';
export type { SessionEntry, ParseResult, ParseError, SessionParseOptions } from './entries.js';

// Write-entry application (pass your better-sqlite3 Database)
export { applyWriteEntry } from './apply.js';
export type { ApplyWriteResult } from './apply.js';

// Read-only header for Lattice-generated context files
export { READ_ONLY_HEADER, createReadOnlyHeader } from './constants.js';
export type { ReadOnlyHeaderOptions } from './constants.js';
