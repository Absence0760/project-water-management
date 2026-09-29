# Calibration research: best practice and what the app should change

A literature and practice review (2026-09-24) of how the app calibrates its
runoff models, builds and uses the recession curve, handles uncertain data, and
reports to a hydrologist or a licensing authority. It addresses common
calibration problems: a flow record too short or too uniform to represent
the long term, fitted parameters that the record can't pin down, and validation scores that can
fall well below the fit. No client numbers, names or results are recorded
here, because the repo is public. Client results are in the gitignored
`data/client-catchment/*.md`.

**Method.** Four literature reviews, one per question: calibration under
equifinality, recession analysis, South African practice, and observation
uncertainty. Each searched primary sources: journal papers, WRC reports,
gazettes, and one published consultant hydrology report. Sources that were
opened and checked are listed as verified in [§ References](#references).
Some are cited from their standard references without being reopened, and they
are marked. Check those before quoting them in a client document.

**Status.** These are recommendations, not decisions. Items the hydrologist
must decide are marked as such. Tracked work is in
[followups.md § Calibration research](./followups.md#calibration-research-2026-09-24).

## Headline findings

1. **When a fit is poorly constrained, look at the record before the
   optimiser.** DDS with 1 500 runs is adequate for 3–5 parameters (Tolson &
   Shoemaker 2007; Arsenault et al. 2014). A flat X1/X3 ridge is an
   identifiability problem: a stronger
   optimiser would only return an arbitrary point on the ridge more precisely.
   A large drop from calibration to dry→wet validation is what the literature
   predicts for a record with little variety (Perrin et al. 2007; Coron et al.
   2012; Fowler et al. 2016, 2020). It is not a code defect.
2. **Report a range, not one parameter set.** Both the international
   literature (GLUE and limits of acceptability: Beven 2006; Beven & Binley
   2014) and South African practice (Kapangaziwiri, Hughes & Wagener 2012;
   Hughes 2013) keep an ensemble of acceptable ("behavioural") parameter sets
   and carry it through to the decision. The app fits one best set. Showing
   that EWR compliance barely moves across the ensemble would be the strongest
   evidence the app could give a regulator.
3. **The workbook's recession model is defensible as a description but not as
   it is built and used.** A daily factor k(Q) read off one master recession
   curve is established practice (Tallaksen 1995; Lamb & Beven 1997; McMahon
   et al. 2026). The workbook's version has four problems:
   - the curve is spliced together by hand and never re-derived;
   - it pools recessions from the extrapolated part of the rating and from
     periods affected by abstraction;
   - a new pulse starts at an index set by the size of the event rather than by
     the catchment's state;
   - the base-flow reset creates water ([engine-audit H1](./engine-audit.md)).

   Read as a storage–discharge relation (Kirchner 2009), the table can become a
   mass-conserving store.
4. **The low flows decide the EWR, and they are the least certain data.**
   - Rating errors are largest for extrapolated high flows and for low flows:
     41–200 % for extrapolated peaks (Kiang et al. 2018), and 20–397 % for low
     flows (Coxon et al. 2015).
   - CHIRPS is poor day by day in South Africa, especially for winter frontal
     rain, but reasonable month by month (Du Plessis & Kibii 2021).
   - Zero-coded missing rain distorts parameters (Hunziker et al. 2017; Beven &
     Westerberg 2011).
   - Under-estimated abstraction makes the fitted "natural" catchment look
     drier than it is (Hughes & Mantel 2010).
5. **South African assessors use other statistics and another form of EWR.**
   - **Calibration.** WR2012 practice judges a calibration on five statistics
     of monthly flows: MAR, the mean of log annual flows, the SD, the log SD and
     the seasonal index. It also uses visual FDC comparison. The app reports
     none of the five.
   - **The Reserve.** It is gazetted as EWR %nMAR, and in Reserve studies it is
     specified as monthly flow-duration (assurance) rules. Those rules follow
     the natural flow (Hughes & Hannart 2003; Hughes & Mallory 2008). The app's
     12 fixed monthly values are a simplification of that.
   - **Compliance.** It is judged on FDCs and on daily as well as monthly data,
     and daily data shows more non-compliance (Pollard et al. 2011; Riddell et
     al. 2014).
6. **There is no published DWS standard for WULA hydrology.** No guideline
   prescribes methods, calibration thresholds or uncertainty reporting for a
   Section 21 dam application. The de facto standard is visible in a 2025
   consultant report:
   - WR2012 WRSM-Pitman recalibrated to the nearest gauge and downscaled by
     area;
   - SAPWAT irrigation demand;
   - a monthly dam balance with a power-law area–volume relation;
   - assurance of supply, change in % zero-flow time, and the Reserve as %nMAR
     plus registered use (Dabrowski 2025).

   The app should match that level of evidence and say what it assumes, not
   claim compliance with a standard that doesn't exist.

## What the app already does in line with practice

- **Calibration target.** It calibrates the present-day (impacted) model
  against the observed record and derives natural flow from the model, rather
  than naturalising the record. That is WR2012's approach, and Payan et al.
  (2008) and Hughes & Mantel (2010) support it.
- **Objectives.**
  - KGE′ is the default, with the −0.41 benchmark (Kling et al. 2012; Knoben
    et al. 2019).
  - Year-balanced KGE′ is an option: Fowler et al.'s (2018) split KGE, which
    transfers best into drying climates.
  - No KGE on log flows (Santos et al. 2018).
- **Validation.** Split-sample and differential dry→wet validation (Klemeš 1986;
  Thirel et al. 2015).
- **Parameter bounds and the MAR band.** Perrin's typical ranges and a WR2012
  MAR band as soft constraints. That is the right idea (Bulygina et al. 2009;
  Kapangaziwiri et al. 2012), though it is used as a penalty, not a filter.
- **Rain data.** CHIRPS is bias-corrected by calendar month, with suspect data
  left out of the fit (low-vs-CHIRPS years whole, flagged zero-run days one by
  one). Zero-rain runs and far-below-CHIRPS years are flagged, and a double-mass check against CHIRPS finds changes in the ratio (engine 0.18.0).

## Recommendations

IDs are for tracking (CR = calibration research). Effort is rough, in
developer-days (d) or weeks (wk). **P1** is the next thing to build, **P2**
follows, **P3** is later or conditional, and **P4** is documented but not
planned.

### Calibration and uncertainty

| ID | Change | Why | Effort | Priority |
| --- | --- | --- | --- | --- |
| CR-1 | **Behavioural ensemble.** Sample 10–20k parameter sets (Sobol or Latin hypercube within the chosen bounds) in Web Workers. Keep the sets that pass the acceptance rules (for example KGE′ within 0.05 of the best, volume bias within a tolerance, and simulated natural MAR inside the WR2012 band). Run every kept set through the network, and report the range of EWR compliance, the flow envelope, and how many sets each rule rejected. | Finding 2; Beven & Binley 2014; Kapangaziwiri et al. 2012; Hughes 2013. At tens of milliseconds per run, 20k runs take minutes on one thread, and far less spread over several workers. | 3–5 d | P1 |
| CR-2 | **Multi-start DDS.** Run 5 seeds and report the spread of optima. Nearly equal scores with scattered parameters is direct evidence of equifinality. | Finding 1; a cheap guard against a stuck run. Done: 5 starts by default, a Starts table and an equifinality note. | < 1 d | P1 |
| CR-3 | **Low-flow objective.** Add the mean of KGE(Q) and KGE(1/Q), with ε = Q̄/100, as the suggested objective for EWR decisions. | Pushpalatha et al. 2012; Garcia et al. 2017. **Built (engine 1.19.0, issue #65):** objective `kgeLowHigh`, ε = Q̄/100 on both sides; suggested for EWR decisions, the default stays KGE′ (model.md §2.10b). | 1 d | P1 |
| CR-4 | **Leave-one-year-out cross-validation**, beside split-sample and dry→wet. Fit on all water years but one, score the one left out, repeat, and report the spread. | A single split of a short record gives one noisy number (Guo et al. 2020); it shows whether one wet year is the persistent outlier. | 1–2 d | P1 |
| CR-5 | **Confidence intervals and benchmarks on scores.** Block-bootstrap 90 % intervals on every KGE′/NSE, resampling water years. Add a mean-flow row and a day-of-year climatology benchmark row. | Clark et al. 2021: daily scores carry large sampling error. In a strongly seasonal catchment, climatology is a hard benchmark to beat. **Built (engine 1.19.0, issue #65):** 1 000 water-year block resamples (fixed seed; none under 3 water years of ≥ 30 days), mean-flow and day-of-year climatology (±7-day window) benchmarks on every scored period (model.md §2.10b). | 2 d | P1 |
| CR-6 | **Drop the Moriasi words on daily scores**, or caveat them. | The Moriasi et al. (2007, 2015) thresholds were set for mostly monthly, SWAT-type work. Done: dropped, with the mean-flow benchmark in their place. | < 1 d | P1 |
| CR-7 | **Regional constraints as filters.** In the ensemble, accept a parameter set only when simulated natural MAR, BFI, Q10/Q50/Q90 and % zero-flow fall inside regional ranges. Show EWR results separately toward each end of the WR2012–quinary MAR band. | Kapangaziwiri et al. 2012. Where two published MAR estimates disagree, the gap between them may be the largest uncertainty in the analysis and should not be hidden in one penalty weight. | 2–3 d | P2 |
| CR-8 | **Two-objective trade-off view.** Plot KGE′ against a low-flow score using a weighted DDS sweep, with the EWR result at each point. | Vrugt & Robinson 2007; Fowler et al. 2016: better-transferring sets often exist on the front. | 2–3 d | P2 |
| CR-9 | **Proxy-basin ensemble** as an independent line of evidence (issue #4 plan item 3). Where the calibration record is short and dry, a longer record from a nearby catchment, once naturalised, may be the only source of wet-year information. | Oudin et al. 2008. | 1–2 wk | P2 |
| CR-10 | **GR6J** as a structural alternative for low flows. Compare EWR results between the GR4J and GR6J ensembles. | Pushpalatha et al. 2011; Fowler et al. 2020: many models lack slow dynamics. | ~1 wk | P3 |
| CR-11 | **Formal likelihood** (Box-Cox λ≈0.2 plus AR(1)) with DREAM(ZS) and predictive intervals, only if interval forecasts on the hydrograph are needed. Label it as conditional on the network inputs. | McInerney et al. 2017; Vrugt 2016. A formal posterior from a few years of impacted flow is likely to be overconfident. | 1–2 wk | P3 |
| CR-12 | **X2 (GR4J exchange).** Keep it fixed at 0 by default, as now, unless the data support it. | Hard to identify on dry records; it can "lose" water. | none | – |

### Recession model

| ID | Change | Why | Effort | Priority |
| --- | --- | --- | --- | --- |
| CR-13 | **Recession diagnostics.** Pick out recession segments from the observed record automatically: catchment rain below a threshold on the day and the day before, Q falling, at least 5–7 days long, with gaps breaking a segment, and flagged extrapolated or suspect days left out. Plot −dQ/dt against Q with the imported table overlaid, so the user can see how far the hand-built curve is from the data. (Since engine 1.0.0 there is no imported table to overlay: it went with the legacy model, issue #16. The segments stay useful as a check on GR4J's simulated recessions.) | Tallaksen 1995; Stoelzle et al. 2013; Dralle et al. 2017. TOSSH (Gnann et al. 2021) documents every default and is the specification to port from. **Built (engine 1.19.0, issue #65):** segments and −dQ/dt per TOSSH defaults, observed against GR4J's simulated recessions with indicative warnings, in the Plausibility checks panel (model.md §2.10d); CR-18's quality flags joined its day mask in engine 1.22.0 (§2.10h). | ~1 wk | P1 |
| CR-14 | **Mass-conserving legacy store** (needs the hydrologist, H1). Turn the table into S(Q) through g(Q) = −ln k(Q) and add each rain pulse as volume. Drop the base-flow reset and the size-dependent start index. Add a water-balance invariant: one pulse returns its own volume within 0.1 % at 1, 10 and 100 mm. Bump `ENGINE_VERSION` and add an audit entry. | Kirchner 2009; Lamb & Beven 1997; Fenicia et al. 2006. This removes H1, and the legacy model becomes a one-store relative of GR4J. Not built. **Dropped (2026-09-26):** engine 1.0.0 removed the legacy model instead (issue #16, audit H1 closed); GR4J is the only runoff model. | – | – |
| CR-15 | **Fitted recession table with uncertainty.** Fit −dQ/dt = aQ^b to each segment. Bin k by log Q and take the 10th/50th/90th percentiles. Bootstrap by segment. Derive a table from the median and report the bands. Tag segments by season and by whether they come before or after the dams spill, and add back estimated abstraction before fitting. Don't replace the imported table when there are fewer than about 8 segments. (The table it would replace went with the legacy model in engine 1.0.0; the segment fit and its bands remain as a diagnostic.) | Jachens et al. 2020; McMahon et al. 2026; Wang & Cai 2009; Thomas et al. 2013. | 1–2 wk | P2 |
| CR-16 | **Recession validation signatures.** Report the skill on withheld segments, BFI by both the Eckhardt and the Hughes et al. (2003) filters (South African reviewers expect the second), and the slope and bias of the low-flow FDC. **Part built (engine 0.25.0, [model.md §2.10d](./model.md)):** dry-season low-flow duration curves of the gauge, logger and each model, with a warning when the simulated Q90 is more than a factor of 2 from the observed. | Eckhardt 2005; Hughes, Hannart & Watkins 2003; Yilmaz et al. 2008. | ~1 wk | P2 |
| CR-17 | **Recommend GR4J** for short, dry records until CR-13/14 pass. | GR4J already conserves water. Done: GR4J is the default since engine 0.11.0. | docs | P3 |

### Data quality and uncertainty

| ID | Change | Why | Effort | Priority |
| --- | --- | --- | --- | --- |
| CR-18 | **A quality flag on each day of a series.** For flow: in the gauged range, extrapolated above the highest gauging, below the lowest gauging, human use dominant, missing or infilled, or suspect. For rain: missing or infilled. Derive the extrapolated flag from the rating's gauged maximum where it is known. | Coxon et al. 2015; Kiang et al. 2018; Wessels & Rooseboom 2009 (SA weirs ±5 % in range, over 40 % beyond it). Roadmap WP-1.32's `filled` mask generalises to this. **Built (engine 1.22.0, issue #66, model.md §2.10h):** one flag per day (`calibrate/dayFlags.ts`) from the Data checks and each record's gauged range (`settings.qualityFlags.ratings`, entered with its source); `infilled` reads gap-filled flow's mask once that lands; human use dominant is defined but not derived (it would move with the parameters being fitted; CR-25). Rain: observed, infilled (CR-20's flag generalised) or missing. | 2–3 d | P1 |
| CR-19 | **An objective that reads the flags.** By default, leave extrapolated, missing and suspect days out of KGE′/NSE, or censor extrapolated days (the only condition is simulated ≥ the highest gauged flow). Down-weight the other flagged classes. Show days used and excluded, and the fit on all days next to the fit on clean days only. | Beven & Westerberg 2011; Westerberg et al. 2011. **Built (engine 1.22.0, issue #66, model.md §2.10h):** days above the highest gauging censored (o′ = max(s, Q_g) where s < Q_g), below-rating, suspect and infilled days left out by default, each configurable; the fit on all days reported beside it; recorded in the fit record ("Quality flags changed since fit"). No down-weighting: each class is in or out. | 2 d | P1 |
| CR-20 | **Treat suspect zero-rain runs as missing.** Today a flagged zero run still drives the model as dry, and it blocks the CHIRPS fallback (issue #2). Treat a flagged run as missing so that corrected CHIRPS fills it, with an infill flag. Add a double-mass check against CHIRPS. **Done (engine 0.15.0, audit B2, [model.md §2.4c](./model.md#24c-zero-rain-runs-treated-as-missing)):** on by default, with keep-dry and missing periods; the per-day flag is `rain_catchment_missing`. **Double-mass check done (engine 0.18.0, [model.md §2.10a](./model.md#210a-data-quality-do-the-observed-flow-records-agree)):** water-year totals of catchment rain against CHIRPS, up to two breaks chosen by BIC, reported at a slope change of 20 % or more confirmed by Pettitt or the BIC gain; a warning and a Data-tab chart, never a change to the fit. The same release fits the CHIRPS factors around flagged runs day by day and keeps kept-dry days in. **Per-segment factors and a fit period done (engine 0.29.0, issue #40 (a), `settings.chirpsFitPeriod`).** | Hunziker et al. 2017. It is exactly the "disinformative data" case. | 2–3 d | P1 |
| CR-21 | **Sensitivity runs and compliance as a range.** Rain × 0.9/1.1, pan coefficient ± 15 %, dam-evaporation coefficient, abstraction × 0.7/1.3, and initial dam storage empty against full. Report EWR compliance as a central value with a low–high range, plus a tornado chart. Label a result whose range crosses the decision threshold "not determinable with current data". | Oudin et al. 2006; Hughes & Mantel 2010; Renard et al. 2010 (a rain multiplier is a sensitivity factor, never a free parameter). **Built (engine 1.19.0, issue #65):** `sensitivityRuns`, one factor at a time, EWR compliance per site as central + low–high with a "not determinable with current data" verdict and a tornado on River & reserve; not stored (model.md §2.10g). `pnpm pan-sensitivity` remains the refitting check of the pan coefficient, and `pnpm fit-sweep` compares fits across fit settings. | 2–3 d harness + 1–2 d chart | P1 |
| CR-22 | **A data-quality panel on every calibration report.** Show the share of days by flag, rain infilled, suspect zero runs, and how wet the calibration period is against the long-term record, with a note on what the record can't support. | Finding 4. **Built (engine 1.22.0, issue #66):** `report.dayQuality` and the Fit panel's data-quality panel: days by flag and what the fit did with them, the scored days' rain by source with zero runs set aside, the record-representativeness gist, and notes on what the record can't support (model.md §2.10h). | 1 d | P1 |
| CR-23 | **Quantile-mapping option for CHIRPS**, by season with a wet-day threshold. Keep today's monthly scaling as the fallback when there are too few overlapping wet days. | Teutschbein & Seibert 2012; Du Plessis & Kibii 2021. Monthly scaling fixes the monthly volume, not wet-day frequency or intensity. | 2–3 d | P2 |
| CR-24 | **Alternative rating curves** that regenerate the observed series, compared as sensitivities. | Kiang et al. 2018: the choice of method is itself a large source of uncertainty. | 2 d | P2 |
| CR-25 | **Flag days where human use dominates** automatically (simulated abstraction plus dam capture above x % of natural flow). Down-weight them in the low-flow objective and report the fit on them separately. | Terrier et al. 2021; Wada et al. 2017. | 1 d | P2 |
| CR-26 | **Oudin PET as a cross-check** for GR4J. A large difference exposes a wrong pan coefficient. | Oudin et al. 2005. | 1 d | P3 |
| CR-27 | **BATEA or formal input-error inference.** Not planned. | Kavetski et al. 2006; Renard et al. 2010: it needs prior error models the project doesn't have. | – | P4 |

### South African reporting and the EWR

| ID | Change | Why | Effort | Priority |
| --- | --- | --- | --- | --- |
| CR-28 | **The WR2012 five-statistic table.** MAR, the mean of log annual flows, the SD, the log SD and the seasonal index, on monthly aggregates of observed and simulated flow, each with its % difference and "good fit" band. Show it beside KGE′/NSE. | WR2012 practice (Bailey & Pitman 2016; Ndiritu 2009). The good-fit thresholds were seen only in a consultant report citing WR2012; confirm them in WRC TT 689/690 first. **Built (engine 1.19.0, issue #65, model.md §2.10):** the five statistics on complete water years of monthly flows, beside KGE′/NSE in the fit results, a run's calibration panel and the summary CSV. Bands 4/4/6/6/8 % labelled indicative; the WRC TT 689/690 check and the WRSM seasonal-index definition are still open (issue #90). | 1–2 d | P1 |
| CR-29 | **Compliance reported as the gazette and CMAs do.** % of time and volume not met per month, from daily data with monthly shown alongside; monthly FDC overlays of natural, present-day and scenario flow on the EWR; and the EWR as %nMAR. | Pollard et al. 2011; Riddell et al. 2014; gazetted Reserve in %nMAR. **Part built (engine 0.21.0, model.md §2.9c):** monthly compliance against a rule table per month of the year, deficit volume, contiguity and the monthly FDC check against the EWR curve. Still open: % of time from daily data, FDC overlays of scenario flow, the EWR as %nMAR. **Rest built (engine 1.19.0, issue #65):** % of time and volume not met per month from daily data beside the monthly view, monthly FDC overlays of natural, present-day and scenario (compare page) flow on the EWR, and the EWR as %nMAR. | 2–3 d | P1 |
| CR-30 | **The EWR as a DRM/RDRM assurance table**: 12 months × assurance levels, for maintenance and drought low flows plus high flows. The day's EWR comes from where simulated natural flow sits on its monthly duration curve. Keep the 12-value pragmatic EWR as a labelled simplification. Needs the hydrologist. | Hughes & Hannart 2003; Hughes & Mallory 2008; Hughes et al. 2014; Sawunyama & Hughes 2010. **Built as a report (engine 0.21.0, [model.md §2.9c](./model.md#29c-ewr-compliance-by-the-reserves-assurance-rules-engine--0210-hydrologist-q6)):** an optional rule table per EWR site judges each month against the requirement its natural flow selects, beside the pragmatic EWR, which sets the daily charge and curtailment by default; from engine 1.3.0 (issue #64) a project can let the table drive them instead (`settings.ewrChargeSource`). The table's values, and which should drive the daily EWR, need the hydrologist. | 1–2 wk | P2 |
| CR-31 | **Licence-scenario report** in the shape of a WULA hydrology section. Compare baseline against proposal on: change in outlet MAR, change in % zero-flow days, change in EWR compliance by season, the applicant's assurance of supply, the effect on downstream users, and the Reserve bookkeeping (nMAR − EWR − registered use). | Dabrowski 2025 as the de facto benchmark; roadmap step 3. | 1–2 wk | P2 |
| CR-32 | **Clear dam and abstraction assumptions.** Record the fraction of catchment above each dam, the area–volume exponent (editable; WR2012's Pitman theory manual, WRC TT 690/16 §2.2, gives 0.6 as the average for all South African reservoirs, while the engine's default is 0.7, Liebe et al. 2005 for small reservoirs, model.md §2.7a; moving the default to 0.6, and the unknown-area fallback from capacity ÷ 3 m to A = 7.2 · C^0.77 m², Sawunyama 2013, is pending the hydrologist), the evaporation source and factor, and abstraction entered as registered volume, SAPWAT crop × area, or metered, with the range between them run as a sensitivity. | Hughes & Mantel 2010 (abstraction is the largest farm-dam uncertainty); Glenday et al. 2022; WP-1.21 (dam evaporation). Partly done (engine 0.16.0, audit N2): each dam's area–storage exponent (default 0.7) and seepage, and the project's A-pan lake-evaporation factor, are editable; the abstraction options and their sensitivity are not built. | 3–5 d | P2 |
| CR-33 | **Seasonal reporting.** Report the winter storage season and the summer low-flow season separately, and add an optional "winter surplus only" abstraction rule. | CMA strategy practice in winter-rainfall catchments. | 2 d | P2 |
| CR-34 | **A statement on how representative the record is**: its length and where it sits in the long-term rainfall distribution. | A few years from one climate state can't support the SD, the seasonal index or a high-flow calibration. **Built (engine 1.19.0, issue #65):** `report.representativeness`: scored days and water years, each year's rain percentile and class against the run's long-term water-year rain, the mean against the long-term mean, and notes on what the record can't show (model.md §2.10b). | < 1 d | P1 (part of CR-22) |

**Suggested order.** CR-2, CR-3, CR-6 and CR-34 are cheap and can go
first. Then:
- the data layer: CR-18 → CR-19 → CR-20 → CR-22;
- the ensemble and reporting: CR-1 → CR-5 → CR-21 → CR-28 → CR-29;
- the recession work: CR-13 (CR-14 was dropped when engine 1.0.0 removed
  the legacy model).

CR-30 and CR-31 are the larger licensing features in roadmap step 3.

## Questions this adds for the hydrologist

1. **Recession (CR-14).** Should the legacy model become a mass-conserving
   store, or should the app recommend GR4J and keep legacy only to reproduce
   the workbook? **Settled without it (2026-09-26):** the app kept legacy for
   comparison from 2026-09-24, then engine 1.0.0 removed it (issue #16); the
   operator assumed the hydrologist's agreement.
2. **EWR form (CR-30).** Is the 12-value pragmatic EWR acceptable for the
   client's purpose? Or does the CMA expect the assurance-table form from the
   gazetted Reserve study for this reach? The app can now take that table and
   report monthly compliance with it (model.md §2.9c); which table, and the
   method choices listed there, are for the hydrologist.
3. **Rating (CR-18).** What is the highest field gauging at each observed
   flow site, and which rating curve was used? This decides which days are
   flagged as extrapolated. Engine 1.22.0 takes the answer per record in
   Settings → Calibration record → Quality flags (model.md §2.10h).
4. **Abstraction (CR-21, CR-32).** Which abstraction estimate is defensible:
   registered, SAPWAT or metered? And what range around it?
5. **Disagreeing MAR estimates (CR-7).** Where two published MARs
   disagree, which does the hydrologist trust, and why? Or should results
   be reported toward both ends?

## Rain forcing: which record, and how to homogenise it (issue #12)

A method note (2026-09-25) for choosing the rain record that forces a
catchment model and making it consistent over time. It came out of the
client catchment study for issue #12. The client findings, figures and
station details are in the private source repo
(`Research/rainfall-forcing.md`); nothing here identifies the catchment.
Items marked **(judgement)** are engineering judgement, not a published rule.
Revised the same day after an independent hydrologist review: the scaling
test, the runoff checks, the fill rule and the day boundary changed, and a
neighbouring-gauge flow check was added (§3).

**Why it matters.** GR4J's parameters absorb the level of the rain that
drove the calibration. If the forcing reads higher in the calibration years
than in the years the model is later run on, the model under-produces flow
in those years and the error lands on the EWR and curtailment results. A
double-mass break against CHIRPS (model.md §2.10a) shows that *something*
changed, but not *which* record.

### 1. Find out what the series is before judging it

Station metadata (who read which gauge, from when, how the average was
built) is the primary evidence (WMO 2020, *Guidelines on homogenization*,
WMO-No. 1245; Peterson et al. 1998). When the metadata is missing, the
values themselves carry a lot of it:

- **Value resolution.** A manual gauge read to whole millimetres gives
  integers; an automatic tipping bucket gives 0.1 or 0.2 mm steps. An
  average of *n* gauges gives multiples of 1/*n* of the gauge step: thirds
  mean three whole-mm gauges, thirtieths three 0.1-mm gauges, twentieths two.
  A change in the mix of denominators from one year to the next dates a
  change in the network behind a "catchment average", with no reference
  series needed.
- **Wet-day frequency.** An average of several gauges has more wet days than
  any one of them (a day is wet if any gauge is), and a gauge read weekly or
  irregularly has far fewer, with large "daily" totals. A step in the number
  of days ≥ 1 mm is a network or reading-practice change, not weather.
- **Reading-day patterns.** An excess of rain on Mondays or after public
  holidays is an unread gauge's accumulation (§2.4d already spreads these).

These markers date the changes. They don't say whether the *level* changed:
that needs references.

### 2. Compare with more than one reference, including a gauge-free one

- **CHIRPS is not a fixed yardstick.** It blends satellite estimates with
  whatever station reports reach it each month, and the number of South
  African stations it ingests has changed over the decades. A catchment /
  CHIRPS ratio can therefore drift because CHIRPS drifted. v2 and v3 also
  differ: v3 (released 2025) adds many stations, corrects gauge undercatch
  and fills gaps from ERA5, so it is wetter than v2 overall, and not by a
  fixed factor (CHC, CHIRPS v3.0 README). The CHC publishes the stations
  v3 used each month (`diagnostics/monthly_station_data/`): check how close
  the nearest one is, and when it enters. Where there is none for decades,
  CHIRPS there is satellite plus climatology. Where a gauge *inside* the
  catchment enters, CHIRPS stops being independent of it.
- **Find out which CHIRPS the project holds.** A workbook column labelled
  "CHIRPS" may be v2. Match its monthly totals against v2 and v3 cells: the
  right version and cell match to a few mm a month, the wrong one doesn't.
- **Use a gauge-independent reference.** ERA5's precipitation is a model
  forecast; outside a radar–gauge composite over the United States it
  assimilates no rain gauges (Hersbach et al. 2020), so a local gauge
  network change can't enter it. Its own observing system changes (the
  satellite era) can, which is why one reference is not enough.
  ERA5-Land's precipitation is ERA5's, interpolated to 0.1° (Muñoz-Sabater et al. 2021), so it adds nothing for
  rain. MERRA-2's land precipitation is corrected towards
  gauge-based and merged products (CPCU, and GPCP over Africa; Reichle et al.
  2017), so it is a third, partly independent view.
- **Count independent references honestly (judgement).** Products that
  share inputs are not separate witnesses. MERRA-2 is corrected towards
  gauge-merged products, CHIRPS blends in gauge reports, and CHIRPS v3's
  daily disaggregation uses ERA5. Three gridded products may amount to
  about one and a half independent views. Agreement among them is weaker
  than it looks, which is why a flow-based check (§3) is worth adding.
  All three are free: CHIRPS from the CHC server (the app's feed code reads
  it), ERA5 and MERRA-2 without an account through the Open-Meteo archive
  API and NASA POWER. IMERG and the Copernicus CDS need a registered
  account.
- **Look for newer gauges inside the catchment.** Automatic-station
  networks installed since about 2015 can publish daily data without an
  account (SASSCAL WeatherNet is one in southern Africa). A few years of an
  in-catchment gauge beside the modelled series is the most direct test of
  a recent era, and a candidate replacement for it. Check its missing days
  month by month before using its totals.
- **Attribution rule (judgement).** Compute the station ÷ reference ratio by
  water year against each reference, and each reference against the others.
  - A step that appears against *every* reference is in the station series.
  - A step that appears against one reference only, and in that reference's
    ratio to the others, is in that reference.
  - Judge steps at the water-year and era scale, not daily: daily timing
    differs between products and gauges (model.md §2.10a).
- **Seasonal shape, not only level.** Compare station ÷ reference by
  calendar month within each era. A change of level with the same shape is
  a scaling problem. A change of *shape* (for example the winter ratio
  collapsing while summer is unchanged) means the series now describes a
  different part of the catchment, and scaling it back is not defensible.

### 3. Check each candidate against the runoff

A 0.05–0.25° product can't resolve orographic rain on a narrow mountain
range, so its level is not the truth either: CHIRPS under-reads in nearly
all of South Africa's winter-rainfall catchments (Pitman & Bailey 2021; Du
Plessis & Kibii 2021). Observed runoff is the
arbiter:

- Over the years with a flow record, compute the runoff coefficient Q/P for
  each candidate forcing.
- Place each (P, Q) pair against a Budyko curve (Fu's form, ω about 1.8–2.6,
  PET from the project's pan data). A forcing that needs Q/P far above what
  the curve allows at that aridity can't be the catchment's rain. In a
  winter-rainfall climate, rain falls when PET is low, so ω sits at the
  low end (Milly 1994; judgement for any given catchment).
- Compare the long-term runoff the forcing implies with the published
  natural MAR for the quaternary or quinary (WR2012; the quinary database),
  remembering that two published estimates can disagree widely.

Lessons from the review (judgement):

- **Know the flow record's rating before you lean on it.** A record rated
  from few measured gaugings, with the rest from a hydraulic model or an
  extrapolation, can carry most of a wet year's volume in the extrapolated
  part.
  Work out the share of volume above the highest measured gauging. Where
  it is large, give the volume ±30–50 %, and redo the Budyko test across
  that range.
- **Take ω from the region, not the textbook.** Fit ω so Fu's curve
  reproduces the quaternary's own published water balance (its MAP and
  natural MAR, at the same PE), then test the catchment with that ω and a
  bracket around it.
- **Use the same PE as the model.** Pan data in a workbook may already
  carry a pan factor. Check what the row is (model.md §2.4a)
  before converting it again, or the Budyko test runs at
  the wrong aridity.
- **Budyko narrows the field; it rarely picks the winner.** With honest
  inputs it will usually exclude the driest products and leave several
  candidates standing. The choice of level then rests on consistency with
  the calibration (§4), with the runoff tests as support. State that
  plainly.
- **Rain level and PE interact.** With the observed flow fixed, a forcing
  that reads too wet needs *more* loss to match it: higher PE, or a larger
  production store X1 that keeps more water available to evaporate. Low PE
  is favoured by rain that reads too *dry*, by flow that reads too high (an
  over-extrapolated rating limb), or by under-counted abstraction. GR4J's
  stores absorb much of either level, so fits at different levels can close
  the volume equally well and differ mainly in hydrograph shape (compare
  PBIAS and AET, not only NSE; model.md §2.4a). Correcting one forcing
  without revisiting the other can make the fit worse *and* push natural
  MAR outside the published band. Settle them together: refit on a
  small grid of fixed rain levels against the corrected PE, and pick by the
  physical checks first and fit second. The rain level stays a fixed input
  chosen once, never a calibrated multiplier.
- **Test time consistency against a neighbouring flow gauge.** A long
  record from an adjacent gauged catchment shares nothing with any rain
  product or with the station.
  - Use its flows as recorded, over its own area (not scaled to this
    catchment).
  - Fit log(annual flow) against log(annual rain) for each candidate
    forcing over the reference era.
  - Read each era's mean residual, divided by the slope, as the rain factor
    that era would need.
  - A forcing whose implied factor drifts across eras is inhomogeneous. One
    that stays near 1 is a good reference for fills.
  - Where every product needs a factor below 1 in the same recent era, the
    neighbour's flow response has probably changed (new dams or
    abstraction). Allow for that before reading the station's factor.
  - A single year's implied factor is noisy (tens of percent). Use era
    means.

### 4. Homogenise to the calibration era

- **Pick a reference era: the years that overlap the calibration flow
  record** (judgement). The model will be fitted to that forcing, so every
  other era should be made consistent with it, not with an abstract "true"
  level.
- **Measure each other era against it** with the gauge-independent
  references (step 2): era factor = (station ÷ reference over the era) ÷
  (station ÷ reference over the reference era), per reference.
  - **Judge the factor against its standard error, not against the
    interannual scatter.** The standard error of the ratio of two era means
    combines the year-to-year variance of the log ratio in *both* windows:
    √(s²ₑᵣₐ/nₑᵣₐ + s²ᵣₑ𝒻/nᵣₑ𝒻). The interannual CV alone describes one year,
    not an era mean. Or use a change-point test on the annual log ratio:
    Pettitt (1979) or Buishand's range test (1982), as in WMO-No. 1245.
  - If the factors from the different references agree, and differ from 1
    by clearly more than their standard errors (or a change-point test
    finds the break), scale that era by their mean.
  - If they straddle 1, disagree, or sit within one to two standard errors,
    **leave the era as recorded** and carry the spread as uncertainty,
    skewed towards the side the evidence leans. Scaling on a disputed break
    adds error.
- **Check that the reference era is itself homogeneous.** The network can
  change inside it too, for example a move to finer-resolution gauges or a
  different set being averaged. Split it at any metadata or value-resolution
  change (§1) and compare the parts. If they differ, narrow the reference to
  the part the calibration flow record actually overlaps.
- **Replace, don't scale, an era whose seasonal shape changed.** Use an
  in-catchment gauge for that era if one exists, scaled to the reference
  era's level against the gauge-independent references (by season if its
  seasonal ratio differs). Otherwise treat the era as missing (the
  `missing` periods of §2.4c) and fill it from a gridded product with
  factors fitted in the reference era. Two gridded fills can disagree by
  tens of percent in a given year, so a gauge anchor is worth a lot.
- **Fit infill factors per era, not over the whole record.** Today one set
  of monthly CHIRPS factors is fitted over every era (§2.4b), so a gap is
  filled with a blend of ratios.
  - **Use one rule everywhere: factors fitted in the reference era.** Fills
    then land at the calibration forcing's level. Factors fitted on other
    eras carry those eras' offsets into the fill.
  - **Check the fills against the neighbouring gauge's flows** where it
    overlaps the gaps. A zero-filled year shows up at once.
  - **Leave replaced and filled periods out of every fit.**
  - **Use explicit date ranges, stated with a reason.** An auto-detected
    change-point can land a year or two from the real network change.
  - **Never fit or fill from a product that ingests the gauge being
    replaced.** Once an in-catchment gauge enters CHIRPS, CHIRPS factors
    fitted or applied in that era are circular. Use a gauge-free reference
    (ERA5) there, with factors fitted in the reference era.
  - This was the *CHIRPS fit period / per-segment factors* followup.
    **Done, engine 0.29.0 (issue #40 (a)):** `settings.chirpsFitPeriod`,
    per listed water-year range with a reason
    ([model.md §2.4b *Fit period*](./model.md#fit-period-and-per-range-factors-engine--0290-issue-40)).
    The double-mass breaks only propose ranges.
- **Match the day boundary before splicing.** Manual gauges in South Africa
  are read at 08:00 and the reading is booked to the previous day. An
  automatic station reports midnight to midnight. Correlate the two at lags
  of −1, 0 and +1 day. If the manual series leads, aggregate the automatic
  station's hourly data to 08:00–08:00 windows booked to the start day.
  **Done, engine 0.30.0 (issue #40 (b)):** the Upload form adds an hourly
  file up into 08:00–08:00 days booked to the start day, and the series
  records it; a gauge-anchored replacement is a `settings.rainSource` period
  ([model.md §2.4e](./model.md#24e-rain-source-periods-engine--0300-issue-40-b)).
- **Check daily intensity, not only totals.** A single automatic gauge has
  more intense days than a mean of several manual gauges, and a constant
  scale factor keeps that. Compare the share of rain on heavy days (say
  ≥ 20 mm) with the reference era. Where it differs, quantile-map the wet-day
  distribution month by month, preserving monthly totals. Or at least
  carry the runoff effect, a few percent in a toy GR4J run, in the band.
- **Don't mix product versions in one series.** A CHIRPS series built from
  v2 for the past and v3 for new days has a break at the join that the
  double-mass check will attribute to the catchment. Replace the whole
  column with one version and refit the factors. The app's feed reads v3's
  daily `sat` product, which starts in 1998 (CHC daily readme); earlier
  days need v3's `rnl` daily product, for the whole record, since the two
  disaggregate the same pentads with different daily timing. The app
  enforces this (issue #40 part c): each series records its product and
  version, the feed never writes into a series of another one without an
  owner confirming a whole-series replacement (a full backfill, `rnl` for a
  record before 1998), and the fit record and run comparison flag the
  change (architecture.md § Data feeds).

### 5. Carry the uncertainty into calibration

- Keep the rain as a **fixed input with era-specific sensitivity ranges**,
  never a free calibration parameter (Renard et al. 2010; CR-21).
- Tie the width of each range to how the era was treated (judgement):
  - narrowest in the reference era: point-to-area error only;
  - wider in an era left as recorded against a disputed break, skewed to
    the side the evidence leans;
  - widest in an era replaced by another gauge or a gridded product, where
    the references themselves can disagree by tens of percent.
- **Apply the ranges outside the calibration window.** There they are ratios
  on the recorded forcing, with the calibrated parameters held fixed.
  Perturbing the forcing *inside* the calibration window only means
  something with a refit for each perturbation. Otherwise it tests a model
  inconsistent with its own calibration.
- **Single years need wider ranges than era means.** A replaced era's scale
  factor, checked against flows year by year, can vary by ±15 % or more.
  Year-level results there (one year's EWR compliance) may need ±25–30 %.
  Multi-year statistics can use the era-level range.
- Report EWR compliance across those ranges, as CR-21 proposes, and state
  in the data-quality panel (CR-22) which years were scaled or replaced.

**References for this section** (the others are in [§ References](#references); unmarked ones are cited from their standard reference, not reopened).
Hersbach et al. 2020, *Q. J. R. Meteorol. Soc.* 146:1999, doi:10.1002/qj.3803 ·
Muñoz-Sabater et al. 2021, *Earth Syst. Sci. Data* 13:4349, doi:10.5194/essd-13-4349-2021 ·
Reichle et al. 2017, *J. Climate* 30:2961, doi:10.1175/JCLI-D-16-0720.1 ·
Funk et al. 2015, *Sci. Data* 2:150066, doi:10.1038/sdata.2015.66 ·
CHC, CHIRPS v3.0 README and daily readme, https://data.chc.ucsb.edu/products/CHIRPS/v3.0/ (verified 2026-09-25) ·
Pitman & Bailey 2021, *Water SA* 47(2), CHIRPS against WR2012 rainfall (verified 2026-09-25) ·
SASSCAL WeatherNet, https://sasscalweathernet.org (verified 2026-09-25) ·
Peterson et al. 1998, *Int. J. Climatol.* 18:1493 ·
WMO 2020, *Guidelines on homogenization*, WMO-No. 1245 ·
Fu 1981 and Zhang et al. 2004, *WRR* 40, W02502 (Budyko–Fu form) ·
Pettitt 1979, *Appl. Statist.* 28:126 · Buishand 1982, *J. Hydrol.* 58:11 ·
Milly 1994, *WRR* 30:2143 (seasonality and the water balance).

### 6. When the only rain record misses the catchment's rain: an areal correction

Added 2026-09-27 (issue #54). The earlier steps assume a catchment gauge
whose level is roughly right. A project can instead have only a gridded
product or one gauge that reads well below the catchment's areal rain.
GR4J conserves water, so it then cannot make the observed flow: the fit
compensates with implausible store sizes and still comes out dry, or it
needs X2 to import water. The engine's answer is a fixed
**areal rainfall correction** on GR4J's rain (model.md §2.4g). The procedure:

1. **Pin down the flow record first.** Before judging the rain, confirm what
   the observed record measures and where. For a DWS gauge, take the
   station's drainage area from the DWS station list, or from a paper that
   tabulates DWS gauged catchments, and compare it with the model's area
   above the gauge node. Check each tabulated value's heading and units
   before taking it. Calibration scores the
   outlet's record only: a record attached to a gauge node inside the
   network (its site, data-model.md § Gauge records) feeds the plausibility
   checks, not the fit (model.md §2.10d). So a gauge that measures only part
   of the catchment can't be calibrated against in place yet
   ([followups.md](./followups.md)); until it can, model the gauged part as
   its own project.
   Also check that each observed flow column is its own instrument: a
   column that duplicates another is left out by the importers (it would
   read as a second, agreeing instrument).
2. **Show the forcing is short, with the runoff.** Over the years with flow,
   compare the observed runoff (mm over the gauge's area) with the forcing's
   rain. A runoff ratio above what a Budyko curve allows at the catchment's
   aridity (§3; Fu's ω about 1.8–2.6, lower in a winter-rainfall climate) is
   a rain record that misses rain, not a flashy catchment. So is a fit that
   stays dry in volume however its stores are set.
3. **Take the level from an independent MAP.** In order of preference: the
   WR2012 MAP of the quaternary (or quinary) the catchment lies in (Bailey &
   Pitman 2016); a gridded MAP averaged over the catchment (the 1′ grid of
   Lynch 2004 underlies much South African work); a MAP published for the
   gauged catchment itself. Design-flood studies of DWS gauged catchments
   tabulate one per catchment (for example Gericke & Smithers 2018, a
   Thiessen average of the daily-rainfall stations of the national design
   rainfall database in and around the catchment; Gericke & du Plessis 2011).
   Check what each value is built from: a per-catchment MAP can rest on few
   stations. Such sources can disagree widely. Then let the
   runoff check (step 4) rule out the one the flow record can't support,
   and say so: that is picking by the physical checks, not fitting. Factor =
   MAP ÷ the forcing's mean annual rain over its complete water years
   (`arealFactorFromMap`). This is how WR90 and WR2012 build catchment
   rainfall: station records scaled by the ratio of the catchment's MAP to
   the station's (Midgley, Pitman & Middleton 1994). One flat factor: an
   annual MAP says nothing about the seasons.
   - **Mind the eras.** A MAP is a long-term mean; the forcing's mean covers
     only its own years. A forcing period drier than the long term gives a
     factor that is too high. Where the difference matters, compare over the same years
     (a long gauge in the region against its own MAP), or state the bias.
   - **Carry the spread.** Where MAP sources disagree, carry the low and high
     factor through the results that decide anything (§5), refitting at each.
4. **Check the factor against the runoff before fitting.** The corrected
   rain's runoff ratio should sit inside the Budyko band, and the implied
   natural MAR near the published one.
5. **Fit at the fixed factor, and on a small grid around it.** Fit GR4J
   (X2 off) at the MAP factor, then at a few factors either side. Report
   the fit and validation scores, the volume error, X1 and the runoff ratio
   at each. Expect the fit to be nearly flat in the factor across a wide
   range: a larger X1 absorbs more rain. So the flow record cannot identify
   the rain level (the X1–rain trade-off of §3), and a factor fitted to the
   flow alone (`method: 'fitted'`, which warns on every run) says little. Use
   the grid to show how much the results that matter (MAR, low flows, EWR
   compliance, supply) move with the factor, not to choose it. Where no
   factor lets X1 reach its typical range (100–1 200 mm, Perrin et al. 2003)
   without an unphysical runoff ratio, suspect the flow record (its rating
   or its site) or the evaporation as much as the rain.
6. **Keep crop demand on the recorded rain.** Effective rain on the
   irrigated fields is a field-scale quantity, taken from rain representative
   of the fields (Dastane 1978, FAO Irrigation and Drainage Paper 25; SAPWAT,
   van Heerden & Walker 2016). An areal factor corrects the catchment's
   average rain, which can differ from the rain on the irrigated fields and
   farm dams, so applying it to demand would cut irrigation demand for rain
   that may not fall there. The engine applies it to GR4J only (model.md §2.4g). If the
   fields' own rain is in doubt, supply a better field series.

To make it reproducible for a seeded project, the correction and the
calibration settings go in a settings patch and the fit is run at import
(model.md §2.10b, "Fit at import").

**References for this section** (unmarked ones are cited from their standard
reference, not reopened). Gericke & Smithers 2018, *J. S. Afr. Inst. Civ.
Eng.* 60(4):51–67, doi:10.17159/2309-8775/2018/v60n4a6 (verified 2026-09-27) ·
Gericke & du Plessis 2011, *Water SA* 37(4):453–470,
doi:10.4314/wsa.v37i4.4 (verified 2026-09-27) · Midgley, Pitman & Middleton
1994, *Surface Water Resources of South Africa 1990* (WR90), WRC 298/1/94 ·
Lynch 2004, *Development of a raster database of annual, monthly and daily
rainfall for southern Africa*, WRC 1156/1/04 · Dastane 1978, *Effective
rainfall in irrigated agriculture*, FAO Irrigation and Drainage Paper 25 ·
Perrin, Michel & Andréassian 2003 and the others in [§ References](#references).

## Where no authoritative guidance was found

- A DWS standard for WULA hydrology (methods, calibration thresholds,
  uncertainty).
- The WR2012 good-fit thresholds in their primary source. The WRC server timed
  out, so they come from a consultant report citing WR2012.
- The official DWS Hydstra quality-code definitions (the pages returned 403).
- A reconciliation of quinary (ACRU) and WR2012 MARs.
- Guidance on using short private flow records.
- A calibration study for catchments dominated by farm dams
  specifically. Where Australian or French results are applied here, that is an
  inference.

## References

Verified during the review: the publisher page, open full text or abstract was
read. The other references are standard ones, cited from memory by the
reviewers and not reopened. Check those before client use.

**Calibration and uncertainty.**
Arsenault et al. 2014, *J. Hydrol. Eng.* 19:1374, doi:10.1061/(ASCE)HE.1943-5584.0000938 (finding cited from memory) ·
Beven 2006, *J. Hydrol.* 320:18, doi:10.1016/j.jhydrol.2005.07.007 ·
Beven & Binley 2014, *Hydrol. Process.* 28:5897, doi:10.1002/hyp.10082 (verified) ·
Beven & Westerberg 2011, *Hydrol. Process.* 25:1676, doi:10.1002/hyp.7963 ·
Bulygina, McIntyre & Wheater 2009, *HESS* 13:893 (verified) ·
Clark et al. 2021, *WRR* 57, doi:10.1029/2020WR029001 (verified) ·
Coron et al. 2012, *WRR* 48, W05552, doi:10.1029/2011WR011721 (verified) ·
Fenicia et al. 2018, *WRR*, doi:10.1002/2017WR021616 (verified) ·
Fowler et al. 2016, *WRR*, doi:10.1002/2015WR018068 (verified) ·
Fowler et al. 2018, *WRR* 54:3392, doi:10.1029/2017WR022466 (verified) ·
Fowler et al. 2020, *WRR*, doi:10.1029/2019WR025286 (verified) ·
Garcia, Folton & Oudin 2017, *HSJ* 62:1149, doi:10.1080/02626667.2017.1308511 (verified) ·
Guo, Westra & Maier 2020, *WRR*, doi:10.1029/2019WR026752 (verified) ·
Kling, Fuchs & Paulin 2012, *J. Hydrol.* 424–425:264 ·
Knoben, Freer & Woods 2019, *HESS* 23:4323, doi:10.5194/hess-23-4323-2019 (verified) ·
Klemeš 1986, *HSJ* 31:13 ·
McInerney et al. 2017, *WRR* 53:2199, doi:10.1002/2016WR019168 (verified) ·
Moriasi et al. 2015, *Trans. ASABE* 58:1763, doi:10.13031/trans.58.10715 (verified) ·
Oudin et al. 2008, *WRR* 44, W03413, doi:10.1029/2007WR006240 (verified) ·
Perrin, Michel & Andréassian 2003, *J. Hydrol.* 279:275 ·
Perrin, Oudin & Andréassian 2007, *HSJ* 52:131 ·
Pool, Vis & Seibert 2018, *HSJ* 63:1941, doi:10.1080/02626667.2018.1552002 (verified) ·
Pushpalatha et al. 2011 (GR6J), *J. Hydrol.* 411:66 ·
Pushpalatha et al. 2012, *J. Hydrol.* 420–421:171 (verified) ·
Sadegh & Vrugt 2014, *WRR* 50:6767, doi:10.1002/2014WR015386 (verified) ·
Saft et al. 2016, *WRR* 52:9290, doi:10.1002/2016WR019525 (verified) ·
Santos, Thirel & Perrin 2018, *HESS* 22:4583, doi:10.5194/hess-22-4583-2018 (verified) ·
Schoups & Vrugt 2010, *WRR* 46, W10531, doi:10.1029/2009WR008933 (verified) ·
Seibert & Beven 2009, *HESS* 13:883 (verified) ·
Shafii & Tolson 2015, *WRR* 51:3796, doi:10.1002/2014WR016520 (verified) ·
Thirel et al. 2015, *HSJ* 60, doi:10.1080/02626667.2014.967248 (verified) ·
Tolson & Shoemaker 2007, *WRR* 43, W01413, doi:10.1029/2005WR004723 (verified) ·
Vrugt 2016, *Environ. Model. Softw.* 75:273 (verified) ·
Vrugt & Beven 2018, *J. Hydrol.* 559:954 (verified) ·
Vrugt & Robinson 2007, *PNAS* 104:708, doi:10.1073/pnas.0610471104 (verified) ·
Westerberg et al. 2011, *HESS* 15:2205, doi:10.5194/hess-15-2205-2011 (verified) ·
Yilmaz, Gupta & Wagener 2008, *WRR* 44, W09417.

**Recession and baseflow.**
Brutsaert & Nieber 1977, *WRR* 13:637 ·
Cooper & Zhou 2023, *JOSS*, doi:10.21105/joss.05492 (verified) ·
Dralle et al. 2017, *HESS* 21:65, doi:10.5194/hess-21-65-2017 (verified) ·
Eckhardt 2005, *Hydrol. Process.* 19:507 ·
Fenicia et al. 2006, *HESS* 10:139 ·
Gnann et al. 2021, TOSSH, *Environ. Model. Softw.* 138:104983; https://github.com/TOSSHtoolbox/TOSSH (verified) ·
Gustard & Demuth 2009, WMO-No. 1029 ·
Hughes, Hannart & Watkins 2003, *Water SA* 29:43 (verified) ·
Jachens et al. 2020, *HESS* 24:1159 (verified) ·
Kirchner 2009, *WRR* 45, W02429, doi:10.1029/2008WR006912 ·
Lamb & Beven 1997, *HESS* 1:101 (verified) ·
lfstat (R), https://cran.r-project.org/package=lfstat (verified) ·
McMahon, Nathan & George 2026, *HESS* 30:893 (verified) ·
Nathan & McMahon 1990, *WRR* 26:1465 ·
Roques et al. 2017, *Adv. Water Resour.* 108:29 ·
Rupp & Selker 2006, *Adv. Water Resour.* 29:154 ·
Smakhtin 2001, *J. Hydrol.* 240:147 ·
Smakhtin & Watkins 1997, WRC 494/1/97 (verified) ·
Stoelzle et al. 2013, *HESS* 17:817 (verified) ·
Tallaksen 1995, *J. Hydrol.* 165:349 ·
Thomas et al. 2013, *WRR* 49:7366 (verified) ·
Wang & Cai 2009, *WRR* 45, W07426 (verified) ·
Wasko & Guo 2022, hydroEvents, *Hydrol. Process.*, doi:10.1002/hyp.14563 (verified) ·
Xie et al. 2020, *J. Hydrol.* 583:124628 (verified).

**Observation and input uncertainty.**
Allen et al. 1998, FAO-56, ch. 3 ·
Andréassian et al. 2004, *J. Hydrol.* 286:19 ·
Coxon et al. 2015, *WRR* 51:5531, doi:10.1002/2014WR016532 (verified) ·
Di Baldassarre & Montanari 2009, *HESS* 13:913 (verified) ·
Du Plessis & Kibii 2021, *J. S. Afr. Inst. Civ. Eng.* 63(3), doi:10.17159/2309-8775/2021/v63n3a4 (verified) ·
Hunziker et al. 2017, *Int. J. Climatol.* 37:4131, doi:10.1002/joc.5037 ·
Kavetski, Kuczera & Franks 2006, *WRR* 42, W03407/W03408 ·
Kiang et al. 2018, *WRR* 54:7149, doi:10.1029/2018WR022708 (verified) ·
McMillan, Krueger & Freer 2012, *Hydrol. Process.* 26:4078, doi:10.1002/hyp.9384 ·
Oudin et al. 2005, *J. Hydrol.* 303:275 and 303:290 ·
Oudin et al. 2006, *J. Hydrol.* 320:62 ·
Payan et al. 2008, *WRR* 44, W03420 ·
Renard et al. 2010, *WRR* 46, W05521 ·
Teutschbein & Seibert 2012, *J. Hydrol.* 456–457:12 ·
Terrier et al. 2021, *HSJ* 66:12, doi:10.1080/02626667.2020.1839080 ·
Wada et al. 2017, *HESS* 21:4169 ·
Wessels & Rooseboom 2009, *Water SA* 35(1) (verified) ·
Westerberg et al. 2016, *WRR* 52:1847 (verified).

**South African practice and regulation.**
Bailey & Pitman 2016, WR2012, WRC TT 683/16; WRSM/Pitman manuals TT 689–691/16 (primary manuals not reached) ·
Dabrowski 2025, hydrological assessment for a proposed instream dam, Confluent Environmental, https://confluent.co.za/wp-content/uploads/2025/06/Appendix-2_OGF_Hydrology.pdf (verified) ·
Glenday et al. 2022, WRC 2927/1/22, catchment model inter-comparison (verified) ·
GN R267 of 2017, WULA regulations; GA GN 538 of 2016 (verified) ·
Gazetted Reserve determinations (NWA s16), read as examples of the form ·
Hughes 2013, *J. Hydrol.* 501:111 (verified) ·
Hughes & Hannart 2003, *J. Hydrol.* 270:167 (verified) ·
Hughes & Mallory 2008, *River Res. Appl.* 24:852 (verified 2026-09-25) ·
Hughes & Münster 2000, WRC TT 137/00, hydrological information and techniques for the water quantity component of the Reserve (cited in Pollard et al. 2011; primary not reached) ·
Hughes & Mantel 2010, *HSJ* 55:578, doi:10.1080/02626667.2010.484903 (verified) ·
Hughes, Kapangaziwiri & Sawunyama 2010, *J. Hydrol.* 387:221 (verified) ·
Hughes, Desai, Birkhead & Louw 2014, *HSJ* 59:673, doi:10.1080/02626667.2013.818220 (verified) ·
Kapangaziwiri & Hughes 2008, *Water SA* 34:183 (verified) ·
Kapangaziwiri, Hughes & Wagener 2012, *HSJ* 57:1000, doi:10.1080/02626667.2012.690881 (verified) ·
Mantel, Hughes & Muller 2010, *Water SA* 36(3) (verified) ·
Ndiritu 2009, *Phys. Chem. Earth* 34 (verified) ·
Pollard, Mallory, Riddell & Sawunyama 2011, WRC K8/881/2 (verified) ·
Riddell et al. 2014, *HSJ* 59:831, doi:10.1080/02626667.2013.853123 (verified) ·
Sawunyama & Hughes 2010, *Water SA* 36(4) (verified) ·
van Heerden & Walker 2016, SAPWAT4, WRC TT 662/16 (verified).
