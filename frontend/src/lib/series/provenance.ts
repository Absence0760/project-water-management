// A series' product and version as the forms offer it (issue #40 part c;
// docs/data-model.md § Series provenance). A select's value is the
// provenance key ('CHIRPS/2.0'), '' for "not recorded".
import {
	chirpsFactorSets,
	CHIRPS_PROVENANCES,
	provenanceKey,
	provenanceLabel,
	seriesDigest,
	type ApanDailyFingerprint,
	type ChirpsFactorSet,
	type RunSummary,
	type DailySeries,
	type RunSeriesSnapshot,
	type SeriesMeta,
	type SeriesProvenance
} from '@water-management/engine';

/** The kinds a person is asked the product and version of: the CHIRPS series. */
export const asksProvenance = (kind: string) => kind === 'rain_chirps_mm';

/**
 * The kinds a person may name the product and version of freely (issue #40
 * (b)): the alternative catchment gauge (e.g. an automatic-station network)
 * and the reanalysis (e.g. ERA5). Optional; recorded with the series like
 * CHIRPS's, so a rain-source period's forcing names its source.
 */
export const asksFreeProvenance = (kind: string) => kind === 'rain_catchment_alt_mm' || kind === 'rain_reanalysis_mm';

/** Free product and version to the request fields: both trimmed strings, or null when either is blank (not said). */
export function freeProvenanceFields(product: string, version: string): { product: string; productVersion: string } | null {
	const p = product.trim();
	const v = version.trim();
	return p && v ? { product: p, productVersion: v } : null;
}

/** The CHIRPS products and versions to pick from, as select options. */
export const CHIRPS_CHOICES: { value: string; label: string }[] = CHIRPS_PROVENANCES.map((p) => ({ value: provenanceKey(p), label: provenanceLabel(p) }));

/** A series' label as the engine's type (null = not recorded). */
export const seriesProvenance = (s: Pick<SeriesMeta, 'product' | 'productVersion'> | null | undefined): SeriesProvenance | null =>
	s?.product && s.productVersion ? { product: s.product, version: s.productVersion } : null;

/** A select's value back to the request fields: both strings, or both null ('' = not recorded). */
export function provenanceFields(key: string): { product: string | null; productVersion: string | null } {
	const at = key.lastIndexOf('/');
	return at > 0 ? { product: key.slice(0, at), productVersion: key.slice(at + 1) } : { product: null, productVersion: null };
}

/**
 * The CHIRPS series' label a run would use: the first CHIRPS series by name
 * (the list comes ordered by kind and name, as runs pick), null when there is
 * none or it isn't recorded, undefined when the list isn't known. For the fit
 * record's "forcing changed since fit" (engine fitRecordStatus).
 */
export function chirpsSourceOf(list: readonly Pick<SeriesMeta, 'kind' | 'product' | 'productVersion'>[] | null | undefined): SeriesProvenance | null | undefined {
	if (!list) return undefined;
	return seriesProvenance(list.find((s) => s.kind === 'rain_chirps_mm'));
}

/**
 * The CHIRPS factor sets a run applied (engine rain.ts chirpsFactorSets of its
 * summary.chirpsCorrection), what "forcing changed since fit" compares with
 * the fit's (issue #51): null when the run applied no monthly correction,
 * undefined when its summary predates the correction record (nothing to compare).
 */
export function runChirpsFactors(summary: Pick<RunSummary, 'chirpsCorrection'> | null | undefined): ChirpsFactorSet[] | null | undefined {
	if (!summary || summary.chirpsCorrection === undefined) return undefined;
	return chirpsFactorSets(summary.chirpsCorrection);
}

/**
 * The same from a run's recorded input series (its snapshot) or a model
 * input: null with no CHIRPS series, undefined when the run is older than the
 * label (nothing to compare).
 */
export function chirpsSourceOfInput(series: Partial<Record<string, Pick<RunSeriesSnapshot | DailySeries, 'provenance'>>> | null | undefined): SeriesProvenance | null | undefined {
	if (!series) return undefined;
	const c = series.rain_chirps_mm;
	if (!c) return null;
	return c.provenance === undefined ? undefined : c.provenance;
}

/**
 * The daily A-pan series a run recorded (issue #45), from its input snapshot:
 * start, length and the values' SHA-256, as the fit record keeps them. null
 * with no daily A-pan series, undefined when the snapshot isn't known or is
 * older than the hash (nothing to compare). For "forcing changed since fit".
 */
export function apanDailyOfInput(series: Partial<Record<string, Pick<RunSeriesSnapshot, 'startDate' | 'length' | 'valuesSha256'>>> | null | undefined): ApanDailyFingerprint | null | undefined {
	if (!series) return undefined;
	const a = series.evap_apan_mm;
	if (!a) return null;
	return a.valuesSha256 ? { startDate: a.startDate, length: a.length, valuesSha256: a.valuesSha256 } : undefined;
}

/**
 * The same from the values themselves (a model input, or a series the page
 * fetched): SHA-256 hex of `seriesDigest(values)`, the hash the backend
 * stores in a run's snapshot (runs/execute.ts seriesHash). null without one.
 */
export async function apanDailyOfValues(s: Pick<DailySeries, 'startDate' | 'values'> | null | undefined): Promise<ApanDailyFingerprint | null> {
	if (!s) return null;
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seriesDigest(s.values)));
	const valuesSha256 = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
	return { startDate: s.startDate, length: s.values.length, valuesSha256 };
}

/**
 * The note a page shows while a data feed backfills a confirmed replacement
 * of any of these series (issue #40c), or null: runs keep using the series as
 * it is until the new record swaps in whole.
 */
export function rebuildingNote(list: readonly Pick<SeriesMeta, 'kind' | 'name' | 'rebuilding'>[] | null | undefined, label: (s: Pick<SeriesMeta, 'kind' | 'name'>) => string): string | null {
	const r = (list ?? []).filter((s) => s.rebuilding);
	if (!r.length) return null;
	return `A data feed is replacing ${r.map(label).join(', ')} with another CHIRPS product or version. Runs use the current series until the replacement completes; refit after it does.`;
}

/** "CHIRPS v2.0", or "version not recorded", for a series list. */
export const describeProvenance = (s: Pick<SeriesMeta, 'product' | 'productVersion'>) => {
	const p = seriesProvenance(s);
	return p ? provenanceLabel(p) : 'version not recorded';
};
