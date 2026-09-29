---
description: Pre-release go/no-go for a backend@X.Y.Z or web@X.Y.Z release. Checks main, CI, what each component would ship since its last release, migrations, and open security signals. Reports a green/red checklist. Read-only; never tags or publishes.
argument-hint: "[backend|web] (optional; both by default)"
---

Run the go/no-go checklist before publishing a release. Report it; never tag,
push or publish. The operator runs `gh release create` after reading it.

## How releases work here

Each component has its own release line (`docs/deployment.md` § Releasing):

| Tag | Workflow | Ships |
|---|---|---|
| `backend@X.Y.Z` | `deploy-backend.yml` | migrations (migrate Lambda), then the API, worker, fetcher and renderer |
| `web@X.Y.Z` | `deploy-frontend.yml` | the static SPA to S3 + a CloudFront invalidation |

Publishing the Release is the trigger. A preflight job then refuses it unless
the tag is newer than the component's last release, the commit is on `main`
with `CI gate` green, the `production` environment has a required reviewer,
and every AWS variable is set. The deploy waits for the operator's approval
in `production`. This command checks the same things earlier, plus what a
human should look at before approving.

## Procedure

Resolve components from `$ARGUMENTS` (none → both). Mark each gate
green / amber / red with a one-line reason.

### 1. main and CI

```
git fetch origin main
git log -1 --format='%h %s' origin/main
gh run list --branch main --workflow ci.yml --limit 1 --json status,conclusion,headSha
```

Red if `CI gate` on `origin/main`'s head isn't `completed/success`. Releases
target `origin/main` (`--target main`), so the local checkout's state doesn't
matter; main is only ever changed through PRs.

### 2. What each component would ship

```
git tag --list 'backend@*' --sort=-v:refname | head -1
git tag --list 'web@*' --sort=-v:refname | head -1
```

With no earlier release, compare against the first commit and say so.

- **backend**: `git log --oneline <last>..origin/main -- backend/ packages/engine/`
- **web**: `git log --oneline <last>..origin/main -- frontend/ packages/engine/`
- Both: `infra/` changes since (Terraform is applied by hand, not by the
  release; flag if the release depends on an unapplied change).

Red if a requested component has nothing to ship.

### 3. Migrations (backend)

`git diff --name-only <last>..origin/main -- backend/migrations/`

For each new file: no already-released file was edited (forward-only,
CLAUDE.md rule 2), and it is compatible with the API version still serving
while it runs (expand/contract). A destructive step (DROP, a NOT NULL
without a default, a type change) is amber with the file and line.

### 4. Order

If web changes need new API behaviour, the backend release must go out and
finish first. Say which order to release in.

### 5. Open signals (amber, never blocking)

```
gh issue list --label dependency-audit --state open
gh api repos/{owner}/{repo}/code-scanning/alerts --jq '[.[]|select(.state=="open")]|length'
gh api repos/{owner}/{repo}/dependabot/alerts --jq '[.[]|select(.state=="open")]|length'
```

Also `docs/security.md` § Known gaps and `docs/legal-status.md` items marked
as blocking go-live, if this is the first production release.

### 6. Report

```
# Release readiness — <date>

| Gate | Status | Detail |
|---|---|---|
| CI gate green on origin/main | ✓ / ✗ | ... |
| backend: commits since <tag> | n | ... |
| backend: migrations | ✓ / ⚠ | ... |
| web: commits since <tag> | n | ... |
| Release order | | backend first / either |
| Open signals | ⚠ | ... |

## Changelog draft
- <sha> <subject>

## Verdict
READY — gh release create backend@X.Y.Z --target main --title "Backend X.Y.Z" --generate-notes
or NOT READY — <the red items>
```

If `gh` is missing or signed out, mark those gates `⚠ skipped` and say how to
check by hand; don't fail the report.

Read-only: never tag, push, publish, or fix a red gate here.
