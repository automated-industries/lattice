import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../../src/gui/ai/chat.js';

/**
 * When the assistant creates a record that names other things (a meeting's
 * attendees, a message's sender), it should PROACTIVELY find/create and link those
 * related records — following the convention already in the data — instead of
 * leaving the names as plain text and waiting to be asked. And it should link the
 * current user's OWN record to records about them, found by searching their name.
 */
describe('assistant proactive-linking + current-user guidance in the system prompt', () => {
  it('instructs proactive relationship wiring for named related entities, per the data convention', () => {
    const prompt = buildSystemPrompt('schema').toLowerCase();
    expect(prompt).toContain('proactively');
    expect(prompt).toMatch(/attendee|participant|sender/);
    expect(prompt).toMatch(/follow the convention|already in the data/);
  });

  it('tells the model to link the current user to records about them, found by their name', () => {
    const prompt = buildSystemPrompt('schema', 'Alex Rivera');
    expect(prompt).toContain('Alex Rivera');
    expect(prompt.toLowerCase()).toMatch(/their own record/);
    // Leverages the now-reliable name search rather than pre-resolving an id.
    expect(prompt).toContain('searching for "Alex Rivera"');
  });
});
