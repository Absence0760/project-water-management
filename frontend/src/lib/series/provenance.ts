// A series' product and version as the forms offer it (issue #40 part c;
// docs/data-model.md § Series provenance). A select's value is the
// provenance key ('CHIRPS/2.0'), '' for "not recorded".
import {
	CHIRPS_PROVENANCES,
	provenanceKey,
	provenanceLabel,
	type DailySeries,
	type RunSeriesSnapshot,
	type SeriesMeta,
	type SeriesProvenance
} from '@water-management/engine';

/** The kinds a person is asked the product and version of: the CHIRPS series. */
export const asksProvenance = (kind: string) => kind === 'rain_chirps_mm';

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

/** "CHIRPS v2.0", or "version not recorded", for a series list. */
export const describeProvenance = (s: Pick<SeriesMeta, 'product' | 'productVersion'>) => {
	const p = seriesProvenance(s);
	return p ? provenanceLabel(p) : 'version not recorded';
};
