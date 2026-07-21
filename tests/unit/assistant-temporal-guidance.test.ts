import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../../src/gui/ai/chat.js';
import { getFunction } from '../../src/gui/ai/registry.js';

/**
 * Bug 10: temporal ("most recent / last / latest") questions were answered with
 * relevance search, which buries a newer-but-low-text record (e.g. a bare calendar
 * HOLD) and returns the wrong "most recent". The fix is guidance, not new query
 * capability — list_rows already sorts by the event/date column. These guards pin
 * the guidance so it can't silently regress:
 *   - the system prompt must route time-ordered questions to list_rows-by-date, and
 *   - the `search` tool must warn it is relevance-ranked, not time-ordered.
 */
describe('Bug 10: temporal-query guidance', () => {
  it('the assistant system prompt routes time-ordered questions to date-ordered list_rows, not search', () => {
    const prompt = buildSystemPrompt('# Current database\n(none)');
    // Names the temporal triggers and the correct tool + ordering.
    expect(prompt).toMatch(/most recent|latest|newest/i);
    expect(prompt).toMatch(/list_rows/);
    expect(prompt).toMatch(/orderDir\s*=?\s*"?desc"?|order(ed)? by date/i);
    // Explicitly steers AWAY from search for recency.
    expect(prompt).toMatch(/NEVER with search|not with search|do NOT.*search/i);
    // Pushback + gap handling (re-query by date; don't name an older record as latest).
    expect(prompt).toMatch(/re-?query|pushe?s? back/i);
  });

  it('list_rows exposes an orderBy column so the model can sort by a date field', () => {
    const listRows = getFunction('list_rows');
    expect(listRows).toBeDefined();
    const props = (listRows!.args as { properties?: Record<string, unknown> }).properties ?? {};
    expect(props.orderBy).toBeDefined();
    expect(props.orderDir).toBeDefined();
  });

  it('the search tool warns it is relevance-ranked, not time-ordered', () => {
    const search = getFunction('search');
    expect(search).toBeDefined();
    expect(search!.description).toMatch(/relevance/i);
    expect(search!.description).toMatch(/not.*time|most recent|latest|list_rows/i);
  });
});
