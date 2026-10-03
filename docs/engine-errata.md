# Engine errata

Known bugs in released engine versions, and the conditions under which they
change results. Every run records its engine version (`model_run.engine_version`),
so a run made by an affected version can be found and re-run. The validation
statement and the sign-off statement print the errata that apply to the run's
version, an evidence pack lists them, and the pack's `/verify` page shows
them to anyone holding the pack (roadmap
[WP-3.13](./roadmap/step-3-licensing.md#wp-313-liability-and-credibility-disclaimers-validation-statement-sign-off),
[WP-3.14](./roadmap/step-3-licensing.md#wp-314-licence-evidence-pack)).

An erratum is a **bug**: the engine did something other than its documented
method. A method that is sound but still open to judgement is a known
limitation instead ([engine-audit.md](./engine-audit.md), printed separately).
An erratum stays here after it is fixed, because runs made by the affected
versions stay in the database and in issued packs.

**Scope.** The table lists the bugs found in the engine audit, its soaks and
reviews that changed a result a user would read, from the first release that
had the behaviour. It is not proof that an unlisted version is free of bugs:
the app prints "none recorded" for a version with no row, never "none".

**Keyed on.** Most errata affect a run made by an affected engine (`run`: the
run's `engine_version`). One that affects an automatic calibration affects
every run that uses the fitted parameters, whichever engine runs them
(`fit`: the fit record's `engineVersion`, `settings.fitRecord`); a run with
entered parameters has none of those.

**Adding one.** Add a row to the table below: a new `ER-<n>` id (never reuse
one), what it is keyed on, the first affected version, the version that fixed
it (`open` while it isn't), the conditions under which results change, and where it is
documented. Then run `pnpm gen:liability`;
`packages/engine/src/liability/errata.test.ts` fails until you do.

**What a new row does** ([legal/known-defect-procedure.md](./legal/known-defect-procedure.md),
issue #103). Once the release that carries it is deployed, every run in its
range is tagged **May be affected** in the run list and its header (the API's
`errata` on each run), and on the next worker tick each project holding such
a run has its owners emailed once (153_erratum_notices). Changing a row's
range later sweeps again, mailing only owners not mailed about it before.

## Errata

| ID | Keyed on | First affected | Fixed in | Severity | Applies when | What goes wrong | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ER-1 | run | 0.0.0 | 0.7.0 | High | Catchment rain has blank days that CHIRPS filled | CHIRPS filled the gaps without bias correction, so a filled year could run far too dry or wet | engine-audit.md B1; model.md §2.4b |
| ER-2 | run | 0.0.0 | 0.15.0 | High | Missing catchment rain was recorded as zeros | A run of zeros counted as dry days and blocked the CHIRPS fill, running the catchment dry over those days | engine-audit.md B2; model.md §2.4c |
| ER-3 | run | 0.15.0 | 0.20.0 | Medium | A run ends in a zero-rain run set aside as missing whose reading day holds a multi-day accumulation | The run was filled from CHIRPS and the accumulated reading was also kept, so that rain was counted twice | engine-audit.md B4; model.md §2.4d |
| ER-4 | run | 0.0.0 | 0.27.1 | High | Flow shares (manual, or a high/low split) add up to more than the catchment | The run went ahead and the farms made more runoff than the catchment's natural flow, lifting the outflow and hiding EWR failures | model.md §2.5 (overAllocationError) |
| ER-5 | run | 0.0.0 | 0.45.0 | High | Simulation start or end unset, and the rain series padded with blanks beyond its readings | The default run window covered the blanks, which ran as 0 mm and distorted every whole-run figure | engine-audit.md D1; model.md §2.1 |
| ER-6 | fit | 0.5.0 | 1.22.0 | Medium | The run's parameters come from an automatic fit on a record with suspect days or flood days beyond the gauged range | Those days weighed in the fit's objective like any other, so the fit could chase a stuck logger or a rating-curve extrapolation | engine-audit.md C2; model.md §2.10h |
| ER-7 | run | 0.16.0 | 0.19.0 | Medium | A transfer into a dam that loses water to evaporation or seepage | The destination dam was topped up short by that day's losses, so it could sit under its dead storage and supply nothing while the source had water to send | engine-audit.md N4; model.md §2.6 |
| ER-8 | run | 0.16.0 | 0.21.1 | Low | A very shallow dam with an area exponent above 1 | A day's evaporation could exceed 1/b of the dam, so a fuller dam ended the day with less water than a lower one and more demand could raise a farm's supply fraction | engine-audit.md N2; model.md §2.7a |
| ER-9 | run | 0.35.0 | 1.29.0 | Low | A transfer into a full dam that has a fixed release | The dam's room ignored the release, so it sat one release below full instead of taking back what it released | engine-audit.md N4; model.md §2.6 |
| ER-10 | run | 0.32.0 | 1.34.0 | High | Rarely (the rarity is here, not in the severity: when it hits, the figures are another farm's), when the JavaScript engine's optimising compiler timed a run a certain way (seen once, on a busy test machine), on a run with two or more farms or water users | A V8 miscompile could give a farm or water user another one's assurance of supply (reliability, annual reliability, failure runs) under its own name; its daily series and every other summary were right, and the run's self-checks didn't look at it | engine-audit.md V1; model.md §2.11a |
| ER-11 | run | 0.16.0 | 1.36.0 | Medium | Two or more transfer rules of one priority from one dam at different reserves (counting a rule active that month at rate 0) | The rules shared the free water above the lowest reserve among them, so the higher-reserve rules together could take the dam below their own reserves (a rule moving nothing lowered the floor for the rest) | engine-audit.md N6; model.md §2.6 |
| ER-12 | run | 1.8.0 | 1.57.0 | Low | A primary or emergency borehole pumping into a farm's dam, on a day its crop requirement came out as float noise (the soil-water store's rain an ulp short of the need) or off-take water arrived an ulp short of the demand | A demand of 10⁻¹² m³ or less counted as the dam being drawn for demand, so the borehole topped the dam up by up to a day's capacity (495 and 1 590 m³ in the cases found), using its annual cap and depleting the river | model.md §2.3, §2.7d; found by verify/ phase 2a |
| ER-13 | run | 1.14.0 | 1.69.0 | High | A farm or water user with an allocation and groundwater pumped into its dam (a dam-target borehole) that also took river water past the dam: river off-take water used directly, or (engine ≥ 1.65.0) its own river abstractions | The allocation comparison counted that river water as drawn from the dam, so it netted the groundwater pumped into the dam against it and the surface use read low, by up to the water pumped into the dam that water year: a unit over its registered surface volume could read within it (RunSummary.allocations, the Allocations tab, an evidence pack's comparison) | model.md §2.12; found by the engine end-to-end tests (2026-10-02) |
| ER-14 | run | 1.14.0 | 1.69.0 | Medium | Two or more river off-takes of one priority from one source that keep different flows in the river (a hands-off flow, keeping the EWR at the source, or the senior users' requirement; none counts as 0) | The off-takes shared the flow above the lowest keep among them, so the ones with a higher keep together took the river below it (the dam-transfer form of this was ER-11) | model.md §2.6a; engine-audit.md N6 |
| ER-15 | run | 1.30.0 | 1.69.0 | Medium | A dam with a release rule (fixed or pass the inflow) on days it doesn't exist: before its in-service date, or once sediment has filled it | The release still ran, taking the water routed to the absent dam before irrigation, so the unit was supplied less than a unit without a dam (a proposed dam's release cut the baseline years before it is built) | model.md §2.7a, §2.7g |
| ER-16 | run | 1.30.0 | 1.69.0 | Medium | A borehole pumping into a dam (primary, supplemental or emergency) on days the dam doesn't exist: before its in-service date, or once sediment has filled it | The borehole found no room in a dam of 0 m³ and pumped nothing, where a unit without a dam has it pump straight to the crop, so the unit was supplied less | model.md §2.7d, §2.7g |
| ER-17 | run | 0.16.0 | 1.69.0 | Medium | A negative monthly A-pan value in settings (the API accepted any number until 1.69.0) | Dam and river-pool evaporation came out negative, so a dam or river pool gained water from nothing in that month (demand was not affected: it reads MAX(0, A-pan)) | model.md §2.2 Settings out of range, §2.7a |
| ER-18 | run | 0.30.0 | 1.69.0 | Low | A project whose only rain is a rain-source period's series (the alternative gauge, or its fallback), with no catchment, CHIRPS or forecast series | GR4J and demand ran on that rain, but the run had no rain_final, put no rain on the dams, gave no runoff coefficient, didn't warn about days with no rain value, and warned "no rainfall series" | model.md §2.4e |
| ER-19 | run | 1.19.0 | 1.69.0 | Low | A sensitivity run (rain × 0.9 / × 1.1) on a project with a rain-source period | The rain range left the period's series (and a reanalysis fallback) unscaled, so the range under-reported the effect of rain over the period | model.md §2.10g |
| ER-20 | run | 0.21.0 | 1.69.0 | Low | A Reserve rule table keyed by the outlet node's own id rather than "the outlet" | It was listed after the gauges in the Reserve report, and beside a table for "the outlet" the latter was used rather than neither | model.md §2.9c |
| ER-21 | run | 1.19.0 | 1.69.0 | Low | Reserve compliance on a run with a forecast tail (an outlook-style run made directly; a saved forecast run reports the history only) | Each month of the year's daily compliance left out the tail's months, so the twelve didn't add up to the site's daily figures | model.md §2.9c |
| ER-22 | run | 0.3.0 | 1.69.0 | Low | Calibration statistics where the simulated flow is the same every day (the mean flow, or an outlet the network dries out) | KGE, r and R² read "not computed" instead of r = 0: KGE 1 − √2 for the mean flow, 1 − √3 for no flow | model.md §2.10 |
| ER-23 | run | 1.18.0 | 1.69.0 | Medium | A seasonal outlook or review triggers on a full-allocation project (allocation mode full allocation) whose decision or review date lies inside the base record (a hindcast), made from the base run's snapshot (the default) | Every member kept the decision year's factor fitted on the whole real year, days after the decision date included: from 1 October a member asked for more than its prorated registered volume, and later in the year its demand depended on the real record after the decision date | model.md §2.15, §2.15a |
| ER-24 | run | 1.14.0 | 1.69.0 | Low | A river off-take sized to its destination's demand that also tops up the destination's dam (`topUpDam`), on a day the dam received water by a dam rule, or could lose less to evaporation and seepage than the day's full rate (a shallow or leaky dam near empty) | The top-up counted the dam's room without that day's dam-rule receipts and with losses the dam couldn't have, so it took more from the river than fitted, and the extra spilled on arrival (and lost its conveyance losses) | model.md §2.6, §2.6a; found by the engine end-to-end tests |
| ER-25 | run | 0.37.0 | 1.69.0 | Low | A Reserve rule table with high-flow components on a run with a forecast tail that starts mid-month (an outlook-style run made directly) | The water year holding that month was left out of the high-flow assessment, though its events are counted day by day from observed history | model.md §2.9d |
| ER-26 | run | 0.31.1 | 1.69.0 | Low | A farm with registered storage (an s21(b) allocation) but no modelled dam | The storage comparison read "under" (a dam of 0 m³) instead of "none" (no dam to compare) | model.md §2.12 |
| ER-27 | run | 1.25.0 | 1.69.0 | Low | Parameters from automated calibration whose rules left water years out, on a run whose settings don't exclude those years | The run's calibration statistics read as in-sample (fit status "fitted") though they also scored the years the fit never saw | model.md §2.10, §2.10j |
| ER-28 | run | 0.1.0 | 1.69.0 | Low | A simulation or report window date that doesn't exist (29 February in a common year, 31 April; the API accepted any YYYY-MM-DD until 1.69.0) | The date rolled over silently (2001-02-29 ran as 1 March), so the run or the report window started or ended a day or two late; a month of 13 stopped the run | model.md §2.8 |
| ER-29 | run | 0.1.0 | 1.69.0 | Low | A CHIRPS value below 0 (the product's −9999 no-data value, from an upload or a direct input; the feed drops it) on a day with no catchment rain | It counted as CHIRPS rain: the day ran as 0 mm instead of falling through to forecast rain, and `rain_final` showed the negative value × the factor | model.md §2.4b |
