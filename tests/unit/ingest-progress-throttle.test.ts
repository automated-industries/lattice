import { describe, it, expect } from 'vitest';
import { shouldPublishIngestProgress } from '../../src/gui/sources-routes.js';

describe('shouldPublishIngestProgress throttle', () => {
  it('always publishes terminal events (done >= total)', () => {
    // First event is terminal.
    expect(shouldPublishIngestProgress(5, 5, 0, 0)).toBe(true);
    // Mid-progress event marked terminal.
    expect(shouldPublishIngestProgress(10, 10, 8, Date.now() - 500)).toBe(true);
  });

  it('publishes the first event (prevTime = 0)', () => {
    expect(shouldPublishIngestProgress(1, 100, 0, 0)).toBe(true);
    expect(shouldPublishIngestProgress(0, 100, 0, 0)).toBe(true);
  });

  it('publishes after 5+ files completed since last event', () => {
    const now = Date.now();
    // Last event at done=0, just started (prevTime recent).
    expect(shouldPublishIngestProgress(5, 100, 0, now - 100)).toBe(true);
    expect(shouldPublishIngestProgress(4, 100, 0, now - 100)).toBe(false);
    // Last event at done=10, now at done=15.
    expect(shouldPublishIngestProgress(15, 100, 10, now - 100)).toBe(true);
    expect(shouldPublishIngestProgress(14, 100, 10, now - 100)).toBe(false);
  });

  it('publishes after 2+ seconds since last event', () => {
    const now = Date.now();
    const twoPlusSecAgo = now - 2100;
    // Less than 1 file completed since last event, but 2.1s elapsed.
    expect(shouldPublishIngestProgress(11, 100, 10, twoPlusSecAgo)).toBe(true);
    // Just under 2s elapsed.
    expect(shouldPublishIngestProgress(11, 100, 10, now - 1900)).toBe(false);
  });

  it('respects injected clock for testing', () => {
    const mockTime = 1000;
    const later = 3100;
    // Suppress without injected time (real Date.now).
    expect(shouldPublishIngestProgress(11, 100, 10, mockTime, () => mockTime + 500)).toBe(false);
    // Allow with injected time (2.1s later).
    expect(shouldPublishIngestProgress(11, 100, 10, mockTime, () => later)).toBe(true);
  });

  it('handles edge cases', () => {
    // done > total (impossible but should allow terminal).
    expect(shouldPublishIngestProgress(105, 100, 50, Date.now() - 500)).toBe(true);
    // prevDone > done (impossible but shouldn't crash).
    expect(shouldPublishIngestProgress(8, 100, 10, Date.now() - 100)).toBe(false);
  });
});
