// Which product and version a series holds (issue #40 part c;
// docs/data-model.md § Series provenance). CHIRPS v2 and v3 differ by an
// era-dependent factor, so a series that splices one onto the other has a
// break in it, and the monthly CHIRPS factors (model.md §2.4b) and any fit
// made on one version don't hold for the other. The engine itself never reads
// this: it labels the series for the feeds' version guard, the fit record's
// forcing and the run comparison.

/** A series' product and version, e.g. { product: 'CHIRPS', version: '2.0' }. */
export interface SeriesProvenance {
	product: string;
	version: string;
}

/**
 * The CHIRPS products the app knows. Product and version are recorded apart,
 * and a change of either is a change of forcing (the feed refuses it without
 * an owner's confirmation). v2.0 has one daily product. v3.0 has two daily
 * disaggregations of the same pentads, with different daily timing: `sat`
 * (IMERG, from 1998, with a preliminary product) and `rnl` (ERA5, from 1981,
 * final only, 5–6 days behind). A series is one of them end to end: splicing
 * `rnl` before 1998 onto `sat` after would be a daily-timing break of its own.
 */
export const CHIRPS_V2: SeriesProvenance = { product: 'CHIRPS', version: '2.0' };
export const CHIRPS_V3_SAT: SeriesProvenance = { product: 'CHIRPS sat', version: '3.0' };
export const CHIRPS_V3_RNL: SeriesProvenance = { product: 'CHIRPS rnl', version: '3.0' };
/** Offered wherever a person says what a CHIRPS series is (upload, import, relabel). */
export const CHIRPS_PROVENANCES: readonly SeriesProvenance[] = [CHIRPS_V2, CHIRPS_V3_SAT, CHIRPS_V3_RNL];
/**
 * What a b023 workbook's CHIRPS column is taken to be when the person
 * importing it doesn't say: the workbooks were built on CHIRPS v2.0.
 */
export const B023_CHIRPS_DEFAULT: SeriesProvenance = CHIRPS_V2;

const PRODUCT = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$/;

/** Why a provenance is invalid, or null (the same rules as the time_series CHECKs, 032_series_provenance.sql). */
export function provenanceError(p: unknown): string | null {
	if (typeof p !== 'object' || p === null) return 'not a product and version';
	const o = p as Record<string, unknown>;
	if (typeof o.product !== 'string' || !PRODUCT.test(o.product)) return 'product must be 1–40 letters, digits, spaces, dots, dashes or underscores';
	if (typeof o.version !== 'string' || !VERSION.test(o.version)) return 'version must be 1–20 letters, digits, dots, dashes or underscores';
	return null;
}

/** "CHIRPS v2.0", "CHIRPS sat v3.0", or "an unrecorded version" for null. */
export const provenanceLabel = (p: SeriesProvenance | null | undefined): string => (p ? `${p.product} v${p.version}` : 'an unrecorded version');

/** The same product and version (null = not recorded, equal only to null). */
export const sameProvenance = (a: SeriesProvenance | null | undefined, b: SeriesProvenance | null | undefined): boolean =>
	(a ?? null) === null ? (b ?? null) === null : !!b && a!.product === b.product && a!.version === b.version;

/** A stable key: 'CHIRPS/2.0', or '' when not recorded (data_feed.replace_series_from). */
export const provenanceKey = (p: SeriesProvenance | null | undefined): string => (p ? `${p.product}/${p.version}` : '');
