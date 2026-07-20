import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Lattice } from '../../src/lattice.js';
import { FeedBus } from '../../src/gui/feed.js';
import {
  enqueueQuestion,
  listPendingQuestions,
  parseQuestionContext,
} from '../../src/gui/questions.js';

describe('question context with subject', () => {
  let db: Lattice;
  let feed: FeedBus;

  beforeEach(async () => {
    db = new Lattice(':memory:');
    feed = new FeedBus();
    await db.init();
  });

  afterEach(() => {
    db.close();
  });

  it('enqueueQuestion stores subject in context_json when provided', async () => {
    const qId = await enqueueQuestion(db, feed, {
      source: 'enrich',
      question: 'Is this a file?',
      options: ['Yes', 'No'],
      context: {
        action: { kind: 'none' },
        subject: { table: 'files', rowId: 'f123', label: 'invoice.pdf' },
      },
    });

    const q = await listPendingQuestions(db, 1);
    expect(q).toHaveLength(1);
    expect(q[0]?.id).toBe(qId);

    // The context_json should be parseable and contain the subject
    const context = parseQuestionContext(q[0]?.context_json || null);
    expect(context.subject).toBeDefined();
    expect(context.subject?.table).toBe('files');
    expect(context.subject?.rowId).toBe('f123');
    expect(context.subject?.label).toBe('invoice.pdf');
  });

  it('enqueueQuestion works without subject (backward compatible)', async () => {
    await enqueueQuestion(db, feed, {
      source: 'enrich',
      question: 'Is this a file?',
      options: ['Yes', 'No'],
      context: {
        action: { kind: 'none' },
      },
    });

    const q = await listPendingQuestions(db, 1);
    expect(q).toHaveLength(1);

    // The context_json should parse without error, subject will be undefined
    const context = parseQuestionContext(q[0]?.context_json || null);
    expect(context.subject).toBeUndefined();
    expect(context.action?.kind).toBe('none');
  });

  it('parseQuestionContext tolerates missing subject field', async () => {
    // Verify that old questions (before subject was added) still parse correctly
    const context = parseQuestionContext(JSON.stringify({ action: { kind: 'none' } }));
    expect(context.subject).toBeUndefined();
    expect(context.action?.kind).toBe('none');
  });

  it('parseQuestionContext tolerates malformed JSON', async () => {
    // Backward compatibility: malformed context degrades to empty object
    const context = parseQuestionContext('{ not valid json }');
    expect(context.subject).toBeUndefined();
    expect(context.action).toBeUndefined(); // parseQuestionContext returns empty object on malformed
  });
});
