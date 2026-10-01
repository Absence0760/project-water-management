# Step 1: the hydrologist's tool, finished and deployed

Status: in progress (written 2026-09-23 against `main` @ 43f9ccb, engine 0.4.0,
migrations `001`–`005`; `main` is now at engine 0.17.0 and migration `006`).
WP-1.2–1.4, 1.18–1.23 and the H1 decision have landed, most of the engine
work on persona recommendations still pending the hydrologist; each WP's
status note says what is left. Rules and template: [README.md](./README.md).

## 1. Summary

Step 1 is for consulting hydrologists and the first client's modelling team.
It ends with a deployed replacement for the b023 spreadsheet that they trust
and use every day. For them this means:

- a model a hydrologist has signed off (issue #1 decided, the engine-audit
  questions answered or explicitly accepted);
- the spreadsheet chores gone: `.xlsx` in and out, instant what-if, automatic
  calibration, templates for bulk entry;
- a live site at `water-management.jaredhoward.com` that has backups, alarms
  and a runbook.

## 2. Users and jobs to be done

| User | Jobs to be done | What they use today | What would make them switch |
| --- | --- | --- | --- |
| **Consulting hydrologist** (primary) | Set up a catchment from a b023 workbook. Calibrate the rain→flow model against the right record. Run what-ifs (dam raise, crop change, transfer). Hand the client shortfall, EWR and curtailment numbers they can defend. | The b023 `.xlsm`: hand-tuned calibration, copy-paste to Word, one workbook per scenario | A model that is **more correct** than the workbook (engine-audit fixes, signed off by them). Calibration in minutes instead of hours (auto-fit + live preview). No loss of Excel (`.xlsx` import and export, templates). Run comparison instead of screenshots side by side. |
| **The first client's modelling team** (co-modellers, the client's reviewer) | Open the same catchment, check numbers, compare baseline against scenario, download tables for their report. | Emailed workbooks and PDFs | One shared, access-controlled copy. Pinned baseline runs. Downloads in their units and number style. |
| **Operator** (developer and support) | Deploy safely, restore after a mistake, answer "why did the result change?", keep costs predictable. | Local dev only | A release pipeline, a restore that has been rehearsed, alarms and a runbook. |

Farmers, WUAs and licensing users are **not** Step 1 users (see §3).

## 3. Scope

### In scope

- **Model sign-off:**
  - issue #1, closed in code and docs;
  - issue #2, the rainfall zero-run check;
  - calibration exclusion ranges;
  - the client catchment regression run on real data;
  - a decision on `verify/`;
  - engine work packages for every audit question (H1, N1–N4, Q1, Q3, Q5,
    Q7, Q11–Q13, Q17, Q18), built once answered.
- **Hydrologist workflow:**
  - `.xlsx` export (library decision);
  - exports over 5 MB;
  - instant in-browser preview;
  - automatic calibration;
  - unit preferences;
  - in-browser workbook import;
  - spreadsheet templates;
  - per-node series overlay (plus the other run-comparison leftovers);
  - pinned runs;
  - the thousands-separator decision;
  - an account menu with "Sign out everywhere".
- **Going live:**
  - client-name scrub and the GitHub plan;
  - the `production` environment;
  - AWS bootstrap and the region;
  - RDS (plan.md Phase 6);
  - the first `backend@`/`web@` releases;
  - a production smoke test;
  - a backup and restore drill;
  - monitoring and a runbook.
- **Production hardening** (plan.md Phase 7, still open):
  - POPIA privacy notice, per-user data export and account deletion;
  - account policy decisions and password change;
  - skewed-`TZ` test runs;
  - the request sequencer;
  - `/audit/all` and `/release-readiness`.

### Out of scope

| Item | Where it goes |
| --- | --- |
| Farmer and WUA views, per-farm visibility scopes, alerts, data feeds (per-project API keys, CHIRPS/DWS fetchers, auto re-run), forecast mode, PDF report generation, change history and audit log, published runs for stakeholders, Afrikaans UI | Step 2 |
| Scenarios within a project (overrides on a base model), licences and allocations, assurance of supply and yield, cumulative impact, catchment map | Step 3. Step 1 uses copy-project plus run comparison. |
| Multi-tenancy, billing, SSO/MFA, public API/OpenAPI, climate and stochastic scenarios, onboarding tour, Excel round-trip back to b023 | Step 4 |
| Run storage in S3, background jobs (SQS) | Step 2, when reports or feeds need them. Step 1 leaves room (WP-1.29). |
| Node types beyond farm/gauge, pump scenarios, the runoff (bucket) module | Not planned until a hydrologist asks. H1 (WP-1.24) may bring in an alternative flow generator. |

## 4. Prerequisites

Already true:

- engine 0.4.0 with the invariant suite, soaked over seeds 1–20000;
- the local stack runs (`pnpm setup && pnpm dev`);
- the Terraform is written and tested plan-only;
- release pipelines exist, and their preflight refuses to deploy.

Still needed, with the WP each one blocks:

| Prerequisite | Needed by | Who |
| --- | --- | --- |
| A hydrologist agrees to a review session. Answers to issue #1's short confirmation, issue #2 and the engine-audit "Open questions" | WP-1.1, then WP-1.19–1.25 | Operator arranges; hydrologist answers |
| The client catchment workbook back in `../project-water-management-source/Original/` | WP-1.4, WP-1.5, WP-1.25, WP-1.31 parity | Operator |
| Client answer to plan.md Q15: may client data live in AWS, and must it stay in South Africa? | WP-1.14 (region), and loading client data into production | Client |
| Client answer to plan.md Q10/Q11: who needs accounts; open or invite-only sign-up | WP-1.12 | Client |
| A list of client-identifying terms (catchment and farm names, workbook file names) agreed with the client | WP-1.7 | Operator + client |
| Who is the POPIA "responsible party" (the operator, the client or the consultancy) and its Information Officer | WP-1.13 | Operator + client (legal) |
| Budget owner for about $50–70/month of AWS (plan.md Q17) | WP-1.14 | Client / operator |

## 5. Architecture changes

```
browser (SvelteKit SPA)
 ├─ lib/preview/engine.worker.ts      runModel on the unsaved model        (WP-1.17)
 ├─ lib/calibration/autocal.worker.ts calibrate() off the main thread      (WP-1.18, issue #4)
 ├─ lib/spreadsheet/*.worker.ts       SheetJS CE: .xlsx export, templates,
 │                                    b023 workbook import                  (WP-1.28/1.30/1.31)
 └─ /account, /privacy routes; account menu (AccountMenu)                 (WP-1.9, 1.13)
        │  same-origin /api (CloudFront → Lambda Function URL)
Hono backend
 ├─ POST /projects/import             ProjectFile → project (atomic)        (WP-1.8)
 ├─ PATCH /projects/:id/runs/:runId   pin / label                           (WP-1.11)
 ├─ GET  …/runs/:runId/series/bulk    all keys of one node                  (WP-1.28)
 ├─ /auth/change-password, PATCH /auth/me, GET /account/export.json,
 │  DELETE /account                                                         (WP-1.9, 1.12, 1.13)
 └─ every response streamed (Function URL invoke mode RESPONSE_STREAM)     (WP-1.29a, built #283)
Postgres (new next-free NNN_ migrations)
 ├─ model_run.pinned_at, pinned_by                                          (WP-1.11)
 ├─ user_preferences.preferences jsonb (083, built)                         (WP-1.26)
 ├─ created_by nullable on project/team/model_run; app_delete_account()     (WP-1.13)
 └─ node: irrigation efficiency, dam area–volume, seepage; transfer.priority (WP-1.19–1.21, landed in 006)
packages/engine (pure)
 ├─ calibrate/ (dds, objectives, calibrate), buildModelInput               (WP-1.17/1.18)
 ├─ quality.ts: zero-rain runs, rain below CHIRPS                           (WP-1.4)
 └─ flow.ts / demand.ts / network/simulate.ts / curtailment.ts physics      (WP-1.19–1.24)
AWS: RDS pg17 + VPC Lambdas as already in infra/; add a Route 53 health check
     on /api/health; restore drill; no new service unless S3 wins D9.
```

Settings changes (calibration exclusions, data-quality thresholds, lake
evaporation factor, effective-rain mode) live in `project.settings` jsonb:
`backend/src/projects/settings.ts` validates them and
`packages/engine/src/project.ts` holds the defaults. They need **no
migration**.

## 6. Work packages

Numbering is the build order for one developer. Three tracks can run in
parallel in git worktrees:

- **A (model sign-off):** 1.1–1.6, 1.19–1.25, 1.33–1.35
- **B (workflow):** 1.9–1.11, 1.17–1.18, 1.26–1.32
- **C (go-live):** 1.7–1.8, 1.12–1.16

WP-1.19–1.24 were built on 2026-09-24 from simulated hydrologist and
assessor answers (engine 0.14.0–0.17.0), so the hydrologist now confirms or
changes each decision rather than answering from scratch
([followups.md](../followups.md)). WP-1.33–1.35 still wait for the answers.

| WP | Title | Track | Size | Depends on |
| --- | --- | --- | --- | --- |
| 1.1 | Hydrologist review pack and session | A | S | – |
| 1.2 | Close issue #1 in code | A | S | – |
| 1.3 | Calibration exclusion ranges | A | S | – |
| 1.4 | Rainfall zero-run check (#2) | A | S | – |
| 1.5 | Client catchment regression on real data | A | S | workbook |
| 1.6 | `verify/` decision | A | S | 1.5 |
| 1.7 | Client-name scrub, repo public | C | M | term list |
| 1.8 | Project import through the API | C | S | – |
| 1.9 | Account menu and `/account` page | B | S | – |
| 1.10 | Thousands separator and export number format | B | S | D10 |
| 1.11 | Pinned runs | B | S | – |
| 1.12 | Hardening before go-live | C | M | D12 |
| 1.13 | POPIA: privacy notice, data export, account deletion | C | M | 1.9, D13 |
| 1.14 | AWS bootstrap, `production` environment, region | C | S (+ operator waits) | 1.7, D7 |
| 1.15 | First release and production smoke | C | S | 1.8, 1.12, 1.13, 1.14 |
| 1.16 | Backups, restore drill, monitoring, runbook | C | M | 1.15 |
| 1.17 | Instant in-browser preview | B | M | – |
| 1.18 | Automatic calibration | B | M | 1.3, 1.17 |
| 1.19 | Operating rules: N4/Q3, Q18, Q5, Q7, Q1 | A | M | 1.1 answers |
| 1.20 | N1 irrigation efficiency | A | M | 1.1 answers |
| 1.21 | N2 dam area–volume, evaporation, seepage | A | M | 1.1 answers |
| 1.22 | N3 effective-rain carry-over | A | M | 1.1 answers |
| 1.23 | Q17 EWR attribution; Q11–Q13 curtailment policy | A | M | 1.1 answers |
| 1.24 | H1 volume-conserving event response | A | L | 1.1 answers, 1.18 |
| 1.25 | Engine release, recalibration, sign-off | A | M | 1.19–1.24 |
| 1.26 | Unit preferences | B | M | 1.9 |
| 1.27 | Run comparison: per-node overlay and leftovers | B | M | 1.11 |
| 1.28 | Spreadsheet library and `.xlsx` export | B | M | D8, 1.10 |
| 1.29 | Exports over 5 MB | B | S | D9 |
| 1.30 | Spreadsheet templates for bulk entry | B | S | 1.28 |
| 1.31 | In-browser b023 workbook import | B | L | 1.8, 1.28 |
| 1.32 | Gap filling for input series | B | M | — |
| 1.33 | Other water users (towns, unlisted users) | A | S | 1.1 answers |
| 1.34 | Groundwater abstraction and base-flow reduction | A | M | 1.1 answers, 1.24 |
| 1.35 | Land-cover streamflow reductions (invasive plants, forestry) | A | M | 1.1 answers, 1.24 |

Rough total: about 25–32 developer-weeks. With tracks in parallel and
operator/hydrologist waits (SES review, the region opt-in, answers), plan on
**4–6 calendar months**. H1 and the workbook import are the long poles.

---

### WP-1.1 Hydrologist review pack and session

- **Goal:** get every open model question answered, or explicitly accepted
  as it is, in one structured session. Record the answers where the code
  will read them.
- **Changes:**
  - **scripts / docs:** a one-page question sheet built from:
    - engine-audit.md "Open questions" 1–7;
    - issue #1 "To close this issue" (which observed record to calibrate
      against, how each record was processed and rated, and the largest
      unmeasured peak);
    - issue #2 (are the zero runs missing data?);
    - human impacts b023 leaves out (WP-1.33–1.35): are there towns or
      unlisted users on the river, and what do they take; do farms pump
      boreholes, and is the aquifer connected to the river; how much of the
      catchment is under invasive trees or forestry, and which reduction
      method is acceptable;
    - followups.md § Hydrologist: the data-quality limits (5×/10× P99,
      5/14-day flat-lines), the "Demand left %" extremes, the return-flow
      and curtailment note, the help-text read-through of
      `frontend/src/lib/help/content.ts`;
    - plan.md "Model and hydrology" 1–14.

    For each question give the options and the recommendation from the
    audit. The session is the operator's job.
  - No code.
- **Data model / API / UI:** none.
- **Local-first equivalent:** n/a.
- **Tests:** n/a (docs only). Say so in the commit.
- **Docs to update:**
  - answers, dated, in plan.md § Questions and model.md §3;
  - the "Decision" column of engine-audit.md;
  - issue #1 and issue #2 comments;
  - followups.md ticks.
- **Acceptance criteria:**
  - every question has an answer, "accepted as is", or "not answerable
    (reason)";
  - each answer names the WP that implements it (1.19–1.24) or says "no
    change".
- **Size:** S (prep); the session itself happens on the hydrologist's
  calendar.
- **Depends on:** –

### WP-1.2 Close issue #1 in code

- **Goal:** the engine never picks a calibration record silently, and the
  agreement warning doesn't assume an instrument fault. These are issue #1
  plan items 1–3. **Landed** (engine 0.5.1): `pickObservedKind` warns on a
  default gauge pick, and model.md §2.10/§2.10a record the findings. The
  agreement warning was already neutral after an earlier rewording, so it was
  left as is. Closing the issue still waits for WP-1.1's sign-off.
- **Changes:**
  - **engine:**
    - `pickObservedKind` pushes a warning when `calibrationFlowKind` is
      null and both gauge and logger series exist ("calibrated against the
      gauge by default; choose the record in Settings → calibration flow
      series");
    - `agreementWarning` in `quality.ts` is reworded neutrally ("the two
      records disagree; check they measure the same reach and period").
    - These are warnings only, with no numeric change, but bump the patch
      `ENGINE_VERSION` because run warnings change (0.5.0 → 0.5.1 by the
      time it landed).
  - **frontend:** none (warnings render already).
- **Data model / API:** none. The client catchment's data and settings
  stay as given.
- **UI:** the new warning shows in the Runs tab warnings.
- **Local-first equivalent:** n/a.
- **Tests:**
  - `run.test.ts`: the default-pick warning, with a positive control (no
    warning when `calibrationFlowKind` is set);
  - update `quality.test.ts` for the wording.
- **Docs to update:**
  - model.md §2.10 (default pick) and §2.10a (the warning is expected
    wherever the two records measure different sites);
  - plan.md (replace the "Ask this first" block with the answer once WP-1.1
    confirms it);
  - followups.md; close issue #1 after sign-off.
- **Acceptance criteria:**
  - a project with both series and no kind set gets exactly one warning;
  - with a kind set it gets none;
  - `pnpm test:engine` is green.
- **Size:** S.
- **Depends on:** – (closing the issue waits for WP-1.1).

### WP-1.3 Calibration exclusion ranges

- **Goal:** let the hydrologist exclude date ranges of the observed record
  from calibration. Uses: a drowned sensor, "above rating" peaks, or a period of
  one record if #1 goes that way. Build it whatever #1 decides: unmeasured
  high flows (above a record's highest field gauging) are the obvious first
  use.
- **Landed** (engine 0.8.0, issue #4 assessor review, with fit provenance),
  with these departures from the plan below, reasoned in model.md §2.10:
  - an entry is a whole water year *or* a date range, and its `reason` is
    required (1–500 characters), not an optional note: an excluded period
    must always leave a record;
  - automatic calibration applies the same list, and each run's statistics
    record `exclusions` and `excludedDays`;
  - up to 100 entries; overlapping periods are allowed (their union is
    excluded), only the same period listed twice is refused;
  - the editor sits under the calibration window in Settings
    (`CalibrationExclusions.svelte`), not inside `CalibrationWindowFields`;
  - **not built:** shading the excluded bands on the hydrograph. The
    calibration panel lists them with the days removed instead.
- **Changes (as planned):**
  - **engine:**
    - `ProjectSettings.calibrationExclusions: { start, end, note }[]`
      (default `[]`);
    - `network/stats.ts` skips excluded days in every metric (NSE, KGE,
      log-NSE, R², PBIAS, annual volumes);
    - `CalibrationStats` gains `excludedDays`.
  - **backend:** zod validation in `projects/settings.ts`:
    - ISO dates, `start ≤ end`;
    - at most 50 ranges;
    - notes ≤ 200 characters.
  - **frontend:** an "Exclude periods" list in
    `components/calibration/CalibrationWindowFields.svelte`; excluded bands
    shaded on the hydrograph (`RunChart.svelte`).
- **Data model:** settings jsonb only; no migration.
- **API:** `PATCH /projects/:id` accepts `settings.calibrationExclusions`.
  Document it in api.md.
- **UI:**
  - empty state: "No periods excluded";
  - validation: an overlap or an inverted range blocks Save with a message;
  - viewers see the list as read-only text;
  - on a phone the list stacks one range per row.
- **Local-first equivalent:** n/a.
- **Tests:**
  - **engine unit:** excluded days change nothing but the metrics; an
    exclusion covering the whole window gives null stats plus a warning;
  - **`compare.ts` `diffInputs`:** a readable line for added or removed
    ranges;
  - **frontend unit:** the form helpers;
  - **e2e:** add a range in `settings.spec.ts`, run, and see `excludedDays`
    in the calibration panel;
  - **axe:** on the Settings tab.
  - Date-sensitive tests run under a skewed `TZ`.
- **Docs to update:** model.md §2.10, api.md, ui.md § Settings,
  run-comparison.md (settings lines).
- **Acceptance criteria:**
  - excluding one unmeasured peak changes NSE and KGE;
  - it leaves every other output bit-identical;
  - "What changed" in compare lists the exclusion.
- **Size:** S.
- **Depends on:** –

### WP-1.4 Rainfall zero-run check (issue #2)

- **Goal:** flag runs of zero rainfall that look like missing data. Stored
  zeros block the CHIRPS fallback.
- **Landed** (engine 0.5.2), with three deliberate departures from the plan
  below, reasoned in model.md §2.10a:
  - the zero-run season is the series' own six wettest months, not "a
    winter month", so summer-rainfall catchments are judged correctly
    (60+ wet-season days; a plain 180 days without two years of data);
  - the CHIRPS check is `lowvschirps`: below 50 % of the record's *usual*
    catchment / CHIRPS share (the median), not of CHIRPS itself, so a
    systematic CHIRPS bias doesn't flag every year or hide real gaps;
  - the thresholds were engine constants like the outlier and flat-line
    limits; since engine 1.20.0 (issue #66) all of them are
    `settings.dataQuality`, defaults unchanged, with the hydrologist
    review's alternatives as opt-in settings (followups.md, *Data-quality
    limits* and *Data-quality alternatives as defaults*).

  The importer prints the zero-run note; the low-vs-CHIRPS check is
  engine-only. The fix itself stays with the data (issue #2 item 1).
  **Superseded in part (2026-09-24):** CR-20 (engine 0.15.0,
  [model.md §2.4c](../model.md#24c-zero-rain-runs-treated-as-missing))
  treats flagged runs as missing in the run so that bias-corrected CHIRPS
  fills them, with per-project keep-dry and missing periods. The stored data
  still isn't changed. Engine 0.18.0 makes the CHIRPS factor fit follow the
  same decisions (flagged runs left out day by day, kept-dry days kept, a
  keep-dry guard; model.md §2.4b) and adds CR-20's double-mass check
  against CHIRPS, a warning plus a Data-tab chart (model.md §2.10a).
- **Changes (as planned):**
  - **engine:** `quality.ts` `checkSeries` gains two checks:
    - `zerorun`: ≥ N consecutive zero days, default 60, counted only when
      the run touches a winter month;
    - `belowChirps`: the water-year total of `rain_catchment_mm` is below
      X × the CHIRPS total, default 0.5, when both series exist.

    New `DataQualitySettings` fields `zeroRunDays` and `chirpsMinRatio`,
    both editable in Settings → Data quality. Bump the patch
    `ENGINE_VERSION`.
  - **scripts:** `scripts/wbt-import` prints the same note at extraction.
  - **frontend:** the checks appear in the Data tab's Data checks panel
    (they already come from `checkSeries`).
- **Data model / API:** settings jsonb only; `summary.dataQuality.seriesChecks`
  gains the two `check` values. Update api.md.
- **UI:**
  - the Data tab lists the flagged stretches;
  - no auto-fix. The fix is data: re-upload those days as blank through Add
    data → append/update.
- **Local-first equivalent:** n/a.
- **Tests:**
  - **engine unit:** a synthetic series with a 361-day zero run, and a
    positive control of a real 30-day summer dry spell that is not flagged;
  - **Python `test_*.py`:** the importer note;
  - **e2e:** extend `data-quality.spec.ts`.
- **Docs to update:** model.md §2.10a, ui.md § Data, followups.md, issue #2.
- **Acceptance criteria:**
  - a synthetic year-long wet-season zero run is flagged, and a dry summer is not;
  - the thresholds are editable;
  - results are unchanged.
- **Size:** S.
- **Depends on:** –

### WP-1.5 Client-catchment regression on real data

- **Goal:** run the commented deviation-list suite against the real workbook
  for the first time.
- **Changes:**
  - **scripts:** re-extract with `scripts/wbt-import` (README steps) into the
    gitignored `data/client-catchment/`;
  - **engine:** run `pnpm test:engine`;
  - for each failure, either fix a real engine bug (with a failing test
    first) or show that the deviation is an audit finding and widen **only**
    the bound that finding names in `run.test.ts` / `flow.test.ts`,
    recording why. Loosening a bound without a named finding is not allowed.
- **Data model / API / UI:** none.
- **Local-first equivalent:** runs only where the gitignored fixtures exist,
  and skips cleanly elsewhere (CLAUDE.md rule 10).
- **Tests:** the suite itself. Also run
  `FUZZ_CASES=20000 pnpm -C packages/engine exec vitest run src/run.invariants.test.ts`
  if any engine code changes.
- **Docs to update:** engine-audit.md § Regression suite (the measured
  differences, per column), followups.md.
- **Acceptance criteria:**
  - the suite passes on real client catchment data;
  - every non-exact column has a bound with the finding ID next to it;
  - the result is recorded, with the date and engine version.
- **Size:** S.
- **Depends on:** the workbook being present.

### WP-1.6 `verify/` decision

> **Status (2026-09-30):** the operator chose (b), rebuild. `verify/` is now
> an independent cross-check of the engine written only from the docs
> (verify/README.md, model.md §6 Verification): phase 1, the core daily
> chain, runs in CI (`pnpm test:verify`); phase 2 is tracked in
> followups.md § Verification. `dumpwb.py` moved to `scripts/wbt-import/`.
> The plan below is the one that was weighed.

- **Goal:** resolve the half-built Python cross-check. It transcribes b023's
  formulas, which engine 0.4.0 deliberately no longer follows.
- **Options:**
  - (a) Delete `verify/`. Move `dumpwb.py` into `scripts/wbt-import/` if
    it's still useful for reading formulas.
  - (b) Rebuild it as an independent implementation of the **audited**
    model. That is L; the invariant suite already covers the same risk.
- **Recommendation:** (a). The invariants plus the real-data regression
  (WP-1.5) are the safety net. Drop the Dependabot `pip` entry in the same
  change (followups § Pipelines).
- **Changes:** remove `verify/` or move it; `.github/dependabot.yml`; docs.
- **Tests:** n/a (deleting unused code). `pnpm test:scripts` stays green.
- **Docs to update:** followups.md, model.md §6 Verification (drop mentions
  of `verify/` if any).
- **Acceptance criteria:**
  - no `verify/` directory;
  - no dangling references (`grep -r verify/`).
- **Size:** S.
- **Depends on:** WP-1.5; the operator decides (D4).

### WP-1.7 Client-name scrub, repo public, GitHub unblocked

> **Status (2026-09):** the scrub, the terms guard and the history rewrite are
> done (the term list is in `infra-secrets/water-management/`); the repo was
> recreated from the clean history (the old one is the private
> `project-water-management-old`) and the issues re-filed as #1 and #2. Left:
> making the repo public (followups.md § Blocking releases).

- **Goal:** make the release gates possible. On GitHub Free, Pro or Team,
  **required reviewers work only on public repositories**
  ([GitHub docs: deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)).
  CodeQL on a private repo also needs paid code scanning. The repo is a
  personal account's private repo, so "a paid plan" in practice means
  Enterprise. Going public is the realistic route.
- **Changes:**
  - **Terms list:** agree the client-identifying terms with the client
    (catchment name, farm names, workbook file names). Keep the list
    **outside the repo** (`infra-secrets/water-management/client-terms.txt`),
    because the list itself names the client.
  - **Working tree:**
    - replace those terms in `docs/`, code comments, test names, `bin/seed-demo.sh`
      text and help content with neutral names ("the client catchment",
      "Farm 7");
    - rename the `data/client-catchment/` fixture path constant to a neutral one,
      keeping a fallback to the old path during the move.
  - **Issues:** edit or re-post the calibration and rainfall issues and comments without
    farm names. Public DWS/WRC facts (gauge IDs, report numbers) can stay if the
    client agrees.
  - **History:**
    - `git log -S'<term>' --all` for each term;
    - if any are found, choose D6: rewrite history with
      `git filter-repo --replace-text`, or publish a fresh squashed repo.
      Both need every other session and worktree stopped first.
  - **Guard:** a local pre-commit hook that greps staged changes against
    the terms file when it exists, so the terms never come back.
  - Then make the repo public:
    - turn on CodeQL, Scorecard and branch protection;
    - make `CI gate` a required check (re-run `new-project-account.sh`, per
      deployment.md §4).
- **Data model / API / UI:** none (text only).
- **Local-first equivalent:** the terms guard is a no-op when the file is
  absent.
- **Tests:**
  - guard unit test under `scripts/guards/`, using synthetic terms;
  - `pnpm test` and `pnpm test:e2e` still pass after the renames.
- **Docs to update:** security.md § Public repo hygiene (the terms file and
  the guard), followups.md (tick both blockers), CONTRIBUTING.md.
- **Acceptance criteria:**
  - `git grep` and `git log -S` find no term, across all refs;
  - the repo is public;
  - CodeQL and Scorecard are green;
  - `CI gate` is required on `main`.
- **Size:** M (the history rewrite and coordination dominate).
- **Depends on:** the term list from the client; D5 and D6.

### WP-1.8 Project import through the API

> **Status (2026-09):** built. `POST /projects/import` (shared with the
> scripts through `backend/src/projects/import.ts`) and the *Import project
> file (.json)* dialog on the project list, with DB, route-inventory, unit,
> e2e and axe tests ([api.md § Import a project file](../api.md#import-a-project-file),
> [ui.md § Project list](../ui.md#project-list)). Two departures from the
> plan below: the route has its **own 5 MB** cap (the export cap, so every
> export imports back) instead of the general 4 MB one, and `run` is a query
> parameter (`?run=1`); a run that fails after the import commits comes back
> as `runError` with the project kept. Measured: a multi-decade catchment's
> `project.json` is well under 1 MB, so gzip request bodies weren't needed.

- **Goal:** there is currently no way to load a catchment into production.
  `pnpm import:project` (`backend/scripts/import-project.ts`) writes to the
  DB directly, and production has no DB access path. Add an atomic import
  route. It's on the go-live critical path, and WP-1.31 builds on it.
- **Changes:**
  - **backend:**
    - move the create-from-`ProjectFile` logic out of
      `scripts/import-project.ts` into `backend/src/projects/import.ts`,
      used by both the CLI and the route;
    - `POST /projects/import`: body = `ProjectFile`
      (`backend/src/projects/document.ts`); one `withUser` transaction;
      fresh ids; optional `teamId`; optional `run: true`;
    - the existing 4 MB `bodyLimit` applies and gives `413` with a hint.
  - **frontend:** "Import project file (.json)" on the project list next to
    Create.
- **Data model:** none. RLS applies through `withUser`, and the importer
  becomes owner through the existing trigger.
- **API:** `POST /projects/import` → `201 { project, runId? }`:
  - `400` with zod details;
  - `413` over 4 MB;
  - `404` for a team you're not in.
- **UI:**
  - file picker, then a preview (name, node, crop and series counts);
  - loading, then success (link to the project) or error (message, and
    nothing is created);
  - on a phone, a full-width dialog.
- **Local-first equivalent:** the same route on `:3001`.
- **Tests:**
  - **DB:** round trip `export.json` → import → `export.json` is equal apart
    from ids; RLS: a signed-out request gets 401; importing into a
    non-member team gets 404, with a positive control of a member's team
    succeeding;
  - **`routes.test.ts`:** the new route is auth-gated;
  - **e2e:** import `seed:examples` output through the UI;
  - **axe:** on the dialog.
- **Docs to update:** api.md § Projects, run-locally.md (UI import),
  deployment.md (how client data gets to production).
- **Acceptance criteria:**
  - a project exported locally imports into a fresh stack identically;
  - a failed import leaves no partial project.
- **Size:** S.
- **Depends on:** –

### WP-1.9 Account menu and `/account` page

- **Status:** built (issue #5). `PATCH /auth/me` and
  `POST /auth/change-password` (through the sign-in lockout; a wrong current
  password is `403`; success moves `sessions_revoked_at`, deletes any
  outstanding reset link and re-issues this device's cookie), the
  `/account` page (display name, email and its confirmation status, change
  password) and an **Account** link at the top of the header's account menu.
  DB tests in `backend/src/auth/auth.db.test.ts`, e2e and axe (both themes,
  desktop and phone width) in `e2e/tests/account.spec.ts`. The account menu
  stays a dropdown on a phone rather than becoming a sheet: it already fits
  a 360 px screen and passes axe there, so the sheet was not built.

- **Goal:** "Sign out everywhere" and password change in the UI. Also a home
  for preferences (WP-1.26) and the privacy actions (WP-1.13).
- **Changes:**
  - **frontend:**
    - `components/layout/AppHeader.svelte` (since issue #17, `AccountMenu.svelte` in the app shell): the Sign out button becomes an
      account menu button showing the display name, with Account, Sign out
      and Sign out everywhere (which asks for confirmation);
    - new `routes/account/+page.svelte`: display name, email and
      verification status, change password.
  - **backend:**
    - `PATCH /auth/me { displayName }`;
    - `POST /auth/change-password { currentPassword, newPassword }`: checks
      the current password against the login lockout, sets
      `sessions_revoked_at`, and re-issues this device's cookie.
- **Data model:** none (`app_user.sessions_revoked_at` exists).
- **API:** the two routes above, plus the existing
  `POST /auth/logout-everywhere`. Document them in api.md.
- **UI:**
  - the menu is keyboard-operable (Escape closes, focus returns to the
    button);
  - error states: wrong current password; a new password that's too short;
  - on a phone, the menu becomes a sheet.
- **Local-first equivalent:** n/a.
- **Tests:**
  - **DB:** change-password revokes other sessions (their next `/auth/me`
    gets 401) while this session survives (positive control); a wrong
    current password counts towards the lockout;
  - **e2e:** sign out everywhere across two browser contexts;
  - **axe:** the menu and `/account` in both themes and at phone width.
- **Docs to update:** api.md § Auth, security.md § Known gaps (remove two
  bullets), ui.md (header), followups.md.
- **Acceptance criteria:**
  - after "Sign out everywhere" in context A, context B gets 401 on its next
    request;
  - a password change keeps the current device signed in.
- **Size:** S.
- **Depends on:** –

### WP-1.10 Thousands separator and export number format

- **Goal:** one number style app-wide (D10), and a decision on how exports
  show unrounded values.
- **Changes:**
  - **frontend:**
    - `lib/format/number.ts` `fmtNum` uses the chosen separator. If it's a
      space, use U+202F (narrow no-break space) so numbers don't wrap;
    - `parseNum` accepts `,`, U+00A0 and U+202F (`\s` already covers the
      Unicode spaces; add tests);
    - `NumberInput grouped` shows the same style;
    - the charts' axis formatters follow.
  - **Exports:**
    - CSV stays full precision and never grouped (machine-readable, as today);
    - `.xlsx` (WP-1.28) writes full-precision values with a display number
      format, so the rounding is visual only.
- **Data model / API:** none.
- **UI:** every figure; screen-reader spot check (NVDA/VoiceOver) that
  "300 000" is read as one number.
- **Local-first equivalent:** n/a.
- **Tests:**
  - `number.test.ts`: format and parse round trip for each separator;
  - `numberText.test.ts`;
  - e2e assertions that pin figures (`network`, `runs` specs) are updated
    to the new style. Change the expected strings to the new format; don't
    loosen them to regexes.
- **Docs to update:** ui.md (Network, and a general number-style note),
  api.md § Export (formatting note), followups.md.
- **Acceptance criteria:** one style everywhere; pasting either style into a
  grouped field parses.
- **Size:** S.
- **Depends on:** D10 (client or hydrologist).

### WP-1.11 Pinned runs

- **Status:** built (issue #7, `015_run_pinned.sql`), differently from the
  plan below: a `model_run.pinned` boolean with a column grant beside `notes`
  (not `pinned_at`/`pinned_by`: 007 revoked the table-level UPDATE, so a
  grant was needed); a ceiling of **10** per project, in a trigger as well as
  the API; the PATCH takes `{ notes?, pinned? }` (no label: runs stay
  immutable); `RunMeta.pinned`; the badge reads "Pinned"; the ceiling's `409`
  shows in the Runs tab's error. The compare picker marks pinned runs but
  doesn't yet default A to the newest pinned run. See
  [data-model.md](../data-model.md) § Pinned runs.
- **Goal:** a baseline survives the 20-run cap (`RUNS_KEPT_PER_PROJECT`).
- **Changes:**
  - **migration (next free NNN):**
    - `model_run.pinned_at timestamptz NULL`;
    - `pinned_by uuid NULL REFERENCES app_user(id) ON DELETE SET NULL`;
    - a covering index on `pinned_by` (catalogue guard);
    - a partial index `(project_id) WHERE pinned_at IS NOT NULL`;
    - the existing `model_run_update` policy (editor) covers the write; no
      new grant is needed, since UPDATE is already granted.
  - **backend:**
    - `runs/execute.ts` `trimRuns` skips pinned runs, and the cap counts
      unpinned runs only;
    - at most `PINNED_RUNS_PER_PROJECT` pinned runs (default 5), `409`
      beyond that;
    - deleting a pinned run needs an unpin first (`409`).
  - **frontend:**
    - pin toggle and "Baseline" badge in `RunsTab.svelte`;
    - `compare/picker.ts` defaults A to the newest pinned run.
- **Data model:** as above. RLS: viewers can see `pinned_at`; only editors
  can change it.
- **API:** `PATCH /projects/:id/runs/:runId { pinned?, label? }` →
  `{ run }`. `RunMeta` gains `pinnedAt`.
- **UI:**
  - viewers see the badge but no toggle;
  - an error toast at the pin cap names the limit.
- **Local-first equivalent:** n/a.
- **Tests:**
  - **DB:**
    - 21 runs with the first one pinned keeps it; the cap and the
      pinned-delete conflicts;
    - RLS: a viewer's PATCH gets 403/404, with a positive control of an
      editor succeeding;
    - the catalogue guard stays green;
  - **unit:** `picker.ts` defaults;
  - **e2e:** pin, run past the cap, and the baseline is still there.
- **Docs to update:** data-model.md § Run output volume, api.md § Runs,
  ui.md § Runs, followups.md.
- **Acceptance criteria:** a pinned run is never trimmed; the pinned count is
  bounded.
- **Size:** S.
- **Depends on:** – (leave room: Step 2's "published run" is a separate flag,
  not `pinned_at`).

### WP-1.12 Hardening before go-live

- **Goal:** close the plan.md Phase 7 items that aren't POPIA, and settle the
  account policies.
- **Changes:**
  - **Account policy (D12):** implement the choices:
    - require a verified email to sign in, or keep the banner;
    - open, email-first or invite-only sign-up;
    - keep or tune the 5-attempt, 1–15 min lockout (anyone can lock another
      person's address).

    Email-first sign-up closes the last account-squatting gap, and is the
    recommendation if sign-up stays open.
  - **Skewed `TZ`:** no workspace sets one today: `frontend/vitest.config.ts`,
    `packages/engine/vitest.workspace.ts` and `backend/vitest.workspace.ts`
    all lack it. Set `TZ=Pacific/Kiritimati` (UTC+14) in the `test` scripts, and
    add a CI leg with `TZ=America/Adak` (UTC−10). Fix any failures at the
    source (CLAUDE.md rule 7).
  - **Request sequencer (plan.md 1d):** list and series fetches in
    `components/runs/cache.ts` and `components/series/valuesCache.ts` drop
    stale responses (a generation counter or `AbortController`) when the
    project or series changes.
  - **Tick stale plan.md Phase 7 rows:** the per-account lockout (`005`) and
    the session watermark (`004`) are done. (Ticked.)
  - **Accessibility leftovers:** a 320 px reflow check and a token contrast
    test, if `e2e/tests/a11y.spec.ts` doesn't already cover them.
  - `/audit/all`, fix every finding; `/release-readiness`.
- **Data model:** only if D12 changes sign-in rules (probably none; `004`
  has `email_verified_at`).
- **API:** possibly `403 { error: 'email not verified' }` on login; document
  it.
- **UI:** the sign-in and register copy for whichever policy is chosen.
- **Local-first equivalent:** Mailpit already catches every email.
- **Tests:**
  - **DB:** the chosen policy, with a positive control of a verified user
    signing in;
  - **unit:** the sequencer (a slow first response loses to a fast second);
  - **e2e:** rapid project switching shows the right series.
- **Docs to update:** security.md § Authentication and § Known gaps, api.md,
  plan.md Phase 7, followups.md § Accounts.
- **Acceptance criteria:**
  - tests pass under both skewed zones;
  - `/audit/all` has no open high or medium finding;
  - the account policy is written in security.md.
- **Size:** M.
- **Depends on:** D12 (client plan.md Q11).

### WP-1.13 POPIA: privacy notice, data export, account deletion

- **Goal:** a user can read what is held about them, download it, and delete
  their account (POPIA ss 18, 23, 24).
- **Changes:**
  - **frontend:**
    - a public `routes/privacy/+page.svelte`: who the responsible party is,
      what is held, why, where (region), the sub-processors (AWS: RDS,
      Lambda, S3, CloudFront, SES), retention, and how to make a request;
    - linked from register, sign-in and the footer;
    - "Download my data" and "Delete my account" on `/account`.
  - **migration (next free NNN, expand):**
    - `project.created_by`, `team.created_by`, `model_run.created_by` and
      `project_import.imported_by` (017) become NULLable with
      `ON DELETE SET NULL`, shown as "Deleted user"
      (review the triggers and the `project_insert` policy that read
      `created_by`);
    - a `SECURITY DEFINER app_delete_account(uid)` with a pinned
      `search_path`. It refuses with a reason when the user is the **only
      owner** of a project that has other members, or the only admin of a
      team with other members; they must transfer first. It deletes
      projects and teams where they are the only member. It removes
      `login_throttle` rows for the address, then deletes `app_user`
      (memberships, tokens and invites cascade already).
    - Grant `EXECUTE` to `water_app`.
  - **backend:**
    - `GET /account/export.json`: profile (no hash), memberships, team
      memberships, invites sent and pending for the address, runs created
      (ids and labels), imports made (project, file name, when; the
      `project_import` row), plus links to each visible project's `export.json`;
    - `DELETE /account { password, confirm: "delete" }`: checks the
      password, dry-run by default (`?dryRun=1` lists what will go), then
      clears the cookie;
    - `requireUser` must 401 a JWT whose user is gone (verify and test).
  - **Retention:**
    - runs: the cap plus pinned runs;
    - `email_token`: purge expired rows (verify that happens);
    - CloudWatch logs: 30 days;
    - RDS backups: 7 days plus the final snapshot. Deleted accounts persist
      in backups for up to 7 days; say so in the notice.
- **Data model:** as above.
- **API:** the two routes; both are auth-gated.
- **UI:**
  - the delete flow shows the dry-run list ("these 2 projects will be
    deleted; transfer 'X' first") and needs the password;
  - the export downloads a file.
- **Local-first equivalent:** the same routes locally.
- **Tests:**
  - **DB:**
    - deletion with and without blockers;
    - a positive control: another member still sees a shared project after
      its creator is deleted;
    - the catalogue guards (search_path, FK indexes);
    - no row references the deleted id afterwards (a query over
      `information_schema` FKs);
  - **e2e:** export, then delete, then sign-in fails;
  - **axe:** `/privacy` and the dialogs;
  - run `/audit/popia`, `/audit/account-deletion-completeness`,
    `/audit/data-export-completeness` and `/audit/third-party-data-flows`,
    and fix every finding.
- **Docs to update:** security.md (POPIA section; remove the known gap),
  data-model.md (nullable `created_by`, deletion function), api.md, plan.md
  Phase 7.
- **Acceptance criteria:**
  - the three audits pass;
  - the notice names the responsible party and region;
  - a deleted user leaves no personal data outside backups.
- **Size:** M.
- **Depends on:** WP-1.9; D13 (who the responsible party is). Get a short
  legal read of the notice before launch.

### WP-1.14 AWS bootstrap, `production` environment, region

- **Goal:** the account and the infrastructure exist.
  [infra/README.md § Operator steps](../../infra/README.md#operator-steps)
  1–9a, in order.
- **Changes:** operator work; the developer reviews the plan.
  - **Region (D7):** af-south-1 is recommended.
    - Check that RDS PG17 on t4g.micro is offered there:
      `aws rds describe-orderable-db-instance-options --engine postgres --engine-version 17 --db-instance-class db.t4g.micro --region af-south-1`.
    - If af-south-1: set `budget_monthly_usd ≈ 70` and `dmarc_report_email`
      in `infra-secrets/water-management/prod.tfvars`.
  - Also:
    - request the SES production-access review early (step 8a takes about a
      day);
    - raise the Lambda concurrency quota (step 3);
    - check the SES VPC endpoint service (step 4a);
    - run `templates/scripts/backfill-prod-environment.sh --apply` with the
      operator as required reviewer, then check with
      `gh api …/environments/production --jq '.protection_rules'`;
    - `terraform plan`, reviewed; `apply` only on the operator's go;
    - run `export-tf-vars.sh`.
- **Data model / API / UI:** none.
- **Local-first equivalent:** n/a. Nothing local changes; `pnpm check:infra`
  stays credential-free.
- **Tests:** `pnpm check:infra` (mocked plan); the plan's own
  postconditions (`oidc.tf`).
- **Docs to update:** deployment.md status line and region decision,
  plan.md 6a, followups.md § Blocking releases.
- **Acceptance criteria:**
  - the release preflight passes every check except "a release exists";
  - SES identity shows `SUCCESS`;
  - production access is granted.
- **Size:** S of developer time; 1–2 weeks elapsed.
- **Depends on:** WP-1.7 (public repo, for required reviewers); D7.

### WP-1.15 First release and production smoke

- **Goal:** `backend@0.1.0` then `web@0.1.0` are live, and a scripted smoke
  test proves register → import → run → export in production.
- **Changes:**
  - **Before tagging:** freeze migrations. After this deploy, `001`–`NNN`
    are immutable (CLAUDE.md rule 2); add a line to data-model.md
    § Migrations naming the first deployed migration.
  - **scripts:**
    - `scripts/release/smoke.mjs` (root script `smoke:prod` in the `test`
      group, with a `test:scripts` target check), using a dedicated smoke
      account. It checks `/api/health`, signs in, imports a synthetic
      example `ProjectFile` (from `backend/scripts/examples`) with WP-1.8,
      runs it, downloads `summary.csv`, then deletes the project;
    - the credentials are entered by the operator at run time and never
      stored.
  - Then invite the client's hydrologist, and load the client catchment
    through WP-1.8 **only** once client plan.md Q15 is answered.
- **Data model / API / UI:** none new.
  - Until sign-off (WP-1.25), the results pages show a banner: "Model not
    yet signed off — for the modeller's review only". It is controlled by
    a frontend build constant removed in WP-1.25, and meets the README gate.
- **Local-first equivalent:** `smoke.mjs` runs against
  `http://localhost:3001` by default.
- **Tests:**
  - `node:test` for the smoke script's argument handling
    (`pnpm test:guards`);
  - running it locally against the dev stack.
- **Docs to update:** deployment.md § Releasing (smoke step), plan.md 6c
  acceptance, followups.md.
- **Acceptance criteria:**
  - both releases were approved in `production`;
  - the smoke test passes against `https://water-management.jaredhoward.com`;
  - the health check is green.
- **Size:** S.
- **Depends on:** WP-1.8, WP-1.12, WP-1.13, WP-1.14.

### WP-1.16 Backups, restore drill, monitoring, runbook

- **Goal:** recovery has been proven, failures are noticed, and support tasks
  are written down.
- **Changes:**
  - **Restore drill:**
    - PITR into `water-management-restore-drill` (infra/README.md
      § Database access and recovery);
    - verify row counts through a temporary SSM EC2 instance (remove its
      endpoints straight afterwards);
    - measure RTO (time to a usable instance) and RPO;
    - delete the instance. Record the date, RTO and RPO.
  - **infra:**
    - a Route 53 health check on `/api/health` with an alarm in us-east-1
      to the existing us-east-1 SNS topic (+$0.50/month);
    - a CloudWatch metric filter on the API log group for unhandled errors
      (`level=error`) with an alarm;
    - Terraform tests in `tests/guardrails.tftest.hcl` for both.
  - **docs:** new `docs/runbook.md`:
    - deploy and rollback (links to deployment.md);
    - restore (step by step, with the drill's timings);
    - rotate secrets (links to infra/README.md);
    - SES bounces and complaints;
    - "user locked out" (wait out the lockout, or reset the password);
    - "user lost access to their email" (not possible without DB access:
      the break-glass SSM route, and its cost);
    - each alarm → first action;
    - the incident playbook (links to security.md).
- **Data model / API / UI:** none.
- **Local-first equivalent:** n/a (the health check is production-only; the
  local equivalent is `curl localhost:3001/health`).
- **Tests:** Terraform tests; `pnpm check:infra`.
- **Docs to update:** runbook.md (new), deployment.md § Rollback (drill
  result), infra/README.md (health check), STACK.md "Where to look".
- **Acceptance criteria:**
  - the drill has been done once, with RTO and RPO recorded;
  - stopping the API (reserved concurrency 0 for a minute, operator)
    triggers the health alarm email.
- **Size:** M (mostly operator time).
- **Depends on:** WP-1.15.

### WP-1.17 Instant in-browser preview

> **Worker built (issue #73):** `lib/preview/engine.worker.ts` with its
> runner (`lib/preview/runner.ts`: one request at a time, latest wins, a
> fake-worker-tested protocol) as a second entry of the page build beside the
> calibration worker (`frontend/vite.config.ts` `workerChunks`, so it shares
> the engine chunks). Its first request kind is WP-3.6's single firm yield,
> the Yield panel's preview ([ui.md § Yield](../ui.md#yield-wp-36)). Not
> built yet: `buildModelInput`, `preview.svelte.ts` and the "Preview
> (unsaved)" panel below; they add a `run` request kind to the same worker.

- **Goal:** change a parameter and see its effect before saving. The engine
  already runs in the browser, fast enough on the client catchment for live preview.
- **Changes:**
  - **engine:** move input assembly into a pure
    `buildModelInput(settings, model, seriesByKind)` in
    `packages/engine/src/`, holding the "first series of each kind by name"
    rule now inside `backend/src/runs/execute.ts` `loadModelInput`. The
    backend calls it too, so preview and stored run can't drift.
  - **frontend:**
    - `lib/preview/engine.worker.ts` (a Vite module worker) running
      `runModel`;
    - `lib/preview/preview.svelte.ts`: debounced (300 ms) input from the
      editor (`lib/model/editor.svelte.ts`) plus the unsaved settings form,
      and the series values (`series/valuesCache.ts`);
    - a "Preview (unsaved)" panel on the Settings, Network and Crops tabs,
      reusing `compare/HeadlineDeltas.svelte` with `compareRuns` (preview
      against the latest or pinned run), plus a mini hydrograph.
- **Data model / API:** none. The inputs come from existing GETs.
- **UI:**
  - states: needs a network and a rainfall series (same links as the Run
    button); computing; error (the engine throws, e.g. more than one
    outlet: show the message); stale (inputs changed while computing);
  - viewers can preview too (read-only what-if; nothing is saved);
  - on a phone, the panel collapses to the headline cards.
- **Local-first equivalent:** n/a (browser only).
- **Tests:**
  - **engine:** `buildModelInput` (first-by-name rule, missing kinds); the
    backend `execute.test.ts` still passes through it;
  - **frontend unit:** debounce and stale-drop logic;
  - **e2e:** change `a` on Settings, the preview NSE changes, then Save and
    Run and the stored run equals the preview (same summary);
  - **axe:** the panel (`aria-live="polite"` for the headline).
- **Docs to update:** ui.md (preview panel), architecture.md (engine in a
  Worker), plan.md 1d.
- **Acceptance criteria:**
  - preview and saved run summaries are identical for the same inputs;
  - the UI stays responsive (typing never blocks) on the largest example.
- **Size:** M.
- **Depends on:** – (the bundle budget: the worker chunk carries the engine;
  record any ceiling raise in `check_web_bundle_budget.mjs`'s change log).

### WP-1.18 Automatic calibration

> **Superseded in part by [issue #4](https://github.com/Absence0760/project-water-management/issues/4)**
> (Phases 4–5): the optimiser is **DDS** (not Nelder–Mead), the objectives add
> KGE′, non-parametric KGE, NSE on √Q/log Q and FDC signatures, and it fits the
> GR4J parameters as well as the legacy ones (until engine 1.0.0 removed the
> legacy model, issue #16). Follow the issue where they differ.
> **Engine done (issue #4 phase 4):** `packages/engine/src/calibrate/` (DDS,
> objectives, split-sample and differential split-sample validation, exclusions,
> GR4J, the year-balanced KGE below); [model.md §2.10b](../model.md).
> **UI done (phase 5):** Settings → Flow calibration → Fit automatically, in a
> Web Worker (`frontend/src/lib/calibration/`), on `GET /projects/:id/model-input`;
> Cancel terminates the worker at once. [ui.md § Settings](../ui.md).
> **Done (phase 8, optional WR2012 check):** the user enters the quaternary's
> WR2012 naturalised MAR and monthly means (never bundled); every run compares
> its simulated natural flow with them, scaled to the catchment, with
> deviation flags as run warnings, and calibration can add a soft MAR
> penalty (off by default). `packages/engine/src/reference/wr2012.ts`;
> [model.md §2.10c](../model.md). Each run carries a written explanation
> (`model_run.notes`, 007_run_notes; editable under the WR2012 panel, shown in
> run comparison), and the summary CSV has a WR2012 block with it.

- **Goal:** fit `CalibrationParams` (a, b, rainThresholdMm, summerFactor,
  winterFactor, optionally baseResetRatio and the winter thresholds) to the
  chosen observed record. Today the workbook is tuned by hand.
- **Changes:**
  - **engine (pure):** `packages/engine/src/calibrate/`:
    - `nelderMead.ts`: bounded through a logit/log transform, with
      restarts;
    - `objective.ts`: NSE, KGE, log-NSE, and a **year-balanced KGE** (the
      mean of per-water-year KGE; issue #1 item 5, Fowler 2016/18), all
      honouring the calibration window and exclusions (WP-1.3);
    - `calibrate.ts`: returns the best parameters, the score trace, and
      **validation** stats outside the window (Klemeš split-sample).

    It's deterministic for a seed. It's not a behaviour change to
    `runModel`, so no `ENGINE_VERSION` bump.
  - **frontend:**
    - `lib/calibration/autocal.worker.ts`;
    - "Fit automatically" in Settings → Flow calibration: pick the
      parameters and bounds, the objective, a max-evaluations budget (default
      400; roughly 10–30 s);
    - live progress and Cancel;
    - a result table of current vs fitted parameters and calibration and
      validation stats;
    - "Apply to form" fills the Settings form, and the user saves. Never
      auto-save.
- **Data model / API:** none.
- **UI:**
  - states: no observed series (disabled, with a link to Data); running;
    cancelled; no improvement found;
  - viewers can run it but can't apply;
  - the phone layout stacks the table.
- **Local-first equivalent:** n/a.
- **Tests:**
  - **engine unit:** Nelder–Mead on Rosenbrock; recovery of known `a` and
    `b` on a synthetic catchment generated from them (within 2 %);
  - exclusions respected; bounds never violated;
  - **invariant:** fitted parameters still pass `checkAll`;
  - **e2e:** fit on an example catchment, Apply, the form shows new values,
    Save;
  - **axe:** the dialog and progress (`role="progressbar"`).
- **Docs to update:** model.md §2.10 (objectives, validation), ui.md
  § Settings, planned-work.md row.
- **Acceptance criteria:**
  - on the synthetic catchment it recovers the parameters;
  - on the example catchments, fitted KGE ≥ hand-tuned KGE;
  - Cancel stops within 1 s.
- **Size:** M.
- **Depends on:** WP-1.3, WP-1.17 (the worker plumbing).

### WP-1.19 Operating rules: N4/Q3, Q18, Q5, Q7, Q1

- **Goal:** implement the hydrologist's answers on the small operating-rule
  questions.
- **Status:** Q5, N4/Q3 and Q18 **landed (engine 0.16.0)**
  on persona recommendation, pending the hydrologist: the room cap
  includes the destination's demand, `transfer.priority` with pro rata ties,
  and the source still doesn't irrigate first.
- **Changes:** each item is only if the answer asks for it.
  - **N4/Q3:** in `network/simulate.ts`, cap a transfer at the receiver's
    free space at the start of the day (`cap − Q[t−1]`).
  - **Q18:** the priority between several transfers from one dam: rule
    order (a new `transfer.priority` int) or pro rata. Update the order
    shuffle exemption in `checkOrderInvariance`.
  - **Q5:** irrigation stops at `node.damMinPct` (today only transfers
    respect it); the help text in `lib/help/content.ts` changes too.
    **Landed (engine 0.16.0)** on persona recommendation, pending the
    hydrologist ([audit Q5](../engine-audit.md)); stored values were reset to
    0 in migration 006.
  - ~~**Q7:** Pitman fallback only on days with **no rain value**.~~ Done
    differently: engine 0.10.0 removed the fallback and the Pitman input
    ([audit P1](../engine-audit.md)).
  - ~~**Q1:** rename `pct_upstream_to_dam` → `pct_upstream_bypass`.~~ Not
    needed: the client confirmed the label's meaning (share into the dam), so
    engine 0.9.0 fixed the formula instead and the column name is right.
  - Each landed item bumps `ENGINE_VERSION` (minor).
- **Data model:**
  - `transfer.priority` (if Q18 is "order"), under the existing transfer
    RLS;
  - the Q1 column pair.

  Both in next-free-NNN migrations with grants unchanged (same tables).
- **API:** the `ProjectModel` shape changes (the new fields); `PUT /model`
  validation; api.md.
- **UI:** Transfers tab priority (drag order or number); the Network field
  label; help text.
- **Local-first equivalent:** n/a.
- **Tests:**
  - an engine unit test per rule;
  - invariants (`checkTransferLimits` gains free-space and priority
    properties);
  - `FUZZ_CASES=20000` soak;
  - DB: the migration applies, and the catalogue guards pass;
  - e2e: the transfer priority edit;
  - `diffInputs` lines for the new fields.
- **Docs to update:** model.md §2.6/§2.7/§3 (Q-rows), engine-audit.md
  decisions, data-model.md field mapping, followups.md.
- **Acceptance criteria:**
  - each answered question has a test named after its ID;
  - examples re-run with the changes listed in engine-audit.md § Effect on
    results.
- **Size:** M (all five); each item alone is S.
- **Depends on:** WP-1.1 answers.

### WP-1.20 N1 irrigation application efficiency

- **Goal:** abstraction covers crop need plus losses; return flow is a share
  of the losses.
- **Status: landed (engine 0.16.0)** on persona recommendation, pending the
  hydrologist ([audit N1](../engine-audit.md)): per farm, backfill e = 1 − r
  with β = 1, and `return_flow_pct` dropped in the same migration (006)
  because it was never deployed.
- **Changes:**
  - **engine:** `demand.ts` / `simulate.ts`:
    - abstraction demand = F / e;
    - return = `lossReturnFraction × (1 − e) × G`;
    - reported "supplied %" is against F / e;
    - crop use = e × G.
  - **migration:**
    - `node.irrigation_efficiency` (0 < e ≤ 1, CHECK) and
      `node.loss_return_fraction` (0–1);
    - backfill decision D2-N1: e = 1 − `return_flow_pct` with loss return
      1 (keeps the water balance close to today's), or e = 1 (return 0);
    - later contract `return_flow_pct` once no code reads it. (As built:
      migration 006 backfilled e = 1 − r with loss return 1, and dropped
      `return_flow_pct` in the same file, since it was never deployed.)

    Or per crop, if the hydrologist prefers (then on `crop`).
  - **scripts:** the importer sets the backfill values.
- **Data model:** columns on `node` (existing RLS and same-project triggers
  apply).
- **API:** `NetworkNode` fields; api.md.
- **UI:** the Network table and one-node form (percent display, help tips).
- **Local-first equivalent:** n/a.
- **Tests:**
  - worked example F = 100, e = 0.9 gives G ≈ 111, and crop use = 100;
  - `checkBalance` extended with the loss terms;
  - `checkDoubledCropAreas` re-examined (return flow semantics);
  - soak; DB migration and catalogue guards; e2e field edit.
- **Docs to update:** model.md §2.3/§2.7 (new section), engine-audit.md N1,
  followups.md (the return-flow and curtailment note).
- **Acceptance criteria:** fully supplied means crop use = F; the catchment
  balance closes; `ENGINE_VERSION` is bumped.
- **Size:** M.
- **Depends on:** WP-1.1 (the N1 answer).

### WP-1.21 N2 dam area–volume, evaporation, seepage

- **Goal:** dams lose open-water evaporation and optional seepage.
- **Status: landed (engine 0.16.0)** on persona recommendation, pending the
  hydrologist ([audit N2](../engine-audit.md)). As built: one A-pan-based
  lake factor (0.75), rain on the dam added, seepage joining the outflow, and
  an unknown area *estimated* as capacity ÷ 3 m with warning W6 (not "no
  evaporation"), so existing projects do change.
- **Changes:**
  - **engine:**
    - E = `k_lake(month) × A-pan(month)/days × A(S)`, with
      `A(S) = c·S^b` (or a full-supply area with b = 0.7, Liebe 2005);
    - seepage = `s × S` per day;
    - both are taken before irrigation on the day (order to confirm),
      clamped so storage ≥ 0;
    - new outputs `evaporation` and `seepage` per farm;
    - a new warning W6: a dam without area data has evaporation ignored.
  - **migration:**
    - `node.dam_area_full_m2` (nullable), `node.dam_area_exponent` (default
      0.7) and `node.dam_seepage_per_day` (default 0), with CHECKs;
    - settings `lakeEvapFactor` monthly (default WR90 lake factors, or 0.75
      flat; hydrologist decides).
    - **Pan basis.** The WR90 (Midgley 1994) lake factors are ratios to
      **S-pan** evaporation, but the project's `apanMm` is A-pan. Applying
      them straight to A-pan is wrong. Either convert A-pan to S-pan first
      (the WR90 monthly pan-conversion factors for the evaporation zone),
      or store a single A-pan-based lake factor and label it as such.
      The WR90 values themselves have not been checked yet: read them from
      the WRC report for the catchment's evaporation zone before building.
      This setting is separate from the GR4J `panCoefficient` (A-pan →
      PET for the land surface), and neither setting is calibrated.
  - **scripts:** the importer leaves area null (b023 has none) and prints a
    note.
- **Data model:** `node` columns. Null area means no evaporation, so
  existing projects are unchanged until data is entered.
- **API:** `NetworkNode` fields; new run series keys; api.md.
- **UI:** dam fields in the Network form; evaporation in farm detail; the
  help text.
- **Local-first equivalent:** n/a.
- **Tests:**
  - order-of-magnitude example (100 000 m³, 3 ha, 6 mm/day ≈ 180 m³/day);
  - `checkBalance` includes the loss terms;
  - storage never goes negative;
  - a new invariant: evaporation = 0 when area is null; soak;
  - DB migration and guards; e2e dam-area edit.
- **Docs to update:** model.md (new §2.7a), engine-audit.md N2,
  data-model.md.
- **Acceptance criteria:** summer storage falls with the loss; the balance
  closes; the effect on examples is recorded.
- **Size:** M.
- **Depends on:** WP-1.1 (N2 answer, and which area–volume data exists per
  dam).

### WP-1.22 N3 effective-rain carry-over

- **Goal:** rain offsets demand beyond the day it falls.
- **Status: landed (engine 0.14.0)** on persona recommendation, pending the
  hydrologist ([audit N3](../engine-audit.md)). As built: one mode only, a
  per-farm one-bucket store sized by `settings.effectiveRainStoreMm`
  (default 25 mm; 0 reproduces the workbook), not the three-mode selector or
  a per-node TAW below. A sixth self-check (`soilWater`) guards it. The
  Crops tab says crop factors are × A-pan and flags a factor above 1.0.
- **Changes:**
  - **engine:** `settings.effectiveRainMode: 'daily' | 'monthly' | 'soilWater'`.
    - `monthly`: monthly effective rain against monthly demand (Dastane
      1974), spread per day.
    - `soilWater`: an FAO-56 root-zone bucket per farm, with a new
      `node.root_zone_taw_mm` (migration) and depletion carried day to day.
  - Which modes to build depends on the answer; don't build all three if
    only one is chosen. Also confirm the crop factors are A-pan based (a doc
    note, or a conversion factor setting).
- **Data model:** settings jsonb; `node.root_zone_taw_mm` only for
  `soilWater`.
- **API / UI:** a Settings → Demand mode selector; the TAW field if needed;
  the Crops demand preview reflects the mode.
- **Local-first equivalent:** n/a.
- **Tests:**
  - a 60 mm day offsets several days in carry-over modes;
  - the `daily` mode is unchanged (a regression test);
  - invariants; soak.
- **Docs to update:** model.md §2.3, engine-audit.md N3 and Q6.
- **Acceptance criteria:** the chosen mode gives lower demand after heavy
  rain; the balance closes.
- **Size:** M.
- **Depends on:** WP-1.1 (N3 answer).

### WP-1.23 Q17 EWR shortfall attribution; Q11–Q13 curtailment policy

- **Goal:** farm shortfalls add up to the site's shortfall, and the
  curtailment report says what it means.
- **Status: landed (engine 0.17.0)** on a simulated CMA-assessor
  recommendation, pending the hydrologist and assessor
  ([audit Q11, Q13, Q17](../engine-audit.md), model.md §2.7b, §2.11). As
  built: sites are the outlet plus every gauge; each site's shortfall is
  charged to upstream farms pro rata to net impact (the rest reported as
  natural), a farm under several sites takes the largest charge, split into
  irrigation and storage parts; the old AB stays as "reach shortfall";
  zero-demand farms get no irrigation cut; "Demand left %" is bounded and
  shows "—" below 1 m³/day; the equitable share is labelled a fairness
  benchmark. A seventh self-check covers attribution. Not built: the site
  list in run comparison, a per-gauge "is an EWR site" flag (WP-3.7).
- **Changes:**
  - **engine:**
    - `network/ewr.ts` / `simulate.ts`: attribute each site's shortfall to
      the farms upstream of it pro rata to net impact `(H + I + J) − U`
      (recommended), or assess at gauges only, per the answer;
    - `curtailment.ts`: Q13 (a cut on a farm with no demand) per the answer;
    - `checkReportTotals` gains Σ attributed = site shortfall.
  - **frontend:**
    - `CurtailmentTable.svelte` labels "gain" as a fairness target (Q11);
    - "Demand left %" (Q12) shows "n/a (demand < X m³/day)" for tiny
      demand, instead of extreme values.
- **Data model / API:** `RunSummary` fields unchanged or added (optional,
  for old runs); api.md.
- **UI:** the curtailment table and its help text.
- **Local-first equivalent:** n/a.
- **Tests:**
  - an additivity invariant;
  - a farm that adds water isn't charged;
  - soak;
  - frontend unit for the display thresholds;
  - e2e snapshot of the table's text.
- **Docs to update:** model.md §2.9/§2.11 and §3 (Q11–Q13, Q17),
  engine-audit.md.
- **Acceptance criteria:** additivity holds on every fuzz case; the
  hydrologist accepts the wording.
- **Size:** M.
- **Depends on:** WP-1.1 answers.

### WP-1.24 H1 volume-conserving event response

> **Specified in [issue #4](https://github.com/Absence0760/project-water-management/issues/4)**
> (Phases 1–3, 6–7): the proposed model is **GR4J** (X2 = 0) behind a
> `RunoffModel` interface, with IHACRES-CMD as the benchmark and the legacy
> model kept as the baseline until sign-off. The issue has the equations, the
> invariants and the phase-by-phase acceptance criteria; follow it where it is
> more specific than this section.
>
> **Status:** GR4J is selectable behind `settings.runoffModel` (engine 0.5.0)
> and the default since engine 0.11.0; the setting is `runoffModel`
> (`'legacy' | 'gr4j'`), not the `flowGenerator` named below. **H1 decided**
> (persona recommendation, 2026-09-24; pending the hydrologist): legacy is
> kept unchanged as workbook comparison only, never evidence, and GR4J is the
> model of record ([audit H1](../engine-audit.md)). **Done 2026-09-26:**
> engine 1.0.0 removed the legacy model (issue #4 phase 10, issue #16); GR4J
> is the only runoff model and H1 is closed. Left: IHACRES (issue #4 phase 7)
> only if asked.

- **Goal:** a storm can never return more water than it brought (the legacy
  model could return more than a storm's rain).
- **Status: done (engine 1.0.0, 2026-09-26, issue #16).** GR4J became the
  default in engine 0.11.0 and passes the event-scale invariant; the legacy
  model was labelled workbook comparison only from 2026-09-24 and removed in
  engine 1.0.0 ([audit H1](../engine-audit.md), closed). Stored legacy runs
  keep their badge and CSV label. Recalibration with the hydrologist is
  WP-1.25's.
- **Changes:**
  - **engine:** a new event response in `flow.ts`:
    - event runoff = `C(R, wetness) × R × area` with C ≤ 1;
    - routed through a unit hydrograph or two linear reservoirs;
    - baseflow fed by a recharge fraction into a slow store;
    - candidates are IHACRES or GR4J (engine-audit.md), chosen with the
      hydrologist.

    D3 decides whether it **replaces** the recession reset outright
    (operator policy: no compatibility modes) or sits behind
    `settings.flowGenerator: 'recession' | 'event'` during recalibration.
    The recommendation is the setting: it's temporary and removed in
    WP-1.25 once signed off, so the two calibrations can be compared with
    run comparison. New `CalibrationParams` fields for the new parameters.
  - **frontend:** the Settings → Flow calibration fields for the new
    parameters; auto-calibration (WP-1.18) supports them. Without it,
    recalibrating a new structure by hand would take weeks.
- **Data model:** settings jsonb only.
- **API:** settings validation; api.md.
- **UI:** a parameter group that switches with the generator; help text.
- **Local-first equivalent:** n/a.
- **Tests:**
  - a new invariant `checkEventVolume`: for any single storm on a dry
    catchment, Σ event runoff ≤ rain volume (the W1 guard becomes a hard
    property);
  - runoff coefficient rises with storm depth (a property test);
  - the client catchment regression gets a new named bound (H1);
  - soak `FUZZ_CASES=20000`.
- **Docs to update:** model.md §2.4 (new subsection), engine-audit.md H1,
  model.md §5 (relation to the bucket module).
- **Acceptance criteria:**
  - coefficient ≤ 1 for every fuzz case;
  - after recalibration (WP-1.25), KGE on the calibration record is at least that of the current
    structure, or the hydrologist accepts the difference in writing.
- **Size:** L (3–5 weeks, including the model choice).
- **Depends on:** WP-1.1 (the H1 answer), WP-1.18.

### WP-1.25 Engine release, recalibration, sign-off

- **Status: done for the engine (2026-09-26, engine 1.0.0, issue #16).**
  1.0.0 is the consolidated version: the legacy model is gone, and with it
  D3's temporary switch (`settings.runoffModel` now only records GR4J), migration 064 moved every project to GR4J, the 20 000-case soak
  passed, and the regression suite's final deviation list is recorded
  ([engine-audit.md § Regression suite](../engine-audit.md#regression-suite-deviation-list);
  the end-to-end natural-flow comparison is retired with the record of its
  last, passing run). The operator **waived** the written sign-off and the
  trigger that the hydrologist first review the GR4J results with the Phase 9
  bands (their agreement is assumed, [plan.md](../plan.md) Decisions).
  Recalibrating the client catchment with the hydrologist and pinning that
  baseline happen in their review (WP-1.1), not as a gate on this release.
  The frontend has no "not yet signed off" banner to remove.

- **Goal:** one signed-off engine version that the client's modelling team
  can rely on. This meets the Step 1 → 2 gate.
- **Changes:**
  - **engine:** consolidate the version (e.g. `1.0.0` when signed off);
    remove the temporary `flowGenerator` switch if D3 chose it.
  - Re-run the client catchment regression and record the final deviation list.
  - With the hydrologist: recalibrate the client catchment against its chosen record with auto-fit
    plus a manual review, using the exclusions for unmeasured peaks.
  - Pin the baseline run (WP-1.11); compare it with the 0.4.0 baseline and
    export the comparison for the sign-off record.
  - **frontend:** remove the "not yet signed off" banner (WP-1.15).
- **Data model / API:** none.
- **UI:** the banner goes.
- **Local-first equivalent:** n/a.
- **Tests:** full engine suite with soak; regression on real data; e2e green.
- **Docs to update:**
  - engine-audit.md (every row decided);
  - model.md (header: signed-off version and date);
  - plan.md (questions answered);
  - followups.md § Hydrologist emptied or moved to Step 2;
  - close issues #1 and #2.
- **Acceptance criteria:** a written sign-off from the hydrologist (an email
  or issue comment is enough) naming the engine version and the baseline run.
- **Size:** M.
- **Depends on:** WP-1.19–1.24 (whichever the answers required).

### WP-1.26 Unit preferences

- **Goal:** each user sees flows and volumes in their own units.
- **Changes:**
  - **migration:** none. The preferences document exists since 083
    (`user_preferences`, own row only under RLS; built for the members'
    own sidebar sections, data-model.md § Display preferences).
  - **backend:** a `units` key in `PreferencesPatch`
    (`backend/src/auth/preferences.ts`; zod:
    `units.flow ∈ m3s | m3day | mlday | ls`, `units.volume ∈ mm3a | mla`);
    `PATCH /auth/me { preferences }` and the `user.preferences` in responses
    already exist.
  - **frontend:**
    - `lib/format/units.ts` conversions (one table, unit-tested);
    - applied to headline cards, the per-farm table, charts (axis labels),
      the compare page, curtailment (keep the l/s column) and the EWR
      settings display;
    - inputs keep their stored units;
    - a preferences section on `/account`.
  - Exports stay in canonical units with the unit in each header (D16).
- **Data model:** the column above.
- **API:** as above; api.md.
- **UI:** a unit label always next to the figure; charts re-render on change.
- **Local-first equivalent:** n/a.
- **Tests:**
  - conversion round trips;
  - DB: a user can't set another user's preferences (only `/auth/me`
    exists; the route test);
  - e2e: switch to ML/day and see the headline change;
  - axe on `/account`.
- **Docs to update:** ui.md (units), api.md, data-model.md (`app_user`),
  planned-work.md row.
- **Acceptance criteria:** every output figure follows the preference; CSV
  and `.xlsx` headers state their units.
- **Size:** M.
- **Depends on:** WP-1.9.

### WP-1.27 Run comparison: per-node overlay and leftovers

- **Goal:** overlay the same farm's series (storage, supplied, outflow)
  across two runs, and close the other comparison gaps in followups.md.
- **Changes:**
  - **frontend:**
    - **Built (issue #8):** `compare/CompareOverlay.svelte` replaced
      `CompareChart.svelte`: a node picker matched by id, then name
      (`compare/overlay.ts`, on the engine's `matchByIdThenName`), A vs B
      and B − A, fetched per side from
      `GET /projects/:id/runs/:runId/series?key&nodeId`, listing only keys
      present on both ([run-comparison.md](../run-comparison.md)).
  - **Copies remember sources:**
    - migration: `node.copied_from_node_id uuid NULL`. This is a lineage
      tag with **no FK**, deliberately: the source may be in another
      project or deleted, and a tag reveals nothing;
    - set it in `POST /projects/:id/copy`;
    - `compare.ts` matches on it before the name.
  - **Value change when dates also changed:** add per-water-year hashes to
    the run input snapshot (`seriesHash` per chunk in
    `backend/src/runs/execute.ts`), so `diffInputs` can report changes on
    the shared years. Older runs fall back to the current behaviour.
- **Data model:**
  - one `node` column (existing RLS; no same-project trigger, because it
    isn't a reference);
  - the snapshot shape in jsonb.
- **API:** `RunInputsSnapshot.series[kind].yearHashes?`; api.md.
- **UI:**
  - empty state: "no farm in both runs";
  - on a phone, the picker is above the chart.
- **Local-first equivalent:** n/a.
- **Tests:**
  - **engine:** `compare.test.ts` (lineage match, year-hash diff);
  - **DB:** copy sets the tag; `compare.db.test.ts`;
  - **e2e:** copy a project, rename a farm, compare, and the farm is still
    matched; overlay a node series;
  - **axe:** the compare page.
- **Docs to update:** run-comparison.md (matching rules, diff limits),
  data-model.md, followups.md.
- **Acceptance criteria:** a renamed farm in a copy matches; a corrected
  value in an extended series is reported.
- **Size:** M.
- **Depends on:** WP-1.11 (baseline default).

### WP-1.28 Spreadsheet library and `.xlsx` export

- **Status: landed (2026-09-25, issue #11).** The Runs tab's "Workbook
  (.xlsx)" builds the workbook in `lib/spreadsheet/export/export.worker.ts`
  (SheetJS CE mini build, 87 KB gzip, its own bundle ceiling) from
  `GET …/series/bulk` (api.md § Bulk run series). Two departures from the
  plan below: a farm node of a long run is **not** under the 5 MB cap (dozens
  of columns of daily values), so the bulk route pages by
  day window (one request up to ~17 years, more for a longer run); and daily
  rows are streamed into SheetJS's sheet XML, because SheetJS's cell objects
  for a run that size need several GB; the zip uses the browser's native
  deflate. A long run of a large network builds in a few
  seconds. Open in
  followups.md § Features left half-way: opening a file in Excel by hand.
  CSV values and the workbook are compared cell for cell in
  `e2e/tests/xlsx-export.spec.ts`.
- **Goal:** download a run as a workbook (summary, catchment daily, one
  sheet per farm like b023's element sheets, curtailment, EWR grid, annual
  volumes, warnings, inputs).
- **Library (D8):**
  - (a) SheetJS CE from its CDN tarball (`https://cdn.sheetjs.com/xlsx-<ver>/xlsx-<ver>.tgz`
    as a pinned `package.json` URL dependency; Apache-2.0). The same library
    reads `.xlsm` for WP-1.31, and it supports number formats. This is the
    recommendation.
  - (b) ExcelJS: richer styling, but slow maintenance and a heavier bundle.
  - (c) `write-excel-file` for writing plus SheetJS for reading: two
    libraries.

  Never the npm `xlsx` package (STACK.md).
- **Changes:**
  - **frontend:** `lib/spreadsheet/export.worker.ts` builds the workbook in
    the browser. The browser build **avoids the Lambda 6 MB limit**
    entirely. It's a lazy chunk, so the workspace page isn't affected; add
    a worker ceiling to `check_web_bundle_budget.mjs` and log it.
  - **backend:** `GET /projects/:id/runs/:runId/series/bulk?nodeId=` returns
    every key of one node (well under the 5 MB cap for a typical
    node), so a workbook takes one request per node instead of one per series.
  - Number format per D11: full-precision values, with a display format per
    column.
  - CSP: a module worker from `'self'` passes the current policy (no
    `blob:` workers); verify with `infra/scripts/check-csp.mjs`.
- **Data model:** none.
- **API:** the bulk route (viewer; 404 for non-members); api.md.
- **UI:**
  - `DownloadMenu.svelte` gains "Workbook (.xlsx)" with progress per node
    and Cancel;
  - an error if a fetch fails;
  - the phone layout keeps the same menu.
- **Local-first equivalent:** n/a (browser only).
- **Tests:**
  - **frontend unit:** the workbook structure (sheet names, headers with
    units, cells equal to the series), read back with the same library;
  - **DB:** the bulk route with RLS (a non-member gets 404, with a positive
    control of a member);
  - `routes.test.ts`;
  - **e2e:** download and parse in the test;
  - `pnpm check:bundle`.
- **Docs to update:** api.md § Export, ui.md, STACK.md (the library and how
  it's pinned), security.md (the dependency), followups.md.
- **Acceptance criteria:**
  - the client-catchment-size run downloads as `.xlsx` in under 30 s;
  - values equal the CSV export;
  - Excel opens it without repair prompts.
- **Size:** M.
- **Depends on:** D8, WP-1.10 (number formats).

### WP-1.29 Exports over 5 MB

> **Built (option (a), issue #283, 2026-09-30).** As planned, with two
> departures: the streaming adapter is the app's own
> (`backend/src/http/lambdaStream.ts`, after Hono's `streamHandle`, which
> ends a body that fails partway as if complete), and a CSV is measured
> before it streams, so the `413` at 50 MB still comes before any byte. The
> whole API streams, not a separate export function: see
> [deployment.md § Response streaming](../deployment.md#response-streaming)
> for that choice. The production check (a 12 MB export through CloudFront,
> sign-in after the switch) waits for the first deploy
> ([followups.md](../followups.md)).

- **Goal:** no export fails because of the Lambda buffered 6 MB response.
- **Options (D9):**
  - (a) **Lambda response streaming:** Function URL `invoke_mode =
    "RESPONSE_STREAM"` and Hono's `streamHandle` in `backend/src/lambda.ts`,
    with export routes writing incrementally. No new service. The local
    equivalent is the Node server itself. The soft limit is about 20 MB, and
    bandwidth is throttled past the first 6 MB. It changes the invoke mode
    for **every** route, so `Set-Cookie` and error paths need a
    Lambda-adapter test.
  - (b) **S3 pre-signed URL:**
    - write the file to a new exports bucket (1-day lifecycle, S3 gateway
      endpoint, which is free) and return `302`/`{ url }`;
    - locally, MinIO in docker-compose with `dev:storage:up/down/status/logs`
      and `STORAGE=local` by default;
    - it leaves room for Step 2's run storage in S3 and generated reports.
- **Recommendation:** with WP-1.28 building workbooks in the browser, the
  remaining server exports are single-node CSVs and `export.json`, which fit
  real catchments. Build (a) now, because it's smaller and adds no service.
  Record (b)'s trigger in Step 2: the first server-generated artefact
  (reports) or run storage in S3.
- **Changes (a):**
  - **backend:** streaming CSV writers in `backend/src/export/csv.ts`;
    remove the 5 MB `MAX_EXPORT_BYTES` cap, and keep a sane 50 MB cap;
  - **infra:** `lambda.tf` invoke mode, plus a Terraform test.
- **Data model:** none.
- **API:** unchanged contracts; the `413` threshold moves; api.md.
- **UI:** none.
- **Local-first equivalent:** the Node server streams natively.
- **Tests:**
  - **unit:** a streamed body equals the buffered body;
  - a `streamHandle` adapter test for cookies and error JSON;
  - `export.db.test.ts` over 5 MB with a synthetic long series;
  - Terraform test;
  - post-deploy: the smoke test downloads a large export.
- **Docs to update:** api.md § Export (size cap), deployment.md,
  infra/README.md.
- **Acceptance criteria:** a 12 MB export downloads through CloudFront in
  production; sign-in still works after the mode switch.
- **Size:** S.
- **Depends on:** D9; WP-1.15 (to verify in production).

### WP-1.30 Spreadsheet templates for bulk entry

- **Goal:** fill farms, crops and crop areas in a spreadsheet instead of
  typing every value by hand.
- **Changes:**
  - **frontend:**
    - "Download template" and "Fill from file" on the Network and Crops
      tabs;
    - template columns come from `components/network/fields.ts` and the crop
      grid, with units in the headers;
    - CSV first (reusing `lib/series/csv.ts` parsing), then a multi-sheet
      `.xlsx` through WP-1.28's library;
    - the upload **merges into the in-memory editor model**
      (`lib/model/editor.svelte.ts`) with a diff preview (added, changed,
      unknown names) and then the normal Save bar. No new API.
- **Data model / API:** none. `PUT /model` validates as usual.
- **UI:**
  - the preview lists row errors (unknown farm, value out of range, percent
    written as 0–100 vs 0–1);
  - viewers don't see it;
  - on a phone, download only.
- **Local-first equivalent:** n/a.
- **Tests:**
  - **frontend unit:** template → parse → same model (round trip); error
    rows;
  - **e2e:** fill crop areas from a CSV, then save;
  - **axe:** the preview dialog.
- **Docs to update:** ui.md (Network, Crops), help content.
- **Acceptance criteria:** a template downloaded from a project and uploaded
  unchanged makes no changes.
- **Size:** S.
- **Depends on:** WP-1.28 (for `.xlsx`; the CSV part can land first).

### WP-1.31 In-browser b023 workbook import

- **Status: landed (2026-09-25, issue #11).** **Import b023 workbook** on the
  project list reads the workbook in `lib/spreadsheet/import/import.worker.ts`
  (the TypeScript port and its streaming workbook reader, 25 KB gzip; it
  shipped on SheetJS CE's mini build at 101 KB) and submits through
  `POST /projects/import`;
  the review shows the counts, the importer's notes, the unmapped report
  and the gauge-as-reference option (ui.md § Import a b023 workbook). The
  notes and unmapped report are kept with the project (017_project_import,
  `GET /projects/:id/import-report`) and shown on its Overview's Import
  record (ui.md § Overview). Departures from the plan below:
  - the limits are 150 MB and 250 sheets, not 30 MB (too low for a b023
    workbook with long daily records);
  - `readWorkbook` reads the zip itself and unpacks only the parts the
    importer reads (`zip.ts`, capped and bounds-checked; security.md), since
    SheetJS's reader inflated the whole unpacked workbook first (a lower
    peak memory and a faster read); then a
    streaming reader of its own replaced SheetJS in the import (`xml.ts`,
    `sheet.ts`, `sharedStrings.ts`, `workbookParts.ts`): the read's own
    memory and time lower again, every cell compared with
    the SheetJS reader in the parity tests (followups.md);
  - the import route gives fresh ids in the document's id order, so an
    import runs to the same last bit as its source (found checking the
    acceptance below).

  Acceptance: the client workbook's TypeScript `project.json` equals the
  Python one (`sourceWorkbooks.test.ts`, local), and both, imported through
  the route's code with a run, store identical run summaries (checked
  locally on 2026-09-25); the synthetic parity test runs in CI. Left open:
  profiling in a real browser (followups.md). The two string decodings where
  SheetJS and openpyxl differed now follow openpyxl (issue #22, 2026-09-26).
- **Goal:** upload a b023 `.xlsm` in the UI with no Python, so the client
  can onboard their other catchments.
- **Changes:**
  - **frontend:** `lib/spreadsheet/import.worker.ts`:
    - a TypeScript port of `scripts/wbt-import/extract_project.py` and
      `calibration.py` (about 870 lines of Python) using SheetJS;
    - it outputs a `ProjectFile` plus an **unmapped report** (hand-written
      transfer formulas that don't fit the rule shape, a Specific method
      with no values, M1-style month-list notes). This closes plan.md 1b ⬜;
    - it submits through `POST /projects/import` (WP-1.8).
  - Read-only parsing: never evaluate formulas or macros, only cached cell
    values; limit the file size (e.g. 30 MB) and the sheet count.
  - **scripts:**
    - `scripts/wbt-import/make_synthetic_workbook.py` (openpyxl) generates a
      b023-layout workbook from an **invented** example catchment. It's
      committed, with the Python extractor's JSON output committed as the
      expected result;
    - keep the Python CLI for the regression fixtures
      (`extract_flow_fixture.py`, deleted in engine 1.0.0 with the
      legacy model's `flow.test.ts`; `extract_project.py` still writes the
      rest) (D17).
- **Data model:** none.
- **API:** reuses the import route.
- **UI:**
  - "Import b023 workbook" on the project list;
  - states: parsing (progress per sheet), a review screen (counts, the
    unmapped report, warnings, name), importing, done (link);
  - errors: not a b023 workbook, or an unsupported version;
  - farm names from the file are rendered as text only.
- **Local-first equivalent:** n/a (browser only).
- **Tests:**
  - **frontend unit:** the TypeScript import of the synthetic workbook
    equals the committed Python output;
  - a skip-if-absent parity test against the real workbook in
    `../project-water-management-source/Original/` (it never runs in CI);
  - month-list cases from `test_months.py` are ported;
  - **e2e:** import the synthetic workbook, run, and results appear;
  - **axe:** the review screen;
  - `/audit/xss` (names from files).
- **Docs to update:** `scripts/wbt-import/README.md`, run-locally.md,
  ui.md, plan.md 1b/Phase 3, planned-work.md row, security.md (untrusted
  file parsing).
- **Acceptance criteria:**
  - the real client catchment workbook imports in the browser to a project whose
    run matches the Python-imported one (identical summary);
  - the synthetic parity test is green in CI.
- **Size:** L (3–4 weeks).
- **Depends on:** WP-1.8, WP-1.28.

### WP-1.32 Gap filling for input series

> **Built for the observed flow records 2026-09-28 (engine 1.23.0, issue
> #66), off by default.** Two decisions differ from the plan below: the fill
> is a project setting per record (`settings.flowGapFill`, so a run's
> snapshot reproduces it), not a `time_series.fill` column, and the donor is
> named by kind (the other observed record or the reference gauge), not by
> series id. Rain gaps stay with CR-20's CHIRPS infill (§2.4c).
> Filled days are left out of every statistic unless the setting says
> otherwise. [model.md §2.10i](../model.md).

- **Goal:** fill missing days in a rain or flow series in a way the
  hydrologist chooses and can see, instead of the engine treating gaps as
  zero rain or falling back silently.
- **Changes:**
  - **engine:** a pure `fillGaps(series, method, donor?)` in
    `packages/engine/src/quality.ts` (it already detects gaps and
    flat-lines). Methods:
    - linear interpolation up to a maximum gap length;
    - scaled donor: a neighbouring gauge or rain series scaled by the ratio of
      overlapping means;
    - leave as gap.

    It returns the filled values plus a per-day `filled` mask. This is the
    first per-value flag; Step 4 WP-4.10 generalises it into DWS quality
    codes. (CR-20, engine 0.15.0, already outputs a per-day flag for rain
    filled from CHIRPS, `rain_catchment_missing`; reuse its shape here.) New invariant: filled days never change observed days, and a
    series with no gaps is returned unchanged.
  - **backend + migration:** store the fill choice per series (method, max
    gap, donor series id) in `time_series`. The filled values are derived at
    run time and never overwrite the uploaded ones, so a fill can be undone.
  - **frontend:** a "Fill gaps" action on the Data tab: pick a method, preview
    the filled days shaded on the chart, see the count per year, apply.
- **Data model:** `time_series.fill jsonb null` (method, maxGapDays,
  donorSeriesId). RLS unchanged (same row). The donor must be in the same
  project (same-project trigger).
- **API:** `PUT /projects/:id/series/:seriesId/fill`; the series `GET`
  returns `fill` and the `filled` mask.
- **UI:** empty (no gaps: action hidden), preview, applied (badge "n days
  filled"), editor vs viewer (viewer sees the badge only), phone layout.
- **Local-first equivalent:** n/a (all in-app).
- **Tests:**
  - **engine unit and invariants:** each method, max-gap edges, leap days,
    no-gap identity, observed days untouched;
  - **DB/RLS:** the donor must be in the same project, with a positive
    control;
  - **e2e:** fill a synthetic gap by interpolation, run, and the run warning
    for missing rain is gone;
  - **axe:** the fill dialog.
- **Docs to update:** model.md (inputs), ui.md (Data tab), api.md,
  data-model.md, planned-work.md "Data quality tools".
- **Acceptance criteria:** a hydrologist can fill a gauge gap from a nearby
  gauge, see exactly which days were filled, run, and undo it. Exports mark
  filled days.
- **Size:** M (1–2 weeks).
- **Depends on:** none. Bumps `ENGINE_VERSION` only if runs start using fills
  by default (they don't: fills are opt-in per series).

### WP-1.33 Other water users (towns, unlisted users)

> **Built 2026-09-25 (engine 0.22.0, migration 011), off by default.** As
> specified, with two decisions made pending WP-1.1: a senior user's demand is
> passed down by the farms upstream (fragmented by flow share, like the EWR),
> and senior users are not curtailed for the EWR while junior ones are.
> [model.md §2.7c](../model.md).

- **Goal:** water taken from the river by users that aren't modelled farms
  (a town or municipal scheme, industry, unlisted or unlawful irrigators) is
  accounted for, so the model stops handing that water to the listed farms
  and over-stating their supply and the EWR.
- **Changes:**
  - **engine:** a new node kind `user`: a monthly demand (m³/day per month),
    an optional share returned downstream (treated wastewater), and a
    priority against the farms (before farms by default: a municipal
    allocation is usually senior). It draws from the river at its position in
    the network only, with no dam, crops or rain. New outputs `supplied`,
    `deficit` and `returned` per user node; the gauge and EWR see the flow
    after it.
  - **migration:** `node.kind` gains `'user'`; `node.user_demand_m3_day`
    (12-month array, nullable) and `node.user_return_pct` (default 0), with
    CHECKs.
  - **scripts:** the importer creates none (b023 has no such node).
- **Data model:** `node` columns; RLS unchanged (same table).
- **API:** `NetworkNode` fields; new run series keys; api.md.
- **UI:** "Add other user" in the Network tab and schematic; demand table by
  month; results in farm-style detail.
- **Local-first equivalent:** n/a.
- **Tests:**
  - engine unit: a user above a farm reduces that farm's river supply by
    exactly the user's take; priority order both ways; return share
    reappears downstream the same day;
  - `checkBalance` includes user takes and returns; storage and flow never
    negative;
  - DB migration and guards; e2e add a user node and run.
- **Docs to update:** model.md (new node kind), data-model.md, api.md, ui.md.
- **Acceptance criteria:** the balance closes; with a user node present, the
  outlet flow falls by the net take on days with enough flow.
- **Size:** S.
- **Depends on:** WP-1.1 (does the client catchment have such users; which
  priority rule applies).

### WP-1.34 Groundwater abstraction and base-flow reduction

> **Built 2026-09-25 (engine 0.23.0, migration 012), off by default.** As
> specified, for farms and other users, with a drought-rule trigger
> (`borehole_trigger_pct`) added. The depletion is a lagged linear-reservoir
> draw on the river at the node rather than on the GR4J routing store; why,
> and how double counting is avoided (calibrate with the historical pumping in
> place), is in [model.md §2.7d](../model.md). Audit finding N5.

- **Goal:** borehole pumping is modelled as a supply source for farms and
  as a loss to the river's base flow, instead of being invisible.
  Groundwater is a separate resource with its own licences, but pumping near
  a river lowers the dry-season flow the EWR depends on.
- **Changes:**
  - **engine:**
    - per farm: a borehole capacity (m³/day) and a use rule (none /
      supplemental after dam and river / primary / drought-only below a dam
      storage trigger), taken from the existing node-based design (model.md
      §4);
    - a stream-depletion fraction `d` (0–1) per farm: a share of the pumped
      volume removed from the river's base flow, with an optional lag
      (a first-order store, so depletion keeps going for a while after
      pumping stops);
    - depends on WP-1.24 (a flow model with a base-flow store to take it
      from);
    - new outputs `groundwaterUsed` and `baseflowDepletion` per farm.
  - **migration:** `node.borehole_capacity_m3_day`, `node.borehole_rule`,
    `node.stream_depletion_frac`, `node.stream_depletion_lag_days`, all
    nullable with CHECKs. Null means no boreholes: existing projects are
    unchanged.
- **Data model / API / UI:** node fields; farm form "Groundwater" section;
  farm detail shows groundwater use and the depletion it causes.
- **Local-first equivalent:** n/a.
- **Tests:**
  - engine unit: supplemental use covers only what dam and river can't;
    depletion equals `d` × pumping over a long run (lag conserves volume);
    base flow never goes negative (depletion is clamped and the unmet part
    reported as a warning);
  - `checkBalance` includes groundwater in and depletion out;
  - DB migration and guards; e2e borehole edit.
- **Docs to update:** model.md, engine-audit.md (new finding row: groundwater
  was not modelled), data-model.md, api.md, ui.md.
- **Acceptance criteria:** the balance closes; a farm with boreholes shows
  less deficit and the outlet shows the depletion.
- **Size:** M.
- **Depends on:** WP-1.1 (do boreholes matter in the client catchment; is
  there any data on pumping volumes or aquifer connection), WP-1.24.

### WP-1.35 Land-cover streamflow reductions (invasive plants, forestry)

> **Built 2026-09-25 (engine 0.24.0, migration 013), off by default.** Patches
> carry a low-flow and a MAR reduction per class rather than twelve monthly
> fractions (the low-flow share applies to each day's flow up to the Q75
> natural flow, the MAR share above it). They are part of the model document
> (PUT /model), not separate CRUD routes, so the route inventory is unchanged.
> The panel is in the one-node form. [model.md §2.5a](../model.md).

- **Goal:** the rain-to-flow step accounts for land cover that uses more
  water than the natural vegetation it replaced: invasive alien trees,
  commercial forestry (a declared streamflow reduction activity under the
  National Water Act), and optionally orchards and vineyards. This is the
  basis for "clear the invasive trees and see what the river gets back", a
  question licensing (Step 3) and environmental users ask.
- **Changes:**
  - **engine:** per hydrological unit, a list of land-cover patches (area km²,
    cover class, condensed-cover % for invasives). Each class reduces natural
    runoff by a monthly fraction of the patch's share of the unit (the method
    South Africa's national water resources study uses for afforestation and
    invasive plants), applied to the natural flow before farms take water.
    The reduction is reported as its own series so it is never hidden inside
    calibration. Class defaults come from published tables and are marked
    as defaults; the hydrologist can override them per project.
  - **migration:** a `land_cover` table (project_id, node_id, class, area_km2,
    density_pct, factors jsonb null), with RLS policies, same-project
    trigger, covering FK indexes and `GRANT … TO water_app` in the same file
    (`/safe-migration`).
  - **scenarios:** a what-if "clear class X from area Y" works through the
    existing copy-and-compare flow (run comparison).
- **Data model / API / UI:** new table and CRUD routes (auth-gated, inventory
  test); a "Land cover" panel per farm; the reduction series in results.
- **Local-first equivalent:** n/a (no external data source; tables are
  entered or imported by hand).
- **Tests:**
  - engine unit: zero patches changes nothing; the reduction never exceeds
    natural flow; clearing all patches returns the natural series exactly;
  - DB/RLS: members see, non-members can't (with a positive control);
  - route-auth inventory; e2e add a patch and compare against the copy
    without it.
- **Docs to update:** model.md, data-model.md, api.md, ui.md, security.md
  (new table).
- **Acceptance criteria:** the natural-flow reduction is visible as its own
  series and the clearing scenario reproduces the unreduced run.
- **Size:** M.
- **Depends on:** WP-1.1 (which covers matter in the client catchment, and
  which reduction method the hydrologist accepts), WP-1.24.

## 7. Security, privacy and compliance

- **New trust boundaries:**
  - **Uploaded files parsed in the browser** (the workbook, templates):
    - they run in a Worker;
    - values only, never formulas or macros;
    - size limits;
    - strings rendered as text (no `{@html}`);
    - the server re-validates everything with zod on `PUT /model` and
      `POST /projects/import`.
  - **The import route** takes up to 5 MB of JSON (its own cap; WP-1.8):
    - auth-gated;
    - `bodyLimit`;
    - the existing WAF per-IP rules;
    - atomic transaction.
  - **Account routes** (change password, delete, export):
    - password re-check on delete and change;
    - lockout applies;
    - the dry-run first.
  - **Streaming mode (WP-1.29):** re-test the shared-secret header check and
    cookies under `RESPONSE_STREAM` (done: `backend/src/http/lambdaStream.test.ts`
    runs the app through the streaming adapter).
  - Run `/audit/auth` and `/audit/xss` before each release that adds
    routes; add every new route to `backend/src/routes.test.ts`'s inventory.
- **Personal data (POPIA):**
  - `app_user` (email, display name, preferences);
  - memberships and invites;
  - `created_by` links;
  - logs (IP in CloudFront/WAF logs, if enabled).

  Client model data (farm names, dam sizes) may identify farm owners: treat
  it as personal information in the notice. Hosting region: D7. If it
  isn't af-south-1, the s72 cross-border transfer must be disclosed.
- **Retention:**
  - runs: the cap plus pinned runs;
  - tokens: expiry plus purge;
  - login throttle: 1 day;
  - logs: 30 days;
  - backups: 7 days plus the final snapshot.

  Put the whole list in the privacy notice (WP-1.13).
- **Abuse cases:**
  - locking out another user's address (D12);
  - enumerating through import errors (404 for non-member teams, never
    403);
  - oversized uploads (limits);
  - an auto-calibration CPU burn (client side only; no server cost).
- **Public repo:** the scrub (WP-1.7), the terms guard, synthetic fixtures
  only (the synthetic workbook generator uses invented catchments).
- **Liability:**
  - the "not yet signed off" banner until WP-1.25;
  - the help text states that the model is a decision aid, not advice;
  - formal legal and liability wording is the Step 2 → 3 gate, not Step 1.
- **Compliance review:** before loading client data into production, have
  whoever acts as the responsible party review the privacy notice. If this
  touches the operator's employer's SOC 2 scope, loop in the CISO or
  Security Analyst.

## 8. Cost and operations

| Item | Monthly | Note |
| --- | --- | --- |
| Baseline stack (infra/README.md § Cost) | ≈ $48–52 in af-south-1 (≈ $40 in us-east-1) | RDS t4g.micro, 2 interface endpoints, WAF |
| Route 53 health check (WP-1.16) | +$0.50 | us-east-1 alarm |
| Restore drill (WP-1.16) | one-off, a few dollars | a temporary RDS instance plus SSM endpoints for hours; delete the same day |
| Streaming (WP-1.29a) | ~0 | or (b) S3 exports: cents, and the gateway endpoint is free |
| Browser-side features (preview, auto-cal, `.xlsx`, import) | 0 | no server compute |
| **Budget alarm** | set `budget_monthly_usd ≈ 70` | the default of 50 would fire every month in af-south-1 |

- **Alarms:**
  - existing: Lambda errors, throttles and p95; migrate errors; RDS CPU,
    credits, storage, connections and memory; SES bounce and complaint;
    CloudFront 5xx; budget;
  - new: health check, unhandled-error metric filter.

  Every alarm has a first action in `docs/runbook.md`.
- **Support load:** low (one team). There's no admin UI and no DB access
  path, so the runbook must say which support requests are impossible
  without the break-glass SSM route.
- **Releases:** backend first, then web; expand/contract migrations. Each
  release goes through `/release-readiness`.

## 9. Validation

Personas and audits to run, each writing to `reviews/` (gitignored). Paste
each "Need verdict" here before building the work packages it covers.

| When | Persona / audit | Must conclude |
| --- | --- | --- |
| Before WP-1.17–1.31 | `/persona hydrologist` | Which gaps block moving off the spreadsheet; ranks preview, auto-cal, `.xlsx`, import, templates, units. **Need verdict:** _pending; run against `main` and record here._ |
| After WP-1.25 | `/persona hydrologist` | "Is the hydrology right?" is yes for the signed-off version; no unphysical results on the examples. |
| WP-1.9, 1.31 | `/persona new-user` | A new modeller can import a workbook and run it without help. |
| WP-1.13 | `/persona data-subject`, `/audit/popia`, `/audit/account-deletion-completeness`, `/audit/data-export-completeness`, `/audit/third-party-data-flows` | Export is complete; deletion is complete; the notice matches reality. |
| Before WP-1.15 | `/persona adversary`, `/audit/auth`, `/audit/xss`, `/audit/infra`, `/audit/cost-controls`, `/audit/secrets` | No open high or medium finding. |
| WP-1.10, 1.26 | `/persona international-user`, `/persona accessibility-user` | The number and unit styles read correctly, including with screen readers. |

Questions for the client:

- Q15: may client data be in AWS, and must it be in South Africa? Decides D7.
- Q10/Q11: who needs accounts; open or invite-only sign-up. Decides D12.
- The client-term list for the scrub (WP-1.7), and whether the catchment name
  itself may be public.
- Who is the POPIA responsible party and Information Officer? (D13)
- The thousands separator (D10) and export number format (D11).
- Q17: the hosting budget owner.
- Plan.md Q9: is the current working copy the reference workbook? Are there other
  catchments to use as import test cases (WP-1.31 parity)?

Questions for the hydrologist: the WP-1.1 pack.

## 10. Exit criteria (these open Step 2)

1. **Model signed off.**
   - Issue #1 is closed with the hydrologist's confirmation.
   - Issue #2 is resolved (data fixed or accepted).
   - Every engine-audit.md "Needs hydrologist" row is decided and
     implemented, or explicitly accepted.
   - A written sign-off names the engine version and the pinned baseline run
     (WP-1.25).
2. **Regression on real data.**
   - The client catchment suite passes on the real workbook with a named-finding
     deviation list.
   - The invariant soak (`FUZZ_CASES=20000`) is green on the signed-off
     version.
   - `verify/` is resolved.
3. **Deployed.**
   - `backend@`/`web@` releases are live at
     `https://water-management.jaredhoward.com`, through the `production`
     environment with a required reviewer.
   - The production smoke test passes.
   - The SES sandbox is exited.
   - The repo is public (or on an Enterprise plan) with `CI gate` required.
4. **Operable.**
   - The restore drill is done, with RTO and RPO recorded.
   - The health and error alarms have been tested.
   - `docs/runbook.md` exists.
5. **Compliant.**
   - The privacy notice is live.
   - Account data export and deletion pass their audits.
   - The account policy is decided and implemented.
   - `/audit/all` has no open high or medium finding.
6. **Workflow parity.** The hydrologist persona and the real hydrologist
   agree the app replaces b023 for day-to-day work: `.xlsx` in and out,
   preview, auto-calibration, templates, pinned baselines, per-node compare,
   and units.
7. **In use.** The first client's modelling team has used production for at
   least one real modelling task (e.g. a what-if delivered to their client)
   without falling back to the spreadsheet.

## 11. Open decisions

| # | Decision | Options | Recommendation | Who |
| --- | --- | --- | --- | --- |
| D1 | Calibration record (issue #1) | Which observed flow record the fit scores against, with or without excluded periods | The outlet's own record (already the setting), with exclusions for unmeasured peaks if wanted | Hydrologist |
| D2 | Audit questions H1, N1–N4, Q1, Q3, Q5, Q7, Q11–Q13, Q17, Q18 | Per engine-audit.md | Per engine-audit.md recommendations; N1 backfill e = 1 − `return_flow_pct` | Hydrologist |
| D3 | How H1 lands | Replace outright; temporary `flowGenerator` setting removed at sign-off | Temporary setting, removed in WP-1.25 (keeps "no compat modes" long-term). **Taken that way:** `settings.runoffModel`, GR4J by default since engine 0.11.0, legacy for workbook comparison only (WP-1.24), removed in engine 1.0.0 (WP-1.25, issue #16) | Operator + hydrologist |
| D4 | `verify/` | Delete; rebuild against the audited model | Delete (WP-1.6). **Decided (2026-09-30): rebuild**, as an independent cross-check written from the docs (verify/README.md; phase 1 done, phase 2 in followups.md § Verification) | Operator |
| D5 | GitHub gates | Public repo; GitHub Enterprise (required reviewers on private repos) | Public, after the scrub | Operator |
| D6 | History with client terms | `git filter-repo --replace-text`; publish a fresh squashed repo; accept (if terms are only public facts) | Decide after `git log -S`; a squashed fresh repo is the safest if farm names are in history. **Decided (2026-09):** `filter-repo`, then the repo recreated from the clean history (WP-1.7) | Operator + client |
| D7 | Region | af-south-1; eu-west-1; us-east-1 | af-south-1 (POPIA, latency); budget ≈ $70 | Operator, after client Q15 |
| D8 | Spreadsheet library | SheetJS CE CDN tarball; ExcelJS; write-excel-file + SheetJS | SheetJS CE (one library for read and write) | Operator |
| D9 | Exports over 5 MB | Lambda streaming; S3 pre-signed + MinIO | Streaming now; S3 when Step 2 needs stored artefacts | Operator |
| D10 | Thousands separator | Comma (the old `fmtNum`); narrow no-break space | **Built (issue #76, 2026-09-27): narrow no-break space (U+202F), '.' decimal**, app-wide (`engine/src/format.ts`). The original ask and SA/SI practice; the client or hydrologist may still reverse it | Client / hydrologist |
| D11 | Export number format | Full precision; rounded | CSV full precision; `.xlsx` full values with display formats | Operator + hydrologist |
| D12 | Account policies | Require verified email to sign in (y/n); open, email-first or invite-only sign-up; lockout parameters | Email-first sign-up; keep the lockout; require verification before joining projects (already true) | Client (Q11) + operator |
| D13 | POPIA responsible party | Operator; client; consultancy | Whoever contracts with the users (usually the client); decides the notice and the Information Officer | Client + operator (legal) |
| D14 | Pinned-run cap | 3; 5; 10 | 5 per project | Operator |
| D15 | Calibration exclusions scope | Per project (settings); per series | Per project, applied to the calibration record | Hydrologist |
| D16 | Units scope | Per user; per project; exports follow the preference | Per user for display; exports canonical with units in headers | Hydrologist |
| D17 | Python importer after the TypeScript port | Keep; retire | Keep for regression-fixture extraction only; the TypeScript version is the user path | Operator |

## 12. Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| The hydrologist is slow to answer, or unavailable | High | Sign-off (the gate) slips; A-track WPs idle | One structured session (WP-1.1); B and C tracks proceed meanwhile; "accepted as is" is a valid answer. |
| H1 recalibration gives a worse fit on the available calibration record | Medium | Hydrologist rejects the new structure | Temporary generator switch (D3); year-balanced KGE and split-sample validation (WP-1.18); run comparison of both. |
| Stacked engine changes move every result, and the client loses trust | Medium | Adoption | Pinned 0.4.0 baseline; each change listed in engine-audit.md § Effect on results; one signed-off release (WP-1.25). |
| Client terms found in git history; rewrite disrupts concurrent sessions | Medium | Delays going public | Check early (WP-1.7); stop other sessions and worktrees first; the squashed fresh repo option. |
| af-south-1 lacks something at apply time (RDS pg17 t4g, SES endpoint) | Low | Region change late | Read-only checks before the plan (WP-1.14, infra step 4a). |
| SES production access refused or delayed | Low | No verification or reset emails | Request early; transactional-only use case text is ready (infra step 8a); the operator verifies test addresses meanwhile. |
| Streaming mode breaks cookies or errors in Lambda | Low | Sign-in broken after a deploy | Adapter test; production smoke; rollback by tag (deployment.md § Rollback). |
| SheetJS parsing of real workbooks differs from openpyxl (cached values, dates) | Medium | Wrong imported numbers | Parity test on synthetic and (locally) real workbooks; the review screen before import; server re-validation. |
| Bundle growth (engine worker, SheetJS) | Medium | Slow first load | Lazy worker chunks; budget ceilings with a logged rationale (`check_web_bundle_budget.mjs`). |
| Deleting a project creator breaks `created_by` assumptions | Medium | Deletion fails or orphans | Nullable `created_by` via expand migration; a DB test querying every FK to `app_user`. |
| Single developer, bus factor | High | Stalls | Plans per WP; tests as spec; runbook; path-scoped commits. |
| Clients rely on numbers before sign-off | Medium | Liability | "Not yet signed off" banner until WP-1.25; access by invitation only. |
