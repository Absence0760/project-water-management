# Engine algorithm review (2026-09)

This is a hydrologist and numerical-methods review of `packages/engine/src`. It
compares the code with `docs/model.md` and with the **actual workbook cells**:
`Blank_WBT_b023_v001.xlsm`, `Client_WBT_b023_v001_…007.xlsm`, and the
LAMBDA definitions in the workbook's named ranges, all read with openpyxl.

**Status: partial.** The session ended early. The sections marked *not
reviewed* still need a pass. No engine code was changed in this round.

## Findings

| # | Severity | Where | Finding | Evidence | Fix |
| --- | --- | --- | --- | --- | --- |
| F1 | **High** (only with more than one transfer from the same dam) | `network/simulate.ts:386-395` | Simultaneous transfers from one source dam are each capped by *yesterday's full* storage minus the reserve. Together they can take more than the dam holds, so `avail`, supplied (G), P and storage (Q) go **negative**. | Source storage 1 000 m³, reserve 0, two enabled rules of 800 m³/day in the same month: 1 600 m³ leaves, and `avail = 1000 − 1600 + inflows`. The workbook's independent "Draw From" columns (`fGetTrfVolCapped`) do the same. client catchment has one transfer, so the regression can't show it. | Keep a running "still available" figure per source and take the rules in order (`v = min(cap, max(prev − reserve − alreadyDrawn, 0))`). This is a no-op whenever the draws fit, so client catchment stays exact. Write the failing test first. The priority rule goes to the hydrologist: docs/model.md **Q18**. |
| F2 | Medium (docs) | `docs/model.md` §2.7 rows Z/AB, quirk Q4 | The doc said `Z = Y` and `AB = MIN(AA, 0)`. The workbook has `Z = Y + Σ upstream Z` and `AB = MIN(AA − Σ upstream AA, 0)` (e.g. `FarmC!Z17 = Y17+FarmA!Z17+FarmB!Z17`, `AB17 = MIN(AA17-(FarmA!AA17+FarmB!AA17),0)`). The engine and `network/README.md` were already right. | client catchment Element sheets, row 17 and row 22 | **Fixed** in model.md §2.7 and Q4. |
| F3 | Medium (hydrology, faithful) | `simulate.ts:443-445`, curtailment R | Incremental shortfalls don't add up to the outlet shortfall. AA is clamped at 0, so a surplus on one branch never offsets a deficit on another, and a farm that adds water gets no credit. | Example in model.md **Q17** (Σ AB = −100 while the outlet meets the EWR) | Question for the hydrologist (Q17). Don't change the engine. |
| F4 | Low (workbook bug, not in the engine) | client catchment `[Farm spec]` M32, M33, M42 | "Selected fragmentation" is hard-coded to the area share for Farm B, Farm C and Farm D, whatever method is chosen. | `M32 = G32/rFarmSpec_AreaTotal`, while the other rows use `IF(method…)` | Documented as **Q16**. The engine applies the chosen method to every farm, which is the intended behaviour. |
| F5 | Low | `network/round.ts` vs `flow.ts:75` | There are two `excelRound` implementations. `round.ts` nudges by `y·4e-16`; `flow.ts` uses `toPrecision(15)` string shifting. They agree on every client catchment value, but they can differ on an x.5 boundary after 15 significant digits. | Code inspection | Use one implementation, `flow.ts`'s 15-significant-digit version, which is closer to Excel. Run the regression suite to prove it changes nothing. Not done. |
| F6 | Low (benign deviation) | `flow.ts:128,166,222` | The engine guards divisions that give `#DIV/0!` in the workbook: `fRfIndex` with a flat curve segment, `fIndxAddedFlow` with amplitude 0, `fBaseFlow` with receded base 0. The workbook would fill every later row with errors. | LAMBDA text of `fRfIndex`, `fIndxAddedFlow`, `fBaseFlow` | Keep the guards. They are documented here. |
| F7 | Info | `demand.ts` / area share | The share and `RainToM3` use `node.areaKm2` (workbook G, which client catchment types in, not `I+J`). The Hi/Lo method uses `areaHiKm2`/`areaLoKm2`. In the app these can drift apart, with no warning when `areaKm2 ≠ hi + lo`. | client catchment G31 = 29.3, I31 + J31 = 29.395 | Consider a data-quality warning when \|areaKm2 − (hi + lo)\| is larger than 1%. |

## Verified OK (against the cells)

- **Units:** `RainToM3 = area km² × 10⁶ / 1000` (mm × km² → m³, `[Flow data]` P8). m³/s → m³/day uses `×86 400` (`AppSettings` C140). l/s uses `÷86.4`. Crop mm × m² ÷ 1000 → m³. The effective-rain offset is `area × (eff/1000) × rain`, in the same operand order as `[Irrigation Demand]` C12 × F9. The Mm³ conversions in stats and quality are right.
- **Calendar:** days per month are 31/30/31/31/**28.25**/…, taken from `AppSettings` D96:D107 and indexed through `[Farm demand]` Q17:AB17. The water-year index `(m+2) % 12` equals `MOD(M+2,12)+1` (`zEWR_Pragmatic`, `[Flow data]` AF). Epoch-day maths is all UTC (`Date.parse(…Z)`, `getUTCMonth`), so there are no local-time bugs. Leap days get the February demand rate.
- **Rounding placement:** crop mm `ROUND(,2)`, farm m³/day `ROUND(,1)`, net demand `ROUND(,0)`, fragments `ROUND(,rFR_Round=0)`, L/M/T `ROUND(,0)`, capacity `ROUND(P,0)`, initial storage `ROUND(Q14×P14,0)`, rain flow `INT`, base `ROUND(,0)`, indices `ROUND(,4)`, transfer cap `ROUND(rate×86400,0)`, and the transfer reserve on the **unrounded** capacity (`fGetDamCapacity`). All of these match. Every operation that follows a rounding step is an integer operation, so no rounding error builds up over 16k days.
- **Rain used (R):** the first non-blank of catchment / CHIRPS / forecast, then the threshold test (`>`). This matches `[Flow data]` R21 exactly, including that a present-but-light catchment value hides a larger CHIRPS value.
- **Flow LAMBDAs:** `fRecede` (with the extrapolation below index 1 on day 1), `fRfIndex` (MATCH −1 → last position with a value ≥ flow, `#N/A` → 1), `fIndxAddedFlow`, `fRespAddedFlow`, `fBaseFlow` (a blank previous index = 0 on day 1) and `fSorW2` all match the code, apart from F6.
- **Farm balance:** columns F–AB match the client catchment row-17 formulas term for term. The gauge (`Gauge`) is `G = ΣU`, `H = ΣZ`, `I = ΣAA`. Transfers draw from the source's `Q[t−1]` (row N−1) and the InOut columns are ±draw.
- **Topology:** a post-order DFS gives upstream-first for any tree. Gauges in the middle of the network pass flow through. Nodes with no area get share 0. Cycles, unknown links and self-links throw.
- **Calibration stats:** NSE, PBIAS (positive = under-estimate), RMSE, KGE 2009 with population σ, R² = r², log-NSE with ε = ō/100 (Pushpalatha et al. 2012) and the Moriasi 2007 thresholds agree with the literature. Blank or NaN observations are skipped. Constant observations give null rather than NaN.
- **Curtailment:** matches `[Shortfalls]` row 11 (H, I, J, K, M, N, O, P, R, S, T, U, V). K_tot uses the rounded averages and has a zero guard (Q14).
- **Performance:** every daily loop is O(days × nodes + days × transfers). Nothing is O(n²) over days.

## Not reviewed (session ended)

- `compare.ts` in detail. From a skim: matching is id-then-name and deltas are b − a. `reportStart/End`, `calibration*` and `calibrationFlowKind` settings only show up as generic "Setting X changed" lines.
- `quality.ts` edge cases (negative flows, `minDays` when a series ends part-way through a year).
- `ewr.ts` compliance grid beyond a code read: the daily vs running-total logic looked right.
- Fuzzing with a seeded PRNG (random trees, zero areas, share sums ≠ 1, transfer chains A→B→C, transfers to an upstream farm) and a mass-balance check (column V = 0) over random networks.
