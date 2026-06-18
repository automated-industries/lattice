# Data Consistency

How `latticesql` keeps the database, the rendered context tree, and offline edits
in agreement — the true model, the invariants the library guarantees (each backed
by a test), and the things it deliberately does **not** guarantee.

---

## The model

There are three places data can live, and exactly one relationship between each
pair:

1. **The database** — the single source of truth. One active substrate at a time:
   SQLite **xor** Postgres, never both. Every read and write goes here first.

2. **The rendered context tree** — a **forward-render mirror** of the database
   (`db → files`). It is derived, not authoritative: a render reads the DB and
   writes Markdown files plus a manifest (`.lattice/manifest.json`) that records,
   per file, the content hash and the source row's version. The tree **lags** the
   DB until a render settles; it is never read back as truth except through the
   explicit reverse-sync path below.

3. **Offline edits** — a **client-side queue** (not a live mirror of the DB). Edits
   made while disconnected are buffered and replayed, in order, when connectivity
   returns.

Everything below is about the three edges between these: DB ⇄ rendered tree, and
DB ⇄ offline queue.

---

## Guaranteed invariants (each test-backed)

### 1. Reverse-sync never silently overwrites a concurrent change

When an external edit to a rendered file is swept back into the database, the
engine first checks whether the underlying row changed since that file was
rendered — an optimistic-concurrency check against the row version captured in the
manifest at render time. If the row changed (a concurrent DB edit), the file edit
is **rejected and reported as a conflict**, never applied over the newer value.
The reject is surfaced to the editor so the change can be re-applied against the
current record.

*Why it matters:* a file edit and a concurrent database edit to the same record
can no longer race to a silent data loss — the database wins and the conflict is
made visible.

### 2. A render is manifest-atomic and fails loudly

The manifest is written **last**, as a single atomic file (temp + rename). It is
the commit point: a render either completes and commits a manifest describing a
fully-written tree, or it throws **before** committing — leaving the **prior**
manifest as the truthful record. Before writing anything, a render probes that its
target directories are writable (a disk-full or read-only mount throws *before* a
single live file is touched). A write failure mid-render is re-raised loudly, never
swallowed; the next render reconciles (unchanged files are skipped, and orphan
cleanup runs only against a committed manifest).

*Guarantee level:* **manifest-atomic + tree-eventually-consistent.** A render is
not a single atomic multi-file swap (a file tree cannot offer one without orphaning
user-edited and attached files the tree interleaves), but the manifest — the one
unit that must be atomic for correctness — is, and a failed render is self-healing
rather than silently divergent.

### 3. Render concurrency is single-owner per output directory

Within a process, the auto-render scheduler and a background render share one
in-flight guard, so they never overlap on the same output directory; a render
scheduled while one is in flight is deferred and coalesced. One-shot CLI renders
construct their own instance and do not auto-render, so they cannot interleave
either.

### 4. Migration reports what it leaves behind

Migrating a workspace into a fresh database asserts, per table, that the target row
count matches the source after copy (a mismatch aborts loudly, before the source is
archived). Files whose canonical bytes are owned-and-local — and therefore are not
carried by a row copy — are counted and reported, so the operator is told exactly
how many files reference bytes that were left behind rather than discovering dangling
references later.

### 5. Offline replay is idempotent and ordered

Queued edits carry a stable edit id and a client timestamp. Replay deduplicates by
edit id and applies in timestamp order, so a replay that is retried (or partially
re-sent) converges to the same state rather than double-applying.

---

## What is deliberately NOT guaranteed

- **Full render-tree atomicity.** See invariant 2 — the manifest is atomic; the
  surrounding file tree is eventually-consistent and self-healing, not
  all-or-nothing.

- **Multi-process renders to the same output directory.** Two processes rendering
  the same context directory at once (for example, a long-running server plus a
  separate one-shot render of the same directory) is **unsupported** — the manifest
  write is last-writer-wins across processes. Point each long-running renderer at
  its own output directory.

- **Cross-key encryption round-trips.** Encrypted columns round-trip through
  decrypt-on-read / encrypt-on-write; both sides of a migration must share the same
  encryption key, or encrypted values arrive unreadable.

---

## Where each invariant is enforced

| Invariant | Enforced in |
| --- | --- |
| 1 — reverse-sync conflict gate | `src/reverse-sync/engine.ts` (row-version check), manifest `rowVersion` |
| 2 — manifest-atomic render + writability probe | `src/render/engine.ts`, `src/render/writer.ts` |
| 3 — single-owner render concurrency | `src/render/auto-render.ts` (single-flight) |
| 4 — migration row-count + blob surfacing | `src/framework/cloud-migration.ts` |
| 5 — offline replay idempotency | the edit-id dedup + client-timestamp ordering on replay |
