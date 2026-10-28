// The daily A-pan series now, as a fit record fingerprints it (issue #45), so
// the Calibration page's header and its fit record can say whether the
// forcing changed since the fit. Reading it fetches the whole series, so it is
// fetched once per version of the series (its id and `updatedAt`) and kept for
// the session: changing tab and back, or the header and the panels both
// asking, never fetch it again (issue #586 round 3; Settings fetched it on
// every visit before the panels moved here).
import type { ApanDailyFingerprint, Et0DailyFingerprint, SeriesMeta } from '@water-management/engine';
import { api } from '#lib/api/index.js';
import { apanDailyOfValues, et0DailyOfValues } from '#lib/series/provenance.js';

/** null: the series has no values to fingerprint. */
type Fingerprint = ApanDailyFingerprint | null;
type Fetch = (projectId: string, seriesId: string) => Promise<Fingerprint>;

const fromApi: Fetch = (projectId, seriesId) => api.series.get(projectId, seriesId).then(apanDailyOfValues);

/** Fingerprints by project, series and version, fetched or on their way. */
const cache = new Map<string, Promise<Fingerprint>>();

/**
 * The fingerprint of the daily A-pan series `meta`, fetched at most once per version of it. A failed fetch is
 * forgotten, so the next ask tries again.
 */
export function apanFingerprint(projectId: string, meta: Pick<SeriesMeta, 'id' | 'updatedAt'>, fetch: Fetch = fromApi): Promise<Fingerprint> {
	const key = `${projectId}\u0000${meta.id}\u0000${meta.updatedAt}`;
	let got = cache.get(key);
	if (!got) {
		got = fetch(projectId, meta.id);
		cache.set(key, got);
		got.catch(() => cache.delete(key));
	}
	return got;
}

/**
 * The daily reference ET series' fingerprint through `through` (issue #604
 * R5-E; a fit record's `forcing.et0Daily.through`), fetched at most once per
 * version of the series and that day: a feed's days after the fit never count.
 */
export function et0Fingerprint(projectId: string, meta: Pick<SeriesMeta, 'id' | 'updatedAt'>, through: string, fetch: (projectId: string, seriesId: string) => Promise<Et0DailyFingerprint | null> = (p, id) => api.series.get(p, id).then((s) => et0DailyOfValues(s, through))): Promise<Fingerprint> {
	const key = `${projectId}\u0000${meta.id}\u0000${meta.updatedAt}\u0000et0\u0000${through}`;
	let got = cache.get(key);
	if (!got) {
		got = fetch(projectId, meta.id);
		cache.set(key, got);
		got.catch(() => cache.delete(key));
	}
	return got;
}

/** Forget every fingerprint (tests). */
export const forgetApanFingerprints = () => cache.clear();
