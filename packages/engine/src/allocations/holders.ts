// Who holds the volumes in a total (issue #523 G, decision D3, provisional
// position, pre-counsel research 2026-10-01; docs/allocations.md § Who sees
// what). A total of registered volumes shown to someone kept from each one is
// shown only when the rows summed into it are held by FARMER_K (5) or more
// registered users. The rows summed are those in force on the day or in the
// water year the total is of, so the holders are counted over the same rows:
// a source's holders over all its rows, whatever their dates, could be 5
// while one holder's row is the only one in force (a total that is one
// holder's volume).
import { FARMER_K } from '../views/farmView';

/** One registered volume with its holder (an opaque key: the backend's app_allocation_volumes / app_allocation_holders, 215). */
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

/** Whether a sum over `holders` registered users may be shown to someone kept from each volume: none at all (it is 0), or FARMER_K or more. */
export const totalShown = (holders: number): boolean => holders === 0 || holders >= FARMER_K;

/** The days of water year `wy` (October–September, labelled by the year it starts in) inside [start, end] (ISO); null when none. */
export function waterYearWithin(wy: number, start: string, end: string): { from: string; to: string } | null {
	const a = `${wy}-10-01`;
	const b = `${wy + 1}-09-30`;
	const from = a > start ? a : start;
	const to = b < end ? b : end;
	return from <= to ? { from, to } : null;
}
