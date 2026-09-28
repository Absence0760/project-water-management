// Excel-compatible rounding, kept only so tests can replay b023 workbook cells.
//
// The engine itself never rounds (docs/engine-audit.md R1): the workbook's
// ROUND/INT steps stopped recessions at arbitrary floors, created or lost
// water when a flow was split, and zeroed small dams. Presentation (UI,
// exports) rounds for display. Don't call these from model code.

/**
 * Excel `ROUND(x, digits)`: half away from zero, applied to the value as Excel
 * sees it (15 significant digits), so 2.675 → 2.68 and 1.005 → 1.01 rather
 * than JS's 2.67 and 1.
 */
export function excelRound(x: number, digits = 0): number {
	if (!Number.isFinite(x)) return x;
	const sign = x < 0 ? -1 : 1;
	const abs = Number(Math.abs(x).toPrecision(15));
	const text = String(abs);
	if (text.includes('e')) {
		// Tiny or huge magnitudes: shifting by string would be malformed; the
		// decimal-representation issue ROUND guards against doesn't arise there.
		const f = 10 ** digits;
		return (sign * Math.round(abs * f)) / f;
	}
	// Shift the decimal point textually so 1.005 → 100.5 exactly, not 100.4999….
	const scaled = Math.round(Number(`${text}e${digits}`));
	const out = sign * Number(`${scaled}e${-digits}`);
	return out === 0 ? 0 : out;
}

/**
 * Excel `ROUNDDOWN(x, digits)`: truncate toward zero, on the 15-significant-
 * digit value like excelRound (so 8.64 / 86.4 → 0.1, not 0.0). Never returns -0.
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
