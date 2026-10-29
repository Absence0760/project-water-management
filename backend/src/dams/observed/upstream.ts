// Digital Earth Africa's public bucket, which both dam observation sources
// read over HTTPS (issue #604 R5; docs/data-sources.md, Digital Earth Africa
// Waterbodies): the Waterbodies time series (waterbodies.ts) and the WOfS
// scenes (R5-C). Anonymous reads, CC BY 4.0. Sentinel-2 and Sentinel-1 (issue
// #624) come from their own buckets and carry Copernicus's credit too. feeds/http.ts FEED_HOSTS lets a
// live fetch reach this host and no other of theirs.
export const DEAFRICA_SERVICES_BASE = 'https://deafrica-services.s3.af-south-1.amazonaws.com/';

/** The attribution shown wherever their values show (CC BY 4.0). */
export const DEAFRICA_ATTRIBUTION = 'Digital Earth Africa, CC BY 4.0';

/**
 * The Copernicus credit for Sentinel-2 and Sentinel-1 values (issue #624; docs/data-sources.md
 * deafrica-sentinel-2-c1): the EU's legal notice asks for "Contains modified Copernicus Sentinel data [year]", and
 * DE Africa processed them. [year] is the years of the values shown.
 */
export const SENTINEL_ATTRIBUTION = 'Contains modified Copernicus Sentinel data [year], processed by Digital Earth Africa';

/** The Sentinel credit for views on these `YYYY-MM-DD` dates: one year, or the first and last ("2021–2024"); null with none. */
export function sentinelCredit(dates: Iterable<string>): string | null {
	let lo: string | null = null;
	let hi: string | null = null;
	for (const d of dates) {
		const y = d.slice(0, 4);
		if (lo === null || y < lo) lo = y;
		if (hi === null || y > hi) hi = y;
	}
	if (lo === null || hi === null) return null;
	return SENTINEL_ATTRIBUTION.replace('[year]', lo === hi ? lo : `${lo}–${hi}`);
}

/** Whether a source's values are Copernicus Sentinel data, and carry SENTINEL_ATTRIBUTION. */
export const isSentinel = (source: string) => source === 's2' || source === 's1';
