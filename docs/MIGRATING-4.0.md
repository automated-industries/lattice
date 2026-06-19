# Migrating to 4.0

**Most upgrades need no action — the GUI silently migrates an existing 3.0+ config
and its data forward on open.** This guide documents what each upgrade does, plus
the manual SQL for library/non-GUI consumers who want explicit control.

## Auto-upgrade on open (the common case)

When the GUI opens a workspace, it silently brings a 3.0+ config + database to the
4.0 shape, preserving comments and data:

- **`ref:` config shorthand** → rewritten in place to an explicit `relations:` block
  (and the parser accepts `ref:` regardless, so a config opens whether or not the
  rewrite has run yet).
- **`deleted_at = ''`** → normalized to `NULL` across every table that has the
  column (so a live row never reads as deleted).
- **`files.path`-only rows** → backfilled into the reference model
  (`ref_kind='local_ref'`, `ref_uri=path`) so their bytes stay resolvable. The
  legacy `path` / `kind` columns are left in place (dropping them is optional).
- **Cloud (Postgres) member group** → the per-cloud group + its grants self-heal,
  and the cloud's own members (from its invite registry) are re-granted the new
  group on the owner's next open.

Each on-open migration is **idempotent** and gated once-per-database, so reopening
is cheap and a database created by 4.0 is untouched. Render manifests also
self-upgrade on the first render (an old v1 `manifest.json` is read for cleanup,
then rewritten in the v2 shape).

These on-disk rewrites let real-world configs migrate forward, so a **future major**
can cleanly drop the back-compat tolerance once configs have upgraded.

## Manual migration (library / non-GUI consumers)

If you use `latticesql` as a library WITHOUT the GUI open path, the on-open
migrations above don't run automatically — apply the equivalent SQL yourself (or
ship it in your consumer's migrations). The most data-safety-critical is
normalizing `deleted_at = ''` BEFORE upgrading; the rest can be done when
convenient. Each is detailed below.

---

## 4.0.0 — Soft-delete predicate simplified to `deleted_at IS NULL`

> **GUI users: no action needed.** The GUI normalizes `deleted_at = '' → NULL` on
> open (once per database, before anything reads the data), so a live row never
> reads as deleted. The rest of this section is for **library / non-GUI consumers**,
> who should run the normalization themselves.

### Library consumers — normalize BEFORE upgrading

> If you open the database WITHOUT the GUI (the library `init()` path), upgrading
> first will HIDE any live row whose `deleted_at` is the empty string (`''`) until
> you normalize it — and during that window a natural-key upsert against a hidden
> row can **INSERT A DUPLICATE**. Normalize every `deleted_at` table to `NULL`,
> verify zero empty-string rows, _then_ upgrade. The numbered steps below are in
> mandatory order; do not reverse them.

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

## 4.0.0 — `ref:` field shorthand deprecated (auto-upgraded, not removed)

> **No action needed.** 4.0 still parses the per-field `ref:` shorthand (it derives
> the same `belongsTo` it always did — relation name = the field name with a trailing
> `_id` stripped), so an existing config opens unchanged. When the GUI opens the
> config it **silently rewrites** `ref:` to the explicit `relations:` block below,
> preserving comments — so configs migrate forward and a **future major** can drop
> the shorthand cleanly.

The explicit `relations:` form is the going-forward shape (and lets you name the
relation yourself instead of relying on the `_id`-stripping rule). The GUI writes it
for any link you create; the auto-upgrade rewrites legacy `ref:` into it on open.

**Before (3.x shorthand — still accepted, auto-rewritten on open):**

```yaml
db: ./app.db
entities:
  ticket:
    fields:
      id: { type: uuid, primaryKey: true }
      title: { type: text, required: true }
      assignee_id: { type: uuid, ref: user } # belongsTo derived automatically, relation named "assignee"
    outputFile: tickets.md
```

**After (4.0):**

```yaml
db: ./app.db
entities:
  ticket:
    fields:
      id: { type: uuid, primaryKey: true }
      title: { type: text, required: true }
      assignee_id: { type: uuid } # plain FK column
    relations:
      assignee: # relation name you choose
        type: belongsTo
        table: user
        foreignKey: assignee_id
        # references: id   # optional; defaults to the target's primary key
    outputFile: tickets.md
```

A malformed _explicit_ `relations:` entry (not an object, missing
`type`/`table`/`foreignKey`, a non-`belongsTo` `type`, or an empty `references`)
still fails loudly rather than silently producing no relation — only the legacy
`ref:` shorthand is tolerated, not a broken `relations:` block.

**Library / non-GUI consumers:** a `ref:` config parses fine, but the on-disk
rewrite only happens through the GUI open path. If you never open the config in the
GUI and want to retire `ref:` before a future major drops it, rewrite it to the
`relations:` form above yourself (the conversion is exactly the `_id`-stripping rule
shown).

---

## 4.0.0 — `files.path` and `files.kind` no longer native columns

> **GUI users: no action needed.** On open the GUI backfills any legacy
> `path`-only file row into the reference model (`ref_kind='local_ref'`,
> `ref_uri=path`) so its bytes stay resolvable. The legacy `path` / `kind` columns
> are left in place (dropping them is optional + destructive, so it is never
> automatic — see the manual step below). Library / non-GUI consumers should run the
> backfill themselves.

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

---

## 4.0.0 — Cloud member group is now per-cloud (BREAKING, cloud + members only)

**Applies only to a Postgres cloud that has provisioned members.** Single-user /
SQLite deployments, and clouds with no members, need no action.

### What changed

Postgres roles and role membership are **cluster-global** — shared by every
database and schema on a Postgres cluster. Prior versions put every cloud's members
in one hard-coded group role, `lattice_members`. Two unrelated Lattice clouds that
happened to share a Postgres cluster therefore shared one members group, and
concurrent member provisioning across them contended on that single role's catalog.

In 4.0 the group name is **derived from the cloud's own `(database, schema)`
namespace**:

```
lattice_m_<first 20 hex of md5(current_database() || ':' || current_schema())>
```

Each cloud gets its own group — genuine cross-cloud isolation, and no shared-catalog
contention. The name is deterministic and stable: the same cloud always resolves the
same group, so install / provision / reconcile all agree. The library exposes
`memberGroupFor(db)` (the resolver) and `LEGACY_MEMBER_GROUP` (the old `'lattice_members'`
constant, kept only to recognize a pre-4.0 cloud). The previously exported
`MEMBER_GROUP` constant is **removed**.

### Breaking behavior

A cloud provisioned before 4.0 has its members in `lattice_members`, and its table /
view / bookkeeping privileges granted to `lattice_members`. After upgrading, the
owner connection installs and reconciles against the **new per-cloud group** — so:

- The new per-cloud group and all of its table / view / bookkeeping / EXECUTE grants
  are recreated automatically on the owner's next open (install + reconcile are
  idempotent and run on every owner open).
- The cloud's **own members are automatically re-added** to the new group on that
  same owner open — `reconcileCloudMemberAccess` re-grants the per-cloud group to
  every role in the cloud's invite registry (`__lattice_member_invites`). It is
  deliberately scoped to the cloud's OWN members, never the cluster-global legacy
  group, so members are never cross-pollinated between unrelated clouds on one
  cluster.

So a cloud whose members were provisioned through Lattice fully self-heals on the
owner's next open — **no action needed.**

### Migration (manual fallback — only if a member isn't in the invite registry)

A member role created out-of-band (e.g. by a DBA, never recorded in
`__lattice_member_invites`) won't be picked up by the automatic re-grant. Add it
explicitly. Open the cloud once as the owner so the per-cloud group + grants exist,
then, connected to the cloud, scope the grant to the cloud's OWN members — NOT the
cluster-global `lattice_members` (which would pull in other clouds' members):

```sql
-- Re-grant the per-cloud group to THIS cloud's own members (its invite registry).
SELECT format(
  'GRANT %I TO %I',
  'lattice_m_' || substr(md5(current_database() || ':' || current_schema()), 1, 20),
  i."role"
)
FROM "__lattice_member_invites" i
JOIN pg_roles r ON r.rolname = i."role"
\gexec
```

Equivalently, re-running your provisioning flow for each member (which issues
`GRANT <per-cloud group> TO <member>`) achieves the same result.

**Step 3 — (optional) retire the legacy group.** Once every cloud on the cluster
has migrated its members and `lattice_members` has no members left, you may drop it:

```sql
DROP OWNED BY lattice_members;  -- removes any stale grants it still holds
DROP ROLE IF EXISTS lattice_members;
```

Leave it in place if any un-migrated cloud on the same cluster still relies on it.
