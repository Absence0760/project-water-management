// Excel-compatible rounding, kept only so tests can replay b023 workbook cells
// (curtailment.test.ts).
//
// The engine itself never rounds (docs/engine-audit.md R1): the workbook's
// ROUND/INT steps stopped recessions at arbitrary floors, created or lost
// water when a flow was split, and zeroed small dams. Presentation (UI,
// exports) rounds for display. Don't call these from model code.

/**
 * Excel `ROUNDDOWN(x, digits)`: truncate toward zero, on the 15-significant-
 * digit value Excel sees (so 8.64 / 86.4 → 0.1, not 0.0). Never returns -0.
 */
export function excelRoundDown(x: number, digits = 0): number {
	if (!Number.isFinite(x)) return x;
	const sign = x < 0 ? -1 : 1;
	const abs = Number(Math.abs(x).toPrecision(15));
	const f = 10 ** digits;
	const r = Math.floor(Number((abs * f).toPrecision(15)));
	if (r === 0) return 0;
	return (sign * r) / f;
}
