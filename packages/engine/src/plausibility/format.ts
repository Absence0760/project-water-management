// Numbers in the plausibility warnings' text. A flow or volume gets fixed
// decimals, except that a small non-zero value those decimals would show with
// fewer than two significant figures gets two significant figures instead:
// a warning once read "Q90 is 0.000 m³/s … 5.6× lower" (issue #45), which is
// both unreadable and looks like a contradiction. The frontend's fmtQty
// (frontend/src/lib/format/number.ts) applies the same rule on screen.

/** `v` to `decimals` places, or two significant figures when that would hide it: amount(0.00042, 3) → "0.00042". */
export function amount(v: number, decimals: number): string {
	const a = Math.abs(v);
	if (a === 0) return '0';
	if (a >= 1 || a >= 10 ** (1 - decimals)) return v.toFixed(decimals);
	if (a < 1e-6) return v.toExponential(1);
	return String(Number(v.toPrecision(2)));
}

/** A flow in m³/s as the warnings write it: 2 decimals from 1 m³/s, 3 below, significant figures when smaller still. */
export const flowText = (m3s: number) => amount(m3s, m3s >= 1 ? 2 : 3);
