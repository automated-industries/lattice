import { describe, it, expect } from 'vitest';
import { deriveCanonicalContexts } from '../../src/framework/canonical-context.js';
import type { TableDefinition } from '../../src/types.js';

// Regression for the asymmetric many-to-many render: a junction linking A and B
// must render the REMOTE entity on BOTH sides (A shows its Bs, B shows its As).
// Pre-fix, the auto-derivation emitted a raw `hasMany` dump per parent, so each
// side surfaced only the FK pointing back at itself — under A you saw A's own id
// repeated, never the link to B.

const contact = {
  columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT' },
} as unknown as TableDefinition;

const meeting = {
  columns: { id: 'TEXT PRIMARY KEY', subject: 'TEXT' },
} as unknown as TableDefinition;

// A PAYLOAD-bearing junction (role/rsvp) whose identity is the composite PK of its
// two FKs — exactly the `contact_meeting` shape that rendered asymmetrically (the
// payload is why a naive "no extra columns" junction test would have missed it).
const contactMeeting = {
  columns: { contact_id: 'TEXT', meeting_id: 'TEXT', role: 'TEXT', rsvp: 'TEXT' },
  primaryKey: ['contact_id', 'meeting_id'],
  relations: {
    contact: { type: 'belongsTo', table: 'contact', foreignKey: 'contact_id' },
    meeting: { type: 'belongsTo', table: 'meeting', foreignKey: 'meeting_id' },
  },
} as unknown as TableDefinition;

describe('canonical-context junction render symmetry', () => {
  const out = deriveCanonicalContexts([
    { name: 'contact', definition: contact },
    { name: 'meeting', definition: meeting },
    { name: 'contact_meeting', definition: contactMeeting },
  ]);
  const byTable = Object.fromEntries(out.map((o) => [o.table, o.definition]));

  it('renders the REMOTE entity on BOTH sides of a payload-bearing junction', () => {
    // The contact renders its MEETINGS and the meeting renders its CONTACTS —
    // symmetric. Pre-fix the contact only got a `CONTACT_MEETING.md` dump.
    expect(Object.keys(byTable.contact.files)).toContain('MEETING.md');
    expect(Object.keys(byTable.meeting.files)).toContain('CONTACT.md');
    expect(Object.keys(byTable.contact.files)).not.toContain('CONTACT_MEETING.md');

    expect(byTable.contact.files['MEETING.md']!.source).toMatchObject({
      type: 'manyToMany',
      junctionTable: 'contact_meeting',
      localKey: 'contact_id',
      remoteKey: 'meeting_id',
      remoteTable: 'meeting',
    });
    // Reciprocal — proves the symmetry the invariant test below locks in.
    expect(byTable.meeting.files['CONTACT.md']!.source).toMatchObject({
      type: 'manyToMany',
      junctionTable: 'contact_meeting',
      localKey: 'meeting_id',
      remoteKey: 'contact_id',
      remoteTable: 'contact',
    });
  });

  it('emits a reciprocal manyToMany for every junction render (symmetry invariant)', () => {
    // The symmetry invariant itself, enforced at test time. (It used to be a
    // render-time throw — removed, because a derivation regression should fail CI,
    // not crash a user's render.) For every manyToMany A → B, B must carry the
    // reciprocal source back to A.
    for (const { table, definition } of out) {
      for (const [file, spec] of Object.entries(definition.files)) {
        const s = spec.source;
        if (s.type !== 'manyToMany') continue;
        const remote = byTable[s.remoteTable];
        if (!remote) continue; // remote has no derived context (e.g. a system table)
        const reciprocal = Object.values(remote.files).some(
          (rs) =>
            rs.source.type === 'manyToMany' &&
            rs.source.junctionTable === s.junctionTable &&
            rs.source.localKey === s.remoteKey &&
            rs.source.remoteKey === s.localKey,
        );
        expect(
          reciprocal,
          `"${s.junctionTable}" renders ${table} → ${s.remoteTable} but ${s.remoteTable} has no reciprocal back to ${table} (${file})`,
        ).toBe(true);
      }
    }
  });

  it('the rendered list shows the remote entity label, not the local FK', () => {
    // `manyToMany` resolves to the REMOTE rows, so the contact's MEETING.md renders
    // the meeting's subject — never `contact_id: <self>`.
    const render = byTable.contact.files['MEETING.md']!.render;
    const md = render([{ id: 'm1', subject: 'Kickoff' } as unknown as Record<string, unknown>]);
    expect(md).toContain('Kickoff');
    expect(md).not.toContain('contact_id');
  });

  it('keeps a first-class entity with two FKs as a hasMany child (not collapsed)', () => {
    // `tasks(id, title, project_id, assignee_id)` has two FKs but its own identity
    // + content, so under each parent it renders its OWN rows (hasMany), never the
    // other FK's entity. This is the guard against collapsing a real entity.
    const tasks = {
      columns: {
        id: 'TEXT PRIMARY KEY',
        title: 'TEXT',
        project_id: 'TEXT',
        assignee_id: 'TEXT',
      },
      relations: {
        project: { type: 'belongsTo', table: 'project', foreignKey: 'project_id' },
        assignee: { type: 'belongsTo', table: 'contact', foreignKey: 'assignee_id' },
      },
    } as unknown as TableDefinition;
    const project = {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT' },
    } as unknown as TableDefinition;
    const o = deriveCanonicalContexts([
      { name: 'tasks', definition: tasks },
      { name: 'project', definition: project },
      { name: 'contact', definition: contact },
    ]);
    const bt = Object.fromEntries(o.map((x) => [x.table, x.definition]));
    expect(Object.keys(bt.project.files)).toContain('TASKS.md');
    expect(bt.project.files['TASKS.md']!.source.type).toBe('hasMany');
  });
});
