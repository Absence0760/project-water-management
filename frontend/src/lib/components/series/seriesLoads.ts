// The Time series tab's reads, latest wins (docs/architecture.md § Stale
// responses). The tab asks for its list again on Try again and after a day is
// edited, and for every series' values each time the list changes: an earlier
// answer that comes back after a later one must not bring the older list, or
// a series' older values, back.
import type { SeriesMeta } from '@water-management/engine';
import { api } from '#lib/api/index.js';
import { latestCall, latestOnly, type Latest } from '#lib/api/latest.js';
import type { Daily } from './coverage';
import { cachedValues, cacheValues } from './valuesCache';

/** The series list, latest call only (`{ current: false }` once a later call began, its failure too). */
export function seriesListLoader(list: (projectId: string) => Promise<SeriesMeta[]> = (id) => api.series.list(id)): (projectId: string) => Promise<Latest<SeriesMeta[]>> {
	return latestCall(list);
}

type Held = Pick<SeriesMeta, 'id' | 'startDate' | 'length' | 'updatedAt'>;
type Fetched = Pick<SeriesMeta, 'id' | 'updatedAt'> & Daily;

/** Where a round's answers go: each called only while the round is the latest one. */
export interface ValuesSink {
	/** The series is being read again: drop any earlier failure. */
	retry(id: string): void;
	value(id: string, v: Daily): void;
	failed(id: string, message: string): void;
}

/**
 * Reads every listed series' values (the session cache first), one round per call. A round that a later
 * one started after writes nothing more, its failures neither: the later round reads what the newer list holds.
 */
export function seriesValuesLoader(
	get: (projectId: string, seriesId: string) => Promise<Fetched> = (p, id) => api.series.get(p, id)
): (projectId: string, list: readonly Held[], sink: ValuesSink) => Promise<void> {
	const rounds = latestOnly();
	return async (projectId, list, sink) => {
		const current = rounds.begin();
		await Promise.all(
			list.map(async (s) => {
				sink.retry(s.id);
				const hit = cachedValues(projectId, s);
				if (hit) {
					sink.value(s.id, hit);
					return;
				}
				try {
					// Cached whatever the round: the cache checks each entry against the series' last change.
					const v = cacheValues(projectId, await get(projectId, s.id));
					if (current()) sink.value(s.id, v);
				} catch (e) {
					if (current()) sink.failed(s.id, e instanceof Error ? e.message : String(e));
				}
			})
		);
	};
}
