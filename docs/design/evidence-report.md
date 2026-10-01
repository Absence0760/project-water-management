# Design: the licensing evidence report

Design spec for [issue #15](https://github.com/Absence0760/project-water-management/issues/15):
what a water-use licence assessor at a CMA needs from a nominated run, in
what order, and how uncertainty and assumptions are shown so the report
can't be gamed. It feeds
[WP-2.15](../roadmap/step-2-shared-catchment.md#wp-215-one-click-pdf-report)
(the report route, extended here with an **evidence mode**, §12) and
[WP-3.14](../roadmap/step-3-licensing.md#wp-314-licence-evidence-pack) /
[WP-3.15](../roadmap/step-3-licensing.md#wp-315-assessor-and-ngo-access-comments-gaming-resistance)
(the issued, hashed pack and its gaming resistance). **Phase C (evidence
mode) is built** (issue #71, 2026-09-29; [ui.md § Evidence report](../ui.md#evidence-report),
[api.md § Evidence report](../api.md#evidence-report)); the issued pack
(WP-3.14) is not yet. Where this spec and the roadmap disagree, this spec is the newer
decision; §12 lists every change it asks of the roadmap.

- **Mock-up:** [Licensing evidence report](https://claude.ai/artifact/3w5pxaf9NpmAKmp9ehRpTM)
  (a private claude.ai page until the operator shares it): two in-app
  boards and the report's six A4 sheets. The same page is committed as
  source in [`evidence-report-prototype/`](./evidence-report-prototype/);
  printing it gives the A4 PDF.
- **Figures:** every number in the mock-up comes from real engine runs
  (0.30.0) of the synthetic **Sandspruit** example catchment
  (`backend/scripts/examples`), with a synthetic Reserve rule table at its
  outlet, and an invented application: Vaalbank raises its dam from
  350 000 to 600 000 m³ and adds 40 ha of maize.
  [`figures.ts`](./evidence-report-prototype/figures.ts) prints them,
  including a 300-member ensemble and the paired band. No client data: the
  repo is public.
- **Personas:** [`persona-licensing-authority`](../../.claude/agents/personas/persona-licensing-authority.md),
  [`persona-licence-applicant`](../../.claude/agents/personas/persona-licence-applicant.md),
  [`persona-environmentalist`](../../.claude/agents/personas/persona-environmentalist.md).
  Their questions shape §1 and §3; running them against the build is part of
  the build's acceptance (§11).
- **Evidence and judgement.** As in
  [calibration-research.md](../calibration-research.md), a claim backed by
  a source is marked **(evidence)** with the source key from
  [§ References](#references); a design choice with no published rule behind
  it is marked **(judgement)**. This is not legal advice; any wording that
  faces a regulator is agreed with the client and their legal adviser
  (roadmap Step 2 D10).

## 1. The job

An assessor has many applications, little time, and must be able to defend
each decision, perhaps at the Water Tribunal. From one report they must be
able to answer, in about **five minutes on page 1** (judgement: the page the
assessor reads before deciding whether to read on):

| # | Assessor's question | Answered by |
| --- | --- | --- |
| Q1 | What does the applicant propose, and did they change anything else? | Page 1 banner; Appendix A.2 (the diff) |
| Q2 | What does it do to the river's Reserve, month by month, not on average? | Page 1 table and "where the river loses most"; § 1 The river |
| Q3 | What does it do to other users downstream? | Page 1 table; § 1 and the downstream rows |
| Q4 | How sure is the model, and is the change bigger than that uncertainty? | Page 1 "Change" column (paired band) and "Worse in"; § 2 Uncertainty |
| Q5 | Can I trust this model here: calibration, WR2012, data? | Page 1 flags; § 3 Model and data |
| Q6 | Is this the run the applicant stands behind, unaltered, and can I reproduce it? | Identity strip; nomination history; Appendix B |

The environmentalist adds one: *does it tell the truth when the river
fails?* That is Q2 read strictly: failures by month and by site, drought
months visible, never averaged away. The applicant's question is the
mirror of Q4 and Q6: a report the authority already trusts, because it runs
on the authority's baseline and hides nothing, gets through faster.

Four rules shape everything else:

1. **Evidence comes only from the nominated run.** The report is built from
   the project's current nominated evidence run and an application run made
   on it, nothing else (§2). No report for an arbitrary pair of runs.
2. **Every change carries its uncertainty, and every band carries its rule.**
   A change is printed as a paired band with the count of parameter sets in
   which it is worse; each band has its decision rule printed on the same
   page (§5).
3. **Absence is printed, never omitted.** Every checklist item (§3) appears.
   When the run can't answer it, the row says "Not assessed" and why. This
   reverses the catchment report's "no placeholders" rule for evidence mode
   only (§4.4).
4. **The report describes; it doesn't decide.** No "approve", no green tick
   on the application, no traffic-light verdict. The s27 decision weighs
   factors the model doesn't hold (evidence: [NWA] s27), and colour that
   reads as a verdict invites the applicant to argue with the colour
   (judgement).

## 2. What the report is built from

| Input | What it is today | Rule in the report |
| --- | --- | --- |
| **Baseline** | The project's current nominated evidence run (`run_nomination`, migration 010): append-only, stamped by the database, never trimmed ([data-model.md](../data-model.md)) | Must be the *current* nomination. Where a publication exists (WP-2.3), the report also says whether the nominated run is the published one, and flags it when they differ |
| **Application** | A scenario run (`model_run.scenario_id`, WP-3.2) whose snapshot records its base run, ops and their classes ([scenarios.md](../scenarios.md)) | Its base run must be the baseline above; same engine version and period; its ops are printed in full with their class |
| **Cited ensemble** | A `run_uncertainty` row on the baseline (migration 014): seed drawn by the database, thresholds stored before any member runs, every start kept ([model.md §2.10e](../model.md#210e-uncertainty-bands-engine--0260-issue-4-phase-9)) | Exactly one, named by id; its thresholds must equal the project's declared thresholds (ask ER3); every other start on the run is listed |
| **Paired band** | A paired `run_uncertainty` row on the application run, re-running the cited ensemble's kept sets ([run-comparison.md](../run-comparison.md)) | Required for every "change" figure that has one |

Two modes share the route and the layout:
- **Application evidence** (the mock-up): baseline + application, as above.
- **Baseline evidence**: the nominated run alone, for the WUA or CMA that
  hosts the baseline to show the model's credibility (§§ 1, 3, 4 and the
  appendices, without the change columns). Judgement: the same pages serve
  the authority's "is the shared baseline fit to assess against?" review.

**Refusal** (board 2 of the mock-up). The evidence mode refuses, with the
failed checks listed and a link to the ordinary catchment report, when: the
baseline isn't the current nomination; the application's base isn't the
baseline; the engine versions or periods differ; the application's runoff
model differs (bands are never pooled across models); or any op is classed
as a **baseline assumption**. An editor may still *preview* a report with
baseline-assumption ops (for a sensitivity test), but then every page
carries the red "Baseline assumptions changed" banner and the report can't
be issued (evidence: roadmap WP-3.15 gaming items 2 and 5; judgement: the
preview exception).

## 3. The assessor's checklist

What an assessor must be able to find, with where it comes from in DWS and
CMA practice and what the app can already produce. **Status:** *built* (the
engine or backend has it now), *partial*, or *ask* (§9).

### 3.1 Regulatory basis

- **What the authority must weigh.** s27 of the National Water Act lists the
  factors, including existing lawful use, efficient and beneficial use, "the
  likely effect of the water use to be authorised on the water resource and
  on other water users", the class and resource quality objectives, and the
  Reserve (evidence: [NWA] s27, s18; [GEOSS] summarises the s27 factors).
- **What the technical report contains.** GN R267's Annexure D gives the
  minimum contents of the technical reports. Its water-management report
  lists, under the present situation, *Evaporation*, *Surface Water
  Hydrology*, *Mean Annual Runoff (MAR)*, *Resource Class … and Reserve*
  and *Surface Water User Survey*, and later an *Assessment of level and
  confidence of information* (evidence: [R267] Annexure D, report 4 items
  4.3–4.10 and 5.21). The technical report is due within 105 days of the
  site meeting, and is checked for acceptance within 10 days (evidence:
  [R267] regs 11, 12).
- **How the Reserve is stated.** A gazetted Reserve gives, per EWR site or
  node, the present ecological state, importance, the recommended
  ecological category (REC) and the EWR as a percentage of natural MAR
  (evidence: [Reserve GN] Table 4.1, e.g. rows of "PES · EIS · REC · nMAR (MCM)
  · EWR (% nMAR)"). The Reserve is determined in eight steps under
  Regulation 810 of 2010 (evidence: [R810]). The requirement is a monthly
  table at assurance points, read at the natural flow's percentile, and
  compliance is judged monthly, with contiguity and magnitude (evidence:
  [Hughes & Hannart 2003], [Pollard 2011], [Riddell 2014]; built as
  [model.md §2.9c](../model.md#29c-ewr-compliance-by-the-reserves-assurance-rules-engine--0210-hydrologist-q6)).
- **What a real submission looks like.** A 2025 consultant hydrology report
  for a proposed instream irrigation dam, submitted to a CMA (evidence:
  [Dabrowski 2025]) is a useful benchmark of current practice. It gives:
  the WR2012/WRSM-Pitman method and its assumptions and limitations; a
  five-statistic calibration table (MAR, mean of logs, SD, log SD, seasonal
  index) against "good fit" guidelines (< 4 %, < 4 %, < 6 %, < 6 %, < 8 %);
  a dam-sizing table of deficit months and assurance of supply per dam size;
  flow-duration curves before and after; the change in MAR at the
  downstream gauge; and a Reserve paragraph. It also shows the risk this
  design guards against: its headline impact is the MAR reduction ("2 %",
  "negligible"), while its own flow-duration analysis finds low- to
  zero-flow conditions rising from about 40 % to 60 % of the time, and the
  Reserve is argued as an annual volume against an unallocated volume
  rather than month by month. Its calibration table shows the seasonal
  index outside its guideline (31 % against < 8 %) while the text says the
  simulation "compared favourably". Judgement: none of this is wrong-doing;
  it is what a free-form report makes easy, and what fixed sections, fixed
  metrics and printed rules make hard.
- **Where no authoritative guidance was found**: a DWS standard for the
  methods, calibration thresholds or uncertainty reporting of a WULA
  hydrology section (the same gap [calibration-research.md](../calibration-research.md#where-no-authoritative-guidance-was-found)
  records). Every threshold in this design is therefore a stated,
  project-level choice, never presented as a DWS rule.

### 3.2 The checklist

| # | The assessor must see | Why (source) | Status in the app | In the report |
| --- | --- | --- | --- | --- |
| C1 | Identity: application, catchment, responsible authority, preparer, signer, status (draft / issued / superseded / withdrawn) | Decision record (evidence: [R267] reg 11; roadmap WP-3.14 item 1) | partial: identity strip built (Phase C: runs, nomination, published run, signers); status WP-3.14 | Page 1 identity strip, every footer |
| C2 | Model and version: runoff model, engine version, git SHA, invariant status, errata | Reproducibility (evidence: roadmap WP-3.13, WP-3.14 item 4) | built: `ENGINE_VERSION`, runoff model per run; `ENGINE_BUILD` is WP-3.13 | Identity strip; Appendix B |
| C3 | The nomination: who nominated the baseline, when, why, and every earlier nomination | Stops picking the kindest model after the fact ([data-model.md](../data-model.md), licensing concern) | built (010) | § 3 Nomination history |
| C4 | What the application changes, each op classed proposal / baseline assumption, and the full input diff | s27 "effect of the use" needs the use isolated (judgement); gaming (evidence: roadmap WP-3.15 items 1–2) | built: ops, classes, `diffInputs` | Page 1 banner; Appendix A.2 |
| C5 | Calibration record: observed record and why, window, exclusions with reasons, fit provenance (objective, seed), in-sample scores (KGE′, NSE, log NSE, PBIAS) with Moriasi ratings and the monthly caveat | Credibility (evidence: [Moriasi 2015]; [Dabrowski 2025] reports fit statistics) | built (model.md §2.10, §2.10b `fitRecord`) | § 3 Calibration record |
| C6 | Validation scores (split sample, dry → wet, independent record) | Out-of-sample skill; short records overfit (evidence: calibration-research.md headline 1) | built: § 3 shows the fit record's validation (`FitProvenance`, ER7), **Not assessed** when the parameters aren't from a stored fit | § 3 |
| C7 | WR2012 comparison: natural MAR against the scaled reference, monthly pattern, flag and the written explanation of a *query* | National reference (evidence: [Bailey & Pitman 2016]; model.md §2.10c) | built | § 3 WR2012 |
| C8 | WR2012 five-statistic table with good-fit bands | Current practice (evidence: [Dabrowski 2025] Table 4; CR-28) | built (CR-28, engine 1.19.0, `summary.calibration.wr2012Fit`): shown in § 3's calibration record | § 3 |
| C9 | EWR site metadata: site, source (gazette notice or desktop), component, unit, REC, EWR % nMAR | How the Reserve is stated (evidence: [Reserve GN]) | built: source, component, unit, EWR % nMAR (computed from the run) and the REC (ER9, the rule table's `category`; *Not given* without one) | § 1 site strip |
| C10 | Reserve compliance by the assurance rules, per site: months met, by month of the year, deficit, longest run, FDC check; baseline and application | Monthly compliance with contiguity (evidence: [Pollard 2011], [Riddell 2014]) | built (§2.9c), per rule-table site | Page 1 row 1; § 1 heat maps, table |
| C11 | Days below the daily EWR (the pragmatic EWR) and the shortfall volume | The app's daily EWR sets curtailment; % of time not met (evidence: CR-29) | built | Page 1 rows 2–3 |
| C12 | MAR and outflow as % of natural MAR, baseline and application | R267 lists MAR; the Reserve is stated in % nMAR (evidence: [R267], [Reserve GN]) | built (means); % nMAR is a division | Page 1 row 4 |
| C13 | Low flows: the change in the flow-duration curve against the EWR curve, in the months that matter | The benchmark's key impact is at low flows (evidence: [Dabrowski 2025] §5.1) | built: the FDC against the EWR curve of the month with the largest change and of the river's driest month (lowest mean natural flow), unbanded (ER5) | § 1 FDC charts |
| C14 | Downstream users: supply and reliability per user, baseline and application, anonymised per Step 3 D2 | s27 "other water users"; R267 user survey (evidence) | partial: supply, days and years fully met built, no band (ER4 rest); anonymising ask ER10 | Page 1 row 6 |
| C15 | The applicant's own assurance of supply | Applicants must show the works meet their need (evidence: [Dabrowski 2025] Table 9; roadmap WP-3.4) | partial: share of demand supplied, over the applicant's own units, no band (ER4 rest) | Page 1 row 5 |
| C16 | Curtailment: the application's EWR charge under the attribution rule, and the rule's name | model.md §2.7b, §2.11 | built | § 1 (application evidence only) |
| C17 | Data-quality flags: forecast days in the window, infilled rain (CHIRPS), zero-rain runs, accumulations, rain-source periods, two-record agreement, double-mass breaks, plausibility checks | "Level and confidence of information" (evidence: [R267] item 5.21); model.md §2.4b–e, §2.10a, §2.10d | built | Page 1 flags; § 3 Data quality |
| C18 | Uncertainty: the cited ensemble, its rule, kept count, coverage of held-out data, every start on the run; baseline bands and the paired change | Equifinality; bands must not be cherry-picked (evidence: [Beven & Binley 2014]; model.md §2.10e) | built, with the declared rule (ER3) and the first cited ensemble | Page 1 change column and rules; § 2 |
| C19 | Settings that drive results: EWR method and tables, attribution rule, calibration window and record, pan coefficient, reporting window, thresholds | Transparency (evidence: roadmap WP-3.14 item 3; licensing persona) | built | Appendix A.1 |
| C20 | Baseline history since the previous publication | Shared baseline moves too (evidence: roadmap WP-3.14 item 7) | built (030_history) | Appendix A.4 |
| C21 | Every run warning, verbatim | Nothing hidden (judgement) | built | Page 1 count; Appendix A.5 |
| C22 | Known limitations, disclaimers, what the report does not cover (dam safety DW793, groundwater, water quality, s27 socio-economic factors) | Liability (evidence: roadmap WP-3.13; [DamSafety]) | WP-3.13 | Page 1 "does not decide"; Appendix B.1, B.3 |
| C23 | Sign-off by a registered natural scientist, bound to a statement hash | Professional responsibility (evidence: roadmap WP-3.13, [SACNASP]) | WP-3.13 | Appendix B.2 |
| C24 | Reproducibility: input series hashes, ops hash, manifest hash and short code, verify link, reproduction bundle, page count | Verify an unaltered, reproducible report (evidence: roadmap WP-3.1, WP-3.14) | partial: series hashes (Appendix A.3) and stored values built; manifest WP-3.14 | Every footer; Appendix A.3, B.4 |
| C25 | Registered water use: each unit's registered volumes (WARMS registrations, licences) against its modelled use per water year, baseline and application; units by name, never the holder (D3) | s27 "existing lawful water uses"; the licence applicant persona asked for a registered-vs-modelled row (judgement) | built (WP-3.10 comparison per run, each run's own volumes; no band) | Page 1 row "Registered vs modelled use" and flag; § 5 |
| C26 | What else is proposed on the baseline: every other submitted or approved application's own change, and their sum | s27 "other water users" (licensing authority persona); a true cumulative run is WP-3.11 | built (`cumulative`, evidence-3): a sum of separate runs, said so, no band | Page 1 row "Other applications on this baseline, summed"; § 4 |

## 4. Information architecture

A one-page summary, then numbered sections in the order the assessor's
questions are asked, then lettered appendices for inputs and verification.
The order is judgement, argued from §1: impacts first (Q2–Q4), because they
decide whether the rest matters; credibility second (Q5), because an
assessor checks it for the impacts they care about; inputs last (Q6), for
the reader who reproduces. The environmentalist's ask, EWR failure per site
and month as the headline, puts the river first among the sections.

### 4.1 Page 1: the summary

Fixed content, in this order (mock-up sheet 1):

1. **Identity strip**: title (the scenario's name), catchment, authority,
   baseline (nomination date, runoff model, period), application (op
   count), engine, preparer, signer, verify code. A "Draft · not issued"
   stamp until WP-3.14 issues it.
2. **The assumption banner**: green "No baseline assumption changed" with
   the op count, or red "Baseline assumptions changed" listing them. Never
   absent.
3. **"Read these first" flags**: every data-quality or credibility
   condition that should change how the table is read: band coverage below
   70 %, forecast days inside the window, plausibility failures, a WR2012
   flag of *note* or worse, a Reserve table's plausibility notes, the
   run-warning count, and any "Not assessed" item from C5–C8. Amber for a
   condition, grey for a count. Judgement: flags go *above* the numbers so
   they are read before them.
4. **What changes, application minus baseline**: one table, fixed rows
   (C10, C11, C11 shortfall, C12, C15, C25, C14), columns *Baseline*,
   *Application*, *Change (paired median, 5–95 %)* with the nominated run's
   own difference beneath, and *Worse in* (k of n sets). One row per EWR
   site when there are several; the outlet first.
5. **Where the river loses most**: the three months of the year with the
   largest paired median change in days below the EWR, with their bands,
   and any month that improves; the longest run of months not met.
6. **This report does not decide**: one sentence on s27 and the other
   reports (C22).
7. **The rules**: R1 (the ensemble's decision rule) and R2 (the paired
   rule), printed in full, verbatim from `ensembleDecisionRule` and
   `summarisePaired`.

**Impact by year class** (planning-outputs R7, issue #53) goes on page 1
after item 4: per dry / normal / wet class, the annual waterfall and the
Reserve months not met, baseline vs application, the verdict from the
months. Built (issue #71 follow-ups): page 1 prints the impact report's
`LicenceImpactBoard` ([ui.md § Report](../ui.md#report),
[model.md §2.14a](../model.md#214a-licence-impact-by-year-class-issue-53-r7-engine-and-report))
from the two runs' daily series, the application named as such. Its
"existing authorised use" is the baseline's use when the baseline is a
full-allocation run (WP-3.10), and the board says so when only one of the
two runs is. The board is computed in the browser, not in the engine's
document: an issued pack (WP-3.14) will need its view model in the
manifest, and that is when it moves into `evidenceReport`.

### 4.2 Sections

| § | Title | Holds | Checklist |
| --- | --- | --- | --- |
| 1 | The river | Per EWR site: the site strip (C9); month × water-year heat maps, baseline and application side by side, changed months outlined; extra days below the EWR by month of the year (paired interval plot); the flow-duration curve against the EWR curve for the month with the largest change and, beside it, the river's driest month; the compliance table; the application's EWR charge (C16) | C9–C13, C16 |
| 2 | Uncertainty | The coverage warning if any; the cited ensemble; the ledger of every start on the baseline; the baseline's bands against the nominated run; the paired bands against zero; R1 and R2 | C18 |
| 3 | Model and data | Calibration record, validation, WR2012 (and the five-statistic table), data-quality checks, the nomination history | C3, C5–C8, C17 |
| 4 | Other users | The downstream table (anonymised), the applicant's own supply and assurance; for a baseline-evidence report, every farm's supply; the other applications on the baseline, each one's own change and their sum | C14, C15, C26 |
| 5 | Registered water use | The allocation mode each run ran with and the band; the over/under-use chart (modelled ÷ registered per whole water year, both runs); whole years above, within and below per unit and source; every water year's volume and use. *Not assessed* when the runs carry no volumes | C25 |
| 6 | The applicant's demand objects | Application only (`evidence-9`): each demand object on the applicant's units, or that the application adds, changes or removes, with its sizing, its source and the note on it, its demand in both runs and its share supplied; the share of that demand by source; *Not assessed* when the applicant has none | – |

§ 5 was added in report version `evidence-2`. Its page-1 row fits the
fixed-rows rule (G6) because it is always printed: the unit-years above a
registered volume, summed, or *Not assessed* with the reason (no volumes in
the runs, none on a unit of theirs, no whole water year). One sum rather
than a row per unit keeps page 1 fixed in length whatever the catchment's
register holds; § 5 and the flag name the units.

**Report version `evidence-3`** (issue #71 follow-ups) added three things.
*The driest month* (`river[].fdcDriestMonth`): the calendar month with the
lowest mean natural flow over its complete months in the baseline. Natural
flow, not the simulated flow or its ratio to the requirement, so it is a
property of the river that neither the requirement's shape nor the
application can move; § 1 plots its FDC beside the largest-change month's,
one plot when they coincide. *The other applications* (`cumulative`): every
other scenario on the baseline that is submitted, or decided with approval,
with its newest run of its current ops, read under the reader's RLS (a
viewer's report lists no submitted application, since only editors read
those; nobody's lists a draft). Each one's own change in days below the
pragmatic EWR and in Reserve months met at the outlet, and their sum over
those run on the baseline's engine, period and runoff model (any other
difference is the application's own ops, which the sum is meant to carry;
past 50 applications nothing is summed, since part of a sum understates). It is a sum of
separate runs, not a combined run: two applications drawing on the same
water can take less together than the sum says, or push the river further,
so the words say so and the row carries no band. A true cumulative run, every
application's ops together, is WP-3.11 (`combineScenarios`). *Its page-1
row* fits G6 the way § 5's does: always printed in an application report,
one row whatever the number of applications (the sum, the names in its
note), *None* in the value's place when there are none the reader can see;
§ 4 lists each. Days below the pragmatic EWR is the row's measure because
every run has it; the Reserve's change is in § 4 beside it.

Report version `evidence-4` (engine 1.33.0) added three fixed page-1 rows and
a § 4 table, each printed whether or not it has anything to show (G6):

- **No-flow days at the outlet**: days the simulated outflow is below 1 L/s
  (0.001 m³/s, the flow a DWS gauge record reads as 0.000), both runs, with
  the longest spell and the paired band ([model.md §2.9e](../model.md#29e-no-flow-days-and-users-served-in-full-while-an-ewr-site-fails-engine--1320-issue-71)).
- **Days below the EWR, first site below the works**: for each proposal op
  that builds or raises storage or abstraction at a node (a farm's or user's
  dam, irrigation, supply, borehole or demand field, a new unit, a crop area,
  a borehole, a transfer's or off-take's source, demand raised on named
  nodes or, without names, on every node of its category; a gauge's own
  fields are not works), the first EWR site downstream of it that is **not the outlet** (a
  gauge marked as an EWR site): the days its daily EWR is not met, with the
  paired band, and the Reserve's months met there when it has a rule table.
  Works sharing a site share its row. Where the river reaches the outlet
  without passing a site, one row names the works with *Not assessed: no EWR
  site between the works and the outlet*, and the assessor's question
  (whether a site closer to the works should be assessed) goes on the
  questions list. Judgement: the outlet is always "downstream", but reading
  it as the site below the works would hide the local effect the
  environmentalist asked about behind the whole catchment's flow; the
  outlet's own rows already say what the outlet sees.
- **Supply bands (ER4 rest)**: *The applicant's own supply* and each other
  user's row carry the paired band on the change in their share of demand
  supplied, with "worse in" (the sets in which it falls); § 4's Change
  column the same.
- **§ 4 Served in full while an EWR site below fails**: per EWR site, the days
  each unit upstream got its whole demand on the site's failing days, both
  runs, and a "read these first" count naming them.

An ensemble stored before engine 1.33.0 has none of these measures: each such
cell prints "no band: the ensemble was stored before engine 1.33.0", and a run
made before it prints the row *Not assessed* with the reason.

Report version `evidence-7` added § 1's **paired change in the FDC check
curve** (ER5 follow-up). The two curve bands on the chart come from the same
parameter sets, so they overlap even when every set moves the curve the same
way. A small table under each FDC plot therefore gives, at each table point,
the paired median change in the application's flow with its 5–95 % range,
the runs' own difference, and the sets in which the application's flow is
lower (`river[].fdcChange`, from `PairedSummary.reserveFdcChange`). Nothing
is tabled when the two runs read the site at different points, units or
components. A pack issued before `evidence-7` keeps its frozen document: no
table, and the caption keeps its warning that overlapping ranges don't mean
no change.

**Report version `evidence-8`** (issue #71 follow-up, before the pilot):
Appendix C's fixed prompts. Until then Appendix C printed the scenario's
description and the run's notes as written, so what an applicant left out
(mitigation, say) was simply absent and an assessor had to notice. Now it
asks three questions of every application (engine `evidence/prompts.ts`,
`APPLICANT_PROMPTS`) and prints each with its answer or *Not given*:

- **Purpose and need**: what the change is for, and why this water is needed
  (what the works serve, why less water or another source would not do).
  Among the factors [NWA] s27 weighs is efficient and beneficial use in the
  public interest, and a WULA's motivation opens with it ([GEOSS]).
- **Mitigation**: what will avoid, reduce or offset the effect on the river
  and other users (releases, a lower take in dry months, a smaller dam, a
  condition accepted). The applicant persona's "shows mitigation, not only
  impact" (§ 10); the report's numbers stay the model's, the words the
  applicant's.
- **Monitoring**: how the effect will be measured once built (what, where,
  how often, by whom, who sees the records), which a licence condition
  would rest on.

Judgement: fixed prompts, not a form per authority, since ER-D1 is still
open; three because they are the parts of a WULA motivation the report's
numbers can't supply, and a short list keeps *Not given* meaningful. The
answers are stored on the scenario (`129_scenario_statement`) and written
where it is edited ([ui.md § Scenarios](../ui.md)), by whoever may change it,
on the description's terms (not frozen by a submission; an issued pack
freezes what it printed, [evidence-pack.md](../evidence-pack.md#what-a-pack-holds)).
The description and run notes stay after them: the description is often the
one line that names the works, and the run notes carry the modeller's reason
next to a WR2012 query. A pack drafted before `evidence-8` says the prompts
aren't part of it.

**Report version `evidence-9`** (issue #259, after engine 1.56.0 gave
demand objects a structured source): § 6, the applicant's demand objects.
The report didn't list them at all, so an application whose change is a
town's or a packhouse's demand showed its effect on the river with nothing
saying how solid the number behind it was. § 6 lists each object on the
applicant's units (their own, or one the application adds) in either run,
by what the application does to it, with the model's sizing, source and
note verbatim, and above the table the same by-source line the run's
demand-objects table prints (the engine's `demandSourceShares`; the run
table's `demandBySource` moved to the engine with it). Page 1 gets a
caution when less than half of that demand is from meter records (the
client's rule puts meter records first: issue #54 Q11), and the checks'
*Expect questions about* names the objects with no source. The notes are
one line of model data each, printed in § 6 only, never on page 1 (G13).
Judgement: a numbered section, not a page-1 row, since it holds a list
whose length is the application's; the caution carries it to page 1. A
pack drafted before `evidence-9` has no `demandObjects`, and its report has
no § 6 at all, rather than a § 6 saying it wasn't part of the pack: the
section is new, not a changed one, so the old pack prints as it did.

**Report version `evidence-10`** (issue #54, #90 Q15 and Q16): two checks
that stop issue on the river abstraction a pack rests on. `pumpCapacity`:
every river pump, other water user and off-take in either run has a
capacity (an uncapped pump is limited only by the river's flow, no basis
for licensing a volume). `protectsEwr`, applications only: the river
abstraction the application's proposals add or change leaves the EWR, or a
hands-off flow, in the river in every month it takes, since under the NWA the Reserve comes first and a new
licence normally carries a hands-off condition. Both read the runs' stored
models (engine `evidence/riverWorks.ts`). Judgement: issue-blocking, not
refusing, so the report still previews and says what to fix; the
baseline's existing users are exempt from the second, because the baseline
is current use and modelling a protection they may not honour would
misstate the river the application is measured against; and nothing gates
a model save or a run, so exploring stays unrestricted. A pack drafted
before `evidence-10` keeps its frozen checks; issuing it checks the live
report, which has both ([evidence-pack.md § What stops issue on the
river](../evidence-pack.md#what-stops-issue-on-the-river)).

**Report version `evidence-12`** (issue #326 A5): § 1 opens with a site
locality map, as a licence application normally carries one. It is drawn
from the project's map features (152 `map_feature`) as they are when the
report is built: the catchment boundary, the applicant's unit (its parcels
and dam, from the application's owned nodes, named), every other unit's
parcels and dams drawn neutrally and never named, rivers, gauges, and the
gauges that are the report's Reserve sites, with a scale bar, a north arrow,
coordinate ticks, a legend, the features' date and source files, and "Base:
the project's map features; no basemap". No tiles: the figure is one SVG the
engine writes (`geo/localityMap.ts`, a local equirectangular projection on
the WGS84 radii), the same bytes in the browser, the server's PDF and
`pnpm reproduce:pack`, so the report names its SHA-256 and a pack's manifest
freezes both. Judgement: in § 1 rather than on page 1, which stays the
change table; a figure, not a section, so the section list doesn't move.
With no map features § 1 says *No locality map: the project has no map
features*; a pack drafted before `evidence-12` says the figure isn't part of
it ([evidence-pack.md § The locality map](../evidence-pack.md#the-locality-map)).
(`evidence-11` is the combined cumulative row's, PR #330.)

In the mock-up §4 is folded into page 1 because Sandspruit's application has
two downstream farms; a catchment with more gets its own page.

### 4.3 Appendices

| | Title | Holds |
| --- | --- | --- |
| A | Inputs and assumptions | A.1 settings that drive results; A.2 the application's ops and the full input diff; A.3 input series (kind, dates, days, SHA-256); A.4 baseline history; A.5 every run warning, verbatim |
| B | Limitations, sign-off and verification | B.1 generated known limitations and errata; B.2 sign-off; B.3 disclaimer (D10); B.4 manifest hash, short code, verify link, in-browser check, reproduction command, page count |
| C | Applicant's statement | The only free text the applicant writes, labelled as theirs (§6 G13): first three fixed prompts, **purpose and need**, **mitigation** and **monitoring**, each with its question and the answer verbatim or *Not given* (report version `evidence-7`); then the scenario description and the run notes, verbatim with author and time |

### 4.4 Table, chart or prose

| Content | Form | Why |
| --- | --- | --- |
| The headline changes | Table | Exact numbers to quote in a decision; one row per measure, same columns (judgement) |
| Reserve compliance over time | Chart: month × year heat map, two grids | Shows *when* it fails and contiguity at a glance; the environmentalist's "not averaged away" (evidence: [Riddell 2014] on contiguity and seasonality) |
| Change by month of the year | Chart: interval plot (dot = median, bar = 5–95 %, zero line) | The shape of the impact across the year, with its uncertainty, without a verdict colour (evidence: [Padilla 2022] on interval encodings) |
| Low flows | Chart: monthly FDC against the EWR curve, log scale | The Reserve's own FDC reading (evidence: [Pollard 2011] Fig. 4) and the benchmark's impact chart ([Dabrowski 2025] Fig. 12) |
| Uncertainty per measure | Table plus a small per-row glyph | Numbers are quotable; the glyph shows where the run and zero sit in the band (judgement) |
| Calibration, WR2012, data quality | Tables | Checklist items, each with a value and a note |
| Rules, "does not decide", flags' meaning | Prose, short | A rule is a sentence; a chart can't carry it |
| Assumptions and diff | Tables | One line per op or setting, class pill |

**Absence** is printed in the table where the value would be, in italic
("Not assessed: one record at the outlet"; "Not computed by engine 0.30.0
(CR-28)"). Evidence mode uses its own section list, so the catchment
report keeps its "no placeholders" rule.

## 5. Uncertainty and "application minus baseline"

The engine already produces what an honest display needs: a behavioural
ensemble with stored thresholds, held-out coverage, a 30-set gate, and a
paired band that cancels the uncertainty both runs share
([model.md §2.10e](../model.md#210e-uncertainty-bands-engine--0260-issue-4-phase-9)).
This section fixes how the report shows it.

**D-U1 Pair every change.** The *Change* column is the paired band
(`summarisePaired`), never the difference of two unpaired bands. Two
unpaired 5–95 % bands overlap even when every parameter set agrees on the
direction of the change (evidence: in the mock-up, the baseline's band on
days below the EWR is 3 125–4 394 days, wider than any plausible change,
while the paired change is +98 days, worse in 71 of 77 sets). Where no
paired band exists for a measure, the cell says "no band"; the report never
fills it with an unpaired difference (judgement).

**D-U2 Always both the run and the band.** Each banded figure prints the
nominated run's value *and* the band: "run: +135 · median +98 (−9 to
+175)". The run alone hides the uncertainty; the band alone lets a reader
quote whichever end suits them, and hides that the run itself can sit off
the median (judgement; the mock-up's run difference, +135 days, is above
the paired median).

**D-U3 Count, don't characterise.** Beside each paired change, "worse in
k of n sets", from `ewrDaysNotMetWorse` / `shortfallWorse` (ask ER4 for the
Reserve rate). No verbal likelihood ("likely", "very likely"): the IPCC
scale maps words to probabilities (evidence: [Mastrandrea 2010]), but a
GLUE band is the range across sets that pass a rule, not a probability
distribution (evidence: [Beven & Binley 2014]), so a calibrated word would
claim more than the method gives (judgement). The page-1 footnote says so:
"A band is the range across those sets under rule R1; it is not a
confidence interval."

**D-U4 The rule beside the band.** R1 and R2 are printed in full on every
page that shows a band (page 1, § 1, § 2), and each band's column header or
caption names its rule. The rule text is the engine's own
(`ensembleDecisionRule`), so the report can't paraphrase it kinder.

**D-U5 Coverage first.** When held-out coverage is below 70 %, an amber
banner opens § 2 ("The bands are too narrow to trust … read every band on
this page as a lower bound") and a page-1 flag repeats it. The mock-up's
synthetic run triggers it (48 % of 1 756 held-out days), which is realistic:
a fitted model's band is often too narrow on data it didn't see. It
doesn't block issue (judgement: blocking would push applicants to loosen
the rule until coverage passes; printing it lets the assessor weigh it).

**D-U6 Gated means gone.** Fewer than 30 kept sets: every band cell reads
"Not enough accepted parameter sets (k of n): no band", and the change
column falls back to the run's difference labelled "no band". The run
itself failing the rule (`referenceAccepted = false`) is a red page-1 flag:
the nominated run is outside its own behavioural set.

**D-U7 Every start is listed.** § 2 lists every `run_uncertainty` row on the
baseline (cancelled, completed, cited) with its date, status and how its
rule differs from the declared one (`diffEnsembleOptions`). With the
database drawing seeds and keeping every start, "ran five, showed one" is
visible on the page (evidence: [data-model.md](../data-model.md), 014).

**D-U8 Visual encoding.** Interval plots (a bar for 5–95 %, a dot for the
median, a tick for the nominated run, a thin zero line), in one neutral hue
(evidence: [Padilla 2022] reviews interval encodings and the
"deterministic construal" error of reading an interval's edges as hard
limits, which the caption's wording counters; judgement: the dot, the tick
and the hue). Direction is read from the sign and from "right of
zero, the application is worse", not from red/green. Each glyph has its own
scale, said in the caption.

**D-U9 Months, not the mean.** The paired band by month of the year is a
chart in § 1, and the three worst months are on page 1. An annual band hides
a dry-season impact behind a wet-season gain (evidence: the mock-up's
November improves by 13 days while May worsens by 29).

## 6. Anti-gaming measures

"Gaming" here means an applicant, or a consultant under pressure, choosing
among legitimate analysis paths after seeing the results: the garden of
forking paths (evidence: [Gelman & Loken 2014]). The defence is to fix the
paths before the result is known, and to print the ones not taken. Each
measure has a test in the build (§11).

| # | Measure | Closes | Mechanism | Status |
| --- | --- | --- | --- | --- |
| G1 | Only the current nominated run, and an application on it | Picking the kindest runoff model, period or baseline | Evidence-mode refusal (§2); nomination history printed | built (board 2) |
| G2 | Every nomination printed, with reasons | Quietly switching the baseline | `run_nomination` append-only | built |
| G3 | Baseline-assumption ops refuse issue and turn every page's banner red | Moving the baseline inside a "proposal" (a pan coefficient, an EWR table) | `classifyOp`; WP-3.15 item 2 | built: red banner and flag, preview only, `issuable` false |
| G4 | One cited ensemble, on the project's declared thresholds; every start listed | Trying seeds or thresholds until the band is kind | DB-drawn seed, kept starts (014); declared rule set (ER3); the *first* complete ensemble on the rule is cited | built |
| G5 | Every change paired, with "worse in k of n" | Quoting the kind end of two overlapping bands | `summarisePaired` | built, Reserve included (`reserve[].worse`), and from engine 1.33.0 each unit's supply, the applicant's own, no-flow days and the EWR site below the works |
| G6 | Fixed rows and sections; absence printed | Leaving out the measure that looks bad | Evidence-mode section list with "Not assessed" | built |
| G7 | Fixed windows: EWR measures over every complete month of the run; a shorter reporting window is shown *beside* the whole run, never instead | Choosing a wet window | Reserve assessment already uses complete months; report rule (judgement) | partial: Reserve rows over every complete month; days-fully-met columns use the reporting window, not shown beside the whole run |
| G8 | Months and sites, not averages; worst months on page 1 | Averaging a dry-season impact away | §2.9c by month; paired by month | built |
| G9 | Data flags above the table | Burying forecast days, infill or plausibility failures in an appendix | Page-1 flags from the run summary | built (each with its direction) |
| G10 | Same engine version, period and runoff model on both runs | Comparing across engine changes | Refusal (§2); WP-3.15 item 5 | built |
| G11 | Hash in every footer; page count in the manifest; in-browser PDF check | Editing or dropping a page of the PDF | WP-3.14 manifest and `/verify` | WP-3.14 |
| G12 | "Draft · not issued" on every page until issued | Submitting a draft as final | WP-3.14 status | partial: the draft stamp on every section head and the footer, and a diagonal print watermark on every page (so a cropped page keeps it); issue WP-3.14 |
| G13 | Applicant free text only in a labelled Appendix C, verbatim with author | A persuasive narrative on page 1 | Layout rule (judgement) | built (Appendix C) |
| G14 | One source for the numbers: the report and the compare page read the same engine outputs | A report that disagrees with the app | Shared code paths; a parity test | built (`evidence/report.test.ts` checks page 1 against `compareRuns`) |
| G15 | No verdict colour; neutral encodings | Arguing with a traffic light | Visual rule (§5 D-U8) | built |
| G16 | The EWR can't be off: a missing rule table is "Not assessed", and a zero table is flagged | Switching the Reserve off | WP-3.15 item 7; §2.9c warnings | built: "Not assessed" row, zero-EWR flag, and a caution flag per site counting the months drier than the table's driest point (the requirement is scaled with the flow there) |

## 7. The mock-up

[Licensing evidence report](https://claude.ai/artifact/3w5pxaf9NpmAKmp9ehRpTM),
source in [`evidence-report-prototype/evidence-report.html`](./evidence-report-prototype/evidence-report.html).

| Board / sheet | Shows |
| --- | --- |
| Board 1 · In-app preview | The route's bar in evidence mode: title, Download draft PDF, Generate PDF (WP-2.15 Phase B), and **Issue** disabled with the reason; the issue checks (nomination, base run, engine, assumptions, river pump capacity and the EWR kept, cited ensemble and paired band, coverage warning, sign-off missing); page thumbnails |
| Board 2 · Refused | A scenario run based on a replaced baseline that also changes the pan coefficient: the two failed checks, and the ways out |
| Sheet 1 · Summary | §4.1 in full, with the mock-up's figures |
| Sheet 2 · The river | Site strip ("Class, REC, EWR % nMAR: not given for this site"), the two heat maps with 3 months lost and 1 gained outlined, the paired by-month plot, the May FDC against the EWR curve, the compliance table, R2 |
| Sheet 3 · Uncertainty | Coverage banner (48 %), the cited ensemble, the ledger of starts, baseline bands, paired bands with glyphs, R1 and R2 |
| Sheet 4 · Model and data | Calibration (validation "Not assessed": Sandspruit's parameters aren't from a stored fit), WR2012 ("note", five-statistic table not computed), data quality (10 forecast days; plausibility fails in 2 of 14 years), nomination history |
| Sheet 5 · Appendix A | Settings, the two ops, series SHA-256s, baseline history, warnings verbatim |
| Sheet 6 · Appendix B | Limitations sample, unsigned sign-off block, D10 placeholder, verification |

What the figures say, from `figures.ts` (seed 4242, 300 sets, 77 kept):
Reserve compliance at the outlet 66 → 64 of 180 months (paired −1.7 pp,
−3.9 to 0.0); days below the EWR 3 937 → 4 072 (paired +98, −9 to +175,
worse in 71 of 77); shortfall +0.56 Mm³ (+0.38 to +0.84, worse in 77 of
77); outflow MAR 1.352 → 1.208 Mm³/a (23.7 → 21.2 % of nMAR); Vaalbank's
own supply 72.9 → 69.9 % of demand. The applicant's own supply falls
because the added maize raises demand more than the bigger dam adds; the
two downstream farms' supply rises slightly (+0.2 and +0.7 pp), which an
assessor would ask about. Both are engine results, left as they are: a mock-up
whose figures tell only a tidy story would hide what the layout must cope
with (the farmer view's lesson, [farmer-view.md §11](./farmer-view.md#11-testing) F3).

## 8. Accessibility and print

- The on-screen report meets WCAG 2.2 AA like the rest of the app (axe in
  the e2e). Colour is never the only cue: heat-map cells differ in fill *and*
  the changed ones in outline; the FDC lines differ in dash; the interval
  plots carry their numbers in the table beside them.
- The print is always light (as `report/printTheme.ts` does today), A4,
  with the footer on every page. Minimum printed size 6.8 pt for footers
  and labels, 9 pt for body text (judgement: legible on an A4 printout).
- Every chart has a `<title>` summary for screen readers, and each has a
  table with the same numbers (the paired by-month values go in the CSV
  export if not printed).

## 9. Asks of the engine, the backend and the frontend

Nothing here changes `runModel`'s results.

| # | Ask | Why | Where it lands |
| --- | --- | --- | --- |
| ER1 | The render session may read a **second run** (the baseline, for an application report) and its uncertainty rows: `RenderScope` becomes `{ projectId, runIds[] }`, the runs named by the job | Today `reports/scope.ts` allows exactly one run, so the headless render of an evidence report would be refused | WP-2.15 Phase C (§12) |
| ER2 | **Evidence mode** on the report route: its own section list (`report/sections.ts`), the refusal checks, page 1, flags, "Not assessed" rows, footers with page x of y, Appendix C | §§2, 4, 6 | WP-2.15 Phase C |
| ER3 | A **declared uncertainty rule set** per project (thresholds, members, bounds), fixed before results are seen and versioned like settings; a cited ensemble must match it | G4; followups "Automated calibration with pre-declared rules" is the same idea for fits | WP-2.15 Phase C (the setting); the fit-side rule set stays its own follow-up |
| ER4 | `summarisePaired` adds the worse-share for the Reserve rate per site, and paired bands on each farm's share of demand supplied and on the FDC-check rate | D-U3; C14, C15 rows have no band today | Built: the Reserve share (Phase C); each unit's supply and the applicant's own (engine 1.33.0). The FDC check is banded as its curve (ER5), not as a rate |
| ER5 | Banded Reserve FDC check (monthly m³/s, the rule-table reading), so the FDC chart can carry a band | The ensemble's FDC bands are daily m³/day against the pragmatic EWR, a different quantity; they can't share the chart | Built (engine 1.33.0): the impacted curve at the table's points per site and month in each member (`reserveFdc`); § 1's chart shades the baseline's band (R1) and hatches the application's own (R2); from `evidence-7` the paired change in the curve at each table point, with "worse in k of n" (the sets in which the application's flow is lower), is a table under the chart (`PairedSummary.reserveFdcChange`, `EvidenceSite.fdcChange`), since the two bands overlap even when every pair shifts the curve the same way |
| ER6 | The WR2012 five-statistic table (CR-28) | C8 | Built as CR-28 (engine 1.19.0); the report shows it in § 3's calibration record |
| ER7 | Report the fit record's validation scores, and "Not assessed" with the reason when the parameters aren't from a stored fit | C6 | Phase C (frontend only) |
| ER8 | Assurance of supply metrics per farm (time-based, volumetric, annual) | C15 | WP-3.4, unchanged |
| ER9 | EWR site metadata on the rule table: `category` (REC), `reference` (gazette notice), and the EWR as % nMAR computed from the run | C9 | Built: `category` on `EwrRuleTable` (A–F or a band like B/C; a settings field, no migration, a label no result depends on) and the EWR % nMAR; the gazette notice is the table's `source`, so no separate `reference` |
| ER10 | Anonymised downstream users in the report, per Step 3 D2 | C14; farm confidentiality (Step 2 D1) | WP-3.3 decides; Phase C shows all farms to viewers who can already see them |
| ER11 | The manifest, its hash on every footer, the page count, `/verify` | G11, C24 | WP-3.14, unchanged |

## 10. What this design changes from the roadmap's pack contents

- WP-3.14's contents (§ "Contents") are kept, reordered by §4, and
  extended with: the "read these first" flags; the nomination history; the
  cited ensemble with the ledger of starts; the paired change column with
  "worse in"; the printed rules; "Not assessed" rows; Appendix C.
- WP-3.14 builds the pack's HTML view on `routes/projects/[id]/packs/[packId]`.
  This spec puts the *layout* on the existing report route first (Phase C),
  so the pack route renders the same components from its frozen manifest
  rather than a second layout (judgement: one layout, as WP-2.15 already
  chose one chart implementation).
- WP-3.15 gaming items 1–8 are kept; G1, G4–G9 and G13–G16 are added.

## 11. Testing

**Before the build (run 2026-09-29, issue #71).** The three personas
(`persona-licensing-authority`, `persona-licence-applicant`,
`persona-environmentalist`) reviewed this spec and the mock-up, each with its
task: the assessor decides in five minutes whether to read on and finds the
flag that should change the reading; the applicant finds what would draw a
request for information; the environmentalist finds the worst month and
whether anything hides it. Their full notes are local (`reviews/`, not
committed); persona answers are drafts for the real people, not decisions.

| Persona | Verdict | Adopt if … |
| --- | --- | --- |
| Licensing authority | Adopt if … | page 1 says whose baseline this is; the modelled works are tied to what the WULA applies for, and every application run on the baseline is listed; each flag says which way it biases the table, worst first |
| Licence applicant | Adopt if … | the report says before submission which rows will draw questions and how to fix each; it shows assurance of supply and mitigation, not only impact; page 1's numbers don't contradict each other |
| Environmentalist | Adopt if … | the Reserve view shows depth of failure and the worst year; the Reserve is assessed where the works act and can't be dropped silently; the Reserve row carries "worse in k of n" and a no-flow row |

Built in Phase C from these findings: the baseline's provenance on page 1
(nominated by whom, and whether it is the published run); the ledger of every
application run on the baseline (Appendix A.6); each flag's direction, red
before caution before counts; "Expect questions about" on board 1; each
measure's basis (pragmatic EWR or the Reserve's rule table) printed on its
row; the Reserve heat maps shaded by the share of the requirement delivered,
failure the heavier mark, with the worst month-year on page 1; the Reserve
row's "worse in k of n" (`summarisePaired` `reserve[].worse`, ER4 part);
outflow as % of natural MAR and its relative change; the natural-MAR and
WR2012 flags saying which way they move the requirement; the cited ensemble
fixed as the *first* on the declared rule, so seeds can't be re-rolled.
Left, each tracked in [followups.md § Evidence report](../followups.md#evidence-report-issue-71):
the applied-for works against the modelled ones (a WULA reference), labelled
mitigation alternatives, EWR rows below each storage or abstraction op, a
no-flow row, a flag for flows below the table's lowest point, the days a user
is served in full while the site fails, Appendix C's fixed prompts, and paired
bands on each unit's supply (ER4 rest). Built since, in the follow-ups: the
driest month's FDC, the other applications on the baseline with their sum,
the diagonal draft stamp, the licence impact by year class on page 1 and
Appendix C's fixed prompts (`evidence-7`, § 4.3); and
for cancelled ensembles, the finding that nothing interim is stored (a
started row holds no summary or result, `run_uncertainty`'s check), which the
ledger now says.

**With the build** (Phase C, §12):
- Unit (frontend): the evidence section list is fixed and complete for
  every run shape (a run without a rule table, a gated ensemble, no fit
  record), with "Not assessed" rows where the catchment report would omit;
  the refusal checks, each with a positive control.
- Unit (backend): `scopeAllows` for a two-run scope refuses a third run
  (positive control: both named runs are allowed).
- Parity (G14): for the seeded example application, every page-1 number
  equals the compare page's value for the same pair.
- e2e: open the evidence report for a seeded nominated run and a scenario
  run on it, wait for `data-report-ready`, `page.pdf()` succeeds, every
  section heading and page-1 row is present, the footer says "Page 1 of N";
  a scenario run on another base shows the refusal; a baseline-assumption
  preview shows the red banner and no Issue.
- axe: the evidence report on screen, light and dark.
- Persona re-run after the build; the acceptance is a "Need verdict" of at
  least *Adopt if…* from the licensing authority and the environmentalist,
  with no gaming path the report misses.

## 12. Changes to the roadmap: the WP-2.15 build plan

**WP-2.15 gains Phase C, "Evidence mode"** (M, about 2 weeks; depends on
Phase A and B, built; the scenarios Stage D UI is not needed, since
scenario runs exist through the API):

1. Engine: ER4 (paired shares and supply bands), with unit tests; ER5 if
   cheap.
2. Settings: ER3 declared uncertainty rule set and ER9 rule-table metadata
   (settings fields, zod, Settings form, `diffInputs` lines so a change to
   either is a baseline assumption).
3. Frontend: `?evidence` on `/projects/:id/report?run=<applicationRun>`
   (or the nominated run alone for baseline evidence); the refusal (board
   2); the evidence section list in `report/sections.ts`
   (`ReportSectionId` gains `summary`, `river`, `uncertainty`,
   `credibility`, `users`, `appendixInputs`, `appendixVerify`,
   `applicantStatement`); page 1; the charts (heat-map pair, paired
   interval plot, FDC); footers with page numbers; ER7.
4. Backend: ER1 (the render scope takes the runs a job names; the job
   records both runs); `POST /projects/:id/reports` accepts `{ runId,
   evidence: true }`.
5. Tests and docs as §11; ui.md § Report, api.md, security.md § Render
   tokens, architecture.md.

What Phase C does *not* do: issue, hash, sign or verify. The PDF says
"Draft · not issued" on every page until WP-3.13 (sign-off) and WP-3.14
(manifest, issue, `/verify`) land; then the pack route renders the Phase C
layout from the frozen manifest.

**Built (2026-09-29, issue #71).** Landed:
- Engine: `evidence/` (`evidenceReport`, `evidenceChecks`, `citedEnsemble`,
  `citedPaired`, the flags, rows with basis labels, `BAND_FOOTNOTE`,
  `NO_BAND`); the declared rule (`uncertainty/options.ts`
  `DeclaredUncertaintyRule`, with its check, text, mismatches and request);
  ER4 in part (`summarisePaired` `reserve[].worse`); the settings diff line
  "Declared uncertainty rule (evidence)".
- Settings: ER3 as `settings.evidenceUncertaintyRule` (Settings › Evidence).
- Backend: `GET /projects/:id/runs/:runId/evidence-report`
  (`backend/src/evidence/report.ts`), viewer and up, one read-only
  transaction.
- Frontend: ER2 as `?evidence` on the report route (boards 1 and 2, page 1,
  sections 1–4, Appendices A–C, the heat maps, the paired by-month plot, the
  FDC chart, the draft stamp); ER7 through `FitProvenance`; the links from
  the Runs tab and the scenario comparison.
- § 5 Registered water use (C25, report version `evidence-2`): each run's
  own allocations compared per unit and water year
  (`backend/src/allocations/runUse.ts`), the over/under-use chart
  (`UsePlot`), the page-1 row *Registered vs modelled use* and its flag
  ([allocations.md § In the evidence report](../allocations.md#in-the-evidence-report)).
- The evidence measures (report version `evidence-4`, engine 1.33.0, §4.2):
  no-flow days, the EWR site below the works, users served in full while a
  site fails, ER4's supply bands and ER5's banded FDC.

Not built, or changed:
- **ER1 avoided.** One run-scoped endpoint returns the whole document, the
  baseline read inside it under the reader's RLS, so no render scope needs
  two runs. It returns when the server PDF does.
- `POST /projects/:id/reports` with `evidence: true` is not built: the
  evidence report prints from the browser only. The server-rendered PDF
  comes with the issued pack (WP-3.14).
- Page numbers ("page x of y") in the footer: the browser print has none;
  they come with the server render.

**WP-3.14:** contents per §10; renders the Phase C components.
**WP-3.15:** gaming items G1–G16 (§6), each with its named test.
**Step 2 D9** (server PDFs) is already answered by Phase B being built.

## 13. Open decisions and questions for the client

| # | Question | Proposal | Who decides |
| --- | --- | --- | --- |
| ER-D1 | Does the pilot CMA want page 1 as designed (a change table with bands), or a fixed form of its own? | Show this mock-up to the pilot CMA before Phase C | Client, with the pilot CMA (Step 3 §9 Q1) |
| ER-D2 | Which Reserve determination applies at each EWR site (gazetted notice, desktop), with its REC and % nMAR? | Enter them as ER9 metadata (the rule table's REC field, built); "Not given" until then | Client's hydrologist (Step 3 §9 Q2) |
| ER-D3 | The project's declared uncertainty thresholds (KGE′ ≥ 0.5, WR2012 up to *query*, low-flow bias ±50 %, 300 sets, ±0.1 pan) | Confirm or replace, then fix them as ER3 before any application | Hydrologist + authority (plan.md Q18) |
| ER-D4 | Does a coverage warning block issue? | No: print it on page 1 and § 2 (§5 D-U5) | Authority |
| ER-D5 | Does the authority expect monthly WRYM-style results alongside the daily model? | Add a monthly aggregation appendix if asked | Authority (Step 3 §9 Q5) |
| ER-D6 | Are downstream users named, anonymised or aggregated in a report an applicant holds? | Anonymised by default (Step 3 D2 (a)) | Client + legal adviser |
| ER-D7 | The disclaimer and "does not decide" wording | Placeholders marked [D10] | Client (legal), Step 2 D10 |
| ER-D8 | Is "worse in k of n sets" understood by assessors, or do they want a percentage? | Both: "71 of 77 sets (92 %)" if the pilot asks | Pilot CMA |

## References

- [NWA] National Water Act 36 of 1998, s18 (the Reserve), s27 (factors for
  licences), s41. https://www.dws.gov.za/iwqs/nwa/tmp_Chapter_4.html ;
  https://www.saflii.org/za/legis/consol_act/nwa1998161/
- [GEOSS] GEOSS South Africa, "The National Water Act: the importance of
  section 27". https://geoss.co.za/the-national-water-act-why-the-motivation-for-a-water-use-license-is-so-important/
- [R267] GN R267, GG 40713, 24 March 2017, Regulations regarding the
  procedural requirements for water use licence applications and appeals:
  regs 11 and 12; Annexure D, report 4 (items 4.3 Evaporation, 4.6 Surface
  Water Hydrology, 4.8 MAR, 4.9 Resource class … and Reserve, 4.10 Surface
  Water User Survey, 5.21 Assessment of level and confidence of
  information). Read 2026-09-26.
  https://www.gov.za/sites/default/files/gcis_document/201703/40713rg10701gon267.pdf
- [R810] Regulation 810, GG 33541, 17 September 2010: procedures for
  classes, the Reserve and RQOs (as summarised by DWS).
  https://www.dws.gov.za/wem/RR.aspx
- [Reserve GN] A gazetted Reserve determination (a 2022 Government Notice),
  read as an example of the form: its Table 4.1, EWR sites and nodes with
  PES, EIS, REC, nMAR and EWR % nMAR. Read 2026-09-26; the notice itself is
  cited in the private source repo.
- [Dabrowski 2025] Hydrological assessment for a proposed instream dam,
  Confluent Environmental (appendix to a water-use licence application),
  April 2025: §3.2 assumptions and limitations, Table 4 (five statistics
  and good-fit guidelines), Table 9 (assurance by dam size), Fig. 12 and
  §5 (downstream impact, Reserve). Read 2026-09-26.
  https://confluent.co.za/wp-content/uploads/2025/06/Appendix-2_OGF_Hydrology.pdf
- [Bailey & Pitman 2016] WR2012, WRC TT 683/16 (as cited in
  calibration-research.md; primary not reopened).
- [Hughes & Hannart 2003], [Pollard 2011], [Riddell 2014], [Moriasi 2015],
  [Beven & Binley 2014]: full entries in
  [calibration-research.md § References](../calibration-research.md#references).
- [Mastrandrea 2010] Mastrandrea et al., Guidance note for lead authors of
  the IPCC AR5 on consistent treatment of uncertainties.
  https://www.ipcc.ch/site/assets/uploads/2017/08/AR5_Uncertainty_Guidance_Note.pdf
- [Padilla 2022] Padilla, Kay & Hullman, "Uncertainty visualization", in
  *Computational Statistics in Data Science*, Wiley, 405–421.
  http://space.ucmerced.edu/Downloads/publications/Uncertainty_Visualization_Padilla_Kay_Hullman_2022.pdf
- [Gelman & Loken 2014] "The statistical crisis in science" (the garden of
  forking paths), *American Scientist* 102(6); working paper
  https://sites.stat.columbia.edu/gelman/research/unpublished/p_hacking.pdf
- [DamSafety], [SACNASP]: as listed in
  [step-3-licensing.md § References](../roadmap/step-3-licensing.md#references).
