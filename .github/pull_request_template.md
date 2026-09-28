## Summary

<!-- 1–3 sentences on what this PR does and why. End with "Closes #<n>" when it finishes an issue. -->

## Changes

<!-- Bulleted list of the user-visible or developer-visible changes. -->

-
-

## Surface touched

- [ ] Engine (`packages/engine`)
- [ ] Backend (`backend/src`)
- [ ] Database migrations (`backend/migrations`)
- [ ] Frontend (`frontend/src`)
- [ ] Infrastructure (`infra/`)
- [ ] CI / GitHub Actions (`.github/`)
- [ ] E2E tests (`e2e/`)
- [ ] Claude tooling (`.claude/`, `CLAUDE.md`)
- [ ] Docs only

## Data safety checklist

<!-- Tick what applies. Leave a row unticked if it genuinely doesn't apply,
     but don't delete it, so the next reviewer can see you considered it. -->

- [ ] Project data is read and written only inside `withUser` (or `withApiKey`); nothing new runs through `withoutUser`
- [ ] A new table has RLS, policies, same-project triggers and `GRANT … TO water_app` in its migration
- [ ] A new route is behind `requireUser` or on the public allowlist in `backend/src/routes.test.ts`
- [ ] No raw DB error text, token or personal data in a response or a log
- [ ] No client data, real farm names or values, and no secret in any file
- [ ] A change in model behaviour bumps `ENGINE_VERSION`

## Test plan

<!-- The targeted commands you ran (CLAUDE.md rule 12). CI runs the full suite. -->

- [ ] `pnpm check && pnpm test`
- [ ] DB tests for what changed: `pnpm -C backend exec vitest run --project db src/<area>`
- [ ] e2e specs for the screens changed: `pnpm -C e2e e2e tests/<spec>.spec.ts`
