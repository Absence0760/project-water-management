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

/**
 * C3S's seasonal forecasts (issue #620, docs/data-sources.md § c3s-seasonal):
 * CDS dataset `seasonal-original-single-levels`, under CC BY 4.0 and the
 * Additional licence to use non European contributions, which asks that the
 * source be acknowledged. Wherever its values show: Copernicus's notice
 * (`copernicusC3sNotice`, the same words as ERA5-Land's, as the copy
 * converts it too), the dataset's citation, and the contributing centres.
 * The ingest writes the same words into the arrays (ingest/c3s_seasonal.py
 * CREDIT, CITATION; ingest/c3srequest.py CENTRE_NAMES; its test checks).
 */
export const copernicusC3sNotice = copernicusEra5lNotice;

/** The seasonal dataset's citation (docs/data-sources.md § c3s-seasonal). */
export const C3S_SEASONAL_CITATION = 'Copernicus Climate Change Service, Climate Data Store (2018): Seasonal forecast daily and subdaily data on single levels. Copernicus Climate Change Service (C3S) Climate Data Store (CDS). DOI: 10.24381/cds.181d637e';

/** Each originating centre of the C3S multi-system, by the CDS's `originating_centre`, as the credit names it. */
export const C3S_CENTRES: Readonly<Record<string, string>> = {
	ecmwf: 'European Centre for Medium-Range Weather Forecasts (ECMWF)',
	ukmo: 'Met Office',
	meteo_france: 'Météo-France',
	dwd: 'Deutscher Wetterdienst (DWD)',
	cmcc: 'Euro-Mediterranean Center on Climate Change (CMCC)',
	ncep: 'NOAA National Centers for Environmental Prediction (NCEP)',
	jma: 'Japan Meteorological Agency (JMA)',
	eccc: 'Environment and Climate Change Canada (ECCC)'
};

/**
 * The credit lines a C3S-conditioned outlook owes: Copernicus's notice with
 * the year the data were read, the citation, and the contributing centres
 * of the systems used (`<centre>-<system>` ids, `ecmwf-51`), each once, in
 * the systems' order. An unknown centre is named by its id rather than
 * dropped, so a new system is still credited.
 */
export function c3sSeasonalCredit(systems: readonly string[], accessed: string): string[] {
	const centres: string[] = [];
	for (const s of systems) {
		const id = s.replace(/-\d+$/, '');
		const name = Object.hasOwn(C3S_CENTRES, id) ? C3S_CENTRES[id]! : id;
		if (!centres.includes(name)) centres.push(name);
	}
	const lines = [copernicusC3sNotice(accessed.slice(0, 4)), C3S_SEASONAL_CITATION];
	if (centres.length) lines.push(`Contributing centres: ${centres.join('; ')}.`);
	return lines;
}

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
