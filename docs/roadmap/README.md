# Roadmap: from one hydrologist's tool to a catchment platform

The app grows in four steps. Each step brings in a new group of users and builds
on the step before. Each step has its own build plan in this folder, written so
a future session can pick it up without this conversation.

| Step | Plan | Who it adds | Headline outcome |
| --- | --- | --- | --- |
| 1 | [step-1-hydrologist-tool.md](./step-1-hydrologist-tool.md) | Consulting hydrologists, the first client | A trusted, deployed replacement for the b023 spreadsheet |
| 2 | [step-2-shared-catchment.md](./step-2-shared-catchment.md) | Farmers, Water User Associations (WUAs) / irrigation boards | One live, shared picture of a catchment: farm views, alerts, data feeds, reports |
| 3 | [step-3-licensing.md](./step-3-licensing.md) | Licence applicants, assessors (CMA/DWS), environmental NGOs | Evidence for water-use licence applications and cumulative-impact assessment |
| 4 | [step-4-platform.md](./step-4-platform.md) | Many organisations and catchments, other countries | A multi-tenant product: fast onboarding, billing, SSO, API, climate scenarios |
| ⟂ | [international.md](./international.md) | People in other countries | A cross-cutting plan: generalising the engine (water year, ET0, EWR and allocation rule sets), global data sources, languages, data residency, multi-region hosting, a first expansion market |

The international plan isn't a fifth step. Its cheap pieces land early (string
extraction arrives with Afrikaans in Step 2), and the rest builds on Step 4's
multi-tenancy and multi-region seams. It says which step each work package
belongs to.

These plans supersede the loose ordering in [planned-work.md](../planned-work.md)
§ "Suggested order". That file stays the catalogue of individual features. Each
step plan says which catalogue rows it delivers. Short-term loose ends live in
[followups.md](../followups.md).

## Gates between steps

A step starts only when the previous step's exit criteria are met. Exit criteria
are in each plan's **Exit criteria** section.

- **Step 1 → 2.** A hydrologist has signed off the model: issue #1 is decided,
  and the audit questions in engine-audit.md are answered or explicitly
  accepted. The app is deployed. Nobody but the modeller should rely on its
  numbers before this.
- **Step 2 → 3.** At least one catchment runs "live" (data feeds plus a
  published baseline) with real WUA/farmer users. The audit log exists. Legal
  and liability wording is agreed with the client.
- **Step 3 → 4.** A second paying organisation, or a signed commercial
  decision, makes multi-tenancy and billing worth building.

Before building a step, validate the need with the domain personas
(`.claude/agents/personas/persona-*.md`, run with `/persona …`):
- Step 2: `wua-manager`, `farmer`.
- Step 3: `licence-applicant`, `licensing-authority`, `environmentalist`.
- Every step: `hydrologist`.

Record their "Need verdict" in the plan's **Validation** section.

## Rules every step plan follows

These come from the repo's hard rules (root `CLAUDE.md`, `docs/STACK.md`). A plan
that breaks one is wrong. Fix the plan; don't work around the rule.

1. **Local-first.** Every new external dependency ships with a local equivalent
   and a code default that points at it, in the same change. Examples:
   - a scheduled fetcher runs locally from a dev script against fixture files;
   - S3 becomes MinIO in docker-compose;
   - SQS becomes an in-process queue;
   - map tiles are self-hosted Protomaps (PMTiles) served locally.

   Each new service gets a root script in the existing
   `dev:<service>:up/down/status/logs` format.
2. **Row-level security (RLS) always.** Every new table gets RLS policies,
   `GRANT … TO water_app`, covering indexes and same-project triggers, all in
   its migration (`/safe-migration`). Every RLS "cannot see" test has a
   positive control. New visibility scopes (e.g. "a farmer sees only their own
   farm") are RLS policies, not UI filtering.
3. **Migrations are forward-only once deployed.** Plans never hard-code
   migration numbers; use the next free `NNN_`. Prefer expand/contract for
   changes to existing tables.
4. **The engine stays pure.** No I/O in `packages/engine`. A behaviour change
   bumps `ENGINE_VERSION` and passes the invariant suite and a
   `FUZZ_CASES=20000` soak. New physics comes with a model.md section and an
   invariant.
5. **Every route is auth-gated or on the public allowlist.** API errors never
   leak DB text. New public surfaces (share links, the API) go through
   `/audit/auth` and `/audit/xss` before release.
6. **Tests and docs in the same change.** Each work package lists its tests:
   unit, DB/RLS, e2e and axe. Date-sensitive tests run under a skewed `TZ`.
7. **Public-repo hygiene.** Fixtures are synthetic. No client names or values.
8. **Deploys go through the `production` environment.** CI uses OIDC; no
   static keys. Terraform: `plan` is fine; `apply` only with the operator.
9. **No preemptive abstraction.** Build for the step you're in; extract on the
   third use. Where a later step needs a seam, a plan says "leave room for X"
   and names it, rather than building X early.

## Plan template

Every `step-N-*.md` uses these sections, in this order:

1. **Summary.** Two or three sentences on who it's for and what changes for them.
2. **Users and jobs to be done.** Each user type: what they need to get done,
   what they use today, what would make them switch.
3. **Scope.** In scope, and explicitly out of scope (with the step that does it).
4. **Prerequisites.** What must be true before starting, including decisions
   still open.
5. **Architecture changes.** A short diagram or list: new services, tables,
   jobs, and what they touch in the existing system (name real files and
   modules).
6. **Work packages.** Numbered WP-N.x, in build order. Each has:
   - **Goal**
   - **Changes**, by workspace: engine / backend + migrations / frontend /
     infra / scripts
   - **Data model** (tables, columns, RLS policies in words)
   - **API** (routes and contracts; add them to api.md when built)
   - **UI** (screens and states: empty, loading, error, viewer vs editor, phone)
   - **Local-first equivalent**
   - **Tests** (unit / DB+RLS / e2e / axe / invariants)
   - **Docs to update**
   - **Acceptance criteria** (observable, testable)
   - **Size** (S ≤ 3 days, M ≤ 2 weeks, L > 2 weeks)
   - **Depends on**
7. **Security, privacy and compliance.** New trust boundaries, personal data
   (POPIA), retention, abuse cases, liability.
8. **Cost and operations.** AWS cost deltas, alarms, support load, runbooks.
9. **Validation.** Which personas to run, what they must conclude, and the
   client questions to ask.
10. **Exit criteria.** What must be true to call the step done and open the
    next.
11. **Open decisions.** Each with options, a recommendation and who decides.
12. **Risks.** Likelihood / impact / mitigation.
