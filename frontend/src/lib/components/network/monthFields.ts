// The twelve water-year month fields of the one-node form (./MonthFields.svelte):
// the dam release, a demand object's demand or profile, an other water user's
// demand, the hands-off flow and River to dam by month. What an edit and the
// fill button write, kept out of the component so it is tested. Pure: no Svelte.
import { fmtNum } from '$lib/format/number';

/** Twelve copies of `v`: a monthly row that starts as one value all year. */
export const monthsOf = (v: number): number[] => new Array<number>(12).fill(v);

/**
 * The row with month `i` (water-year order) set to `v`; a cleared field
 * (null) writes `blank`. A missing row (or one of the wrong length) starts as
 * `blank` in every month, so the result always has 12 values.
 */
export function withMonth(row: readonly number[] | null | undefined, i: number, v: number | null, blank = 0): number[] {
	const next = Array.from({ length: 12 }, (_, k) => row?.[k] ?? blank);
	next[i] = v ?? blank;
	return next;
}

/** October's value (the first in water-year order) in every month; `blank` when there is none. */
export const fillFromFirst = (row: readonly number[] | null | undefined, blank = 0): number[] => monthsOf(row?.[0] ?? blank);

/**
 * What the fill button's live line says: which value went into every month,
 * as the fields show it (× `scale`), and which row: "Copied October’s 150 to
 * every month of Demand, m³/day, per month."
 */
export function fillMessage(row: readonly number[] | null | undefined, blank: number, scale: number, caption: string): string {
	const v = Math.round((row?.[0] ?? blank) * scale * 1e9) / 1e9;
	return `Copied October’s ${fmtNum(v, 4, true)} to every month of ${caption}.`;
}
