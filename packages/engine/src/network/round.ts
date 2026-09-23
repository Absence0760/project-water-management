// Excel-compatible rounding. The b023 workbook rounds at fixed points in the
// chain (fragmented flow, demand, dam splits, return flow); reproducing those
// exactly is what lets the engine match the workbook to the cubic metre.

const POW10 = [1, 10, 100, 1000, 10_000, 100_000, 1_000_000];

/**
 * Excel `ROUND(x, digits)`: half away from zero, and tolerant of binary
 * representation error (Excel rounds 2.675 to 2.68 because it works to 15
 * significant digits; plain `Math.round(267.49999999999997)` would give 267).
 */
export function excelRound(x: number, digits = 0): number {
	const f = POW10[digits] ?? 10 ** digits;
	const y = Math.abs(x) * f;
	// Nudge by a few ulps so values that are .5 in decimal but .4999… in binary round up.
	const r = Math.floor(y + 0.5 + y * 4e-16);
	const out = r / f;
	return x < 0 ? -out : out;
}

/**
 * Rounding precision the b023 workbook uses at each step. They are workbook
 * cells (e.g. `rFR_Round`, `zFarmDemand_Round`) but identical in every b023
 * workbook we have seen, so they are constants rather than project settings.
 */
export const WBT_PRECISION = {
	/** [Crop demand] gross crop requirement, mm (`rCropDemand_CalcPrecision`). */
	cropGrossMm: 2,
	/** [Farm demand] gross farm demand, m³/day (`zFarmDemand_Round`). */
	farmDemandM3Day: 1,
	/** [Irrigation Demand] daily net demand, m³/day (`rID_Round`). */
	netDemandM3Day: 0,
	/** [Fragmented flow] / [Fragmented EWR] per-farm share, m³/day (`rFR_Round`). */
	fragmentedM3Day: 0
} as const;
