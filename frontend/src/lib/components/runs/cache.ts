// Per-session caches for run results, so returning to the Runs tab shows the
// last run on the first frame and a chart never refetches a series it already
// has. Series are fetched one at a time on demand: a run stores ~170 daily
// series of ~16 000 values, far too many to load up front.
import type { DailySeries } from '@water-management/engine';
import type { Run, RunSeriesRef } from '$lib/api/types';

export const detailCache = new Map<string, { run: Run; series: RunSeriesRef[] }>();

const MAX_SERIES = 60;
const seriesCache = new Map<string, Promise<DailySeries>>();

/** Memoised fetch of one run series (LRU-bounded; failures are not cached). */
export function cachedSeries(
	runId: string,
	key: string,
	nodeId: string | null,
	fetch: () => Promise<DailySeries>
): Promise<DailySeries> {
	const k = `${runId}|${nodeId ?? ''}|${key}`;
	const hit = seriesCache.get(k);
	if (hit) {
		seriesCache.delete(k);
		seriesCache.set(k, hit);
		return hit;
	}
	const p = fetch();
	seriesCache.set(k, p);
	p.catch(() => seriesCache.delete(k));
	while (seriesCache.size > MAX_SERIES) seriesCache.delete(seriesCache.keys().next().value!);
	return p;
}

/**
 * Start fetching the series in `wanted` that the run stores (`refs`), into
 * the cache, without waiting for them. The Runs tab calls it the moment a
 * run's detail arrives with the catchment flows its first charts draw, so
 * those requests are in flight while the browser renders the results page
 * (half a second or more on a loaded machine) instead of starting when the
 * charts mount, and ahead of the panels further down (issue #41).
 */
export function prefetchSeries(
	runId: string,
	refs: RunSeriesRef[],
	wanted: { key: string; nodeId: string | null }[],
	fetch: (key: string, nodeId: string | null) => Promise<DailySeries>
): void {
	for (const w of wanted) {
		if (!refs.some((r) => r.key === w.key && r.nodeId === w.nodeId)) continue;
		// A failure is the chart's to show when it asks for the series itself (failures aren't cached).
		cachedSeries(runId, w.key, w.nodeId, () => fetch(w.key, w.nodeId)).catch(() => {});
	}
}

export function forgetRun(runId: string) {
	detailCache.delete(runId);
	for (const k of [...seriesCache.keys()]) if (k.startsWith(`${runId}|`)) seriesCache.delete(k);
}
