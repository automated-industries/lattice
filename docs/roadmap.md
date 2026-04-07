# Lattice — Roadmap & Feature Ideas

> Last updated: 2026-04-07

Items are classified as:

- **ROADMAP** — architectural decisions, planned infrastructure changes
- **FEATURE** — specific capabilities to build, can be scoped into tickets

---

## 1. Audit Trail for Entity Tables

**Type:** FEATURE (quick win)

**Problem:** `AuditEmitter` exists in Lattice but `auditTables` defaults to `[]` (nothing audited). No record of skill/playbook/feedback changes.

**Proposed:** Enable audit logging for configurable tables. At minimum: skills, playbooks, feedback. Each insert/update/delete emits an audit event with before/after state.

**Why:** The infrastructure exists, just needs to be turned on with sensible defaults. This unblocks everything else — you can't build confidence decay, contradiction detection, or rollback without knowing what changed and when.

---

## 2. Reverse-Seed Safeguard (Recovery from Empty DB)

**Type:** FEATURE

**Problem:** If the DB is reset/wiped but rendered files exist on disk, all data is lost. There's no mechanism to re-seed from the files that Lattice itself generated.

**Proposed behavior:**

- DB has data → render to files (current behavior)
- DB table is empty + rendered files exist → parse files back into DB rows
- Both exist → DB wins (source of truth)
- Neither exists → seed from defaults

**Why:** Production DB resets happen (accidental, migration failures, volume loss). The rendered files are a perfectly good backup — Lattice generated them, it should be able to read them back.

---

## 3. Knowledge Reconciliation — The Pruning Side of the Learning Loop

**Type:** ROADMAP

**Problem:** The learning loop (feedback → playbook → skill) only adds knowledge. There is no process to prune stale context, detect contradictions, or classify conflicts. Context only grows — agent context sizes already hit 225KB for some agents.

**The gap:**

1. **Prune stale context** — old skills, outdated memory entries, superseded playbooks accumulate forever
2. **Reconcile contradictions** — when new info conflicts with existing knowledge, nobody flags it
3. **Classify conflicts** — is it idiosyncratic (one-off exception) or systematic (the old rule was wrong)?
4. **Detect oscillation** — the system flip-flops between two contradictory rules over time

**Proposed reconciliation step in the learning loop:**

```
New information arrives
  → Compare against existing knowledge (skills, playbooks, memory)
    → No conflict → add normally
    → Conflict detected → classify:
      → Idiosyncratic (one-off) → note as exception, don't change base knowledge
      → Systematic (pattern) → flag for review, propose update to base knowledge
        → If approved → update/replace old knowledge, prune superseded entries
        → If rejected → note as known exception
```

**Three-agent architecture needed:**

1. **Consigliere** — catches point-in-time drift and contradictions
2. **Knowledge Hygiene agent** — catches temporal patterns (flip-flopping, decay, oscillation)
3. **Lattice infrastructure** — timestamps + confidence scores on every entry

**Prior art research (2026-04-07):**

| Capability                              | Best existing implementation                                    | Gap?                                  |
| --------------------------------------- | --------------------------------------------------------------- | ------------------------------------- |
| Temporal fact tracking                  | Graphiti (Zep, open source) — 4 timestamps per fact             | No                                    |
| Contradiction detection                 | Graphiti + AGM Cognitive Memory paper — LLM-based comparison    | Partial — brittle on subtle conflicts |
| Confidence decay on disuse              | TTL/recency weighting only                                      | **Yes — nobody has continuous decay** |
| Anti-oscillation (flip-flop)            | Robotics only ("The Irrational Machine")                        | **Yes — nothing for learning loops**  |
| Exception vs rule change classification | Nobody                                                          | **Yes — biggest gap in the field**    |
| Truth Maintenance Systems               | Classical AI (1980s) — nobody has integrated with modern agents | **Yes — nobody since the 80s**        |

**Key papers:**

1. [Graph-Native Cognitive Memory for AI Agents](https://arxiv.org/html/2603.17244v1) (March 2026) — AGM belief revision applied to agent memory
2. [BeliefShift benchmark](https://arxiv.org/html/2603.23848v1) (March 2026) — metrics for temporal belief consistency and contradiction detection
3. [Zep/Graphiti](https://arxiv.org/html/2501.13956v1) (January 2025) — temporal knowledge graph, closest production implementation
4. [The Irrational Machine](https://arxiv.org/html/2510.10823) (October 2025) — flip-flop detection with commit-on-near-tie and margin-to-switch thresholds
5. [T-GRAG](https://arxiv.org/abs/2508.01680) (2025) — dynamic temporal GraphRAG resolving temporal conflicts
6. [MemOS](https://arxiv.org/abs/2507.03724) (July 2025) — memory OS with MemCube abstraction and feedback/correction loops

**Novel opportunity:** A TMS-inspired justification graph layered onto a temporal KG with decaying confidence scores — combines Graphiti's temporal tracking, AGM's formal revision semantics, and The Irrational Machine's anti-oscillation mechanisms. Nobody has done this.

---

## 4. Incremental Writes (Event Log Pattern)

**Type:** ROADMAP

**Problem:** Current writes are full row overwrites. Last-write-wins, no merge, no history. When a skill is updated, the previous version is gone.

**Proposed behavior:**

- Each write to skills/playbooks/feedback is a versioned operation with a flag: `add`, `replace`, `delete`
- Operations are appended to a change log (not overwriting the row directly)
- The current state is the result of replaying the log (or a materialized view)
- Each operation records: timestamp, user_id/agent_id, diff/content, reason

**Why:** At scale with multiple concurrent agents writing skills, blind overwrites lose information. The event log pattern enables: audit trail, conflict detection, rollback, and promotion pipeline tracking.

**Not urgent** — hash-skip renderer handles current scale fine. Build this when concurrent agent writes start causing data loss.

---

## 5. Confidence Decay Scoring

**Type:** FEATURE

**Problem:** Knowledge items (skills, playbooks) are binary — active or deleted. There's no signal for "this skill hasn't been exercised in 3 months and conflicts with 2 newer playbooks."

**Proposed:**

- Every knowledge item gets a `confidence` score (0.0–1.0) and `last_exercised_at` timestamp
- Confidence decays over time if the item isn't used/validated
- Low-confidence items are flagged for review (not auto-deleted — Sarah decides)
- Validation (agent uses skill successfully) refreshes confidence
- Contradiction (new evidence conflicts) reduces confidence

**Depends on:** Audit trail (#1) and timestamps on all entries.

---

## 6. Anti-Oscillation Detection

**Type:** FEATURE

**Problem:** The system might flip-flop between contradictory rules — add rule A, then evidence suggests B, then back to A. The Consigliere catches point-in-time drift but not temporal oscillation patterns.

**Proposed:**

- Track the history of changes to each knowledge item (requires event log, #4)
- Detect when an item has been updated > N times with alternating content
- Apply "margin-to-switch" threshold — don't change a rule unless the new evidence is significantly stronger than the current rule
- Flag oscillating items for human review with the full change history

**Inspired by:** "The Irrational Machine" paper — commit-on-near-tie, margin-to-switch thresholds, temporal smoothing.

**Depends on:** Event log (#4) and audit trail (#1).

---

## 7. Implementation Notes (Keep It Simple)

**Type:** ROADMAP

Sarah's principle: don't overcomplicate. The core of all 6 items above is just **three columns on every knowledge row:**

```sql
ALTER TABLE skills ADD COLUMN last_used_at TEXT;      -- when was this skill last exercised?
ALTER TABLE skills ADD COLUMN change_count INTEGER DEFAULT 0;  -- how many times has this been edited?
ALTER TABLE skills ADD COLUMN confidence REAL DEFAULT 1.0;     -- 0.0 to 1.0, decays over time
```

Same for playbooks and feedback. That's it — no graph databases, no RL, no embeddings.

**Contradiction detection** is a simple query:

```sql
-- Find skills with overlapping scope that were updated close together with different content
SELECT a.slug, b.slug, a.updated_at, b.updated_at
FROM skills a JOIN skills b ON a.category = b.category AND a.id != b.id
WHERE a.name LIKE '%' || b.name || '%'
AND ABS(julianday(a.updated_at) - julianday(b.updated_at)) < 7;
```

**Oscillation detection** is just `change_count` — if a skill has been edited > N times in M days, flag it.

**Pruning score** (when ready):

```
score = (usage_frequency * 0.4) + (recency * 0.3) + (consistency * 0.3)
```

Low score → flag for Sarah's review. Never auto-delete.

**Reference links from ChatGPT research (useful ones only):**

- [OpenAI Cookbook: Temporal agents with knowledge graphs](https://cookbook.openai.com/examples/temporal_agents) — foundation for time-aware facts
- [Claude Code issue: Temporal context graph](https://github.com/anthropics/claude-code/issues) — aligned proposal for facts + constraints + events
- [Awesome TKGC repo](https://github.com/nhutnamhee/awesome-temporal-knowledge-graph-completion) — reading list for temporal KG patterns

**Not needed now:** RL-based pruning, temporal embeddings, 4-layer architectures. These are academic. Three columns + simple queries gets us 80% of the value.

**EXCEPTION — counterfactual pruning IS required.** Before deleting any knowledge item, run a regression check: "if I remove this, does anything break?" Sarah already built this pattern in the Canoe validation dashboard — regression simulation tests whether a proposed GP rule change breaks existing passing validations before applying it. Same principle for knowledge pruning:

```
Proposed deletion: skill X (low confidence, stale)
  → Find all agents assigned skill X
  → Find recent runs where those agents succeeded
  → Check: did any of those runs reference skill X in their reasoning?
    → Yes → DO NOT DELETE, flag as "low confidence but load-bearing"
    → No → Safe to archive (not delete — archive with full history)
```

**Never auto-delete. Always archive. Always regression-test first.**
