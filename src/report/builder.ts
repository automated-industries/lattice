import type { StorageAdapter } from '../db/adapter.js';
import { allAsyncOrSync } from '../db/adapter.js';
import type { Row, ReportConfig, ReportResult, ReportSectionResult } from '../types.js';

/**
 * Report generation extracted from the `Lattice` facade. The facade keeps the
 * public `buildReport` method (it performs the `init()` guard and delegates
 * here). Dependencies that live on the facade (the adapter and the column-cache
 * accessor) are injected so this module never reaches into `Lattice` internals.
 */
export interface ReportBuilderDeps {
  adapter: StorageAdapter;
  ensureColumnCache: (table: string) => Set<string>;
}

export class ReportBuilder {
  private readonly adapter: StorageAdapter;
  private readonly ensureColumnCache: ReportBuilderDeps['ensureColumnCache'];

  constructor(deps: ReportBuilderDeps) {
    this.adapter = deps.adapter;
    this.ensureColumnCache = deps.ensureColumnCache;
  }

  /** Parse duration shorthand ('8h', '24h', '7d') into ISO timestamp. */
  private resolveSince(since: string): string {
    const match = /^(\d+)([hmd])$/.exec(since);
    if (!match) return since; // assume ISO timestamp
    const [, numStr, unit] = match;
    const num = parseInt(numStr ?? '0', 10);
    const ms = unit === 'h' ? num * 3600000 : unit === 'd' ? num * 86400000 : num * 60000;
    return new Date(Date.now() - ms).toISOString();
  }

  async buildReport(config: ReportConfig): Promise<ReportResult> {
    const since = this.resolveSince(config.since);
    const sections: ReportSectionResult[] = [];
    let allEmpty = true;

    for (const section of config.sections) {
      const cols = this.ensureColumnCache(section.query.table);
      const hasTimestamp = cols.has('timestamp');
      const conditions: string[] = [];
      const params: unknown[] = [];

      // Time window filter
      if (hasTimestamp) {
        conditions.push('timestamp >= ?');
        params.push(since);
      }

      // Soft-delete exclusion
      if (cols.has('deleted_at')) {
        conditions.push('deleted_at IS NULL');
      }

      // User filters
      if (section.query.filters) {
        for (const f of section.query.filters) {
          switch (f.op) {
            case 'eq':
              conditions.push(`"${f.col}" = ?`);
              params.push(f.val);
              break;
            case 'ne':
              conditions.push(`"${f.col}" != ?`);
              params.push(f.val);
              break;
            case 'gt':
              conditions.push(`"${f.col}" > ?`);
              params.push(f.val);
              break;
            case 'gte':
              conditions.push(`"${f.col}" >= ?`);
              params.push(f.val);
              break;
            case 'lt':
              conditions.push(`"${f.col}" < ?`);
              params.push(f.val);
              break;
            case 'lte':
              conditions.push(`"${f.col}" <= ?`);
              params.push(f.val);
              break;
            case 'like':
              conditions.push(`"${f.col}" LIKE ?`);
              params.push(f.val);
              break;
            case 'isNull':
              conditions.push(`"${f.col}" IS NULL`);
              break;
            case 'isNotNull':
              conditions.push(`"${f.col}" IS NOT NULL`);
              break;
            case 'in': {
              const arr = f.val as unknown[];
              if (arr.length > 0) {
                conditions.push(`"${f.col}" IN (${arr.map(() => '?').join(', ')})`);
                params.push(...arr);
              }
              break;
            }
          }
        }
      }

      const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
      const orderBy = section.query.orderBy
        ? ` ORDER BY "${section.query.orderBy}" ${section.query.orderDir === 'desc' ? 'DESC' : 'ASC'}`
        : '';
      const limit = section.query.limit ? ` LIMIT ${String(section.query.limit)}` : '';

      const rows = await allAsyncOrSync(
        this.adapter,
        `SELECT * FROM "${section.query.table}"${where}${orderBy}${limit}`,
        params,
      );

      if (rows.length > 0) allEmpty = false;

      // Format
      let formatted = '';
      if (section.format === 'custom' && section.customFormat) {
        formatted = section.customFormat(rows);
      } else if (section.format === 'counts' && section.query.groupBy) {
        const groups = new Map<string, number>();
        for (const row of rows) {
          const rawGroupVal = row[section.query.groupBy];
          const type =
            typeof rawGroupVal === 'string'
              ? rawGroupVal
              : typeof rawGroupVal === 'number'
                ? String(rawGroupVal)
                : 'other';
          const prefix = type.includes('.') ? (type.split('.')[0] ?? type) : type;
          groups.set(prefix, (groups.get(prefix) ?? 0) + 1);
        }
        formatted = [...groups.entries()].map(([k, v]) => `${k}: ${String(v)}`).join('\n');
      } else if (section.format === 'count_and_list') {
        const label = (r: Row): string => {
          const v = r.summary ?? r.name ?? r.title;
          return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : JSON.stringify(r);
        };
        formatted = `Count: ${String(rows.length)}\n` + rows.map((r) => `- ${label(r)}`).join('\n');
      } else {
        const label = (r: Row): string => {
          const v = r.summary ?? r.name ?? r.title;
          return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : JSON.stringify(r);
        };
        formatted = rows.map((r) => `- ${label(r)}`).join('\n');
      }

      sections.push({ name: section.name, rows, count: rows.length, formatted });
    }

    return { sections, isEmpty: allEmpty, since };
  }
}
