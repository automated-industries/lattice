import type { Row } from '../types.js';

/**
 * Replace `{{path}}` tokens in a template string with values from a row.
 *
 * Supports dot-notation paths for nested objects, which is the primary mechanism
 * for accessing resolved `belongsTo` relation fields:
 *
 * ```ts
 * interpolate('{{title}} by {{author.name}}', {
 *   title: 'Hello World',
 *   author: { name: 'Alice', id: 'u-1' },
 * });
 * // → 'Hello World by Alice'
 * ```
 *
 * - Unknown paths render as empty string.
 * - `null` and `undefined` values render as empty string.
 * - Non-string primitives are coerced with `String()`.
 */
export function interpolate(template: string, row: Row): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_, path: string) => {
    const parts = path.trim().split('.');
    let val: unknown = row;
    for (const part of parts) {
      if (val == null || typeof val !== 'object') return '';
      val = (val as Record<string, unknown>)[part];
    }
    return val == null ? '' : String(val);
  });
}
