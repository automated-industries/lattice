import type { Row, SecurityOptions, AuditEvent } from '../types.js';

const SUSPICIOUS_PATTERNS = [
  /(\bdrop\b|\bdelete\b|\btruncate\b|\binsert\b|\bupdate\b)\s+\b(table|from|into)\b/i,
  /<script[\s\S]*?>/i,
  /javascript:/i,
  /\.\.[/\\]/,
  /\x00/,
];

export class Sanitizer {
  private readonly _options: Required<SecurityOptions>;
  private readonly _auditHandlers: Array<(event: AuditEvent) => void> = [];

  constructor(options: SecurityOptions = {}) {
    this._options = {
      sanitize: options.sanitize ?? true,
      auditTables: options.auditTables ?? [],
      fieldLimits: options.fieldLimits ?? {},
    };
  }

  onAudit(handler: (event: AuditEvent) => void): void {
    this._auditHandlers.push(handler);
  }

  sanitizeRow(row: Row): Row {
    if (!this._options.sanitize) return row;

    const out: Row = {};
    for (const [key, val] of Object.entries(row)) {
      if (typeof val === 'string') {
        let s = val
          // Strip null bytes
          .replace(/\x00/g, '')
          // Strip dangerous control chars (keep tab/newline/CR)
          .replace(/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');

        // Apply field limit
        const limit = this._options.fieldLimits[key];
        if (limit !== undefined && s.length > limit) {
          s = s.slice(0, limit);
        }

        // Warn on suspicious content (do not block)
        for (const pattern of SUSPICIOUS_PATTERNS) {
          if (pattern.test(s)) {
            console.warn(`[lattice/security] Suspicious content in field "${key}"`);
            break;
          }
        }

        out[key] = s;
      } else {
        out[key] = val;
      }
    }
    return out;
  }

  emitAudit(
    table: string,
    operation: AuditEvent['operation'],
    id: string,
  ): void {
    if (!this._options.auditTables.includes(table)) return;
    const event: AuditEvent = {
      table,
      operation,
      id,
      timestamp: new Date().toISOString(),
    };
    for (const handler of this._auditHandlers) {
      handler(event);
    }
  }

  isAuditTable(table: string): boolean {
    return this._options.auditTables.includes(table);
  }
}
