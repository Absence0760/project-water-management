// How current a project's input data is, whether runs are behind it, and
// which stored series an uploaded file most likely updates.
import { fromEpochDay, toEpochDay, type SeriesMeta } from '@water-management/engine';
import type { RunMeta } from '$lib/api/types';

/** Days after which data counts as stale. Could become a project setting. */
export const STALE_DAYS = 7;

type Meta = SeriesMeta & { updatedAt?: string };

export const seriesEnd = (s: Pick<SeriesMeta, 'startDate' | 'length'>) =>
	fromEpochDay(toEpochDay(s.startDate) + Math.max(s.length, 1) - 1);

/** Kinds that drive a run (rainfall); observed flow only scores it. */
export const isDriver = (kind: string) => kind.startsWith('rain_');

export interface Freshness {
	/** Latest end date across the series. */
	latest: string;
	/** Days from `latest` to today. */
	age: number;
	stale: boolean;
	perSeries: { id: string; kind: string; name: string; end: string; age: number }[];
}

export function freshness(list: readonly SeriesMeta[], today: string, staleDays = STALE_DAYS): Freshness | null {
	if (!list.length) return null;
	const perSeries = list
		.map((s) => {
			const end = seriesEnd(s);
			return { id: s.id, kind: s.kind, name: s.name, end, age: toEpochDay(today) - toEpochDay(end) };
		})
		.sort((a, b) => b.end.localeCompare(a.end));
	const top = perSeries[0]!;
	return { latest: top.end, age: top.age, stale: top.age > staleDays, perSeries };
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
