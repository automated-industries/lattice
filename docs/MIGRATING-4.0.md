# Migrating to 4.0

This guide covers the breaking changes in the 4.0 release and the migration each
one requires.

---

## 4.0.0 — Soft-delete predicate simplified to `deleted_at IS NULL` (BREAKING)

### STOP — RUN THE NORMALIZATION MIGRATION BEFORE YOU `npm install latticesql@4.0`

> **Upgrading first will HIDE any live row whose `deleted_at` is the empty string
> (`''`)** until you normalize it — and during that window a natural-key upsert
> against a hidden row can **INSERT A DUPLICATE**. Normalize every `deleted_at`
> table to `NULL`, verify zero empty-string rows, *then* upgrade. The numbered
> steps below are in mandatory order; do not reverse them.

### What changed

Prior versions treated a row as "live" when `deleted_at` was **either** `NULL`
**or** the empty string `''`. That empty-string branch was a back-compat shim for
legacy / pre-soft-delete data — current code has only ever written a timestamp
(on delete) or `NULL` (on insert/restore), never `''`.

In 4.0 the live predicate is the single, consistent form used everywhere:

```sql
WHERE deleted_at IS NULL
```

The legacy `OR deleted_at = ''` branch is removed from the **last three** read
paths that still carried it: the natural-key lookup family, the seed resolver,
and full-text search (both indexed and LIKE). Everything else — the main `query`
read path, `getActive` / `countActive`, the report builder, the GUI count, and
the entire `{ col: 'deleted_at', op: 'isNull' }` structured-filter family —
already used bare `deleted_at IS NULL`, so for them nothing changes. This release
simply makes the codebase consistent.

### Breaking behavior

After upgrading, **a LIVE row whose `deleted_at` holds the empty string `''`
reads as DELETED.** It disappears from:

- natural-key lookups (`getByNaturalKey`, `upsertByNaturalKey`,
  `enrichByNaturalKey`, `softDeleteMissing`),
- the seed link/resolve path,
- full-text search (both the indexed path and the LIKE path).

Only legacy or externally / manually inserted rows can hold `''`; a database that
has only ever used this library to soft-delete has none, and the migration below
is a harmless no-op for it. Run it anyway — a single missed `''` row vanishes
silently.

### Required migration (run FIRST, then upgrade)

**Step 1 — Normalize EVERY `deleted_at` table. Do not copy a fixed list —
introspect.**

The normalization must cover every table that has a `deleted_at` column: the
framework-native tables **and** every user-defined entity table (the GUI's
`CREATE TABLE` always adds `deleted_at`). The printed names further down are
illustrative only; **the authoritative list is whatever the introspection query
returns**.

Enumerate them with schema introspection — this is the primary, authoritative
step:

- **SQLite:**

  ```sql
  SELECT m.name
  FROM sqlite_master m
  JOIN pragma_table_info(m.name) c
  WHERE m.type = 'table' AND c.name = 'deleted_at';
  ```

- **Postgres:**

  ```sql
  SELECT table_name
  FROM information_schema.columns
  WHERE table_schema = 'public' AND column_name = 'deleted_at';
  ```

Then, for each table name the query returned:

```sql
UPDATE "<table>" SET deleted_at = NULL WHERE deleted_at = '';
```

On Postgres you can generate and run all of the `UPDATE`s in one pass with
`psql`'s `\gexec`:

```sql
SELECT format('UPDATE %I SET deleted_at = NULL WHERE deleted_at = '''';', table_name)
FROM information_schema.columns
WHERE table_schema = 'public' AND column_name = 'deleted_at'
\gexec
```

> **Illustrative only — do not treat this as the list.** The framework-native
> `deleted_at` tables are `secrets`, `files`, `notes`, `chat_threads`, and
> `chat_messages`. Your real list is whatever the introspection above returns: it
> includes these **plus** every user-defined entity table your app or the GUI
> created. Application-defined tables are **not** framework-native — they exist
> only if your app declared them — so you MUST rely on the introspection result,
> never a hardcoded list.

**Step 2 — Verify zero empty-string rows on every table (HARD GATE — do not
proceed until all return 0):**

```sql
SELECT COUNT(*) FROM "<table>" WHERE deleted_at = '';
```

Run this on **every** table the Step 1 introspection returned. Every count must
be `0`. Do not move on to Step 3 while any table still reports a non-zero count.

**Step 3 — Only now upgrade:**

```bash
npm install latticesql@4.0
```

### If you already upgraded before normalizing

The rows are not lost — only hidden by the predicate. Run the Step 1
normalization immediately and they reappear. Then audit for duplicate rows
created by any natural-key upsert that ran during the hidden window: for each
affected table, group by the natural key and look for more than one live row per
key. Duplicates created in that window are **not** auto-reconciled — you must
merge or remove them by hand.

---

## 4.0.0 — `ref:` field shorthand removed (BREAKING)

The per-field `ref:` shorthand for declaring a `belongsTo` relationship has been
removed in 4.0. Declare the foreign key as a plain field and add an explicit
`relations:` block on the entity. A config that still uses `ref:` now fails to
parse with a clear error naming the offending `entity.field` — there is no silent
fallback.

The relation name is no longer derived for you (previously the field name had its
trailing `_id` stripped) — you name it explicitly in `relations:`.

**Before (3.x — removed):**

```yaml
db: ./app.db
entities:
  ticket:
    fields:
      id:          { type: uuid, primaryKey: true }
      title:       { type: text, required: true }
      assignee_id: { type: uuid, ref: user }   # belongsTo derived automatically, relation named "assignee"
    outputFile: tickets.md
```

**After (4.0):**

```yaml
db: ./app.db
entities:
  ticket:
    fields:
      id:          { type: uuid, primaryKey: true }
      title:       { type: text, required: true }
      assignee_id: { type: uuid }              # plain FK column
    relations:
      assignee:                                # relation name you choose
        type: belongsTo
        table: user
        foreignKey: assignee_id
        # references: id   # optional; defaults to the target's primary key
    outputFile: tickets.md
```

**Error on a leftover `ref:`** — parsing the "Before" config in 4.0 now throws an
error of this form (the exact `entity.field` and suggested relation name are
filled in for the offending field):

```
Lattice: `ref:` on "ticket.assignee_id" was removed in 4.0. Declare the foreign
key as a plain field and add an explicit `relations:` entry on entity "ticket"
instead — e.g. relations: { assignee: { type: belongsTo, table: <target>,
foreignKey: assignee_id } }. See MIGRATING-4.0.md.
```

A malformed `relations:` entry (not an object, missing `type`/`table`/`foreignKey`,
a non-`belongsTo` `type`, or an empty `references`) also fails loudly rather than
silently producing no relation.

The GUI's "Add link" and junction-creation flows already write the explicit
`relations:` shape, so workspaces created or edited through the GUI need no manual
change. Existing on-disk `lattice.config.yml` files authored with `ref:` will fail
to open after upgrade until migrated to the shape above — this is intentional
(fail loud, no auto-migration).

---

## 4.0.0 — `files.path` and `files.kind` columns removed (BREAKING)

### What changed

The native `files` entity no longer declares the legacy `path` and `kind`
columns. File resolution now flows entirely through the content-addressed and
reference columns that have shipped alongside them since 2.0:

- **`sha256` / `blob_path`** — for files whose bytes Lattice owns (a
  content-addressed copy under `<lattice-root>/data/blobs/`).
- **`ref_kind` / `ref_uri` / `ref_provider`** — the reference model, for files
  that live elsewhere. `ref_kind` is the single discriminator:
  - `'blob'` — an owned local copy (bytes under `data/blobs/`, resolved via
    `blob_path`).
  - `'local_ref'` — a file referenced **in place** on this machine; `ref_uri` is
    its absolute OS path, served straight from disk (no copy made).
  - `'cloud_ref'` — a file that lives remotely (an `s3://bucket/key` object or an
    external URL in `ref_uri`).

What `path` and `kind` used to carry now maps to the reference model: an ingested
local file is recorded as a `local_ref` whose `ref_uri` is the absolute path
(previously stored in `path`), and an owned copy is identified by `sha256` /
`blob_path` rather than a free-form `kind`.

### Breaking behavior

- Reads and writes against `files.path` or `files.kind` no longer resolve to a
  declared native column. Any consumer code that read `row.path` / `row.kind` on
  a native `files` row must read `ref_uri` (for a `local_ref`) or `blob_path` (for
  an owned blob) instead.
- For an existing row that only ever populated the legacy `path` column, file
  resolution now falls back to the reference columns: a row with no `ref_kind`
  and no `blob_path` resolves as unavailable rather than reading `path`. Backfill
  such rows into the reference model before upgrading (see below).

### Migration

If your physical `files` table still carries the legacy columns, drop them:

```sql
ALTER TABLE files DROP COLUMN path;
ALTER TABLE files DROP COLUMN kind;
```

> **`DROP COLUMN` support:** SQLite added `ALTER TABLE … DROP COLUMN` in
> **3.35.0** (March 2021) — make sure your SQLite build is at least that version.
> PostgreSQL has supported it for far longer, so no version concern there.

Before dropping `path`, backfill any rows that relied on it into the reference
model so their bytes stay resolvable — a row whose only on-disk pointer was
`path` should become a `local_ref`:

```sql
UPDATE files
   SET ref_kind     = 'local_ref',
       ref_uri      = path,
       ref_provider = 'fs'
 WHERE path IS NOT NULL
   AND ref_kind IS NULL
   AND blob_path IS NULL;
```

(Adjust for rows whose `path` already pointed inside `data/blobs/` — those are
owned blobs and should instead set `ref_kind = 'blob'`, `blob_path = path`.) After
the backfill verifies clean, run the `DROP COLUMN` statements above.

## Render manifest is v2-only

The render manifest (`.lattice/manifest.json`) is now written exclusively in the
hashed v2 shape — each entity's files entry is a `{ filename: { hash, ... } }`
map (content hashes power change detection for the file → DB write-back), never
the older bare `["FILE.md", ...]` filename array.

**No action is required.** An old v1 `manifest.json` still on disk is handled
gracefully: its filenames are read for cleanup (so orphaned files are still
detected), and because a v1 entry carries no content hashes there is no baseline
to compare against, so write-back simply skips those entries — exactly as before.
The first render after upgrading rewrites the manifest in the v2 shape, upgrading
it automatically.

If you would rather force a clean v2 render immediately, delete the manifest and
re-render — it will be regenerated from scratch:

```sh
rm .lattice/manifest.json
```
