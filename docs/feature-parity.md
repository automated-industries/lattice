# Feature Parity Matrix

Tracks which features exist in each Lattice package and whether they are documented
on the website. **This file must be updated with every release.**

Last updated: 2026-03-30 (v0.14.0)

---

## Legend

| Symbol | Meaning |
|--------|---------|
| ✓ | Implemented and shipped |
| — | Not applicable (language-specific, not ported) |
| ✗ | Missing — needs to be added |
| 🔜 | Planned for next release |

---

## Core API

| Feature | NPM (`latticesql`) | Go (`lattice-go`) | Website Docs | Since |
|---------|--------------------|-------------------|--------------|-------|
| `new Lattice(config)` constructor | ✓ | ✗ | ✓ | v0.1.0 |
| `lattice.define(table, schema)` | ✓ | ✗ | ✓ | v0.1.0 |
| `lattice.reconcile()` | ✓ | ✗ | ✓ | v0.5.0 |
| `lattice.start()` / `lattice.stop()` | ✓ | ✗ | ✓ | v0.1.0 |
| `lattice.query(table)` / `.all()` / `.get()` | ✓ | ✗ | ✓ | v0.1.0 |
| `lattice.insert(table, row)` | ✓ | ✗ | ✓ | v0.1.0 |
| `lattice.update(table, id, fields)` | ✓ | ✗ | ✓ | v0.1.0 |
| `lattice.delete(table, id)` | ✓ | ✗ | ✓ | v0.1.0 |
| WAL mode + busy timeout | ✓ | ✗ | — | v0.1.0 |

## Schema & Migrations

| Feature | NPM | Go | Website Docs | Since |
|---------|-----|----|--------------|-------|
| Column type definitions | ✓ | ✗ | ✓ | v0.1.0 |
| Foreign key / relations | ✓ | ✗ | ✓ | v0.1.0 |
| `addColumn` migrations | ✓ | ✗ | ✓ | v0.3.0 |
| `renameColumn` migrations | ✓ | ✗ | ✓ | v0.3.0 |
| `dropColumn` migrations | ✓ | ✗ | ✓ | v0.3.0 |
| `addIndex` / `dropIndex` | ✓ | ✗ | ✓ | v0.3.0 |
| Schema validation on startup | ✓ | ✗ | ✓ | v0.2.0 |
| Auto-migration on schema drift | ✓ | ✗ | ✓ | v0.4.0 |

## Render Engine (Markdown generation)

| Feature | NPM | Go | Website Docs | Since |
|---------|-----|----|--------------|-------|
| `render(outputDir)` | ✓ | ✗ | ✓ | v0.1.0 |
| Default list template | ✓ | ✗ | ✓ | v0.1.0 |
| Default table template | ✓ | ✗ | ✓ | v0.1.0 |
| Default detail template | ✓ | ✗ | ✓ | v0.1.0 |
| Default JSON template | ✓ | ✗ | ✓ | v0.2.0 |
| Custom Handlebars templates | ✓ | ✗ | ✓ | v0.2.0 |
| Relation resolution in templates | ✓ | ✗ | ✓ | v0.3.0 |
| Manifest file (render tracking) | ✓ | ✗ | ✓ | v0.5.0 |

## Entity Context Directories

| Feature | NPM | Go | Website Docs | Since |
|---------|-----|----|--------------|-------|
| `defineEntityContext(table, config)` | ✓ | ✗ | ✓ | v0.5.0 |
| Per-row context directories | ✓ | ✗ | ✓ | v0.5.0 |
| Relation-joined context files | ✓ | ✗ | ✓ | v0.5.0 |
| `cleanup()` on deleted rows | ✓ | ✗ | ✓ | v0.5.0 |

## Writeback (SESSION.md → DB)

| Feature | NPM | Go | Website Docs | Since |
|---------|-----|----|--------------|-------|
| `defineWriteback(definition)` | ✓ | ✗ | ✓ | v0.6.0 |
| File watcher (chokidar / polling) | ✓ | ✗ | ✓ | v0.6.0 |
| Idempotent entry processing | ✓ | ✗ | ✓ | v0.6.0 |
| Deduplication via entry ID | ✓ | ✗ | ✓ | v0.6.0 |
| `event` entry type | ✓ | ✗ | ✓ | v0.6.0 |
| `write` entry type (DB mutation) | ✓ | ✗ | ✓ | v0.7.0 |
| Multi-entry SESSION.md parsing | ✓ | ✗ | ✓ | v0.7.0 |
| Schema validation on write entries | ✓ | ✗ | ✓ | v0.8.0 |

## Security

| Feature | NPM | Go | Website Docs | Since |
|---------|-----|----|--------------|-------|
| `sanitizeRow()` (null-byte, length limits) | ✓ | ✗ | ✓ | v0.2.0 |
| Audit event emission on write | ✓ | ✗ | ✓ | v0.8.0 |
| Column/table name injection prevention | ✓ | ✗ | ✓ | v0.8.0 |
| `check-generic.sh` (no internal terms) | ✓ | — | — | v0.4.0 |

## Lifecycle

| Feature | NPM | Go | Website Docs | Since |
|---------|-----|----|--------------|-------|
| `SyncLoop` with interval polling | ✓ | ✗ | ✓ | v0.5.0 |
| `StopFn` returned from `start()` | ✓ | ✗ | ✓ | v0.5.0 |
| Graceful shutdown | ✓ | ✗ | ✓ | v0.5.0 |

## CLI (`lattice` binary)

| Feature | NPM | Go | Website Docs | Since |
|---------|-----|----|--------------|-------|
| `lattice init` | ✓ | — | ✓ | v0.9.0 |
| `lattice status` | ✓ | — | ✓ | v0.9.0 |
| `lattice render` | ✓ | — | ✓ | v0.10.0 |
| `lattice migrate` | ✓ | — | ✓ | v0.10.0 |
| CLI binary in npm package | ✓ | — | ✓ | v0.9.0 |

*CLI is NPM-only by design — it is a dev tooling surface, not a runtime API.*

## Codegen

| Feature | NPM | Go | Website Docs | Since |
|---------|-----|----|--------------|-------|
| TypeScript type generation from schema | ✓ | — | ✓ | v0.11.0 |

## Report Framework

| Feature | NPM | Go | Website Docs | Since |
|---------|-----|----|--------------|-------|
| `buildReport(config)` | ✓ | ✗ | ✓ | v0.14.0 |
| Time-windowed sections | ✓ | ✗ | ✓ | v0.14.0 |
| Configurable aggregation | ✓ | ✗ | ✓ | v0.14.0 |

## Seeding DSL

| Feature | NPM | Go | Website Docs | Since |
|---------|-----|----|--------------|-------|
| `seed(config)` — YAML/JSON → DB | ✓ | ✗ | ✓ | v0.13.0 |
| Upsert + link + prune | ✓ | ✗ | ✓ | v0.13.0 |

---

## Parity Summary (v0.14.0)

| Package | Core | Schema | Render | Entity Ctx | Writeback | Security | Lifecycle |
|---------|------|--------|--------|------------|-----------|----------|-----------|
| NPM (`latticesql`) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Go (`lattice-go`) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |

**Go parity status: 0% — repo not yet created. Target: v0.15.0 with core + schema + basic render.**

---

## Updating This File

After every release, update this file by:

1. Adding rows for any new features
2. Updating ✗ → ✓ when Go or website coverage is added
3. Updating the "Last updated" date and version at the top
4. Updating the Parity Summary table

This file lives in the NPM repo but describes the state of all three repos. Agents
working on the Go repo must submit a PR to this file when Go parity is achieved for
a feature group.
