# Structured-source import (v4.2)

latticesql 4.2 can turn a **structured file** — a JSON object or an Excel
`.xlsx` workbook — into a Lattice schema (entities, dimensions, junctions) and
materialize it into a workspace. Everything here is **additive and opt-in**:
absent a file drop, behavior is byte-identical to 4.1.

There are **three doors and one pipeline**. Dropping a file into the assistant
rail in `lattice gui` builds a proposal, which is applied over
`POST /api/import/apply`. `lattice import <file>` does the same apply from a
terminal — no browser, no server, no upload. And `applyImport` is exported from
`latticesql` for a job or a library caller (see [Library API](#library-api)).
All three run the same inference, the same match-to-existing, and the same
snapshot dating; none of them is a reduced version of another.

```sh
lattice import ./exports/2026-07.xlsx --dry-run   # what would this create?
lattice import ./exports/2026-07.xlsx
lattice import ./big-book.xlsx --sheet "Q3"
```

See the [CLI reference](cli.md#lattice-import) for every option.

## What it does

When you drop a recognized JSON / `.xlsx` source into the chat:

1. **Infer a schema.** `inferSchema` reads the source and proposes **entities**
   (record collections that become tables), **dimensions** (small repeated value
   sets that become a shared taxonomy / dictionary), and **junctions** (the
   many-to-many links between them). Field types are inferred per column
   (`inferFieldType`), and source keys are normalized to table/column names
   (`normalizeName`).
2. **Read Excel natively.** `excelToRecords` turns each sheet into records by
   detecting the header row and the data region. A per-slice tab that is just a
   filtered view of a master sheet is recognized as a **read-only view** (no
   duplicated rows) rather than a second table — see `dedupeAndDetectViews`.
3. **Detect an as-of date for point-in-time snapshots.** `detectAsOf*` looks at
   the file's contents, then its name, then an Excel preamble, then a Claude
   fallback — or a per-row date **column** (`detectAsOfColumns`, `parseCellDate`).
   When a date is found, every materialized row is stamped `as_of` and the row
   identity folds it in, so **re-importing a newer period APPENDS a dated
   snapshot beside the prior one** instead of overwriting it. Dimensions (the
   shared taxonomy) are not dated.
4. **Recognize a re-import.** `matchSchemaToExisting` fingerprints the inferred
   schema and matches it against the tables already in the workspace, so a
   re-upload lands as a **new snapshot of the existing tables**, not a duplicate
   set. `renameEntities` applies any entity → table-name overrides.
5. **Materialize.** `materializeImport` creates the tables (idempotently),
   inserts the rows + links, persists the schema to the workspace config, and
   builds the detected read-only views.

## Document tables are named from the document (5.2)

A `.docx` / `.pptx` with substantive embedded tables flows through the same
deterministic importer as a spreadsheet — and its tables are **named from the
document itself**, never numbered positionally. The first source that yields a
usable name wins:

1. the table's explicit Word **caption** (`w:tblCaption`);
2. the nearest **preceding heading** (a styled heading or a short title-shaped
   line, looked up only between this table and the previous one — an introductory
   sentence is never taken as a name);
3. the **slide title**, for PowerPoint;
4. the **document's file name**, when the document yields a single table.

Anything still un-nameable is **folded into one table named after the document**
(with the full column union), rather than dropped or numbered. A caption that is
itself a placeholder ("Table 1") is rejected and the ladder falls through. Two
adjacent tables with identical columns and the same name — a table split by a
page break — are merged back into one.

A shared name policy backs this everywhere tables are created: anonymous names
(`table_1`, `sheet3`, `untitled`, …) are filtered out by a pre-flight in
`materializeImport` (reported, never a partial write; names already registered in
the workspace are exempt), and the assistant's create-table calls reject them
outright with an instructive error.

## Import is automatic — there are no decisions to make

Dropping a file imports it. There is no confirmation card, no "what should I
bring in?" choice, and no follow-up question: every recognized case materializes
straight away, and what happened is reported in the activity feed (and is
undoable) rather than asked about up front.

- **Brand-new structured data.** Tables and rows are created directly, along with
  any detected computed views, shown as a compact live-progress card.
- **A recognized dataset.** The file matches tables already in the workspace and
  is imported as a snapshot. When a date is confidently detected it is used;
  otherwise the import is filed as a **new** snapshot rather than overwriting the
  previous one, so an undated re-import can never clobber earlier data.
- **A multi-sheet workbook.** Each sheet is imported as its own unit, so a
  workbook with many sheets lands sheet by sheet. If one sheet cannot be
  imported, the rest still are and the result says so ("imported N of M sheets")
  rather than failing the whole book.

Imports apply through `applyImport`. The browser reaches it over
`POST /api/import/apply`, which streams the materialization progress back as
NDJSON; `lattice import` calls it directly and prints the same lines to stderr.
After an import lands, the data-model planner runs over the new tables to apply
safe normalizations.

## File-size cap

A source file is capped at **100 MB**, and the cap is enforced **on both paths**:
the streaming upload rejects an oversized file, and the apply route re-`statSync`s
the retained bytes before reading them — so an oversized or swapped-on-disk
source (including one reached via a `local_ref` that never went through the
upload) cannot be streamed whole into memory.

## Library API

The whole apply is one call. `readImportSource` turns a file into records;
`applyImport` takes it from there — inference, match-to-existing, the per-sheet
split for an over-large workbook, snapshot dating, computed opt-ins, and the
report of low-confidence links it deliberately left unconnected:

```ts
import { readImportSource, applyImport } from 'latticesql';

const source = await readImportSource('./exports/2026-07.xlsx', '2026-07.xlsx');
const result = await applyImport(
  { db, configPath, latticeRoot, validTables, softDeletable, feed },
  source,
  { mode: 'both' },
  (event) => console.error(event.message), // progress, as it happens
);
// result: { mode, asOf, asOfColumn, tablesCreated, rowsByTable, links, views }
```

A refusal arrives as an `Error` carrying a `code` — read it with
`ingestErrorCode(e)` — rather than a status: `not_found` when the bytes are not
there, `too_large` past the cap, `invalid_request` for an unreadable source or a
plan over the safe table limit.

The individual stages are exported too, and run GUI-independently:

```ts
import {
  inferSchema,
  inferFieldType,
  normalizeName,
  sourceRecords,
  excelToRecords,
  dedupeAndDetectViews,
  detectAsOf,
  detectAsOfCandidates,
  detectAsOfColumns,
  parseCellDate,
  matchSchemaToExisting,
  renameEntities,
  materializeImport,
} from 'latticesql';

// JSON object → proposed schema
const plan = inferSchema(data); // { entities, dimensions, junctions, skipped }

// Detect the as-of date and any per-row date column
const asOf = detectAsOf(fileName); // ISO YYYY-MM-DD | null
const asOfColumns = detectAsOfColumns(data, plan);

// Detect read-only views (per-slice tabs that mirror a master)
const { views } = dedupeAndDetectViews(data, plan);

// Materialize into a workspace
const result = await materializeImport({ db, configPath }, data, plan, views, {
  mode: 'both',
  asOf,
  asOfColumn: null,
});
// result: { mode, asOf, asOfColumn, tablesCreated, rowsByTable, links, views }
```

`materializeImport` takes a `mode` of `'schema'` (table structures + dimension
values + views), `'contents'` (entity rows + links into existing tables), or
`'both'` (the default). When `asOf` (a file-level ISO date) or `asOfColumn` (a
per-row date column) is set, rows are stamped and the row identity folds the date
in, so the same model imported at a new date is a distinct snapshot rather than an
overwrite. `onProgress` streams the per-phase pipeline steps for a live view.

See [CHANGELOG.md](../CHANGELOG.md) for the full 4.2 list and
[assistant.md](assistant.md) for the chat-drop experience.
