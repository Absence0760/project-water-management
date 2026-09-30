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

**Adding one.** Add a row to the table below: a new `ER-<n>` id (never reuse
one), the first affected version, the version that fixed it (`open` while it
isn't), the conditions under which results change, and where it is
documented. Then run `pnpm gen:liability`;
`packages/engine/src/liability/errata.test.ts` fails until you do.

## Errata

| ID | First affected | Fixed in | Severity | Applies when | What goes wrong | Source |
| --- | --- | --- | --- | --- | --- | --- |
| ER-1 | 0.0.0 | 0.7.0 | High | Catchment rain has blank days that CHIRPS filled | CHIRPS filled the gaps without bias correction, so a filled year could run far too dry or wet | engine-audit.md B1; model.md §2.4b |
| ER-2 | 0.0.0 | 0.15.0 | High | Missing catchment rain was recorded as zeros | A run of zeros counted as dry days and blocked the CHIRPS fill, running the catchment dry over those days | engine-audit.md B2; model.md §2.4c |
| ER-3 | 0.15.0 | 0.20.0 | Medium | A run ends in a zero-rain run set aside as missing whose reading day holds a multi-day accumulation | The run was filled from CHIRPS and the accumulated reading was also kept, so that rain was counted twice | engine-audit.md B4; model.md §2.4d |
| ER-4 | 0.0.0 | 0.27.1 | High | Flow shares (manual, or a high/low split) add up to more than the catchment | The run went ahead and the farms made more runoff than the catchment's natural flow, lifting the outflow and hiding EWR failures | model.md §2.5 (overAllocationError) |
| ER-5 | 0.0.0 | 0.45.0 | High | Simulation start or end unset, and the rain series padded with blanks beyond its readings | The default run window covered the blanks, which ran as 0 mm and distorted every whole-run figure | engine-audit.md D1; model.md §2.1 |
| ER-6 | 0.5.0 | 1.22.0 | Medium | An automatic calibration on a record with suspect days or flood days beyond the gauged range | Those days weighed in the fit's objective like any other, so a fit could chase a stuck logger or a rating-curve extrapolation | engine-audit.md C2; model.md §2.10h |
