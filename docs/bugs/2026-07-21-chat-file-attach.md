# Chat file attach drops the file, invents a message, and shows no progress

**Date:** 2026-07-21
**Area:** GUI / assistant composer (file attach)
**Severity:** High — attachments silently vanish; the user is asked to re-upload a file they already uploaded.

## Symptoms

1. A file is attached and a message typed, but the message is sent **without the file**.
2. The user is asked to upload a file **after** they already uploaded it.
3. A files-only send (attach a file, no text) posts an invented **"Take a look at this
   file."** message the user never wrote.
4. No visual indication that a single attached file is uploading / ingesting.

## Root cause

The composer's submit (`submitComposer`, create-database-wizard.ts):

```
var batch = stagedFiles.slice();
clearStaging();                        // ← tray cleared BEFORE ingest
uploadFiles(batch, { silent: true }).then(
  function (refs) { sendChat(t, refs); },
  function () { sendChat(t); },         // ← ingest FAILED → send text WITHOUT the files
);
```

- The staging tray was cleared up front, so the moment ingest was in flight the files
  were already gone from the UI — and on ingest **failure** the turn was sent with the
  typed text alone (`sendChat(t)`), losing the attachment with **no error surfaced**. A
  files-only send whose ingest failed no-oped in `sendChat` (nothing to say) — with the
  file already discarded — which reads as "I attached a file and nothing happened / it
  asked me to upload it again."
- There was **no in-flight indicator** for a single-file ingest (only multi-file drops
  got a batch progress bar), so the user couldn't tell it was working.
- A files-only send fabricated **"Take a look at this file."** (`sendChat`, and a server
  fallback in `chat-routes.ts`) as the visible + persisted user message.

## Fix

- **Never drop an attachment silently.** `submitComposer` no longer clears the tray up
  front. It locks Send and shows the tray as "Adding…" while the batch ingests; only on
  success does it clear and send with the file refs. On failure (or an ingest that
  yields no usable file) it **keeps the files staged**, surfaces a toast ("…they're
  still attached, tap Send to retry"), and does **not** send the message without them.
- **Progress indicator.** A `.staging-busy` state (dim chips, hide the remove buttons,
  pulse the "Adding…" header) covers the single-file case that had no batch bar.
- **No invented message.** A files-only send now shows the attached **file name(s)** as
  the bubble/message — truthful, not a fabricated instruction. The server's fallback
  (`chat-routes.ts`) likewise derives from the file names; the attached-files note is
  what actually directs the assistant to read them.
- **Don't ask to re-upload an already-attached file.** The assistant system prompt now
  states that a file attached to the current message is already available (never tell
  the user to upload it again), and to ask for an attachment only when a _referenced_
  file cannot be found among existing Files.

## Requirements coverage

- (1) upload just a file, (2) upload a file + message — both send the file reliably
  now (no pre-clear, no send-without-file);
- (3) reference a previously-uploaded file — prompt directs the assistant to find it in
  Files first; (4) reference a not-yet-uploaded file — prompt directs it to ask for the
  attachment;
- (5) uploading/ingesting indicator — `.staging-busy` + "Adding…" + locked Send;
- (6) no invented "take a look at this file" — replaced by the truthful file name(s).

## Tests

The client bundle is byte-pinned; `tests/unit/app-js-composition.test.ts` and
`tests/unit/app-css-composition.test.ts` recapture the length/hash and assert the
composed script is syntactically valid. The composer's attach→ingest→send behavior is
GUI-level; verify manually: attach one file with no text (sends as the file name, not
"take a look…"; Send is locked + tray reads "Adding…" during ingest), attach a file
with text (both sent together), and simulate an ingest failure (files stay staged, a
toast appears, the message is not sent without them).
