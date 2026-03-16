import { describe, it, expect, vi } from 'vitest';
import { Sanitizer } from '../../src/security/sanitize.js';

describe('Sanitizer', () => {
  it('strips null bytes', () => {
    const s = new Sanitizer({ sanitize: true });
    const result = s.sanitizeRow({ name: 'hello\x00world' });
    expect(result.name).toBe('helloworld');
  });

  it('strips control characters but preserves tab and newline', () => {
    const s = new Sanitizer({ sanitize: true });
    const result = s.sanitizeRow({ name: 'hello\x01\t\nworld' });
    expect(result.name).toBe('hello\t\nworld');
  });

  it('enforces field limits by truncating', () => {
    const s = new Sanitizer({ sanitize: true, fieldLimits: { notes: 5 } });
    const result = s.sanitizeRow({ notes: 'hello world' });
    expect(result.notes).toBe('hello');
  });

  it('passes through non-string values unchanged', () => {
    const s = new Sanitizer({ sanitize: true });
    const result = s.sanitizeRow({ count: 42, active: true, data: null });
    expect(result.count).toBe(42);
    expect(result.active).toBe(true);
    expect(result.data).toBeNull();
  });

  it('skips sanitization when sanitize is false', () => {
    const s = new Sanitizer({ sanitize: false });
    const result = s.sanitizeRow({ name: 'hello\x00world' });
    expect(result.name).toBe('hello\x00world');
  });

  it('emits audit events for configured tables', () => {
    const s = new Sanitizer({ auditTables: ['users'] });
    const handler = vi.fn();
    s.onAudit(handler);
    s.emitAudit('users', 'insert', 'user-1');
    expect(handler).toHaveBeenCalledWith({
      table: 'users',
      operation: 'insert',
      id: 'user-1',
      timestamp: expect.any(String) as string,
    });
  });

  it('does not emit audit events for non-configured tables', () => {
    const s = new Sanitizer({ auditTables: ['users'] });
    const handler = vi.fn();
    s.onAudit(handler);
    s.emitAudit('tasks', 'insert', 'task-1');
    expect(handler).not.toHaveBeenCalled();
  });
});
