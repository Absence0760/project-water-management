// How current a project's input data is, whether runs are behind it, and
// which stored series an uploaded file most likely updates.
import { fromEpochDay, toEpochDay, type SeriesMeta } from '@water-management/engine';
import type { RunMeta } from '$lib/api/types';

/** Days after which data counts as stale. Could become a project setting. */
export const STALE_DAYS = 7;

type Meta = SeriesMeta & { updatedAt?: string };

export const seriesEnd = (s: Pick<SeriesMeta, 'startDate' | 'length'>) =>
	fromEpochDay(toEpochDay(s.startDate) + Math.max(s.length, 1) - 1);

/** Kinds that drive a run (rainfall, daily A-pan evaporation); observed flow only scores it. */
export const isDriver = (kind: string) => kind.startsWith('rain_') || kind === 'evap_apan_mm';

/**
 * Recorded rain: what a run is driven by, so what freshness measures. A
 * forecast runs into the future and observed flow only scores a run: either
 * would read "up to date" while the rain lags (the backend's `dataUntil`
 * uses the same two kinds).
 */
export const isRecordedRain = (kind: string) => kind === 'rain_catchment_mm' || kind === 'rain_chirps_mm';

export interface Freshness {
	/** Latest end of the recorded rain; null when there is none. */
	latest: string | null;
	/** Days from `latest` to today; null without recorded rain. */
	age: number | null;
	/** Recorded rain older than the limit, or none at all. */
	stale: boolean;
	/** Every series, newest end first. */
	perSeries: { id: string; kind: string; name: string; end: string; age: number }[];
	/**
	 * The series behind: those a run is driven by (recorded rain, A-pan
	 * evaporation) ending more than the limit ago. A forecast runs ahead and
	 * observed flow only scores a run, so neither counts. The count is the
	 * badge on Data in the workspace's sections.
	 */
	behind: { id: string; kind: string; name: string; end: string; age: number }[];
}

/** Driver series that can fall behind today (a forecast runs into the future). */
const canFallBehind = (kind: string) => isDriver(kind) && kind !== 'rain_forecast_mm';

export function freshness(list: readonly SeriesMeta[], today: string, staleDays = STALE_DAYS): Freshness | null {
	if (!list.length) return null;
	const perSeries = list
		.map((s) => {
			const end = seriesEnd(s);
			return { id: s.id, kind: s.kind, name: s.name, end, age: toEpochDay(today) - toEpochDay(end) };
		})
		.sort((a, b) => b.end.localeCompare(a.end));
	const behind = perSeries.filter((p) => canFallBehind(p.kind) && p.age > staleDays);
	const top = perSeries.find((p) => isRecordedRain(p.kind));
	if (!top) return { latest: null, age: null, stale: true, perSeries, behind };
	return { latest: top.end, age: top.age, stale: top.age > staleDays, perSeries, behind };
}

/**
 * The Data table's order, freshness first: the series behind (the badge's
 * count, `Freshness.behind`) most days behind first, then the series a run
 * reads, then the rest (another of the same kind is read, reference only);
 * the list's own order within each group.
 */
export function freshnessOrder<T extends { id: string }>(
	list: readonly T[],
	behind: readonly { id: string; age: number }[],
	inUse: ReadonlySet<string>
): T[] {
	const age = new Map(behind.map((b) => [b.id, b.age]));
	const rank = (s: T) => (age.has(s.id) ? 0 : inUse.has(s.id) ? 1 : 2);
	return list
		.map((s, i) => ({ s, i }))
		.sort((a, b) => rank(a.s) - rank(b.s) || (age.get(b.s.id) ?? 0) - (age.get(a.s.id) ?? 0) || a.i - b.i)
		.map((x) => x.s);
}

/**
 * Driver series changed since `run`: updated after it was made (when the API
 * reports updatedAt) or reaching past its end date.
 */
export function newDataSinceRun(list: readonly Meta[], run: Pick<RunMeta, 'createdAt' | 'endDate'> | null): Meta[] {
	if (!run) return [];
	return list.filter(
		(s) => isDriver(s.kind) && ((s.updatedAt !== undefined && s.updatedAt > run.createdAt) || seriesEnd(s) > run.endDate)
	);
}

const KEYWORDS: [RegExp, string][] = [
	[/chirps/, 'rain_chirps_mm'],
	[/forecast|gfs|ecmwf/, 'rain_forecast_mm'],
	[/logger/, 'flow_logger_m3s'],
	[/reference|regional|neighbou?r/, 'flow_reference_m3s'],
	// Before rain: an evaporation file is in mm too.
	[/evap|\ba-?pan\b/, 'evap_apan_mm'],
	[/rain|precip|\bmm\b/, 'rain_catchment_mm'],
	[/flow|gauge|weir|discharge|m3\/s|m³\/s|cumec/, 'flow_observed_m3s']
];

/** The file's header line (first line whose first cell isn't a date), if any. */
export function headerLine(text: string): string {
	for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		const first = (line.split(/[,;\t]/)[0] ?? '').trim().replace(/^"|"$/g, '');
		// Same rule as the CSV parser: a header's first cell is text, not a date.
		return /^\d/.test(first) ? '' : line;
	}
	return '';
}

/**
 * Best guess at which series a file updates: an existing series whose name
 * appears in the file name or header wins; otherwise keywords pick the kind,
 * and the name is that kind's only series (or blank for a new one).
 */
export function guessSeries(
	fileName: string,
	header: string,
	list: readonly SeriesMeta[]
): { kind: string; name: string } | null {
	const text = `${fileName} ${header}`.toLowerCase().replace(/[_]+/g, ' ');
	const named = list
		.filter((s) => s.name.trim().length >= 3 && text.includes(s.name.trim().toLowerCase()))
		.sort((a, b) => b.name.length - a.name.length)[0];
	if (named) return { kind: named.kind, name: named.name };
	const kind = KEYWORDS.find(([re]) => re.test(text))?.[1];
	if (!kind) return null;
	const same = list.filter((s) => s.kind === kind);
	return { kind, name: same.length === 1 ? same[0]!.name : '' };
}
