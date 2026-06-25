# Chat message not connected to its attached files

**Date:** 2026-06-25
**Area:** GUI assistant composer (`src/gui/app/modules/create-database-wizard.ts`, `onboarding.ts`) + chat route (`src/gui/chat-routes.ts`)

## Symptom

A user attached three screenshots to a chat message ("analyze these screenshots")
and the assistant replied that it did **not see any attached files** — even though
the files were referenced in its context. The attachment and the message were
disconnected: the assistant had no signal that those specific files belonged to
this request.

## Root cause

The composer Send fired two independent, unordered actions:

1. `sendStaged()` → `uploadFiles()` — a fire-and-forget ingest of the staged files.
2. `sendChat(text)` — POST `/api/chat` with the message only.

So the chat turn was sent **before** the files finished ingesting, and it carried
**no reference** to them. Nothing told the assistant "these just-attached files are
what the request is about." The earlier instinct — "send the images to the model as
vision" — was the wrong fix: it only helps images, breaks on multiple/complex file
types, and treats the symptom (analysis) rather than the cause (the message is not
linked to the files the user added).

## Fix

Make the one composer Send a connected, ordered workflow that works for **any** file
type and count, reusing the assistant's existing file-interaction tools:

1. **Add the files first.** `uploadFiles()` now returns a promise resolving with
   `[{id, name}]` for each ingested file. `submitComposer` awaits the ingest before
   sending the chat (`opts.silent` suppresses the single-file open-the-record jump
   when a message accompanies the upload).
2. **Reference them in the turn.** `sendChat(text, attachedFiles)` includes the
   ingested ids in the `/api/chat` body.
3. **Connect server-side.** `buildAttachedFilesNote(db, attachedFiles)` grounds each
   id against the **visible** files table (a stale/invented id is dropped, never
   referenced) and prefixes a note — "the user just attached these files … read them
   with your file tools and use them to do what the user asks" — to the model's turn
   only. The persisted user message is unchanged; the dispatch/tools still see the
   real message (so `ingest_url` is unaffected).

The assistant then uses its existing tools (`get_row_context`, the `files` table,
each file's extracted text/description) to act on exactly the attached files.

## Lessons learned

- A "send X to the model" reflex narrows a general problem to one data type. The
  generic, scalable fix connected the message to the files via ids and let the
  existing per-file capabilities do the rest.
- Fire-and-forget + a dependent action is an ordering bug. Await the prerequisite
  (ingest) before the dependent step (the chat turn) when one needs the other.
- Ground model-facing references against the visible DB so the assistant never
  receives an id it can't actually see.

## Regression tests

- `tests/unit/chat-attached-files.test.ts` — `buildAttachedFilesNote`: empty when
  nothing is attached; names a single file (singular phrasing) with its id; names
  multiple files (plural phrasing, the reported multi-screenshot case); drops
  stale/invisible ids instead of inventing a reference.
