// The Copernicus credit for Sentinel-2 and Sentinel-1 values (issue #624;
// docs/data-sources.md deafrica-sentinel-2-c1): the EU's legal notice asks
// for "Contains modified Copernicus Sentinel data [year]", and DE Africa
// processed them. The one definition: the evidence report's § 7
// (damObservations.ts) and the backend's dam views (dams/observed/upstream.ts,
// through the package's `./sentinel-credit` export) both read it.
//
// A leaf module, no imports: the fetcher Lambda's bundle reaches it through
// upstream.ts and must not pull in the engine (infra/scripts/package-lambdas.sh).

/** The credit; [year] is the years of the values shown. */
export const SENTINEL_CITATION = 'Contains modified Copernicus Sentinel data [year], processed by Digital Earth Africa';

/** The Sentinel credit for values on these `YYYY-MM-DD` dates: one year, or the first and last ("2019–2021"); null with none. */
export function sentinelCitation(dates: Iterable<string>): string | null {
	let lo: string | null = null;
	let hi: string | null = null;
	for (const d of dates) {
		const y = d.slice(0, 4);
		if (lo === null || y < lo) lo = y;
		if (hi === null || y > hi) hi = y;
	}
	if (lo === null || hi === null) return null;
	return SENTINEL_CITATION.replace('[year]', lo === hi ? lo : `${lo}–${hi}`);
}
