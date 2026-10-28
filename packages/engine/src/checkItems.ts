// A data-check item's id (issue #611): `<check>:<seriesId>:<start>:<end>`,
// the period one data check flagged on one stored series. settings.checksKept
// lists the items the user kept as recorded. Its own module, with no imports
// but the calendar, so ./calibrate/provenance.ts and ./calibrate/dayFlags.ts
// can read it without an import cycle through ./recordPeriods.ts.
import { isIsoDate, toEpochDay } from './calendar';

/** Most items settings.checksKept may list: 300 ids (about 75 characters each, some 22 KB) leave most of the API’s 64 KB settings patch to the other settings, which the Settings form sends with them. */
export const CHECKS_KEPT_MAX = 300;

/** The data checks whose kept items (settings.checksKept) clear a flow day's suspect class. */
export const KEPT_SUSPECT_CHECKS: ReadonlySet<string> = new Set(['outlier', 'flatline']);

/** A data-check item id, `<check>:<seriesId>:<start>:<end>`, in its parts. */
export interface CheckItemRef {
	check: string;
	seriesId: string;
	start: string;
	end: string;
}

/** The parts of a data-check item id; null when it isn't one (four parts, two dates in order). */
export function parseCheckItemId(id: string): CheckItemRef | null {
	if (typeof id !== 'string') return null;
	const parts = id.split(':');
	if (parts.length !== 4) return null;
	const [check, seriesId, start, end] = parts as [string, string, string, string];
	if (!check || !seriesId || !isIsoDate(start) || !isIsoDate(end) || start > end) return null;
	return { check, seriesId, start, end };
}

/** The epoch-day ranges, inclusive, of the kept outlier and flat-stretch items of one record (settings.checksKept). */
export function keptSuspectRanges(checksKept: readonly string[] | null | undefined, seriesId: string | null | undefined): [number, number][] {
	if (!seriesId || !checksKept?.length) return [];
	const out: [number, number][] = [];
	for (const id of checksKept) {
		const r = parseCheckItemId(id);
		if (r && r.seriesId === seriesId && KEPT_SUSPECT_CHECKS.has(r.check)) out.push([toEpochDay(r.start), toEpochDay(r.end)]);
	}
	return out;
}
