import type { StorageAdapter } from '../db/adapter.js';
import { allAsyncOrSync } from '../db/adapter.js';
import { assertSafeIdentifier } from '../schema/identifier.js';
import type {
  Row,
  SeedConfig,
  SeedResult,
  SeedLinkSpec,
  UnresolvedLink,
  UpsertByNaturalKeyOptions,
  LinkOptions,
} from '../types.js';

/**
 * Thrown by Lattice.seed when onUnresolvedLink: 'throw' is set and one or more
 * junction links could not be created because their target rows did not
 * resolve. (Moved here from lattice.ts; re-exported from lattice.ts to
 * preserve the public export name.)
 */
export class SeedReconciliationError extends Error {
  constructor(
    public readonly table: string,
    public readonly unresolvedLinks: UnresolvedLink[],
  ) {
    const detail = unresolvedLinks
      .map((u) => `${u.field}="${u.name}" (→ ${u.resolveTable}.${u.resolveBy})`)
      .join(', ');
    super(
      `seed("${table}"): ${String(unresolvedLinks.length)} unresolved link(s) — ` +
        `target row(s) not found: ${detail}. Create the missing target(s) and re-seed.`,
    );
    this.name = 'SeedReconciliationError';
  }
}

export interface SeedEngineDeps {
  adapter: StorageAdapter;
  upsertByNaturalKey: (
    table: string,
    naturalKeyCol: string,
    naturalKeyVal: string,
    data: Row,
    opts?: UpsertByNaturalKeyOptions,
  ) => Promise<string>;
  link: (junctionTable: string, data: Row, opts?: LinkOptions) => Promise<void>;
  softDeleteMissing: (
    table: string,
    naturalKeyCol: string,
    sourceFile: string,
    currentKeys: string[],
  ) => Promise<number>;
  inferFk: (table: string) => string;
}

export class SeedEngine {
  private readonly _adapter: StorageAdapter;
  private readonly _upsertByNaturalKey: SeedEngineDeps['upsertByNaturalKey'];
  private readonly _link: SeedEngineDeps['link'];
  private readonly _softDeleteMissing: SeedEngineDeps['softDeleteMissing'];
  private readonly _inferFk: SeedEngineDeps['inferFk'];

  constructor(deps: SeedEngineDeps) {
    this._adapter = deps.adapter;
    this._upsertByNaturalKey = deps.upsertByNaturalKey;
    this._link = deps.link;
    this._softDeleteMissing = deps.softDeleteMissing;
    this._inferFk = deps.inferFk;
  }

  // Body moved VERBATIM from lattice.ts seed() (1541–1640), minus the not-init
  // guard (stays on Lattice). this.upsertByNaturalKey → this._upsertByNaturalKey,
  // this.link → this._link, this.softDeleteMissing → this._softDeleteMissing,
  // this._inferFk → this._inferFk (bound dep). The inline
  // `import('./types.js').UpsertByNaturalKeyOptions` at the original line 1570
  // becomes the top-level-imported `UpsertByNaturalKeyOptions`.
  async seed(config: SeedConfig): Promise<SeedResult> {
    let upserted = 0;
    let linked = 0;
    let softDeleted = 0;
    const keys: string[] = [];
    const unresolvedLinks: UnresolvedLink[] = [];

    const resolveMaps = config.linkTo
      ? await this._buildSeedResolveMaps(config.data, config.linkTo)
      : new Map<string, Map<string, string>>();

    for (const record of config.data) {
      const rawKey = record[config.naturalKey];
      const naturalKeyVal =
        typeof rawKey === 'string' ? rawKey : typeof rawKey === 'number' ? String(rawKey) : '';
      if (!naturalKeyVal) continue;

      keys.push(naturalKeyVal);

      const upsertOpts: UpsertByNaturalKeyOptions = {};
      if (config.sourceFile) upsertOpts.sourceFile = config.sourceFile;
      if (config.sourceHash) upsertOpts.sourceHash = config.sourceHash;
      if (config.orgId) upsertOpts.orgId = config.orgId;
      const id = await this._upsertByNaturalKey(
        config.table,
        config.naturalKey,
        naturalKeyVal,
        record as Row,
        upsertOpts,
      );
      upserted++;

      if (config.linkTo) {
        if (!id) continue;
        for (const [field, spec] of Object.entries(config.linkTo)) {
          const names = record[field] as string[] | undefined;
          if (!Array.isArray(names)) continue;
          const resolveTable = spec.resolveTable ?? field;
          const targetIds = resolveMaps.get(this._seedResolveKey(resolveTable, spec.resolveBy));
          for (const name of names) {
            const targetId = targetIds?.get(name);
            if (targetId === undefined) {
              unresolvedLinks.push({
                record: naturalKeyVal,
                field,
                name,
                junction: spec.junction,
                resolveTable,
                resolveBy: spec.resolveBy,
              });
              continue;
            }
            const linkData: Row = {
              [this._inferFk(config.table)]: id,
              [spec.foreignKey]: targetId,
              ...(spec.extras ?? {}),
            };
            await this._link(spec.junction, linkData);
            linked++;
          }
        }
      }
    }

    if (config.softDeleteMissing && config.sourceFile && keys.length > 0) {
      softDeleted = await this._softDeleteMissing(
        config.table,
        config.naturalKey,
        config.sourceFile,
        keys,
      );
    }

    if (config.onUnresolvedLink === 'throw' && unresolvedLinks.length > 0) {
      throw new SeedReconciliationError(config.table, unresolvedLinks);
    }

    return { upserted, linked, softDeleted, unresolvedLinks };
  }

  // VERBATIM from lattice.ts 1648–1650 (+ its JSDoc).
  private _seedResolveKey(resolveTable: string, resolveBy: string): string {
    return JSON.stringify([resolveTable, resolveBy]);
  }

  // VERBATIM from lattice.ts 1671–1722 (+ its JSDoc). The single call site
  // this._assertIdent(group.resolveTable, group.resolveBy) is inlined to
  // _assertIdent's exact body (lattice.ts 779–782): two assertSafeIdentifier
  // calls. this._adapter is the threaded adapter; the inline
  // `import('./types.js').SeedLinkSpec` param type (orig line 1673) becomes the
  // top-level-imported SeedLinkSpec.
  private async _buildSeedResolveMaps(
    data: Record<string, unknown>[],
    linkTo: Record<string, SeedLinkSpec>,
  ): Promise<Map<string, Map<string, string>>> {
    const wanted = new Map<
      string,
      { resolveTable: string; resolveBy: string; names: Set<string> }
    >();
    for (const [field, spec] of Object.entries(linkTo)) {
      const resolveTable = spec.resolveTable ?? field;
      const groupKey = this._seedResolveKey(resolveTable, spec.resolveBy);
      let group = wanted.get(groupKey);
      if (!group) {
        group = { resolveTable, resolveBy: spec.resolveBy, names: new Set<string>() };
        wanted.set(groupKey, group);
      }
      for (const record of data) {
        const names = record[field];
        if (!Array.isArray(names)) continue;
        for (const name of names) {
          if (typeof name === 'string' && name.length > 0) group.names.add(name);
        }
      }
    }

    const maps = new Map<string, Map<string, string>>();
    for (const [groupKey, group] of wanted) {
      const map = new Map<string, string>();
      maps.set(groupKey, map);
      if (group.names.size === 0) continue;
      assertSafeIdentifier(group.resolveTable, 'table');
      assertSafeIdentifier(group.resolveBy, 'column');
      const names = [...group.names];
      const placeholders = names.map(() => '?').join(', ');
      const rows = await allAsyncOrSync(
        this._adapter,
        `SELECT id, "${group.resolveBy}" FROM "${group.resolveTable}" WHERE "${group.resolveBy}" IN (${placeholders}) AND deleted_at IS NULL`,
        names,
      );
      for (const row of rows) {
        const key = row[group.resolveBy];
        if (typeof key !== 'string') continue;
        if (!map.has(key)) map.set(key, row.id as string);
      }
    }
    return maps;
  }
}
