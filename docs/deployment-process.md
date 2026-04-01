# Lattice OSS — Deployment Process

This document is the authoritative reference for how Lattice OSS features are developed,
tested, and released across all three repositories.

**Last updated:** 2026-03-30

---

## The Three-Repo Constraint

Lattice OSS spans three repositories that must stay in sync:

| Repo              | Purpose            | Location                               | Published At                                          |
| ----------------- | ------------------ | -------------------------------------- | ----------------------------------------------------- |
| `lattice` (NPM)   | TypeScript package | `automated-industries/lattice`         | npmjs.com/package/latticesql                          |
| `lattice-go` (Go) | Go module          | `automated-industries/lattice-go`      | pkg.go.dev/github.com/automated-industries/lattice-go |
| `lattice-website` | Marketing + docs   | `automated-industries/lattice-website` | latticesql.com                                        |

**Rule:** A feature is not released until it exists in both packages and is documented on
the website. No partial releases. No "we'll add Go support later."

This constraint exists because users choose a language. If Go support lags, Go users get
an inferior product. Documentation that trails the packages destroys trust.

---

## Version Strategy

NPM and Go use matching semver. When NPM ships v0.15.0, Go ships v0.15.0.

```
NPM:     latticesql@0.15.0
Go:      github.com/automated-industries/lattice-go v0.15.0
Website: documents v0.15.0 features
```

If a Go port of a feature is genuinely incomplete at release time, the feature is held
in both packages until Go is ready. The alternative — a version matrix with NPM ahead
of Go — creates permanent maintenance debt and confuses users.

### Pre-1.0 policy

While in v0.x.y, breaking changes are allowed. Increment the minor version for breaking
changes, patch for backwards-compatible fixes and additions.

---

## Development Workflow

### Adding a new feature

1. **Design first.** Write the feature spec as a PR description or a doc in `docs/plans/`
   before writing code. Include API surface for both TypeScript and Go.

2. **Implement in NPM.** TypeScript implementation in `lattice/src/`. Must include:
   - Unit tests in `tests/unit/`
   - Integration test in `tests/integration/` if the feature touches file I/O or SQLite
   - API reference update in `docs/api-reference.md`
   - README update if user-visible

3. **Port to Go.** Go implementation in `lattice-go/`. Must include:
   - Table-driven tests matching the NPM test cases
   - Godoc comments on all exported symbols
   - README update

4. **Update the website.** Before any release:
   - Update `lattice-website/src/app/docs/page.tsx` with the new feature documentation
   - Keep examples consistent between the NPM and Go code blocks on the docs page

5. **Update the feature parity matrix.** Mark the feature as ✓ for both packages in
   `docs/feature-parity.md`. Commit this alongside the feature, not after.

6. **Open a coordinated PR.** See below.

### PR strategy

For significant features, open three linked PRs simultaneously:

- `lattice` PR: TypeScript implementation
- `lattice-go` PR: Go port
- `lattice-website` PR: Documentation

Reference the other PRs in each PR body. Don't merge any until all three are approved.

For small changes (bug fixes, doc corrections), a single-repo PR is acceptable if the
change genuinely does not affect the other repos. Use judgment — when in doubt, update all
three.

---

## CI/CD

### lattice (NPM) — existing

`.github/workflows/ci.yml` runs on every push to `main` and all PRs:

```
lint → format:check → typecheck → test:coverage → build → ESM verify → CJS verify
```

`.github/workflows/release.yml` triggers on `v*` tags:

```
lint → typecheck → test → build → npm publish (with provenance)
```

Required secret: `NPM_TOKEN`

### lattice-go — when created

`.github/workflows/ci.yml` must run:

```yaml
- go vet ./...
- go test ./... -race -count=1
```

Trigger: push to `main`, all PRs to `main`.

`.github/workflows/release.yml` triggers on `v*` tags. No publish step needed — Go modules
are consumed directly from git tags by `pkg.go.dev`.

### lattice-website

`.github/workflows/ci.yml` runs on every push to `main` and all PRs:

```
lint (next lint) → build (next build)
```

Vercel handles deployment automatically on merge to `main`. The CI workflow is a gate only
— it ensures the build does not break before Vercel deploys it.

---

## Branch Protection

All three repos must have branch protection on `main`:

| Rule                                 | NPM | Go  | Website |
| ------------------------------------ | --- | --- | ------- |
| Require PR before merging            | ✓   | ✓   | ✓       |
| Require status checks to pass        | ✓   | ✓   | ✓       |
| Require branches to be up to date    | ✓   | ✓   | ✓       |
| Dismiss stale reviews on new commits | ✓   | ✓   | ✓       |

**Required status checks:**

- NPM: `Lint, typecheck, test, build`
- Go: `Lint, test, build`
- Website: `Lint and build`

**Manual setup required.** Branch protection is configured in GitHub repository settings
(Settings → Branches → Branch protection rules). The CI workflow names above must match
exactly what you enter as required status checks.

To configure via GitHub CLI:

```bash
gh api repos/automated-industries/lattice/branches/main/protection \
  --method PUT \
  --field required_status_checks='{"strict":true,"contexts":["Lint, typecheck, test, build"]}' \
  --field enforce_admins=false \
  --field required_pull_request_reviews='{"dismiss_stale_reviews":true,"required_approving_review_count":1}' \
  --field restrictions=null
```

Replace repo name and context name as needed for each repo.

---

## Release Process

### Pre-release checklist

Run through this checklist before cutting a release tag:

- [ ] All CI checks passing on `main` for all three repos
- [ ] `docs/feature-parity.md` is current (all new features marked ✓)
- [ ] `CHANGELOG.md` updated in NPM repo with full feature list for this version
- [ ] Go repo `CHANGELOG.md` updated (same features)
- [ ] Website docs updated for all new features
- [ ] Version bumped in `package.json` (NPM) and `go.mod` (Go — via tag)
- [ ] No pending `TODO(release)` or `FIXME(release)` comments in either codebase

### Cutting the release

1. **Bump version in NPM repo:**

   ```bash
   cd repos/lattice
   npm version minor  # or patch / major
   git push origin main --tags
   ```

   The `release.yml` workflow triggers automatically on the `v*` tag and publishes to npm.

2. **Tag the Go repo at the same version:**

   ```bash
   cd repos/lattice-go
   git tag v0.15.0
   git push origin v0.15.0
   ```

   `pkg.go.dev` indexes the tag automatically within minutes.

3. **Verify the website:**
   - Confirm Vercel deployed the latest `main` of `lattice-website`
   - Spot-check the docs page for the new features

4. **Announce** (if applicable) — post to Slack/Discord/HN.

### Rollback

If a bad NPM publish occurs, use `npm deprecate` to flag the version, then publish a patch.
NPM does not support true unpublish after 72 hours. For Go, a bad tag can be overridden by
publishing a higher patch version. Document any rollbacks in CHANGELOG.md.

---

## CHANGELOG Coordination

Both the NPM and Go repos maintain a `CHANGELOG.md`. Entries for the same release must
describe the same features. The website does not have a CHANGELOG — it reflects the current
state of the docs.

Format (both repos):

```markdown
## v0.15.0 — 2026-04-15

### Added

- `buildReport()` — time-windowed report sections with configurable aggregation
- `seed()` — YAML/JSON seeding DSL for upsert + link + prune

### Fixed

- ...

### Breaking

- ...
```

---

## Agent Responsibilities

| Agent     | Responsibility                                                                  |
| --------- | ------------------------------------------------------------------------------- |
| Forge     | TypeScript implementation, NPM releases, docs/api-reference.md                  |
| Pipeline  | CI/CD workflows, branch protection, release automation, cross-repo coordination |
| Commons   | Go port, lattice-go CI, Go documentation                                        |
| Anvil     | QA, test coverage, integration test strategy                                    |
| Blueprint | Go architecture, module design, API surface parity                              |
| Alloy     | Go build tooling, CI configuration for lattice-go                               |

When Forge adds a feature:

1. Forge notifies Commons to begin the Go port
2. Forge opens the website PR
3. Pipeline verifies CI is green on all three before merge
4. Anvil reviews test coverage

No feature ships until all agents have completed their portion.

---

## Reference

- Feature parity matrix: `docs/feature-parity.md`
- API reference (NPM): `docs/api-reference.md`
- Architecture: `docs/architecture.md`
- Go repo: `github.com/automated-industries/lattice-go` (to be created)
- Website repo: `github.com/automated-industries/lattice-website`
