import { describe, it, expect } from 'vitest';

import { buildSystemPrompt } from '../../src/gui/ai/chat.js';
import { REGISTRY } from '../../src/gui/ai/registry.js';

// Regression guards for the "Gladys can't handle dates" bug: the assistant
// returned April meetings for "the meeting I had today" because (1) it was never
// told the current date, and (2) its list_rows read was oldest-first by insert
// time. See docs — the fix injects a "# Current date" section and makes reads
// newest-first by the real event-time column, with a model-facing order/filter.
describe('assistant temporal grounding', () => {
  it('injects a "# Current date" section anchored to the supplied instant', () => {
    const prompt = buildSystemPrompt(
      'schema',
      undefined,
      undefined,
      [],
      '2026-07-02T15:04:05.000Z',
      'America/New_York',
    );
    expect(prompt).toContain('# Current date');
    expect(prompt).toContain('Today is 2026-07-02T15:04:05.000Z');
    expect(prompt).toContain('America/New_York');
    // It must instruct relative-to-now interpretation, not training data.
    expect(prompt).toMatch(/today.*recent.*most recent/i);
    expect(prompt.toLowerCase()).toContain('training data');
  });

  it('always emits a date section even when no instant is supplied (fallback to now)', () => {
    const prompt = buildSystemPrompt('schema');
    expect(prompt).toContain('# Current date');
    // A real ISO timestamp is present (YYYY-MM-DDTHH:MM…).
    expect(prompt).toMatch(/Today is \d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });
});

describe('list_rows tool advertises order + date-filter controls', () => {
  const listRows = REGISTRY.find((f) => f.name === 'list_rows');

  it('exists and exposes orderBy / orderDir / filter to the model', () => {
    expect(listRows).toBeDefined();
    const props = (listRows?.args as { properties?: Record<string, unknown> }).properties ?? {};
    expect(props).toHaveProperty('orderBy');
    expect(props).toHaveProperty('orderDir');
    expect(props).toHaveProperty('filter');
    // orderDir is an asc/desc enum.
    const orderDir = props.orderDir as { enum?: string[] };
    expect(orderDir.enum).toEqual(['asc', 'desc']);
  });

  it('describes the newest-first default so the model knows recency is available', () => {
    expect(String(listRows?.description).toLowerCase()).toContain('newest-first');
  });
});
