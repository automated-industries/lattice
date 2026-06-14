import { describe, expect, it } from 'vitest';
import { RealtimeBroker } from '../../src/gui/realtime.js';

describe('RealtimeBroker', () => {
  it('rejects non-postgres URLs', () => {
    expect(() => new RealtimeBroker('sqlite:///tmp/foo.db')).toThrow(/postgres:\/\//);
    expect(() => new RealtimeBroker('mysql://x@y/z')).toThrow(/postgres:\/\//);
  });

  it("starts in 'connecting' state before start() runs", () => {
    const broker = new RealtimeBroker('postgres://u:p@127.0.0.1:1/x');
    expect(broker.state()).toBe('connecting');
  });

  it('stop() is idempotent and transitions to stopped', async () => {
    const broker = new RealtimeBroker('postgres://u:p@127.0.0.1:1/x');
    await broker.stop();
    expect(broker.state()).toBe('stopped');
    // Second stop is a no-op.
    await broker.stop();
    expect(broker.state()).toBe('stopped');
  });
});
