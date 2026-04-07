# Contributing to latticesql

Thank you for your interest in contributing. This document covers the development setup, workflow, and standards for the project.

---

## Table of Contents

- [Development setup](#development-setup)
- [Project structure](#project-structure)
- [Running tests](#running-tests)
- [Building](#building)
- [Code style](#code-style)
- [Submitting a change](#submitting-a-change)
- [Versioning](#versioning)

---

## Development setup

**Requirements:**

- Node.js ≥ 18 (the library targets Node 18+; tested on Node 20 and 25)
- npm ≥ 10

**Clone and install:**

```sh
git clone https://github.com/automated-industries/lattice.git
cd lattice
npm install --include=dev
```

> **Note:** Always use `--include=dev`. If `NODE_ENV=production` is set in your environment, plain `npm install` will strip devDependencies (vitest, TypeScript, etc.).

**Verify setup:**

```sh
npm run build      # Compile src/ → dist/
npm test           # Run the full test suite
npm run typecheck  # TypeScript strict type checking
```

All three should pass with no errors on a clean clone.

---

## Project structure

```
src/
├── index.ts          # Public exports
├── lattice.ts        # Lattice class
├── types.ts          # Public TypeScript types
├── cli.ts            # CLI entry point
├── config/           # YAML config schema + parser
├── codegen/          # Type + SQL migration generators
├── db/               # SQLiteAdapter
├── schema/           # SchemaManager
├── render/           # RenderEngine + templates
├── sync/             # SyncLoop
├── writeback/        # WritebackPipeline
└── security/         # Sanitizer

tests/
├── unit/             # Unit + integration tests
└── fixtures/         # Test fixture files (lattice.config.yml, etc.)

docs/                 # Documentation (Markdown)
dist/                 # Compiled output (gitignored)
```

---

## Running tests

```sh
npm test                  # Run all tests once
npm run test:watch        # Watch mode
npm run test:coverage     # Coverage report
```

Tests use [Vitest](https://vitest.dev/). All tests run against real SQLite (`:memory:`) — no mocking of the database layer.

### Test requirements

- Every new feature must include tests
- Every bug fix must include a failing test that passes after the fix (test-first)
- The test suite must remain green — no skipped or disabled tests
- Coverage target: 80%+ for new code

### Test locations

| What              | Where                        |
| ----------------- | ---------------------------- |
| Config parsing    | `tests/unit/config.test.ts`  |
| Code generation   | `tests/unit/codegen.test.ts` |
| Core CRUD + query | `tests/unit/lattice.test.ts` |
| Render templates  | `tests/unit/render.test.ts`  |

---

## Building

```sh
npm run build
```

Uses [tsup](https://tsup.egoist.dev/) to compile two entry points:

1. `src/index.ts` → `dist/index.mjs` + `dist/index.js` + type declarations
2. `src/cli.ts` → `dist/cli.js` (with `#!/usr/bin/env node` shebang)

The built output is what npm publishes — the `dist/` directory.

---

## Code style

```sh
npm run lint          # ESLint
npm run lint:fix      # ESLint with auto-fix
npm run format        # Prettier
npm run format:check  # Prettier check (CI)
```

**Key rules:**

- TypeScript strict mode (`strict: true`, `exactOptionalPropertyTypes: true`)
- No `any` — use `unknown` where the type is genuinely unknown
- `async` only where awaiting a real async operation (better-sqlite3 is synchronous)
- Public API methods return `Promise<T>` even when they resolve synchronously
- Internal modules use explicit return types
- No `console.log` in library code — only in `src/cli.ts`

### Code examples & documentation

All examples in code, docs, and tests must use **generic, fictional names**:

- People: `Alice`, `Bob`, `John`, `user-1`
- Companies: `Acme Corp`, `Example Inc`
- Emails: `alice@example.com`, `admin@test.com`
- Projects: `Project X`, `my-app`

Do not use real people, companies, clients, or internal system names in any public-facing content. When in doubt, use a placeholder.

---

## Submitting a change

1. **Open an issue first** for non-trivial changes — agree on the approach before coding.
2. **Fork** the repo and create a feature branch: `feature/my-change` or `fix/bug-name`.
3. **Write tests first** for bug fixes (see test requirements above).
4. **Keep changes focused** — one logical change per PR. Do not mix refactoring with new features.
5. **Run the full suite** before pushing: `npm run build && npm run typecheck && npm test`.
6. **Open a PR** with a clear description of what changed and why.

### PR checklist

- [ ] Tests pass (`npm test`)
- [ ] TypeScript compiles cleanly (`npm run typecheck`)
- [ ] Lint passes (`npm run lint`)
- [ ] New feature or bug fix has test coverage
- [ ] Docs updated if the public API changed
- [ ] `CHANGELOG.md` entry added

---

## Versioning

This project follows [Semantic Versioning](https://semver.org/):

- **Patch** (`0.4.x`): Bug fixes, no API changes
- **Minor** (`0.x.0`): New features, fully backward compatible
- **Major** (`x.0.0`): Breaking API changes

Breaking changes require a migration guide in `docs/` and a prominent `CHANGELOG.md` entry.

Current version: **0.5.0** (entity context directories, lifecycle management, full CLI).
