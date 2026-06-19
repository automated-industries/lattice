import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Lattice, SeedReconciliationError } from '../../src/lattice.js';

/**
 * Characterization snapshot for seed()'s upsert + junction-link resolution.
 *
 * This test pins the OBSERVABLE result of a seed() with linkTo: the full
 * junction row-set, the SeedResult counters, and the unresolvedLinks ordering.
 * It is GREEN against the current per-row implementation AND must stay GREEN
 * after the per-row re-read is dropped and the FK resolves are batched into a
 * single IN(...) lookup. If any byte of the resulting graph changes, this fails.
 */
describe('seed() link resolution — result-identity snapshot', () => {
  let db: Lattice;

  beforeEach(async () => {
    db = new Lattice(':memory:');
    db.define('meeting', {
      columns: {
        id: 'TEXT PRIMARY KEY',
        slug: 'TEXT NOT NULL',
        title: 'TEXT',
        deleted_at: 'TEXT',
      },
      render: () => '',
      outputFile: 'meeting.md',
    });
    db.define('people', {
      columns: {
        id: 'TEXT PRIMARY KEY',
        slug: 'TEXT NOT NULL',
        name: 'TEXT',
        deleted_at: 'TEXT',
      },
      render: () => '',
      outputFile: 'people.md',
    });
    db.define('meeting_people', {
      columns: {
        meeting_id: 'TEXT NOT NULL',
        person_id: 'TEXT NOT NULL',
        role: 'TEXT',
      },
      primaryKey: ['meeting_id', 'person_id'],
      render: () => '',
      outputFile: 'meeting-people.md',
    });
    await db.init();

    // alice + carol exist; bob deliberately absent (an unresolvable link).
    // A soft-deleted "ghost" with slug 'alice' must NOT win the resolve.
    await db.seed({
      table: 'people',
      naturalKey: 'slug',
      data: [
        { slug: 'alice', name: 'Alice' },
        { slug: 'carol', name: 'Carol' },
      ],
    });
  });

  afterEach(() => {
    db.close();
  });

  /**
   * Resolve every meeting's attendees through the same code path that the
   * boot seeder uses. Two records, mixed resolvable/unresolvable, a duplicate
   * name across records (carol attends both) and an empty attendee list.
   */
  function seedMeetings(onUnresolvedLink?: 'collect' | 'throw') {
    return db.seed({
      table: 'meeting',
      naturalKey: 'slug',
      data: [
        { slug: 'standup', title: 'Standup', attendees: ['alice', 'bob', 'carol'] },
        { slug: 'retro', title: 'Retro', attendees: ['carol'] },
        { slug: 'solo', title: 'Solo', attendees: [] },
      ],
      linkTo: {
        attendees: {
          junction: 'meeting_people',
          foreignKey: 'person_id',
          resolveBy: 'slug',
          resolveTable: 'people',
          extras: { role: 'attendee' },
        },
      },
      ...(onUnresolvedLink ? { onUnresolvedLink } : {}),
    });
  }

  /** Stable snapshot of the junction graph keyed on (meeting.slug, people.slug). */
  async function junctionSnapshot(): Promise<string> {
    const links = await db.query('meeting_people');
    const meetings = await db.query('meeting');
    const people = await db.query('people');
    const mById = new Map(meetings.map((m) => [m.id as string, m.slug as string]));
    const pById = new Map(people.map((p) => [p.id as string, p.slug as string]));
    const rows = links
      .map((l) => ({
        meeting: mById.get(l.meeting_id as string) ?? '?',
        person: pById.get(l.person_id as string) ?? '?',
        role: (l.role as string) ?? null,
      }))
      .sort((a, b) =>
        a.meeting === b.meeting
          ? a.person.localeCompare(b.person)
          : a.meeting.localeCompare(b.meeting),
      );
    return JSON.stringify(rows);
  }

  it('collect mode: junction graph + counters + unresolved ordering are stable', async () => {
    const result = await seedMeetings();

    // Counters: 2 resolvable links (standup→alice, standup→carol, retro→carol = 3),
    // bob unresolved. carol resolves in both meetings.
    expect(result.upserted).toBe(3);
    expect(result.linked).toBe(3);
    expect(result.unresolvedLinks).toHaveLength(1);
    // Ordering of unresolvedLinks follows (record, field, name) iteration order.
    expect(result.unresolvedLinks[0]).toMatchObject({
      record: 'standup',
      field: 'attendees',
      name: 'bob',
      junction: 'meeting_people',
      resolveTable: 'people',
      resolveBy: 'slug',
    });

    // Row-set snapshot: the exact junction graph, with junction extras (role).
    expect(await junctionSnapshot()).toBe(
      JSON.stringify([
        { meeting: 'retro', person: 'carol', role: 'attendee' },
        { meeting: 'standup', person: 'alice', role: 'attendee' },
        { meeting: 'standup', person: 'carol', role: 'attendee' },
      ]),
    );
  });

  it('soft-deleted target does not resolve a link (NOT_DELETED preserved)', async () => {
    // Soft-delete carol; her links must now surface as unresolved, not resolve
    // to the tombstoned row. Proves the batched IN(...) keeps the soft-delete
    // predicate the per-row getByNaturalKey used.
    const carol = await db.getByNaturalKey('people', 'slug', 'carol');
    await db.update('people', carol!.id as string, { deleted_at: new Date().toISOString() });

    const result = await seedMeetings();
    expect(result.linked).toBe(1); // only standup→alice
    // bob (standup) + carol (standup) + carol (retro) all unresolved, in order.
    expect(result.unresolvedLinks.map((u) => `${u.record}:${u.name}`)).toEqual([
      'standup:bob',
      'standup:carol',
      'retro:carol',
    ]);
  });

  it("'throw' mode still raises and lists every missing target", async () => {
    await expect(seedMeetings('throw')).rejects.toBeInstanceOf(SeedReconciliationError);
    try {
      await seedMeetings('throw');
      expect.unreachable('seed should have thrown');
    } catch (e) {
      const err = e as SeedReconciliationError;
      expect(err.table).toBe('meeting');
      expect(err.unresolvedLinks.map((u) => u.name)).toContain('bob');
    }
  });

  it('idempotent re-seed produces the identical junction graph', async () => {
    await seedMeetings();
    const first = await junctionSnapshot();
    const second = await seedMeetings();
    expect(await junctionSnapshot()).toBe(first);
    // No duplicate links on re-run (link() is INSERT OR IGNORE by default).
    expect(second.linked).toBe(3);
  });
});
