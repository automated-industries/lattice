export type Row = Record<string, unknown>;

export interface LatticeOptions {
  wal?: boolean;
  busyTimeout?: number;
  security?: SecurityOptions;
}

export interface SecurityOptions {
  sanitize?: boolean;
  auditTables?: string[];
  fieldLimits?: Record<string, number>;
}

export interface TableDefinition {
  /** Column name → SQLite type spec (e.g. `'TEXT PRIMARY KEY'`) */
  columns: Record<string, string>;
  /** Transform DB rows into text content for the context file */
  render: (rows: Row[]) => string;
  /** Output path relative to the outputDir passed to render/watch */
  outputFile: string;
  /** Optional pre-filter applied before render */
  filter?: (rows: Row[]) => Row[];
}

export interface MultiTableDefinition {
  /** Returns the "anchor" entities — one output file is produced per anchor */
  keys: () => Promise<Row[]>;
  /** Derive the output file path from the anchor entity */
  outputFile: (key: Row) => string;
  /** Transform an anchor entity + related table data into text content */
  render: (key: Row, tables: Record<string, Row[]>) => string;
  /** Additional table names to query and pass into render */
  tables?: string[];
}

export interface WritebackDefinition {
  /** Path or glob to agent-written files */
  file: string;
  /** Parse new file content starting at fromOffset; return entries and next offset */
  parse: (
    content: string,
    fromOffset: number,
  ) => { entries: unknown[]; nextOffset: number };
  /** Persist a single parsed entry; called exactly once per unique dedupeKey */
  persist: (entry: unknown, filePath: string) => Promise<void>;
  /** Optional dedup key — if omitted, every entry is processed */
  dedupeKey?: (entry: unknown) => string;
}

export interface QueryOptions {
  where?: Record<string, unknown>;
  orderBy?: string;
  orderDir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface CountOptions {
  where?: Record<string, unknown>;
}

export interface InitOptions {
  migrations?: Migration[];
}

export interface Migration {
  version: number;
  sql: string;
}

export interface WatchOptions {
  /** Poll interval in milliseconds (default: 5000) */
  interval?: number;
  onRender?: (result: RenderResult) => void;
  onError?: (err: Error) => void;
}

export interface RenderResult {
  filesWritten: string[];
  filesSkipped: number;
  durationMs: number;
}

export interface SyncResult extends RenderResult {
  writebackProcessed: number;
}

export type StopFn = () => void;

export type AuditEvent = {
  table: string;
  operation: 'insert' | 'update' | 'delete';
  id: string;
  timestamp: string;
};

export type LatticeEvent =
  | { type: 'audit'; data: AuditEvent }
  | { type: 'render'; data: RenderResult }
  | { type: 'writeback'; data: { filePath: string; entriesProcessed: number } }
  | { type: 'error'; data: Error };
