// The third-party data the app serves or reads, and the notice each licence
// asks for (docs/maps.md § Sources, the licences read there). Shown on the
// public Data sources page (/data-sources) and, for the map's layers, on the
// map's attribution control while that layer is drawn. A statement here is
// the licensor's required wording: change it only with the licence (the
// test checks each against docs/maps.md, where the licence was read).
// Plain text, never HTML: the page renders it as text.

/** The day the licences below were last read on their publishers' pages (docs/maps.md § Sources, "read <date>"). */
export const LICENCES_READ = '2026-10-01';

/** The page's line under its title: "Licences last read 1 October 2026" (UTC, so the day never shifts). */
export const licencesReadLine = (read: string = LICENCES_READ): string =>
	`Licences last read ${new Date(`${read}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })}`;

export interface DataCredit {
	/** The fragment id on /data-sources. */
	id: string;
	/** The dataset as the app names it. */
	name: string;
	/** What the app uses it for. */
	usedFor: string;
	/** Who publishes it. */
	publisher: string;
	/** The licence, in a few words, and where it was read. */
	licence: string;
	licenceUrl: string;
	/** The licensor's required notice(s), word for word. */
	statements: string[];
	/** The citation for published material, when the publisher asks for one. */
	citation?: string;
}

/** The product name the HydroSHEDS licence's Exhibit B statement takes. */
const PRODUCT = 'Water Management';

/**
 * HydroSHEDS version 1 License Agreement, Exhibit B (HydroSHEDS technical
 * documentation v1.4, Appendix A), with the product's name filled in.
 */
export const HYDROSHEDS_STATEMENT = `This product [${PRODUCT}] incorporates data from the HydroSHEDS version 1 database which is © World Wildlife Fund, Inc. (2006-2022) and has been used herein under license. WWF has not evaluated the data as altered and incorporated within [${PRODUCT}], and therefore gives no warranty regarding its accuracy, completeness, currency or suitability for any particular purpose. Portions of the HydroSHEDS v1 database incorporate data which are the intellectual property rights of © USGS (2006-2008), NASA (2000-2005), ESRI (1992-1998), CIAT (2004-2006), UNEP-WCMC (1993), WWF (2004), Commonwealth of Australia (2007), and Her Royal Majesty and the British Crown and are used under license. The HydroSHEDS v1 database and more information are available at https://www.hydrosheds.org.`;

/** The Copernicus WorldDEM-30 licence's notice for adapted data (Art. 6(b)). */
export const COPERNICUS_NOTICE =
	'produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved';

/** The same licence's liability sentence (Art. 6(c)), for the legal notice. */
export const COPERNICUS_LIABILITY =
	'The organisations in charge of the Copernicus programme by law or by delegation do not incur any liability for any use of the Copernicus WorldDEM-30';

/** ESA WorldCover's attribution for a map or figure (CC BY 4.0). */
export const WORLDCOVER_STATEMENT = '© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium';

/** The map's attribution control while real HydroRIVERS reaches are drawn: short, linking to the full statement. */
export const HYDRORIVERS_MAP_ATTRIBUTION = 'Rivers: HydroRIVERS, HydroSHEDS v1 © World Wildlife Fund, Inc. (2006-2022), used under license';

export const DATA_CREDITS: readonly DataCredit[] = [
	{
		id: 'basemap',
		name: 'Basemap (Protomaps tiles of OpenStreetMap)',
		usedFor: 'The map’s background: land, water, roads, boundaries and place names.',
		publisher: 'Protomaps; OpenStreetMap contributors',
		licence: 'Open Database License (ODbL) 1.0, commercial use allowed with attribution',
		licenceUrl: 'https://www.openstreetmap.org/copyright',
		statements: ['© Protomaps © OpenStreetMap contributors']
	},
	{
		id: 'copernicus-dem',
		name: 'Copernicus GLO-30 digital elevation model (Mapterhorn’s Terrarium tiles)',
		usedFor: 'The map’s shaded relief, and the catchment outlines Delineate proposes from it.',
		publisher: 'DLR e.V. and Airbus Defence and Space, provided under COPERNICUS by the European Union and ESA; tiles compiled by Mapterhorn',
		licence: 'The Copernicus WorldDEM-30 licence: free of charge, worldwide, adaptation and commercial use allowed',
		licenceUrl: 'https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Data/DEM/resources/license/License-COPDEM-30.pdf',
		statements: [`Relief and delineated catchments ${COPERNICUS_NOTICE}.`, `${COPERNICUS_LIABILITY}.`, 'Elevation tiles © Mapterhorn (https://mapterhorn.com/attribution).']
	},
	{
		id: 'hydrorivers',
		name: 'HydroRIVERS v1.0',
		usedFor: 'The map’s River network layer, and the reaches an editor adds to a project as rivers.',
		publisher: 'WWF (World Wildlife Fund, Inc.), HydroSHEDS',
		licence: 'The HydroSHEDS version 1 License Agreement: free for non-commercial and commercial use, with attribution',
		licenceUrl: 'https://www.hydrosheds.org/products/hydrorivers',
		statements: [HYDROSHEDS_STATEMENT],
		citation: 'Lehner, B., Grill, G. (2013). Global river hydrography and network routing: baseline data and new approaches to study the world’s large river systems. Hydrological Processes, 27(15): 2171–2186.'
	},
	{
		id: 'worldcover',
		name: 'ESA WorldCover 10 m 2021 v200',
		usedFor: 'The cultivated areas proposed on the Crops tab (its cropland class).',
		publisher: 'European Space Agency, WorldCover consortium',
		licence: 'Creative Commons Attribution 4.0 International (CC BY 4.0)',
		licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
		statements: [WORLDCOVER_STATEMENT],
		citation: 'Zanaga, D. et al. (2022). ESA WorldCover 10 m 2021 v200. https://doi.org/10.5281/zenodo.7254221'
	},
	{
		id: 'chirps',
		name: 'CHIRPS v3 daily rainfall and the CHIRPS-GEFS v3 forecast',
		usedFor: 'The rain feeds: satellite rainfall over a catchment, and the rain forecast.',
		publisher: 'Climate Hazards Center, UC Santa Barbara',
		licence: 'Public domain, and Creative Commons Attribution 4.0 International (CC BY 4.0)',
		licenceUrl: 'https://www.chc.ucsb.edu/data/chirps3',
		statements: ['Climate Hazards Center Infrared Precipitation with Stations version 3 (CHIRPS3) Data Repository: https://doi.org/10.15780/G2JQ0P (2025).']
	},
	{
		id: 'fonts',
		name: 'Noto Sans map labels',
		usedFor: 'The lettering of place names and catchment codes on the map.',
		publisher: 'The Noto Project Authors; packaged by Protomaps',
		licence: 'SIL Open Font License 1.1',
		licenceUrl: 'https://openfontlicense.org/open-font-license-official-text/',
		statements: ['Noto Sans © The Noto Project Authors, under the SIL Open Font License 1.1.']
	}
];
