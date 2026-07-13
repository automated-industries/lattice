# Desktop app crashes with a JS-heap OOM during bulk document ingest

- **Date:** 2026-07-13
- **Area:** Ingest — desktop runtime memory ceiling + extraction concurrency
- **Severity:** Critical (the whole desktop app process aborts mid-batch; repeated, reproducible)

## Symptom

Ingesting a folder of large Office documents (~60 files, a few hundred MB total, individual
spreadsheets/decks up to ~35 MB) crashes the desktop app partway through the batch. The
macOS crash report shows `EXC_BREAKPOINT (SIGTRAP)` on the embedded runtime thread. Time to
crash varies wildly with what is being ingested — from ~70 seconds after launch to many
hours — and the same folder ingests fine through the CLI-launched GUI on the same machine.

Symbolicating the crash frames against the runtime binary identifies the abort precisely:
V8 `FatalProcessOutOfMemory` with the reason string **"Ineffective mark-compacts near heap
limit"** — the JS old-space heap hit its configured maximum and consecutive full GCs could
not reclaim anything. Notably, resident memory at death was only ~270 MB, which had
previously been read as evidence this was _not_ an OOM; it is — the heap limit itself was
tiny.

## Root cause

Two independent causes compound:

1. **The compiled desktop runtime ships a conservative default V8 heap limit.** Nothing in
   the desktop build passed `--v8-flags`, and the packaged runtime's default old-space
   ceiling is a few hundred MB — vs ~4 GB for the CLI (`deno run`) default on the same
   machine. This is why the crash class is desktop-only and why every prior "bulk-ingest
   crash" investigation on the desktop kept finding memory-shaped failures. There is no
   runtime escape hatch in the packaged app (no env-var flag pass-through), so the limit
   must be baked in at build time.

2. **Extraction transients are input-side, large, and were multiplied by concurrency.** The
   folder-ingest pool runs 4 files at once and the browser upload path allows 3 more, and
   each in-flight file can materialize:
   - a full archive inflation of an Office/OpenDocument/EPUB file into memory
     (`unzipSync` map, up to the 256 MB aggregate cap) plus full JS-string decodes of the
     large XML parts;
   - a pdf.js parse graph bounded only by a wall-clock timeout, not by memory;
   - for scanned PDFs, a base64 copy of the whole file (~1.37×) inside the model request
     body, which the SDK re-serializes and retains across 429/5xx retries — this leg had no
     lock at all (only native image normalization was serialized);
   - for browser uploads, the full request buffer (≤50 MB) retained by the handler for the
     rest of its lifetime, alongside all of the above.

   The 200 KB cap on _extracted text_ never bounded any of these input-side intermediates.
   Count-based concurrency limits (4 + 3) cannot bound the heap when a single file's
   transients run to hundreds of MB: concurrency × peak-transient is the number that has to
   fit the heap, and it didn't.

## Fix

- **Bake a real heap ceiling into every desktop build.** All four `deno desktop` build
  scripts now pass `--v8-flags=--max-old-space-size=4096` (matching the CLI default on a
  16 GB machine and the ceiling CI already builds with). It is a ceiling, not a
  reservation — the process still only commits what it allocates.
- **Serialize heavy extraction.** New `src/gui/ai/extract-gate.ts`: files ≥ 8 MB on disk
  acquire a process-wide single-slot lane around the whole extraction (`extractSource`),
  covering archive inflation, PDF parsing, and the scanned-PDF vision call for every ingest
  door (folder pool, browser upload, local-path ingest, chat attachments). Smaller files —
  the long tail — keep the pool's full concurrency. Lock order with the existing native
  image lock is strictly lane → native, so the two cannot deadlock; the lane releases in
  `finally`, so a throwing extraction never poisons it.
- **Release the upload buffer before extraction.** The browser-upload handler now hashes
  and sizes the request bytes up front, keeps them only if an S3 push will need them, and
  drops the reference before extraction begins — a large upload's in-memory copy no longer
  coexists with the extraction transients.
- **Log the effective heap limit at startup** (`[desktop] … (V8 heap limit N MB)`), so a
  memory-starved build is visible at a glance instead of only as a mid-ingest crash.

## Lessons learned

- **Output caps don't bound input transients.** The extracted-text cap suggested extraction
  memory was bounded; the actual heap cost lives in the intermediates (inflation maps,
  parse graphs, base64 request bodies) that exist before any cap applies.
- **A compiled runtime's V8 defaults are not the CLI's defaults — assert them, don't assume
  them.** The startup heap-limit log and the build-script regression test exist so this
  divergence can never be invisible again.
- **Low resident memory does not rule out an OOM.** A process can die of heap exhaustion at
  ~270 MB RSS when the configured limit is small. Symbolicate the abort reason before
  classifying a crash.
- **Per-stage locks don't compose into a memory budget.** Serializing one native step
  (image normalization) still left every JS-heavy leg concurrent. The budget that matters
  is concurrency × peak-per-file-transient across the whole pipeline.

## Regression tests

- `tests/unit/extract-gate.test.ts` — heavy extractions serialize (`maxActive === 1`),
  small files stay concurrent and are never blocked behind the lane, and a rejected heavy
  extraction releases the lane for the next waiter.
- `tests/unit/desktop-heap-flags.test.ts` — every desktop build script carries
  `--v8-flags=--max-old-space-size=4096`; fails loudly if the flag is ever dropped.
- The upload-buffer release is a reference-lifetime change with no cheap deterministic
  test (observing collectability mid-handler requires GC instrumentation); it is covered by
  review and the end-to-end bulk-ingest verification.

## Follow-ups (noted, not in this fix)

- `autoImportStructured` (spreadsheet re-import on upload) runs outside the lane,
  post-extraction, upload-only — worth folding under the lane if it ever shows up in a
  heap profile.
- pdf.js parsing remains timeout-bounded rather than memory-bounded; the lane serializes
  big PDFs, which contains the risk, but a streaming/paged parse would bound it properly.
