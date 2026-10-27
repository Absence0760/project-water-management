// Rain data credits (issue #604 R4-E, docs/data-sources.md).
// A module of its own, with no imports (engine `@water-management/engine/credits`),
// so the public Data sources page and the map's attribution, which show
// only these, load none of the rest of the liability texts.
// The notices the gap-filling products and the ECMWF forecast ask for,
// wherever their values show: the Data tab, the per-day preview, a run's
// results and report, its exports and evidence pack. Word for word as
// docs/data-sources.md quotes them (its test checks).

/** ECMWF open data's credit (CC BY 4.0, docs/data-sources.md § ecmwf-ens). */
export const ECMWF_CREDIT = 'ECMWF open data, CC BY 4.0';

/**
 * Copernicus's attribution for ERA5-Land, quoted exactly (docs/data-sources.md
 * § ERA5-Land): "Contains modified" because our copy remaps and converts it;
 * `year` is the year the data were accessed.
 */
export const copernicusEra5lNotice = (year: number | string): string =>
	`Contains modified Copernicus Climate Change Service information ${year}. Neither the European Commission nor ECMWF is responsible for any use that may be made of the Copernicus information or data it contains.`;

/** ERA5-Land's dataset citation (docs/data-sources.md § ERA5-Land). */
export const ERA5L_CITATION =
	'Muñoz Sabater, J. (2019): ERA5-Land hourly data from 1950 to present. Copernicus Climate Change Service (C3S) Climate Data Store (CDS). DOI: 10.24381/cds.e2161bac';

/**
 * NASA's citation for IMERG Late (docs/data-sources.md § imerg, CMR's
 * collection citation). `accessed` is the day (or year) the data were read;
 * `version` the IMERG version in words (V07).
 */
export const imergCitation = (accessed: string, version = 'V07'): string =>
	`Huffman, G.J., E.F. Stocker, D.T. Bolvin, E.J. Nelkin, J. Tan (2024), GPM IMERG Late Precipitation L3 1 day 0.1 degree x 0.1 degree ${version}, edited by Andrey Savtchenko, Greenbelt, MD, Goddard Earth Sciences Data and Information Services Center (GES DISC), accessed ${accessed}, doi:10.5067/GPM/IMERGDL/DAY/07.`;

/** A rain product whose credit must go with its values. */
export type CreditedRainProduct = 'era5l' | 'imerg_late' | 'ecmwf_ens';

/** One product's credit lines: its name, then the notice or citation, word for word. */
export interface RainCredit {
	product: CreditedRainProduct;
	name: string;
	lines: string[];
}

/**
 * The credits a run (or a view of the products) owes: ERA5-Land's Copernicus
 * notice and citation, IMERG Late's citation per version, ECMWF's credit, in
 * that order, each once. `accessed` is the day the values were read
 * (YYYY-MM-DD, the run's creation day); its year goes in the Copernicus line.
 */
export function rainCredits(used: { era5l?: boolean; imergVersions?: readonly string[]; ecmwf?: boolean }, accessed: string): RainCredit[] {
	const out: RainCredit[] = [];
	if (used.era5l) out.push({ product: 'era5l', name: 'ERA5-Land', lines: [copernicusEra5lNotice(accessed.slice(0, 4)), ERA5L_CITATION] });
	const versions = [...new Set(used.imergVersions ?? [])];
	if (versions.length) out.push({ product: 'imerg_late', name: 'IMERG Late', lines: versions.map((v) => imergCitation(accessed, v)) });
	if (used.ecmwf) out.push({ product: 'ecmwf_ens', name: 'ECMWF ENS forecast', lines: [ECMWF_CREDIT] });
	return out;
}

/**
 * The credits a run owes from its summary and forecast source: ERA5-Land when
 * it filled a day or its rain was in the run (summary.gapRain.products), each
 * IMERG version present, and ECMWF when any forecast day the run read was an
 * ECMWF feed's: `forecastRainSource` 'ecmwf_ens' (the feed wrote every one),
 * or `forecastRainEcmwf` true (it wrote some, and a person the rest; backend
 * runs/execute.ts forecastRainEcmwf). ERA5-Land's and IMERG's presence is
 * the products' own, never all-or-nothing.
 */
export function runRainCredits(
	run: {
		summary?: { gapRain?: { products: readonly { product: string; version: string | null; present: boolean }[] } | null } | null;
		forecastRainSource?: unknown;
		forecastRainEcmwf?: unknown;
	},
	accessed: string
): RainCredit[] {
	const products = run.summary?.gapRain?.products.filter((p) => p.present) ?? [];
	return rainCredits(
		{
			era5l: products.some((p) => p.product === 'era5l'),
			imergVersions: products.filter((p) => p.product === 'imerg_late' && p.version).map((p) => p.version!),
			ecmwf: run.forecastRainSource === 'ecmwf_ens' || run.forecastRainEcmwf === true
		},
		accessed
	);
}
