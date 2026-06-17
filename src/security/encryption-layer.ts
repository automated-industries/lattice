import type { Row } from '../types.js';
import {
  deriveKey,
  encrypt as encryptValue,
  decrypt as decryptValue,
  resolveEncryptedColumns,
} from './encryption.js';

interface EncryptedConfig {
  encrypted?: boolean | { columns: string[] };
}

export interface EncryptionLayerDeps {
  encryptionKeyRaw?: string | undefined;
  getEntityContexts: () => Iterable<[string, EncryptedConfig]>;
  getTables: () => Iterable<[string, EncryptedConfig]>;
  introspectColumns: (table: string) => Promise<string[]>;
}

export class EncryptionLayer {
  private _key?: Buffer;
  private readonly _columns = new Map<string, Set<string>>();
  private readonly _keyRaw?: string | undefined;
  private readonly _getEntityContexts: () => Iterable<[string, EncryptedConfig]>;
  private readonly _getTables: () => Iterable<[string, EncryptedConfig]>;
  private readonly _introspectColumns: (table: string) => Promise<string[]>;

  constructor(deps: EncryptionLayerDeps) {
    this._keyRaw = deps.encryptionKeyRaw;
    this._getEntityContexts = deps.getEntityContexts;
    this._getTables = deps.getTables;
    this._introspectColumns = deps.introspectColumns;
  }

  /**
   * Throw-only validation of encryption-key configuration. Runs in the
   * synchronous prefix of `init()` so `expect(() => db.init()).toThrow(...)`
   * still observes the throw — moving this check into the async tail would
   * convert the throw into a rejected Promise and break those tests.
   * Column resolution happens later in {@link finalizeSetup} once the schema
   * has been applied.
   */
  validateConfig(): void {
    for (const [table, def] of this._getEntityContexts()) {
      if (!def.encrypted) continue;
      if (!this._keyRaw) {
        throw new Error(
          `Entity context "${table}" has encrypted: true but no encryptionKey was provided in Lattice options`,
        );
      }
    }
    for (const [table, def] of this._getTables()) {
      if (!def.encrypted) continue;
      if (!this._keyRaw) {
        throw new Error(
          `Table "${table}" has encrypted: true but no encryptionKey was provided in Lattice options`,
        );
      }
    }
  }

  /** Single source of truth for the defineLate inline-guard wording. */
  validateTable(table: string, def: EncryptedConfig): void {
    if (def.encrypted && !this._keyRaw) {
      throw new Error(
        `Table "${table}" has encrypted: true but no encryptionKey was provided in Lattice options`,
      );
    }
  }

  /**
   * Resolve which columns to encrypt per table, using introspectColumns to
   * see the post-migration schema. Runs in the async tail of init() after
   * applySchema/applyMigrationsAsync.
   */
  async finalizeSetup(): Promise<void> {
    for (const [table, def] of this._getEntityContexts()) {
      if (!def.encrypted) continue;
      if (!this._keyRaw) continue; // already validated above
      await this.registerColumns(table, def.encrypted);
    }
    for (const [table, def] of this._getTables()) {
      if (!def.encrypted) continue;
      if (!this._keyRaw) continue;
      // Entity-context encryption for this table (if any) was already
      // resolved in the first loop — skip to avoid clobbering with a
      // narrower table-level spec.
      if (this._columns.has(table)) continue;
      await this.registerColumns(table, def.encrypted);
    }
  }

  /**
   * Shared helper: derive the encryption key on first use, introspect the
   * table's current columns, resolve which to encrypt, and record the set.
   * Called from both `finalizeSetup` (boot path) and `defineLate`
   * (post-init table registration).
   */
  async registerColumns(table: string, encrypted: true | { columns: string[] }): Promise<void> {
    if (!this._keyRaw) {
      throw new Error(
        `Cannot register encrypted columns for "${table}": no encryptionKey was provided`,
      );
    }
    this._key ??= deriveKey(this._keyRaw); // LAZY scrypt — first registration only
    const allCols = await this._introspectColumns(table);
    const encCols = resolveEncryptedColumns(encrypted, allCols);
    this._columns.set(table, encCols);
  }

  /** Encrypt applicable columns in a row before writing. Returns a new row. */
  encryptRow(table: string, row: Row): Row {
    const encCols = this._columns.get(table);
    if (!encCols || !this._key) return row;
    const result = { ...row };
    for (const col of encCols) {
      const val = result[col];
      if (typeof val === 'string' && val.length > 0) {
        result[col] = encryptValue(val, this._key);
      }
    }
    return result;
  }

  /** Decrypt applicable columns in a row after reading. Mutates in place. */
  decryptRow(table: string, row: Row): Row {
    const encCols = this._columns.get(table);
    if (!encCols || !this._key) return row;
    for (const col of encCols) {
      const val = row[col];
      if (typeof val === 'string' && val.length > 0) {
        row[col] = decryptValue(val, this._key);
      }
    }
    return row;
  }

  /** Decrypt applicable columns in multiple rows. Mutates in place. */
  decryptRows(table: string, rows: Row[]): Row[] {
    if (!this._columns.has(table)) return rows;
    for (const row of rows) this.decryptRow(table, row);
    return rows;
  }

  hasEncryptedColumns(table: string): boolean {
    return this._columns.has(table);
  }

  clear(): void {
    this._columns.clear();
    delete this._key;
  }
}
