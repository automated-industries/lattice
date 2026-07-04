import { describe, it, expect } from 'vitest';
import { parseConfigString } from '../../src/config/parser.js';

const configDir = '/fake/project';

const BASE_ENTITIES = `
db: ':memory:'
entities:
  ticket:
    fields:
      id: { type: uuid, primaryKey: true }
      title: { type: text }
      priority: { type: integer }
      assignee_id: { type: uuid }
    relations:
      assignee: { type: belongsTo, table: user, foreignKey: assignee_id }
    outputFile: tickets.md
  user:
    fields:
      id: { type: uuid, primaryKey: true }
      name: { type: text }
    outputFile: users.md
  ticket_tags:
    fields:
      id: { type: uuid, primaryKey: true }
      ticket_id: { type: uuid }
      tag_id: { type: uuid }
    relations:
      ticket: { type: belongsTo, table: ticket, foreignKey: ticket_id }
      tag: { type: belongsTo, table: tag, foreignKey: tag_id }
    outputFile: ticket_tags.md
  tag:
    fields:
      id: { type: uuid, primaryKey: true }
      name: { type: text }
    outputFile: tags.md
`;

const parse = (computedYaml: string) => parseConfigString(BASE_ENTITIES + computedYaml, configDir);

describe('config parser — computed: section', () => {
  it('parses a valid computed section in declaration order', () => {
    const result = parse(`
computed:
  ticket_view:
    base: ticket
    description: A projection.
    fields:
      title: { kind: alias, source: title }
      who: { kind: alias, source: assignee.name }
      urgent: { kind: calc, expr: "priority >= 3", type: boolean }
      category: { kind: ai_classify, input: title, prompt: Categorize., labels: [bug, feature] }
      summary: { kind: ai_transform, inputs: [title], prompt: Summarize., model: cheapest }
      tag_count: { kind: aggregate, via: ticket_tags.tag, fn: count }
  second_view:
    base: ticket_view
    fields:
      t: { kind: alias, source: title }
`);
    expect(result.computedTables.map((c) => c.name)).toEqual(['ticket_view', 'second_view']);
    const def = result.computedTables[0]!.definition;
    expect(def.base).toBe('ticket');
    expect(def.description).toBe('A projection.');
    expect(Object.keys(def.fields)).toHaveLength(6);
    expect(def.fields.summary).toEqual({
      kind: 'ai_transform',
      inputs: ['title'],
      prompt: 'Summarize.',
      model: 'cheapest',
    });
    // Entities are untouched by the computed section.
    expect(result.tables.map((t) => t.name)).toEqual(['ticket', 'user', 'ticket_tags', 'tag']);
  });

  it('parses configs without a computed section to an empty list', () => {
    expect(parseConfigString(BASE_ENTITIES, configDir).computedTables).toEqual([]);
  });

  it('rejects an unknown field kind', () => {
    expect(() =>
      parse(`
computed:
  v:
    base: ticket
    fields:
      x: { kind: teleport, source: title }
`),
    ).toThrow(/unknown kind "teleport".*alias, calc, ai_classify, ai_transform, aggregate/);
  });

  it('rejects unresolved references at parse time', () => {
    expect(() =>
      parse(`
computed:
  v:
    base: ticket
    fields:
      x: { kind: alias, source: nope }
`),
    ).toThrow(/"ticket" has no column "nope"/);
    expect(() =>
      parse(`
computed:
  v:
    base: ticket
    fields:
      x: { kind: ai_classify, input: assignee.nope, prompt: p, labels: [a] }
`),
    ).toThrow(/"user" has no column "nope"/);
  });

  it('rejects an unknown base table', () => {
    expect(() =>
      parse(`
computed:
  v:
    base: nothing
    fields:
      x: { kind: alias, source: title }
`),
    ).toThrow(/unknown base table "nothing"/);
  });

  it('rejects empty labels and missing prompts', () => {
    expect(() =>
      parse(`
computed:
  v:
    base: ticket
    fields:
      x: { kind: ai_classify, input: title, prompt: p, labels: [] }
`),
    ).toThrow(/labels/);
    expect(() =>
      parse(`
computed:
  v:
    base: ticket
    fields:
      x: { kind: ai_transform, inputs: [title] }
`),
    ).toThrow(/non-empty string "prompt"/);
  });

  it('rejects an invalid model tier', () => {
    expect(() =>
      parse(`
computed:
  v:
    base: ticket
    fields:
      x: { kind: ai_classify, input: title, prompt: p, labels: [a], model: gpt-4 }
`),
    ).toThrow(/invalid model/);
  });

  it('rejects computed→computed base cycles, naming the cycle', () => {
    expect(() =>
      parse(`
computed:
  a:
    base: b
    fields:
      x: { kind: alias, source: y }
  b:
    base: a
    fields:
      y: { kind: alias, source: x }
`),
    ).toThrow(/base cycle/);
  });

  it('rejects reserved names and entity collisions', () => {
    expect(() =>
      parse(`
computed:
  __lattice_evil:
    base: ticket
    fields:
      x: { kind: alias, source: title }
`),
    ).toThrow(/reserved/i);
    expect(() =>
      parse(`
computed:
  ticket:
    base: user
    fields:
      x: { kind: alias, source: name }
`),
    ).toThrow(/collides with entity "ticket"/);
  });

  it('rejects malformed shapes loudly', () => {
    expect(() => parse(`\ncomputed: [not, an, object]\n`)).toThrow(
      /config\.computed must be an object/,
    );
    expect(() =>
      parse(`
computed:
  v:
    fields:
      x: { kind: alias, source: title }
`),
    ).toThrow(/must name a non-empty "base"/);
    expect(() =>
      parse(`
computed:
  v:
    base: ticket
`),
    ).toThrow(/must have a "fields" object/);
    expect(() =>
      parse(`
computed:
  v:
    base: ticket
    fields:
      x: { kind: calc, expr: 'title', type: money }
`),
    ).toThrow(/invalid calc type/);
  });

  it('rejects injection attempts inside calc expressions at parse time', () => {
    expect(() =>
      parse(`
computed:
  v:
    base: ticket
    fields:
      x: { kind: calc, expr: "title; DROP TABLE ticket; --" }
`),
    ).toThrow(/';' is not allowed/);
  });

  it('rejects aggregate specs that do not resolve', () => {
    expect(() =>
      parse(`
computed:
  v:
    base: ticket
    fields:
      n: { kind: aggregate, via: ticket_tags, fn: count }
`),
    ).toThrow(/via must be/);
    expect(() =>
      parse(`
computed:
  v:
    base: ticket
    fields:
      n: { kind: aggregate, via: ticket_tags.tag, fn: launch }
`),
    ).toThrow(/invalid fn/);
    expect(() =>
      parse(`
computed:
  v:
    base: ticket
    fields:
      n: { kind: aggregate, via: ticket_tags.tag, fn: sum, column: nope }
`),
    ).toThrow(/"tag" has no column "nope"/);
  });

  it('rejects a computed field named id', () => {
    expect(() =>
      parse(`
computed:
  v:
    base: ticket
    fields:
      id: { kind: alias, source: title }
`),
    ).toThrow(/field "id" collides/);
  });
});
