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
