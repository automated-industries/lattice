import { describe, expect, it } from 'vitest';
import { parseLlmDate } from '../../src/gui/ai/asof-llm.js';

describe('parseLlmDate', () => {
  it('accepts a clean ISO reply', () => {
    expect(parseLlmDate('2026-03-31')).toBe('2026-03-31');
  });

  it('extracts an ISO date even with surrounding text', () => {
    expect(parseLlmDate('The as-of date is 2025-06-30.')).toBe('2025-06-30');
  });

  it('returns null for NONE / no date', () => {
    expect(parseLlmDate('NONE')).toBeNull();
    expect(parseLlmDate('I could not find a date.')).toBeNull();
    expect(parseLlmDate('')).toBeNull();
  });

  it('rejects implausible dates', () => {
    expect(parseLlmDate('2026-13-40')).toBeNull(); // bad month/day
    expect(parseLlmDate('1999-01-01')).toBeNull(); // out of business range
  });
});
