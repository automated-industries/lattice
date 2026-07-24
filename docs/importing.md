# Structured-source import (v4.2)

latticesql 4.2 can turn a **structured file** — a JSON object or an Excel
`.xlsx` workbook — into a Lattice schema (entities, dimensions, junctions) and
materialize it into a workspace. Everything here is **additive and opt-in**:
absent a file drop, behavior is byte-identical to 4.1.

The feature is reachable **only by dropping a file into the assistant rail** in
`lattice gui`. There is no CLI verb and no separate endpoint to call by hand —
the upload pipeline builds a proposal, and a confirmed proposal is applied via
`POST /api/import/apply`. The same inference and materialization functions are
also exported from `latticesql` for library use (see [Library API](#library-api)).

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

## Silent import vs. the inline confirm card

The chat drop chooses a path automatically. **Most drops import silently** — a
confirm card only appears for the one genuinely ambiguous case:

- **Brand-new structured data → silent import.** Tables and rows are created
  directly (plus any detected computed views), shown as a compact live-progress
  card with no confirm gate. Uncertain, low-confidence choices still interrupt:
  a **marginal link** the importer isn't sure about becomes a question in the
  assistant panel ("connect these?"), rather than being guessed at.
- **Recognized dataset + a confident date → silent import.** The file matches
  tables already in the workspace and a date was confidently detected, so it is
  imported straight away as a dated snapshot and reported in the activity feed.
- **Recognized dataset but no / ambiguous date → confirm card.** Importing
  undated would overwrite the prior snapshot — a genuinely low-confidence choice
  — so an **inline confirm card** proposes the date (and any per-row date column)
  before anything is written.

Silent and confirmed imports both apply via `POST /api/import/apply`, which
streams the materialization progress back as NDJSON. After an import lands, the
data-model planner runs over the new tables to apply safe normalizations and
surface further suggestions.

## File-size cap

A source file is capped at **50 MB**, and the cap is enforced **on both paths**:
the streaming upload rejects an oversized file, and the apply route re-`statSync`s
the retained bytes before reading them — so an oversized or swapped-on-disk
source (including one reached via a `local_ref` that never went through the
upload) cannot be streamed whole into memory.

## Library API

The inference + materialization functions are exported from `latticesql` and run
GUI-independently:

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
