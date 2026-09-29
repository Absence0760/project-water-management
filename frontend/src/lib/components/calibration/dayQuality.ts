// The data-quality panel of a fit (calibration research CR-22, engine ≥
// 1.20.0): the per-day quality flags of the fitted record and its rain, as
// table rows and words. Pure, so it is unit-tested; DataQualityPanel.svelte
// renders it. No run-time engine import: the constants below mirror
// calibrate/dayFlags.ts (FLOW_DAY_FLAGS, FLAG_USE_TEXT), so the Fit panel's
// chunk stays free of the model code (issue #9); dayQuality.test.ts checks
// they agree.
import type { AboveRatingUse, DayQuality, FlowDayFlag } from '@water-management/engine';
import { fmtNum } from '$lib/format/number';

/** The flow classes in the order the panel lists them, with how each is named. */
export const FLOW_ROWS: { flag: FlowDayFlag; label: string }[] = [
	{ flag: 'inRange', label: 'In the gauged range' },
	{ flag: 'aboveRating', label: 'Above the highest gauging' },
	{ flag: 'belowRating', label: 'Below the lowest gauging' },
	{ flag: 'suspect', label: 'Suspect (outlier or flat stretch)' },
	{ flag: 'infilled', label: 'Infilled' },
	{ flag: 'humanUse', label: 'Human use dominant' },
	{ flag: 'missing', label: 'Missing' }
];

export const USE_TEXT: Record<AboveRatingUse, string> = {
	censor: 'censored at the highest gauging',
	exclude: 'left out',
	include: 'scored as recorded'
};

export interface DayQualityRow {
	label: string;
	days: string;
	/** Share of the window's days, "12.3 %". */
	share: string;
	/** What the fit did with them. */
	treatment: string;
}

/** "12.3 %" of a whole; "–" of none; "<0.1 %" for a sliver, so it never reads as nothing. */
export function shareText(n: number, of: number): string {
	if (of <= 0) return '–';
	const p = (100 * n) / of;
	return n > 0 && p < 0.05 ? '<0.1 %' : `${fmtNum(p, 1)} %`;
}

/** What the fit does with a class's days under the report's settings. */
function treatment(q: DayQuality, flag: FlowDayFlag): string {
	switch (flag) {
		case 'inRange':
			return 'scored';
		case 'humanUse':
			return 'scored (not derived yet)';
		case 'missing':
			return 'no reading';
		case 'aboveRating':
			return USE_TEXT[q.use.aboveRating];
		default:
			return USE_TEXT[q.use[flag]];
	}
}

/**
 * One row per flow class with days in the window. "In the gauged range"
 * reads "Not flagged" when no gauged range is recorded: nothing says those
 * days are inside it. Human-use days are listed only when there are any
 * (nothing sets them yet).
 */
export function flowRows(q: DayQuality): DayQualityRow[] {
	return FLOW_ROWS.filter((r) => q.flow[r.flag] > 0 || (r.flag !== 'humanUse' && r.flag !== 'infilled' && r.flag !== 'missing')).map((r) => ({
		label: r.flag === 'inRange' && !q.rating ? 'Not flagged (no gauged range recorded)' : r.label,
		days: fmtNum(q.flow[r.flag]),
		share: shareText(q.flow[r.flag], q.windowDays),
		treatment: treatment(q, r.flag)
	}));
}

/** The scored days' rain by source, or null without rain. */
export function rainRows(q: DayQuality): { label: string; days: string; share: string }[] | null {
	if (!q.rain) return null;
	const r = q.rain;
	const rows = [
		{ label: 'Catchment gauge reading', n: r.observed },
		{ label: 'Infilled (CHIRPS, forecast or another gauge)', n: r.infilled },
		{ label: 'Missing', n: r.missing }
	];
	const out = rows.filter((x) => x.n > 0 || x.label === 'Catchment gauge reading').map((x) => ({ label: x.label, days: fmtNum(x.n), share: shareText(x.n, q.scoredDays) }));
	if (r.zeroRunDays > 0) out.push({ label: 'of which zero-rain runs set aside as missing', days: fmtNum(r.zeroRunDays), share: shareText(r.zeroRunDays, q.scoredDays) });
	return out;
}

/** "1 204 of 1 461 days scored · 31 left out · 12 censored": the panel's one-line gist. */
export function dayQualityGist(q: DayQuality): string {
	const withReading = q.windowDays - q.flow.missing;
	const parts = [`${fmtNum(q.scoredDays)} of ${fmtNum(withReading)} observed day${withReading === 1 ? '' : 's'} scored`];
	if (q.leftOutDays) parts.push(`${fmtNum(q.leftOutDays)} left out`);
	if (q.censoredDays) parts.push(`${fmtNum(q.censoredDays)} censored`);
	return parts.join(' · ');
}

/** "Gauged range 0.05–12 m³/s (DWS gaugings)", or that none is recorded. */
export function ratingLine(q: DayQuality): string {
	const r = q.rating;
	if (!r) return 'No gauged range recorded for this record.';
	const v = (x: number) => fmtNum(x, x >= 100 ? 0 : x >= 1 ? 2 : 3);
	const range =
		r.gaugedMaxM3s !== null && r.gaugedMinM3s !== null
			? `${v(r.gaugedMinM3s)}–${v(r.gaugedMaxM3s)} m³/s`
			: r.gaugedMaxM3s !== null
				? `up to ${v(r.gaugedMaxM3s)} m³/s`
				: `from ${v(r.gaugedMinM3s!)} m³/s`;
	return `Gauged range ${range}${r.source ? ` (${r.source})` : ''}.`;
}
