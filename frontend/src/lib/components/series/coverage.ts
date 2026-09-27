// Data-coverage statistics for input time series: period, gaps, typical
// magnitude, staleness, and what an "append / update" upload would change.
import { fromEpochDay, toEpochDay } from '@water-management/engine';

export interface Daily {
	startDate: string;
	values: (number | null)[];
}

export interface CoverageStats {
	startDate: string;
	endDate: string;
	days: number;
	/** Days carrying a value. */
	present: number;
	/** 0–100. */
	missingPct: number;
	/** Mean of the days present (mm/day for rain, m³/s for flow). */
	meanDaily: number | null;
	/** Depth series only (rain, daily A-pan evaporation): mean daily × 365.25, mm/a. */
	meanAnnualMm: number | null;
	/** Last day that carries a value (null if none). */
	lastValueDate: string | null;
}

const isRain = (kind: string) => kind.endsWith('_mm');

export function coverageStats(s: Daily, kind: string): CoverageStats {
	const n = s.values.length;
	let present = 0;
	let sum = 0;
	let last = -1;
	for (let i = 0; i < n; i++) {
		const v = s.values[i];
		if (v == null || !Number.isFinite(v)) continue;
		present++;
		sum += v;
		last = i;
	}
	const d0 = toEpochDay(s.startDate);
	const meanDaily = present ? sum / present : null;
	return {
		startDate: s.startDate,
		endDate: fromEpochDay(d0 + Math.max(n, 1) - 1),
		days: n,
		present,
		missingPct: n ? ((n - present) / n) * 100 : 0,
		meanDaily,
		meanAnnualMm: isRain(kind) && meanDaily !== null ? meanDaily * 365.25 : null,
		lastValueDate: last >= 0 ? fromEpochDay(d0 + last) : null
	};
}

export interface CoverageBin {
	/** First and last day (ISO) of the bin. */
	from: string;
	to: string;
	/** Share of the bin's days that carry a value, 0–1. */
	frac: number;
}

/**
 * Bin a series into calendar years (or months when it spans under three
 * years) with the share of days present in each: the data for a gap strip.
 */
export function coverageBins(s: Daily): CoverageBin[] {
	const n = s.values.length;
	if (n === 0) return [];
	const d0 = toEpochDay(s.startDate);
	const byMonth = n < 3 * 365;
	const key = (day: number) => {
		const iso = fromEpochDay(day);
		return byMonth ? iso.slice(0, 7) : iso.slice(0, 4);
	};
	const bins: CoverageBin[] = [];
	let curKey = key(d0);
	let from = d0;
	let have = 0;
	let total = 0;
	const flush = (lastDay: number) =>
		bins.push({ from: fromEpochDay(from), to: fromEpochDay(lastDay), frac: total ? have / total : 0 });
	for (let i = 0; i < n; i++) {
		const day = d0 + i;
		const k = key(day);
		if (k !== curKey) {
			flush(day - 1);
			curKey = k;
			from = day;
			have = 0;
			total = 0;
		}
		total++;
		const v = s.values[i];
		if (v != null && Number.isFinite(v)) have++;
	}
	flush(d0 + n - 1);
	return bins;
}

/** Whole days from `iso` to `todayIso` (both YYYY-MM-DD). */
export function daysBetween(iso: string, todayIso: string): number {
	return toEpochDay(todayIso) - toEpochDay(iso);
}

/** 0 → "today", 1 → "yesterday", 12 → "12 days ago", 75 → "2 months ago", 800 → "2 years ago". */
export function describeAge(days: number): string {
	if (days < 0) return 'in the future';
	if (days === 0) return 'today';
	if (days === 1) return 'yesterday';
	if (days < 60) return `${days} days ago`;
	// At least 2: 60 days is under two 30.44-day months and 730 under two years, which read "1 months" / "1 years".
	if (days < 730) return `${Math.max(2, Math.floor(days / 30.44))} months ago`;
	return `${Math.max(2, Math.floor(days / 365.25))} years ago`;
}

export interface MergePreview {
	/** Days that get a value where the stored series had none (or didn't reach). */
	added: number;
	/** Days whose stored value changes. */
	changed: number;
	/** Those days, oldest first: the stored value and the file's. */
	changes: { date: string; from: number; to: number }[];
	/** Days in the file equal to what is stored. */
	unchanged: number;
	/** Resulting series. */
	result: Daily;
}

/**
 * What an append/update upload does: file values win on the days they cover,
 * the series extends in either direction, and — unlike a raw merge — days the
 * file leaves blank keep their stored value (so a partial file can't erase
 * readings). `result` is what to send to POST …/series/merge.
 */
export function mergePreview(existing: Daily | null, incoming: Daily): MergePreview {
	const i0 = toEpochDay(incoming.startDate);
	if (!existing || existing.values.length === 0) {
		const added = incoming.values.filter((v) => v != null).length;
		return { added, changed: 0, changes: [], unchanged: 0, result: { startDate: incoming.startDate, values: [...incoming.values] } };
	}
	const e0 = toEpochDay(existing.startDate);
	const start = Math.min(e0, i0);
	const end = Math.max(e0 + existing.values.length, i0 + incoming.values.length); // exclusive
	const out: (number | null)[] = new Array(end - start).fill(null);
	existing.values.forEach((v, k) => (out[e0 - start + k] = v));
	let added = 0;
	let changed = 0;
	let unchanged = 0;
	const changes: MergePreview['changes'] = [];
	incoming.values.forEach((v, k) => {
		if (v == null) return;
		const idx = i0 - start + k;
		const old = out[idx];
		if (old == null) added++;
		else if (old === v) unchanged++;
		else {
			changed++;
			changes.push({ date: fromEpochDay(i0 + k), from: old, to: v });
		}
		out[idx] = v;
	});
	return { added, changed, changes, unchanged, result: { startDate: fromEpochDay(start), values: out } };
}
