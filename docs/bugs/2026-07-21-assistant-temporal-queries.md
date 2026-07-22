# Assistant answers "most recent" temporal queries by relevance, not by date

**Date:** 2026-07-21
**Area:** assistant / retrieval
**Severity:** High — the assistant returns a confidently _wrong_ "most recent" record (worse than a "no results", because the user trusts it).

## Symptom

Asked "what was the last meeting I had with <contact>", the assistant returns a
meeting dated D1 and, when told "we met more recently than that", insists D1 is the
latest and finds nothing newer — even though a later meeting (D2) exists in the same
workspace and is fully linked to both people. D2 is a low-content calendar "HOLD"
entry (little body text).

## Root cause

Temporal questions were resolved through the relevance-ranked `search` tool
(full-text search over the workspace). Relevance ranking has no notion of recency, so
a newer record with little text ranks _below_ older, wordier ones and never enters
the retrieved set — the model then summarizes whatever came back and names an older
record as "most recent".

The structured, date-ordered path already exists: the `list_rows` tool sorts by the
table's real event/date column (e.g. a meeting's `start_at`), newest-first, and takes
column filters. Nothing routed a temporal question to it — the model reached for
`search` by default, and neither the system prompt nor the `search` tool description
warned against it.

## Fix

Guidance, not new query capability (the assistant is LLM-driven; tool selection is
steered by the system prompt + tool descriptions, exactly like every other behavior):

- **System prompt** — a rule that any time-ordered question ("most recent / last /
  latest / newest", "since <date>", "the last time I …") MUST be answered with
  `list_rows` ordered by the record's date column (`orderDir: "desc"`, small limit,
  plus the needed filter), **never** `search`; when the answer depends on a related
  record ("the last meeting WITH <person>"), find that record first, then read the
  dated entity ordered by date; when the user pushes back that something is more
  recent, **re-query by date** rather than re-running the same text search; and when
  nothing exists after a date, say so plainly instead of naming an older record.

- **`search` tool description** — now states results are ranked by text relevance, not
  time, and that `list_rows` ordered by the date column is the tool for "most recent /
  last / latest" questions.

This directly implements the reported fixes: route temporal intent to a date-ordered
query, re-query by date on pushback, and prefer "nothing after <date>" over a wrong
older answer. It does not change the `search` ranking itself (blending recency into
relevance is a larger, separate change) — instead it keeps temporal questions off the
relevance path entirely, which is the safer and more direct fix.

## Tests

`tests/unit/assistant-temporal-guidance.test.ts` pins the guidance so it can't
regress: the system prompt routes time-ordered questions to date-ordered `list_rows`
and away from `search`; `list_rows` exposes an `orderBy` column; and the `search`
description warns it is relevance-ranked, not time-ordered.

## Not fixed here (noted for follow-up)

The report also flagged a possible **ingest/coverage gap** — a meeting the user
believed occurred that is not present in the workspace at all (not by link, attendee,
title, or summary). That is a data-pipeline/sync question, distinct from this
query-routing bug, and is not addressed by this change.
