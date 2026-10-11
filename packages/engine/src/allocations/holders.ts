// Who holds the volumes in a total (issue #523 G, decision D3, provisional
// position, pre-counsel research 2026-10-01; docs/allocations.md § Who sees
// what). A total of registered volumes shown to someone kept from each one is
// shown only when the rows summed into it are held by FARMER_K (5) or more
// registered users. The rows summed are those in force on the day or in the
// water year the total is of, so the holders are counted over the same rows:
// a source's holders over all its rows, whatever their dates, could be 5
// while one holder's row is the only one in force (a total that is one
// holder's volume).
//
// The dominance rule (provisional, pending the CISO and counsel's D3 review,
// issue #92): a sum of 5 or more holders is still withheld when one of them
// holds more than 80 % of it, or two of them more than 90 % (the second limb
// keeps a reader who knows one holder's volume, such as an applicant's own,
// from reading the largest of the rest as the sum less theirs).
import { toEpochDay } from '../calendar';
import { FARMER_K } from '../views/farmView';

/** The dominance rule's limits (provisional, #92): the largest holder's share, and the two largest holders' share, of a sum shown. */
export const DOMINANCE_TOP1 = 0.8;
export const DOMINANCE_TOP2 = 0.9;

/** One registered volume with its holder (an opaque key: the backend's app_allocation_volumes / app_run_allocation_holders, 215). */
export interface HeldVolume {
	holder: string | number;
	volumeM3PerYear: number;
	waterUse?: string | null;
	/** First day it applies (ISO, inclusive); null/absent = open. */
	validFrom?: string | null;
	/** Last day it applies (ISO, inclusive); null/absent = open. */
	validTo?: string | null;
}

/** Whether a row takes water (not s21b storage only, a volume above 0) on any day of [from, to] (ISO, inclusive). */
export const takesWithin = (r: HeldVolume, from: string, to: string): boolean =>
	r.waterUse !== '21b' && r.volumeM3PerYear > 0 && (!r.validFrom || r.validFrom <= to) && (!r.validTo || r.validTo >= from);

/** The registered users whose takes are in force on any day of [from, to]: the holders behind a total over those days. */
export const holdersWithin = (rows: readonly HeldVolume[], from: string, to: string): number => new Set(rows.filter((r) => takesWithin(r, from, to)).map((r) => r.holder)).size;

/**
 * Whether a sum may be shown to someone kept from each volume, given each
 * holder's part of it: none at all (it is 0), or FARMER_K or more holders
 * with a part above 0, none of them above DOMINANCE_TOP1 of the sum and no
 * two above DOMINANCE_TOP2.
 */
export function totalShown(parts: Iterable<number>): boolean {
	const p = [...parts].filter((v) => v > 0).sort((a, b) => b - a);
	if (!p.length) return true;
	if (p.length < FARMER_K) return false;
	const total = p.reduce((s, v) => s + v, 0);
	return p[0]! <= DOMINANCE_TOP1 * total && p[0]! + p[1]! <= DOMINANCE_TOP2 * total;
}

/** Each holder's takes in force over [from, to] (ISO, inclusive): volume × days in force there (a share of the sum, whatever the unit). */
export function amountsWithin(rows: readonly HeldVolume[], from: string, to: string): Map<string | number, number> {
	const lo = toEpochDay(from);
	const hi = toEpochDay(to);
	const out = new Map<string | number, number>();
	for (const r of rows) {
		if (!takesWithin(r, from, to)) continue;
		const a = Math.max(lo, r.validFrom ? toEpochDay(r.validFrom) : lo);
		const b = Math.min(hi, r.validTo ? toEpochDay(r.validTo) : hi);
		if (b >= a) out.set(r.holder, (out.get(r.holder) ?? 0) + r.volumeM3PerYear * (b - a + 1));
	}
	return out;
}

/** Whether the sum of `rows`' takes over [from, to] may be shown (totalShown over each holder's part of it). */
export const shownWithin = (rows: readonly HeldVolume[], from: string, to: string): boolean => totalShown(amountsWithin(rows, from, to).values());

/** The days of water year `wy` (October–September, labelled by the year it starts in) inside [start, end] (ISO); null when none. */
export function waterYearWithin(wy: number, start: string, end: string): { from: string; to: string } | null {
	const a = `${wy}-10-01`;
	const b = `${wy + 1}-09-30`;
	const from = a > start ? a : start;
	const to = b < end ? b : end;
	return from <= to ? { from, to } : null;
}
