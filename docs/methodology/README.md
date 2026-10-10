# Methodology statements

The methodology statement says, in one document an assessor can read, how
the app turns a catchment's inputs into the results a report or an evidence
pack prints: the model's structure, the methods behind each result, the
assumptions and what the model leaves out. It is the "how" behind every
number; [model.md](../model.md) is the full reference it summarises.

## Versions

Each version is its own file, `v<N>.md`, and **a published version is never
edited**. A change of wording or substance is a new file (`v2.md`, …), and
the old one stays, because a sign-off or an evidence pack records the version
and the SHA-256 of the exact bytes it was made under (roadmap
[WP-3.13](../roadmap/step-3-licensing.md#wp-313-liability-and-credibility-disclaimers-validation-statement-sign-off),
[WP-3.14](../roadmap/step-3-licensing.md#wp-314-licence-evidence-pack)).
Anyone holding a pack can hash the file at the engine's tag and compare.

| Version | Written | For engines | Notes |
| --- | --- | --- | --- |
| [v1](./v1.md) | 2026-09-29 | 1.30.0 – 1.71.0 | First statement (issue #71) |
| [v2](./v2.md) | 2026-10-03 | 1.72.0 – 1.76.0 | §4: irrigation systems per crop and unit; the return flow a share of the water supplied (audit N1) |
| [v3](./v3.md) | 2026-10-08 | 1.77.0 | §5: the daily EWR at the outlet may come from the DRM TAB file or percentile tables, scaled by MAR or area (issue #455) |
| [v4](./v4.md) | 2026-10-09 | 1.78.0 – 1.79.0 | §2, §3, §8: runoff from each unit's own rain, opt-in (issue #482) |
| [v5](./v5.md) | 2026-10-10 | ≥ 1.80.0 | §2: a reference rain gauge's monthly factors level every unit's CHIRPS, then the MAP ratio (issue #500, provisional) |

The highest version is the current one: new sign-offs and packs cite it.

## How it reaches the app

`pnpm gen:liability` (`packages/engine/scripts/gen-liability.ts`) writes
`packages/engine/src/liability/methodology.generated.ts`: every version's id
and SHA-256, and the current version's text. The validation statement and
the sign-off statement cite the current version and its hash.
`packages/engine/src/liability/methodology.test.ts` recomputes each file's
hash and fails when the generated module is stale, and when a published
version's hash has changed (an edit to a version already cited).

## Related

- [engine-errata.md](../engine-errata.md): known engine bugs per version,
  printed with every run of an affected version.
- [engine-audit.md](../engine-audit.md): the open audit items, printed as the
  known limitations.
- [disclaimer-review.md](../legal/disclaimer-review.md): the disclaimer, a
  separate versioned text.
