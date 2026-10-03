# Follow-ups: open work (checked against the code 2026-09-27)

Everything below is known, unfinished work. Longer-term features live in
[planned-work.md](./planned-work.md); client and hydrologist questions are in
[plan.md § Questions for the client](./plan.md#questions-for-the-client).
Tick items off (or move them into an issue) as they are done.

This file holds the detail. Anything that blocks a release or waits on
someone outside the code also has a GitHub issue: release blockers #62,
the history scrub #63, the legal go-live gates #103, the information officer's POPIA
questions and the applicant decisions (D1–D3, WP-3.3) #90,
the hydrologist's decisions #46, the Step 2
persona run #51, planning outputs #53, the client's requests #54.

The buildable work is filed in batches by area, one issue per batch, so a
session can take a batch at a time; each batch issue names the section
here that holds each item's detail. Tick an item in both places.

| Batch | Issue |
| --- | --- |
| EWR and Reserve engine work | #64 |
| Calibration workflow (CR items) | #65 |
| Rainfall and data-quality tools | #66 |
| Engine model structure (causal model, dams, time-varying development) | #67 |
| Engine verification and regression coverage | #68 |
| Data-feed hardening | #69 |
| Printable and server-side reports | #70 |
| Licensing evidence pack (WP-3.14) and its dependents (the evidence report, [§ Evidence report](#evidence-report-issue-71)) | #71 |
| Water-use allocations, second slice | #72 |
| Applicants, scenarios and firm yield | #73 |
| Farmer view and alerts | #74 |
| CI, tooling and dependency hygiene | #75 |
| UI consistency and help text | #76 |

## Blocking releases (operator)

The checklist for these is issue #62; the history scrub is #63.

- [ ] **GitHub variables for the background Lambdas (2026-09-25).** The
      backend release preflight (`deploy-backend.yml`, `REQUIRED_CONFIG`)
      refuses every `backend@` release until these repository variables
      exist: `WORKER_FUNCTION_NAME` (job queue, #10 part 1),
      `FETCHER_FUNCTION_NAME` (data feeds, #10 part 2),
      `RENDERER_FUNCTION_NAME` and `RENDERER_ECR_REPOSITORY` (server-side
      PDFs, #26). They are Terraform outputs (`infra/outputs.tf`), so after
      the AWS bootstrap below, re-run
      `~/github/templates/scripts/export-tf-vars.sh infra/` and check all four
      appear under the repo's Settings → Variables.
- [x] **`production` environment branch/tag policy and the release-tag
      ruleset (#126, 2026-09-29).** The release preflight now refuses every
      release until the `production` environment deploys only from `main`
      and the `backend@*`/`web@*` tags, and an active tag ruleset stops those
      tags being created (except by an admin), moved or deleted. Run the
      one-line `gh api` commands in deployment.md § The production
      environment's branch and tag policy (steps 1–3), then its step 4 check.
      — *Done 2026-09-29: steps 1–3 applied, step 4 shows the three policies
      (`main`, `backend@*`, `web@*`) and the "Release tags" ruleset active.*
- [ ] **Propose the branch/tag policy for the templates repo (#126).** The
      templates repo's `backfill-prod-environment.sh` sets only the
      reviewer; propose deployment.md's steps 1–3 for its `base` branch so
      every estate repo gets them.
- [ ] **Renderer Lambda needs a two-step first deploy (#26, closed; now #62).** Lambda can't be
      created before its image is in ECR: apply without it, cut the first
      `backend@X.Y.Z` release (which builds and pushes
      `backend/renderer.Dockerfile`), then set `renderer_image_tag` to the
      tag it printed (`<version>-<sha12>`) and apply again. The image has never been built or run on
      Lambda; smoke-test one render in production and check its alarms
      (details under § Server-side reports).
- [ ] **Raise the Lambda concurrent-executions quota before the first apply
      (2026-09-28, infra audit).** A new account's quota is 10 and AWS keeps
      10 unreserved, so every reserved concurrency fails to apply until it is
      raised, and `-1` (unreserved) is now refused by the variables'
      validation. In af-south-1 request at least the sum of the reservations
      + 10 (33 at the defaults; ask for 1000) and wait for the grant:
      infra/README.md § Operator steps, step 3. Then run
      `infra/scripts/preapply-check.sh` (step 7a: the quota, the us-east-1
      state bucket and sops key, the SES endpoint service, the RDS class,
      the CloudTrail trail the KMS key alarm needs) and
      plan only once it passes.
- [ ] **After the first apply and first release, run
      `infra/scripts/postapply-check.sh` (#126, 2026-09-29)** and clear
      every FAIL: unconfirmed alert subscriptions, the RDS event
      subscription, the ECR policy, the site's 404s and bucket listing, the
      Function URL's 403 (infra/README.md § Operator steps, step 8). At the
      first deploy, before client data, prove RDS events reach the alerts
      topic with the reboot and `--rds-event-test` (step 10c): the topic
      policy's `aws:SourceArn` condition can't be proven by a plan.
- [ ] **Confirm the database's KMS key before the first apply (#126,
      2026-09-29).** `rds_customer_managed_key` defaults to `true`: a
      customer-managed key (`infra/kms.tf`) that keeps cross-account snapshot
      sharing and AWS Backup cross-account copies possible, for $1–3 a month.
      Keep it, or set `false` for the AWS-managed `aws/rds` key, in
      `terraform.tfvars`. It can't be changed once the instance exists
      (deployment.md § Decide before the first apply). Disabling the key,
      scheduling its deletion, changing its policy or revoking a grant
      alarms (`kms.tf`), but only through CloudTrail: **make sure a trail
      logging write management events (KMS not excluded) covers the region
      before the first apply**, preferably the Organization trail from the
      management account; `preapply-check.sh`'s `cloudtrail` check FAILs
      until one does (infra/README.md § Operator steps, step 7a).
- [ ] **SES production access.** Report links (#26), invites and password
      resets reach only verified addresses while SES is in the sandbox.
      Request production access in the chosen region before any client uses
      email.
- [ ] **AWS budget default is now $90** (`infra/variables.tf`
      `budget_monthly_usd`; was $60, then $80, #126), sized for af-south-1's ~$59–64
      idle with the database's KMS key, plus a derived $7/day budget (deployment.md § Budget alerts).
      Set ~60 in tfvars for us-east-1. Cost Anomaly Detection is off by
      default so the first apply can't fail on an existing monitor: turn it
      on after the first apply (infra/README.md § Operator steps, step 11).
- [ ] **Data-feed terms** (operator, roadmap D7): DWS's terms for automated
      fetching and whether the fetcher's region can reach the site (it
      answered our network with HTTP 403, so the DWS parser is untested
      against the live page); CHIRPS-GEFS's licence before client use
      (details under § Features left half-way).

- [x] **Disclaimer and sign-off wording (WP-3.13, decision D10; issue #47).**
      Agreed 2026-09-28: the operator accepted revised wording, as operator,
      after three pre-counsel reviews (disclaimer, sign-off, farmer lines);
      no external legal adviser reviewed it. `DISCLAIMER` is version
      `2026-09-28`, status `agreed`; the sign-off statement is `signoff-2`
      (ten confirmations); farmer and alert-email lines name DWS beside the
      WUA, and each alert kind carries its own line. The record is
      [legal/disclaimer-review.md](./legal/disclaimer-review.md) (what
      changed, why, and § 6: what stays open for a lawyer, tracked in
      [legal-status.md](./legal-status.md) under Counsel review; the go-live
      gates and pre-fee items are issue #103; its known-defect procedure is
      built, 2026-10-01:
      [legal/known-defect-procedure.md](./legal/known-defect-procedure.md),
      awaiting counsel review with the rest).

- [x] **Client data in git history (#63).** Decided 2026-09-28: the public
      repo starts from one commit of the cleaned tree, and the full history
      stays in the private `project-water-management-old`, because rewriting
      reworded prose across every past commit can't be shown complete. Done:
      the tree was swept for client values, dates, counts, site
      descriptions, the second configuration and workbook names (three
      independent audits against the client data, the last with no high or
      medium findings), the value list joined the terms list in
      `infra-secrets/water-management/` (so `pnpm check:terms` guards it),
      and the issues that quote client data are re-filed clean at their own
      numbers, the originals archived there. Published 2026-09-28: the old
      repo is the private `-old`, the new one holds that single commit and
      issues #1–77 on their old numbers, and `pnpm check:terms` passes on
      its tree and history (checked from a fresh mirror clone).

- [ ] **GitHub plan.** The repo is private on a free plan, so:
      - required reviewers and branch protection aren't available, which means
        the release preflight refuses every release;
      - CodeQL and Scorecard fail on every push;
      - since 2026-09-25, no Actions job starts at all ("recent account
        payments have failed or your spending limit needs to be increased"),
        so CI, the e2e shards and the Dependabot workflows are all dark. Fix
        the payment or spending limit under Billing & plans first, then
        confirm the next push to `main` goes green (nothing since then has
        had a CI run; #20, #60 and #61 were merged on local checks only).

      Make the repo public (after the history scrub above) or upgrade the plan. Then
      make `CI gate` a required check.
- [x] **Client names (WP-1.7).** The tree and the history are scrubbed
      (2026-09, `git filter-repo --replace-text`). The repo was then
      recreated from the clean history, because GitHub keeps old commits
      under PR refs: the previous repo is now the private
      `project-water-management-old` (it still holds the old history and
      issues; delete it once nothing is needed from it). The calibration and
      rainfall issues are re-filed without the names as #1 and #2 (originals
      archived in `infra-secrets/water-management/`).
- [x] **`production` environment:** run
      `templates/scripts/backfill-prod-environment.sh --apply`, with the
      operator as required reviewer. — *Done: `Absence0760` is the required
      reviewer (checked 2026-09-29).*
- [ ] **AWS bootstrap:** follow `infra/README.md` steps 1–9a, then
      `export-tf-vars.sh`. Pick the region; the recommendation is af-south-1
      for everything, SES included ([deployment.md § Region
      recommendation](./deployment.md)). If that's the choice, raise
      `budget_monthly_usd` to about 90 and set `dmarc_report_email`.

## DB tests share the mail outbox (2026-10-02, PR #360)

- [x] **Guard pending notices as db-setup.ts guards pending jobs.** The
      tick sends every pending `pack_notice` (133), `erratum_notice` (153)
      and `alert_delivery` (051) in the shared test database, so a notice
      one DB test file left behind landed in the next file that ticked
      (alerts.db.test.ts got a "pack withdrawn" mail from
      write-routes.db.test.ts, CI run 37010696949). Done (fix/r4-sec-access):
      `pendingJobs.ts assertNothingPending` (db-setup.ts) now fails a file
      that leaves a pending, sending or digest-waiting notice of any kind
      and settles it; `helpers.ts settlePendingNotices` settles all three
      queues. A run of every DB file that touches packs, alerts, errata,
      ticks or sweeps (76 files) found two more leakers, now fixed:
      pack-share.db.test.ts (two pack notices) and alerts.db.test.ts (a
      digest-waiting delivery from the daily-cap test).

## Two-step sign-in (issue #282)

Built 2026-10-01: TOTP (RFC 6238) with ten recovery codes, the two-step
sign-in, `amr` in the session, and the requirement for project owners, team
admins and assessors at the route (security.md § Two-step sign-in). Open:

- [x] **No app-wide prompt yet** (done 2026-10-01). A banner on the
      workspace (`layout/MfaBanner.svelte`, from `GET /auth/mfa`
      `required && !enrolled`, and from any `403 mfa_required`) links to the
      Account page's panel; a password-only session of a role that needs it,
      or any `403 mfa_step_up`, gets **Sign in again** (security.md §
      Two-step sign-in, § The prompt). `required` now reads false while
      `MFA_REQUIRED=false`.
- [ ] **The requirement is checked at the route, not in RLS.** Every owner
      route goes through `requireRole(…, 'owner')`, so a new one is covered
      without a decision, but a route that checks the owner role some other
      way would not be. Durable fix: step-4 WP-4.2's `app.auth_mfa`
      transaction setting, with the owner-level policies refusing without it.
      Trigger: organisations (WP-4.1), when the session context is rebuilt.
- [x] **Signing a run or a pack doesn’t require it** (below,
      "Two-step sign-in on sign-off"). **Done** (operator decision,
      2026-10-01): every signer needs it.
- [x] **The two-step sign-in banner can be dismissed** (from #282). Like the
      confirm-email banner, it hides until the next refused action or
      sign-in. **Decided (operator, 2026-10-01): keep it dismissable**,
      since every refused action brings it back (security.md § Two-step
      sign-in, The prompt). No change.
- [ ] **A native speaker's review of the Afrikaans** for "tweestap-intekening",
      "verifikasie-app" and "herstelkode" (§ Afrikaans).

## Hydrologist

Every engine decision marked "pending the hydrologist" in model.md is
collected as a checklist in issue #46; tick it there as they answer.

**Provisional decisions 2026-10-01.** Issue #90's calibration, data-quality,
EWR, planning and help-text questions (modelled area to D10) were answered
from the literature, provisionally, so the app can be called
production-ready: one row per question, with its source, in
[calibration-research.md § Provisional decisions](./calibration-research.md#provisional-decisions-on-the-hydrologists-questions-2026-10-01). They are **not** the hydrologist's sign-off; each item below
stays open until they confirm it. Two change the engine (1.62.0):
validation benchmarks from the calibration period (CR-5, engine-audit C4)
and zero-flow stretches scored (QF-3, C3). Rows marked "needs client data"
(the modelled area, QF-4's ratings, which Reserve table, which zero-rain
runs and accumulations are real) can't be decided without the client.

- [ ] **Network, supply, crops and dams: provisional decisions 2026-10-01**
      (issue #90, the hydrologist list from *Supply order at a dam* to
      *WP-1.35 Land-cover split*). Each item was researched against published
      South African practice and decided **provisionally, to be confirmed by
      the client's hydrologist**; the record, one row per item with its
      source, is [engine-audit.md § Provisional decisions
      2026-10-01](./engine-audit.md#provisional-decisions-2026-10-01-network-supply-crops-and-dams),
      and model.md marks each section. Built where the evidence clearly
      pointed elsewhere (engine 1.63.0): an unknown dam area is 7.2 · C^0.77
      m² (Maaren & Moolman 1985, via Sawunyama 2013) instead of capacity ÷
      3 m, whose source was never found; a save takes a dam area exponent
      0 < b ≤ 1; the sediment warning asks for a dam's in-service date; and
      both importers flag a near-empty placeholder pool (Q18). Everything
      else was kept. **Still the client's data**, each surfaced in the app:
      which dams keep a reserve (form hint), Q18 pools (import warning), Q19
      upstream-to-dam % per farm (run warning on a dam-less farm), which
      units are run of river and their pump capacities (import flag, run
      warning, evidence-pack gate), each senior user's population (for the
      NWA basic-needs exemption), each property's GN 538 rate (run warning),
      municipal return shares (treatment works records), soils and root
      depths (the 25 mm store), the A-pan row's pan type (before a WR90
      preset or the SABI crop set is applied), sediment rates and surveys,
      borehole d and k and whether they pumped during the calibration
      record, and land-cover classes and areas. Trigger: the hydrologist's
      answers on #90; a reversal becomes a new engine version with its
      engine-audit.md entry.

- [ ] **River abstractions beside a dam (engine 1.65.0, issue #344):**
      confirm the decisions of [model.md §2.7j](./model.md) (open question R2
      in engine-audit.md): the abstractions take after the dam side from the
      flow passing the dam (its spill too), keep the unit's hands-off flow,
      share the river by the demand objects' supply order, and a pool (issue
      #90 Q18) starts full, refills only from the flow above what must pass
      and gains no rain. Trigger: the hydrologist's answer on #90; a change
      is a new engine version.

- [x] **Calibration record:** the gauge vs the logger over their overlap,
      [#1](https://github.com/Absence0760/project-water-management/issues/1)
      (closed 2026-09-25). Decided: the logger is the calibration and
      validation target, and the gauge column (not a suitable calibration
      record; private source repo) is a regional wet/dry index only
      ([model.md §2.10](./model.md), [plan.md § Questions](./plan.md#model-and-hydrology-for-the-hydrologist)).
      The hydrologist's agreement was assumed by the operator, not given in
      writing; reopen #1 if they disagree. Plan items 1–3 (no silent default
      pick, a neutral agreement warning, the findings in model.md) landed
      earlier. Still open, and separate: the rating, area and fit-limitation
      questions (plan.md questions 2–4), and the runoff-ratio check, which
      needs the client workbook back in
      `../project-water-management-source/Original/`.
- [ ] **Validation signature thresholds and parameters to confirm**
      (engine 1.55.0, CR-16, [model.md §2.10d](./model.md), *Validation
      signatures*). Built on these engineering defaults; put each as
      "confirm or change": the Hughes et al. (2003) filter at α 0.995,
      β 0.5 and one forward pass (or three, as §2.9d's Lyne–Hollick); the
      Eckhardt (2005) filter's a 0.98 (or a from the record's recessions,
      Eckhardt 2008) and BFImax 0.25 (hard-rock perennial; 0.50 or 0.80
      elsewhere); the provisional warning limits: the simulated BFI more
      than 0.15 from the observed by either filter, the low-flow FDC's slope
      bias or %BiasFLV beyond ±50 % (the slope bias only where both curves
      flow above 0.001 m³/s at Q95), and a held-out recession skill below 0
      with 8 or more segments ("not judged" with fewer); the Q70–Q95 slope
      segment; holding out every third segment; and keeping the quality-flagged days in the BFI and FDC (the
      recession segments leave them out). The thresholds are the engine's
      constants (`BFI_WARN_DIFF`, `FDC_LOW_WARN_PCT`, `HOLDOUT_SKILL_WARN`,
      `RECESSION_MIN_SEGMENTS` in `plausibility/signatures.ts` and
      `recession/check.ts`); the Runs panel reads them through
      `PROVISIONAL_SIGNATURE_LIMITS`, so the answer changes one place, and
      a change to a warning bumps `ENGINE_VERSION`.
- [ ] **Demand sources to confirm** (engine 1.56.0, issue #54 Q11,
      [model.md §2.7f](./model.md) "The source"). Built on these readings of
      the client's rule; put each as "confirm or change": a per-head norm
      for livestock counts as `perCapita` (the rule names people only); a
      meter record and an AADD are always given as m³/day by month (never a
      count × a metered litres per head); a new object stays "not recorded"
      even when it starts at a category's norm (Red Book 230 l, 45 l per head
      of cattle), until the modeller picks its source; and the workbook
      importers record a typed-over demand as `other`, not as an AADD even
      where the workbook's number came from one.
- [ ] **Flow gap filling defaults to confirm** (engine 1.23.0, issue #66,
      [model.md §2.10i](./model.md)). Built off by default on these
      engineering defaults; put each to the hydrologist as "confirm or
      change": the 5-day interpolation limit (seasonal?); one whole-record
      donor ratio (or per month / per flow class); the donor refusal
      thresholds (r < 0.5, fewer than 365 shared days); clamping a donor day
      to the record's own maximum (or the weir's rated maximum); and never
      scoring filled days by default (`qualityFlags.infilled` 'exclude').
      The hand-off to CR-18/19 is done: the flags read the fill's code as
      *infilled*, and the quality flags' infilled treatment replaced the
      branch's own `useFilledDays` switch (never deployed).
      **Provisional decision 2026-10-01 (to be confirmed by the client's hydrologist):** keep every default as built ([calibration-research.md § Provisional decisions](./calibration-research.md#provisional-decisions-on-the-hydrologists-questions-2026-10-01)).
- [ ] **A full allocation and the basic-needs floor** ([engine-audit W1](./engine-audit.md),
      engine 1.44.0, issue #123; to put to the hydrologist through #90).
      A restriction what-if holds a domestic or municipal object's floor
      (25 l a person a day), on a full-allocation run too, but a full
      allocation alone rescales the object, floor included, to the unit's
      registered volume (0 in a year with nothing registered), and the
      results then never show it below basic needs. Domestic use and basic
      human needs aren't licensed uses. Decide: (a) hold the floor after the
      allocation factor on every day, or (b) keep the rescale and report the
      floor from the demand before it, so those days show as below basic
      needs. Either is a change to `allocations/mode.ts` `planAllocations`
      or the floor reporting, an `ENGINE_VERSION` bump, and W1 closed.
- [ ] **Drought restrictions (WP-3.8) to confirm** (engine 1.54.0,
      [model.md §2.7i](./model.md); to put to the hydrologist through #90 /
      #46). Built off by default on these choices; confirm or change each:
      one rule per project on the **total farm dam storage** by default (every
      farm dam, Σ storage ÷ Σ capacity, the review triggers' basis; some dams
      or each unit's own dam are options); the level **decided on review dates and held** until
      the next review or lift date (no daily re-evaluation or hysteresis);
      the storage read at the **start of the review day**; a fresh run's
      **first day decided** from its starting storage when the latest date
      before it is a review; **every unit's demand** cut, the other water
      users not; the demand kept as the demand, so a cut **counts as a
      shortfall** in the assurance of supply; the **outlook, its triggers
      and firm yield run without the rule**; the Settings template's
      levels (60 / 40 / 25 % of capacity; irrigation 20 / 40 / 60 %,
      domestic and municipal 10 / 20 / 30 %) as a starting point only.
      From engine 1.54.0 also: under the **own-dam basis** a unit without a
      dam isn't restricted by storage (only by the EWR trigger); the **EWR
      trigger** reads the site's pragmatic EWR shortfall on the **day
      before** a review only (not a count of recent days, not the Reserve
      rule tables' monthly compliance) and raises the level to at least its
      own; a rule **from the published notice** is one level in force below
      100 % from the publication date to the next expected one.
- [ ] **Drought restrictions on the other water users: decide whether and
      how** (engine 1.54.0, [model.md §2.7i](./model.md)). The rule cuts
      only hydrological units: an other water user's demand has no category
      and no population, so a cut on it could take a town below basic needs
      with nothing to stop it. Options, for the hydrologist and the client:
      (a) leave users uncut (today; a municipal abstractor's own restriction
      stages are outside the model); (b) give user nodes a restriction
      category (domestic / municipal / industrial / other) and a population,
      then cut them by their category's share with the 25 l floor, as a
      demand object is; (c) model towns and industry as demand objects on a
      unit instead of user nodes, so the rule, the categories and the floor
      already apply; (d) one % cut for every user with no floor, marked as
      unprotected. Trigger: a catchment where a municipal abstractor sits on
      the river as an other water user and is restricted in practice.
- [ ] **A pump capacity on other water users (WP-3.8) to confirm** (engine
      1.58.0, [model.md §2.7c](./model.md); to put to the hydrologist through
      #90 / #46). Built off by default (null = no limit) on these choices;
      confirm or change each: the capacity caps only the **river take**, not
      the user's boreholes; a **senior user's claim** on the farms upstream
      is MIN(demand, capacity), so they pass no more than its pump can lift
      (the alternative, passing the whole demand, leaves water flowing past
      a pump that can't take it); **no capacity is silent** (a farm's
      river-pumping rule without one warns; a user never had one), though
      an evidence pack isn't issued on a user with demand and no capacity
      (`evidence-10`); and the
      reported **pump-limited** demand counts only what the river had within
      the user's priority and allocation room, so a day the farms upstream
      passed only the capped claim shows 0. Trigger: the client's pump
      capacities for its municipal and industrial abstractors (issue #54 Q1),
      or the hydrologist's answer.
- [ ] **Which dam evaporation preset for the client's catchment** (engine
      1.49.0, [model.md §2.7a](./model.md) item 4). Built without changing
      the default (one flat 0.75 × A-pan): Settings → Demand → **Dam
      evaporation preset** fills the monthly factors from flat 0.75, or from
      the WR90 monthly lake factors (0.81–0.88 × S-pan, Midgley et al. 1994)
      converted to A-pan at the project's own monthly A-pan with WR90's
      monthly S-pan ← A-pan equation or Taljaard's (2023). With a Western
      Cape-like A-pan these give about 0.52–0.73 × A-pan through the year,
      0.66–0.68 over it, below the flat 0.75. Put to the hydrologist: keep
      flat 0.75, or which WR90 conversion (WR90's 1994 regression or
      Taljaard's refit on ten stations); whether the 55.4 / 38.5 mm A-pan
      floor below which a WR90 fill is refused is right; whether WR90's large-reservoir lag
      suits small farm dams; and whether a site study or the quaternary's
      WR2012 evaporation zone should replace the national monthly factors.
      Once chosen, fill it on the client project (it is a project setting,
      not a default). **Provisional decision 2026-10-01** (issue #90, to be
      confirmed by the client's hydrologist): keep flat 0.75 as the default
      and fill no preset yet; WR90 lake factors with Taljaard's conversion
      once the client's A-pan row is confirmed to be A-pan, not S-pan.
- [ ] **Human impacts (WP-1.33–1.35) to confirm** ([model.md §2.7c](./model.md)).
      Built 2026-09-25, off by default, on the engineering decisions below,
      not client sign-off. Put each to the hydrologist as "confirm or change":
      - WP-1.33 other water users (engine 0.22.0): are there towns, industry
        or unlisted irrigators upstream of the logger, and what do they take
        (monthly m³/day) and return? Priority: a senior user's demand is
        passed down by the farms upstream (fragmented by flow share like the
        EWR; farms divert less, then pass inflow below the dam), and it is
        **not curtailed** for the EWR (its charge stands, not moved onto
        farms); a junior user takes what reaches it and is curtailed like a
        farm. Confirm both rules and which priority each user has. Known
        limit: a farm never releases stored water for a senior user, and
        development (users, their demand) can't vary within a run.
      - WP-1.34 boreholes (engine 0.23.0): do boreholes matter in the client
        catchment, and is there any data on pumping volumes, distances from
        the river or aquifer tests? Confirm the method (a lagged linear
        reservoir with capture share d and time constant k, not a Glover/Hunt
        kernel) and the values. If the calibration record was measured while they
        pumped, calibrate with them in the model (model.md §2.7d).
        **Changed in engine 1.10.0, pending the hydrologist's confirmation:**
        depletion the river can't give was dropped; it is now carried over as
        a deficit, taken off the first flow back and never written off
        (bounded by the depletion generated; the run warns with what is still
        owed at its end). Drafted from the hydrologist persona's review of
        this issue (item 15), not the real hydrologist: confirm it, or say
        whether to cap the carry-over (the review's option: d × the water
        year's pumping).
      - WP-3.9 individual boreholes (engine 0.36.0): confirm the supply order
        (primary direct, then dam-target, then the dam and river, then
        supplemental, then emergency), what a dam-target borehole does in each
        mode (primary keeps the dam topped up; supplemental adds today's
        shortfall and first lifts a dam below dead storage; emergency refills
        a low dam; primary and emergency only on a day the dam is drawn for
        demand, engine 1.8.0, since pumping into it with nothing to irrigate
        took the room winter inflow needed and spilled; model.md §2.7d), and
        whether a farm needs a fill-to level or pumping season per borehole
        instead, and that annual caps reset on 1 October. **Built as a draft
        (engine 1.12.0, issue #46 item 7):** each property's own GN 538 volume
        (area × the Table 2 rate the modeller enters, at most 40 000 m³/a),
        the most pumped in any 12 months, and warnings for an unknown volume
        and a depletion share ≥ 80 % (model.md §2.7d). Confirm with the
        hydrologist: the 80 % alluvial threshold, whether to ship the
        gazette's quaternary → rate schedule as data (not done: the scanned
        table's column layout can't be verified row by row), and one property
        per node. Trigger: the first licence application with boreholes. Also: one depletion lag
        per node is shared by its boreholes; per-borehole lags if a
        geohydrology report gives different response times.
      - **Provisional decision 2026-10-01** (issue #90, to be confirmed by
        the client's hydrologist) on WP-1.34 and WP-1.35: the lagged
        reservoir and the deficit carry-over, the GN 538 volume rule and the
        Q75 daily split are kept; the values, areas and classes are client
        data (engine-audit.md § Provisional decisions 2026-10-01).
      - WP-1.35 land cover (engine 0.24.0): which covers matter in the client
        catchment (invasives, plantations, riparian stands) and their
        condensed areas? The class reductions are indicative mature-stand
        values (model.md §2.5a); confirm them, or supply the Scott & Smith /
        Gush curves by age and site the CMA uses. Confirm the daily split
        (low-flow share on each day's flow up to the Q75 natural flow, the
        other share above it) and whether orchards and vineyards need a class.
- [ ] **A resized dam follows its own area–volume relation** (engine 1.10.0,
      [model.md §2.13](./model.md)). Built, pending the hydrologist's
      confirmation: drafted from the hydrologist persona's review of issue
      #46 (item 11). The storage–yield curve and a scenario's dam-capacity op
      take A_full × (C_new / C)^b (a survey curve cut or extrapolated) instead
      of scaling the area with capacity; doubling a 3 m-deep 100 000 m³ dam
      gives 54 150 m², not 66 667. Confirm, and say whether the larger side
      should wait for a surveyed curve ("A resized dam's shape" under Yield).
      Also for them: the default exponent is 0.7 (Liebe et al. 2005), while
      WR2012 (TT 690/16 §2.2) gives 0.6 as the South African average, and an
      unknown dam's area could follow A = 7.2 · C^0.77 m² (Sawunyama 2013)
      instead of capacity ÷ 3 m. Both change every such dam's evaporation,
      so both wait on the hydrologist (model.md §2.7a). **Provisional
      decision 2026-10-01** (issue #90, to be confirmed by the client's
      hydrologist): the resize rule and the 0.7 exponent kept; the unknown
      area changed to 7.2 · C^0.77 (Maaren & Moolman 1985) in engine 1.63.0,
      since the 3 m depth's source was never found.
- [ ] **Engine audit decisions to confirm** ([engine-audit.md](./engine-audit.md)).
      Implemented 2026-09-24 on simulated hydrologist and CMA-assessor
      recommendations (reports in gitignored `reviews/persona-*-audit-decisions.md`),
      **not** client sign-off. Put each to the hydrologist as "confirm or change":
      - H1: closed. Engine 1.0.0 removed the legacy model (2026-09-26,
        issue #16); GR4J is the only runoff model, and the operator waived
        the review that was to come first. Nothing left to confirm.
      - N3 (engine 0.14.0): a 25 mm soil-water store carries effective rain
        over; 0 reproduces the workbook. Confirm the size per soil/root depth.
      - Q5 (0.16.0): `damMinPct` is the dam's minimum operating level;
        existing values were reset to 0 (they were the workbook's transfer
        minimum).
      - N1 (0.16.0): irrigation efficiency e and losses returning β replace
        return flow %; backfilled so a crop is now fully supplied (r > 0 →
        e = 1 − r, β = 1). Ask whether the client's crop factors already
        include losses (then scale them by 1 − r to keep today's numbers).
      - N2 (0.16.0): dam evaporation (lake factor 0.75 × A-pan), rain on the
        dam and seepage; unknown areas use capacity ÷ 3 m (warning W6).
        Needs each dam's area when full, and confirming the "Mantel & Hughes
        2023" 3 m median depth reference (not verified). Rain on a dam is
        partly double-counted with land runoff. **Provisional decision
        2026-10-01** (issue #90): the reference was never found, so engine
        1.63.0 estimates an unknown area as 7.2 · C^0.77 m² (Maaren &
        Moolman 1985); N1, N3, N4/Q3/Q18 and Q5 are provisionally kept
        (engine-audit.md § Provisional decisions 2026-10-01).
      - N4/Q3/Q18 (0.16.0): transfers capped at the receiver's room; an
        explicit priority, with equal priorities sharing pro rata.
      - Q17/Q13/Q11 (0.17.0): EWR shortfall charged to upstream farms pro
        rata to net impact at the outlet and every gauge (the rest reported
        as natural), split into irrigation and storage parts; the old AB is
        kept as "reach shortfall"; zero-demand farms get no irrigation cut;
        "Demand left %" bounded, "—" under 1 m³/day; equitable share labelled
        a fairness benchmark, not an allocation.
- [x] **Attribution follow-ons (Q17): the site flag and the site list**
      (engine 1.5.0, migration 086, issue #64). A gauge has an "EWR site"
      flag (`ewrSite`, default true, so every existing project runs as
      before): unticked, it charges nobody and a Reserve rule table there is
      skipped; the outlet is always a site and only a gauge can be unticked
      (model rules, the API and scenarios). It is on the one-node form, a
      gauge's `node.set` field in a scenario (always a baseline
      assumption), and run comparison's *What changed* lists the EWR site
      list changing ([model.md §2.7b](./model.md), [run-comparison.md](./run-comparison.md)).
- [x] **The per-run attribution self-check is exact at every site**
      (Q17, engine ≥ 1.6.0). A run stores each transfer rule's daily volume
      (`transfer_rule@<rule id>` on its source farm, for every rule that can
      move water, `network/transferSeries.ts`), so the self-check recomputes
      `J_int` and every site exactly, a site a transfer crosses included
      (checked with a perturbed charge there, `transferSeries.test.ts`), and
      the farm projection's recompute is exact on a transfer loop without
      `bindingApproximate`. Runs from before 1.6.0 keep the fallback (exact
      only where no transfer crosses a site; the loop cut). About 1 % more
      series before compression on the examples with transfers
      ([model.md §2.7b](./model.md)).
- [ ] **Issue #46 persona drafts: built; the rest waits on the hydrologist** (2026-09-27).
      Two simulated reviewers (hydrologist, licence assessor) drafted "confirm or
      change" answers to every #46 item (issue comments; reasoning and the
      follow-up primary-source research in the gitignored
      `reviews/persona-*-issue46*.md`). Three were defects, fixed: dam-target
      boreholes pump only on a day the dam is drawn for demand (engine 1.8.0);
      a freshet is a flood hydrograph, not days held at the peak (1.9.0); and
      groundwater pumped into a dam is netted out of surface use in the
      allocation comparison (no bump). Built as drafts, none changing a
      default: an enlarged dam resized along its own area–volume relation and
      unmet borehole depletion carried as a deficit (1.10.0); the natural-MAR
      warning, assurance over complete water years, the lowest trigger band
      from the lowest storage on record, and the freshet peak labelled
      daily-mean with a warning when natural flow rarely reaches it (1.11.0);
      the GN 538 volume per property with a 12-month check, and flow
      flat-lines by the record's resolution (1.12.0, migration 089).
      Waiting on the real hydrologist, because they change defaults or rest on
      judgement no published standard settles: `ewrChargeSource` →
      `ruleTable` and `lowFlowMeasure` → `baseflow`; the base-flow filter's
      three passes (the Desktop Reserve method used one, Hughes et al. 2003);
      τ 0.2; outcome cut-offs 0.95 / 0.85 and the 5 % / 20 % days; the 0.9
      annual assurance threshold; senior users exempt only for basic human
      needs, with an optional restriction % (provisionally 2026-10-01: the
      NWA basic-needs reading adopted as the target, applied once each senior
      user's population is known); the dam area exponent 0.6
      (WR2012) instead of 0.7 and the fallback area 7.2·C^0.77 (Sawunyama
      2013) instead of capacity ÷ 3 m (provisionally 2026-10-01: 0.7 kept,
      the fallback changed in engine 1.63.0); which dam evaporation preset (the
      WR90 monthly presets are built, engine 1.49.0, but 0.75 × A-pan, the
      top of SA practice, stays the default; see "Which dam evaporation
      preset" above); plantation classes by
      short/long-lag curve with rotation-average values; rain accumulations
      (tagged ones missing, auto-spread only up to 10 days); the ±15 %
      natural-MAR tolerance. Still to build, not a judgement: a scenario op
      for a dam's surveyed curve (§ Yield) and GN 538's quaternary → rate
      schedule as data (Appendix B is a scan; the rate is an input today).
      **Provisional decision 2026-10-01 (to be confirmed by the client's hydrologist):** for the items in this pass (`ewrChargeSource`, `lowFlowMeasure`, the filter's passes, τ, the outcome cut-offs and the 5 % / 20 % days, the ±15 % natural-MAR tolerance) keep the built defaults; the pass count is the first thing to check if base flow is switched on ([calibration-research.md § Provisional decisions](./calibration-research.md#provisional-decisions-on-the-hydrologists-questions-2026-10-01)).
- [x] **Client regression suite is thinner since N1** (fixed 2026-09-28,
      issue #68). The suite now compares the N1 columns against an **N1
      replay**: each farm with e < 1 runs with a demand factor of e, so it
      abstracts the workbook's F and returns r·G (β = 1), and the network
      downstream is the workbook's again (engine-audit.md § regression suite,
      N1). That restored about half the network comparisons N1 had skipped on
      the client catchment. The rest are N4: the one transfer's destination is
      near full, so the room cap moves less than the workbook's rule does, and
      no input can replay a transfer's volume. Both ends and anything below
      only one end stay skipped; below the join, outflow and inflow are
      compared again and only the day-dependent columns are skipped. Also
      found on the way: the suites read `data/client-catchment` only, while
      `pnpm seed:demo` writes `data/client-<name>-app/`, so on a machine set
      up by the seed they skipped. `WBT_CLIENT_CATCHMENT_DIR` now points them
      at an extract (run-locally.md).
- [x] **Validation scores are saved with a run** (issue #4). Apply stores the
      fit record (seed, objective, window, exclusions, the in-sample and
      validation scores) with the parameters, each run snapshots it, and the
      Runs page and run comparison show the validation scores beside the
      in-sample ones (model.md §2.10b). Calibration exclusions are stored too,
      and `runModel` passes them to the EWR agreement (model.md §2.9b).
- [x] **Data-quality limits:** outliers are 5× the 99th percentile for rain and
      10× for flow; flat-lines are 5 days for rain and, for flow, 14 to 90 days
      by the record's resolution and the flow (engine 1.12.0, a draft pending
      the hydrologist; model.md §2.10a). The
      catchment-rain checks (issue #2) flag a zero run with 60+ days in the
      series' six wettest months (180+ days without two years of data) and a
      water year below 50 % of the record's usual catchment / CHIRPS share.
      Are these right for these catchments? They're fixed in code
      ([model.md §2.10a](./model.md#210a-data-quality-do-the-observed-flow-records-agree));
      make them settings if the hydrologist wants to tune them.
      A simulated hydrologist review (2026-09-24; see "Issue #4 Phase 6"
      below) recommends:
      1. Make two limits editable in `settings.dataQuality`: the minimum
         wet-season zero-rain days and the CHIRPS ratio cutoff. Keep the
         sample-size floors as constants.
      2. **Check zero runs against CHIRPS:** if CHIRPS recorded at least half
         its usual rain over the run, call it "probably missing data";
         otherwise, "a long dry spell that may be real". This fixes the false
         alarms that fixed day-counts would raise in the semi-arid Karoo and
         Northern Cape.
      3. Judge a zero run by the rain the climatology would have put on those
         days (flag it at 25 % or more of mean annual rain, with 60 days as a
         secondary floor), not by how many days it lasted.
      4. Compare each year with a moving median of about ±5 years instead of
         one record-wide median, because the catchment/CHIRPS ratio drifts
         over decades.
      5. Scale the CHIRPS minimum: the larger of 50 mm and 25 % of median
         annual CHIRPS.

      Test the semi-arid defaults on a semi-arid gauge record with a known
      drought (e.g. 2015–19) before changing them. Do this after the CHIRPS
      fallback bias correction lands, because it uses these flags. Once
      CR-20 lands (below) a flagged zero run changes results, not just
      warnings, so a false alarm is no longer free: item 2 matters more.

      **Done (engine 1.20.0, issue #66):** the limits are
      `settings.dataQuality` (Settings → Data quality): the outlier factors,
      the flat-line lengths (rain, A-pan, the flow floor and cap), the
      minimum wet-season zero-rain days (1) and the low-vs-CHIRPS ratio
      cutoff (1), defaults unchanged; the sample-size floors stay constants.
      Recommendations 2–5 are built as settings, **off by default**:
      `zeroRunChirpsCheck` (2), `zeroRunRule: 'usualRain'` with
      `zeroRunUsualShare` 25 % and `zeroRunMinDays` 60 (3),
      `lowVsChirpsBaseline: 'moving'` (±5 years) (4) and
      `lowVsChirpsMinimum: 'scaled'` (5). Every rain consumer (zero-run mask,
      CHIRPS and rain-source factor fits, double mass, the Data tab) reads
      them, and a fit records them (`forcing.rainChecks`)
      ([model.md §2.10a](./model.md#210a-data-quality-do-the-observed-flow-records-agree)).
- [ ] **Data-quality alternatives as defaults.** The four alternatives above
      stay off until they are run on a semi-arid gauge record with a known
      drought (e.g. 2015–19; none is in the repo) and the hydrologist agrees.
      Trigger: such a record, or the hydrologist's answer. Then decide per
      alternative whether it becomes the default; a default change bumps
      ENGINE_VERSION with an engine-audit.md entry and the regression
      deviation list. Also for the hydrologist: the CHIRPS share that clears
      a zero run (50 %, `ZERO_RUN_CHIRPS_SHARE`) and the coverage it needs
      (50 % of the run's days) are constants; the ±5-year window and the 25 %
      scaled-minimum share are too.
      **Provisional decision 2026-10-01 (to be confirmed by the client's hydrologist):** keep all four off; deciding needs a semi-arid record with a known drought, which only the client can supply ([calibration-research.md § Provisional decisions](./calibration-research.md#provisional-decisions-on-the-hydrologists-questions-2026-10-01)).
- [ ] **CHIRPS bias correction (engine 0.7.0, audit B1).** CHIRPS that fills
      in for blank catchment rain is now scaled per calendar month by
      Σ catchment / Σ CHIRPS, fitted without the suspect catchment rain the
      issue #2 checks flag ([model.md §2.4b](./model.md#24b-chirps-fallback-bias-correction)).
      **Done (engine 0.18.0): the fit follows the zero-rain decisions.** A
      flagged run treated as missing is left out day by day (the rest of its
      water year stays in), kept-dry days stay in as confirmed readings, and
      a keep-dry that bias-corrected CHIRPS contradicts (more than max(50 mm,
      25 % of the usual annual rain) over its kept days) leaves its year out
      and warns. Low-vs-CHIRPS years are still left out whole. The run's
      `chirpsCorrection`, summary CSV and run comparison (`chirpsFit`) say
      what was left out. Confirm the guard's limits with the hydrologist.
      Confirm with the hydrologist:
      - linear scaling per month, versus quantile mapping (which also fixes
        the wet-day count and intensities that drive GR4J's event response);
      - the minimum sample (90 shared days and 50 mm of CHIRPS per month,
        else the pooled factor) and the 0.25–4 clamp;
      - whether a neighbouring gauge should fill gaps before CHIRPS does.

      The issue #4 phase 6 GR4J-vs-legacy comparison can no longer be re-run:
      engine 1.0.0 removed the legacy model (issue #16). The last client
      record of legacy against the workbook is the regression run on engine
      0.45.0 (`run.test.ts`, engine-audit.md § Regression suite).
      **Provisional decision 2026-10-01 (to be confirmed by the client's hydrologist):** keep linear monthly scaling as the default, the sample and clamp limits; the quantile map stays opt-in, recommended where a month has ≥ 30 wet days on both sides ([calibration-research.md § Provisional decisions](./calibration-research.md#provisional-decisions-on-the-hydrologists-questions-2026-10-01)).
- [ ] **Multi-day rain accumulations (issue #2, audit B4). Built (engine
      0.20.0, model.md §2.4d): detection, spreading by bias-corrected CHIRPS
      (default on), keep-as-recorded and listed windows in Settings → Rain
      gaps and CHIRPS, the run warning, `summary.rainAccumulation`, the
      `rain_catchment_spread` column, the summary CSV block, Data-tab shading,
      run comparison and fit provenance.** Still open, for the hydrologist
      (engine-audit.md question 10): (1) confirm the thresholds (20 mm; 3 days;
      CHIRPS ±1 day < 25 %; CHIRPS over the run ≥ 50 %; 92-day cap) against
      the station's observer logs or "accumulated" flags, if the source files
      have them; (2) some detected windows read far less than CHIRPS over
      them. An unread gauge loses catch to evaporation and overflow, so decide
      whether such a window's total should be scaled up, or its days treated
      as missing instead of spread. The durable fix is an under-catch rule
      with its own threshold (the window's total against corrected CHIRPS),
      once the hydrologist says which; until then the gauge total is kept.
      Trigger: the hydrologist's review of issue #2.
      **Provisional decision 2026-10-01 (to be confirmed by the client's hydrologist):** keep the thresholds and the gauge total as recorded; confirming any one window needs the station's observer logs (client data).
- [ ] **Zero-rain runs treated as missing (CR-20, issue #2; the hydrologist's answer is on #46). Built
      (2026-09-24): engine, API and CSV export landed in engine 0.15.0
      (audit B2, model.md §2.4c), then the Settings section, the Data tab
      shading and the help entry (ui.md), then `zeroRainRuns` in a fit
      record's `forcing` (fit provenance), so a change flags "Forcing changed
      since fit". Engine 0.18.0 added the double-mass check and made the
      CHIRPS fit respect keep-dry (end of this item). Engine 0.20.0 handles
      the multi-day accumulations some of these runs end in (audit B4,
      model.md §2.4d): the reading's total is spread over the run by CHIRPS
      instead of being kept on its day while CHIRPS also fills the run, which
      counted that rain twice (the item above). Still open: the hydrologist's
      answer on the flagged runs.** The issue #2 checks find runs of zero catchment rain
      that look like missing data, but they only warn. A 0 is a reading, so
      those days still run dry and CHIRPS never fills them. A flagged run can
      coincide with substantial CHIRPS rain (details in the private source
      repo). The plan:
      1. **Engine:** when picking rain used (model.md §2.4, column R), a day
         inside a flagged zero run counts as blank. Bias-corrected CHIRPS
         (§2.4b) then fills it, then forecast rain. Stored catchment rain is
         never changed. Minor `ENGINE_VERSION` bump.
      2. **Setting** `settings.zeroRainRuns`: `mode` `'missing'` (default)
         or `'asRecorded'`, plus two date-range lists. `keepDry` holds
         flagged runs the hydrologist confirms as real dry spells. `missing`
         holds extra ranges to treat as missing, e.g. the bad days inside a
         low-vs-CHIRPS year. They're saved in project settings, so each run's
         snapshot reproduces them.
      3. **Visible:** a run warning lists the filled ranges, their days and
         mm (raw → corrected). Results carry a per-day infilled-rain flag,
         the first slice of CR-18 in the same shape as WP-1.32's `filled`
         mask. Filled days are shaded on the daily rain chart. Settings →
         Data quality edits the mode and the lists.
      4. **Audit trail:** a finding in engine-audit.md; the affected columns
         go on the client catchment regression suite's deviation list;
         model.md §2.4/§2.4b/§2.10a, ui.md, api.md and the help text are
         updated with the code.

      Why default on: a false positive costs little, because in a real
      drought CHIRPS is dry too and filling it adds little rain. A missed
      gap runs a whole wet season dry. Rejected: fixing it in the importer
      (hides the change, and CSV uploads bypass it) and filling from
      climatology (smears rain over every day and loses storm timing).
      Still ask the hydrologist to confirm the flagged runs
      ([plan.md § Questions, *Zero-rain runs*](./plan.md#questions-for-the-client)). Out of
      scope: low-vs-CHIRPS years are never blanked whole; the `missing`
      list covers them once the hydrologist names the bad days.
      **Double-mass check against CHIRPS: done (engine 0.18.0, audit B3,
      model.md §2.10a).** Water-year totals, up to two breaks, a data check,
      a Data-tab chart, a summary-CSV block and a run warning when CHIRPS
      fills an era whose ratio differs from the fit. It only warns; the
      response to a real break is the *CHIRPS fit period* item below (done,
      engine 0.29.0). The
      same release made the CHIRPS fit leave flagged runs out day by day and
      keep kept-dry days in (the *CHIRPS bias correction* item above).

      **Simulated review (2026-09-24), a draft for the real hydrologist, not
      sign-off.** A `persona-hydrologist` review
      (`reviews/persona-hydrologist-zero-rain.md`, gitignored and local only,
      because it quotes client numbers) judged the flagged runs to be
      missing data, not real dry spells. It suggested listing some adjacent
      days as `missing` too, and an accumulation check (a very large reading straight after a zero or
      blank run, on a day CHIRPS is dry). None of this is applied: the
      hydrologist decides what to list
      ([plan.md § Questions, *Zero-rain runs*](./plan.md#questions-for-the-client)).
      **Provisional decision 2026-10-01 (to be confirmed by the client's hydrologist):** keep treating flagged runs as missing; which runs are real dry spells needs the station's records (client data).
- [x] **CHIRPS fit period / per-segment factors (tracked from audit B3,
      2026-09-24; done, engine 0.29.0, issue #40 (a)).** The double-mass
      check (model.md §2.10a) can find the catchment / CHIRPS ratio breaking
      part-way through a record, but the CHIRPS factors were one set
      fitted over all eras, so a gap in the latest era was filled with a
      blend of older ratios. `settings.chirpsFitPeriod` now chooses: `'all'`
      (the default, unchanged) or water-year ranges, each with a reason (one
      set per range, fitted only on its years; years outside every range stay
      out of every fit; a gap takes the nearest range). Following the issue
      #40 amendments, the double-mass breaks only *propose* ranges
      (`proposeChirpsFitRanges`, Settings → *Propose from the double-mass
      breaks*) for the hydrologist to check: there is no automatic
      `'segments'` mode. The minimum sample and clamp hold per range,
      falling back to the range's pooled factor, then all the ranges'.
      `missing` and filled days stay out of every fit. Recorded, with each
      fit's reference window, in `summary.chirpsCorrection.fitPeriod`, the
      summary CSV, run comparison and fit provenance
      (`forcing.chirpsFitPeriod`, `forcing.chirpsFactors`; a change flags
      "Forcing changed since fit"); the double-mass run warning names the
      range whose factors filled each gap; Settings → Rain gaps and CHIRPS →
      *CHIRPS fit period*
      ([model.md §2.4b *Fit period*](./model.md#fit-period-and-per-range-factors-engine--0290-issue-40)).
      Never applied silently: the default stays `'all'`. CHIRPS version
      provenance was issue #40 (c); the per-period rain source and 08:00
      aggregation are the next item.
- [x] **Per-period rain source (done, engine 0.30.0, issue #40 (b) and its
      amendments).** `settings.rainSource` lists periods whose catchment rain
      comes from a second catchment-rain kind, `rain_catchment_alt_mm`, ×
      monthly factors: fixed with their provenance (source, dates fitted on,
      method), or `'fit'` against a reference that doesn't contain the gauge
      (a new gauge-free kind, `rain_reanalysis_mm`; CHIRPS is refused once
      the period says CHIRPS ingests the gauge) over a named reference era,
      recording both ratios' windows. Gaps fall through to a named fallback
      (default CHIRPS × the fit-period factors; or reanalysis × its own
      era's factors), then forecast. The primary days in a period stay out
      of every fit (a test pins a replaced period at 10 × CHIRPS). Per-day
      `rain_source` column, `summary.rainSource`, a warning per period, a
      summary CSV block with the reasons, run comparison
      (`RunComparison.rainSource` and a settings line), fit provenance
      (`forcing.rainSource`, "Forcing changed since fit"), Settings → *Rain
      source periods*. Sub-daily uploads are added up into 08:00–08:00 days
      booked to the start day (or midnight days), recorded on the series
      (`time_series.day_boundary`, 033) and guarded against merging the
      other window
      ([model.md §2.4e](./model.md#24e-rain-source-periods-engine--0300-issue-40-b)).
- [x] **A separate PE input for GR4J (done, engine 0.31.0, issue #39).**
      One A-pan row drove crop demand, dam evaporation and GR4J's PE.
      `settings.pe` now picks GR4J's PE: `{ kind: 'pan' }` (pan coefficient
      × A-pan, the default and what every earlier run did, byte-identical)
      or `{ kind: 'monthly', mm, source }` (12 water-year values entered
      directly, e.g. a station FAO-56 ET₀, with a required source). Demand
      and dam evaporation still read A-pan. Fit provenance
      (`forcing.pe`, "Forcing changed since fit"), run comparison, scenarios
      (`settings.set` `pe`), the ensemble (no pan shift under a monthly PE)
      and `pnpm pan-sensitivity` (refuses a monthly PE) follow it. Settings
      → Flow calibration also has an FAO-56 Table 5 helper that suggests the
      pan-coefficient row from monthly RH, wind, siting and fetch; it only
      fills the form, and (engine 0.31.1) writes where the values came from
      into the row's `panCoefficientSource` note, which fits record
      ([model.md §2.4a](./model.md#24a-rain-to-flow-gr4j-engine--050-issue-4)).
- [x] **A daily A-pan evaporation series (done, engine 0.38.0, issue #45).**
      Series kind `evap_apan_mm` (mm/day), uploaded through Add data like
      rain. On the days it has a value ≥ 0 it replaces the monthly A-pan
      mean for crop demand, dam evaporation and GR4J's PE under
      `pe.kind: 'pan'`; other days use the monthly mean, counted in
      `summary.apanDaily` and a run warning. No series, byte-identical
      results. Settings → Demand says which source A-pan comes from
      ([model.md §2.3a](./model.md#23a-daily-a-pan-evaporation-engine--0380-issue-45)).
- [x] **Fit provenance of the daily A-pan series (done, engine 0.40.0).**
      The fit record's `forcing.apanDaily` keeps the start, length and
      SHA-256 of the daily A-pan series the fit ran on (null = none);
      `fitRecordStatus(settings, record, { apanDaily })` sets
      `apanDailyChanged` (and `forcingChanged`) when it was added, replaced
      or removed since a GR4J fit under pan coefficient × A-pan, with its own
      caveat. Settings hashes the project's series, the Runs page, report and
      run comparison read each run's snapshot `valuesSha256`
      ([model.md §2.10b](./model.md)).
- [x] **Quantile-map a replacement gauge's daily intensities
      (calibration-research.md §4, *Check daily intensity*; done, engine
      1.21.0, issue #66).** Every rain-source period now reports the share
      of its rain on heavy days (≥ 20 mm) and its wet days against the
      primary record's in a reference era, and warns when the heavy-day
      shares are more than 5 points apart; an opt-in per-period
      `quantileMap` maps the scaled gauge's wet days onto the primary
      record's, month by month (else by season, else not at all, at 30 wet
      days), keeping every year-month's total. The default (no map) runs
      exactly as before ([model.md §2.4e *Daily
      intensity*](./model.md#24e-rain-source-periods-engine--0300-issue-40-b)).
- [x] **CR-23: quantile-map the CHIRPS gap fill (done, engine 1.53.0).**
      Opt-in `settings.chirpsQuantileMap`: fitted with the monthly factors
      on the §2.4b fit period's shared days, CHIRPS' wet-day rate matched to
      the catchment's and its wet days mapped onto the catchment's, per
      calendar month (else season, else the factor alone, with a warning),
      each calendar month's corrected total kept. Pinned with the factors,
      recorded in a fit's forcing, compared in "What changed". Off by
      default: a run without it is unchanged ([model.md §2.4b *Quantile
      map*](./model.md#quantile-map-engine--1530-cr-23)).
- [ ] **Confirm the daily-intensity defaults with the hydrologist (issue
      #66, and CR-23's CHIRPS gap map, engine 1.53.0).** Built on documented
      defaults: a heavy day is ≥ 20 mm; the check warns beyond 5 share
      points; a wet day is ≥ 1 mm; both maps work by calendar month, pooling
      the 3-month season below 30 wet days on either side and leaving a
      thinner season unmapped (the CHIRPS map then takes the monthly factor
      alone and warns). Also whether a replacement gauge's map should
      adjust wet-day frequency as the CHIRPS map does (it doesn't: it keeps
      each month's wet days and total, so a gauge wet on fewer days keeps
      part of its heavy-day excess; the CHIRPS map dries CHIRPS' extra wet
      days, since CHIRPS is the one wet too often), and whether the CHIRPS
      map should be on by default once confirmed. Trigger: the
      hydrologist's answer, or the first client run with either map on. The
      shared constants are in `packages/engine/src/quantileMap.ts`, the
      heavy-day ones in `rainSourcePeriods.ts` ([model.md §2.4b *Quantile
      map*](./model.md#quantile-map-engine--1530-cr-23)).
      **Provisional decision 2026-10-01 (to be confirmed by the client's hydrologist):** keep the defaults as built, the gauge map keeping wet-day counts and the CHIRPS map opt-in ([calibration-research.md § Provisional decisions](./calibration-research.md#provisional-decisions-on-the-hydrologists-questions-2026-10-01)).
- [x] **Help text read-through** (`frontend/src/lib/help/tips.ts`,
      `articles.ts` and `farmer.ts`; issue #76, 2026-09-27). A
      `persona-hydrologist` pass checked every entry against the engine;
      19 fixes, each verified in the code: the water account, balance check
      and water balance now list groundwater, lost seepage, depletion and
      the storage reset; outflow, dam storage and spill the dam release;
      demand and supplied the demand objects (and supplied is abstracted,
      not delivered); days EWR not met for a unit; WR90/WR2012 publish
      S-pan, not A-pan (also fixed in model.md §7); `run.rain_used` moved
      off the rain threshold (no threshold under GR4J); forecast rain only
      past the record in a forecast run; the WR2012 rainfall scaling is a
      choice; the borehole trigger level; the dam-rain double count (N2);
      farmer-view "measuring points … checked for the reserve" (Afrikaans
      re-translated and re-checked). **Pending the client's hydrologist**
      (persona drafts, tracked on #46 with D10): base flow described via the Lyne–Hollick filter,
      not GR4J's routing store; the Reserve set for a target category A–D;
      "IFR" as the older term. **Provisional decision 2026-10-01:** all
      three kept, and D10's narrow no-break space too; the `ewr` article now
      names the Act's term (the Reserve, its ecological part) and the
      `ecological-category` article says E and F aren't management targets.
- [x] **Curtailment "Demand left %"** is bounded 0–100 and shows "no
      demand" / "—" below 1 m³/day (Q13, engine 0.17.0).
- [x] **Issue #46 persona drafts, four changes built** (engine 1.11.0,
      2026-09-27; drafts from the licensing-authority and hydrologist
      personas, **pending the client's hydrologist**, who may reverse any
      of them on #46): (1) an optional `naturalMarMcm` on a Reserve rule
      table (engine, settings API, `ewrRule.set`, the rule-table editor;
      settings JSON, no migration) and a run warning when the percentile
      comes from the run and the run's natural MAR is more than ±15 %
      (`EWR_NATURAL_MAR_TOLERANCE`, a judgement) from it, model.md §2.9c;
      (2) the annual assurance of supply counts complete water years only,
      with `partWaterYears` saying how many part years were left out,
      §2.11a; (3) the review triggers' lowest band runs from the lowest
      total storage on record for the review date instead of empty dams,
      §2.15a. Still open for the hydrologist: whether `naturalSource`
      should default to `table` (or be a required choice) where the gazette
      publishes a natural curve, the 15 % itself, and the minimum vs a 5th
      percentile (≥ 20 years) for the lowest band. (4) A high-flow
      component's peak is labelled the **daily-mean** peak in the editor
      (a gazette gives an instantaneous one, BBM manual WRC TT 354/08
      §21.3), and the run warns when natural flow has no event in more
      than half the water years (`EWR_HIGH_FLOW_NATURAL_MIN_SHARE`),
      §2.9d. Open: whether the engine should take the gazette's
      instantaneous peak and a per-site peak-to-daily ratio instead.

## Issue #4 Phase 6: simulated review findings (2026-09-24)

The `persona-hydrologist` and `persona-licensing-authority` agents answered
the six Phase 6 questions in issue #4. Their full reports are in
`reviews/persona-*-phase6.md`, gitignored and local only, because they quote
client numbers. **These are simulated reviews: a pre-filled pack for the real
hydrologist and a CMA official, not sign-off.** Nothing below is recorded as
a decision in `docs/plan.md` (D3).

**Recommendation to put to the hydrologist.** Make GR4J (with X2 = 0) the
default, and don't build the IHACRES-CMD benchmark (Phase 7) first. Three
conditions come before any client numbers:
- [x] **CHIRPS fallback bias correction.** Raw CHIRPS can read well below
      the station catchment rain, so fallback years would produce too little
      flow under a water-conserving model. **Landed in engine 0.7.0**
      (audit B1, [model.md §2.4b](./model.md#24b-chirps-fallback-bias-correction)):
      monthly factors, on by default. The re-run of the comparison and the
      hydrologist's confirmation are the open item under Hydrologist above.
- [ ] **Make the logger fit identifiable, keeping the logger as the target.**
      A calibration record alone may not pin down every GR4J parameter
      (details in the private source repo).

      **Resolved (2026-09-24): don't recalibrate on the gauge.** It isn't a
      comparable record (reasons in the private source repo).

      **Plan**, in order:
      1. **Constrain the logger fit with information about *this*
         catchment.** Switch on the Phase 8 WR2012 soft penalty on MAR for
         the client catchment, and record its weight. Where published
         natural-MAR estimates disagree, use the band between them, not one
         value. Also run a fit bounded to Perrin's 80 % ranges. Report both
         fits beside the free fit.

         **Landed in code (2026-09-24):** the WR2012 calibration penalty
         (`settings.wr2012.calibrationPenalty`, model.md §2.10c) takes an
         optional MAR band (`marLowMm3` / `marHighMm3`) instead of one
         target — zero inside it, a soft pull towards the nearer bound
         outside it — for exactly this "two disagreeing published estimates"
         case, validated (both bounds or neither, low ≤ high) by a shared
         engine function the backend and the Settings form both use, and
         recorded in the fit record and run comparison's *What changed*.
         Automatic calibration also takes a `bounds: 'wide' | 'typical'`
         option (a "Bounds" select in Fit automatically), the second
         restricting the search to Perrin et al.'s 80 % ranges; it's recorded
         on the fit record too. Free / typical-bounds / band / both fits
         on the client record, with their scores, are in the private source
         repo (the repo is public).

         What the fits show is in the private source repo. The durable fix
         is still item 3, the proxy-basin prior. Item 2 is still open; item 4
         has landed.
      2. **Use the gauge as a regional wet/dry index only.** Use it to rank
         water years for the dry→wet test design and the Phase 9 forcing,
         never as a calibration or validation target for this river.
         **Done (engine 1.19.0, issue #65):** the dry → wet test ranks water
         years by the reference gauge's water-year mean flow when it covers
         them (`rankYearsBy`, the default when a reference exists), falls
         back to the record's own flow with a note, and never scores it
         (tested); `differential.rankedBy` is in the report and fit record and
         shown beside the test. The Phase 9 ensemble has no year ranking (its
         held-out split is chronological), so nothing changes there
         (model.md §2.10b).
      3. **The durable fix for parameter uncertainty is a proxy-basin model.**
         Build a gauged neighbouring catchment as its own project in the
         app, with its own rain, farm dams and irrigation, and calibrate it
         on its gauge record. Then compare its fitted X1–X4 with the logger
         fit: this is regionalisation by spatial proximity (Oudin et al.
         2008).
         - If the neighbour's parameters are better constrained than the
           logger fit's, use the neighbour's as a prior. That brings a
           longer record into the fit honestly.
         - It needs the neighbour's rain record and development data, and it
           depends on WP-1.21 (dam evaporation) and WP-1.33 (other water
           users).
      4. ~~**Importer fix.**~~ **Done (2026-09-24).** `scripts/wbt-import`
         always mapped the workbook's gauge column to `flow_observed_m3s`,
         which is wrong where that column is a gauge on another catchment.
         The default is unchanged (the column may really be the catchment's
         own gauge), but `extract_project.py --gauge-as-reference
         [--gauge-scaling-from YYYY-MM-DD --gauge-scale-factor F]` now
         imports it as a new `flow_reference_m3s` series ("Reference gauge
         (other catchment)") with any area scaling undone. The engine never
         reads that kind
         ([model.md §2.10](./model.md#210-calibration-statistics-flow-calibration-cfg)).
         `pnpm seed:demo` can use it per workbook, taking the scaling from
         `WBT_GAUGE_SCALING_FROM` / `WBT_GAUGE_SCALE_FACTOR` outside the repo.
      5. **Confirm the modelled area.** Where published catchment areas
         disagree, ask the hydrologist which is right.

      The hydrologist still signs off the logger as the target (#1). This
      plan doesn't need them to settle a conflict.
- [x] **Fix the monthly pan coefficient (A-pan → PET) before calibrating.**
      Done 2026-09-24 (model.md §2.4a, §2.10b): it is never a calibrated
      parameter (guard test); a fit records the forcing it ran under (pan
      coefficient, A-pan, CHIRPS bias correction) and shows "Forcing changed
      since fit" when any differs; Settings offers generic / winter-rainfall /
      summer-rainfall presets (indicative, FAO-56 Table 5 classes) and a run
      warns outside 0.6–0.85. `pnpm pan-sensitivity <project.json>` runs GR4J
      at 0.60 / 0.70 / 0.85 and the winter preset, fixed and refitted. Its
      results on the client catchment are in the private source repo.
      Still open: the hydrologist picks the monthly values (Q4 below);
      the PE level itself was decided with #13 (plan.md, 2026-09-26).
- [x] **Fit GR4J for the client project.** The client
      project never had fitted GR4J parameters (it ran on the defaults).
      **Refitted 2026-09-25 on engine 0.20.0** (after the rain fixes of
      issue #2), results in the private repo's `Research/`: the pan
      coefficient preset, the bounds and the validation scores, each with
      its reasoning, are recorded there. As for every client figure, the
      results carry their uncertainty (Phase 9).
      Applied to the local project only; a revised A-pan level (#13) would
      change the fit.

**Answers to put to the hydrologist and the CMA** (the full reasoning is in
the reports):
- **Q1: model on record.** GR4J is fine as the daily impact model, but every
  evidence run must carry the WR2012 comparison. (The persona called Pitman
  desirable, not mandatory; the app removed it as an input in engine 0.10.0,
  audit P1.) Legacy is not acceptable as evidence at all, because it
  doesn't conserve water (H1). If both models run, declare the primary one
  before seeing results. (Settled: engine 1.0.0 removed legacy, so GR4J is
  the only model, issue #16.)
- **Q2: WR2012.** Always report it; never make it a hard constraint. Keep
  the soft MAR penalty off by default and record its weight when it's on
  (an applied fit's record keeps the weight and the MAR ratio with and without it).
  Flag a simulated MAR that differs from WR2012 by more than 10 %, 25 % (or
  15 % wetter) or 50 %. Those bands are persona judgement for a CMA official
  to confirm. Phase 8 has landed to these criteria (engine 0.6.0; the MAR
  band followed in 0.8.0, model.md §2.10c). Three pieces are deferred: a
  written explanation stored with each run, the WR2012 block in the CSV
  export, and tagging the help entries as South Africa-only.
- **Q3: other upstream use.** The persona's "probably yes" was withdrawn:
  it rested on the workbook's gauge (see above). The question stays open
  for the hydrologist. Still do WP-1.21 (dam evaporation) and WP-1.33 (other water
  users) before a final calibration, because they are real modelled
  processes.
  - [x] **Gap:** development (dams, abstraction) can't vary over time within
        a run. Done (engine 1.30.0, issue #67, model.md §2.7g): a dam in
        service from a date, abstraction from a date, and capacity lost to
        sediment from a survey date.
- **Q4: pan and lake factors.** These are two separate settings. PET uses a
  monthly A-pan coefficient (FAO-56 range 0.35–0.85), or from engine 0.31.0
  a monthly PE row entered directly (`settings.pe`, model.md §2.4a). Dams use WR90 lake
  factors, which are **S-pan** based; the roadmap WP-1.21 spec is now
  corrected. The WR90 monthly lake factors have been read (engine 1.49.0:
  national monthly values, not per evaporation zone, as reproduced by
  Taljaard 2023 Table 2-3) and are offered as presets converted to A-pan
  (model.md §2.7a item 4); which one the client takes is in § Hydrologist.
- **Q5: split-sample periods.** Split-sample, dry→wet, and an independent
  instrument. Cross-record validation has landed, and so have stored
  exclusions (whole water years or date ranges, each with a required reason;
  model.md §2.10) and fit provenance: an applied fit is saved with its seed,
  objective, window, exclusions and validation scores, each run snapshots
  it, and a hand edit after Apply marks it "parameters edited since fit"
  (model.md §2.10b). The Runs page shows the in-sample score next to those
  validation scores.
  - [x] Shade excluded periods on the Runs hydrograph. **Done (2026-09-28,
        issue #65):** the hydrograph tints the run's own calibration
        exclusions (from its settings snapshot, never the project's current
        ones) with a text key listing each period and its reason (ui.md,
        `runs/exclusionShading.ts`).
- **Q6: uncertainty.** SA Reserve practice uses confidence ratings and
  assurance rules, not a numeric band. Show monthly compliance against the
  EWR assurance rules, not a raw count of days below the EWR (done, engine
  0.21.0, below). Phase 9 criteria are below.

**Open items (not yet started):**
- [x] **Phase 9: uncertainty bands.** Done 2026-09-25, engine 0.26.0,
      migration 014 ([model.md §2.10e](./model.md#210e-uncertainty-bands-engine--0260-issue-4-phase-9),
      [ui.md](./ui.md), [run-comparison.md](./run-comparison.md)). A seeded
      Latin hypercube over the free parameters (log-uniform across a
      decade or more), a ±0.1 pan-coefficient shift, station-with-infill vs
      CHIRPS-only rain and gauge vs logger; member 0 is the run itself.
      Kept by stored thresholds (KGE′ ≥ 0.5 before the split date, WR2012 up
      to *query* and inside the MAR band, low-flow bias ±50 %), diffed in the
      Runs-tab history and run comparison; coverage of the held-out half per
      record (warning below 70 %); no percentiles below 30 kept; bands on
      every output below plus the monthly Reserve compliance rate; paired
      B − A bands in run comparison; one model per ensemble. The database
      draws the seed and keeps every start; the server regenerates the
      sample and re-runs member 0 and three random members before storing
      (licensing, issue #15: bands can't be cherry-picked). The ensemble
      runs in the calibration worker: 300 members take 8–16 s on the example
      catchments. Defaults to confirm: plan.md question 18.
      Criteria it was built to (assessor):
      - The ensemble comes from a seeded sample across the parameter bounds
        (Latin hypercube or DDS-AU), **not** the optimiser's search path.
      - The ensemble also varies the pan coefficient, the rain source and the
        observed record (hydrologist).
      - A parameter set is kept only if it passes stored, diffed thresholds:
        a skill score, the Phase 8 WR2012 bounds, and a low-flow check.
      - Report how many held-out observations fall inside the band, with a
        warning below 70 %.
      - Show no percentiles with fewer than 30 accepted members.
      - 5–95 % bands on EWR days not met (monthly and total), shortfall
        volume, curtailment per farm, annual volumes and MAR.
      - Paired bands on the difference between a run and its baseline (the
        application's extra impact).
      - Monthly flow-duration curves against the EWR line.
      - A band per runoff model, never pooled.
      - Seed, method, thresholds, the kept parameter sets and the
        percentiles are stored and reproducible.
      - The decision rule is printed next to the band.
- [x] **EWR compliance by the Reserve's assurance rules**, monthly, as the
      headline instead of raw days-not-met (hydrologist Q6). Done 2026-09-25,
      engine 0.21.0 ([model.md §2.9c](./model.md#29c-ewr-compliance-by-the-reserves-assurance-rules-engine--0210-hydrologist-q6)):
      an optional rule table per EWR site (Settings, paste from a
      spreadsheet), monthly compliance at the requirement the month's natural
      flow selects, the FDC check, the headline card, the Reserve compliance
      panel, a summary CSV block and run comparison. The method choices are
      plan.md question 17 for the hydrologist.
      - [x] **Daily charge from the rule table.** Built as an opt-in
            setting, engine 1.3.0 (issue #64,
            [model.md §2.9c](./model.md#29c-ewr-compliance-by-the-reserves-assurance-rules-engine--0210-hydrologist-q6)):
            `settings.ewrChargeSource: 'ruleTable'` feeds each rule-table
            site's `ewr_rule` requirement to attribution and curtailment in
            place of the pragmatic EWR (the pragmatic EWR outside complete
            months and at sites without a table), stored as
            `ewr_charge_shortfall`; the default stays `'pragmatic'`. Left
            for the hydrologist and the assessor: which is the default
            (plan.md question 17).
      - [x] **Uncertainty on compliance.** Phase 9's bands include the
            monthly Reserve compliance rate per site beside days not met
            (engine 0.26.0).
      - [x] **Low flows and high flows (WP-3.7, engine 0.33.0).** The DRM
            low-flow table beside a total table and freshet / flood
            components per site, entered by paste or CSV, with a heat map
            per site ([model.md §2.9d](./model.md)). Method choices pending
            the hydrologist (plan.md question 17).
      - [x] **Low flows on base flow.** Built as an opt-in setting, engine
            1.3.0 (issue #64, [model.md §2.9d](./model.md)):
            `settings.lowFlowMeasure: 'baseflow'` judges a low-flow
            requirement on the month's base flow from a three-pass
            Lyne–Hollick filter (α 0.995, Smakhtin & Watkins 1997); the
            default stays the month's total volume. Engine ≥ 1.6.0 filters
            each month over its own days and the 730 before it only, so a
            completed month's base flow never moves with later days and a
            resumed run's is the uninterrupted run's to the bit (the
            snapshot, format 2, carries those days). Left for the
            hydrologist: which measure a Reserve monitoring report uses, and
            the filter parameter (plan.md question 17).
      - [x] **Site source and confidence labels (WP-3.7 UI)** (engine
            1.5.0, issue #64). An optional typed `sourceKind`
            (`gazetted` | `desktop` | `other`) on `EwrRuleTable`, checked
            by the engine, the settings API and the rule-table editor; the
            Reserve panel and the printed report put the confidence line
            ("Desktop estimate, low confidence", "Gazetted Reserve") before
            the source, and run comparison lists it changing. The "changed
            table in red as a baseline assumption" part is the scenario op
            `ewrRule.set` (engine ≥ 1.6.0): always baseline, and the
            scenario list and the compare page's overrides show the table
            it sets and the one it replaces, each with its confidence line.
- [x] **Nominated evidence run** (2026-09-25, migration 010). An editor
      nominates a run as evidence with a required reason; the history is
      append-only in the database (who, when, runoff model and engine version
      stamped by a trigger), nominated runs can't be deleted or trimmed, and
      the Runs tab, run header, compare and summary CSV show it, with a
      warning when a later run uses another runoff model
      ([data-model.md](./data-model.md), [security.md](./security.md)). The
      assessor rated this Medium.
- [x] **Hydrologist plausibility checks** (as run warnings or a report).
      Done 2026-09-25, engine 0.25.0
      ([model.md §2.10d](./model.md#210d-hydrologist-plausibility-checks-engine--0250-issue-4-phase-6)):
      `RunSummary.plausibility`, run warnings, a *Plausibility checks* block
      in the summary CSV and a lazy-loaded panel on Runs & results
      ([ui.md](./ui.md)):
      - natural flow ≥ impacted observed flow + modelled abstraction in every
        water year (A = natural − simulated outflow, split into use, dams and
        land cover; 10 % of the observed volume allowed for gauging error,
        floor 1 % of the record's mean; judged with 300+ observed days);
      - EWR days reported separately for good-rain and fallback-rain years
        (a fallback year has more than half its rain, or its days, from
        CHIRPS, forecast, spread or blank days), with the Reserve months met
        split the same way; warns at a 10-point difference;
      - a double-mass curve of gauge flow against rain, to tell new upstream
        use from a failing gauge (the rain-vs-CHIRPS break detection,
        `doubleMassSegments`; each break set against the simulated outflow,
        with a seasonal hint);
      - dry-season low-flow duration curves overlaid for gauge, logger and
        each model (the latest run of each other runoff model), warning when
        the simulated Q90 is more than a factor of 2 from the observed.

      For the hydrologist: confirm the dry-season rule (six months of lowest
      mean flow), the 10 % / 1 % tolerance, the fallback-year rule and its
      10-point warning, the seasonal hint's 10-point margin and the factor of
      2 on Q90 (every value and its reasoning is in model.md §2.10d).
      Still open, each with its trigger:
      - [x] **Checks on a gauge node inside the network.** Done 2026-09-27
            (issue #64), engine 1.4.0, migration 084 (may need renumbering
            at merge): a flow record can be attached to a gauge above the
            outlet (`time_series.site_node_id`, the Data page's site select),
            and checks 1 and 4 run at each such gauge against the simulated
            flow there, per site in `plausibility.gauges`, the Runs panel,
            the summary CSV and the warnings
            ([model.md §2.10d](./model.md#210d-hydrologist-plausibility-checks-engine--0250-issue-4-phase-6),
            [data-model.md](./data-model.md#gauge-records-084_gauge_recordssql)).
            A series revision keeps the site too (2026-09-27, migration 085):
            a deleted gauge record restored from its revision is back at its
            gauge, and a restore whose gauge has left the model is refused
            rather than put at the outlet
            ([data-model.md](./data-model.md#gauge-records-084_gauge_recordssql)).
      - [x] **The checks in the run comparison.** Done 2026-09-27 (issue
            #64): Compare's *Plausibility checks* panel gives, per site (the
            outlet and each gauge), both runs' failing years with those newly
            failing and now passing, and the Q90 ratio with pass or fail,
            then the rain-source split and the double-mass breaks
            ([run-comparison.md](./run-comparison.md#plausibility-checks)).
- [x] **Phase 10 of issue #4: remove legacy** (issue #16). Done 2026-09-26,
      engine 1.0.0, ahead of its 2026-11-30 deadline; the operator waived the
      hydrologist-review trigger ([plan.md](./plan.md) Decisions,
      [model.md §2.4](./model.md#24-natural-flow-from-rain-flow-data)).
- [x] **Phase 7 of issue #4 (IHACRES)** only if the hydrologist asks for it. Asked in issue #90 (2026-09-28). **Provisional decision 2026-10-01: not built.** GR6J (CR-10) is the planned structural alternative for low flows and the climatology benchmark already tests GR4J's skill; reopen if the client's hydrologist asks ([calibration-research.md § Provisional decisions](./calibration-research.md#provisional-decisions-on-the-hydrologists-questions-2026-10-01)).
- [x] **Persona tooling** (2026-09-24): `tsx` is an engine dev dependency
      (same pin as the backend), so `pnpm -C packages/engine exec tsx` works.

## Calibration research (2026-09-24)

The review in [calibration-research.md](./calibration-research.md) turned into
34 recommendations (CR-1 … CR-34), with priorities and effort. Open items, in
the suggested order (the IDs carry the detail):

- [x] **Cheap first:** CR-3 KGE(Q)+KGE(1/Q) objective, CR-34
      record-representativeness note. CR-2 multi-start DDS (engine 0.13.0,
      model.md §2.10b) and CR-6 drop Moriasi words on daily scores
      (model.md §2.10) are done. **Done (engine 1.19.0, issue #65):** CR-3
      is the `kgeLowHigh` objective (mean of KGE′ on Q and on 1/(Q+ε),
      ε = Q̄/100), suggested for EWR decisions, default still KGE′; CR-34
      is `report.representativeness` (scored days and water years, each
      year's rain percentile and dry / near normal / wet class against the
      run's complete water years of rain, the mean against the long-term
      mean, and notes when the record can't test wet or dry years or has
      fewer than 5), shown in Fit automatically (model.md §2.10b).
- [x] **Data layer:** CR-18 per-day quality flags → CR-19 flag-aware
      objective → CR-20 flagged zero-rain runs become missing so corrected
      CHIRPS fills them (closes the gap behind issue #2) → CR-22 data-quality
      panel. CR-20 went first (built 2026-09-24, engine 0.15.0; see
      "Zero-rain runs treated as missing" above). Its per-day infill flag is
      the rain slice that CR-18 then generalises. **Done (engine 1.22.0,
      issue #66, model.md §2.10h):** CR-18 flags each day (`calibrate/dayFlags.ts`:
      in range, above / below the gauged range entered per record, suspect by
      the Data checks, infilled, missing; human use defined, not derived; rain
      observed / infilled / missing), CR-19 censors days above the highest
      gauging and leaves below-rating, suspect and infilled days out of the
      fit by default, with the fit on all days beside it and the settings in
      the fit record, and CR-22 is the Fit panel's data-quality panel. The
      recession segments (CR-13) leave flagged days out. **Infilled hook:
      done (engine 1.23.0, issue #66, model.md §2.10i):** `observedInfillMask`
      reads the gap fill's per-day code, so filled flow days are flagged
      *infilled* in the fit, the panel and the recession mask, and
      `qualityFlags.infilled` is the one control for scoring them (the run's
      statistics, the EWR test and the plausibility checks follow it). The
      defaults are open questions on issue #66.
- [x] **Show the per-day flow flags on the hydrograph (CR-18 follow-on).**
      **Done (engine 1.48.0, model.md §2.10h):** a run stores the scored
      record's classes as `observed_flow_quality` (`FLOW_QUALITY_COLUMN`,
      codes as `FLOW_DAY_FLAGS`, only when a day is flagged), beside the
      scored `observed_flow`, so at the calibration site's node when the run
      scores a gauge inside the network; the fit and the column read one
      function (`recordFlowFlags`), `verify/columns.ts`
      `OBSERVED_FLOW_COLUMNS` describes it for the summary CSV's column
      guide, and the self-checks hold it to its record (`checkFlowQuality`).
      The Runs hydrograph (and the calibration site's) draws each flagged
      class as a strip along the foot of the plot with a key in words naming
      its days and what Fit automatically does with them under the run's
      settings; the Data tab's flow chart shows the same classes under the
      current settings; the daily CSV carries the column. The same change
      fixed the self-check failing every run with a gap-filled record
      (`observed_flow_filled` was not allowed blank days). The flags exist per day in the engine (`flowDayFlags`) and drive the
      fit and its panel, but a run doesn't store them, so the hydrograph and
      the Data tab can't shade the days above the gauged range or those the
      fit left out. Durable fix: a run column (`observed_flow_quality`,
      codes as `FLOW_DAY_FLAGS`, added only when a day is flagged, like
      `rain_catchment_missing`) registered in `verify/columns.ts`, shaded on
      the hydrograph with a legend. Trigger: the hydrologist asks to see
      which days were flagged, or gap filling of observed flow lands and its
      infilled days need showing.
- [x] **Fit-settings sweep (headless).** **Done (2026-09-28, issue #65):**
      `pnpm fit-sweep <project.json> --grid <grid.json>`
      (`backend/scripts/fit-sweep.ts`, model.md §2.10b) fits every cell of
      pan preset × bounds × objective × named exclusion set × WR2012 band,
      with validation, into one Markdown table (and `--json` for CR-1), the
      engine version, seed, starts and budget in the header, ranking
      nothing; at most 24 cells unless `--max-cells`. It also fixed
      `pnpm pan-sensitivity` not finding root-relative paths. The free / typical-bounds / band /
      both comparison (above, under "Make the logger fit identifiable") was
      built by hand, and every further "what if we fit it this way" repeats
      that. Generalise `backend/scripts/pan-sensitivity.ts` into a script
      that takes a `project.json` and a grid of fit settings (pan preset ×
      bounds × objective × named exclusion sets × WR2012 band on/off),
      runs `calibrate()` with validation for each cell, and writes one
      Markdown table: fitted parameters, in-sample and validation scores,
      MAR and EWR days not met, with seed and engine version in the header.
      It fits every cell and ranks nothing, so the choice stays the
      hydrologist's and is recorded with a reason, as exclusions are. No DB
      or UI; client output stays in the gitignored `data/`. This is not
      CR-21, which perturbs the inputs of one fit rather than comparing fits.
      CR-1 below can then reuse its batch and report code. Do it
      before CR-1, or as soon as the hydrologist asks for another
      side-by-side of fits.
- [x] **Ensemble and reporting:** ~~CR-1 behavioural ensemble with the EWR
      range~~ (done as Phase 9, engine 0.26.0: a few hundred Latin-hypercube
      sets in one worker, not 10–20k across several; more workers are the
      scaling step if the hydrologist wants larger samples) → ~~CR-5
      bootstrap CIs and benchmarks~~ → ~~CR-21 sensitivity runs and "not
      determinable"~~ → ~~CR-28 WR2012 five-statistic table~~ → ~~CR-29
      compliance as %time, %volume, FDC overlays and %nMAR~~. **Done
      (engine 1.19.0, issue #65):**
      - CR-5 (`calibrate/bootstrap.ts`): 90 % water-year block-bootstrap
        intervals on KGE′, NSE and `kgeLowHigh` (1 000 resamples, fixed
        seed, none under 3 water years of ≥ 30 days), and mean-flow and
        ±7-day day-of-year climatology benchmarks on every scored period,
        shown in Fit automatically (model.md §2.10b).
      - CR-21 (`uncertainty/sensitivity.ts`, model.md §2.10g): one factor
        at a time (rain ×0.9/1.1, pan coefficient and dam lake-evaporation
        factor ±15 %, abstraction ×0.7/1.3, dams empty/full), EWR
        compliance per site as central + low–high with a "not determinable
        with current data" verdict and a tornado on River & reserve. Not
        stored: a live diagnostic like `pnpm pan-sensitivity`; a stored,
        server-checked version would need a table like `run_uncertainty`.
        Joint (not one-at-a-time) extremes and era-specific rain ranges are
        not modelled. The ranges and the 0.8 threshold are defaults for the
        hydrologist (issue #90).
      - CR-28 (`reference/wr2012Fit.ts`, model.md §2.10): the five
        statistics on complete water years of monthly flows beside KGE′/NSE
        in the fit results, a run's calibration panel and the summary CSV.
        The bands (4/4/6/6/8 %) and the seasonal-index definition are
        labelled indicative until checked in WRC TT 689/690 (issue #90).
      - CR-29 (model.md §2.9c): % of time and of volume not met per month
        from daily data beside the monthly verdict, monthly FDC overlays
        of natural, present-day and (on the compare page) scenario flow on
        the EWR curve, and the EWR as %nMAR.
- [x] **Automated calibration with pre-declared rules.** *Built in engine
      1.25.0 (issue #153, model.md §2.10j): `settings.calibrationRules`, run
      by the server one fit per job (steps 1–3), the ensemble around an
      applied fit computed by the server (step 4), and new data re-running
      the rules (step 5, `after.onNewData`; it applies a fit only while the
      rules are signed off). Open elsewhere: the hydrologist's sign-off of the
      draft defaults, and whether only a named role may sign off (#90).* Today every pass
      of the calibrate → review → adjust → refit loop needs a person, because
      the choices (exclusions, forcing, which fit to keep) are made after the
      scores are seen. Automating those choices by chasing the score would
      overfit and be easy to game. The durable fix is a **rule set** stored
      with the project and fixed before any result is seen, so the whole
      loop can run unattended:
      1. Exclusions come from the per-day quality flags (CR-18/19) by rule
         (e.g. a water year with more than 20 % flagged days), each with a
         machine reason naming the rule.
      2. Forcing comes from the rule set, or each option becomes a sweep
         case (the fit-settings sweep above).
      3. The sweep fits every case; the rule set picks one by a **validation**
         score (e.g. best dry → wet KGE′), never in-sample, among the fits
         that pass stated filters (MAR inside the WR2012 band, parameters in
         Perrin's typical range).
      4. CR-1 builds the ensemble around the kept fit and reports the EWR
         range.
      5. New observed or rain data triggers a rerun (needs the Background
         jobs item in [planned-work.md](./planned-work.md)); the fit record's
         stale checks already say when one is due. *(Built: `after.onNewData`.)*

      The rule set, seed and engine version go in the fit record, so a run
      is reproducible and an assessor can challenge the rules rather than
      the result. A rule-set change is versioned and shows in run
      comparison, like any other settings change. Facts that aren't in the
      data (which gauge is on the modelled river, the highest trusted
      gauging, known gauge breaks) stay per-catchment metadata that a
      person enters once. **Depends on:** the sweep → CR-18/19 → CR-1 →
      Background jobs. **Needs the hydrologist to sign off** the default
      rules (flag thresholds, selection score, filters) before any automated
      fit is used as evidence; the question is in issue #90. Trigger: once
      the sweep (done 2026-09-28) and CR-18 (issue #66) have landed. Both
      have (CR-18/19 in engine 1.22.0): the rule set can now read
      `dayQuality` and the per-day flags; it still waits on the hydrologist
      signing off the default rules. **Provisional decision 2026-10-01:** the
      default rules are adopted as drafted, but `signedOff` stays false, so a
      fit they pick is still not evidence until the hydrologist signs them
      ([calibration-research.md § Provisional decisions](./calibration-research.md#provisional-decisions-on-the-hydrologists-questions-2026-10-01)).
- [x] **Recession:** CR-13 diagnostics (−dQ/dt vs Q; the imported table
      to overlay went with the legacy model in engine 1.0.0). CR-14 is
      dropped: engine 1.0.0 removed the legacy model (issue #16). **Done
      (engine 1.19.0, issue #65):** TOSSH-default recession segments with a
      1 mm/day rain rule, −dQ/dt against Q (ETS) for the observed record and
      GR4J's simulated outflow on the same days, power-law fits compared at
      the median flow (indicative warnings with 8 or more segments, "Not
      judged" below), in the Plausibility checks panel and the summary CSV
      (model.md §2.10d). CR-18's flags joined its day mask in engine 1.22.0.
- [x] **Run comparison: the recession diagnostics (engine 1.19.0) and the
      validation signatures (engine 1.55.0, CR-16) aren't set side by side.**
      *Done 2026-09-30 (display only, no engine version): `RunComparison.plausibility`
      gains `recession` and `signatures`, each run's stored numbers with pass
      or fail, a change only between runs that scored the same record, and a
      note on a run without them
      ([run-comparison.md](./run-comparison.md#plausibility-checks)).*
      The Compare page shows neither: `packages/engine/src/plausibility/compare.ts`
      compares checks 1–4 only
      ([run-comparison.md](./run-comparison.md#plausibility-checks)), so a
      before-and-after refit can't show a recession rate or a BFI moving.
      Durable fix: add rows to `RunComparison.plausibility` for the recession
      rate ratio and b difference, each signature's difference or bias and the
      held-out skill, as each run stored them (nothing recomputed), with their
      pass or fail. Trigger: the next change to the Compare page's plausibility
      table, or a hydrologist asking to compare refits.
- [x] **Hydrologist questions** from the review: the EWR form the CMA expects (CR-30), the logger's highest gauging and
      rating (CR-18), the defensible abstraction estimate and range (CR-21,
      CR-32), and which MAR estimate to trust (CR-7). CR-18 is
      already plan.md hydrologist Q2. **Moved (2026-09-28):** all of them,
      with the defaults issue #65 built on (CR-5, CR-13, CR-21, CR-28,
      CR-34, the dry → wet ranking), are in issue #90.
- [ ] **Later (P2/P3):** CR-7 regional filters, CR-8 trade-off view, CR-9
      proxy basin (issue #4 item 3), CR-10 GR6J, CR-15 fitted recession with
      uncertainty (CR-16's BFI, low-flow FDC slope and held-out recessions
      are built, engine 1.55.0), CR-24 alternative
      ratings, CR-25 human-use flag, CR-30 assurance-table EWR, CR-31 licence
      scenario report, CR-32 dam and abstraction assumptions, CR-33 seasonal
      reporting.

## Verification

- ✅ **Engine audit** (engine 0.4.0, [engine-audit.md](./engine-audit.md)):
  - E1/E2: base flow on day 1, and negative recession.
  - R1: the model no longer rounds.
  - G1: gauge EWR shortfall.
  - C1: Pitman calibrates against natural flow (superseded: P1 removed Pitman
    in engine 0.10.0).
  - M1: importer month lists.
  - W1–W5: new warnings.
  - F8: order-dependent float noise in EWR shortfalls.
- ✅ **Invariant suite** (per-run checks in `packages/engine/src/verify/checks.ts`,
  re-run checks in `packages/engine/src/testing/invariants.ts`) runs on
  random networks, the three example catchments and the client catchment (when `data/`
  is present). Soaked over seeds 1–20000 before engine 0.12.0 (see the soak item
  below). Described in model.md §6 Verification.
- ✅ **Self-checks on every saved run** (engine 0.12.0): `runModelChecked`
  stores `summary.verification` and `summary.waterBalance`; farms record the
  working columns K–P, S, T and the balance check V; the farm daily CSV is in
  FarmTemplate letter order; the results have a Self-checks panel with a
  water balance per water year and "Trace a day" (model.md § Verification,
  ui.md § Self-checks).
- [x] **A farm's assurance of supply carried another farm's figures**
      (issue #192, [engine-audit.md V1](./engine-audit.md#findings), engine
      1.34.0): a V8 miscompile of `nodeReliability`'s day loop (Maglev OSR
      code re-entered on later calls). Worked around by moving the loop into
      `tallyWindow`, which takes the series as parameters (bit-identical;
      0 of 88 stressed runs failed, against 34 of 64 before). It is guarded
      on every saved run by the `assurance` self-check, and in the opt-in
      stress test `backend/src/model/assurance-jit.perf.test.ts`
      (`pnpm test:backend:perf`).
- [x] **A transfer rule that moves nothing relaxed its siblings' reserve**
      (found reviewing #73; [engine-audit.md N6](./engine-audit.md#findings),
      erratum ER-11, engine 1.36.0): rules of one priority from one dam shared
      the free water above the *lowest* reserve among them, so a rate-0 or
      lower-reserve rule let the others take the dam below their own reserves
      (two 50 % rules from a full 1 000 m³ dam moved 800 m³ with a 0 % rate-0
      rule beside them, 500 m³ without it). Each rule now draws only above its
      own reserve (the water is shared band by band between reserves, model.md
      §2.6), a rule with no rate this month is not active, and
      `checkTransferLimits` checks the reserve per rule on every saved run.
      Tests: `run.test.ts` › "rules of one priority from one dam keep each
      rule's own reserve", `run.invariants.test.ts` › "engine 1.36.0: several
      rules from one dam …". The open entry PR #237 carries for this is closed
      by it.
- [ ] **Report the V8 miscompile upstream** (issue #192; tracked in #232). The report is
      drafted in [upstream/v8-maglev-osr.md](./upstream/v8-maglev-osr.md), and
      `pnpm test:backend:v8-osr` stresses the pre-fix loop (`47e1ddb1^`) on any
      Node binary. On x64 the stress has not reproduced it on Node 22, 24 or 25,
      though x64 is where it first showed in CI, and a 150-line harness of the
      loop never failed. What is left: re-check the flag table on arm64 (an
      Apple Silicon Mac) with the commands in that file, and the operator files
      it at crbug.com/v8 after the checklist there. The durable fix is V8's;
      `tallyWindow` stays either way. Trigger: before the next Node major bump,
      and again after it, run `pnpm test:backend:perf` alone and
      `pnpm test:backend:v8-osr` (on arm64, where it reproduces), to learn
      whether the new V8 still has the bug. If the fault turns up in a saved
      run's `assurance` check on a new Node version, that is this bug in
      another place: look for another long per-node loop read through an
      object argument.
- [x] **The water account's EWR rows are redone by a per-run check**
      (issue #192, engine 1.34.0): `checkSupplyAssurance` holds each
      site's required, met and days not met, per water year and over the
      run, to the site's own series: the pragmatic EWR (`ewr` at the
      outlet, `ewr_cumulative` at a gauge) or a rule-table site's
      `ewr_rule` (the pragmatic EWR on days without one), and
      `ewr_shortfall` or `ewr_charge_shortfall`. Its loop has V1's
      workaround (`ewrOver`).
- ✅ The engine rejects networks with more than one outflow node.
- [x] **Client catchment regression on real data:** done 2026-09-27: the
      workbook regression in `run.test.ts` passes against the re-extracted
      workbook on engine 1.2.0 (local only; the fixture is gitignored), and
      the self-checks passed on a real run on 2026-09-24. The original note:
      the suite had a commented
      deviation list but had never run against the real workbook. Re-extract
      it and run `pnpm test:engine`; a failure prints the actual difference
      next to its bound. Then load it (`pnpm seed:demo`; a large workbook can
      exhaust a laptop's memory, so cap it: on Linux run it under
      `systemd-run --user --scope -p MemoryMax=4G`; macOS has no per-process
      cap, so close other heavy apps and watch Memory Pressure in Activity
      Monitor, stopping it with Ctrl-C if it turns red), make a run, and confirm in the Self-checks panel
      that every check passes, every residual is float noise, and the yearly
      water balance is physically sensible (runoff coefficient, consumptive
      use against demand, storage change). This is the first time the
      self-checks would see real data; nothing else tells us as much for as
      little. Record findings here without client numbers (public repo).
      **Partly done 2026-09-24** (engine 0.13.0, local dev DB): a fresh run of
      the client catchment passed every self-check, every yearly residual
      was float noise, and sampled farm-days recomputed independently from
      the Network, Crops and Settings inputs agreed with the model to float
      precision. A water year with missing catchment rain recorded as 0
      (issue #2) would show an implausible runoff coefficient, which the
      run's data checks already flag. That is an input question for the
      hydrologist, not a
      calculation error. Still open: the regression suite against the
      re-extracted workbook.
- [x] **`verify/` (Python cross-check):** it transcribed the workbook's
      formulas, which the engine no longer follows. **Decided (operator,
      2026-09-30): rebuild, not delete** (roadmap D4 / WP-1.6 option (b)).
      **Done, phase 1:** `verify/` is now an independent cross-check of the
      audited engine ([verify/README.md](../verify/README.md), model.md §6
      Verification): a stdlib Python model of the core daily chain written
      only from the docs, run beside `runModel` on the example catchments,
      eight probes and random networks from its own seeded generator, every
      daily series compared to float noise, with a 24-mutant self-test
      (`pnpm test:verify`, CI job `verify`, 200 random networks). On engine
      1.36.0 the examples, the probes and 750 random networks agree on every
      column (largest difference 9e-9 m³/day); no engine departure from its
      documentation. Six points the docs left open were settled from
      `runModel`'s outputs and written into model.md (§2.4a no catchment
      area, `uh_store`; §2.4b a negative reading; §2.4d the accumulation run
      test's window; §2.6 the order of the room and band sharing, and the
      room from yesterday's storage; §2.10a the median of an even count). The
      workbook formula dumper moved to `scripts/wbt-import/dumpwb.py`.
- [x] **`verify/` phase 2a** (tracking issue #259; engine 1.53.0, no engine
      change): boreholes and stream depletion (§2.7d), allocations, the
      licence cap and full-allocation runs with the summary's `capReached`,
      `limitBound` and `scaled` rows (§2.12a), demand factors (§2.3 item 4a),
      demand objects and the basic-needs floor (§2.7f), river off-takes and
      canal seepage (§2.6a), other water users (§2.7c), supply rules and the
      river pump (§2.7e), dam survey curves and releases (§2.7a), hands-off
      flows and River to dam by month (§2.7h), each written from its model.md
      section, in about a third of the random networks and most of a new set
      of dense ones, with 35 more mutants (59 in all) and three coverage
      probes. The examples, the probes and 1 600 random and dense networks
      agree apart from the float-noise item below (fixed in engine 1.57.0);
      two points §2.12a left
      open were settled from `runModel` (a later water year a forecast tail
      runs into is its own part year; a no-demand year's `scaled` row) and
      written into model.md. CI's `verify` job runs 200 random and 200 dense
      networks.
- [x] **A float-noise demand switches on a dam-target borehole** (found by
      `verify/` phase 2a, 2026-09-30; engine 1.53.0; **fixed in engine
      1.57.0**, erratum ER-12). A primary or emergency dam-target borehole
      pumps "only while Dr > 0 (to within 10⁻¹² × D)" (model.md §2.7d), but
      the engine switched it on for a rounding residual and filled the dam by
      a day's room. Two ways in: the soil-water store left a crop requirement
      of 1.4 × 10⁻¹⁴ m³ on a day the effective rain covered it (e = 0.01, so
      D = 1.4 × 10⁻¹² m³), and the emergency borehole pumped 495 m³ into a
      495 m³ dam (verify random seed 1343, farm day 930); and off-take water
      that arrived one ulp short of the demand (980.5862268744551 vs
      980.5862268744552 m³) left a rest of 1.1 × 10⁻¹³ m³ that `groundwaterDay`
      was handed as the day's demand, so the switch judged it against itself,
      and the emergency borehole pumped 1 590 m³ (dense seed 86, day 46). The
      same noise demand made `limitBound` read two ways (198 vs 199 days in
      water year 2010, seed 145): the engine's test floors the deficit at
      10⁻⁹ m³, the doc didn't say so. **Fixed at the source:** rain within
      10⁻¹² of the need covers it (`coveredByRain`, model.md §2.3), so no
      noise requirement arises; the switch judges the rest against the day's
      full demand, off-take water used included (`groundwaterDay`'s `dayD`,
      §2.7d); §2.12a states `limitBound`'s floors. Pinned in `demand.test.ts`,
      `boreholes.test.ts` and `mode.test.ts`; `verify/diff.py`'s
      `KNOWN_CASES` allowance is gone. Off-take delivery itself can still
      arrive an ulp off the demand ((share ÷ (1 − loss)) × (1 − loss)); that
      is now harmless noise in `offtake_used` (≤ 10⁻¹² × D, below every
      threshold), so it stays.
- [x] **A no-demand year's `scaled` row reads two ways** (found by `verify/`
      phase 2a; engine 1.53.0; **fixed in engine 1.57.0**). Under a full
      allocation a year with no demand can't be scaled;
      `RunSummary.allocations.scaled` listed the volume registered over its
      run days (1 263 064 m³), except in the year a forecast tail starts in,
      where it listed k × demand = 0 (dense seed 14). Now every such year
      lists the volume registered over the days it would have been scaled on
      (its run days; the tail-start year's historical days), what it would
      have asked for (`fullAllocationFactors`, model.md §2.12a, probe
      `scaled-no-demand-tail-year`, `mode.test.ts`).
- [ ] **`verify/` phase 2b: the rest of the model.** Phases 1 and 2a cover
      the daily chain and the optional inputs above; `verify/model.py`'s
      `unsupported()` names what they leave out and the harness refuses an
      input that uses it. To add, each from its model.md section, with
      random-generator coverage (dense networks too), a probe for anything
      the docs leave open and a mutant per rule
      ([verify/README.md § Phase 2b](../verify/README.md#phase-2b-not-covered-yet)):
      demand factors by part (`partDemandFactor`, the `demand.scale` op with
      a part, merged in #252), drought restrictions (once #258 merges),
      Reserve rule tables A1–A7 (§2.9c–d), forecast mode (§2.4f),
      calibration (§2.10, §2.10b), land cover (§2.5a), time-varying
      development (§2.7g), rain-source periods, the areal correction, the
      daily A-pan, CHIRPS fit ranges, the CHIRPS quantile map (CR-23),
      keep-dry and the non-default data-quality limits. **Trigger:** the
      next engine change to any of these features (its PR adds that feature
      to `verify/` first, so the change lands against an independent
      reading), #258 merging (drought restrictions), or before the first
      licence evidence pack relies on one of them, whichever comes first.
- [x] **A fourth full page load of the Settings tab fails in e2e** with
      `net::ERR_INSUFFICIENT_RESOURCES` / "Failed to fetch dynamically
      imported module" against the Vite dev server (:7801). Done 2026-09-24:
      e2e now runs against a production build of the frontend
      (`vite build` into `frontend/build-e2e/` with the e2e API URL baked in,
      served with the SPA fallback by `e2e/support/static-server.ts`), which
      also matches production. Measured with `tests/repeated-loads.spec.ts`
      (six `page.goto(…?tab=settings)` in a row, `--workers=1
      --repeat-each`): dev server 3 of 3 failed at the fourth load; built site
      5 of 5 passed. That spec stays as the regression guard.
      `E2E_DEV_SERVER=1` still runs against `vite dev` for debugging
      ([e2e/README.md](../e2e/README.md)). Specs that already navigate between
      tabs in the app rather than with repeated `page.goto` can stay as they
      are: that is how a user moves around anyway.
- [x] **e2e runs from parallel worktrees share one `water_e2e` database and
      fixed ports** (:3101 and :7801). Fixed 2026-09-25: each checkout gets a
      slot (`e2e/support/env.ts`): the main checkout and CI keep :3101, :7801
      and `water_e2e`; a git worktree gets :3101+slot, :7801+slot and
      `water_e2e_<slot>` from a hash of its path; `E2E_SLOT` overrides. A
      slot clash fails on the port at start-up, before global setup touches
      the database. CI runs the suite as 14 shards on one shared build
      (e2e/README.md § CI). The flakes seen under load (`chirps-bias`,
      `data-quality`, 2026-09-24) were never reproduced alone; if either fails
      on its own, look for a missing readiness signal on reload rather than a
      longer timeout.
- [x] **Wall-clock test flakes under load** (2026-09-24): the timing
      checks moved out of the unit suite into `*.perf.test.ts` vitest
      `perf` projects (median of 7 after a warm-up, serial), run with
      `pnpm test:engine:perf` / `pnpm test:backend:perf`, not by
      `pnpm test` or CI. The backend's 50 ms example-catchment budget
      then failed even alone (median 75–80 ms, 2026-09-26): the run had
      grown feature by feature, not through one bug. Bisecting the first
      example's GR4J run (warm, outside vitest) found two steps, B4
      multi-day accumulations (merge b042b363, ~49 → ~54 ms: a second
      CHIRPS fit) and WP-3.4 assurance of supply (merge c789b325, ~62 →
      ~70 ms: the water account), on top of a steady climb as each WP
      added output series. The profile's costs were generic, not new
      physics: copying ~150 output series (≈ 830 000 values) with
      `Array.from` on typed arrays (~14 ms), `monthOfEpochDay` /
      `waterYearOf` allocating a `Date` per call in every per-day loop
      (~5 ms), and the water account's per-day keyed sums (~5 ms). Fixed
      at the source (an indexed copy, integer calendar arithmetic checked
      against `Date` day by day, column-wise sums in the same node order,
      and the CHIRPS fit working out each day's water year once); every
      output is bit-identical (hash of the full output of all three
      examples × both runoff models), so no ENGINE_VERSION bump. Warm run
      ~63 → ~27 ms; the test's own median 75–80 → ~42 ms. What is left
      above the warm figure is JIT warm-up: the test times runs 2–8 of a
      fresh process, and the first few run at 55–75 ms before V8
      optimises the run path. Run it alone.
- [x] **Frontend bundle split by tab** (2026-09-24): the catchment
      workspace loads each tab (and the Add data / series preview dialogs)
      on demand (`common/Lazy.svelte`, architecture.md § Code splitting).
      Largest chunk 130 → 37 KB (ceiling 41 KB); opening a catchment ~298
      → ~89 KB. The total was already 383 KB against a 295 KB ceiling on
      main (help centre, new tabs' code, engine code), so its ceiling went
      *up* to 411 KB (405 KB measured).
- [x] **Bring the total bundle down** (issue #9, 2026-09-25): −6 KB (419 →
      413 KB on main at merge; main had already passed the old 411 KB ceiling,
      now 419), from `build.target: 'es2022'`. Help tips
      load the help text off the critical path (−26 KB on each tab with a
      tooltip; the total doesn't move). Measured and rejected, with the numbers
      in the guard's change log: sharing the engine with the calibration
      worker (−13 KB total but +23 KB on a catchment's cold open) and
      `experimentalMinChunkSize` (1–4 KB, cold loads grow).
- [x] **Engine code followed phantom imports into pages** (issue #9 second
      pass, 2026-09-26): Rollup treated every engine module as possibly having
      side effects, so a page that reached a module through the
      `@water-management/engine` barrel depended on it without calling it.
      `frontend/vite.config.ts` now marks the engine side-effect free
      (`frontend/src/lib/engineSideEffects.test.ts` fails on any top-level
      statement in `packages/engine/src`). First loads: farm pages −13 KB,
      share −13, home −9, a catchment −8 (that code now loads with the Data,
      Settings and Runs tabs, +6 each). The total stays 815 KB.
- [x] **Stop shipping the engine twice** (issue #9, done 2026-09-26; numbers
      in the bundle guard's change log). The calibration worker is an entry
      of the page build (`frontend/vite.config.ts`, `autocalWorkerChunk`; the
      page takes its URL from `virtual:autocal-worker-url`), so it imports the
      engine code it shares with pages from shared chunks instead of carrying
      a 62 KB copy. First, the small things pages read moved out of the
      modules that hold the run, fit and ensemble code, since a chunk holds
      whole modules: `version.ts`, `prepare.ts`, `calibrate/params.ts`,
      `calibrate/objectives.ts`, `runoff/params.ts`, `runoff/pet.ts`,
      `reference/wr2012Settings.ts` (+ `wr2012Resolve.ts`),
      `uncertainty/options.ts`, `network/damCurve.ts`, and `waterYearOf` /
      `waterYearLabel` into `calendar.ts` (docs/architecture.md § Code
      splitting; `frontend/src/lib/engineSplit.test.ts` keeps them apart).
      Measured against main @ e9c88b2, gzip: total 919 → 899 KB; compare
      114 → 92; a catchment on Runs 256 → 249; report 192 → 187; Settings
      212 → 211; home, farm, share and the other tabs within ±0.6 KB. The
      trade-off: the Data tab 195 → 197 and its series preview 210 → 214,
      where engine code the worker also runs is now several small shared
      chunks. A fit started from Settings fetches 45 KB of worker code (was
      62); a cold worker with nothing cached is 74 KB over 23 files. The
      guard's worker ceiling is now 35 KB (the worker's own code, 33), and it
      fails if the worker stops importing from `chunks/`. The spreadsheet
      workers stay separate bundles: the export worker imports only engine
      types, and the import worker's engine code (date helpers,
      `zeroRainRuns`, two farm constants) is ≤ 6 KB gzip, where sharing would
      bring whole engine modules and more requests into a one-off download.
- [x] **The Runs tab no longer carries the whole help text** (it was 26 KB
      gzip on top of the page, through `WaterStoryPanel` → `PictureTour` →
      `lib/help/guides.ts` → `lib/help/content.ts`). Fixed by removing the
      "Where the water went" panel, which repeated figures the summary cards,
      the self-checks' water balance and the runoff model panel already show;
      no project-page component imports `lib/help` now. If PictureTour comes
      back to an app page, give it a small `id → title` map for its guide links
      first, so it stops importing `guides.ts`.
- [x] **Win back bundle weight** (issue #9 third pass, 2026-09-26): total
      977 → 887 KB gzip merged over main @ ed1d29a (970 → 880 on 1ded742),
      from a per-module attribution of a sourcemapped build (numbers in the
      bundle guard's change log). The
      run export writes its own OOXML (`spreadsheet/export/writer.ts`, the
      bytes SheetJS wrote, pinned by a byte-for-byte test against the old
      path): export worker 88 → 10.5 KB. Svelte's runtime ships as one
      chunk (`svelteRuntimeChunk`): −12 KB total and every first load 3–6 KB
      lighter. The spreadsheet workers now get the engine treeshake rule
      (−0.7 KB). Ceilings: total 892, spreadsheet worker 32.
- [x] **Component CSS repeated across files** (issue #9, 2026-09-26):
      `.small` (53 copies), `.u` (22) and the `.seg` segmented control (5)
      now live once at the end of `app.css` (architecture.md § Shared CSS),
      pinned first by `e2e/tests/shared-css.spec.ts` (light/dark,
      phone/desktop, the report in print, the override editor's
      three-button switch). Total −1.0 KB gzip (over origin/main @ 1a8d058:
      891.7 → 890.7 KB, 913 069 → 912 108 bytes), not the 2–3 KB estimated:
      most copies sat in shared chunks where gzip already folded them. Runs
      and the report load 0.2 KB less, Network, Data and Settings 0.1; pages
      that use none of them (home, sign-in, /farm, /share) ~0.06 KB more. A
      computed-style crawl of 15 screens × 2 themes × 2 widths (1 328
      elements) matched before and after except two intended changes: the
      Network tab's three-button layout switch (since replaced by the map,
      issue #17) squared its middle button, which had all four corners
      rounded, and four components that wrote `class="muted small"` with
      no `.small` rule (History, the Runs tab's run-inputs panel, Yield,
      Forecast) now render it small. Measured and not moved: the spinner
      (−0.3 KB total, +0.1 KB on /farm, /share and sign-in), `.stat dd.sub`
      (−0.07 KB; would leak into three components that style it their own
      way), the Settings sections' repeats (one lazy chunk already).
- [x] **Cut weight for issue #17's pages** (issue #9, 2026-09-26): total
      966 722 → 953 006 bytes gzip (945 → 931 KB by the guard's rounding;
      ceiling 949 → 935), from a per-chunk and per-module attribution of a
      sourcemapped build. The weight left is mostly content (help text
      62 KB, uPlot 22, Svelte's runtime 21, SvelteKit's client 11) and
      split overhead (~63 KB in the JS, ~30 KB in 109 CSS files), not dead
      code: tree-shaking already drops unused exports and components, no
      module ships twice outside the two spreadsheet workers (~1 KB), and
      no global CSS class is unused. Removed: preload lists without chunks
      the importer already has (−2.3), the Runs tab's six always-rendered
      panels back in its chunk (−6.8), the report's server-PDF controls in
      its chunk (−0.4), Svelte's scoping class `s<hash>` (−2.6), 7-character
      file hashes and CSS files by hash alone (−2.7) (architecture.md §
      Code splitting). Moved: the Invite farmers dialog is its own chunk
      (+1.2 total), taking the workspace page chunk 40.7 → 38.5 KB. Numbers
      per step in the bundle guard's change log.
- [x] **Per-chunk ceiling vs always-rendered lazy panels** (issue #17,
      2026-09-26). The bundle guard now measures the workspace tab chunks
      (the modules the catchment page's `LOAD` map imports lazily, found
      through the chunk map `vite.config.ts`'s `chunkModuleMap` writes to
      `.svelte-kit/output/client/.vite/`) against a 60 KB ceiling of their
      own, apart from the 42 KB page and route ceiling; it fails if it finds
      no tabs, a tab in more or fewer than one chunk, or a tab in the
      workspace page's chunk. The Settings tab took back its data feeds,
      scheduled reports, API keys, outcome and outlook settings and
      pan-coefficient helper (~−6.5 KB total; the tab 57 KB), the Runs tab
      its plausibility checks (~−1.3 KB; 27 KB). The uncertainty and outcome
      panels this entry counted for Runs had already moved into the River &
      reserve tab's chunk. Total 987 → 979 KB (numbers in the guard's change
      log). Left as they are: the Overview's lazy panels (Flow vs reserve,
      Supply by farm, Share links) would fold into the workspace page chunk,
      the one every catchment's cold load pays for, under the page ceiling;
      and Flow vs reserve and the water-year bars are shared with other
      tabs, so they stay chunks of their own.
- [x] **Compare runs' always-rendered lazy panels** (issue #17,
      2026-09-27). CompareView imports the paired uncertainty band, the
      daily series overlay and the days below the reserve each year
      statically: every comparison renders all three. The band (used only
      there) is now in Compare runs' chunk: 14.3 + 1.7 CSS → 17.1 + 1.8 CSS
      KB, under the 60 KB tab ceiling. The overlay and the reserve years
      stay chunks of their own, since the Scenarios and River & reserve
      tabs load them lazily, but Compare runs now preloads them with its
      chunk instead of fetching them after it renders. Total 1 051 240 →
      1 049 897 bytes gzip (−1.3 KB, 319 → 315 files); `/compare`'s cold
      load with everything it renders 154.2 KB in 65 files → 153.0 KB in
      61, with no second round of requests.
- [x] **The home page loads the import dialog on demand** (issue #9,
      2026-09-26). It was estimated at ~7.5 KB; with the engine's series
      provenance and kinds code only it used, home's first load fell 81.5 →
      65.5 KB gzip. The total rose 889.4 → 891.5 KB (extra chunks; no
      ceiling moved). Warmed on hover or focus of the import buttons;
      `project-import.spec.ts` pins the keyboard path (Enter opens, focus
      moves in, Escape closes and returns focus) and a failed download;
      `components/import/homeSplit.test.ts` keeps the page off the import
      code. Pinning the keyboard path found that `Dialog` couldn't be
      reopened straight after Escape (its `close` event is queued, so the
      bound `open` lagged); it now follows `cancel` too.
- [x] **A failed chunk download can't be retried without a reload.**
      `common/lazy.ts` forgets a failed import and `Lazy.svelte` offers
      "Try again", but browsers keep a module that failed to fetch in the
      page's module map (HTML spec; checked in Chromium with the home
      page's import dialog), so the same `import()` fails again at once and
      "Try again" never recovers. The home import dialog offers a reload
      instead. Durable fix for the workspace: have `Lazy.svelte`'s retry
      reload the page when nothing is unsaved, or tell the user to save and
      reload when something is (the save bar knows), and correct the
      comment in `lazy.ts`. Trigger: the next change to `Lazy.svelte`, or
      a report of a stuck "Try again".
      **Done 2026-09-26:** a failed chunk now says what failed and offers
      **Reload page** (`common/ChunkFailed.svelte`), never "Try again", and
      never reloads by itself. With unsaved changes it says so; the reload is
      a plain `location.reload()`, so the page's `beforeunload` guard asks
      first (`provideUnsaved()` in `common/chunkFailed.ts`: the workspace's
      model editor and a scenario's override editor). No "Save, then reload"
      button: the save bar stays on screen, and saving can be refused (model
      issues), so the user saves and then reloads. `lazy.ts` says why a
      rerun or a cache-busting URL can't recover. The third, fourth and
      fifth users made the shared piece: `Lazy`, the home import dialog, and
      three sites found on the way that had the same bug: the workbook
      reader in the import dialog (a failed download left it stuck on
      "Reading…" with the file input disabled), Overview's "Set up alert
      emails" (did nothing), the report's human-impact tables and the root
      layout's language catalogue ("Try again" that couldn't work).
      `e2e/tests/lazy-chunk.spec.ts` pins them (the layout's catalogue
      aside: its chunk has no name or content a test can block it by).
      Total bundle 891.5 → 892.8 KB gzip.
- [x] **Three dynamic imports still report a failed chunk as a raw error.**
      The run's workbook export (`export/DownloadMenu.svelte`, "Workbook
      failed: Failed to fetch dynamically imported module …") and the
      account's data export (`routes/account/+page.svelte`) show the
      browser's message, and pressing again fails the same way; the
      verify-email banner (`routes/+layout.svelte`, `{#await import(…)}`)
      is silently missing. Nothing is stuck or lost. Durable fix: catch the
      `import()` on its own and say it the `ChunkFailed` way, as the
      workbook reader now does. Not done with the rest because each needs
      more than a swap: the menu's status line is an inline `aria-live`
      span with no room for an alert and a button, and the account page is
      a translated surface, so its message needs `t()` wording and the
      translation sheet (`ChunkFailed` is English, which the layout's
      catalogue failure can use only because the catalogue is what failed).
      The banner may well stay silent (a reminder, not the page). Trigger:
      the next change to either export or the banner.
      **Done 2026-09-26:** all three say it the `ChunkFailed` way. The
      workbook download shows a compact alert below the menu (the status
      line keeps its own errors). The account page words it with `t()`
      (`ChunkFailed` now takes `text` and `reload`), on the translation
      sheet. The banner says so in its place rather than vanishing, since an
      unconfirmed address holds back pending invitations; the layout words
      it with `msg()` through the i18n module when the page loaded it, else
      English. `lazy-chunk.spec.ts` covers each. Total bundle 894.0 KB gzip
      (the guard rounds up and prints 895, its ceiling: under 1 KB left).
- [ ] Soak the fuzz tests after any engine change:
      `FUZZ_CASES=20000 pnpm -C packages/engine exec vitest run src/fuzz`
      (the random cases moved from `run.invariants.test.ts` into the shard
      files; GR4J only since engine 1.0.0). **Engine 1.0.0 (2026-09-26,
      issue #16): 20 000 cases with `FUZZ_MAX_FAILURES=100` passed** once
      seed 2909 was fixed: the doubled-crop-area law is now checked with
      annual borehole caps off, since more demand uses a cap up earlier and
      moves the lagged stream depletion in time (the cap working, present
      on main before #16; `checkGroundwater` still checks the caps).
      **20 000-case soak on engine 1.20.0 (2026-09-28, issue #68,
      `FUZZ_MAX_FAILURES=100`, seeds 1–20 000, 13.5 min): failed on 5 seeds**,
      tracked in issue #164: the doubled-crop-area law on 4536, 10028 and 11421
      (rises up to 0.29 → 0.49, too large to be noise) and ulp-scale noise on
      10306 (a depletion infeed of 1e-6 with nothing pumped) and 15467
      (supplied 1 ulp above demand). No soak since 1.0.0 had scanned
      seeds above 2 000, so any engine from 1.1.0 to 1.20.0 may have introduced them.
      **Diagnosed and fixed (2026-09-29, engine 1.24.0).** Bisected over the
      engines with history (1.2.0, then 1.15.0–1.20.0; 1.3.0–1.14.0 were
      squashed by the repo recreation): all five pass on 1.2.0; 4536, 10028,
      11421 and 15467 fail from 1.15.0 and 10306 from 1.19.0, and the
      diagnosis names the feature behind each. **4536, 10028: the law, not
      the engine.** A primary dam-target borehole tops the dam up only on a
      day it is drawn for demand (engine 1.8.0), so more demand switches it
      on like a drought trigger, and the stored groundwater seeps on
      downstream or its stream depletion lands on a flood day. The law now
      runs those units as supplemental (`droughtBoreholesAsSupplemental`).
      **11421: engine float noise.** Behind that trigger it was seed 1774's
      noise again (a supplemental top-up leaving the demand an ulp of a
      1.4e6 m³ dam short), now counted as failed days of time reliability.
      Fixed in `groundwaterDay`: a unit that pumped all it was asked for
      leaves the dam supplying the demand exactly. **15467: engine float
      noise.** Off-take water used + the rest rounded one ulp above demand
      (engine 1.14.0); the supply is clamped to D. **10306: check noise.**
      `checkGroundwater` works the infeed back from a 6.2e9 m³ depletion
      deficit, and its tolerance now includes that scale. Each seed is a
      named test (`run.invariants.test.ts`, `boreholes.test.ts`).
      **20 000-case soak on engine 1.24.0 (2026-09-29,
      `FUZZ_MAX_FAILURES=100`, seeds 1–20 000, 4.8 min on four shards):
      passed.**
      **Owed for engines 1.1.0 and 1.2.0** (2026-09-27, superseded by the
      1.20.0 soak above): no 20 000-case soak
      is recorded since 1.0.0. Machine time only (15–20 min);
      run it on its own, not beside e2e or another session's tests.
      **Engine 1.3.0 (issue #64, 2026-09-27): a 2 000-case soak** (the new
      rule-table charge and base-flow modes drawn in) passed except **seed
      1774**, which fails with or without them (it has no rule table):
      doubling crop areas raised n14's supply fraction 0.9999999999964 →
      0.9999999999984, a 2e-12 rise. **Diagnosed and fixed in the check
      (2026-09-27, no engine change):** float noise. n14's dam seeps all it
      holds each day and a supplemental dam-target borehole (1e9 m³/day,
      cap off under `droughtBoreholesAsSupplemental`) refills it to dead
      storage + demand ≈ 2.19e5 m³, so `avail + gd − dead` returns the
      demand only to an ulp of 2.19e5 (2.9e-11 m³). Every short day was a
      top-up day, none short by more than 1.49 ulp; Σ(D − G) ≈ 2.1e-9 m³ in
      both runs over Σ D = 639 → 1278 m³, so 1 − fraction halved. The
      noise is absolute, not relative to demand, so `checkDoubledCropAreas`
      now allows each fraction (and volumetric reliability) 4ε × the farm's
      largest volume ÷ its mean demand (floor 1e-12), the catchment's
      likewise; a named seed-1774 test pins it, and the real rises in
      `boreholes.test.ts` still fail the law. A 2 000-case soak on 1.5.0
      (`FUZZ_MAX_FAILURES=100`, seeds 1–2000) then passed. The
      20 000-case soak is still owed.
      **Seed 921 fixed in engine 0.19.0** (2026-09-24): the transfer room
      cap (N4) ignored the receiving dam's own rain, evaporation and
      seepage, so a leaky dam was topped up short by a fixed volume and
      doubling demand raised its supply fraction. The room is now
      `cap − (Q[t−1] + Pd − E − Sp) + D − scheduled` (model.md §2.6),
      `checkTransferLimits` reads it the same way, and a named seed-921
      test pins it. A 2 000-case soak on 0.19.0 passed for both runoff
      models.
      **20 000-case soak on 0.19.0 (2026-09-24) failed**, stopping at the
      3-failure cap per model (legacy scanned seeds 1–8984, GR4J 1–17277),
      so later seeds are unscanned. **20 000-case soak on 0.21.1
      (2026-09-25, `FUZZ_MAX_FAILURES=100`, seeds 1–20 000):** GR4J passed;
      legacy failed on one seed, 14313 (order invariance, below). Repro any seed with
      `FUZZ_SEED=<n> FUZZ_CASES=1 pnpm -C packages/engine exec vitest run src/fuzz`.
- [x] **Order invariance: EWR days not met off by one (seeds 4014, 8984,
      9681).** Fixed in engine 0.19.1 (2026-09-25). The cause was not the
      summing order of E but which farms counted as having an impact at all.
      A farm's net impact e was called noise only against its own *flows*, and
      two cases slipped through: a full dam spilling its runoff (e = I − spill
      cancels at the scale of the storage, ±1e-11, seed 4014), and an empty farm
      below one whose outflow carried a 1e-13 residue (seed 8984). Either came
      out positive in one node order and 0 in the other, so the farm was charged
      for a day. `network/attribution.ts` now sizes the noise by every volume in
      the balance: the farm's flows, its dam storage (today and yesterday) and
      the flows and storage of the nodes draining into it. The threshold is
      applied before E is summed, so Σ charges = D* still holds. Two scales
      that were tried and rejected: every upstream farm's flows, and the
      site's shortfall D. Both are too coarse and zeroed real impacts on fuzz
      networks. **0.19.2 (same day):** the 20 000-case soak showed 0.19.1's
      1e-12 of dam storage was still too coarse (it zeroed real ~1e-6 m³
      impacts beside a 10⁶ m³ dam; seeds 9051, 11240, 15426 failed
      `checkEwrAttribution`), so the storage and upstream terms now use
      `RESIDUE` = 1e-14 (~45 ulp), the size of the residues actually seen. Tests: `attribution.test.ts` › "a float residue at the scale
      of a dam or an upstream flow is not an impact", `run.invariants.test.ts`
      › "engine 0.19.1: …" pins the three seeds.
- [x] **Doubling crop areas raised supply by 0.0015–1.5 pp (seeds 4197,
      7686, 15979, 17277).** Fixed in engine 0.21.1 (2026-09-25); an engine
      bug, not hydrology, so `checkDoubledCropAreas` is unchanged. The
      earlier guess (rain on the dam, dead-storage threshold days) was the
      symptom: in all four the doubled run's dam was *fuller* than the base
      run's on some days. Ablation: every seed passes with dam evaporation
      off, with no dam surface, or with every b = 0.7; each had a dam with
      b > 1 (3, 2.34, 3, 3) and a mean depth of 0.5–32 mm. The daily step
      applies the start-of-day surface to the whole day, so for b > 1
      `Q[t−1] − E − Sp` falls as `Q[t−1]` rises once a day's evaporation
      exceeds 1/b of the dam: seed 15979's base dam (149 m³, b = 3, 1.6 mm
      deep when full) evaporated entirely while the doubled run's slightly
      lower one (144 m³, 10 % less surface) kept 3 m³, and over ~20 days the
      farm got more than twice the water (0.838 → 0.870). Rain on the dam had
      the right sign throughout (a lower dam caught less, until the
      inversion made it the fuller one). The real process, a dam evaporating
      as its surface shrinks, is order-preserving for any b, so this is the
      scheme's artefact. Fix: for b > 1, E ≤ (1 − seepage) × Q[t−1] / b
      (`network/simulate.ts` `damDay`, `verify/checks.ts`, the day-trace
      formula; model.md §2.7a, engine-audit.md N2); never binds for b ≤ 1.
      `persona-hydrologist` (simulated, 2026-09-25) agreed it is an artefact,
      rejected neutralising it in the check, called the cap defensible as a
      documented limiter (it understates evaporation on extremely shallow
      dams; the uncapped step overstated it), and recommended narrowing the
      range to b ≤ 1 (next item). Tests: `run.test.ts` › "engine 0.21.1:
      with b > 1 a fuller dam never ends the day with less water",
      `run.invariants.test.ts` › "engine 0.21.1: doubling crop areas …".
      The random-cases tests' failure cap is now `FUZZ_MAX_FAILURES`
      (default 3; model.md §6).
- [x] **Order invariance: a transfer source at its reserve (legacy seed
      14313).** Found by the 20 000-case soak (2026-09-25; the earlier soak
      stopped at seed 8984). The only rule into a farm drew from a dam sitting
      exactly at its reserve, so `free = Q_src[t−1] − reserve` came out as 0
      or as one ulp depending on node order, and attribution charged that
      residue to the receiving farm. **Fixed in engine 0.21.1:**
      `network/attribution.ts` sizes the noise by the dams at both ends of the
      day's transfers too, the same `RESIDUE` rule as 0.19.2. Pinned in
      `run.invariants.test.ts` beside the 0.19.1–0.19.2 seeds.
- [x] **Order invariance: Reserve rule tables (engine 0.24.1, 2026-09-25).**
      The first 20 000-case soak with rule tables in the fuzz generator
      failed on 18 seeds per model. Two tables for one site were resolved by
      list order (now neither is used, with a warning; the API already
      refused such a list), and a site's natural flow summed in display order
      moved the percentile across a flat stretch of the table's natural
      curve (now summed in node-id order, and a flow within 1e-12 of a curve
      point counts as reaching it). Seeds 3238, 6191, 17126, 18472 pinned in
      `run.invariants.test.ts`; the flat-curve case in `assurance.test.ts`.
- [x] **Order invariance: list-order float sums tipped thresholds (engine
      0.26.1, 2026-09-25).** The first 20 000-case soak generating other
      users, boreholes and land cover (engines 0.22–0.24) failed order
      invariance on 11 legacy and 16 GR4J seeds with real differences
      (outflow 7988 vs 8469 m³/day, a dam's area 73.6 vs 0, a user's EWR days
      not met 209 vs 210). One mechanism throughout: sums over lists in
      display order (the farms' flow shares and the catchment area Σ farm
      area, a farm's crops and crop areas, the senior users' claims and
      upstream share totals, land-cover patches, transfer rules, the EWR
      attribution's impacts) differed in their last bit when the lists were
      reordered, and a threshold turned the ulp into a result: a dam sitting
      exactly at its drought-borehole trigger (seed 3899: 481.22408531730883
      vs …088 m³, 116 938 m³ pumped in one order, none in the other), a dam
      running dry in one order and keeping a residue with a surface in the
      other (5703, 15208, 17002), the catchment area and so every natural
      flow (7094). None of the new elements had an order rule of its own
      that was wrong (users are served by position, boreholes are per node,
      patches add linearly); the noise predates them, they only added the
      thresholds that amplify it (and 14313 above was the same class).
      **Fixed at the source:** every sum feeding the balance runs in id
      order (`packages/engine/src/order.ts`; model.md §6 "The ordering
      rule"), and `checkOrderInvariance` now requires every daily series to
      be **bit-identical** in any display order, so a new list-order sum is
      caught even where no threshold amplifies it (the summary keeps its
      float tolerance). No documented result changed (engine-audit.md
      unchanged): only last bits and the tied threshold days move. Tests:
      `order.test.ts` (one case per sum, on values whose sum depends on the
      order), `run.invariants.test.ts` › "engine 0.26.1: …" pins the seeds
      of both models; `runoff/legacy.test.ts` now adds the area in id order.
- [x] **Dam area exponent above 1** (done 2026-10-01, engine 1.63.0, issue
      #90; provisional decision, to be confirmed by the client's hydrologist).
      Narrowed to 0 < b ≤ 1 (`DAM_AREA_EXPONENT_MAX`) in zod, the node form,
      the frontend model check and the scenario ops; `damLosses` runs an
      older document's b > 1 as entered, with the limiter and a warning that
      a save now needs b ≤ 1; the engine's random-network soak still draws b
      up to 3 for those documents, the scenario fuzz only up to 1. No
      migration: every write path (the model PUT, a project import, a history
      restore) parses through `ModelBody`, so the column's wider check holds
      only rows from before, and nothing is deployed yet. Was: validation
      allowed 0 < b ≤ 3
      (migration 006's check, `backend/src/model/validate.ts`,
      `frontend/src/lib/model/validate.ts`, `run.ts` `damLosses`,
      `verify/checks.ts`), but a single area–storage power law with b > 1 is
      not a real basin: any area–stage power law A ∝ hᵐ gives b = m/(m + 1)
      < 1, and published small-reservoir fits give b ≈ 0.65–0.85 (Liebe et
      al. 2005: 0.70). b > 1 happens only locally (a flat shelf at the top),
      which a power law can't represent anyway; that needs a stage–area–volume
      table. The persona hydrologist recommends narrowing to 0 < b ≤ 1: a new
      forward-only migration adding the tighter check `NOT VALID`, reporting
      or clamping rows above 1, then `VALIDATE`; the same bound in zod, the
      frontend, `damLosses` (warning) and the fuzz generator; the 0.21.1
      limiter stays for runs saved before. Deferred because it narrows what
      users may enter, so it is the real hydrologist's call. Trigger: the
      hydrologist review of N2 (engine-audit.md), or the first real dam
      entered with b > 1. (Resolved as above; the migration it proposed
      proved unnecessary.)
- [x] **Excel audit workbook export** (issue #68, 2026-09-29; the operator
      asked for it ahead of the trigger below). The Runs tab's Download menu
      offers **Audit workbook — *unit* (.xlsx)** after each farm's daily CSV:
      the chain F … AA as live Excel formulas over the farm's inputs (the
      catchment's rain, the evaporation depth, gross demand, effective rain
      used, the demand factor, H, I, J, Z as values), the dam storage carried
      from row to row, a Model sheet with the run's numbers and a daily
      largest-difference column (`verify/audit.ts`, `lib/spreadsheet/audit/`,
      api.md § Export). Written by the app's own OOXML writer (formula cells
      added; no SheetJS in the app); the bulk route pages the fetch, so the
      5 MB limit doesn't bind. The formulas are one expression tree that the
      engine evaluates, held to `runModel` on random networks. AB (a
      diagnostic that needs every upstream AA) is left out. It doesn't
      replace the `verify/` Python cross-check: the operator chose to rebuild
      that too (2026-09-30), and the two are complementary, one farm's
      formulas in Excel against the whole network from the docs (§ Verification).
      Original entry: an `.xlsx` for one farm, inputs as values, each working
      column as a live formula and a column comparing Excel's value with the
      model's, so Excel recomputes the model independently. Trigger was: after
      the client catchment run and the hydrologist persona review confirm it's
      wanted.
- [ ] **Audit workbook: the farms it refuses today** (from issue #68). The
      workbook names and refuses a farm with boreholes, a release rule, a
      river pump, river off-takes, demand objects, senior users downstream,
      an allocation cap, a storage reset, a survey curve, a daily A-pan
      series on a dam, or a dam capacity that changes over the run (sediment,
      an in-service date), since its formulas carry the b023 core only. It also
      takes gross demand, the effective rain used and the open-water
      evaporation depth as values (headed "From the run"). Durable fix:
      grow `farmAuditPlan` feature by feature (the checkWorkings replay is the
      reference for each: release, then the river pump and boreholes, then
      off-takes and demand objects), recompute gross demand from the crops
      sheet and the soil-water store from `rain_final` as `checkSoilWater`
      does, put the lake factor and the monthly A-pan on the Parameters sheet
      so the evaporation depth is a formula, and store the day's evaporation
      depth on the run so a daily A-pan series needs no refusal. Each step keeps the random-network
      test green. Trigger: the first licence-evidence run on a farm the
      workbook refuses, or a hydrologist asking for the demand side in it.
- [x] **Trace the runoff side** (2026-09-24): `/day` without `nodeId`
      traces the catchment (GR4J stores before/after, exchange, UH, natural
      flow, and the store balance with its residual; legacy runs list the
      [Flow data] columns). Column catalogues `GR4J_COLUMNS` /
      `LEGACY_RUNOFF_COLUMNS` in `verify/columns.ts` (ui.md, api.md).
- [x] **Per-store starting values on a run's first day** (engine 1.20.0,
      issue #67): the run's summary records each store after the warm-up
      (`summary.runoff.storesStartMm`, summing to `storageStartMm`, checked
      by the runoff self-check), and day one's catchment trace starts from
      them store by store. A run from before keeps the "–" and the total.
- [x] **Alert on a failed self-check in production** (2026-09-24):
      `executeRun` logs `{ event: "self_check_failed", projectId, runId,
      checks }` (check ids only), and `infra/alarms.tf` has a metric filter
      + alarm on the alerts SNS topic (plan-tested; not applied).
- [x] **Hydrologist persona review of the Self-checks panel and exports**
      (2026-09-27, #17). A persona draft (the `persona-hydrologist` point of
      view over the three seeded examples, run through the engine and the
      export builders), not the real hydrologist's sign-off. What a
      hydrologist checks first, and what it found:
      - *Mass balance closure*: answered. Residuals are float noise (whole-run
        ≤ 1e-10 m³, largest farm-day 2.3e-10 m³/day on Kleinberg), in the
        panel, the summary CSV and column V of every farm day. **Defect,
        fixed:** the panel's balance table and the CSV's equation row left
        out terms the residual counts (groundwater, other users, stream
        depletion, seepage lost, storage set; the CSV had no storage-set
        column at all), so a row with them didn't add up by eye. Both now
        show a column for each term the run has and name exactly those
        terms in the equation.
      - *Units*: every daily column carries its unit and FarmTemplate
        letter. **Defect, fixed:** the summary CSV wrote a dozen computed
        figures under raw engine keys with no unit (`kge`, `logEpsilonM3s`,
        `volumeErrorPct`, `runoffCoefficient`, `damEndM3` …); all are
        labelled now, with a test that no raw key is left in the
        calibration block.
      - *Storage bounds*: the self-check covers it, but a reader couldn't
        check it from the files: **fixed**, the summary's farm table has
        `Dam capacity (m³)` (from the run's own model) beside the dam's
        storage figures.
      - *EWR*: **gap, fixed:** the outlet EWR test on the observed record vs
        the simulated outflow (issue #4) was computed but silently dropped
        from the summary CSV (an object, skipped); it is now a block under
        Catchment, whole record then each water year. So were the
        calibration exclusions and the annual observed-vs-simulated volumes
        (arrays): both are written now.
      - *Gap-filling provenance*: answered (rain-source, rain treated as
        missing, accumulation and CHIRPS-factor blocks; the catchment daily
        CSV's rain-source and missing-day columns).
      - *Which run and engine*: the summary CSV says (and now names the
        runoff model); the panel now says which engine ran the checks. The
        daily CSVs still don't (next item).
      - *Wording*: the panel said "farm" where the workspace says "unit";
        it reads "unit" now (`checkLabel`), the CSV keeps the API's "farm".
      **Is the Excel audit workbook worth a day?** Yes, but not before the
      real hydrologist reads this: the checks show the model agrees with
      itself, and only a recompute in someone else's tool shows it agrees
      with its formulas. Note it also needs each farm day's *inputs* (rain,
      A-pan, crop areas and factors), which the farm daily CSV doesn't carry
      (it starts at gross demand), so the file can't be recomputed alone
      today. Trigger unchanged (above), plus the first run nominated as
      licence evidence.
- [x] **Say which run and engine made a daily CSV, inside the file**
      (2026-09-27, operator go-ahead the same day for a `#` line on every
      daily CSV): `daily.csv` and `farms.csv` lead with
      `# run=…; engine=…; runoff_model=…; created=…; period=…` (a farm's
      `daily.csv` also `dam_capacity_m3=`), after the legacy warning on a
      legacy run; values percent-encoded so a label can't break the line or
      start a formula (`backend/src/export/csv.ts` `runProvenanceComment`);
      `lib/export/dailyTable.ts` reads every leading `#` line; api.md § Export
      (`pandas.read_csv(…, comment='#')`). The farmer's own
      `…/farm/:nodeId/export.csv` carries no provenance line (since #124 it
      is the last year in whole m³, its columns named by the farm page in
      the reader's language): it serves the published figures, and the farm view carries no run label, only the publication
      and its engine version. Original entry: The
      farm and catchment daily CSVs (`daily.csv`, `farms.csv`) carry the run
      only in the file name, which is lost the moment the file is renamed or
      pasted into a workbook; the summary CSV has the full provenance. The
      durable fix: a leading `# run=<label>; engine=<version>;
      runoff_model=<m>; created=<iso>; period=<start>..<end>` line (plus
      `dam_capacity_m3=` for a farm), the same shape as the legacy-run line
      (audit H1), with `lib/export/dailyTable.ts` taught to take more than
      one `#` line and the DB tests and `e2e/tests/forecast.spec.ts` that
      read row 1 as the header updated. Not done in the review because it
      moves the header off row 1 for *every* file, which breaks a plain
      `pandas.read_csv` without `comment='#'`: the operator's call.
      Trigger: the operator (or the real hydrologist) confirms the `#` line
      is acceptable on every file, or the first client hand-off of daily
      CSVs.
- [x] **See every input series and how the model used it** (2026-09-24):
      the Data tab's Preview dialog joins every input series by day with
      rain used and its source, CHIRPS factor and corrected value, flow in
      m³/day, per-series flags and calibration exclusions (ui.md). Its e2e
      spec `e2e/tests/series-preview.spec.ts` passes (2026-09-24); the dialog
      is now near full-screen (`Dialog` `full` size).
- [x] **More columns in the Data tab downloads** (the original request that
      led to the self-checks; built for issue #66 once the operator confirmed
      the columns on #93, 2026-09-29, engine 1.27.0; docs/api.md § Export).
      `GET /series/:id/export.csv` wrote only `date` + the uploaded value. It
      now adds how the model used each series: for
      rainfall, the rain used that day after gap-filling, which source filled
      it (catchment / corrected CHIRPS / forecast) and the rain after the
      threshold; for CHIRPS, the day's bias factor and the corrected value;
      for flow, m³/day, the data-quality flags (negative, outlier, flat),
      whether the day is excluded from calibration, and the latest run's
      simulated outflow. Model-derived columns name the run they came from;
      without a run, raw values plus quality flags only.

## Farmer view (WP-2.6, #25)

Left out of the first build because the contract or an API doesn't carry it
yet; each lands with the work package named.

- [x] **"Next 14 days"** (ForecastCard) on the main and dam pages: built
      with WP-2.12 (`farm.forecast` when the published run is a forecast run).
- [x] **Afrikaans notice on the farm page**: `FarmView` carries both
      (`noticeEn`, `noticeAf`, no more `?lang`); the page shows the one in
      the language the reader chose, marked with its `lang`, or the other
      with "The WUA wrote this notice in English only" (design §7). The
      saved copy moved to `wm.farm.saved.v2` (a v1 copy is dropped).
- [x] **"Who can see my hydrological unit" by name** (design §10.2): done (91b8b833):
      `GET …/farm/:nodeId/access` lists people by name and role, never an
      email, and the card falls back to roles if it fails
      (`farm-view.spec.ts` checks it).
- [x] **The WUA's name** in "Contact [WUA]" lines (issue #74):
      `project.wua_name` (095_wua_name), set as **WUA name** on the Project
      page's details and carried as `project.wuaName` in `FarmView` and
      `FarmIndex`; the contact lines name it, and say "your WUA" without
      one. Not the team's name, which may be a consultancy's.
- [x] **"Email me when …"** links for the notice and a low dam: alert emails
      (WP-2.13); the farm view's alert card and every alert email link to
      `/account/alerts`. "Email me when it's ready" (a report) is still open.
- [x] **"Not available: the model's data starts on …"** (issue #74): the
      projection carries the run's first day (`dataFrom`; a row stored
      before it gets it from `catchment_view.runStart`), and "Compared with
      last season" names it. A copy saved on the phone before it still says
      the data doesn't reach back.
- [x] **e2e on the full stack**: `e2e/tests/farm-view.spec.ts` runs in CI's
      e2e shards against the farm API and the seeded publication (1ab1896b,
      de671eb2).

- [ ] **A unit with demands on both its dam and the river: which side was
      short** (persona-farmer, round 4, 2026-10-02). Since engine 1.65.0
      (model.md §2.7j) a unit's crops or demand objects can each draw on a
      river abstraction beside its dam. The farm page's "Short on N days …"
      line still counts a short day "when your dam was down to its stop
      level" whenever the dam sat there, whichever side was short; a unit
      whose demands *all* draw on the river is already right
      (`season.onlyRiver`, the river's wording), and the dam's days left
      already divide by the dam's own draw (`damDraw`). What's missing is a
      per-side shortfall: the run publishes each abstraction's take
      (`river_take@`) but not what it was asked for after a drought
      restriction (the stored `object_demand@` is before the cut), so the
      projection can't tell a river-side shortfall from a dam-side one
      without guessing. Durable fix: the engine publishes each river
      abstraction's unmet demand (`river_short@<key>`, an ENGINE_VERSION
      bump), the projection counts the dam side's and the river side's
      short days apart, and the card gets a river reason ("… when the
      river or your pump couldn't give enough", through the i18n agents).
      Trigger: the client's first unit with both a dam-side and a
      river-side demand is published to its farmer.

## Afrikaans (WP-2.5)

Issue #49 (the translation turnaround) is closed: on 2026-09-26 every
farmer-facing string got Afrikaans, written by the `af-translator` agent and
reviewed by the `af-checker` agent ([ui.md § Language](./ui.md#language)).

The plumbing is built (catalogues, switch, `app_user.locale` /
`volume_unit`, locale-aware numbers; [ui.md § Language](./ui.md#language)).

- [x] **Translation turnaround.** All 607 rows of
      `docs/i18n/af-translation-sheet.md` (505 site messages, some with a
      row per plural form; 70 email strings; 8 glossary entries of three
      rows each) are in the three catalogues, through
      `pnpm gen:i18n:apply`; the sheet is empty. The plan's WP-2.5 e2e is
      `e2e/tests/language.spec.ts` (the sign-in page and the farm view in
      Afrikaans with `<html lang="af">`); the invite email is
      `backend/src/farms/invites.db.test.ts` (Afrikaans, `lang="af"`), the
      alert email `alerts-mailpit.spec.ts`.
- [x] **Afrikaans boards** at 360 px and an axe pass on every translated
      page in Afrikaans: `e2e/tests/af-layout.spec.ts`, light and dark, all
      green.
- [ ] **A native speaker's review** (tracked in issue #90, where the
      client answers it; moved off #74 by the 2026-09-30 fact-check, so #74
      no longer carries it). The Afrikaans is machine-written and
      machine-checked. The client confirmed (2026-09-28, issue #90) that
      their native-speaker translator (roadmap Step 2 prerequisite 6) will
      review it, the #47 liability lines included
      ([legal/disclaimer-review.md § 3](./legal/disclaimer-review.md)),
      before the first farmers are invited in Afrikaans. They read the three
      catalogues (`frontend/src/lib/i18n/messages/af.ts`,
      `backend/src/mail/i18n/af.ts`, `frontend/src/lib/help/content.af.ts`,
      each with the English beside every entry) and corrects them in place.
      The checker's open questions, to look at first: "Advies" for the
      Advisory level, "redigeerders" for the WUA's editors, "Model: tekort"
      as the model band, the ordinal day (`9d963c34`, a bare number, since
      `Intl.PluralRules('af-ZA', ordinal)` only ever picks `other`), and
      the upstream/downstream sentence, reworded as a label list
      (`7f35d413`). Added 2026-09-27 from the landing, sign-up and legal
      passes: the hero slogan "Elke druppel in die opvanggebied word
      verreken" (`633902ad`, and its alt text `2f037a30`: change both
      together); "punte" or "persentasiepunte" for percentage points (four
      places, the farm pages' `a3e2d360` included: change all or none);
      "magtiging vir watergebruik" or "watergebruiksmagtiging" (`7a517563`,
      the share page; it will spread to the licensing pages);
      "voorbeeld-opvanggebied" hyphenated or as one word (catalogue-wide);
      "Regsinligting" for the Legal nav (`de7530aa`); and "Bevestig
      wagwoord" on sign-up beside "Herhaal nuwe wagwoord" on the account
      page (deliberate: the English differs). Added 2026-10-01 from the
      "Was this useful?" pass (issue #74): "bestuur" for the people who run
      a catchment's alerts (`6bfb93ee`), and "aftekening" for a sign-off in
      the terms' "What changed" line (`71f9b9a7`, matching the run's
      "afgeteken"). The specs read the words from
      the catalogues, so a correction needs no test change. Trigger: before
      Afrikaans-speaking farmers are invited.
- [x] **Not yet in the catalogue**: the `/share` page (`share/share.ts`,
      `share.*` keys, with the switch in its header; it still imports none
      of the workspace's code, `boundary.test.ts`), the notes list inside
      "Notes about your hydrological unit" (`NotesList` takes a `words` prop: English
      `notes/words.ts` for the workspace, `farm/notesWords.ts` from the
      catalogue), and the server errors a farmer can see: the API sends a
      stable `code` (`ERROR_CODES`, [api.md § Errors](./api.md#errors)) and
      `lib/i18n/apiError.ts` words it, or the status, from the catalogue;
      the server doesn't localise ([ui.md § Language](./ui.md#language)).
      The new keys are on the sheet. The bundle measured 927 KB (926.5)
      against the 925 KB ceiling after this: see the next item.
- [x] **Bundle ceiling.** The catalogue and switch add about 10 KB gzip to
      the total (the English catalogue is ~7 KB; each key also appears at its
      call site). The catalogue now loads only on the translated routes (the
      workspace never downloads its ~8 KB chunk; `/share` does, now it is
      translated), but the guard
      counts lazy chunks too, so the split costs ~2 KB of total: 932 KB
      before, 934 KB after, against main's 929 KB ceiling (largest chunk
      43 KB, at its ceiling). Fitting under 929 without a raise needs weight
      removed, not moved: the durable option is English-as-key messages
      (gettext style: the English sits at the call site and `af.ts` maps it,
      so no separate English catalogue ships, ~5–7 KB), which reworks the
      catalogue, the sheet and the tests; build-time key shortening saves
      ~3–4 KB at the cost of a custom Vite plugin. Otherwise the operator
      raises `BUDGET.totalCodeKb` with a change-log entry. Trigger: before
      this branch merges to main.
      **2026-09-26 (i18n follow-ups branch):** translating `/share`, the
      farm notes list and the server errors (~86 keys, the error-code
      helper) cost about 2 KB; merged with main (ceiling 940 KB) the total
      measures 938 KB, largest chunk 42 KB (at its ceiling).
      **2026-09-26 (issue #9): English-as-key landed.** Each message is its
      English at the call (`t('Your dam')`), `af.ts` is keyed by an 8-hex hash
      of it (and a context where the same English means two things), and no
      English catalogue ships; the sheet reads the messages from the source
      (`scripts/guards/i18n_extract.mjs`; [ui.md § Language](./ui.md#language)).
      Measured on main @ 1ded742 (gzip): total 969.8 → 968.4 KB (−1.4, not the
      5–7 estimated: the keys are gone, but the English now compresses in
      many small chunks instead of one 11 KB catalogue chunk); first loads
      farm page 97.9 → 91.8, farm list 79.4 → 71.5, sign-in 71.5 → 63.0,
      account 71.6 → 63.8, `/share` 74.3 → 65.7, sign-up 74.3 → 66.3 KB. The
      catalogue chunk is gone; the message code is a 1.3 KB chunk. Build-time
      key shortening is moot: there are no keys left to shorten (the ids ship
      only as af.ts keys, one per reviewed translation).
- [x] **Help drift tooling** from the plan: `pnpm gen:i18n:stamp <id>`
      (`scripts/guards/i18n_stamp.mjs`) re-stamps a glossary translation's
      `sourceHash` from the current English and rewrites the sheet;
      `pnpm check:i18n` lists what has no Afrikaans and any stale
      translation, and fails on a stale one ([ui.md §
      Language](./ui.md#language)).

## UI

- [x] **"Unit" wording, the smaller choices** (from #54; operator, #93).
      Should engine run warnings and API errors say "unit" in the
      workspace, should the xlsx summary sheets say "Unit summary", and
      should a new node default to "Unit N"? **Decided (operator,
      2026-10-01): yes, keep, yes. Done:** the engine's run warnings and
      save errors and the workspace API's errors say "unit" (engine 1.61.0,
      words only); a new node is `Unit N`; the xlsx Summary sheet keeps
      "Farm summary", since it is the summary CSV's block and the CSV is a
      contract (ui.md § the words). The first automatic run after the
      upgrade reads the reworded warnings as new, so a person publishes it
      once.
- [x] **`projects.spec.ts` › *fifty projects › fit the window…* fails on
      `main`** (tracked on #76; seen 2026-09-27, not caused by it; fails the same on a clean
      checkout): at 1440 px the page itself scrolls 25 px, where the list
      should scroll inside its card and the page not at all; under load the
      row's More-actions menu also misses `aria-expanded="true"`. **Done
      2026-09-28.** The menu: the list's late scroll event closed the menu
      its own opening had scrolled into view (#101). The height budget: the
      card measured what sits below it from the document's `scrollHeight`,
      which counts the empty window under a short list, so after a search
      narrowed the list and was cleared the card stayed at its 320 px floor
      with the window empty below; it now measures to the end of the page's
      `<main>` and observes `<main>` too (`routes/+page.svelte`; the spec
      clears a search and checks the card refills). The 25 px page scroll
      no longer reproduces at 1440 or 1280, idle or under full CPU load.
- [x] **Thousands separator style** (issue #76, 2026-09-27; D10): a narrow
      no-break space (U+202F) app-wide, the original ask: the workspace's
      `fmtNum`, the farm view, the landing page and the engine's messages
      all group through `engine/src/format.ts` ([ui.md § Number
      style](./ui.md#number-style)). Pasting commas still parses. The client
      or hydrologist may reverse it; it is one constant.
- [x] **Sparkline read-out is mouse-only** (found with the chart labels,
      2026-09-27; `charts/Sparkline.svelte`). Pointing reads out the month
      or day under the pointer ("Jul 0.40"); a screen reader gets every
      value through the accessible name, but a sighted keyboard user sees
      only the end labels and the marked peak or low. Durable fix: make the
      sparkline focusable with arrow keys stepping the read-out (a slider
      pattern, `aria-valuetext`), or a "Show the numbers" disclosure beside
      the Crops list and the Dams cards. Trigger: the next accessibility
      pass, or an accessibility-persona finding on it. **Done 2026-09-28**
      (#76): the slider. It lies over the line, takes focus with Tab, starts
      at the mark, and the arrows, Page Up/Down (a tenth of the line) and
      Home/End step the read-out and the dot (`keyStep` in
      `charts/sparkline.ts`), with the point in words as `aria-valuetext`. A
      mouse press doesn't focus it. ui-playbook § 3; `sparklines.spec.ts`.
- [x] **Five help diagrams scroll sideways at 1440** (2026-09-27, from the
      diagram labels work; done 2026-09-30). The help `Diagram` never draws text under
      9.5 px, so at column width the model pipeline, workflow, calibration
      loop, validation and rain-sources diagrams scroll a little sideways
      instead of shrinking (measured: the pipeline 53 px at 1440; at 1280 all
      five, 40 to 213 px). Redrawn, text floor kept: every diagram is at most
      660 units wide, which fits the 582 px column at 1280 (the pipeline top
      to bottom, the workflow in two rows, the other three tighter).
      `help/diagrams/width.test.ts` holds the width, and
      `diagram-labels.spec.ts` checks none scrolls at 1440 or 1280 (ui.md §
      Help).
- [x] **Deleting a scenario's released base run sometimes answers 404**
      (issue #77, found 2026-09-28, fixed 2026-09-28): the scenarios e2e
      failed ~1 in 15. The cause was in the browser, not RLS (an editor's
      `model_run_delete` policy never used `app_run_kept`): the Runs tab reads
      its list as it opens, and when the delete answered before that read, the
      older list arrived last, put the run back and opened it, and the run's
      `GET` answered "not found". The page and the Runs tab now count their
      changes to the run list and read it again when a list read before a
      change answers after it (`runs.spec.ts` holds the read past the delete
      to pin it). The server's kept rule is now one definition
      (`RUN_KEPT_SQL` calls `app_run_kept`); the route locks the run, answers
      `404` only for a run that isn't there and `409` for a delete RLS refuses;
      the Runs tab words a run that's gone instead of showing "not found", and
      a delete of a run already gone just removes it from the list.
- [x] **"Sign out everywhere" button** (2026-09-24): the header's account
      menu has *Sign out* and *Sign out everywhere*.
- [x] **Account page and password change while signed in** (WP-1.9, issue
      #5): the menu's *Account* link opens `/account` (display name, email
      and confirmation status, change password); `PATCH /auth/me` and
      `POST /auth/change-password` (docs/api.md § Auth).
- [x] **Dam figures in the run summary** (issue #55, done 2026-09-26; from
      #17, [ui.md § Summary](./ui.md#summary)). Engine 1.2.0 puts each dam's
      end-of-run storage, the storage 30 days before, the lowest in the last
      year (value and first day) and the days at the minimum level in
      `FarmSummary` (`damEndM3`, `damAgoM3`, `damLowM3`, `damLowDate`,
      `damDaysAtMin`). The Summary's Dams today card and the Network's colour
      by dam level and *Dam at end of run* read them, and fetch the daily `dam_storage`
      series only for a run from before 1.2.0. The Dams page still fetches
      every dam's series, because its sparklines and storage chart draw them.
- [x] **Exports carry unrounded values** now that the engine doesn't round.
      Decided (step-1 roadmap D11): CSV keeps full precision; the workbook
      keeps full values with per-unit display formats (api.md § Number
      formats).
- [x] **Small flows read 0.000; the FDC table was in no export; download
      names used the UTC date** (issue #45, done 2026-09-26): `fmtQty`
      (two significant figures below what the fixed decimals show), the
      engine's `fdcPercentileTable` in the summary CSV, the workbook and the
      report, and `project.time_zone` (058) dating every download.
- [x] **Other server-side "today"s are still UTC's** (found with issue #45;
      fixed 2026-09-26). Every day the server counts or writes for a person
      is now the calendar day in the project's time zone
      (`projects/timeZone.ts` `localDate`; SQL through `app_time_zone`,
      059_local_day): the alert evaluator's `today` and a forecast's
      `madeOn` (`alerts/evaluate.ts`), the 06:00 digest and the daily cap
      (`app_alert_claim` / `app_alert_claim_digest` now take the worker's
      clock and work out each delivery's 06:00 from its project's zone, so
      the evaluator, the cap and the digest agree on one local day), feed
      health (`feeds/health.ts`: `checked`, `since` and staleness), the
      portfolio (each row carries its own `timeZone` and `today`; the
      team-wide `today` is gone), the farm view's `stale` and its forecast's
      `madeOn` (stored at publish), and the dates in server-written text:
      a publication's `citedBy` name, the auto-publish note, a restore's
      reason, the allocation re-import refusal, the not-reproducible
      message and an unlabelled run's name in the report email. Kept UTC
      on purpose: `feeds/fetch.ts` `utcToday`, the fetch plumbing's clock
      (which days to ask for, the newest a source can have), since CHIRPS
      days are UTC days and UTC's today is never after a DWS (South
      African) day; the sources' own dates, never shifted; the account's
      `my-data_<date>.json`, which belongs to no project
      (`DEFAULT_TIME_ZONE`) until users have a zone of their own.
      Publications made before this keep the UTC `madeOn` they stored.
- [x] **FarmDay help diagram is behind the engine** (fixed 2026-09-25):
      `components/help/diagrams/FarmDay.svelte` now draws rain on the dam,
      open-water evaporation and seepage to the river below the wall, and its
      `aria-label` says so.
- [x] **Reporting window picker: move the re-windowing into the engine**
      (issue #44, [ui.md § Reporting window](./ui.md#report-window); done
      2026-09). `analyseSeason`'s recompute is now the engine's
      `curtailmentOverWindow(run, window)` / `prepareCurtailment`
      (`views/farmProjection.ts`): farms, other water users and EWR sites
      over any window of a saved run, the EWR site binding each farm's
      charge included, recomputed from the stored flows. The farmer
      projection's season and the Runs tab share it; the frontend's
      mirrors of `otherUserCurtailment` and the consumptive share are gone
      from `runs/windowedCurtailment.ts`, and the binding-site column is
      back for every window. A view over a saved run, so no
      `ENGINE_VERSION` bump; `curtailmentOverWindow.test.ts` checks it
      against `runModel` on seeded networks.
- [x] **Human-impact tables sat inside the Summary with no menu entry, and
      Other water users was shown twice** (hydrologist persona, issue #51;
      done 2026-09-29, issue #137). They are **Other uses** on Units &
      supply (`#res-other-uses`, a `supplyNav` entry when the run has any),
      the Summary ends with a line naming what the run has and linking
      there (`runs/humanImpacts.ts` `otherUsesLink`), and the page keeps one
      copy of Other water users: the curtailment table's, which gained the
      % of demand supplied (`usersTableOnSupply` draws the other table only
      for a run whose curtailment doesn't list them). The printable report
      keeps the tables under its summary. Pinned by `land-cover.spec.ts`,
      `demand-objects.spec.ts`, `demand-object-schedule.spec.ts`,
      `other-users.spec.ts`; `humanImpacts.test.ts`, `supply.test.ts`.
- [x] **The water balance by water year was reachable only under Dig deeper
      › Self-checks** (hydrologist persona, issue #51; done 2026-09-29,
      issue #137). It is a *Water balance* section in Model quality
      (`#res-water-balance`, `runs/WaterBalanceTable.svelte`, the component
      the self-checks used), and the self-checks link to it; the printable
      report keeps it under the checks. `self-checks.spec.ts` and
      `runs.spec.ts` pin it.
- [x] **The same water balance by water year in two places, and the
      catchment's in a third** (issue #175's overlap check, 2026-09-29; the
      UI half done 2026-09-30, the choice of table still open, below).
      Model quality's *Water balance* (`#res-water-balance`, issue #137) and
      Dig deeper › Self-checks both draw the per-unit column-V balance by
      water year (`runs/WaterBalanceTable.svelte`, `runs/checks.ts`
      `BALANCE_COLUMNS`, Mm³), and River & reserve's Water account
      (`reliability/WaterAccountPanel.svelte`, `reliability.ts`
      `ACCOUNT_LINES`, m³) draws the catchment's for the same water years.
      About ten of the self-check's thirteen terms are the account's too
      (rain on dams, groundwater, transfers, consumptive use, other users,
      dam evaporation, seepage lost, stream depletion, off-take losses,
      outflow, change in storage, residual); the self-check starts from unit
      runoff (after land cover and flow shares) where the account starts
      from natural flow and lists land cover and unallocated flow as outs,
      and only the self-check has rain (mm), the runoff coefficient and
      start and end storage.
      **Durable fix:** one client-facing balance. Either the Water account
      gains rain (mm), the runoff coefficient, start and end storage and an
      **m³ / Mm³** switch, and Model quality's Water balance becomes a link
      to it; or the Water balance section stays the client's table and the
      account links to it. Either way the Self-checks panel shrinks to the
      closure check (each water year's residual, pass or fail) with a link,
      and the summary CSV and `.xlsx` export keep both tables. Pin the
      surviving table's rendered lines with an e2e spec first, and update
      ui.md § Water account, § Self-checks and the help articles. The
      surviving table also gets the playbook's "Show all N" fold: on a
      30-water-year run the Water balance table scrolls inside its 70vh box
      and sideways at 1440.
      **Who:** operator (which table is the client's; asked on
      [#93](https://github.com/Absence0760/project-water-management/issues/93)).
      **Trigger:** the next change to the Water account, the Water balance
      section or the Self-checks panel, or a client asking for the table.
      **Done (2026-09-30), the part that doesn't wait on that choice:** on
      Runs & results the Self-checks panel is now only the closure check
      (one line: the balance closes in every water year and the whole run,
      or the years that don't with their residuals; `runs/checks.ts`
      `balanceClosure`) and a link to the table; the Water balance and the
      Water account link to each other for the same run, each saying what
      the other adds, instead of one repeating the other
      (`self-checks.spec.ts` follows both links and Back). The printable
      report still draws the table under its self-checks, its only copy
      there.
      - [ ] **Still open: which table is the client's** (operator). Then
            either the Water account gains rain (mm), the runoff
            coefficient, start and end storage and an m³ / Mm³ switch and
            Model quality's Water balance becomes a link, or the account
            becomes the link; the report prints the chosen one, and the
            summary CSV and `.xlsx` keep both. Trigger unchanged.

## Roles and what each member sees

Today the workspace shows the same seven tabs to everyone. Owners and team
admins see and change everything, which is right. Everyone else sees every
modeller tab too: a viewer gets Network, Crops, Transfers, Data and Settings
& calibration read-only, under a "View only" note (`routes/projects/[id]/+page.svelte`).
Roles are `viewer` / `editor` / `owner` per project, and team `member`
(→ editor) / `admin` (→ owner) (data-model.md § Roles, § Teams).

Already planned, so not repeated here: the **`farmer`** role, with its own
phone view at `/farm/:id` and farm-scoped RLS, which redirects a farmer away
from the workspace entirely (roadmap step 2, WP-2.1 onward). Also planned:
read-only **share links** for regulators, viewers opening on the published
run, and help entries tagged by `audience`, all in step 2.

Open gaps:

- [x] **Read-only team role** (2026-09-24): team `viewer` → project
      `viewer` (migration 008). `app_project_role()` maps each team role
      explicitly (unknown grants nothing); creating or moving a project
      into a team needs team member or admin; a viewer's copy is personal
      (data-model.md § Teams, ui.md § Teams).
- [x] **Tabs by role** (2026-09-26, issue #6; ui.md § Tabs by role). Viewers
      were shown tabs they can't act on and mostly don't need. One pure
      function, `visibleTabs(role, prefs)` (`lib/workspace/tabs.ts`), that
      the tab strip and the Overview checklist (whose steps link to tabs) both use:
      - owner and editor: every tab, as now;
      - viewer: Overview and Runs & results, plus Data (charts and
        downloads); the model tabs (Network, Crops, Transfers, Settings &
        calibration) sit behind a "Show model inputs" toggle. History (the
        change log of those inputs) sits there too.

      Still a question for the client: should viewers see the model inputs
      by default? Built as "no", in one constant
      (`VIEWER_SEES_MODEL_INPUTS_BY_DEFAULT`).

      **This is presentation, not access control.** RLS still lets a viewer
      read every input, so a deep link (`?tab=settings`) keeps working, and
      nothing gets hidden "for privacy" this way. Data a role must not see
      needs RLS, as the farmer role has.
- [x] **Members choose their own tabs.** Let each user hide tabs they don't
      use (within what their role can see), with a "Reset to default" option.
      Overview can't be hidden. A hidden tab still opens from a deep link, and
      a "Hidden tabs (2)" menu brings it back. *Built (issue #17, 2026-09-27):*
      the **Choose sections** / "Hidden (n)" menu in the sidebar
      (`workspace/SectionsMenu.svelte`, ui.md § Tabs by role), stored per
      account in `user_preferences` (083), not an `app_user.preferences`
      column: `app_user`'s SELECT policy lets co-members read each other's
      rows, and this table is own-row only. WP-1.26's unit preferences join
      that document as a key.

Tests (tabs by role, built: `lib/workspace/tabs.test.ts`,
`e2e/tests/tabs-by-role.spec.ts`; members' own tabs, built:
`tabs.test.ts`, `backend/src/auth/preferences.db.test.ts`,
`e2e/tests/own-sections.spec.ts`): unit tests for `visibleTabs` across role ×
preference, including an owner who can't lose Overview. An e2e test that a
viewer sees the short tab set, turns on "Show model inputs", and opens a
deep link to a hidden tab. Route-auth is unchanged. Docs: ui.md (the tabs
table), data-model.md § Teams, api.md (team roles, `preferences`).

**Ask the client:** which people at the WUA and the client need which role,
and whether viewers should see model inputs by default. **Trigger:** before
the first non-modeller user is invited (WUA staff, a client reviewer), and
with WP-2.1 at the latest, so the farmer role lands alongside a team viewer
role and not before it.

- [x] **Adding someone by email told the adder whether they have an
      account, and added a verified account without asking it** (issue #51,
      adversary finding 3; done 2026-09-29, issue #136). Every add by email
      (`POST /projects/:id/members`, `/farmers`, `/farmers/bulk`, `POST
      /teams/:id/members`) is an invite, answered `201 { invited: true,
      invite }` / bulk `'invited'` whether or not the address has an
      account, and a verified account joins only when its holder accepts on
      `/account/invitations` (`GET /me/invites`, `POST
      /me/invites/:id/accept`, `DELETE /me/invites/:id`;
      `109_invite_accept.sql`). The members and farmers lists show nobody
      before they accept, and a decline reaches the owner's History as
      `invite.declined` with the masked address only. An existing farmer's
      bulk rows still add farms at once (`'added'`): they are on the list
      already. The daily cap (`101_invite_throttle.sql`) stays. Tests:
      `auth/account-tokens.security.db.test.ts` (unknown, unconfirmed and
      verified addresses get the same answer and row, with a positive
      control), `invites/invites.db.test.ts`, `sharing.spec.ts`.
- [x] **An invite outlives its sender's right to send it** (review of
      issue #136, 2026-09-29). `invite` RLS checks owner/admin only when the
      invite is written, so if the owner who sent it is removed or demoted
      before it is accepted, the invitee still joins with the invited role
      (`owner` included), through the invitations page or, as before #136,
      a sign-up or confirmation link. **Durable fix:** in 109's functions
      and `app_accept_invites`, accept (and list) an invite only while its
      `invited_by` still holds owner on the project (directly or as team
      admin) or admin on the team, or delete a person's sent invites when
      they lose that role (a trigger on `project_member`/`team_member`),
      with a DB test for each path. **Trigger:** before a catchment has more
      than one owner outside the operator's own team.
      **Done** (155_invite_sender_role.sql): every function that lists,
      describes or accepts an invite checks its sender at that moment
      (`app_invite_sender_holds`), chosen over a role-change trigger because
      it fails closed on every way a role is lost; owners see a lapsed invite
      flagged (`senderLapsed`) to re-send or revoke. Tests:
      `invites/invites.db.test.ts`, `farms/invites.db.test.ts`.
      A lapsed invite revives if its sender regains the role: **accepted
      (operator, 2026-10-01)**, since they could re-send it anyway
      (security.md § Invites).

## Features left half-way

- [x] **Make the model causal, then run forecast mode once** (engine-audit.md
      K1, found building WP-2.12, 2026-09-26; done in engine 1.28.0, issue
      #67). Every record-wide figure (GR4J's cycled warm-up, the land-cover
      Q75, the Reserve's natural curves and the months it assesses, a full
      allocation's yearly factor) reads only the days before a forecast tail
      (`forecastTail.ts`), so a run with the tail has the same series as the run without it on every shared day, to the bit, and `runForecastChecked` takes
      every series from it with no splice (model.md §2.4f). It still runs the
      history twice: the summaries cover their whole run and the self-checks
      recompute them from the series, so windowing them to the history would
      touch every summary and every check, for no change in a figure. A
      snapshot at `forecastFrom` would make the second run cover the tail
      only (same series, less time); trigger: forecast runs' time showing up
      in the job queue's budget.
- [x] **Scheduled forecast runs** (WP-2.12 → WP-2.11 hand-off, 2026-09-26;
      [architecture.md § Background work](./architecture.md)). A forecast
      feed's (CHIRPS-GEFS) merge that changes days queues a `rerun` job with
      `trigger: 'forecast'` (`series/newData.ts` `queueForecastFor` →
      `runs/autoRun.ts` `enqueueForecastRun`, dedupe key `forecast`, the
      re-run's debounce), only while `settings.autoRun.enabled` (the same
      opt-in as the re-run: a scheduled forecast run is an automatic run).
      The job runs `executeRun(db, id, forecastRunLabel, 'forecast')` then
      `trimRuns` (one unkept forecast run kept), is never auto-published, and
      does nothing when the observed rain has overtaken the issue. Tests:
      `runs/autoRun.db.test.ts` § scheduled forecast runs.
- [ ] **Dam storage (WP-3.5, engine 0.35.0): what the first slice left.**
      Built: survey curves, releases, monthly lake factors, seepage
      destination (model.md §2.7a "Dam geometry, losses and releases").
      Still open:
      - ~~*Capacity loss to sediment*~~: done (engine 1.30.0, issue #67,
        migration 110, model.md §2.7g): `damSurveyDate` and
        `damSedimentPctPerYear`, linear both ways from the survey; dead
        storage, the curve's volumes and the dam-level triggers scale with
        the capacity. Pending the hydrologist (#90).
      - ~~*The survey curve as a scenario op*~~: done (engine 1.20.0, issue
        #67): `damCurve` is in `NODE_SET_FIELDS.farm`, the "Add a change"
        form takes pasted rows (`curve` ValueSpec reusing `parseDamCurve`),
        and override mode records a table edit of the curve, after the
        capacity op when the dam is raised with it (scenarios.md § Dam
        capacity).
      - ~~*Transfer room ignores today's release*~~: done (engine 1.29.0,
        issue #67): the room counts a fixed release's floor, the release
        with no inflow and nothing transferred in (`fixedReleaseFloor`,
        model.md §2.6). A pass-inflow release stays uncounted: it is at most
        the day's inflow, which the room doesn't count either, and both are
        only known after the transfers are settled.
      - ~~*Self-checks water-balance table*~~: done (76f24440): optional
        columns for groundwater, storage set, other use, depletion and
        seepage lost, shown only when a run has them; a release joins the
        outflow, so it needs no column.
      - ~~*Monthly lake-factor presets*~~: done (engine 1.49.0, model.md
        §2.7a item 4): `LAKE_FACTOR_PRESETS`
        (`packages/engine/src/evaporation/lakeFactorPresets.ts`), flat 0.75
        and the WR90 monthly lake factors converted to A-pan at the
        project's A-pan (WR90's or Taljaard 2023's pan equation), filled from
        Settings with a recorded source note (`lakeEvapFactorSource`, shown
        in run comparison and the report). Which one the client's catchment
        takes is in § Hydrologist.

- [x] **The Sandspruit example fails `catchments.test.ts` on main** (fixed:
      the test passes, 15/15, 2026-09-27) (seen
      2026-09-25 on origin/main at 9590fa1, before the scenario merge): engine
      0.28.0's forecast-rain warning (3ae50b9) fires on the example's last 10
      days (2025-01-01 … 2025-01-10), which the test's expected-warnings list
      doesn't include. Either the example's rain source for those days is
      wrong, or the list needs the new warning with a reason. Owner: the
      forecast-rain change.


- **Assurance of supply, stress classes and the water account** (roadmap
  WP-3.4, engine 0.32.0, 2026-09-26; [model.md §2.11a–b](./model.md)).
  Built: `network/reliability.ts` → `RunSummary.supplyAssurance`, the Runs
  tab's two panels, the three summary-CSV blocks,
  `settings.assuranceAnnualThreshold`, `checkReliability` and
  `checkWaterAccount` in the soak. Left open:
  - [ ] **The hydrologist signs off the definitions** (pending, decided from
        the persona review): demand days, not all days, for the time-based
        measure; part water years counting for the annual one; the stress-class
        thresholds as they stand; seepage as a memo rather than an out
        term. Trigger: the hydrologist's first review of a licensing run.
  - [x] **Dam releases in the water account** (done, engine 0.35.0: a memo
        column, `damReleaseM3`, since a release joins the river) once WP-3.5 lands: a release
        that leaves the network is an out term; one that stays is already in
        the outflow. Owner: WP-3.5.
  - [x] **EWR required vs met from the Reserve rule tables** (§2.9c) and
        WP-3.7's Desktop tables: done, engine 1.3.0 (issue #64). With
        `settings.ewrChargeSource: 'ruleTable'` the account's requirement
        at a site with a table is the table's (rows say `ewrSource:
        'ruleTable'`), the same choice as the charge; the pragmatic EWR
        stays the default, pending the hydrologist.
  - [x] **Where else the metrics show** (done, issue #70): the printable
        report's **Assurance of supply** section, the farm view's share of
        each month's need received with its stress class in plain words, and
        the compare and scenario views' per-farm table with the change B − A
        (`compare/AssuranceDeltaTable.svelte`). The farm view shows stress
        months only, not the reliability measures, which are over the
        modeller's report window rather than the farmer's season.
  - [x] **Bundle budget** (superseded by later ceiling moves; now 994 KB,
        19f02741 then the 2026-09-27 raise): the build was 829 KB against the 821 KB ceiling
        (both panels are lazy; the growth is the engine module in every
        runModel chunk, the help entries and the Settings field). The
        coordinator raises the ceiling at merge or trims elsewhere.


- **Reproducible inputs and cited runs** (roadmap WP-3.1, prerequisite of
  scenarios #18, 2026-09-25; [data-model.md § Stored run inputs](./data-model.md#stored-run-inputs-021_series_blobsql)).
  Built: engine `canonicalJson` / `seriesDigest`, `021_series_blob.sql`
  (`series_blob`, `run_input_series`, the GC trigger, `model_run_cited`),
  `executeRun` storing inputs, `loadRunInput` (byte-identical round trip on
  the three examples), the run-input route for uncertainty bands using it.
  Left open:
  - [x] **Scenarios add the first "cited" clause** (WP-3.2, 024_scenarios,
        2026-09-25): `model_run_cited` is `EXISTS (SELECT 1 FROM scenario s
        WHERE s.base_run_id = p_run)`, with a `NO ACTION` key (checked at the
        end of the statement, so a project delete still cascades); the unpin
        and delete routes answer `409 this run is cited by scenario "…"`;
        cited runs don't count against `PINNED_RUNS_PER_PROJECT_MAX`.
  - [x] **`GET …/runs/:runId/reproduce`**, `RunMeta.reproducible` and the
        Runs tab's **Check reproduction** action (2026-09-26,
        `backend/src/runs/reproduce.ts`, `runs/ReproducePanel.svelte`; api.md
        § Runs, ui.md). The answer is `identical`, `differs` (up to 50
        differences: summary paths, series with days, first date and largest
        difference), `not_reproducible`, `inconsistent` or `failed`. The list
        tags the exception, **Inputs not stored**, rather than badging every
        run "Reproducible"; the "Cited" lock is the existing **Published** /
        **Scenario base** tags without a ✕ (pending the hydrologist).
  - [x] **Withdrawing a nomination (un-nominate)**. Done in
        `098_nomination_withdrawal` (issue #73): an append-only history row
        with no run and a required reason (`run_id`, `runoff_model` and
        `engine_version` NULL together), stamped by `run_nomination_stamp`,
        allowed only while a run is nominated; `POST …/evidence/withdraw`
        and the Evidence panel's **Withdraw the nomination…**; shown as
        "Withdrawn on … by …" in the Runs tab's history and evidence line,
        compare and the summary CSV. The guard (035) is unchanged: the
        project stays undeletable. Tests: `runs/evidence.db.test.ts`
        ("withdrawing the nomination"), the unit tests of both `evidence.ts`
        and `export/run-tables.ts`, e2e `evidence.spec.ts`.
  - [x] **WP-2.3's publication-history trim skips cited runs' publications**
        (024_scenarios, 2026-09-25): `run_publication_cap` keeps, beyond the
        newest 12, every publication whose run a scenario is based on, so
        the base keeps its "published" record. (A publication is itself a
        citation since 022, so "cited" here means cited by something else;
        evidence packs and assessments add their clause the same way.)

- **Scenarios** (issue #18, WP-3.2, 2026-09-25;
  [scenarios.md](./scenarios.md)). Built: the engine part,
  `packages/engine/src/scenario/` (`applyScenario`, `classifyOp`,
  `classifyScenario`, `validateScenarioOps`), with the invariant and
  no-silent-change fuzz; the backend, data model and API
  (`024_scenarios.sql`, `backend/src/scenarios/`, `executeScenarioRun`,
  rebase, the scenario per side in compare) and the frontend API client
  (`api.scenarios`). Left open:
  - [x] **The Scenarios tab** (stage D, 2026-09-26;
        [ui.md § Scenarios](./ui.md#scenarios-tabscenarios)): the list and
        its empty state, the editor that records every op with undo, the
        "Based on run X" banner and the red "Baseline assumptions changed"
        callout, rebase with a dry-run check, the scenario-vs-base
        comparison and the compare page's Scenario overrides section
        (reusing the #8 overlay), the Runs tab's **Scenario** and
        **Scenario base** tags (no ✕ on a cited base), e2e
        (`e2e/tests/scenarios.spec.ts`: a 20 % dam raise run and compared)
        and axe in light, dark and on a phone.
  - [x] **Override mode for the Network, Crops and Transfers editors**
        (roadmap WP-3.2 *Frontend*, 2026-09-26; [scenarios.md § UI](./scenarios.md#ui),
        [ui.md § Scenarios](./ui.md#scenarios-tabscenarios)). **Edit in the
        model tables** opens the three tabs, unchanged, on their own
        `ModelEditor` loaded with the scenario's model
        (`scenarios/OverrideEditor.svelte`, its own chunk), under a banner
        saying it is the scenario, not the catchment. **Record** diffs the
        edits into ops (`scenarios/overrideDiff.ts` `diffModel`): node fields
        → `node.set`, crop areas → `cropArea.set`, new and removed nodes,
        crops, transfers, land cover and boreholes → their ops, each through
        the form's check (`ops.ts` `checkOp`, split out of `buildOp`), the
        list re-applied to prove it gives back the edited model. Edits no op
        can express are named and block recording (a node's kind, the outlet
        moved); crop edits and removals, moves and inserts record since the
        later ops below (engine 1.35.0), demand objects since engine 1.45.0.
        The shared editors weren't changed, so no pinning e2e was needed;
        e2e covers override mode in `scenarios.spec.ts`.
  - [x] **Names of nodes a rebase dropped are lost on reload** (2026-09-26,
        `047_scenario_op_names`, `backend/src/scenarios/names.ts`): the
        server keeps `op_names`, `{ id, name }` for every node and crop the
        ops name, from the base run's snapshot on create, on a PATCH of the
        ops and on a rebase, keeping a name a later base no longer has while
        an op still names it (047 backfilled existing scenarios from their
        base). The editor names from `Scenario.opNames`, and the in-memory
        `seenNames` is gone. Tests: `names.test.ts`, the rebase case in
        `scenarios.db.test.ts`, and the rebase e2e reloads.
  - [x] **One home for the model's save rules** (2026-09-25): the rules are
        the engine's `modelRuleIssues` (`packages/engine/src/modelRules.ts`);
        `scenario/structure.ts` and `modelProblems` both call it, and a fuzz
        test checks a scenario applied to a valid model always passes them.
  - [x] **EWR rule table op** (`ewrRule.set`, engine ≥ 1.6.0, issue #64,
        WP-3.7): sets or replaces a site's Reserve rule table, checked with
        Settings' own checks, always a baseline assumption (applications
        included: shown in red, not refused), in the scenario form with the
        Settings tab's table editor and described with its confidence line
        ([scenarios.md § Reserve rule tables](./scenarios.md)).
  - [x] **Later ops** (engine 1.35.0, issue #73): `allocation.set` and
        `allocation.remove` (a registered volume set, replaced or removed by
        id; the proposal on the applicant's own unit), `ewrRule.remove`
        (always a baseline assumption), `node.move` and `node.insert` (the
        network stays one tree with one outlet: the model rules refuse a
        loop, an insert only re-points nodes draining where it drains),
        `crop.set` and `crop.remove` (the proposal only on a crop the
        scenario added), `landCover.set`. In the "Add a change" form, and
        override mode records crop edits and removals, moves, inserts and
        land cover edited in place instead of blocking them. Hidden
        registered volumes answer as free ids in an application (the mask),
        and run comparison now lists a volume's storage, months and maximum
        rate, and a land-cover patch's area and cover on their own
        ([scenarios.md § Op catalogue](./scenarios.md#op-catalogue)).
        Left open:
        - [x] **A transfer rule that moves nothing relaxes its siblings'
              reserve** (done in #240, engine 1.36.0: [engine-audit.md
              N6](./engine-audit.md#findings), erratum ER-11; found
              reviewing #73; `network/simulate.ts` ~726,
              `freeBy[tr.from]`): a rule active in a month at max rate 0 (a
              listed month at rate 0), or any rule with a lower reserve at
              the same priority, counts in the free water above each rule's
              reserve, so two 50 %-reserve rules from a full 1000 m³ dam move
              800 m³ with a 0 %-reserve rate-0 rule beside them (the dam ends
              at 200 m³, below both reserves) and 500 m³ without it. Durable
              fix: free water per rule from its own reserve, and a rule with
              no rate this month not active; an engine-audit entry, a
              version bump and an invariant. Trigger: the hydrologist's
              review of transfers, or any project with two rules from one
              dam at different reserves.
        - [x] **Scenario fuzz with allocation modes** (done in #73):
              `scenario.invariants.test.ts` runs `checkAll` on random
              scenarios over bases under a cap or a full allocation, so a
              scenario's volumes reach the allocation self-check.

- **Printable catchment report** (issue #19, WP-2.15 Phase A, 2026-09-25;
  [ui.md § Report](./ui.md#report)). Built: the print route
  `/projects/:id/report?run=`, the Runs tab's **Report** button, A4 print
  CSS, charts at 2 device pixels per CSS pixel, the `data-report-ready`
  signal, e2e (`e2e/tests/report.spec.ts`) including `page.pdf()`. Left open:
  - [x] **Phase B, server-side PDFs**: built (issue #26); what is left is
        under § Server-side reports. The plan was a `report_render` job in headless
        Chromium, S3 / MinIO, a single-use render token). Trigger: decision
        D9, when someone asks for emailed or scheduled reports. The job queue
        (WP-2.8) is in place; the route and `data-report-ready` are what it
        would open and wait on.
  - [x] **Publication sections** (done, issue #70): the cover's published-by
        line and restriction notice (WP-2.3), **Changes since the previous
        publication** (WP-2.4), both from `GET …/runs/:runId/publication`,
        and the Overview published card's **Report** link.
  - [x] **The licensing evidence pack's sections and uncertainty display**
        (#15: designed in [design/evidence-report.md](./design/evidence-report.md)).
        Built (issue #71): WP-2.15 Phase C, the report route's evidence mode
        ([ui.md § Report](./ui.md#report)), and the issued pack on top of it
        ([§ Evidence report](#evidence-report-issue-71)). What's left of it
        is listed there.
  - [ ] **Firefox print check.** The acceptance asks for a clean A4 PDF from
        Chromium and Firefox; e2e runs Chromium only, so print the largest
        example from Firefox by hand before calling Phase A accepted. Firefox
        has no CSS page-margin boxes, so its print has no running footer
        (issue #70 moved the footer into the page's CSS); check the rest.
        Owner: the operator, by hand.
  - [x] **Farmer access test** (done, issue #70): `report.spec.ts` checks a
        farmer gets 403 from the run and its publication and is sent to their
        farm page.

- **Data feeds** (issue #10 part 2, WP-2.10, 2026-09-25;
  [architecture.md § Data feeds](./architecture.md#data-feeds)). Built:
  CHIRPS, CHIRPS-GEFS and DWS parsers on synthetic fixtures, `018_feeds`,
  the jobs, the routes, Settings → Data feeds, the fetcher Lambda and its
  queues (plan only). Left open:
  - [ ] **DWS is unverified against the live site** (on #62's first-deploy list; the check itself is #92). It answers HTTP 403 to
        our (non-South-African) network, so the parser follows the request two
        open-source clients make (RivRetrieve-Python, aquascope) and the
        layout of an archived daily page (web.archive.org, 2024: the header
        is `D AVG F/R`, not the clients' `D_AVG_FR`). Trigger: the first
        deploy. From the fetcher's region, attach a DWS feed to a throwaway project and check it goes OK; if the
        page differs, the feed fails loudly (nothing is written) and
        `sources/dws.ts` plus its fixture change together. Codes that say
        the data is missing (151, 165, 170, 172, 246, 247, 255) become gaps;
        the rest are counted: agree with the hydrologist whether flagged flows
        (60 above rating, 150 extrapolated, 173 unreliable…) should be kept.
        Only H (river gauge) codes are accepted, sent as `SiteType=RIV`
        (#35). Also check a gauge that belongs to a dam: archived pages ask
        for some H stations (a dam's canals and downstream river gauge, e.g.
        those listed under a reservoir's HyDataSets page) with
        `SiteType=DC`; if RIV fails for one, derive DC from the catalogue
        rather than the code letter, which can't tell them apart.
  - [ ] **Terms of use (operator decision, roadmap D7):** DWS's terms for
        automated retrieval, and CHIRPS-GEFS's licence (CHIRPS itself is
        public domain). Decide before a DWS or GEFS feed is used for a client.
  - [ ] **CHIRPS scale factor** (hydrologist, D7): a feed writes CHIRPS as
        published into `rain_chirps_mm`; the existing CHIRPS bias correction
        (Settings → Rain gaps) applies at run time, as for an uploaded series.
        **Provisional decision 2026-10-01 (to be confirmed by the client's
        hydrologist):** yes, CHIRPS needs one, and the run-time bias
        correction is it; no separate factor at ingest, so the stored feed
        stays as published ([calibration-research.md § Provisional decisions](./calibration-research.md#provisional-decisions-on-the-hydrologists-questions-2026-10-01)).
  - [x] Marking a fed series on the Data tab ("from CHIRPS feed", from
        `time_series.feed_id`): built, `SeriesMeta.feed` and the Data tab's
        *Written by the … feed* (#69). Merges are already audited
        (`series.merged`, `feeds/ingest.ts`).
  - [x] A debounced re-run after new data (WP-2.11, built).
  - [x] Emailing owners about a stale or failing feed: the `data_stale` and
        `feed_failing` alerts (WP-2.13), once the catchment switches them on.
  - [x] CHIRPS by bounding box (the roadmap's `{ bbox }`): `config.bbox`, the
        area-weighted mean of the 0.05° cells it overlaps, at most 100 cells in
        25 rows (issue #69; architecture.md § Data feeds).
  - [x] ~~**Request volume grows with feeds.** Each CHIRPS feed re-reads its
        last 50 days daily (~200 range requests).~~ **Only what can change
        is read (#69):** the ingest keeps a checked final marker
        (`last_meta.finalThrough`) and the next window starts after it; a
        `sat` fetch stops probing finals after the first batch without one,
        and doesn't re-read the preliminary days the series already holds
        (`heldThrough`). architecture.md § Data feeds, the window. On the
        fixtures a caught-up feed's daily fetch goes from 194 range requests
        to 3 (`sat`) and from 158 to 5 (`rnl`), and a backfill of final days
        moves on 120 days a window instead of 70.
  - [x] ~~**Ingest doesn't check a result's dates against the window asked
        for.**~~ **Fixed (#31, `029_feed_fetch`):** the `feed_fetch` job
        records its window on the feed before sending, and the ingest
        refuses an answer with a day outside it, and drops any answer but
        the newest fetch's (late or redelivered). A DWS backfill through an
        empty stretch now moves on too (#29, `last_meta.through`).
  - [x] ~~Related: "Run now" is deduped per feed but not rate-limited, and an
        hourly schedule re-reads CHIRPS (published daily) 24 times a day.~~
        **Done (#69, `111_feed_daily_only`):** every feed runs daily (the
        hourly schedule is gone for every source: none publishes more
        often), and "Run now" is a token bucket per feed, 6 presses that
        queue or pull a fetch, then one every 10 minutes (`429` with
        `Retry-After`).

- **Run comparison** (the per-node daily series overlay is built, issue #8,
  [run-comparison.md](./run-comparison.md)):
  - copies that remember their source nodes (renamed farms in a copy don't
    match);
  - a value change is not isolated when the dates also changed;
  - default side A to the newest pinned run (roadmap WP-1.11): the pickers
    already mark pinned runs (015_run_pinned), but `compare/picker.ts`
    `defaultPair` still takes the previous run.
- **Export:**
  - ~~`.xlsx` output~~ **landed (WP-1.28, 2026-09-25)**: the run workbook,
    built in the browser from the bulk series route (api.md § Export). Left
    open:
    - [x] **Opened in Excel** (2026-09-25). Three synthetic workbooks from
      `buildWorkbook` (the unit test's input with the awkward names
      `=Upper farm`, `Summary`, and a long one with `[ ] : / * ?`; a 3-year,
      2-farm run; a 20-year, 8-farm run, 19 MB) were opened in Excel 16.113
      for Mac by the operator, who saw no repair prompt. The same files pass
      Python's `zipfile.testzip()` and open in openpyxl 3.1.5 with no
      warnings; every tab keeps its unit headers, real dates, full-precision
      values and `#,##0.00` display formats. Not scripted (macOS blocks the
      terminal from driving Excel), so a real client-size run and
      LibreOffice (not installed) are unchecked; worth one more look at the
      first client handover.
    - [x] **Smaller files** (2026-09-25): the workbook is zipped with the
      platform's `CompressionStream('deflate-raw')` (`zip.ts`) instead of
      SheetJS's fixed-Huffman deflate; a client-size run's file shrank to
      well under half, built in a few seconds. A unit test caps a synthetic 10-year run's
      size and reads every cell back.
    - No frozen header row or live formulas (SheetJS CE doesn't write panes;
      the formula audit workbook is the separate item in § Verification).
  - ~~a path for exports over 5 MB~~ **landed (WP-1.29a, issue #283,
    2026-09-30)**: the API's Function URL is in `RESPONSE_STREAM` mode and
    every CSV download streams, capped at 50 MB (a farm's daily CSV is
    ≈ 400 KB a year, so a century fits), the same code path on the local Node
    server ([deployment.md § Response streaming](./deployment.md#response-streaming),
    [api.md § Export](./api.md#export)). `export.json` and the bulk series
    pages keep the 5 MB JSON cap (an export must import back).
    - [ ] **Check it in production at the first backend deploy** (WP-1.29's
      acceptance criteria; the steps are in deployment.md § Response
      streaming): a farm daily CSV over 12 MB downloads through CloudFront,
      and sign-in and sign-out still work. AWS's response-streaming page says
      "Lambda function URLs do not support response streaming within a VPC
      environment", which reads as a client inside a VPC calling a URL (its
      example is a VPC client using `InvokeWithResponseStream`), not a
      VPC-attached function behind a public URL as here; only a real deploy
      settles it. If it fails, the durable fallback is WP-1.29 option (b),
      the CSV written to S3 and handed out as a signed URL (the reports'
      pattern), with the URL put back to `BUFFERED` and lambda.ts back to
      the buffered adapter together.
- **Accounts:**
  - Should sign-in require a verified email?
  - Should sign-up be invite-only, or email-first? Email-first closes the last
    account-squatting gap.
  - Is a 5-attempt, 1–15 min lockout acceptable, given anyone can lock another
    person's address that way?
- **Data ingestion:**
  - per-project API keys for logger feeds;
  - scheduled CHIRPS / DWS fetchers;
  - auto re-run after new data;
  - forecast days flagged (plan.md §1e).
- **Data quality:** gap filling.
- **WR2012 check (issue #4 phase 8, model.md §2.10c):**
  - [x] **A written explanation per run** (2026-09-24): migration 007
        adds `model_run.notes` (+ who/when stamp by trigger); the app may
        `UPDATE` only that column; `PATCH /projects/:id/runs/:runId`; the
        Run notes panel under WR2012, run comparison and the summary CSV
        carry it (data-model.md § Run notes).
  - [x] **Summary CSV export** carries the WR2012 block (reference, scaling,
        MAR ratios, monthly table, flag) and the run notes (2026-09-24).
  - [x] **SA-only help tag** (issue #76, 2026-09-27). `HelpEntry.countries`
        (ISO codes) landed; `wr90`, `quaternary`, `wr2012-check`,
        `wr2012-penalty`, `desktop-reserve-model` and `ga538` carry `ZA`, and
        the glossary shows "Applies in South Africa". Hiding them outside
        South Africa waits on country presets (international.md WP-I.4,
        which carries it).
- **Workbook import in the browser (WP-1.31).** Left open:
  - [x] **Peak memory on the largest workbooks** (2026-09-25).
        `readWorkbook` first unpacked only the parts it reads
        (`lib/spreadsheet/import/zip.ts`: the client workbook's peak memory
        clearly down and the read more than twice as fast), then stopped
        using SheetJS altogether:
        a streaming OOXML reader (`xml.ts` tokenizer, `workbookParts.ts`,
        `sheet.ts`, `sharedStrings.ts`) parses each part as it inflates and
        keeps each cell as typed-array slots, so the large [Flow data] XML
        is never held as a string or turned into an object per
        cell. Measured in
        Node (vitest fork, SheetJS on its browser code paths for the before;
        median of 3; the harness is a throwaway test that times
        `readWorkbook` + `extractProject` and reads `process.resourceUsage()`):
        on the client workbook peak RSS more than halved, most of what is
        left being the harness holding the file twice, so the read's own
        share fell by roughly an order of magnitude; `readWorkbook` about
        twice as fast. Synthetic fixture: peak
        129 → 114 MB (harness ~95 MB), read ~50 → ~25 ms. Parity: the
        fixture and local source-workbook tests give identical output, and a
        new cell-by-cell comparison with the SheetJS reader
        (`readerParity.test.ts`, and on the client workbooks in
        `sourceWorkbooks.test.ts`) finds no difference. The import worker
        101 → 25 KB gzip (the bundle guard's spreadsheet-worker ceiling
        107 → 95 KB, now the export worker's).
  - [x] **Strings SheetJS and openpyxl decode differently** (issue #22,
        2026-09-26). The reader kept SheetJS's string decoding, which differs
        from openpyxl, and so from the Python importer the port must match,
        in two cases: Excel's `_xHHHH_` escapes (SheetJS turned `_x000D_`
        into a carriage return, openpyxl leaves the text as written) and a
        formula's cached text (`t="str"`, which SheetJS entity-decoded twice:
        `a&amp;amp;b` read `a&b`, openpyxl `a&amp;b`). `sheet.ts` and
        `sharedStrings.ts` now decode cell text as openpyxl does
        (`xml.ts` `decodeXmlText`): one entity decode, no `_xHHHH_` handling,
        and, found while pinning it, the rest of what openpyxl does: a CR
        written as `&#13;` stays a CR (SheetJS turned CRLF into LF after
        decoding), a literal CR becomes LF, a reference beyond U+FFFF is one
        character (SheetJS truncated it), and a shared string drops every
        `x005F_` (openpyxl's `read_string_table`). Pinned by a hand-written
        fixture with openpyxl's output committed
        (`scripts/wbt-import/make_string_decoding_fixture.py`,
        `fixtures/string_decoding.*`, `test_string_decoding.py`,
        `stringDecoding.test.ts`); `readerParity.test.ts` still compares
        everything else with SheetJS cell for cell and lists exactly which
        fixture cells differ, and `sourceWorkbooks.test.ts` allows only
        differences `explainedByDecoding()` puts down to decoding. None of
        the workbooks seen so far changes (the parity tests stay green). Not
        changed: sheet names, defined names and number formats
        (`workbookParts.ts`) keep SheetJS's decoding, which differs from
        openpyxl only for a name containing a literal `_xHHHH_`; no b023
        workbook has one.
  - [x] **The notes and unmapped report are kept** (2026-09-25). The import
        dialog sends them beside the document (`importReport` on
        `POST /projects/import`, capped by zod) and they are stored in the
        import's transaction in their own append-only table, one row per
        import, rather than a `project` jsonb column (migration 017
        `project_import`; data-model.md § Import reports). Viewers read them
        through `GET /projects/:id/import-report` and on the Overview's
        Import record, both lists collapsed at first; not dismissible, since
        it is the audit trail. Not in `export.json` (api.md § Import report).
  - [x] **Measured in a real browser** (issue #23, 2026-09-26). The client
        workbook (a large `.xlsm`) imported through the real worker code in
        desktop Chrome 154, Safari 26.6, iOS Safari (iPhone 17e simulator,
        iOS 26.4) and Android Chrome 145 (Pixel 10 Pro emulator, 3 GB). A
        throwaway harness (not committed) timed `parse()` from File to result
        and sampled the tab's process memory (macOS RSS; Android RSS + swap,
        since the emulator swaps to zram) from just before the pick to the
        result; median of 3, growth over the tab's baseline, after against
        before:

        | Browser | Memory growth | Time |
        | --- | --- | --- |
        | Chrome (desktop) | about half | unchanged |
        | Safari (desktop) | under a quarter | about the same |
        | iOS Safari (simulator) | under a third | about the same |
        | Android Chrome (emulator) | under half | a little faster |

        Two causes, both fixed at the source in `zip.ts`. (1) WebKit's
        `DecompressionStream` inflates each input chunk into one output
        chunk, so the compressed [Flow data] handed over whole came out as a
        single very large chunk; compressed bytes now go in 64 KB slices,
        pulled on demand. (2) The worker loaded the whole File as an
        `ArrayBuffer` for the whole read; the zip reader now reads
        the File itself with `Blob.slice`: the end record and directory,
        then each needed entry 64 KB at a time. Safari's drop is larger than
        the buffers removed; why WebKit held the rest isn't pinned
        down (it also shrank with the big buffers gone). Guarded by
        `zip.test.ts` (a spy Blob: reading one part of a 3 MB archive reads
        < 100 KB of it, and the inflater never gets a slice over 64 KB).
        Pick to review screen in the real app (Playwright, disk-backed file,
        after) takes a few seconds at most in Chromium and WebKit. The result
        sent back to the page is well under a MB as JSON, so the copy between
        worker and page doesn't matter. **Not done: a real phone.** None was connected; simulators
        and emulators don't enforce a phone's per-tab memory limit. At the
        measured peak growth the import should fit comfortably, but the first
        client import from a phone, or any report of a failing import, is
        the trigger to confirm on a device (the harness notes in issue #23).

- **Publication** (roadmap WP-2.3 phase 1, 2026-09-25; [data-model.md §
  Publications](./data-model.md#publications-022_publicationsql),
  [api.md § Publication](./api.md#publication)). Built: `022_publication`,
  `farmProjection` / `catchmentView` in the engine, the publication routes,
  the farm-view API routes of WP-2.6 (index, view, CSV), publishing from the
  Runs tab, the seeded publications. Left open:
  - [x] **Share links** (WP-2.3 phase 2, 2026-09-25): `025_share_links`
        (`share_link`, `app_share_view`, `app_share_series`), the owner
        routes and the public `POST /share/view` / `/share/series`, the
        `/share` page and the Overview's Share links panel
        ([api.md § Share](./api.md#share),
        [security.md § Share links](./security.md#share-links)). The flow
        series answer only at `FARMER_K` farm holders (design §10.3), which
        is stricter than the roadmap's D2 note "always show outflow".
  - [x] **Audit events for share links** (done: `share/routes.ts` records both) (`share_link.created` /
        `share_link.revoked`): today the row records `created_by` /
        `created_at` and `revoked_by` / `revoked_at`, and a link is never
        deleted so that record stays. Needs WP-2.4's `audit_event` (issue
        #28); add the two writes to `backend/src/share/routes.ts` in the
        same change, and then decide whether revoked links may be purged.
  - [x] **Audit events** for publishing and for notice changes (done:
        `publication.published` and `publication.notice_changed`, `publish/routes.ts`): today only
        `published_by` and `updated_at` / `updated_by` record them. Needs
        WP-2.4's `audit_event`; add the writes in the same change.
  - [x] **Roadmap UI around it** (2026-09-25): the Overview's "Published
        baseline" card (read-only; editors link to the Runs tab's notice
        editor), viewers opening the Runs tab on the published run, "compare
        with published" (the compare page's default and offer, and the Runs
        header link), and `publishedAt` on `GET /projects` for every member
        ([ui.md § Summary](./ui.md#summary), [run-comparison.md](./run-comparison.md)).
  - [x] **The binding EWR site is stored** (engine 1.5.0, issue #64). A
        run stores `ewr_binding_site` per farm upstream of two or more EWR
        sites (the site's index, blank on a day without a charge; any other
        farm's follows from its charge), and the projection and the Runs
        tab's window picker read it, so the binding site is exact on a
        transfer loop too; a run from before 1.5.0 falls back to the
        recompute ([model.md §2.7b](./model.md)). About 195 kB before
        compression (1.6 % of the run's series) on Sandspruit, nothing on
        the single-site examples.
  - [x] **The chart series and per-farm history routes** of WP-2.6
        (issue #74): `GET …/farm/:nodeId/series?key=&from=&to=` (one farm
        allowlist series from the published run, the year to `dataUntil` by
        default, sliced in SQL) and `GET …/farm/:nodeId/history` (the farm's
        own figures in the last 12 publications), `farms/view.ts`,
        [api.md § Farm](./api.md#farm). The farm page keeps rendering from
        the projection (design §12: "compared with last season" from
        `lastSeason`, not `/history`); nothing on it calls them yet.

## Pipelines

- Releases are `web@X.Y.Z` / `backend@X.Y.Z` GitHub releases, run through a
  preflight → build → `production` approval → deploy pipeline
  ([deployment.md §4](./deployment.md)).
- [x] Dependabot's `pip` entry watched the repo root, which has no Python
      manifest; since 2026-09-25 it watches `brand/` and `scripts/wbt-import/`
      (the openpyxl pin the importer CI job installs).
- [x] **`help.spec.ts:289` flake under heavy load** (fixed 2026-09-26): "an
      old /help#term link goes on to the glossary entry" once found the
      article scrolled out of view at 10 workers. The glossary scrolled to
      the entry once, after the first render; the heading font
      (`font-display: swap`) landing later re-flowed everything above it.
      Now `lib/help/anchor.ts` (`holdAnchor`) holds the entry at the top:
      it scrolls again when `document.fonts.ready` resolves and whenever
      the page's height changes (a ResizeObserver on the body), until the
      reader scrolls, taps or presses a key themselves, or the hash changes.
      /farm/words had the same one-shot scroll and uses it too. Tests:
      `anchor.test.ts`; help.spec.ts's hash tests passed 45/45 at
      `--repeat-each=15 --workers=8`. A traced repro (help.spec.ts at
      `--repeat-each=40..50`, 12 workers: 2–6 failures a run before) showed
      the re-flow was the glossary's own stylesheet, not the font (only `h1`
      uses Outfit): the scroll ran with the entry's `scroll-margin-top` at
      `0px` and the unstyled entries ~3,000 px taller, landing at the page
      end; the body's resize when the CSS lands is what `holdAnchor` catches.
      Why the page renders before its CSS: the next entry.
- [x] **A client navigation could render its page before the page's CSS
      had loaded** (found tracing the entry above; fixed 2026-09-26).
      SvelteKit calls each route node's loader twice per navigation (a
      warm-up in `load_route`, then the real call in `load_node`), and Vite's
      preload helper awaits a chunk's CSS only on the first call (the second
      finds it in its `seen` map and returns at once; unchanged on Vite
      main). So when a page's stylesheet was slower than its JavaScript, the
      page painted unstyled for a moment and anything measured then was
      wrong. The root layout now has `onNavigate(() => stylesheetsReady())`
      (`lib/nav/stylesheets.ts`): SvelteKit awaits it before the DOM update,
      and it resolves once every `<link rel="stylesheet">` without a
      `.sheet` has fired `load` or `error`. A link that fires neither within
      10 s is logged (`console.error`, with its address) and the page renders
      without it, so a broken stylesheet can't hang navigation. A first load
      has no `onNavigate`; the glossary's `holdAnchor` still covers that
      case. Evidence (loaded batch, help + portfolio at `--repeat-each=40`,
      12 workers): the glossary's first render had its CSS 39/40 times
      before the fix and 40/40 after; waits under load were a few ms, and
      none reached 1 s in 1,840 tests. Unloaded click → glossary on screen:
      median 59.5 ms before, 58.9 ms after (25 runs each). Tests:
      `stylesheets.test.ts`.
- [ ] **Report the CSS-before-render race upstream.** A ready-to-file
      report (versions, cause with code references, failing trace, a fix
      for each project, our workaround) is in
      [upstream/sveltekit-css-before-render.md](./upstream/sveltekit-css-before-render.md):
      file it on `sveltejs/kit` with a cross-reference on `vitejs/vite`.
      Filing publishes to an outside project, so it's the operator's call.
      Trigger: anyone with a GitHub account and ten minutes; once fixed
      upstream, `stylesheetsReady` can go after a version bump.
- [x] **`POST /projects/:id/runs` holds a DB connection for the whole engine
      run** (found by #41): the engine ran inside the request's
      transaction, so a long run pinned a pooled connection. Fixed: the
      inputs are read in a READ ONLY REPEATABLE READ transaction, the engine
      runs with none open, and the run is stored in a second transaction that
      checks the caller's role again (`runOutsideTransaction`,
      `runs/execute.ts`). The run stores the inputs it was computed from, so
      it always reproduces; a scenario run refuses (`409`) if the scenario's
      ops or base changed meanwhile. The same split covers scenario runs, an
      import's run, "Check reproduction" and storing an uncertainty ensemble.
      Jobs (`rerun`, `yield`) keep the engine in their transaction on purpose
      (their writes commit with `done`; the worker serves no request).
      The engine still occupies the Node thread while it runs; moving it to a
      worker thread is a separate change, only worth it if the API serves
      concurrent requests per process (it doesn't on Lambda).
      [architecture.md § A model run](./architecture.md#a-model-run),
      `runs/connection.db.test.ts`.
- [x] **Four e2e failures in a full local run on cb652174** (#41's class,
      2026-09-26):
      - `examples.spec.ts:70` ("Farmers (3)") was shared state, not load:
        `language.spec.ts` linked a new farmer to the seeded Sandspruit, so
        when it ran first the list read "Farmers (4)" (fails every time
        with one worker and that file order). It now uses a catchment of
        its own. #41's Members-table cases are a different thing: that
        table already waits on its loaded rows.
      - `published-baseline.spec.ts` ran twelve page loads in one 30 s
        budget; no step waited over 3 s, the budget ran out wherever it
        was. Split into three tests (24/24 at 16 workers, where the single
        test failed 4–6 of 8).
      - `runs.spec.ts:110`, `:169` (the hydrograph and EWR canvases): no
        race, the canvas appears once the flows load. But the flows were
        requested only when the charts mounted, after the browser had
        rendered the whole results page (0.4–1.1 s under load), and after
        the Runoff panel's stores and the notes count further down, so on
        HTTP/1.1 (6 connections a host) the EWR series could queue. The
        Runs tab now requests them as the run's detail arrives
        (`prefetchSeries`, `runs/cache.ts`). Chart failures at 16 workers
        went from 11 to 2 in 176 tests, at the same load.
      - Every authenticated request read the session watermark in its own
        transaction (3 round trips); now one statement
        (`queryWithoutUser`, `auth/session.db.test.ts`).
- [x] **The Runs tab's first chart still missed a 5 s wait on an
      oversubscribed machine** (2 of 96 `runs.spec.ts` tests at 16 workers,
      load average ~37 on 16 cores; none at the configured 6 workers,
      120/120 in a 10× repeat): `/auth/me` gated the page's own requests (one
      hop on every page load), and the browser spent about a second
      rendering the whole results page before any chart drew. Fixed
      2026-09-27 (#17): the root layout starts the catchment page's requests
      beside `/auth/me` (`lib/workspace/firstLoad.ts`; the page still mounts
      only once auth answers, and a failed `/auth/me` drops them), and Runs &
      results renders the groups below the flow charts only after the
      hydrograph is painted (`runs/RunCharts.svelte`; a `#res-…` link to one
      of them renders them at once). Time to the hydrograph's first paint,
      production build, median of 9 loads of an 8-year run, A/B on the same
      loaded laptop: 323 → 268 ms, and 997–1167 → 643–755 ms at 4× CPU
      throttling ([architecture.md § First load](./architecture.md#first-load-frontend)).
      Pinned by `auth.spec.ts` (request order) and `runs-page.spec.ts` (paint
      order). What is left in the chain is the Runs tab's own: its chunk, then
      the run's details, then its flows, each after the last; a chart wait
      failing at 6 workers again is the trigger to start the shown run's
      details beside the page's requests too.
- [ ] Optional:
      - a read-only Terraform plan role, for a real `terraform plan` in CI.
        Waits on the first deploy: there is no AWS account, state bucket or
        OIDC provider to plan against yet (plan.md Phase 6), and the role
        (read-only IAM + state read, trusted for pull requests without the
        `production` environment) is an IAM decision for the operator.
        Trigger: the account exists and `terraform apply` has run once (#108).
      - ~~a CodeQL Python leg for `scripts/wbt-import`~~ **Done (2026-09-28,
        issue #75):** `security.yml` analyses `python` too (the importer and
        the smaller Python tools), on Python 3.14.

## Server-side reports (WP-2.15 Phase B, issue #26)

- [ ] **The renderer image has never run on Lambda.** CI and
      the gates cover the render path with the local Chromium (the worker's
      inline renderer, MinIO, Mailpit, e2e) and the renderer Lambda's
      message handling with stubs. **Built and emulated (2026-09-28, issue
      #75):** `pnpm check:renderer-image` (CI job `renderer-image` on every
      PR, and `deploy-backend.yml` before it ships the image) packages the
      Lambdas, builds `backend/renderer.Dockerfile` and runs
      `infra/scripts/smoke-renderer-image.sh`: as a uid with no passwd entry
      on a read-only filesystem, Chromium prints a PDF with the Lambda launch
      flags, the handler answers an unparseable record under the Lambda
      runtime interface emulator (pinned v1.37 by SHA-256), and the init
      check refuses a missing `REPORTS_BUCKET`. Its first run found a real
      bug: `aws-lambda-ric` 4 refuses to start without `LAMBDA_TASK_ROOT`,
      which AWS's own base images set and this image didn't, so every render
      would have failed at init; the image now sets it. Still open: a full
      render through the handler needs the deployed site, bucket and queues
      (the production check refuses local URLs), so after the first deploy
      render one report in production and check its alarms (#92; tracked in #108).
- [x] **The DB test files ran in parallel**, although
      `backend/vitest.workspace.ts` sets `fileParallelism: false` for the
      `db` project and several tests say "a tick here sees only this file's
      jobs": Vitest 2 ignores that option inside a workspace project
      (checked 2026-09-25 with two sleeping test files). One file's tick then
      claimed another's jobs, and with the report tests' queued renders in
      the mix the job and feed tests failed intermittently. Fixed at the
      root on main (b92608e): the `db` project pins one fork
      (`poolOptions.forks.singleFork`), which does serialise the files. The
      report branch's duplicate `--no-file-parallelism` flag was dropped at
      merge. Making every tick-based test hermetic would let the files run in
      parallel again.
- [x] **MinIO's upstream image is gone** (the `minio/minio` Docker Hub
      repository answers "pull access denied"; MinIO stopped publishing
      community images in 2025). docker-compose pins the community fork's
      build (`pgsty/minio:RELEASE.2026-08-04T00-00-00Z`, github.com/pgsty/minio,
      ~800k pulls). Re-check it on each bump; the alternative is any other
      S3-compatible local server, since the app only uses the S3 API.
      **Re-checked 2026-09-28 (issue #75):** that build is still the fork's
      newest (releases every one to two months since April, ~910k pulls).
      The bumps now come to the re-check on their own: Dependabot's
      `docker-compose` entry (`.github/dependabot.yml`) proposes each new
      tag (the entry's comment says what to re-check), and CI's DB and e2e jobs
      start MinIO from the bumped tag, so a fork that stops working fails
      that PR.
- [x] **The printed network schematic is unreadable past ~10 units
      (2026-09-27).** The report prints `NetworkSchematic` scaled to the A4
      width (`svg.schematic { max-width: 100% }`), and the tree lays every
      unit that drains into one node side by side: a 30-unit catchment
      becomes a 4,500 px strip printed at ~15 %, its names about 1.5 pt
      (the on-screen report scrolls it inside its box, so only paper and the
      server PDF suffer). The Inputs table still lists every node, so
      nothing is lost, but the picture is useless. Durable fix: a print
      layout for the schematic that wraps a wide row of siblings onto
      several rows (or lays out to the A4 box, as `fill` does for the
      Network's map) with a readable floor for the labels, and an e2e case
      printing a 30-unit report that checks the label size in the PDF
      (`pdftotext -bbox`). Trigger: before a client prints a report of a
      real catchment (which can have many units), with the next change to
      `NetworkSchematic` or the report's print CSS. **Done (2026-09-27):**
      the report prints a second copy drawn with `paper`
      (`wrappedSchematicLayout`, at most five columns, a wide row of
      branches wrapped onto more rows with a gutter for their rivers; the
      screen copy is unchanged and hidden in print). A 30-unit catchment
      prints on one page with its names at ~7.6 pt of type;
      `report-schematic-print.spec.ts` prints one and checks every name's
      box in `pdftotext -bbox` (CI installs poppler-utils). Still open: the
      drawing isn't split at a page break on purpose, so a network more than
      ~12 rows deep (a long main stem wraps down, not across) runs over the
      A4 height as one picture; see the entry below.
- [x] **A printed schematic taller than a page (2026-09-27).** The paper
      layout bounds the width, not the height: a main stem of 12+ gauges
      in a chain, or many wrapped rows, is taller than A4's ~1,000 px and
      Chromium carries the one SVG over the page break wherever it falls,
      possibly through a row of names. Durable fix: split the paper drawing
      into page-high bands at a row boundary (draw each band as its own SVG
      with the rivers continuing off its edge). Trigger: a real catchment
      deeper than ~12 rows, or a client report with a cut name. **Done
      (2026-09-27):** `paperBands` cuts a paper drawing taller than its page
      just below a row's names, each band its own SVG printed whole
      (`break-inside: avoid`), the first leaving room for the heading;
      rivers crossing a cut run off one band and on from the next, with an
      arrowhead at each end (`bandCrossings`) and a "Continues on the next
      page" / "Continued from the previous page" note. A drawing that fits
      prints as one, as before. `report-schematic-print.spec.ts` prints a
      25-gauge main stem (four pages) and checks every name is whole on one
      page, inside its margins, at ≥ 7 pt of type (measured from the printed width, not the word box, whose height is each font's own metric; 2026-09-28).
- [x] **playwright-core is pinned in two places**: `backend/package.json`
      (the worker's renderer) and `e2e/package.json` (`@playwright/test`),
      plus the image tag in `backend/renderer.Dockerfile`. They must move
      together (the Chromium build is tied to the version); Dependabot bumps
      them separately. **Done (2026-09-28, issue #75):** Dependabot's
      `playwright` group bumps backend's and e2e's in one PR, and `pnpm
      check:pins` (`scripts/guards/check_playwright_pins.mjs`, CI's
      workflow-lint job) fails until all five pins agree and are exact
      (those two, `renderer-deps`' package.json and lockfile, and both
      `FROM` tags); a stale image digest fails the renderer image smoke.

## Change history (WP-2.4, issue #28)

- [x] **Field-level history affordance** (roadmap WP-2.4 UI, issue #17):
      "Changed 3× · last by Ann, 12 Aug 2026: 40% → 60%" under the node
      sheet's fields, the farm drawer's planted areas and Settings &
      calibration's parameters, linking to History filtered to the field
      (`kind=revision&unit=&q=`). One `GET …/history/fields` per project,
      fetched lazily ([api.md § Field history](./api.md#field-history),
      [ui.md § Field history](./ui.md#field-history)); History's parameter
      filter is now in the URL (`q=`) and applied by the server to
      revisions on every page.
- [x] **`api_key.*` audit kinds are recorded** now that per-project API
      keys exist (WP-2.9, `039_api_keys.sql`): `api_key.created/revoked`,
      and a key's ingest merges carry `actor_api_key_id` (now a foreign key).
- [x] **Auto re-run after an ingest or a feed merge** (WP-2.11,
      `042_auto_rerun.sql`): `series/newData.ts` `onSeriesDaysChanged`
      queues the debounced `rerun` from `mergeInto`, the PUT route and the
      data feeds' ingest. A key's re-run runs as the key's creator through
      `SECURITY DEFINER app_enqueue_rerun` (no job policy for keys); a key
      whose creator was deleted skips it.

## Allocations (WP-3.10)

The first slice (2026-09-26: migration 038, engine `compareAllocations`,
`backend/src/allocations/`, the Allocations tab; [allocations.md](./allocations.md))
stores registered volumes and compares them with a run's modelled use. Left,
from the WP:

- [x] **Engine `allocationMode`** (2026-09-28, engine 1.18.0, issue #72):
      `none` | `cap` | `fullAllocation`, with `RunSummary.allocations`, the
      `allocations` self-check (`checkAllocations`, also in the fuzz's
      invariants) and every run's input carrying the volumes (no names).
      `cap`: each unit's surface and groundwater use per water year within
      its whole-year registered volumes; `fullAllocation`: its demand scaled
      per water year to them, keeping its own seasonal shape (not the
      licence's months, which only the cap applies, below). Warm starts carry
      both ([model.md §2.12a](./model.md#212a-allocations-and-full-allocation-runs-engine--1180-issue-72)).
- [ ] **How the cap counts water drawn from a dam boreholes filled.** The
      cap counts every dam draw as surface use, so groundwater pumped into a
      dam and drawn out uses both volumes, where the comparison nets it
      (§2.12). The durable fix is a per-day provenance of stored water (the
      pumped share of each dam's storage) so the cap nets it the same way.
      Trigger: the hydrologist's answer on s21b and the netting (#90).
- [x] **`settings.allocationTolerance`** (2026-09-28, issue #72): the
      comparison's band as a project setting (Settings › Registered volumes,
      default 0.1, pending the hydrologist); `?tolerance=` still overrides it
      for one request.
- [x] **Licence impact board on a full-allocation background** (2026-09-29,
      issue #53 R7, [model.md §2.14a](./model.md#214a-licence-impact-by-year-class-issue-53-r7-engine-and-report)).
      With #116's allocation mode merged, a baseline that is a
      full-allocation run makes the board's step *existing authorised use*,
      and a pair with only one run at full allocation is said so
      (`report/licenceImpact.ts`). Making the pair for an assessor in one
      step is WP-3.11's cumulative assessment (roadmap step 3).
- [x] **WARMS per s21 water use** (2026-09-30, migration 142, engine
      1.59.0, issue #72): the importer reads a water-use code (21(a) a take,
      21(b) a dam's storage), the unit and the frequency, and refuses an
      ambiguous row (no code, two uses, another s21 use, a missing or
      non-annual unit, two storages) rather than guess; a WARMS extract
      without the code column is refused. A 21(b) row is stored as storage
      only and never caps, scales or compares as a take
      ([allocations.md § Importing](./allocations.md#importing)).
- [ ] **A real WARMS extract** to check `HEADER_ALIASES` (the water-use,
      unit and frequency spellings included) against, then XLSX import and a
      column-mapping step for unknown headings. Until then an unknown heading
      is listed as "not read". Trigger: the client sends an extract
      (plan.md questions; DWS supplies extracts on request).
- [x] **Licence conditions** (2026-09-28, migration 103, issue #72):
      `months`, `max_rate_m3s`, `conditions jsonb` on each allocation, in the
      form, the list, the import template and the export, and on the run's
      input.
- [x] **Apply licence conditions in the cap** (2026-09-30, engine 1.37.0,
      issue #72): no supply of a source on a day outside the months of use
      of every allocation of it in force, and at most their maximum rates
      × 86 400 a day (`dailyLimits`); the day's room is the smaller of that
      and what is left of the year's volume, and the `allocations`
      self-check replays both. `fullAllocation` still scales to the volume
      only ([model.md §2.12a](./model.md#212a-allocations-and-full-allocation-runs-engine--1180-issue-72)).
      Whether the months and rate should bind the dam draw or only the
      river-side takes is engine-audit L2 (pending the hydrologist, #90).
- [x] **Say when a licence's months or rate bound, not only the volume**
      (2026-09-30, engine 1.40.0). `RunSummary.allocations` sources carry
      `limitBound` beside `capReached`: per water year the days the limit
      held use back (the source took all its room and the unit went short),
      split into volume used up, maximum rate and outside the months of use.
      A source whose licence states conditions stores `allocation_left_*`
      beside the room. Checked from the columns by `checkAllocations`; shown
      under the picked unit on the Allocations page, in the compare
      endpoint's `capYears`, the summary CSV's *Allocation cap by water
      year* and the evidence report's § 5 ([allocations.md](./allocations.md), [model.md § Which limit
      bound](./model.md#212a-allocations-and-full-allocation-runs-engine--1180-issue-72)).
- [x] **Cite the cap's limit days in the evidence report** (2026-09-30,
      report version `evidence-6`). § 5 carries each cap run's
      `capReached` / `limitBound` per unit and source
      (`EvidenceAllocationSource.capA` / `capB`) and prints them in *What the
      cap held back* ([allocations.md § In the evidence report](./allocations.md#in-the-evidence-report)).
- [x] **Farm view: a farmer's own registered volume** (2026-09-30, issue
      #72): *Your registered water* shows the farm's own volumes a year and
      dam storage in force today beside the season's modelled supply and the
      modelled dam, with "not an entitlement" (`FarmView.registered`; no
      name or registration number). Not blocked by D3, which is about other
      people's names and volumes.
- [x] **D3: who sees registered water use** (2026-10-01, migration 162,
      provisional position, pre-counsel research). Viewers read each volume
      only once an owner switches it on, else totals per water source at 5
      or more registered users; § 5 of the evidence report lists only the
      applicant's own units, the rest as totals (`evidence-15`); a WARMS
      extract needs its reference; Privacy §5 says so
      ([allocations.md § Who sees what](./allocations.md#who-sees-what)).
- [ ] **Share views: allocation totals** (D3 (c), narrowed): totals only, at
      5 or more holders (the share links' `k` rule), never a unit beside a
      volume or a name. Share views show no allocation figure today, so
      nothing leaks; this is the feature, to the rule. Trigger: a client
      asks for registered use on its public page.
- [ ] **A capped run's per-unit series still bound a viewer's guess at the
      volume** (D3). With viewers' switch off, a viewer reads no copy of the
      volumes, but a cap run's daily `supplied` per unit is held to its
      volume, and `allocation_left_*` (a capped source with licence
      conditions) is the volume less use so far; a viewer's project
      `model-input` also omits the volumes (RLS), so a fit they run in a cap
      project runs uncapped. Durable fix: for a viewer with the switch off,
      leave `allocation_left_*` out of the series routes and exports, and
      say on a cap run's per-unit pages that its use is capped by a volume
      they can't see. Trigger: a project with outside viewers runs in cap
      mode, or counsel reads per-unit modelled use as personal information.
- [ ] **Registration numbers in History** are readable by viewers
      (`allocation.created/changed/deleted` carry `registrationNo`), and a
      registration number is a "unique identifier" (POPIA s1). Durable fix:
      leave `registrationNo` out of those events for a viewer in the History
      route (as `allocation.viewer_units` is off). Trigger: with the share
      views item above, or counsel's review (#92).
- [x] **Dam capacity vs registered storage** (2026-09-30, issue #72): the
      comparison's `storage` carries the difference and a status banded like
      a year's use, and the Allocations page says it in words.
- [ ] **Dam filling vs registered storage** (s21b): whether filling a dam
      from the river is also a s21(a) take, and so how the comparison and the
      cap count it. The comparison counts supply from the farm's own dam as
      abstraction. Pending the hydrologist (issue #90).
- [x] **POPIA**: allocations and holder names in the data-subject export
      (2026-09-26). `GET /auth/me/export` lists, per linked farm, the
      allocations matched to it with the holder name (what RLS already lets
      the farmer read). Never matched by name to an account: names aren't
      unique ([security.md § Allocations](./security.md#allocations-popia-minimisation-038_allocationssql)).
- [x] **Evidence pack and chart** (2026-09-29, issue #71): the evidence
      report's § 5 *Registered water use* (the over/under-use chart, the
      per-unit and per-year comparison, each run's own volumes and mode),
      the fixed page-1 row *Registered vs modelled use* and its flag
      ([allocations.md § In the evidence report](./allocations.md#in-the-evidence-report)).
      The issued pack (WP-3.14) freezes the document, so it carries § 5 once
      the pack lands.
- [x] **Over/under-use chart on the Allocations tab** (2026-09-29, issue #71
      follow-up): the report's `UsePlot`, moved to `allocations/` and shared,
      heads the tab's *Every hydrological unit and water year* for the
      compared run (drawn at its box's width, labels on their own line on a
      phone, the first ten rows until Show all), and both charts carry a
      screen-reader description counting the whole years above the band
      ([ui.md § Allocations](./ui.md#allocations-taballocations)).

## Catchment map (issue #288)

Phases 1–2 of WP-3.12 landed (2026-10-01: migration 152, `backend/src/geo/`,
the Map tab, Settings → WR2012 check → Propose from the map;
[maps.md](./maps.md)). Left, from the WP and the issue:

- [ ] **Shapefile import** (zipped `.shp`/`.dbf`/`.prj`, parsed in the browser
      with `shpjs`, reprojected from the `.prj` with proj4, Hartebeesthoek94
      Lo zones; an unknown projection refused). Today the form turns a
      `.zip`/`.shp` away with how to export GeoJSON in EPSG:4326 from QGIS.
      Needs the zip-bomb test and the "Lo projection within 0.5 % of a
      reference area" acceptance test. Trigger: a client holding only
      shapefiles.
- [x] **Production basemap** (2026-10-02, PR feat/infra-map-data): the
      tiles bucket and the same-origin `/tiles/*` behaviour
      (`infra/map_data.tf`, `s3_cloudfront.tf`: cached, its own OAC, the
      `tiles_range` function letting an archive through only by one range of
      at most 2 MiB, the cost bound), the three `PUBLIC_TILES…` variables
      through `deploy-frontend.yml` behind a gate that takes only same-origin
      `/tiles/` paths, and delineation's DEM (`delineation_dem`: `DEM_URL` on
      the API and its role's read of `tiles/terrain.pmtiles`, refused on an
      API Lambda under 1 024 MB or 25 s). CSP unchanged. Tracing a dam's
      water occurrence followed the same pattern (#326 C2: `dam_trace_water`,
      `WATER_URL` and the read of `tiles/water.pmtiles`). What's left is the
      operator's (uploading, the variables, the tfvars:
      [deployment.md § Map tiles](./deployment.md#map-tiles)) and the item
      below.
- [x] **The licence sentences the map's production data waits for**
      (operator + legal text; maps.md § Sources): the Copernicus WorldDEM-30
      liability sentence (Art. 6(c): "The organisations in charge of the
      Copernicus programme by law or by delegation do not incur any liability
      for any use of the Copernicus WorldDEM-30") and HydroSHEDS' Exhibit B
      statement are done (2026-10-02, on the public Data sources and credits
      page, `/data-sources`), and so are the terms' end-user protections for
      HydroRIVERS (2026-10-03: Terms §9's clause on map data licensed to us,
      no stand-alone redistribution, no reverse engineering; `LEGAL_VERSION`
      2026-10-03, legal-status.md). `scripts/release/map-data-gates.mjs`
      refuses `PUBLIC_TERRAIN_URL` and a `rivers` load until the sentences
      are in `frontend/src`'s legal text (rivers: the Exhibit B statement and
      the §9 clause); they are, so what is left is the operator's at deploy time: uploading `terrain.pmtiles` (which the
      `/tiles/*` behaviour then serves to anyone) and `delineation_dem` are
      the operator's to do only after the Art. 6(c) sentence is live
      (Terraform can't see the frontend, and the upload is outside it). Trigger: the first deployment that wants the relief,
      Delineate or the River network layer.
- [x] **Loading the quaternary dataset in production** (2026-10-02, PR
      feat/infra-map-data): the production path for every reference dataset
      is built (the migrate Lambda reads one file from the private reference
      bucket, hash-checked, through `load-reference.yml` in the `production`
      environment; [deployment.md § Reference datasets](./deployment.md#reference-datasets)).
      It refuses `quaternaries` by name while the WR2012 decision below is
      open; on a yes, mark the Sources rows allowed and add the kind to
      `REFERENCE_KINDS` (`geo/referenceLoad.ts`, with its parser) and
      `LOADABLE` (`scripts/release/map-data-gates.mjs`).
- [ ] **Decision: WR2012's licence terms** (operator; maps.md § Quaternary
      dataset, roadmap Step 4 D5). Until the WRC confirms redistribution,
      WR2012 values are loaded only from the operator's own registered
      download, never committed or shipped.
- [ ] **Decision: the DWS station catalogue's licence** (operator; maps.md
      § Sources, issue #326 B-gauge, decision D-B). The Verified data pages
      answer 403 outside South Africa, and DWS's information pages restrict
      use to "academic, research or personal purposes". Ask DWS Hydrological
      Services in writing whether station metadata may be reused in a
      commercial service; until then the nearest-gauge proposal reads only
      the synthetic list. On a yes: record it in the sources table, load the
      catalogue with `pnpm import:gauge-stations`, and allow the
      `gauge-stations` kind on the production path (`geo/referenceLoad.ts`,
      `scripts/release/map-data-gates.mjs`, the workflow's choices), which
      refuses it until then.
- [ ] **HydroRIVERS in production** (issue #345; maps.md § River network,
      § Sources). The licence allows commercial use (checked 2026-10-01),
      on two conditions, both met. The HydroSHEDS Exhibit B statement
      (2026-10-02): the public Data sources and credits page
      (`/data-sources`) carries it, and the map's attribution control
      credits HydroRIVERS, linking there, while its reaches are drawn. The
      end-user protections the agreement asks for (2026-10-03, § 2.1.2 and
      § 2.1.3): Terms §9's clause on map data licensed to us (no stand-alone
      copying or distribution, no reverse engineering; the licensors keep
      ownership and give no warranty), pre-counsel wording, `LEGAL_VERSION`
      2026-10-03 (legal-status.md). What is left is loading it with
      `load-reference.yml` (kind `rivers`, built 2026-10-02; its gate checks
      both texts are in the legal text).
      Trigger: the first deployment that wants the River network layer.
- [ ] **Decision: DWS 1:500 000 rivers' licence** (operator; maps.md §
      Sources, issue #345, D-B). Its page answers 403 outside South Africa
      and DWS's published wording is non-commercial, so HydroRIVERS is used.
      Ask DWS in writing only if hydrologists want the national 1:500 000
      set itself (#90 Q23 asks the client whether OSM's rivers already do).
- [ ] **Contributor-owned features** (WP-3.3 × WP-3.12): `map_feature.scenario_id`
      so an applicant places their own scenario's features, with the RLS
      the WP describes. Today only editors write; farmers and applicants
      read (RLS) but no route serves them.
- [x] **Feeds from the boundary** (WP-2.10 × WP-3.12, S): done in issue
      #326 B-rain (2026-10-01): Settings → Data feeds → **Use the catchment
      boundary** proposes the CHIRPS cells the boundary covers, weighted by
      the share of each inside (exact clipping), and an owner applies it
      ([maps.md § Rain from the boundary](./maps.md#rain-from-the-boundary)).
- [ ] **Re-read a feed's record over new cells** (WP-2.10, M; found in #326
      B-rain): new cells (from the boundary, or a redrawn one) go only to a
      feed whose series is empty, else to a new feed in a separate series,
      because a feed's existing days were averaged over its old cells and it
      never splices two areas. Durable fix: a staged same-product
      replacement, like the version replacement of issue #40c (backfill the
      whole record over the new cells in `feed_stage`, swap it in whole),
      so the boundary feed can take over the default series. Trigger: a
      hydrologist wanting the boundary's rain in an existing CHIRPS series
      without comparing two series.
- [x] **Drawing polygons on the map** (D9 (b)): superseded by issue #326
      C1 (2026-10-01): editors draw polygons and lines, place points by
      click, and reshape them, with paste-a-shape and keyboard placement as
      the non-pointer paths ([maps.md § Drawing](./maps.md#drawing)).
- [x] **Dam polygons → the full-supply area** (2026-10-01, issue #326
      B-dams): a dam polygon linked to a unit proposes its area as the dam's
      `damAreaFullM2` on Dams → Proposed from the register and the map, with
      Use and a model revision naming the polygon ([maps.md § Dams from the
      register and the map](./maps.md#dams-from-the-register-and-the-map)).
      What stays open is the rest of the curve: a polygon gives one point
      (the area when full), not the area–volume shape below it, which needs
      a survey or a DEM (the "A resized dam follows its own area–volume
      relation" item, and B-delineate's DEM).
- [ ] **Decision: the DWS register of dams' licence** (operator; maps.md §
      Sources). The Dam Safety Office's List of Registered Dams and its
      Google Earth overlay state no licence, and DWS's data terms elsewhere
      restrict use to academic, research or personal purposes. The dam
      proposals are built and tested against the synthetic register; ask
      DWS (Dam Safety Office) for written permission for commercial use
      before a client deployment loads the real list. Trigger: the first
      client who wants register capacities proposed.
- [x] **Sub-catchments at every dam and abstraction point** (#326
      B-delineate's stretch): built with C3, start a catchment from the map
      (migration 178, `delineation/subcatchments.ts`,
      design/start-from-map.md). One routed window, each unit's incremental
      area with its holes, the order from the D8 tree.
- [x] **Sub-catchments for a model that already has nodes** (#326 C3):
      done 2026-10-02 (PR feat/326-start-followups, migration 182):
      **Divide the model** on the Map proposes each linked unit's own area,
      drains-into and runoff to its dam from the same partition, beside its
      current values, each taken only when ticked; a value changed since
      the proposal is refused, never overwritten
      (design/start-from-map.md § Dividing a model that has nodes).
- [x] **Each proposed unit's outline told apart on the map** (#326 C3):
      done 2026-10-02 (PR feat/326-start-followups): each piece drawn on
      its own, tinted, with its number as a badge (no glyphs needed); the
      sheet's cards carry the same number and are the key; a card with the
      focus or the pointer lights its piece, and a piece clicked on the map
      opens its card (design/start-from-map.md § Each unit's piece on the
      map).
- [x] **Intermediate gauges in a model started from the map** (#326 C3):
      done 2026-10-02 (PR feat/326-start-followups): a gauge other than the
      outlet is a gauge node in the order by default, partitioning like a
      water user; a division can add an unlinked gauge as a new gauge node
      (design/start-from-map.md § Gauges as nodes).
- [ ] **The elevation model's channels from the tiles pipeline** (issue
      #374 item 3, maps.md § The elevation model's channels): today each
      0.2° tile is routed on request and kept in an in-memory cache, which
      on Lambda lasts one instance, so a production user pays a few seconds
      and an elevation-model attempt per tile per cold instance. Durable
      path: build the channel lines once per DEM in the tiles pipeline (a
      `pnpm dev:tiles:channels` step and the production tiles bucket, as
      vector PMTiles) and draw them like the basemap. Trigger: the first
      production deploy with `delineation_dem = true`.
- [x] **Delineation of catchments larger than about 100 km across**
      (2026-10-03, branch wip/r2-delineate-job; design/delineation.md §
      Where it runs): a click still at the edge of the request's window
      goes to a `delineate` job on the worker (191_delineation_request), the
      same code with windows up to 6 144 cells (about 200 km) in its 300 s,
      the worker at 2 048 MB with `delineation_dem` on; the Map waits for it
      and decides the proposal as any other. Past 200 km it is still
      refused, not cut off. (Sub-catchments from clicks don't use it: a
      click past the window is an inflow point, maps.md § Sub-catchments
      from clicks.)
- [x] **Loading the register of dams in production** (2026-10-02, PR
      feat/infra-map-data): the reference-dataset path is built and refuses
      `dam-register` while the register's licence decision above is open; on
      a yes, allow the kind as for the quaternaries.
- [x] **Loading the land-cover grid in production** (2026-10-02, PR
      feat/infra-map-data): `pnpm import:land-cover … --out <file>.json.gz`
      pre-summarises the WorldCover tiles on the operator's machine, and
      `load-reference.yml` (kind `land-cover`) loads that file into RDS
      through the migrate Lambda: one operator path for every reference
      dataset, the licence-blocked kinds refused by name
      ([deployment.md § Reference datasets](./deployment.md#reference-datasets)).
      Show the WorldCover attribution with any figure served.
- [ ] **Decision: SANLC's licence** (operator; maps.md § Sources, issue
      #326 B-landcover, decision D-B). South African National Land Cover
      would give crop classes WorldCover lacks (centre pivots, orchards,
      vineyards, sugar cane), but the earlier release's GEOTERRAIMAGE licence
      is CC BY-ND with no commercial resale and no competing products, and
      DFFE's e-GIS pages (the 2018/2020 terms) refuse connections from
      outside South Africa. Ask DFFE in writing whether SANLC 2020 may be
      reused, with derivatives, in a commercial service; on a yes, record it
      in the sources table and load it as another dataset (`--classes` with
      its cultivated class codes; the loader takes EPSG:4326 only, so a
      projected release is reprojected first). Until then the
      proposals read WorldCover or the synthetic grid. Trigger: a
      hydrologist asking which crop the land cover sees, or WorldCover's
      cropland class proving too coarse in a client catchment.
- [x] **Loading the evaporation grid in production** (issue #326 B-evap,
      2026-10-02, PR feat/evaporation-production-load): `pnpm
      import:evaporation <years> --dataset <label> --out <file>.json.gz`
      averages the reduced dPET years into the grid of monthly means on the
      operator's machine, and `load-reference.yml` (kind `evaporation`)
      loads that file into RDS through the migrate Lambda
      ([deployment.md § Reference datasets](./deployment.md#reference-datasets)).
      Only a reference-ET grid loads (an A-pan grid's source has no allowed
      Sources row); its caps are 32 MiB uploaded, 64 MiB unzipped. The
      dPET/ERA5-Land attribution is stored on the dataset row and shown
      under every proposal; its credit on the /data-sources page waits for
      that page (PR #354).
- [x] **One shell for the map-proposal panels** (found in #326 B-evap's UI
      review). Done: `components/proposals/ProposalPanel.svelte` draws the
      frame (heading, intro, controls, the live notice that takes the
      keyboard after a Use, the `aria-busy`/`data-ready` body, the failure
      with Try again) and `ProposalNoDataset`, `ProposalSynthetic` and
      `ProposalSource` the shared alerts and citation; land cover, the dams
      and evaporation each keep their data, rows, Use and words. Pinned
      first by `e2e/tests/proposal-panels.spec.ts` (each panel's failure
      and Try again) and each panel's own spec, which now also checks the
      focus move after a Use for land cover and the dams. A new proposal
      panel starts from `ProposalPanel` (ui-playbook.md § 4).
- [ ] **Decision: WR2012's evaporation, and an A-pan source** (operator;
      maps.md § Sources, issue #326 B-evap, decision D-B). The map proposes
      reference ET (dPET) as GR4J's PE, never as A-pan, so demand and dam
      evaporation still take the A-pan row typed from WR90/WR2012 or a
      station. WR2012's evaporation (S-pan per quaternary) is blocked with
      the rest of WR2012 (the WR2012 decision above) and is S-pan, which
      would need the hydrologist's S-pan → A-pan factors; no open A-pan grid
      passes D-B (Global-AI_PET v3.1 is non-commercial, WaPOR's RET is CC
      BY-NC-SA, ERA5-Land's `pev` is known to be wrong). On a WRC yes:
      convert WR2012's S-pan to A-pan with stated monthly factors, keyed
      per quaternary (a quaternary-keyed variant of the grid, or
      rasterised to it), load it as kind `apan`, and record it in the
      sources table. Trigger: the WR2012 decision, or a hydrologist asking
      for the A-pan row from the map.

- [ ] **Divide and start: a piece's area from its cells, not its simplified
      outline** (persona-hydrologist, round 4, 2026-10-02). The DEM
      partition is exact in cells, but each piece's `areaM2`
      (`backend/src/delineation/subcatchments.ts` `piece()`) is its
      Douglas–Peucker-simplified outline's geodesic area, so the pieces and
      the rest add up to −0.51 % of the catchment on the synthetic DEM, more
      on small, jagged pieces. The cell area is already summed (`cellArea`,
      used only when the outline fails). Durable fix: take each piece's area
      from its cells and keep the outline for display, *and* decide what the
      saved parcel's `area_m2` is (today the unit's area equals its parcel's
      outline area, which "area from the map" relies on): either store the
      cell area on the parcel too, with the outline marked simplified, or
      simplify less. Trigger: a divide whose pieces fall more than 1 % short
      of the catchment, or the first real DEM catchment with many small units.

## Crop factors (issue #54 item 1)

- [x] **Reference crop library and Load crop factors** (2026-09-26). ARC/SABI
      A-pan factor tables and
      SABI 2021 system efficiencies, loaded into the crop table from the Crops
      tab with a diff and the demand difference, saved through the normal
      save bar ([model.md §2.3 item 8](./model.md), [ui.md § Load crop
      factors](./ui.md#load-crop-factors)). No project's numbers change by
      default.
- [ ] **The hydrologist's choice (Q9/Q10).** Which crop set each catchment
      uses (library, a node-based workbook's factors × Kp, their own) and which irrigation systems the
      farms have. Then record the choice and evidence in
      `docs/engine-audit.md` and load it (the dialog does the loading).
      Also for them to confirm: a Table 4.14 part month (e.g. mealies to
      15 Feb) keeps its printed factor rather than being prorated, and the
      stage-to-month rule for vegetables (model.md §2.3 item 8). Trigger:
      their answer on #46.
- [x] **b023 crop-table slips flagged on import** (2026-09-30, issue #289).
      Rows copied from another crop, a negative factor, a lone 0, a lone
      spike or dip of more than 0.3 and a factor above 1.0 each give an
      import-report warning (`crop-factors-copied`, `crop-factors-suspect`),
      both importers alike; the factors import unchanged ([model.md §2.3
      item 3](./model.md)). Load crop factors lists them under a b023
      workbook source too ([ui.md § Load crop factors](./ui.md#load-crop-factors)).
- [x] **A node-based workbook's crop sheets** (2026-09-30, issue #289).
      The reader, `spreadsheet/import/nodeCrops.ts`, reads them. It
      finds [Crop_Factors] and [Crop_Areas] by name (ignoring case, spaces
      and underscores) and their tables by header row (twelve month names in
      any order, then "Crop(s)"; "Farm …" then a column per crop). It returns
      each crop's twelve factors (Oct..Sep) and efficiency, each farm's areas
      in m² (hectare columns converted), the A-pan and effective-rainfall rows, and warnings (a missing
      sheet or header, a non-numeric or out-of-range cell, a duplicate, a
      crop in one sheet but not the other). The set is marked
      `shape: 'fao-et0'`. It runs in the import worker
      (`createWorkbookImport().readNodeCrops(file)`), parses only those two
      sheets and is tested on a synthetic workbook of that layout
      (`testWorkbook.ts` `syntheticNodeBased`). Load crop factors
      offers it as its third source, with Kp defaulting to 0.75
      (`SOURCE_KINDS`, `defaultKp` in `crops/loadFactors.ts`) and the
      reader's warnings listed ([ui.md § Load crop
      factors](./ui.md#load-crop-factors)).
- [x] **One table of irrigation efficiencies; drip the new-farm default**
      (2026-09-28, issue #90 answering #54 Q10). The engine's
      `IRRIGATION_SYSTEMS` is now the SABI 2021 Table 4 set with Q10's values
      (drip 0.90, micro 0.82, pivot 0.85, permanent sprinkler 0.80, movable
      sprinkler 0.75, surface 0.70); the crop library's `LIBRARY_SYSTEMS`
      re-exports it and the farmer view names the nearest of it. New farms
      start on drip (`NEW_FARM_IRRIGATION` e = 0.90; migration 099 sets the
      column default). Saved farms keep their values (a value off the table
      shows "Other" in the helper); no engine version change, since the run
      reads neither ([model.md § Irrigation efficiency](./model.md)). Still
      the hydrologist's: which system each farm's crops are under (the item
      above).

## Demand objects and run of river (issue #54 items 2b–2d)

- [x] **Demand objects, phase 1** (2026-09-27, engine 1.7.0, migration 088).
      Several non-crop demands per unit (category, monthly or per-unit
      sizing with losses and a profile, return share, priority against the
      crops, internal or piped out), supplied from the unit's own sources,
      reported per object ([model.md §2.7f](./model.md)); the Network node
      form's Demand objects section ([ui.md](./ui.md)); the b023 importers map
      a gross demand typed over the crop formula to one
      (scripts/wbt-import/README.md). No project's numbers change.
- [x] **A pump capacity on other water users** (2026-09-30, engine 1.58.0,
      no migration). The farm's `pumpCapacityM3Day` on a user node, no supply
      rule; a senior user's claim capped to it; the `pump_limited` series and
      summary means; the Other water users panel's
      Pump capacity with the pumps × m³/h calculator, a scenario `node.set`,
      the run comparison and the summary CSV ([model.md §2.7c](./model.md)).
      No importer sets it: neither b023 importer creates user nodes. Its
      policy choices are listed under § Hydrologist.
- [x] **A water source per demand: river abstractions beside a unit's dam**
      (2026-10-01, engine 1.65.0, migration 170, issue #344, #342 items 4
      and 5). A unit's crops and each demand object draw on the dam (the
      default, the unit's supply rule) or on a river abstraction of their
      own with its own pump and an optional pool (capacity only: it starts
      full, its area is estimated), after the dam side, from the flow passing
      the dam with its spill, by the demand objects' supply order
      ([model.md §2.7j](./model.md)). The node form's **Water for …**
      fields, a scenario `node.set` / `demandObject.set`, the run comparison,
      the series `river_take@`, `river_pool@`, `river_pool_evaporation@`,
      `FarmSummary.riverTakes` and the water balance's pool evaporation.
      Supersedes draft PR #341's pool on a dam-less run-of-river unit. No
      importer sets it (b023 has no such abstraction). The decisions are
      open question R2 in engine-audit.md, listed under § Hydrologist.
- [x] **A river abstraction's pump-limited demand** (2026-10-02, engine
      1.66.0, follow-up from PR #350). Each abstraction with a pump capacity
      publishes `river_pump_limited@<key>`: the demand its pump left unmet
      while the flow its level left, or its own pool, still had the water
      (within the allocation room), as an other water user's `pump_limited`
      does (§2.7c). `RiverTakeSummary.avgPumpLimitedM3Day` and
      `daysPumpLimited`; the Units & supply **River abstractions** table and
      the summary CSV's River abstractions block show them
      ([model.md §2.7j](./model.md)). Nothing else in the run changes.
- [x] **Run of river from the importer** (2026-09-27). `--run-of-river`
      (seed: `WBT_RUN_OF_RIVER=1` per workbook) imports the flagged dummy-dam
      and dam-less units as run of river with an uncapped pump; set per
      workbook in the private seed settings.
- [x] **Demand objects: date-window schedules** (2026-09-28, engine 1.17.0,
      migration 105, issue #90 Q4 and Q12). The client answered: the daily
      pattern depends on the demand type (a town's is fixed, irrigation's
      varies) and the switch is set by date, not by river flow. A `schedule`
      on the object: windows (every day, a yearly MM-DD span wrapping the
      year end, a one-off date range, days around Easter), narrowed to
      weekdays, each with a factor (0 = off), the later window winning;
      applied in `network/demandObjects.ts planObjects` before the split and
      recomputed by the self-checks; days off reported apart from days
      short (`DemandObjectSummary.daysOff`); the node form's On/off schedule
      ([model.md §2.7f](./model.md), [ui.md](./ui.md)). Off keeps today's
      meaning: no demand, so no supply and nothing returned.
- [ ] **Demand objects: the off reason (parked 2026-10-01).** Not built.
      The hydrology holds up, but no catchment we hold has an on/off schedule,
      so building it now would be guessing at a need (issue #54). Open
      (issue #90 Q12, parked): what causes
      off days (occupancy, works downtime, load-shedding, switching to a
      borehole), whether an off period can mean "supplied from elsewhere"
      (no river take, the return goes on) or "curtailed" (counted as a
      shortfall) rather than "not needed", and whether a treatment works
      keeps discharging while its user is off the river. Today every off day
      is "not needed" (no demand, no return). Durable fix: a `reason` on a
      schedule window (`notNeeded` / `elsewhere` / `curtailed`), carried into
      the return as a per-day override (an `elsewhere` day keeps its return,
      from a set discharge or the recent mean) and into the summary
      (curtailed days as short, elsewhere days as met elsewhere). Trigger:
      a real demand object whose off days aren't "not needed".
- [x] **Demand objects: an uploaded daily factor series: dropped
      (2026-10-01, issue #54).** The date-window schedules cover recurring
      patterns, common practice (WEAP) uses monthly profiles plus windows,
      and no record we hold needs a daily series. Reopen only if a client
      brings a record the windows can't describe.
- [x] **Demand objects: a structured demand source** (engine 1.56.0,
      2026-09-30, migration 139; issue #54 Q11, confirmed in issue #90). A
      `source` on the object (`meter` | `aadd` | `perCapita` | `other`, null =
      not recorded, the note kept for the detail); `meter` and `aadd` must be
      sized `monthly`, `perCapita` `perUnit` (modelRules `doSourceSizing`).
      Set by the node form (picking a source sets and locks the sizing), the
      scenario ops and both workbook importers (`other`, the typed-over
      demand); a record only, so a run is the same with any source. Shown in
      the run's demand-objects table (a Source column and each source's
      share of the demand) and the summary CSV ([model.md §2.7f](./model.md)).
- [x] **Demand objects: the source in the evidence report** (report format
      `evidence-9`, 2026-09-30, issue #259). § 6 of the evidence report
      lists each demand object on the applicant's units (theirs, or a unit
      the application adds) in either run: what the application does to it
      (added, changed, removed, unchanged), its sizing, its source and note
      as the model holds them, each run's mean demand and its share
      supplied, with the by-source line the run's table prints above it
      (`demandBySource` moved to the engine as `network/demandSources.ts`,
      `demandSourceShares` for the report, which says "not recorded" even
      when nothing is). Page 1 cautions when less than half of that demand is
      from meter records, and *Expect questions about* names the objects with
      no source. The PDF and the preview are the same layout. A pack drafted
      before `evidence-9` has no `demandObjects` and prints without § 6, its
      stored manifest still matching its hash ([evidence-pack.md](./evidence-pack.md#what-a-pack-holds),
      [ui.md § Evidence report](./ui.md#evidence-report)).
- [x] **Restrictions: the basic-needs floor** (2026-09-30, engine 1.44.0,
      issue #123, migration 127; agreed in issue #90 Q13). A domestic or
      municipal demand object has a floor of population × 25 l a day (its
      `population`, or a per-person object's count); a `demand.scale`
      restriction never cuts it below that, the curtailment report and the
      share-the-pain board never leave its unit less than its floor once the
      EWR is met (what the floor keeps is shown), and the results, the
      summary CSV and the demand-objects table report the days and volume
      below the floor apart from the shortfall, with the l/person/day
      supplied as the municipal level ([model.md §2.7f](./model.md)). Cuts
      stay one % for every category (#53 O4). WP-3.8's drought restriction
      rule (a cut by dam level) holds the same floor: done (engine 1.54.0,
      2026-09-30, [model.md §2.7i](./model.md)), through `planObjects`'
      floor and `dayFloor`, checked by the `droughtRestriction` self-check.
- [x] **A scenario op for demand objects** (engine 1.45.0, 2026-09-30;
      related: issue #73 "Later scenario ops"). `demandObject.add` /
      `.set` / `.remove` ([scenarios.md § Op catalogue](./scenarios.md#op-catalogue)):
      add checks every field and puts the object on a unit only; set changes
      one field (every one but `id` and `nodeId`, the schedule rebuilt from
      its windows' fields), consecutive sets on one object are one edit
      group (a sizing switched with its count and litres); the save rules
      apply after each group. Classified by the object's unit (proposal on
      an owned unit, as a borehole). Applicants: a `demandObjects` mask kind
      (opaque id and name, `applicationMask`, the results' `reIds`), and
      `node.remove` counts only objects they see. Override mode records an
      object added, changed (per field, schedule included) or removed, and
      "Add a change" has the three ops, the schedule included. Run comparison now lists a changed object note. The fuzz
      generator and the invariants cover them.
- [x] **Per-category scaling of demand** (engine 1.45.0, 2026-09-30; issue
      #123's DWS % restrictions per category). `demand.scale` takes an
      optional `part`: `crops` (a unit's crop water requirement) or a demand
      object category (`domestic`, `municipal`, …), so a what-if cuts
      domestic by 10 % and irrigation by 30 % as two ops. A part's factor
      stacks on the unit's own and goes through the same basic-needs floor
      (engine 1.44.0, `planObjects`): a domestic or municipal cut never goes
      below the floor ([scenarios.md § Demand scaling](./scenarios.md)).
- [x] **WP-3.8's drought restriction rule** (engine 1.54.0, 2026-09-30,
      [model.md §2.7i](./model.md)). `settings.droughtRestriction`: review
      and lift dates and up to six levels, each a storage threshold on the
      total farm dam storage and a % cut per part of demand (crops, each
      demand-object category), the basic-needs floor kept; off by default.
      Series `restriction_level`, `restriction_cut@<part>`,
      `restricted_demand`; `RunSummary.droughtRestriction` and its summary
      CSV block; the `droughtRestriction` self-check; Settings → Drought
      restrictions, the Units & supply tables and the outlook's "Use as the
      drought restriction rule" (the review triggers, R6); `settings.set`
      in scenarios and the run comparison's lines. No migration: the rule is
      part of `project.settings` (jsonb). Also built (engine 1.54.0, the
      same PR): the rule on some dams or each unit's own dam (`basis`,
      `damNodeIds`) and on some units (`nodeIds`), moved with a project
      copy; the EWR-failure trigger (`ewrTrigger`, the site's EWR not met
      the day before a review); a rule started from the WUA's published
      notice (`restrictionRuleFromNotice`, in Settings and the scenario
      form); and resumed runs, bit-identical to the uninterrupted one and
      self-checked. Cutting the other water users is a question for the
      hydrologist (§ Hydrologist), not built.
- [x] **The licensing gate on river pumps and the EWR** (2026-10-01, report
      format `evidence-10`, engine 1.60.0 for the run warning, issue #54,
      built on #90 Q15 and Q16's recommendations). Two checks that stop an
      evidence pack's issue, read from the runs' stored models: every river
      pump, other water user and off-take either run rests on has a
      capacity, and an application's own new or changed river abstraction
      leaves the EWR or a hands-off flow in the river in every month it
      takes. Model saves and runs stay unrestricted. A dam-less farm under
      river first or trigger now warns that its dam route bypasses the pump
      ([evidence-pack.md § What stops issue on the river](./evidence-pack.md#what-stops-issue-on-the-river)).
- [ ] **The licensing gate's choices to confirm** (`evidence-10`; to put to
      the hydrologist through #90 / #46). Built on these, each confirmable:
      the baseline's existing users are exempt from the EWR check (Q15's
      recommendation read "any project used for a licence application"); a
      hands-off flow must cover every month the works take; any change to
      the applicant's unit puts its river take under the check; the EWR
      kept counts as protection even in a model whose EWR is 0 (the
      Reserve rows then say *Not assessed*, so nothing is hidden). Trigger:
      the hydrologist's answer to Q15 and Q16. **Provisional decision 2026-10-01**
      (issue #90, to be confirmed by the client's hydrologist): Q15 and Q16
      as built, required for licensing evidence and not to save or run a
      model (NWA s18; a b023 import has no capacities).
- [ ] **A dam-less unit under river first or trigger bypasses its pump**
      (engine 1.60.0 warns, model.md §2.7e). Only run of river zeroes the
      dam split and River to dam, so on a unit with no dam the other rules
      irrigate what is routed to the absent dam straight from the river,
      past the pump capacity. The evidence check counts it as unbounded,
      and the run warns, judging "no dam" over the run's days as the check
      does (a dam not in service yet or silted empty inside the run
      included; `damPresence`). Durable fix: send K, M and O through the
      pump under those rules when there is no dam (a change to the model's
      numbers: an engine-audit.md finding, *needs hydrologist*, then
      `pnpm gen:liability`). Trigger: the hydrologist confirming how a
      dam-less river-first unit should take its routed water.
- [ ] **Pump capacities for the run-of-river units.** The importer leaves
      them uncapped (b023 has none) and every run warns; an evidence pack
      can't be issued on such a run until they are entered (`evidence-10`). Enter them in the
      Network tab's Supply section once the capacities are known.
      Trigger: the capacities being supplied.
- [ ] **Effective rain on a typed-over demand beside crops.** b023 takes
      effective rain off a farm's whole gross demand, typed part included;
      the imported object isn't reduced by rain. No effect where the farm has
      no crops. Durable fix, if a workbook
      needs it: an object option to share the unit's effective rain, or the
      hydrologist confirming a domestic demand isn't reduced by rain (the
      physical reading). Trigger: a workbook with a typed-over demand on a
      cropped farm.
- [x] **The browser importer has no run-of-river option** (2026-10-01).
      The in-app workbook import has the Python's `--run-of-river`:
      `extractProject(…, { runOfRiver: true })` (`asRunOfRiver` in
      `spreadsheet/import/farms.ts`, same units, fields and notes), behind
      the review's *River pumping units* checkbox, off by default and shown
      only when the importer flags a unit. Parity: `fixture.test.ts` against
      the committed `synthetic_b023.run-of-river.*` output, and the local
      `sourceWorkbooks.test.ts` on the client workbooks.

## Rain forcing, fitting at import and river off-takes (issue #54)

- [x] **Areal rainfall correction** (2026-09-27, engine 1.13.0). A fixed
      factor per month on the rain GR4J runs on, with its method and source,
      recorded in the fit record's forcing ([model.md §2.4g](./model.md);
      Settings → Flow calibration). Demand and the dams keep the recorded
      rain. No project's numbers change until it is set.
- [x] **Fit at import** (2026-09-27). `pnpm import:project --settings
      <patch.json> --fit`; the seed's `WBT_SETTINGS` / `WBT_FIT=1` per
      workbook ([model.md §2.10b](./model.md)); which workbooks use it is in
      the private seed settings.
- [x] **A logger column that duplicates the gauge column** is left out by both
      importers, with a warning (scripts/wbt-import/README.md).
- [x] **A river off-take into a side branch** (2026-09-27, engine 1.14.0,
      migration 091). A transfer rule with `source: 'river'` takes from the
      flow leaving its source unit today (capacity by month, a hands-off flow,
      the EWR kept when asked, conveyance losses, sized to the destination's
      need or up to capacity), meets the destination's demand first, tops up
      its dam when asked and passes the rest on ([model.md §2.6a](./model.md)).
      The importers turn a workbook transfer into a dam-less, demand-less
      unit from a probable run-of-river unit into one; where the seed turns
      one on, its capacity is set in the private seed settings (plan.md
      question 20).
- [ ] **A seeded off-take's capacity is an assumption**
      (details in the private source repo), pending the client's answer to
      plan.md question 20. Durable fix: the client's numbers in the private
      per-workbook settings, and the sensitivity note in the private repo
      updated. Trigger: the answer to question 20.
- [x] **Canal seepage back to the river** (2026-09-30, engine 1.42.0,
      migration 126). An off-take's `lossReturnPct` (default 0, so every
      stored rule runs as before) returns that share of its conveyance losses
      to the river the same day, below the source or below the farm
      `lossReturnNodeId` downstream of it along the river (model.md §2.6a).
      The balance, the water account (`conveyanceLossM3` net of it), the
      self-checks, the EWR attribution (credited where the losses were
      charged), the run comparison, the scenario ops, the API, the model
      checks and the Transfers tab follow; the run stores
      `offtake_loss_return` on the return unit.
- [x] **Calibrating at a gauge inside the network.** Done 2026-09-30,
      engine 1.41.0: `settings.calibrationSiteNodeId` (null = the outlet,
      the default, so nothing changes for a project that never sets it).
      calibrate() scores the gauge's simulated flow (its outflow) against
      the gauge's own record, `calibrationFlowKind` and the
      independent-record test pick among the gauge's records, and the
      report, the fit record (`siteNodeId`, flagged `siteChanged` when the
      settings move) and automated calibration's plan carry the site; the
      server's rules and the uncertainty ensemble follow it. A gauge's
      record has no gauged range and no gap filling (those settings are the
      outlet records'). The API checks a new site is a gauge above the
      outlet with a record, and a copy or import moves it. Settings →
      Calibration record → *Scored at* picks it. The outlet's observed-flow
      EWR test stays the outlet's, since its requirement is the outlet's
      pragmatic EWR and a gauge's flow can't be judged against it; each gauge
      EWR site with a record gets its own test (below)
      ([model.md §2.10k](./model.md#210k-calibrating-at-a-gauge-inside-the-network-engine--1410)).
  - [x] **The run's calibration statistics at the calibration site.** Done
        2026-09-30 (engine 1.41.0): runModel scores `summary.calibration` at
        the site (`siteNodeId`, `siteName`; `fitStatus` against a fit at the
        same site), stores the gauge's record as that node's
        `observed_flow`, and the Results tab charts it as the calibration
        site's hydrograph. A stored site the run can't use warns and scores
        the outlet; Settings says so under *Scored at*.
  - [x] **EWR agreement at a gauge EWR site with its own record.** Done
        2026-09-30 (engine 1.41.0): `summary.catchment.ewrAgreementSites`,
        each gauge EWR site's record against its simulated outflow and its
        own pragmatic requirement (`ewr_cumulative`), beside the outlet's
        unchanged test, in the Runs tab and the summary CSV
        ([model.md §2.10k](./model.md#210k-calibrating-at-a-gauge-inside-the-network-engine--1410)).
- [ ] **A "from MAP" helper for the areal factor in Settings.** The factor
      is typed; `arealFactorFromMap` (engine) needs the forcing's values,
      which Settings doesn't load. Durable fix: a small panel that fetches
      the rain series the run would use and fills the flat factor and the
      source note from an entered MAP. Trigger: the hydrologist setting a
      correction by hand in the app.

## Notes (WP-2.7)

- [x] **Notes in the project export and copy** (2026-09-26). The export
      (`export.json`) carries the undeleted notes the exporter can read, as
      a record the importer ignores; a copy takes none. Why, per path:
      [data-model.md § Notes](./data-model.md#notes-037_notessql). Tests in
      `notes/notes.db.test.ts`.
- [x] **The notes count cache never evicted** (2026-09-26). The module-level
      map in `notes/counts.svelte.ts` kept one entry per project opened in a
      session, and a project visited again showed its first visit's counts.
      Now only the open project's counts are kept (another project replaces
      them) and sign-out clears them (`clearNoteCounts`, AccountMenu and
      FarmShell). Test: `notes/counts.test.ts`.

## Portfolio dashboard (WP-2.14)

- [x] **Fold the portfolio into the project list as a team filter** (done
      2026-09-30, issue #176). The list's rows already carried the
      portfolio's figures from the same helpers; it gained the Restriction
      (under Lowest dam) and Alerts columns, the 30-day units-short count,
      the Figures age sort (the Data heading) and `?dir=desc`, and the tiles'
      counts in its header line; with a team's chip picked it states that
      team's thresholds and who can change them. `/teams/:id/portfolio`
      redirects to `/?owner=team:<id>&sort=status`, keeping its sort. The
      team thresholds still judge the rows (`GET /projects/outcomes`). Tests:
      `portfolio.spec.ts` (rewritten for the team filter: figures, thresholds
      and a viewer, old links and Back, sorting both ways, a farmer, a team
      that isn't yours, thirty catchments at 1440 and 1280, axe),
      `projects.spec.ts`, `teams.spec.ts`, `grouping.test.ts`,
      `outcomes.test.ts`.

- [x] **The project list's data age counted to the viewer's day, not the
      project's** (WUA-manager persona, #51; done 2026-09-29, issue #137).
      `GET /projects` rows carry the project's `today` (its time zone) and
      `dataFreshness` counts to it, as the portfolio and the outcome columns
      do; the workspace header, the Data tab and the Overview count to the
      project's date too (`projects/freshness.ts` `projectToday`), so no two
      of them differ by a day. Tests: `freshness.test.ts` under skewed `TZ`,
      `projects.db.test.ts` (two zones 25 hours apart).
- [x] **Traffic-light thresholds per team (D11)** (2026-09-26).
      `055_team_settings` adds `team.settings` with a validated
      `portfolio.thresholds` (green and amber cut-offs, 0–100 %, green <
      amber; a CHECK as well as the API's zod schema, `teams/settings.ts`).
      Team admins edit them on the team page (`PATCH /teams/:id` with
      `settings`, `null` = the defaults); every member reads which apply. The
      portfolio passes them to `ewrStatus` and returns them with a `source`
      (`team` / `default`), and the page says whose they are. Each change is a
      `team_thresholds.changed` audit event on every team project. Alerts
      (WP-2.13) and the farm view don't use these thresholds (alerts have
      their own per-rule ones; the farm view shows the outlet's days not met
      without a colour), so nothing else reads them. Tests:
      `teams/settings.test.ts`, `teams/settings.db.test.ts`,
      `portfolio/status.test.ts`, `portfolio/portfolio.db.test.ts`, the
      portfolio and teams e2e specs.
- [ ] **Confirm the default traffic-light thresholds (D11).** The setting
      above makes the numbers adjustable per team; the defaults (5 % / 20 %
      of the last 30 days with the outlet EWR not met,
      `portfolio/status.ts` `EWR_THRESHOLDS`) still need the hydrologist's
      sign-off (plan.md, questions for the hydrologist, 19; issue #46). The page says
      so while a team uses them. Durable fix: the hydrologist confirms or
      replaces them; change `EWR_THRESHOLDS`, the 055 header, and the docs
      that quote them. Trigger: the hydrologist's answer.
- [x] **Bundle ceiling after the team thresholds.** Superseded: the ceiling
      has been re-measured and moved since (the guard's change log), and the
      2026-09-26 weight cut took the total to 931 KB under a 935 ceiling.
      The team page's
      thresholds panel, the portfolio's thresholds sentence and the History
      line add ~1.4 KB gzip: 925.5 KB against the 925 KB ceiling (main
      measured 924.1 KB before them), so `pnpm check:bundle` reports 926.
      The ceiling was left alone for the integrator to decide
      (`scripts/guards/check_web_bundle_budget.mjs`); weight to remove
      instead is the English-as-key catalogue in the i18n bundle item above
      (~5–7 KB). Trigger: the merge.
- [x] **Alerts column.** `alertsFiring` counts the firing `alert_event`
      rows per project in the portfolio query, and the page shows it
      (WP-2.13).
- [x] **"Farms short this week" lands at the top of the Runs tab** (fixed
      2026-09-26). The link is `?tab=runs&run=…&window=last7#res-curtailment`,
      but the Runs tab renders its results after loading, so the browser's
      own jump found nothing. RunsTab now scrolls to a `#res-*` fragment once
      the run's details have rendered (once per visit; later jumps are the
      browser's), holds it there with `holdAnchor` while the panels above
      load, and moves focus to the panel's heading (`tabindex="-1"`, no
      second scroll), so Tab carries on from there. Test: portfolio.spec.ts
      "“farms short this week” opens the Runs tab at the curtailment table"
      (the link, then a reload); it failed before the fix (landed at the
      top) and passed 30/30 at `--repeat-each=30`, 12 workers.
      Since issue #17 the panel is on Hydrological units: the link is
      `?tab=supply&run=…&window=last7#res-curtailment`, that page holds the
      fragment the same way, and the old Runs link is sent there.
- [x] **No perf guard on the portfolio query** (done 2026-09-26). The
      backend's `perf-db` vitest project (the db project's global setup) runs
      `portfolio/portfolio.db.perf.test.ts`: 10 published catchments × 60
      farms, 10-year runs, budget 500 ms, median of 7 (measured 41 ms).
      `pnpm test:backend:perf:db`, alone, not in `pnpm test` or CI
      ([testing.md § Performance budgets](./testing.md#performance-budgets)).

## Firm yield (WP-3.6)

- [x] **Contributor policies.** Done in `096_contributor_yield` (issue #73):
      a contributor queues a `yield` job as themselves on an application they
      own, for their own farm's dam or one its `node.add` ops add, and reads,
      inserts and trims only the results they computed; an assessor's yield
      on the same application stays hidden from them. The API
      (`yieldInputFor`) refuses a hidden dam with an unknown id's words, and
      the handler re-checks as the acting user through the new
      `JobHandler.alsoRole`, so the job dies once they lose the role or the
      dam. Tests: `yield/contributor.db.test.ts` (positive controls and
      fail-closed), `jobs/trust.security.db.test.ts` (the `alsoRole`
      allowlist). The Yield panel on the Applicant view followed in #73
      (`applications.spec.ts`): it offers the applicant only their own units
      and the ones their ops add, only the owner queues, and it follows the
      job on `GET …/jobs`, which now lists a contributor their own yield jobs
      (RLS, 096) where it had refused them, so the panel had never left
      "Queued" nor cancelled one (`yield/contributor.db.test.ts`).
- [x] **In-browser preview.** Done (issue #73): the preview worker
      (`lib/preview/engine.worker.ts`, WP-1.17's, a second entry of the page
      build beside the calibration worker) works out the dam's firm yield
      for the picked pattern and assurance as soon as the Yield panel opens,
      labelled "Preview · Not stored"; the job stays the stored result. Same
      input as the job (the run's own stored input, or a team scenario's
      saved ops on its base run's) and the same search, so the numbers agree
      on the same engine (unit `preview/compute.test.ts`, e2e
      `yield.spec.ts` on a run and a scenario). Viewers preview too. Not
      offered on an application (the job applies the applicant mask, built
      only on the server) and not for the curve (see below). Bundle: total
      +5 KB; the calibration worker's own file 37 → 17 KB, since the run
      code both workers use moved to a shared chunk.
- [x] **The preview across engine releases.** The browser runs the web
      build's engine and the job the backend's, released separately, so
      between a `web@` and a `backend@` release the preview can differ from
      the stored result by the engine change, and the preview didn't say
      which engine it ran. Done: the preview names its engine ("on engine
      X", `ENGINE_VERSION` from the engine's `version` module) beside the
      stored result's, and when the newest stored firm yield came from
      another engine it says so, naming both (`engineDiffersNote`, unit
      `yield/yield.test.ts`, e2e `yield.spec.ts` with the stored result's
      engine rewritten in the response).
- [ ] **No preview on an application** (a deliberate decision, pending
      #90). The Yield panel offers no preview on an applicant's scenario, on
      the Applicant view or the owner's: the job applies its ops under
      `applicationMask` (backend `scenarios/applicant.ts`), and the input
      the preview would need includes the farms the mask hides from the
      applicant (a contributor can't read the base run's input, by RLS), so
      sending it to the browser would leak them. If the client wants
      applicants to preview (their D2 answer, issue #90), the durable fix is
      a server-side preview endpoint that runs the masked search and
      returns only the yield number, never the input. Trigger: the client's
      D2 answer asks for it.
- [x] **A job started elsewhere.** The Yield panel followed only the jobs it
      queued itself, so after a reload or in another tab mid-job it showed
      the last stored result. Fixed: `GET /projects/:id/yield/jobs?nodeId=`
      (api.md § Yield) lists a dam's pending yield jobs with their target,
      read from the job payload under RLS (viewers may already SELECT a job,
      so no migration and no mirrored column; `GET /jobs` stays
      payload-free for the other kinds), and the panel picks one up on open
      and follows it to the end (e2e `yield.spec.ts`).
- [ ] **A resized dam's shape** (pending the hydrologist). **Built in engine
      1.10.0, pending the hydrologist's confirmation:** the storage–yield curve
      and a scenario's `damCapacityM3` op resize a dam along its own
      area–volume relation (A_full × ratio^b; a survey curve cut at the new
      top, or extrapolated beyond it with a power law through its top rows,
      model.md §2.13, scenarios.md § Dam capacity) instead of scaling the
      area with capacity. Drafted from the hydrologist persona's review of
      issue #46 (item 11), not the real hydrologist. Initial and minimum
      levels still keep their fractions. The `node.set` for a survey curve,
      so a scenario can carry the enlarged dam's own surveyed curve (the
      durable answer for the larger side), is built (engine 1.20.0, issue
      #67). Left: the hydrologist's confirmation of the resize (#90).
      Trigger: the hydrologist's review, or a licence application for a dam
      raise.

## Cumulative impact (WP-3.11)

Built (issue #287, migration 145): `combineScenarios` / `cumulativeImpact`
in the engine, `backend/src/assessments/` with the `assessment` job, and
the assessors' **Assess together** view
([scenarios.md § Cumulative impact](./scenarios.md#cumulative-impact-wp-311)).
Left:

- [x] **The evidence report's cumulative row reads a combined run.** C26.
      Built (report format `evidence-11`): page 1's row, now *This and the
      other applications on this baseline, together*, and § 4's combined
      table read a completed assessment of exactly this application and
      every other submitted or approved one on the baseline with their
      current ops (the combined change and the interaction at the outlet);
      without one the backend checks the combination itself
      (`checkCombination`, no model run), so a conflict makes the row *Not
      assessed* with the conflicts named, never a silent merge. Chosen over
      running the combination in the report request, which is up to 8 + 2
      model runs per GET, pack draft and issue check. A pack drafted before
      it keeps its frozen sum ([evidence-pack.md § The other applications
      together](./evidence-pack.md#the-other-applications-together)).
- [x] **The cumulative row's assessment engine** (from #71, C26; operator,
      #93). The row read the newest complete assessment of the same
      applications on any engine and printed which, so its baseline figure
      (the assessment's own run of the baseline) could differ from the
      report's. **Decided (operator, 2026-10-01): require the baseline
      run's engine. Done:** `loadCombined` reads only an assessment made on
      the baseline run's engine; one on another engine makes the row *Not
      assessed* with why (assessed on X, the baseline ran on Y: assess
      again), and while the server runs another engine than the baseline's
      it says to run the baseline again (`staleAssessment`). Tests:
      `evidence/report-combined.db.test.ts`.
- [x] **Who sees the combined row** (from #71, C26; operator, #93).
      Assessments are visible to editors only, so a viewer's report never
      shows the combined figure (viewers don't see submitted applications
      at all), and a team scenario counts as an application once it is
      submitted, as § 4 always did. **Confirmed (operator, 2026-10-01):
      both stay as built** ([evidence-pack.md § The other applications
      together](./evidence-pack.md#the-other-applications-together)).
- [ ] **The reproduction bundle carries the combined row's runs.** An
      `evidence-11` pack's combined row cites an assessment, whose runs (the
      baseline, each alone, all together, on the assessment's engine) the
      bundle doesn't hold, so `reproduce:pack` re-runs the baseline and the
      application but not that row. Durable fix: the bundle adds the
      assessment's members (ops and hashes, as `scenario.json` does for the
      application) and its stored report, and `reproduce:pack` re-runs the
      combination with `combineScenarios` and compares the outlet rows.
      Trigger: the first issued pack whose combined row is assessed, or an
      assessor asking to reproduce it.
- [ ] **Yield and reliability per dam, together.** The report covers the EWR
      sites, the Reserve, the outlet and existing users' supply; a firm
      yield of each dam on the combined input (WP-3.6) is not in it. Durable
      fix: the job runs `yield` for the dams the applications touch on the
      baseline, alone and together, and adds rows. Trigger: an assessor
      asks for yield in a cumulative assessment.
- [ ] **A full-allocation baseline column** (WP-3.10): the baseline run as it
      is today; making it *existing authorised use* means assessing on a
      full-allocation run. Durable fix: the assessment takes an optional
      `backgroundRunId` (a full-allocation run of the same model) as the
      baseline. Trigger: the first assessment on a catchment with WARMS
      volumes imported.

## Applicants (WP-3.3)

The first slice (migrations 044/045, [scenarios.md § Applications](./scenarios.md#applications-wp-33))
built the role, its RLS, applications and their workflow, sharing, the
Applicant view and the Applications tab. Left:

- [x] **The applicant's view of results** (issue #73). An applicant ran
      their application but saw no result: `/compare/runs` refuses a
      contributor (it returns `inputs`), and the scenario run answered with
      metadata only. Done in `118_applicant_results` and
      `GET …/scenarios/:sid/results`: the server reads the run and its base
      past RLS (`app_application_run_results`, for whoever reads the
      application), rebuilds the check that made the run (its `reIds`), and
      projects them (`scenarios/applicantResults.ts`, D2's default): every
      EWR site, the catchment's flows and outlet series at five or more farm
      holders, their own units and those their ops add in full, every other
      unit downstream only as "Farm 3" and a whole percentage, and what ran
      on their units, an item added under a hidden item's id shown by the id
      they gave. A run with a baseline assumption shows the EWR only (the
      share link's rule: such an op on a hidden farm makes the difference
      from the base that farm's figures), and RLS now hands a contributor
      none of that run's series (it had let them read both the catchment's
      and their own units'). The Applicant view shows it as **Your results
      against the baseline**. Tests: `scenarios/applicantResults.test.ts`,
      `scenarios/results.db.test.ts` (the string scan, who may ask, RLS,
      each with its positive control), e2e `applications.spec.ts`
      ([scenarios.md § Applications](./scenarios.md#applications-wp-33)).
      Whether an applicant may see more (the catchment below five holders,
      or results with a baseline assumption) is D2, below.
- [x] **A contributor can `SELECT` their own application runs' rows**, whose
      `inputs` snapshot holds the whole base (every farm's parameters); the
      API never returns them (RLS can't hide a column). Done in
      `046_contributor_runs.sql`: `model_run_select` lost its contributor
      branch, and what the API reads of their runs goes through `SECURITY
      DEFINER` `app_scenario_run_meta` (metadata only) and
      `app_trim_application_runs`. `run_series_select_contributor` no longer
      hands over other farms' series of their runs (only the application's
      own nodes and the catchment allowlist under the k rule). Chosen over
      storing a projection with the run, which would still leave `inputs`
      on a readable row, or drop the assessors' exact input. The results
      slice above builds its projection server-side the same way.
- [ ] **D1, D2, D3 and D14 are provisional positions** (pre-counsel
      research, 2026-10-01; [issue #90](https://github.com/Absence0760/project-water-management/issues/90);
      step-3 § 11; [legal-status.md § Positions taken pending counsel](./legal-status.md#positions-taken-pending-counsel-2026-10-01)),
      built and waiting for the client, the pilot authority and counsel
      (#92): D1 (who decides: the responsible authority, members acting for
      it, the endorsement and the conflict guard, 163_licensing_authority);
      D2 (the applicant sees the farmer scope plus the river: the k rule
      split, the issued copy's frozen units, 164_applicant_visibility and
      165_applicant_copy); D3 (names to editors, owners and the linked
      farmer; volumes outside the organisation as totals, 162; [allocations.md § Who sees what](./allocations.md#who-sees-what));
      and the outcome words (D14: `licence_issued`, `licence_refused`,
      `application_rejected`, `not_considered`, 163), whose labels may follow
      the pilot authority's house style. Trigger: the client's answers.
- [x] **Oracles.** Closed by `049_applicant_oracles` and the engine's
      `mask` (then `maskedNames`). The project owner puts an applicant and their
      consultant in an applying party (`project_member.party`); an applicant
      shares only within it, picked from `…/share-candidates`, so every other
      id or address gets one answer. An application is checked in its
      applicant's namespace (hidden farms under their anonymous names, hidden
      crops under their ids), so a rename to a hidden name applies like a
      free one and the hidden farm is suffixed in that application's runs,
      for the assessors to see. Application names are unique per owner, not
      per project. Tests: `scenarios/oracles.db.test.ts`
      ([scenarios.md § Applications](./scenarios.md#applications-wp-33)).
- [x] **Hidden ids and counts in an application's messages.** An op that
      targeted or reused the id of a hidden crop, transfer, land-cover patch
      or borehole answered differently from a free id (`… not found` against
      applied, `… already in use`), an op on a hidden farm reported what it
      dropped (`dropped 2 crop area(s)`), and a rule could quote hidden data.
      Done in the engine's `mask` (`applyScenario`, built by `applicationMask`):
      hidden items meet the ops under opaque ids (and names) no op holds, so
      a hidden id answers exactly as a free one; afterwards they get their
      ids back, and an item an op added under a hidden id moves to a fresh
      one (`reIds`, for the assessors), so the hidden item still lines up
      with the base by id. `node.remove` counts only what the applicant sees.
      A rule an op breaks because of hidden data (a hidden item, a hidden
      farm's borehole rule, flow shares over 100 % or no catchment area left
      while any farm is hidden) reads only "doesn't apply to the catchment as
      modelled". The applicant projection now shows their own farm's
      boreholes, which it had left out. Tests: `scenario/overrides.test.ts`
      ("mask: ids, counts and value rules"), `scenarios/applicant.test.ts`,
      `scenarios/oracles.db.test.ts` ("ids and counts"), each with its
      positive control ([scenarios.md § Applications](./scenarios.md#applications-wp-33)).
- [ ] **The wording of a value rule refused because of hidden data**
      ([issue #90](https://github.com/Absence0760/project-water-management/issues/90)).
      Built on the recommended default: the applicant is told only "doesn't
      apply to the catchment as modelled" (`MASKED_RULE`), never which rule
      or the hidden values; the assessors, checking the same application,
      read the same words (the check is judged in the applicant's
      namespace). **Pending the client**: whether an applicant may be told
      more (which rule, or "the catchment's flow shares would pass 100 %").
      The refusal itself stays: a model breaking a save rule can't run.
      Trigger: the client's answer on issue #90.
- [x] **Comments / NGO access** (WP-3.15, scenario half, issue #71): done in
      `115_scenario_share_notes`. A submitted or decided application gets
      read-only share links (the Application panel's Share dialog: an
      assessor or its applicant; `POST /share/scenario`, a redacted
      projection with the EWR per site first, results only when the stamps
      verify), and comments (the notes drawer on the Application panel and
      each Applications row) with the `assessors`, `parties` and
      `public_participation` audiences, the read/write matrix in
      [data-model.md § Notes](./data-model.md#notes-037_notessql), and every
      edit of one kept in `note_revision`. An NGO (since 166 with no role, through the link) opens the
      link, signs in from it and comments (`e2e/tests/scenario-share.spec.ts`).
- [x] **Pack targets for share links and notes** (WP-3.15, the pack half):
      done in `128_pack_share_notes` (2026-09-30, issue #71). An editor
      links an **issued** pack from its page (`targetKind: 'pack'`,
      `app_share_link_creatable` / `_visible`); `POST /share/pack`
      (`app_share_pack`, public) answers exactly what verify does plus,
      while the pack stands, a redacted projection of its own frozen report
      (the river's rows and sites, the `k` rule on volumes); a superseded or
      withdrawn pack's link says so, and why, with no figure. `note.pack_id`
      (`team` or `public_participation`, open while a pack link is live, every
      edit kept), `GET|POST …/notes?packId=`, the pack page's Notes, and a
      pack view on `/share` ([evidence-pack.md § Sharing and comments](./evidence-pack.md#sharing-and-comments)).
      Two decisions against the first sketch here: no PDF key through the
      link (the PDF carries every unit's figures and the applicant's
      statement, which the projection withholds), and no applicant-made
      link, since applicants read no pack then (since built in 131:
      "Applicants' access to their own application's packs", § Evidence
      report).
- [x] **Packs from the Applications list** (WP-3.14): built 2026-09-30
      (issue #71). The Applications tab and the Application panel list each
      application's packs and link to the pack view
      ([ui.md § Evidence pack](./ui.md#evidence-pack)).
- [x] **A comment-only role for NGOs** (WP-3.15). Done 2026-10-01
      (166_public_participation; licensing positions item 7, provisional
      position, pre-counsel research): no role at all. Anyone signed in
      comments through a live link to an application or an issued pack (a
      *link participant*, `POST /share/comment`, 10 an hour), reads only what
      the link shows, and is never made a viewer; the e2e
      (`scenario-share.spec.ts`, `pack-share.spec.ts`) comments as a
      non-member ([scenarios.md § Sharing and
      comments](./scenarios.md#sharing-and-comments-wp-315)).
- [x] **The owner's inventory of every public link.** Done 2026-09-30:
      the Project page's Share links list is every link in the project
      (`GET …/share-links?scope=all`, owner only), the baseline's and each
      application's, with what it opens, who made it, its dates and a
      Withdraw behind a confirm ([ui.md § Project](./ui.md#project), [security.md §
      Scenario links](./security.md#scenario-links-wp-315-115_scenario_share_notessql)).
      Pack links join the same list once packs are a share-link target (the
      item under § Evidence report).
- [x] **Afrikaans for the shared application page** (WP-3.15): done. The
      `share.scenario` strings are in the Afrikaans catalogue, and
      `pnpm check:i18n` reports no untranslated site, email or glossary
      string (checked 2026-09-30); the pack view's `share.pack` strings went
      through the same round in its own change. The native speaker's review
      is the Afrikaans item above
      ([#90](https://github.com/Absence0760/project-water-management/issues/90)).
- [ ] **The catchment series k (≥ 5 farm holders) for contributors** is the
      share links' rule, applied conservatively; the hydrologist and the
      client may prefer catchment flows always visible to applicants (they
      are gauge data). Pending the hydrologist and the licensing authority
      (issue #90).
- [x] **Performance of `run_series_select`.** Every viewer read of run series
      now evaluates `app_hidden_scenario_runs()` and the contributor policy's
      two helpers once per query (hashed subplans; the contributor ones exit
      after one index probe for a non-contributor). Measured ~6 ms per query
      on a loaded test database; run `pnpm test:backend:perf` alone on a quiet
      machine to confirm the budgets hold. Trigger: the next perf run.
      **Checked 2026-09-26** after 046 (one more helper in the contributor
      branch) on a quiet machine (load < 3), each suite alone:
      `test:backend:perf:db` portfolio median 114 ms (budget 500);
      `test:backend:perf`'s DB-free budgets unaffected by RLS (its GR4J
      example-run budget fails for an engine reason, tracked under Pipelines).
- [x] **Invite as an applicant with farms.** Done in
      `097_contributor_invite_farms` (issue #73): `POST /farmers` takes
      `role: 'contributor'`, so the Invite farmers dialog's **Joins as**
      *Applicant* adds a verified account, or invites any other address, as a
      contributor with the farms they hold; accepting links them
      (`app_accept_invites`, for the role the invite made them). A resend
      from the members list keeps the farms. Tests:
      `farms/invites.db.test.ts` ("inviting an applicant with farms"), e2e
      `farmer-invites.spec.ts`.
- [ ] **A dominance rule beside k** (filed 2026-10-01 with the k rule's
      split, 164; provisional position, pre-counsel research, 2026-10-01).
      The use's catchment series (outflow, observed flow, EWR shortfall) and
      the volume rows show at 5 or more farm holders, but k alone doesn't
      protect a catchment where one holder does almost all the abstraction:
      natural minus outflow is then mostly that holder's use. Durable fix:
      withhold the use's series and volume rows also when one holder accounts
      for more than ~70 % of modelled consumptive use in the published run
      (one SQL helper beside the holder count, used by `app_share_series`,
      `run_series_select_contributor` and the volume projections, with tests
      at 69 and 71 %). Trigger: counsel's answer on question 5 of the
      licensing positions (k and "reasonably foreseeable method"), or the
      first pilot catchment with one dominant user.

- [ ] **Portfolio e2e stalls under heavy parallel load** (seen once,
      2026-09-26, in 1 of 4 loaded batches of `help.spec.ts` +
      `portfolio.spec.ts` at `--repeat-each=40`, 12 workers, while testing
      the stylesheet wait): in the same repeat the curtailment test's table
      stayed on "Working out last 7 days…" past its 5 s check, and the
      farmer-redirect test stopped at `/farm`. Both wait on API responses,
      and the traces showed no stylesheet wait, so it reads as a backend
      stall under load (compare #41's hashing and model-save causes).
      Durable fix: trace the slow requests in a loaded run (the API's
      per-request timing log, as #41 did) and fix whichever handler stalls;
      never a longer wait. Trigger: it recurs, in CI or a local loaded run.
      Checked 2026-09-28 (issue #75): not recurred; the failing `main` runs
      that day were `runs.spec.ts` (the run-cap list test), not the portfolio
      spec. Tracked in #108.

## Landing page (issue #57, closed)

- [ ] **Performance budgets on the deployed site.** Lighthouse ≥ 95 in all
      four categories, LCP < 2.0 s on throttled 4G, CLS 0 (the issue's
      quality bar). Met locally (2026-09-28, the build served over HTTP/2
      with gzip like CloudFront; [design/landing-art.md § Quality
      bar](./design/landing-art.md#quality-bar)): 100 / 100 / 96 / 100, LCP
      1.6 s, CLS 0 on the mobile preset. The earlier 2.4–2.6 s miss was the
      measuring server's HTTP/1.1 and a background texture standing in as
      the LCP element (now vector, and landing.spec.ts checks the LCP
      element is the hero render). If the deployed site still misses 2.0 s,
      the lever left is the ~0.5 s render delay: less script before the
      landing's first paint (the root layout's app-wide code). Trigger: the
      first deploy (Phase 6), tracked on #92 (moved there when #57 closed).
- [x] **`/welcome` in Afrikaans before hydration** (issue #51, the
      international persona). The page is prerendered once, in English, and
      `app.html` says `<html lang="en">`; an Afrikaans visitor's words and
      `lang` switch together only once the app hydrates and loads the
      catalogue. `lang="en"` is correct for what is on the page before then
      (the words are English), so setting `lang="af"` early from the stored
      choice would claim Afrikaans for English text, and an inline script
      would also need its own hash in the meta CSP (`kit.csp` hash mode,
      `infra/scripts/check-csp.mjs`). Durable fix: prerender the landing
      page once per language (`/welcome` and an Afrikaans `/af/welcome`, or
      the language as a path parameter with `entries`), each with its own
      `lang`, `hreflang` links between them, and the root sending a stored
      or browser choice to the right one. Trigger: the landing page is
      linked from somewhere Afrikaans readers arrive first (a WUA's
      Afrikaans newsletter), or a screen-reader user reports it.
      **Done** (issue #137, 2026-09-30): `/welcome` and `/welcome/af` are
      prerendered from one route, `routes/welcome/[[lang=locale]]`, each in
      its language with its own `<html lang>` (`hooks.server.ts`, no inline
      script), canonical, `hreflang` alternates (`x-default` → `/welcome`)
      and `og:locale`; the switch there is a pair of links, and `/welcome`
      sends a visitor whose choice is Afrikaans on to `/welcome/af`
      (ui.md § Landing page; `landing-language.spec.ts`).
- [x] **A public summary of the engine audit** for the trust strip's first
      point: `/methods` ("How the model is checked"), linked from the trust
      strip and the footer ([ui.md § Methods page](./ui.md#methods-page)).

## Legal pages and POPIA (issues #47, #48)

The tracker is [legal-status.md](./legal-status.md) (what the drafts
assume, the questions for counsel); these are the actions, with triggers.

- [ ] **Counsel review** of `/privacy` and `/terms` and the five questions in
      legal-status.md (the CPA's reach over a free service; the Virginia
      venue clause; roles before the s21 agreement and s55 registration
      exist; email-only contact under s18; the liability wording the
      operator accepted without counsel, #47, disclaimer-review.md § 6). Trigger: before the first
      client's farmers are invited.
- [ ] **Register the information officer** on the Information Regulator's
      eServices portal ([legal/information-officer.md](./legal/information-officer.md);
      the operator files it). Trigger: before production holds client data.
- [ ] **The operator agreement signed** with each client
      ([legal/operator-agreement.md](./legal/operator-agreement.md), a
      template for counsel). Confirm the mailbox provider first: Migadu per
      the estate's DNS, but the operator's own site names Gmail (list Google
      too if mail is forwarded). Trigger: the first client going live.
- [x] **Re-acceptance when the terms change.** Built 2026-09-28 (#47): an
      account on old terms sees the re-acceptance notice before any page and
      accepts through `POST /auth/me/accept-terms`. The material-change email
      to existing account holders (Terms §16) is still sent by hand.
- [ ] **Self-service account deletion** and what happens to evidence an
      account made: #90; the privacy notice discloses the current exception.

## Infrastructure edge

- [ ] **Move the API origin to CloudFront OAC for Lambda if direct traffic
      shows up (issue #126).** Today a direct call to the public Function
      URL is refused by the app's shared-secret check (403), but it has
      already passed the WAF by going around it and holds API concurrency
      while refused. Decision: keep the shared secret. **Trigger:** the
      `origin-secret-rejected` alarm (`infra/alarms.tf`, more than 20
      refusals in an hour, from the `origin_secret_rejected` log line in
      `backend/src/app.ts`) firing outside a secret rotation, or throttles the
      WAF's request metrics don't explain. **Durable fix:** Function URL auth
      type `AWS_IAM` behind an OAC of type `lambda`; the SPA then sends
      `x-amz-content-sha256` on every PUT/POST/PATCH, and the one-click
      unsubscribe POST (RFC 8058, sent by mail clients that can't add that
      header) moves to a signed GET. Reasoning in docs/security.md
      § Infrastructure.
- [ ] **Check the 404s on the live site after the first apply (issue #126).**
      `curl -sI https://<domain>/missing.pdf` should answer `404` with
      `content-type: text/html` (spa_rewrite's page, not S3 XML), and
      `curl -sI https://<domain>/_app/missing.js` `404` (S3 NoSuchKey via the
      frontend bucket's ListBucket grant, not `403` AccessDenied);
      `curl -s 'https://<domain>/?list-type=2'` must return the app's
      `index.html`, never a bucket listing. The map tiles (once uploaded):
      `curl -sI https://<domain>/tiles/south-africa.pmtiles` answers `416`
      from `tiles_range` (no whole-file read), with
      `-H 'Range: bytes=0-16383'` `206`, and `/tiles/x.txt` `404`. Plan-only tests
      (`infra/tests/edge.tftest.hcl`,
      `infra/scripts/cloudfront-functions.test.mjs`) can't see CloudFront's
      real behaviour.
- [ ] **Record which file a reference load came from (round 4 infra audit,
      data finding 4).** A load checks the uploaded file's SHA-256, then
      drops it: the dataset rows don't say which key and hash they came
      from, so once the Actions log expires nobody can tell which file is
      live or which version to restore (the reference bucket is versioned
      for a year, deployment.md § Reference datasets, Undoing a load).
      **Durable fix:** a migration adding a `reference_load (kind, dataset,
      source_key, source_sha256)` table (rivers have no dataset table of
      their own), written in the same transaction as the dataset by
      `geo/referenceLoad.ts` and cleared by any other replace, and shown on
      `/data-sources`. **Trigger:** the
      first production load, or the next migration touching those tables.

## Housekeeping

- [ ] **`devEnv.test.ts` reads the developer's real `.env.development.local`**
      (found 2026-10-01, issue #326 round 3). "loads the committed env file and
      points both URLs at the checkout database" fails on any machine whose
      `backend/.env.development.local` sets `DATABASE_URL` to another database
      (an override to run a preview database), since `loadDevEnv` reads that
      file and it wins. The code is right; the test isn't isolated. Durable fix:
      give `loadDevEnv` the directory to read (or the file list) and point the
      test at a temp directory holding only a copy of the committed file.
      Trigger: the next change to `config/devEnv.ts`, or a second report of
      the failure.

- [ ] **Run the full suites once GitHub Actions is back** (it has been off
      since 2026-09-24, billing). Work since then was verified with targeted
      tests only; the email-first sign-up (2026-09-27) changed the shared
      test helpers every DB and e2e test uses (`backend/src/__tests__/helpers.ts`
      `signUp`, `e2e/support/api.ts` `register`). Trigger: Actions
      re-enabled, or before the first release: run `test:backend:db` and
      the 14 e2e shards (or both suites locally, not beside each other).

- [ ] **Make the deploy role's sops-key grant opt-in upstream** (issue #126
      § IAM). The templates `project-baseline` module's key policy lets the
      GitHub deploy role `kms:Decrypt` the project's sops key, which no
      workflow here uses, and which would let an approved deploy run decrypt
      every production secret. The proposal (a `deploy_role_sops_access`
      variable, off here, default flipped once consumers opt in) is in
      [upstream/templates-baseline-sops-deploy-grant.md](./upstream/templates-baseline-sops-deploy-grant.md).
      The change belongs in the `templates` repo, not here. Trigger: before
      the first `terraform apply`, or the next baseline change, whichever
      comes first; then re-run the baseline stage and check the key policy.

- `SECURITY DEFINER` grants (issue #37, 028_definer_grants): the catalogue
  guard now fails any `SECURITY DEFINER` function executable by a role other
  than the owner and `water_app`. The in-flight `025_share_links.sql` branch
  may add such functions; when it merges, run `pnpm test:backend:db` and make
  sure its functions revoke `PUBLIC` (the owner's default privileges already
  close them if 028 has applied first, but a database migrated in file order
  applies 025 before 028's default-privilege change, so 025 needs its own
  `REVOKE`).

- [x] **Split the help content chunk** (done 2026-09-26). `lib/help/
      content.ts` (every entry, one module) was the largest page chunk at
      42.2 KB gzip, at the 43 KB ceiling. Built differently from the plan
      here (one module per category behind an id → category index): measured
      first, that split costs ~9 KB of total (11 chunks compress worse, plus
      a 2.3 KB index) while a tip still fetches ~7–11 KB. Landed instead: the
      text is split by what reads it. `tips.ts` (term, short text, units,
      field keys; 10.4 KB) is all a HelpTip loads; `articles.ts` (the long
      text, aliases, related, source by id) is joined in by `content.ts` for
      the /help pages (32.3 KB with it); `farmer.ts` (the farm words, whole,
      2.2 KB) is all /farm/words and the translation sheet load. A tooltip
      fetches 10 KB instead of 42, a farmer's words page 2 instead of 42.
      Total 928 → 931 KB on main @ 3ada6d9 (+3: smaller chunks compress
      worse; the guard counts every chunk, so no split lowers it; 934 merged
      over 3af5d05, ceiling 940); largest page chunk 42.2 KB → 41.4 KB (now the Settings
      tab), ceiling 43 → 42. Guards: `content.test.ts` ("the help text
      split"): HelpTip imports only `$lib/help/tips`, the text modules have
      no run-time imports, tips and articles cover the same ids in order.
      Issue #9's last checkbox.

- Since 2026-09-28 every change reaches `main` through a pull request: `main`
  is protected on GitHub (PRs only, admins included) and the git guard hook
  blocks pushes to it (CLAUDE.md, "Working alongside other Claude sessions").
- Demo data: `pnpm dev:db:reset && pnpm seed:demo` rebuilds the dev database.
  It holds three invented catchments, a demo team, two demo users, and client
  catchment if the workbook is present.
- The domain personas (`/persona hydrologist,environmentalist,…`) are ready to
  run against the merged app. See `.claude/personas/README.md`.

## Liability and sign-off (WP-3.13)

Built 2026-09-26: the draft disclaimer, the validation statement with the
known limitations generated from engine-audit.md, and the immutable
professional sign-off on a run, all on the report route
([ui.md § Report](./ui.md#report), [model.md §2.10f](./model.md#210f-validation-statement-and-known-limitations-engine--0312-roadmap-wp-313),
[data-model.md § Sign-offs](./data-model.md#sign-offs-036_signoffsql)).
Left, each with its trigger:

- [x] **`ENGINE_BUILD` from CI** (done, issue #70): `deploy-frontend.yml`
      runs `scripts/release/engine-build.mjs --soak-cases 1600` (the engine
      suite with the soak at 1 600 cases; a failure stops the release), and
      the frontend build injects the record (`__ENGINE_BUILD__`), so a
      released site's validation statement states it
      ([model.md §2.10f](./model.md#210f-validation-statement-and-known-limitations-engine--0312-roadmap-wp-313)).
- [x] **Methodology statement and engine errata** (issue #71, 2026-09-29):
      `docs/methodology/v1.md` (versioned, its SHA-256 pinned by
      `methodology.test.ts`) and `docs/engine-errata.md`, both generated into
      the engine by `pnpm gen:liability`. The validation statement and the
      sign-off statement (`signoff-4`) cite the methodology by version and
      hash and list the errata of the run's engine version. The pack records
      the same (WP-3.14).
- [x] **Pack sign-off** (issue #71, 2026-09-29, 112_evidence_pack):
      `signoff.pack_id` beside a now-nullable `run_id`, exactly one set; the
      pack statement `pack-signoff-1` (the run statement's confirmations plus
      one binding the pack's manifest hash), on a draft pack only
      ([evidence-pack.md](./evidence-pack.md)). A scenario is still signed
      through its run, and the works statement words itself for a scenario.
- [x] **Validation statement panel on the run and the scenario** (WP-3.13
      UI; done 2026-09-27, issue #17): the report's `ValidationStatement`,
      folded shut, in the run's Record group (`#res-validation`) and under
      the scenario's comparison (`liability/ValidationPanel.svelte`, its
      body a lazy chunk; ui.md § Runs & results, § Scenarios).
- [x] **Two-step sign-in on sign-off** (issue #282 built TOTP two-step
      sign-in and requires it of owners, team admins and assessors:
      security.md § Two-step sign-in). Signing a run or a pack didn't
      require it, since a signer is any editor, so a sign-off was only as
      strong as the signer's password. **Decided (operator, 2026-10-01):
      require it of every signer**, since a sign-off is the professional
      record an authority relies on. **Done:** `requireStepUp` after the
      role check in `POST …/runs/:runId/signoffs` and
      `POST …/packs/:packId/signoffs` (`403 mfa_required` / `mfa_step_up`,
      which the workspace's two-step banner picks up), and both reads'
      `cannotSign` say so first (`stepUpRefusal`), so nobody fills in the
      dialog to be refused. Tests: `auth/stepUp.db.test.ts`.
- [x] **Sign-offs in the POPIA data export** (WP-1.13; export done
      2026-09-26, `signoffs` in `GET /auth/me/export`): a sign-off holds the
      signer's typed name and registration; the export and account deletion
      must list them (deletion keeps the row with `user_id` nulled, as the
      professional record, and the privacy notice must say so).
- [x] **Flagged years are capped** (done, engine 1.31.1, issue #70): the
      low-vs-CHIRPS check's examples list every flagged year, so the
      statement does too.

## Evidence report (issue #71)

Built 2026-09-29: WP-2.15 Phase C, the evidence mode of the report route
([ui.md § Evidence report](./ui.md#evidence-report),
[design/evidence-report.md §12](./design/evidence-report.md#12-changes-to-the-roadmap-the-wp-215-build-plan)).
Left, from the design and the persona review (§11), each with its trigger.
"Before the pilot" means before a report goes to the pilot CMA.

- [x] **§ 3 said the WR2012 five-statistic table was "not computed".** It is
      built (CR-28, engine 1.19.0, `summary.calibration.wr2012Fit`) and the
      calibration record shows it. Fixed in the same change: the line now
      prints *Not assessed* only when `wr2012Fit` is null.
- [ ] **Applied-for works against the modelled ones** (licensing
      authority). Nothing ties the scenario's ops to what the WULA applies
      for. Durable fix: a WULA reference field on the scenario (application
      number, the works as applied for), printed on page 1 and Appendix A.2,
      and a check that each proposal op names the works it models. Trigger:
      before the pilot.
- [ ] **Labelled mitigation alternatives** (licence applicant). The report
      shows one application; applicants must show the mitigation they
      weighed. Durable fix: an application may cite other scenario runs on
      the same baseline as labelled alternatives ("smaller dam", "winter
      abstraction only"), each a page-1 column with its paired change.
      Trigger: before the pilot, or the first applicant asks.
- [x] **EWR rows below each storage or abstraction op** (environmentalist).
      Built (engine 1.33.0, report `evidence-4`): for each proposal op that
      builds or raises storage or abstraction at a node, a page-1 row at the
      first EWR site downstream that isn't the outlet (days its daily EWR is
      not met, the paired band, the Reserve's months met when it has a
      table); works with no site between them and the outlet share one *Not
      assessed* row and an assessor's question
      ([design/evidence-report.md §4.2](./design/evidence-report.md#42-sections)).
- [x] **A no-flow-days row** (environmentalist; the benchmark report's key
      impact is zero-flow time). Built (engine 1.33.0): days the outlet's
      simulated outflow is below 1 L/s (`summary.catchment.noFlow`,
      [model.md §2.9e](./model.md#29e-no-flow-days-and-users-served-in-full-while-an-ewr-site-fails-engine--1320-issue-71)),
      both runs, the longest spell, and the paired band with "worse in"
      (`MemberMetrics.noFlowDays`).
- [x] **A flag for flows below the rule table's lowest point** (G16). A
      natural flow drier than the table's driest point gets a requirement
      scaled down with the flow (model.md §2.9c), below the table's driest
      requirement, which makes those months easier to meet. Durable fix:
      count those months per site and flag them on page 1. **Done:** the
      evidence report counts each site's months with `beyond: 'drier'`
      (baseline and application, `belowTableA/B`), prints them in § 1's site
      strip and flags them as a caution on page 1 with their effect (the
      requirement shrinks with the flow), with the share expected by
      construction when the percentile is from the run. The scaling rule
      itself stays pending the hydrologist (model.md §2.9c).
- [x] **Days a user is served in full while the site fails** (environmentalist).
      Built (engine 1.33.0): per EWR site, not only the outlet, the days each
      unit upstream got its whole demand while the site's EWR failed
      (`summary.servedWhileEwrFails`), in a § 4 table and a "read these
      first" count naming them.
- [x] **The Reserve method's open choices are not in the known-limitations
      list.** Done 2026-09-29: engine-audit rows A1–A7 (below the driest
      point, interpolation, the percentile's source and the ±15 % MAR
      tolerance, the charge source, low flows on base flow, finding a
      high-flow event, capping and counting events), each pending the
      hydrologist, regenerated with `pnpm gen:liability`; plan.md question 17
      and engine-audit's open question 12 carry them. Was: model.md §2.9c lists them as pending the hydrologist (the
      requirement below the driest point scaled or held, linear or log
      interpolation, the percentile from the run or the table, the charge
      source), and the evidence report's G16 flag says so, but
      `docs/engine-audit.md` has no row for them, so the generated Known
      limitations (printed on every validation statement) omit them. Durable
      fix: a **Needs hydrologist** row in engine-audit.md for §2.9c's open
      choices, then `pnpm gen:liability`. Trigger: the next change to the
      engine-audit tables, or before the pilot, whichever is first.
- [x] **The driest month's FDC beside the largest-change month.** Built
      (evidence-3): `EvidenceSite.fdcDriestMonth`, the calendar month with
      the lowest mean natural flow over its complete months in the baseline
      (a property of the river, so neither the requirement nor the
      application moves it); § 1 plots its FDC beside `fdcMonth`'s, one plot
      captioned as both when they coincide (`grid.ts` `fdcMonths`).
- [x] **A cumulative row over other applications on the baseline**
      (licensing authority, s27 "other water users"). Built (evidence-3) as
      a sum, not a combined run: every other application submitted or
      decided with approval, with its newest run of its current ops on the
      baseline (read under the reader's RLS, so a viewer's report lists no
      submitted application and nobody's a draft), each one's own change in
      days below the pragmatic EWR and Reserve months met at the outlet, and
      their sum over those on the baseline's engine, period and runoff model:
      § 4's table and page 1's *Other applications on this baseline, summed*,
      whose basis says it is a sum of separate runs. The durable fix, a
      combined run of every application's ops, is WP-3.11
      (`combineScenarios`, with its conflict rules); the row then reads that
      run instead. Trigger: WP-3.11, which has now landed (engine, backend
      and the Assess together view, issue #287): the switch is the open item
      under [§ Cumulative impact](#cumulative-impact-wp-311).
- [x] **Cancelled ensembles' interim results.** Finding: there are none to
      print. The browser runs an ensemble and stores it only when every set
      has run; a `started` row of `run_uncertainty` holds no summary or result
      (014's check requires both null until complete), so nothing interim
      exists. The ledger now says so for each start not completed (*started,
      not completed: no result stored*, with the note that the app keeps who,
      when and its rule), rather than implying a result was hidden. Storing
      partial results would mean the browser writing them mid-run, which the
      report doesn't need: the cited ensemble is the first *complete* one on
      the declared rule (G4), so an abandoned start can't be cited either way.
- [x] **Appendix C's fixed prompts.** Built (report version `evidence-8`):
      three fixed prompts, purpose and need, mitigation and monitoring
      (engine `evidence/prompts.ts`), answered on the scenario where it is
      edited (**Applicant's statement**, `ScenarioStatement.svelte`) and
      stored on it (`129_scenario_statement`, following the scenario's RLS:
      an editor on a team scenario, only the applicant on an application;
      a decision can't change them). Appendix C prints each with its question,
      the answer verbatim or *Not given*, before the description and run
      notes; a pack freezes them in its manifest, and one drafted before
      `evidence-8` says they aren't part of it
      ([design/evidence-report.md § 4.2](./design/evidence-report.md)).
- [ ] **Appendix C's answers on the shared application page.** The scenario
      share link (`app_share_scenario`, 115) shows the description to the
      public but not the three fixed prompts' answers (purpose and need,
      mitigation, monitoring). Showing them helps the public comment on an
      application; it also publishes the applicant's own words beyond the
      assessor. **Recommendation:** show them, since the description is
      already public and the answers are the applicant's case. Durable fix:
      redefine `app_share_scenario` from its latest body to add the three
      fields, a `share.scenario` i18n round for their headings, and a
      pack-share-style DB test. **Who:** operator, asked on
      [#93](https://github.com/Absence0760/project-water-management/issues/93).
      **Trigger:** the answer, or the first application shared for public
      comment.
- [x] **A diagonal draft stamp.** Built: a print-only diagonal *Draft · not
      issued* watermark (`position: fixed` in `@media print`, repeated on
      every printed page by Chromium), `aria-hidden` beside the section heads'
      text stamps, until a pack issues the report.
- [x] **Paired bands on each unit's supply (ER4 rest).** Built (engine
      1.33.0): each unit's mean demand and supply in `MemberMetrics`; the
      paired summary bands each unit's share supplied and, with the
      application's own units, their group's, each with its worse-share. The
      applicant's own supply, the other users' rows and § 4's Change column
      carry them; an ensemble stored before 1.33.0 prints *no band* with the
      reason.
- [x] **REC per rule table (ER9).** The site strip prints REC *Not given*.
      Durable fix: `category` and `reference` on `EwrRuleTable` (a settings
      field, a baseline assumption in the diff). **Done:** an optional
      `category` (A–F or a band like B/C) on the rule table: Settings, the
      settings API, `ewrRule.set`, the run-comparison diff and the § 1 site
      strip (*Not given* and the assessor question only when absent). A
      label: no result changes, no `ENGINE_VERSION` bump. No separate
      `reference`: the table's required `source` is the gazette notice.
      The values themselves still wait on ER-D2.
- [x] **Banded FDC (ER5).** Built (engine 1.33.0): each member carries the
      Reserve's FDC check curve per site and month at the table's points
      (`MemberMetrics.reserveFdc`); § 1's chart shades the baseline's 5–95 %
      band (R1) and hatches the application's own curve's (R2), or says why
      there is none.
- [x] **The paired change of the FDC check curve** (engine review of ER5).
      § 1's chart bands each run's own curve (R1 shaded, R2 hatched); the two
      come from the same parameter sets, so they overlap even when every
      pair shifts the curve the same way, and the caption said so. Built
      (report format `evidence-7`): `summarisePaired` bands the per-pair
      difference of the impacted curve at each table point with the share of
      pairs in which the application's flow is lower
      (`PairedSummary.reserveFdcChange`); the evidence document carries it
      per month and point with the runs' own difference and "worse in k of
      n" (`EvidenceSite.fdcChange`), and § 1 prints it as a table under each
      FDC plot (screen and the server-rendered PDF alike), the caption no
      longer apologising for the overlap. A pack issued before `evidence-7`
      keeps its frozen document, with no table and the old caption. No
      `ENGINE_VERSION` bump: no run's output changes.
- [ ] **The WR2012 five-statistic table's bands (ER6/CR-28)** stay labelled
      indicative until checked in WRC TT 689/690: tracked in
      [§ Calibration research](#calibration-research-2026-09-24) (issue
      #90).
- [x] **Licence impact by year class on page 1 (issue #53 R7).** Built: page
      1 prints the impact report's `LicenceImpactBoard` after the change
      table, the application named as such, from the three daily series the
      page fetches before ready (`loadImpactSeries`), with the full-allocation
      note as the impact report has it. Since 2026-09-30 (report format
      `evidence-5`) the engine builds the board into the document
      (`evidence/impact.ts`) from the series the backend loads, so the draft
      and an issued pack print the same board; the page no longer fetches
      series for it.
- [ ] **The server-rendered evidence PDF.** An *issued pack* is printed on
      the server now (119_pack_render, [evidence-pack.md § The PDF](./evidence-pack.md#the-pdf)),
      from its frozen manifest; the *draft* evidence report on the report
      route still prints from the browser only. Page 1's licence impact
      board is in the manifest since `evidence-5` (2026-09-30), so a pack's
      page and PDF print it. Left: a server render of the draft report
      (`POST …/reports { runId, evidence: true }`, a render scope over the
      baseline, ER1), only worth it if someone asks for a draft PDF by
      email. Trigger: that request.
- [x] **`ENGINE_BUILD` from CI**, which the evidence report's B.1 needs:
      done (issue #70), [§ Liability and sign-off](#liability-and-sign-off-wp-313).

**Evidence packs** (WP-3.14; built 2026-09-29: the table, the manifest and
its hash, the pack sign-off, draft, issue, supersede, withdraw and the public
verify lookup; 2026-09-30: the server-rendered PDF and the reproduction
bundle, [evidence-pack.md](./evidence-pack.md)). Left:

- [x] **The pack view and the verify page.** Built 2026-09-30
      ([ui.md § Evidence pack](./ui.md#evidence-pack),
      [§ Verify page](./ui.md#verify-page)): `routes/projects/[id]/packs/[packId]`
      renders the evidence report from the frozen manifest with the stamp and
      verify line in every section and the footer; `/verify/[[code]]` with the
      in-browser manifest (and, once recorded, PDF) check; Create, Sign,
      Issue, New version, Withdraw and Delete draft; the pack lists on the
      evidence report and the Applications tab and panel; the sign-off dialog
      says the signer's name and registration are public. Axe on both
      (`e2e/tests/evidence-pack.spec.ts`).
- [x] **The server-rendered pack PDF and its hash.** Built 2026-09-30
      (119_pack_render, [evidence-pack.md § The PDF](./evidence-pack.md#the-pdf)):
      issuing queues a `pack_render` job that prints the pack's own page with
      WP-2.15 Phase B's renderer (a render scope over the pack alone: the
      manifest holds the report, so no run is read), stores it in its own
      bucket under its SHA-256 (versioned, Object Lock GOVERNANCE for 10
      years, no lifecycle: operator decision, 2026-09-30,
      [deployment.md § Evidence packs](./deployment.md#evidence-packs)), and
      records the hash once through `app_record_pack_pdf`; verify returns
      it. Recorded *after* issue, not before: only an issued pack's page
      prints its issued stamp, so for the seconds of the render verify
      answers `pdfSha256: null` (the pack view shows the PDF as rendering).
- [ ] **The deployed pack render, end to end** (#92's check, for packs):
      the renderer's put into the Object Lock bucket (its checksum header,
      the default retention applied) is checked only by plan tests and
      MinIO locally. Durable fix: after the first deploy, issue a pack on
      the staging project and confirm the object's retention
      (`aws s3api get-object-retention`) and that the download's SHA-256
      equals verify's. Trigger: the first production deploy.
- [x] **The reproduction bundle and `pnpm reproduce:pack`** (built
      2026-09-30, 122_pack_bundle, [evidence-pack.md § Reproduction](./evidence-pack.md#reproduction)):
      issue builds a deterministic ZIP (`manifest.json`, each run's stored
      inputs and results digest, the input series as CSV, the scenario, a
      README), checks it, stores it under `packs/` and records its hash
      through `app_record_pack_bundle`, which only the issuing transaction
      may call; verify returns `bundleSha256`; `GET …/packs/:packId/bundle`
      downloads it; `pnpm reproduce:pack` re-runs both runs offline and
      compares their results digests. The bundle carries each run's own
      stored inputs rather than the project's `export.json`: those are what
      the runs used, where the export is the project as it is now.
- [x] **Re-run both runs on the server after issue.** Issue checks the
      bundle's files, hashes and manifest but didn't re-run the runs (it
      takes as long as the runs, too long for a request). Built
      (154_pack_reproduce, 2026-10-01): the issue's transaction queues a
      `pack_reproduce` job that reads the stored bundle back, checks it is
      the recorded bytes, runs `checkPackBundle` with the re-run and the
      pack's manifest hash, and records the outcome (`reproduced`,
      `not_reproduced`, `other_engine`, `no_bundle`), the engine and every
      check in `pack_reproduction`, through `app_record_pack_reproduction`
      from that job only. The pack page's bar shows it; verify doesn't
      ([evidence-pack.md § Reproduction](./evidence-pack.md#reproduction)).
- [x] **Re-run a pack again on the server.** The `pack_reproduce` job runs
      once, at issue (3 attempts). When it gives up (the packs bucket
      unreachable for all three) the pack page says the re-run couldn't be
      done, and nothing asks again; and after an engine upgrade nothing
      re-runs older packs on the new engine (one outcome per pack and
      engine is recorded, so the table already holds a second). Durable
      fix: an editor's `POST …/packs/:packId/reproduce`, as
      `POST …/packs/:packId/pdf` asks again for a PDF (queue
      `queuePackReproduce` while no outcome is recorded for the server's
      engine; route inventory, role ladder, mass-assignment and write-route
      entries), with a "Try again" on the pack page. Trigger: the first
      `pack_reproduce` job that goes dead in production, or an engine
      version bump after the first pack is issued. **Decided (operator,
      2026-10-01): build it now. Done:** `POST …/packs/:packId/reproduce`
      (`requestPackReproduce`: idempotent while one is pending, `409` once
      the server's engine has an outcome), `canRerun` and `serverEngine` on
      the pack's `reproduction`, and the bar's **Try again** / **Re-run on
      engine X** (evidence-pack.md § Reproduction, "Re-run again"). Tests:
      `evidence/packs.db.test.ts`, the four route lists,
      `packs/pack.test.ts`, `e2e/tests/evidence-pack-pdf.spec.ts`.
- [ ] **Move the bundle's build to a job if issue nears the timeout.** The
      bundle is built in the issue's transaction today, estimated 5–10 s at
      300 outputs × 30 years a run
      ([evidence-pack.md § Reproduction](./evidence-pack.md#reproduction)).
      If a catchment's issue ever nears the API's 30 s, the build moves to
      a job (the `pack_reproduce` job's place, before its check). Trigger:
      an issue slower than 15 s in the API's logs.
- [x] **Errata found after issue on verify.** Verify lists the errata the
      manifest recorded when the pack was drafted; one found later, for the
      same engine version, isn't shown. Built: `app_verify_pack` (132) also
      returns each run's engine and its fit's, which the API turns into
      `errataFoundSince` (`errataFor` over the current list, less the
      recorded ids) and never returns itself; the verify page lists them
      under "Errata found since issue", and the pack's page in its unprinted
      bar (on a draft, "found since this draft was made"). Issue refuses a
      draft with any (`409` `pack_errata_since_draft`, the checklist's
      `errataRecorded`): draft it again, which records them. The manifest, its
      hash and `errata` are unchanged
      ([evidence-pack.md § Verification](./evidence-pack.md#verification)).
- [x] **Applicants' access to their own application's packs** (WP-3.15):
      done in `131_applicant_packs` (2026-09-30, issue #71). Issuing stays
      with the editors. An application's parties (its owner and whoever they
      shared it with) read its issued, superseded and withdrawn-after-issue
      packs, never a draft, through `SECURITY DEFINER` functions rather than
      a row policy (the manifest names every unit, and RLS can't hide a
      column): verify's fields, a pack link's figures and D2's units (their
      own by name, the others downstream of the application under the names
      the results view gives them, with their change in whole points; none
      when a baseline assumption changed). `GET
      …/scenarios/:sid/packs[/:packId]`, the Application panel's list and
      the applicant's pack view ([evidence-pack.md § Applicants](./evidence-pack.md#applicants)).
      `app_share_link_creatable` / `_visible` let the application's owner
      link their own issued pack and list and revoke the links they made.
- [ ] **Send a pack to the authority's own address, not only its members.**
      `POST …/packs/:packId/send` (licensing build item 13, 2026-10-01)
      emails only members marked as acting for the responsible authority,
      with a link to the pack's page that needs them signed in.
      `settings.responsibleAuthority` (163) holds no address, and a link that
      opened the PDF and bundle without signing in would be a new way out of
      the app for every unit's figures. Durable fix: an
      `authority.email` in the settings, set by the owner, and a single-use,
      time-limited delivery token (stored as its hash, like a render token)
      that downloads exactly that pack's PDF and bundle once, recorded in
      the history; the operator agreement then names the authority as a
      recipient. Trigger: an authority whose assessors won't hold accounts,
      or counsel's answer on the D1 hosting question.
- [x] **An anonymised printable copy of the pack for its applicant.**
      Built 2026-10-01 (165_applicant_copy; licensing build item 12,
      provisional position, pre-counsel research, 2026-10-01): a party of
      the application asks for it on their pack view (`POST
      …/scenarios/:sid/packs/:packId/pdf`), an `applicant_pack_render` job
      prints that view as them in the server renderer (a render session that
      reads that one page, render-token purpose `applicant_pack`), stores it
      beside the pack's PDF under `applicant/` and records its own SHA-256
      once (`evidence_pack_applicant_copy`); `GET …/pdf` downloads it. The
      printed page says it is a derived copy, not the pack, with the pack's
      code, manifest hash and verify address
      ([evidence-pack.md § Applicants](./evidence-pack.md#applicants)).
- [x] **"Pack issued" notices** (Mailpit locally, SES in production) to the
      project's editors and the scenario's owner: built 2026-09-30
      (133_pack_notices, `backend/src/evidence/notices.ts`). Issuing a pack,
      or withdrawing one that was issued (with its reason), emails the
      project's editors and owners and the application's owner, never the
      actor; a supersede is told in the new version's email, and a draft
      withdrawn is told to no one. Queued in the route's transaction, sent
      by the tick as each recipient under RLS, with the role and address
      checked again at send; the email carries the version, the short code,
      the verify link and the recipient's own view of the pack (the
      applicant's is their copy, 131_applicant_packs), never a figure
      ([evidence-pack.md § Notices](./evidence-pack.md#notices)). The
      Afrikaans words went through the i18n translator and checker (the
      native speaker's review is pending with the rest, § Afrikaans).
- [x] **"Pack issued" emails: no opt-out, and a rare duplicate** (from #71;
      operator, #93). They have no opt-out, like report-ready emails, and
      if SES accepts an email but the call times out the retry can send a
      second copy, as the alert emails can. **Accepted (operator,
      2026-10-01)**: they are service messages to the people accountable
      for the pack ([evidence-pack.md § Notices](./evidence-pack.md#notices)).

## Alerts (WP-2.13)

- [x] **SES suppression turns a person's alerts off, with a banner.**
      Built (057_alert_followups, `mail/suppression.ts`, `infra/ses.tf`):
      the configuration set publishes bounces and complaints to SNS
      `ses-events` → SQS `mail-events` → the worker, which flags the
      address (`app_user.mail_suppressed_at`) and pauses the person's alert
      emails; the account and alert pages show a banner with **Turn alert
      emails back on** (`POST /me/alerts/resume`, which also takes the
      address off SES's suppression list, once a day). Paused rather than
      set to `off`, so the person's choices come back as they were. A
      dedicated queue, not the jobs queue: the worker trusts each queue for
      its own kind of message only. Locally: `pnpm dev:mail:bounce <email>`.
      The Terraform is plan-tested, not applied (Phase 6).
- [x] **End-to-end through Mailpit.** Built in English:
      `e2e/tests/alerts-mailpit.spec.ts`. A synthetic 14-day dry forecast,
      run and published, takes a farm's dam below the WUA's level (set
      between the dam today and the forecast's lowest, so the forecast is
      what crosses); one worker tick (`runJobsTick`) mails the farmer
      through Mailpit; the spec reads the email through Mailpit's API (the
      farm and the forecast named, no other farm, the RFC 8058 headers at
      the API with the link's token), opens its *Stop these emails* link
      signed out, and checks the next crossing mails the WUA but not the
      farmer. It needs `pnpm dev:mail:up` and skips without it locally,
      never in CI (`server-report.spec.ts`'s rule). It runs once per language,
      English and Afrikaans (next item).
- [x] **Alert wording in Afrikaans.** Every `mail.alert.*` key and the
      alert and unsubscribe pages are in Afrikaans (§ Afrikaans), and
      `LANGUAGES` in `e2e/tests/alerts-mailpit.spec.ts` has its `af` entry:
      the Mailpit e2e checks the Afrikaans mail and the unsubscribe page on a
      phone set to Afrikaans.
- [x] **Staleness for series an API key sends, and units short on an
      automatic publication (issue #120).** Built (141): a `data_stale` rule
      per series an API key writes (`alert_rule.series_id`, 2 days by
      default, from the series' last non-blank day; listed under **API data
      behind**, marked "(no API key sends it now)" once a person writes over
      the key's days; a hand-uploaded series gets none), and the
      `farms_short` kind, staff only, on publications an auto run made
      (`run_publication.auto`). The one Afrikaans line not yet re-translated
      after the rename, `mail.alert.stale.seriesWhat` ("API data behind"),
      is on the translation sheet and goes out in English until it is.
- [x] **Per-feed staleness levels.** Built (057 `alert_rule.feed_id`):
      one `data_stale` rule per feed, each at its own level past that
      feed's usual delay, with a default per source (CHIRPS 3 days,
      CHIRPS-GEFS 2, DWS 30: `SOURCES[source].staleAlertDays`); the rule
      editor lists them under **Data feeds behind**, and a feed added once
      they are on gets its rule at its source's default. 051's
      catchment-wide rules became one per feed at the same level, in place
      (history kept); a catchment with no feed keeps its choice until its
      first feed adopts it.
- [x] **Farmer feedback** (the roadmap's recommendation before
      WhatsApp/SMS; issue #74): built (151). Every alert email and digest
      asks "Was this alert useful?" with two plain links, Yes and No, to a
      public page (`/alerts/feedback`) that preselects the answer, takes an
      optional comment and stores nothing until **Send**; a single-purpose
      token (its own HMAC label beside the unsubscribe token's) answers only
      its own email, for 30 days. Editors see the answers counted per kind
      and the comments, without names, under the rule editor. Kept: an
      answer 1 year, an unanswered link 30 days; in the data export,
      deleted with the account; Privacy §3, §4, §5 and §7 (LEGAL_VERSION
      2026-10-01). ~~SES open and click tracking~~: **dropped**
      (fact-check 2026-09-30). Privacy §3 says "We do not use analytics,
      advertising or tracking tools", and an open pixel is exactly that;
      open rates are unreliable too, since some mail apps fetch images on
      their own. No alert email carries an image, a pixel or a tracked link.
- [ ] **A farmer's own dam alert level** (issue #51, the farmer persona:
      "40 %, chosen by me, before my planting decision"). The page now
      shows the WUA's level for each farm (`AlertChoice.threshold`), but only
      the WUA sets it (`alert_rule`, one per farm, editors). Letting a farmer
      pick their own warning level (a per-subscription threshold on
      `alert_subscription`, beside the WUA's) is a
      decision for the WUA, not a build: an alert at a farmer's level is
      still the model's estimate, and a level above the WUA's could read as
      an earlier restriction. Trigger: the client decides whether farmers
      may set their own level (plan.md §9 questions).
- [ ] **WhatsApp / SMS** (optional, after Step 2; issue #74). Likely the
      right channel for South African farmers, but more than a transport
      beside `mail/transport.ts` (fact-check 2026-09-30). Before it can be
      built:
      - `alert_subscription.channel` is limited to `'email'` by a check
        constraint (`051_alerts.sql`): a migration widens it, and the
        preferences, the fan-out and the worker learn a channel per person
        (with a phone number, a new piece of personal information: the
        privacy notice, the export and deletion).
      - **Meta as a new sub-processor** (WhatsApp Business Platform): the
        operator agreement and Privacy §5 name it.
      - **A POPIA s72 cross-border transfer**: Meta processes outside South
        Africa, so Privacy §6 needs its own s72 basis and safeguards.
      - **Templates approved in advance**: WhatsApp's business-initiated
        messages are pre-approved templates, so every alert's wording (both
        languages, the liability lines included) is submitted and approved
        before it can be sent, and changing it means approval again.
      - **Cost**: utility templates are about R0.12 a message from
        1 October 2026, per message, so the daily cap and the digest matter
        for the bill too; an SMS fallback costs more.
      Trigger: farmers ask for it after a season of email alerts in
      production (#92); the "Was this useful?" answers are the evidence.
## POPIA and the Step 2 release (WP-2.16)

The questions for the client's information officer are in [issue #90](https://github.com/Absence0760/project-water-management/issues/90)
(§ For the client's information officer), with what each answer changes in
the code in a comment there; the operator's actions (registering the
information officer, the signed operator agreement) are the go-live gates in
[issue #103](https://github.com/Absence0760/project-water-management/issues/103).
Issue #48 closed 2026-09-28 with its engineering done.

The Step 2 release-hardening pass (2026-09-26,
[step-2 § WP-2.16](./roadmap/step-2-shared-catchment.md#wp-216-release-hardening-for-step-2))
documented what is true today in
[security.md § Personal information](./security.md#personal-information-popia)
and fixed what it could in code (048_account_deletion). These need the
client, its information officer or legal, and none is a code change on its
own. Loop in the CISO or security analyst before acting on any of them.

- [x] **Privacy notice for farmers and members.** What is collected (the
      security.md table), why, who sees a farm's figures (D1, FV-D5), the
      retention periods, the rights and how to exercise them, and the
      responsible party's contact. Needs the client's information officer
      and the Afrikaans translation (WP-2.5). Then a link on sign-up, the
      invite email and the farm view. Trigger: **blocking** before the first
      farmer is invited on production. **Done 2026-09-27:** `/privacy` and
      `/terms`, linked from sign-up, the invite emails, the sign-in pages
      and the farm menu, with the consent record (087) and re-acceptance
      (2026-09-28); counsel review is gate D in legal-status.md (#103).
- [x] **Confirm the lawful basis** for each row marked *(confirm)* in
      security.md. **Provisional positions taken (pre-counsel research,
      2026-10-01):** accounts on contract, s11(1)(b); memberships, farm
      links, notes, the audit log and alerts on the client's legitimate
      interest, s11(1)(f), with the s11(3) objection built in (leave the
      project; the alert unsubscribe); records kept under s14(1)(b); "and
      duty to keep" dropped from Privacy §4. Alerts are service messages,
      not direct marketing (s1, s69): `mail/alerts.content.test.ts` holds
      their links to an allowlist, and SES open and click tracking stays
      off. Privacy §4 and §10, security.md § Personal information,
      `LEGAL_VERSION` 2026-10-02. The client's information officer may still
      override them by written instruction (operator agreement cl. 3).
- [x] **The client's privacy contact on the farm page and in invitations**
      (POPIA s18(1)(b) for project data). Done (168_team_privacy_contact;
      provisional position, pre-counsel research, 2026-10-01): a team's
      admins set a privacy contact (name or office, email, optional postal
      address) in Team settings; farmers read it from the farm menu's "Who
      decides about your farm's information" (`GET
      /projects/:id/privacy-contact`), and invitation emails to the team or
      its projects name it. Privacy §2 points there. A project without a
      team, or a team that hasn't set one, still relies on operator agreement
      3A.1(b) (the client's own notice); the page then says to ask the
      inviter or the WUA.
- [ ] **Operator agreement** (POPIA s20–21, gate B in #103) between the client as
      responsible party and the operator: security measures, sub-processors
      (AWS), breach notification to the client. Who: operator + client
      legal. Trigger: before production holds client data.
- [ ] **Hosting region and transfer.** `af-south-1` keeps the data in South
      Africa; any other region is a transfer under s72 and needs the client's
      agreement. Trigger: the region choice in § Blocking releases.
- [x] **Data-subject export** ("download my data", plan.md Phase 7;
      2026-09-26). `GET /auth/me/export` and the Account page's **Download
      my data**: the account, memberships, farm links with their published
      figures and registered volumes, notes, sign-offs, invites to the
      verified address, alert and report choices, and the audit events by or
      about the person, the RLS-hidden parts through
      `app_subject_export()` (054_subject_export.sql). One a minute per
      account. `auth/export.ts` `USER_FK_COVERAGE` classifies every foreign
      key to `app_user` (guarded by `export.db.test.ts`). The privacy notice
      (above) must say it exists.
- [ ] **Self-service account deletion, and evidence that names its maker.**
      **Operator path done (138, issue #112):** deleting an account keeps
      the evidence it made (project, team, run, ensemble, nomination,
      scenario, import) with the maker cleared, deletes a started ensemble
      and draft applications, and refuses only the sole owner or admin until
      handed over (deployment.md § Runbooks, item 7; Privacy §7 rewritten,
      `LEGAL_VERSION` 2026-09-30). **Self-service done (143, issue #112):**
      `DELETE /auth/me` (the password again, through the sign-in lockout;
      `409 account_sole_holder` naming the projects and teams they alone own
      or administer; an audit event per project and team; an email of what
      was done, s24(4)) and the Account page's **Delete my account** dialog,
      in English and Afrikaans, with `account-delete.spec.ts`. What is left
      of #112 waits on the information officer (#90): confirming the rule,
      and the items below (deleted notes' bodies, backups after an erasure,
      D12, the lawful bases). Trigger: the #90 answers.
- [x] **Two owners leaving a project (or admins a team) at the same moment
      can leave it with none** (2026-10-01, PR #320). The member routes lock
      the owner (admin) rows before `assertNotLastOwner` /
      `assertNotLastAdmin`, and migration 149 has the keep-owner and
      keep-admin triggers take a per-project (per-team) lock before counting;
      `last-owner-race.db.test.ts` forces both orders.
- [ ] **A DWS or CMA responsible party keeps the maker's name** (National
      Archives Act s13(2)(a), operator agreement 3A.2). **Built 2026-10-01
      (161):** the operator-set `team.public_records` keeps the name in that
      team's project history after account deletion, and the team and its
      projects are kept until `team.records_disposal_confirmed_on`
      (provisional position, pre-counsel research). Left: Privacy §7's
      sentence for such a team ("If the organisation responsible for a
      project is a government body that must keep its records by law …, your
      name stays in that project's history after your account is deleted"),
      a `LEGAL_VERSION` bump with it and an email to that team's members
      first (Privacy §12). Trigger: the first DWS or CMA client signs 3A.2.
- [x] **Retention of deleted notes' bodies.** Done (158_note_purge.sql;
      provisional position, pre-counsel research, 2026-10-01): a deleted
      note's text and earlier texts are erased 90 days after deletion by the
      tick (`app_purge_deleted_notes`, `DELETED_NOTE_RETENTION_DAYS`); the
      `note.deleted` event stays; a note on a scenario or pack past draft is
      kept hidden with the licence record. Privacy §7, security.md,
      data-model.md § Notes. A dispute before day 90: the client instructs
      the operator in writing to copy the note out first (no legal-hold
      feature until one is asked for).
- [x] **Backups after an erasure.** Done (provisional position, pre-counsel
      research, 2026-10-01): backups age out (≤ 35 days) and a restore
      re-applies erasures and revocations before traffic is back.
      `erasure_log` (159) keeps the id of every deleted account, project and
      team for 40 days, written by triggers so both deletion paths are
      covered; the restore runbook's step 6a reads it, and the audit log's
      revocations, on the old instance (deployment.md § Restoring the
      database); `account_deleted` now logs the account id for the case
      where the instance itself is lost; the old instance's final snapshot
      is taken only if needed and deleted within 30 days; the teardown
      snapshot is kept 90 days after the shutdown notice. Privacy §7,
      operator agreement 5.8 and 10.2, infra/README.md § Tearing down.
- [x] **D12 confirmation** (2026-10-01, provisional position, pre-counsel
      research). Pseudonymising is enough: s24(1)(b) reaches only what s14
      no longer authorises, and s14(1)(b) authorises the audit trail. The
      events stay, treated as personal information (not de-identified).
      Migration 160 also blanks the deleted account's masked address in
      invitation entries (`app_mask_email`, paired with `maskEmail` by
      `mask-email.db.test.ts`); Privacy §7 says so. If counsel wants the
      events de-identified, the remaining step is clearing `subject.userId`
      and node names in events about the person.
- [x] **Personal-information incident procedure** for the "a farmer sees the
      wrong farm" runbook (deployment.md § Runbooks, item 4): who at the
      WUA decides on notifying the Information Regulator and the data
      subject (s22), and in what time. Who: client. Trigger: before go-live.
      **Drafted:** [legal/incident-procedure.md](./legal/incident-procedure.md);
      the WUA's named decider goes in each operator agreement.
- [x] **The ingest hold's outlier limit still counts a key's earlier
      pushes.** Fixed in 053_series_key_days.sql: `series_key_days` records,
      per (series, key), the days a key changed that nobody has written
      since (a person's or a feed's write releases them, a replace releases
      all), and `series/hold.ts` `limitWithout` leaves them out. Tests:
      `ingest/ingest.db.test.ts` (a key pushing in batches can't raise its
      own limit; another key's and a person's days still count),
      `series/hold.test.ts`.
- [x] **The ingest hold has no reference for a series one key fills.**
      Fixed in 056_accepted_series.sql: `run_input_series.series_id` records
      which series each input of a run was read from, and when the series
      without the key's days is too short to judge by, the limit comes from
      the latest manual run's input of that series (what a person accepted;
      `limitFrom: 'accepted'`). Until a manual run has read the series the
      limit is deliberately the key-shaped one (`limitFrom: 'own'`, said in
      the held event, the response and the History line): security.md §
      API keys gives the reasoning. Tests: `ingest/ingest.db.test.ts`,
      `series/hold.test.ts`.
- [x] **Deleting an assessor's account is refused (session B, WP-3.3).**
      Fixed in 052_scenario_decider_deletion.sql: `scenario_guard` (from
      045's definition) lets an update through untouched when its only
      change is `decided_by` becoming NULL and the account it named no
      longer exists, which only the foreign key's `ON DELETE SET NULL`
      produces. While the account exists, clearing or changing
      `decided_by` is still refused. `auth/account-deletion.db.test.ts`
      covers both.
- [x] **Persona verdicts and load checks** ([issue #51](https://github.com/Absence0760/project-water-management/issues/51)):
      the six personas' verdicts are in step-2 §9 "Build verdicts" (first
      pass 2026-09-28, fixes in #127, #129, #130, #134, #135 and the PR that
      closed #51, re-checked at 81db5ed), and the 60-farm load timings in
      step-2 WP-2.16 "Load checks" (manual run ≈ 8.7 s on the API Lambda,
      under the 10 s trigger; storage flat over 30 days).
- [x] **Hold a key's pushes into a short series?** A series with fewer than
      100 non-zero days has no outlier limit, so a key's push into it is
      checked for negatives only (security.md § API keys, Limits). Holding
      every such push is safer but holds a new logger's automatic runs
      until a person runs the model, every day, for months on a dry rain
      record. Who: operator,
      [#93](https://github.com/Absence0760/project-water-management/issues/93).
      Trigger: before the first gateway key is issued on production.
      **Decided (operator, 2026-10-01): hold auto-publish only (option b),
      keep automatic runs (option a). Done:** a key's push with no outlier
      limit records `series.unchecked` and answers `autoPublishHeld: true`;
      its automatic run runs, and `autoPublish` publishes none while such an
      event is newer than the latest manual run (`series/hold.ts`
      `uncheckedSinceLastRun`); the History says "Paused automatic
      publishing". Tests: `ingest/ingest.db.test.ts`,
      `history/timeline.test.ts`.
- [x] **The WUA's cut % beside its own notice.** The farm page and `/share`
      showed "a 20 % cut in registered water use" only when the WUA wrote no
      notice text; the alert email shows both. Make them agree (both, or
      neither). Who: operator,
      [#93](https://github.com/Absence0760/project-water-management/issues/93).
      **Decided (operator, 2026-10-01): both everywhere**, since the % is the
      WUA's decision and the notice its explanation. **Done:** `noticeCard`
      (farm page) and `shareNotice` (`/share` and its printed member
      summary) show the line whenever a % was published. Tests:
      `farm/cards.test.ts`, `share/share.test.ts`, `farm-view.spec.ts`,
      `share-links.spec.ts`.
- [x] **A stale EWR-forecast alert says nothing.** A firing
      `ewr_forecast_fail` event is left as it is while its forecast is behind
      the recorded rain (`alerts/evaluate.ts`, by design: a stale forecast
      neither opens nor clears), but when no new forecast is made (the
      forecast feed failing) the workspace's Active alerts showed it as
      current. Done: the API's `forecastOutOfDate` (derived at read time,
      `newestForecast`; api.md § Alerts) puts "Forecast out of date: made …
      on the rain recorded to …, but rain is now recorded to …" under the
      event on Active alerts (ui.md § Alerts), and a mail of it sent
      meanwhile says the same (`mail.alert.ewr.outOfDate`). The farm page
      and the farmer alert pages show no EWR event (staff only).
- [ ] **A log of restriction decisions** (WUA persona): which restriction
      the WUA published, when, and by whom, for members and the CMA. The
      publication history holds it; a page that lists it doesn't exist.
      Trigger: a WUA asks, or Step 3's licensing evidence needs it.
- [ ] **One guard for views over a run's stored series.** Every view that
      reads a run's daily series (not its summary) must cut a forecast run
      at `summary.forecast.from` (`beforeForecast`); issue #51 found four
      that didn't, one at a time. A guard test listing each
      `api.runs.series` / `run_series` consumer and how it treats a forecast
      run would stop the next one. Trigger: the next view over stored
      series.

## River network layer at full HydroRIVERS scale (round 4 readiness, perf-hunt)

Measured on a scratch database with 300 000 synthetic reaches spread over
South Africa (2026-10-02): `GET …/map/rivers` for a 2° × 2° box runs two
sequential scans of `river_reference`, the bbox query (21 ms: the btree
`river_reference_bbox_idx` on `(min_lon, max_lon, min_lat, max_lat)` can't
serve a four-sided overlap, so the planner skips it) and `riverDatasets()`'
`count(*) … GROUP BY dataset` (25 ms), on every pan. Fine at South Africa's
network; linear in the table, so about 0.2 s a request if the operator loads
all of Africa. `GET …/map/stations` counts its datasets the same way.

- **Durable fix:** in one migration, an expression GiST index on
  `box(point(min_lon, min_lat), point(max_lon, max_lat))` (core Postgres, no
  PostGIS) with the query written as `box(...) && box(...)`, and a small
  per-dataset summary table (dataset, count) the loader (`loadRivers.ts`,
  `loadGaugeStations.ts`) writes in its transaction, read instead of the
  count. Measure before and after with `EXPLAIN (ANALYZE, BUFFERS)` at a
  million rows.
- **Trigger:** a river network of more than about 500 000 reaches is loaded,
  or the layer's request shows above 100 ms in the API's logs.

## Round-4 input hardening (map data, geometry, compute caps)

What the round-4 `sec-input` pass fixed is in docs/security.md (§ Input
handling: Delineation, Map data files, Geometry cost). Left open:

- [ ] **A work budget on summing a polygon over a grid.** `gridShares`
      (land cover, evaporation; a viewer's read) clips every vertex to every
      row it is summed over. Halving the rows and cells (the `sec-access`
      round-4 branch, `eachBand`) fixes the ordinary case, but a comb whose
      every edge runs the polygon's whole height keeps all its vertices in
      every row: a valid 50 000-vertex one over 0.0025° × 178° is about
      72 000 rows × 50 000 vertices, billions of steps, and `maxCells`
      doesn't stop it (one column). The durable fix is a budget on the
      vertices the clipping makes (`eachBand`'s `work` counter, refused past
      a few million) with a test of that comb. Trigger: the halving lands on
      main (it was left to that branch to avoid two rewrites of one file).
- [ ] **Nested holes.** `checkGeometry` now refuses a hole that crosses its
      outer ring or another hole, but not a hole wholly inside another hole
      (its area is subtracted twice). A full check is a point-in-ring test
      per pair of holes, quadratic in the number of holes, so it needs a
      cap on holes first. Trigger: a real file with nested holes, or an area
      found below a polygon's outer ring minus its holes.
- [ ] **Pin the GDAL image by digest.** `bin/tiles-dev.sh water` runs
      `$GDAL_IMAGE` (`ghcr.io/osgeo/gdal:ubuntu-small-3.11.3`) by tag when
      gdalwarp isn't installed; `pnpm check:pins` doesn't cover it. Pin it
      `@sha256:` and add it to the pins guard. Trigger: the next change to
      that script.
- [ ] **No published checksums for the downloaded sources.** HydroRIVERS'
      zip, JRC GSW's tiles, dPET's yearly files and the Protomaps/Mapterhorn
      builds have no checksum the scripts verify (whether each publisher
      offers one was not checked in this round); the scripts are HTTPS-only (redirects
      too) and the readers fail closed, and the production load hashes
      what the operator prepared. Trigger: any of them starts publishing
      checksums.
