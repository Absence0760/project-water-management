// Per-session cache of input-series values (keyed "projectId/seriesId"), so
// revisiting the Time series tab draws coverage and charts on the first frame.
// An entry counts only while it is still what the series holds: the same
// start, length and last change (`updatedAt`). A change that keeps the length
// (a restore, a feed correcting a day, another editor's merge) makes it stale.
import type { SeriesMeta } from '@water-management/engine';
import type { Daily } from './coverage';

type Held = Pick<SeriesMeta, 'id' | 'startDate' | 'length' | 'updatedAt'>;
type Entry = Daily & { updatedAt?: string };

const cache = new Map<string, Entry>();
const key = (projectId: string, seriesId: string) => `${projectId}/${seriesId}`;

/** The cached values of a series, or null when there are none or they are stale. */
export function cachedValues(projectId: string, s: Held): Daily | null {
	const hit = cache.get(key(projectId, s.id));
	if (!hit || hit.startDate !== s.startDate || hit.values.length !== s.length || hit.updatedAt !== s.updatedAt) return null;
	return { startDate: hit.startDate, values: hit.values };
}

/** Remember a series' values as read (the GET answer carries its `updatedAt`). */
export function cacheValues(projectId: string, s: Pick<SeriesMeta, 'id' | 'updatedAt'> & Daily): Daily {
	const v = { startDate: s.startDate, values: s.values };
	cache.set(key(projectId, s.id), { ...v, updatedAt: s.updatedAt });
	return v;
}

/** Drop a series' values (after this session wrote them). */
export function forgetValues(projectId: string, seriesId: string): void {
	cache.delete(key(projectId, seriesId));
}
