import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../../src/gui/ai/chat.js';

/**
 * Bug 11: the assistant system prompt must robustly detail clean, scalable
 * star-schema data-model best practices, so every object it creates or reorganizes
 * follows a well-normalized relational model. This pins the guidance so it can't
 * silently regress.
 */
describe('Bug 11: star-schema data-model guidance', () => {
  const prompt = buildSystemPrompt('# Current database\n(none)');

  it('names the star schema + the core normalization principles', () => {
    expect(prompt).toMatch(/star schema/i);
    expect(prompt).toMatch(/normaliz/i);
    expect(prompt).toMatch(/fact/i);
    expect(prompt).toMatch(/dimension/i);
    expect(prompt).toMatch(/one concept per table/i);
  });

  it('steers derived data to computed views and dedup to a reversible merge', () => {
    expect(prompt).toMatch(/computed/i);
    expect(prompt).toMatch(/dedup|duplicate/i);
    expect(prompt).toMatch(/reversible|additive/i);
  });
});
