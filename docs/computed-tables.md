# Computed tables

A **computed table** is a live, read-only view built from the tables you already
have. You describe _what each field is_ — a copied column, a calculation, an
AI-derived value, or a total across linked rows — and Lattice compiles that
description into a SQL VIEW and registers it as a queryable table. The values
are never copied: every read reflects the current state of the records the view
is built from.

Everything here is **additive and opt-in**: a workspace with no `computed:`
section behaves exactly as before.

## The shape of a definition

A computed table has one **base** table (a declared entity or another computed
table) and a set of named **fields**. The view always projects the base's
primary key as `id` first, then each field in declaration order:

```yaml
computed:
  ticket_summary:
    base: tickets
    fields:
      title: { kind: alias, source: title }
      team: { kind: alias, source: assignee.team.name }
      is_urgent: { kind: calc, expr: 'priority >= 3', type: boolean }
      tag_count: { kind: aggregate, via: ticket_tags.tag, fn: count }
```

Definitions live in the workspace config next to `entities:`. The GUI builder
(below) reads and writes the same section — a hand-edited config and a
GUI-built view are the same thing.

## The five field kinds

### `alias` — copy a field

Project a column of the base table, or follow declared `belongsTo` relations
with a dotted path:

```yaml
title: { kind: alias, source: title }
team: { kind: alias, source: assignee.team.name } # tickets → people → teams
```

### `calc` — a calculation

A sandboxed expression over base columns and dotted paths. Expressions support
arithmetic, comparisons, `and`/`or`/`not`, `case … when`, `cast`, and a fixed
function set: `coalesce`, `nullif`, `lower`, `upper`, `trim`, `length`,
`substr`, `replace`, `abs`, `round`. Raw SQL never passes through — the
expression is parsed and re-emitted, so anything outside the grammar is
rejected at definition time.

```yaml
is_urgent: { kind: calc, expr: 'priority >= 3', type: boolean }
label: { kind: calc, expr: "coalesce(nickname, name, 'unknown')" }
```

`type` is the display type (defaults to `text`).

### `ai_classify` — an AI-assigned category

A model assigns each row one label from a fixed set, based on one input field:

```yaml
sentiment:
  kind: ai_classify
  input: body
  prompt: How does the customer feel in this message?
  labels: [happy, neutral, frustrated]
```

Each **distinct input value** is labeled once and the result is materialized
into a bookkeeping table the view joins against — the model is never re-run at
read time, and two rows with the same input always get the same label.

### `ai_transform` — AI-written text

A model derives a free-form value from one or more input fields (input order is
part of the identity — reordering inputs is a new definition):

```yaml
summary:
  kind: ai_transform
  inputs: [title, body]
  prompt: Summarize this ticket in one sentence.
```

Results are cached per row, keyed on the current input values — see
[staleness](#refreshing-ai-values--staleness) below.

### `aggregate` — a total across links

Fold many linked rows into one value per base row, through a junction table:

```yaml
tag_count: { kind: aggregate, via: ticket_tags.tag, fn: count }
total_paid: { kind: aggregate, via: invoice_payments.payment, fn: sum, column: amount }
```

`via` is `<junctionTable>.<remoteRelation>`; `fn` is one of `count`, `sum`,
`avg`, `min`, `max`, `concat`; `column` names the remote column to aggregate
(required for every `fn` except `count`).

## Building one in the GUI

Open the **Tables** tab. The explorer's third column is **Computed Tables**;
its header carries a **+ New** button that opens the builder (`#/computed/new`).

1. **Name it** — lowercase letters, numbers, and underscores.
2. **Pick the base table** ("Built from"). Fields can come from the base and
   anything linked to it — the pickers list every reachable column, including
   dotted paths through linked tables and aggregate targets through junctions.
3. **Add fields.** Each row is a name plus a kind — _Copy a field_,
   _Calculation_, _AI category_, _AI text_, or _Total across links_ — with the
   inputs that kind needs.
4. **Preview.** A dry run compiles the definition against your live schema and
   shows up to 20 sample rows. Nothing is created or saved by a preview. Each
   field is stamped ✓ (compiled) or ✕ (the failing field), and the compiled
   SELECT is available under the collapsed **Definition (SQL)** block.
5. **Create.** Enabled once the current definition has previewed successfully
   (any edit re-requires a preview). Creating registers the view, persists the
   definition to the workspace config, and lands you on the view's rows.

Editing an existing view (**Edit definition →** in a computed card's detail
panel, or `#/computed/<name>`) is the same form plus two more actions:
**Refresh values** (runs the AI fill now, streaming per-field progress) and
**Remove**.

The explorer also shows the projection itself: a dashed connector from the base
table to the computed view, and the view's detail panel lists the base under
_Upstream · sources_.

## Refreshing AI values + staleness

AI fields are **materialized, never computed at read time**. A background fill
runs when a definition with AI fields is created or changed; you can also run
it on demand (**Refresh values** in the builder, or **Refresh** in the Tables
explorer's detail panel).

Staleness is handled by construction: an AI value is cached against the exact
input values it was derived from. When a source row changes, its cached value
no longer matches, so the field reads **blank for that row until the next
refresh** — you may see a gap, but never a stale value. Unchanged rows keep
their cached values (no re-billing for what's already known), and a changed
prompt, label set, input list, or model invalidates exactly that field's cache.

## Read-only rows

A computed table's rows are derived, not authored. The GUI marks the view with
a **Computed** badge on its rows page and record pages, shows where the values
come from, and offers no editing affordances (no field editor, no markdown
editing, no per-row delete). The server enforces the same rule: any direct
write to a computed table is refused with a message pointing you at the source
tables or the definition. To change what a computed table shows, change the
records it is built from — or edit its definition.

The source tables are protected in the other direction too: deleting or
renaming a table is refused while a computed table reads from it, naming the
definitions that depend on it.

## Deleting + undo

Removing a computed view drops the view and its definition (and its AI-value
cache). Nothing about the source tables changes. The operation is recorded in
version history and is **revertible** — undo re-creates the view from the
captured definition. A computed table that other computed tables are built on
cannot be deleted until they are deleted or repointed.

A refresh, by contrast, only fills in AI-derived cells; it appears in history
as an informational entry with nothing to revert.

## HTTP API

The GUI drives computed tables through `lattice gui`'s local server. On a team
cloud, mutating verbs (and preview/refresh, which belong to the owner-side
builder) are owner-only — a scoped member gets a 403.

| Method | Endpoint                             | What it does                                                            |
| ------ | ------------------------------------ | ----------------------------------------------------------------------- |
| GET    | `/api/computed-tables`               | List definitions with per-field fill/error state                        |
| GET    | `/api/computed-tables/:name`         | One definition plus its compiled SELECT (`{ def, sql }`)                |
| GET    | `/api/computed-tables/fields?base=`  | Field-picker candidates for a base: columns, dotted paths, aggregates   |
| POST   | `/api/computed-tables/preview`       | Dry-run a definition (`{ def, limit? }`) — no DDL, nothing persisted    |
| POST   | `/api/computed-tables`               | Create (`{ name, def }`) — registers the view + persists the definition |
| PUT    | `/api/computed-tables/:name`         | Update the definition (`{ def }`); dependents recompile in order        |
| DELETE | `/api/computed-tables/:name`         | Delete the view + definition (refused while dependents exist)           |
| POST   | `/api/computed-tables/:name/refresh` | Run the AI fill now; streams per-field progress as NDJSON               |

The preview response is `{ columns, rows, sql, fieldTypes, pendingAi }` —
`pendingAi` maps each AI field to how many items a fill pass would enqueue.
The refresh stream emits one JSON object per line:
`{ phase: 'field', field, message }` when a field starts,
`{ phase: 'field-done', field, filled, pending, error? }` when it finishes,
and a final `{ done: true }` (or `{ phase: 'error', message }`).

Definition shape errors, unknown bases/columns, and dependency refusals come
back as `400 { error }` with the compiler's message verbatim — the same text
the builder shows in its error strip.
