export function requireString(v: unknown, label: string): string {
  if (typeof v !== 'string' || v.length === 0) throw new Error(`${label} is required`);
  return v;
}

export function requireTable(v: unknown, valid: Set<string>): string {
  const table = requireString(v, 'table');
  if (!valid.has(table)) throw new Error(`Unknown table: ${table}`);
  return table;
}
