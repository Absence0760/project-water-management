// The third-party data the app serves or reads, and the notice each licence
// asks for (docs/maps.md § Sources, the licences read there). Shown on the
// public Data sources page (/data-sources) and, for the map's layers, on the
// map's attribution control while that layer is drawn. A statement here is
// the licensor's required wording: change it only with the licence (the
// test checks each against docs/maps.md, where the licence was read).
// Plain text, never HTML: the page renders it as text.

// From the credits' own subpath, not the engine's barrel: this module is on the public Data sources page and the map's attribution, which need nothing else of the engine.
import { copernicusEra5lNotice, ECMWF_CREDIT, ERA5L_CITATION, imergCitation } from '@water-management/engine/credits';
import { APP_NAME } from '#lib/brand.js';

/** A `YYYY-MM-DD` day in words, "1 October 2026" (UTC, so the day never shifts). */
export const readDay = (read: string): string =>
	new Date(`${read}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** The page's line under its title: "Licences last read 2 October 2026", the latest of the credits' read dates. */
export const licencesReadLine = (read: string = LICENCES_READ): string => `Licences last read ${readDay(read)}`;

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
	/** Where the licence's terms are published; absent when none came with the data (the page then names the licence without a link, "checked on" its day). */
	licenceUrl?: string;
	/** The day the licence was read on its publisher's page, `YYYY-MM-DD` (docs/maps.md § Sources, "read <date>"). */
	read: string;
	/** The licensor's required notice(s), word for word. */
	statements: string[];
	/** The citation for published material, when the publisher asks for one. */
	citation?: string;
}

/** The product name the HydroSHEDS licence's Exhibit B statement takes. */
const PRODUCT = APP_NAME;

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

/** JRC Global Surface Water's attribution for a published map (its download page); bin/tiles-dev.sh writes it as the water archive's attribution, which a traced dam's description carries. */
export const JRC_WATER_STATEMENT = 'Source: EC JRC/Google';

/** dPET's attribution, with ERA5-Land's Copernicus line (CC BY 4.0): the backend's `DPET.attribution` (geo/evaporationGrid.ts), word for word. */
export const DPET_STATEMENT =
	'hPET/dPET © Singer et al. 2021, University of Bristol, CC BY 4.0. Contains modified Copernicus Climate Change Service information (ERA5-Land, CC BY 4.0); neither the European Commission nor ECMWF is responsible for any use of it.';

/** ESA WorldCover's attribution for a map or figure (CC BY 4.0). */
export const WORLDCOVER_STATEMENT = '© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium';

/** Digital Earth Africa's credit (CC BY 4.0) for the dam observations: the backend's `DEAFRICA_ATTRIBUTION` (dams/observed/upstream.ts), word for word. */
export const DEAFRICA_STATEMENT = 'Digital Earth Africa, CC BY 4.0';

/**
 * Copernicus's credit for Sentinel-2 and Sentinel-1 values (issue #624): the backend's `SENTINEL_ATTRIBUTION`
 * (dams/observed/upstream.ts), word for word, its [year] filled with the years of the views shown wherever they show.
 */
export const SENTINEL_STATEMENT = 'Contains modified Copernicus Sentinel data [year], processed by Digital Earth Africa';

/** GeoNames' attribution (CC BY 4.0), shown under every Map search that lists a place: the backend's `GEONAMES_SOURCE` (geo/gazetteer.ts), word for word. */
export const GEONAMES_STATEMENT = 'GeoNames (geonames.org), CC BY 4.0';

/**
 * The Southwestern Cape MAP surface's credit line, as its authors give it: the
 * backend's `WAAS_MAP_ATTRIBUTION` (geo/rainMap.ts), word for word, which a
 * production load stores as the grid's attribution (issue #560).
 */
export const WAAS_MAP_STATEMENT = 'Mean annual rainfall surface for the Southwestern Cape. Prepared for the WAAS project by Beuster Clarke & Associates. March 2007, Version 1.1.';

/**
 * The map's attribution control while the MAP grid layer draws that surface's
 * points: short, naming the study and its authors, linking to the full line on
 * /data-sources#waas-map (as HydroRIVERS'). The whole 150-character line wrapped
 * to two or four lines along the map's foot, under its Show everything and Key
 * buttons, at 1280 px as on a phone (PR #570).
 */
export const WAAS_MAP_MAP_ATTRIBUTION = 'MAP grid: WAAS (2007), Beuster Clarke & Associates';

/** The map's attribution control while real HydroRIVERS reaches are drawn: short, linking to the full statement. */
export const HYDRORIVERS_MAP_ATTRIBUTION = 'Rivers: HydroRIVERS, HydroSHEDS v1 © World Wildlife Fund, Inc. (2006-2022), used under license';

/**
 * The map's attribution control while a dam outline traced from JRC Global
 * Surface Water is drawn: JRC's "Source: EC JRC/Google", and that the data was
 * modified (Copernicus Delegated Regulation 1159/2013 Art. 8(1) and (3);
 * docs/legal/map-data-licences.md § 5.3). The farm map says the same in the
 * reader's language (farm/farmMap.ts farmMapCredits), the statement as written.
 */
export const JRC_WATER_MAP_ATTRIBUTION = `Dam outline: traced from JRC Global Surface Water (${JRC_WATER_STATEMENT}), modified`;

/**
 * The regional GR4J prior's sources (issue #622): the donors' flow records,
 * their basin attributes, and the soil water capacity grid. Word for word as
 * docs/data-sources.md § GR4J priors and docs/maps.md § Sources record them,
 * and as the backend stores them on the datasets (geo/gr4jDonors.ts
 * GR4J_DONORS, geo/soilGrid.ts SOILS).
 */
export const CARAVAN_STATEMENT =
	'Donor flow records: GRDC-Caravan (Färber et al. 2025, Zenodo 10.5281/zenodo.15349031), CC BY 4.0, from data held by the Global Runoff Data Centre (GRDC); South Africa’s and Namibia’s records © their departments of water.';
export const HYDROATLAS_STATEMENT = 'Basin attributes: HydroATLAS v1.0 (BasinATLAS; Linke et al. 2019, Lehner et al. 2022), CC BY 4.0.';
export const SOILGRIDS_STATEMENT = 'Soil water retention: SoilGrids 2.0 © ISRIC – World Soil Information, CC BY 4.0.';
export const ISDA_STATEMENT = 'Depth to bedrock: iSDAsoil © Innovative Solutions for Decision Agriculture (iSDA), CC BY 4.0.';

export const DATA_CREDITS: readonly DataCredit[] = [
	{
		id: 'basemap',
		name: 'Basemap (Protomaps tiles of OpenStreetMap)',
		usedFor: 'The map’s background: land, water, roads, boundaries and place names.',
		publisher: 'Protomaps; OpenStreetMap contributors',
		licence: 'Open Database License (ODbL) 1.0, commercial use allowed with attribution',
		licenceUrl: 'https://www.openstreetmap.org/copyright',
		read: '2026-10-01',
		statements: ['© Protomaps © OpenStreetMap contributors']
	},
	{
		id: 'copernicus-dem',
		name: 'Copernicus GLO-30 digital elevation model (Mapterhorn’s Terrarium tiles)',
		usedFor: 'The map’s shaded relief, and the catchment outlines Delineate proposes from it.',
		publisher: 'DLR e.V. and Airbus Defence and Space, provided under COPERNICUS by the European Union and ESA; tiles compiled by Mapterhorn',
		licence: 'The Copernicus WorldDEM-30 licence: free of charge, worldwide, adaptation and commercial use allowed',
		licenceUrl: 'https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Data/DEM/resources/license/License-COPDEM-30.pdf',
		read: '2026-10-01',
		statements: [`Relief and delineated catchments ${COPERNICUS_NOTICE}.`, `${COPERNICUS_LIABILITY}.`, 'Elevation tiles © Mapterhorn (https://mapterhorn.com/attribution).']
	},
	{
		id: 'hydrorivers',
		name: 'HydroRIVERS v1.0',
		usedFor: 'The map’s River network layer, and the reaches an editor adds to a project as rivers.',
		publisher: 'WWF (World Wildlife Fund, Inc.), HydroSHEDS',
		licence: 'The HydroSHEDS version 1 License Agreement: free for non-commercial and commercial use, with attribution',
		licenceUrl: 'https://www.hydrosheds.org/products/hydrorivers',
		read: '2026-10-01',
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
		read: '2026-10-01',
		statements: [WORLDCOVER_STATEMENT],
		citation: 'Zanaga, D. et al. (2022). ESA WorldCover 10 m 2021 v200. https://doi.org/10.5281/zenodo.7254221'
	},
	{
		id: 'jrc-water',
		name: 'JRC Global Surface Water v1.5 (1984–2024), water occurrence',
		usedFor: 'Trace a dam: the outline of a dam’s water, proposed from how often satellites saw water there.',
		publisher: 'European Commission Joint Research Centre, with Google',
		licence: 'Produced under the Copernicus Programme: free of charge, without restriction of use',
		read: '2026-10-02',
		licenceUrl: 'https://global-surface-water.appspot.com/download',
		statements: [JRC_WATER_STATEMENT],
		citation: 'Pekel, J.-F., Cottam, A., Gorelick, N., Belward, A.S. (2016). High-resolution mapping of global surface water and its long-term changes. Nature 540, 418–422.'
	},
	{
		id: 'dpet',
		name: 'dPET (the daily files of hPET, potential evapotranspiration)',
		usedFor: 'The evaporation proposals: a catchment’s monthly reference evapotranspiration.',
		publisher: 'University of Bristol (data.bris); computed from ERA5-Land, Copernicus Climate Change Service',
		licence: 'Creative Commons Attribution 4.0 International (CC BY 4.0)',
		read: '2026-10-02',
		licenceUrl: 'https://data.bris.ac.uk/data/dataset/qb8ujazzda0s2aykkv0oq0ctp',
		statements: [DPET_STATEMENT],
		citation: 'Singer, M.B. et al. (2021). Scientific Data 8, 224. Dataset: https://doi.org/10.5523/bris.qb8ujazzda0s2aykkv0oq0ctp'
	},
	{
		id: 'chirps',
		name: 'CHIRPS v3 daily rainfall and the CHIRPS-GEFS v3 forecast',
		usedFor: 'The rain feeds: satellite rainfall over a catchment, and the rain forecast.',
		publisher: 'Climate Hazards Center, UC Santa Barbara',
		licence: 'Public domain, and Creative Commons Attribution 4.0 International (CC BY 4.0)',
		licenceUrl: 'https://www.chc.ucsb.edu/data/chirps3',
		read: '2026-10-01',
		statements: ['Climate Hazards Center Infrared Precipitation with Stations version 3 (CHIRPS3) Data Repository: https://doi.org/10.15780/G2JQ0P (2025).']
	},
	// The rain data copy's other products (issue #604 R4-E, docs/data-sources.md): ERA5-Land and IMERG Late fill catchment-rain gaps where a
	// project chooses them, and the ECMWF ENS forecast feeds the rain forecast. Each notice is the engine's (liability/rainCredits.ts), the
	// one every other place their values show prints; read now, so Copernicus's year and IMERG's day accessed are today's.
	{
		id: 'era-land',
		name: 'ERA5-Land daily precipitation',
		usedFor: 'Filling gaps in the catchment rain where a project’s Rain gaps setting chooses it, and the Data tab’s rain products side by side.',
		publisher: 'ECMWF, for the Copernicus Climate Change Service (C3S)',
		licence: 'Creative Commons Attribution 4.0 International (CC BY 4.0)',
		licenceUrl: 'https://cds.climate.copernicus.eu/datasets/reanalysis-era5-land',
		read: '2026-10-27',
		statements: [copernicusEra5lNotice(new Date().getUTCFullYear())],
		citation: ERA5L_CITATION
	},
	{
		id: 'imerg',
		name: 'GPM IMERG Late Run, daily (V07)',
		usedFor: 'Filling the last few days of the catchment rain, before CHIRPS’ first values, where a project’s Rain gaps setting chooses it.',
		publisher: 'NASA Goddard Earth Sciences Data and Information Services Center (GES DISC)',
		licence: 'NASA open data (CC0 by NASA’s data use guidance; CC BY 4.0 on the AWS Open Data registry), credited as CC BY asks',
		licenceUrl: 'https://www.earthdata.nasa.gov/engage/open-data-services-software-policies/data-use-guidance',
		read: '2026-10-27',
		statements: [imergCitation(new Date().toISOString().slice(0, 10))]
	},
	{
		id: 'ecmwf-ens',
		name: 'ECMWF open data: the ENS 15-day rain forecast',
		usedFor: 'The rain forecast, where an ECMWF ENS feed writes it.',
		publisher: 'European Centre for Medium-Range Weather Forecasts (ECMWF)',
		licence: 'Creative Commons Attribution 4.0 International (CC BY 4.0) and the ECMWF Terms of Use',
		licenceUrl: 'https://www.ecmwf.int/en/forecasts/datasets/open-data',
		read: '2026-10-27',
		statements: [ECMWF_CREDIT]
	},
	{
		id: 'waas-map',
		name: 'Mean annual rainfall surface for the Southwestern Cape (WAAS, 2007)',
		usedFor: 'The map’s MAP grid layer, and the mean annual rainfall a unit’s MAP is proposed from.',
		publisher: 'Beuster Clarke & Associates, for the Western Cape Water Availability Assessment Study (WAAS) of the Department of Water Affairs and Forestry (now the Department of Water and Sanitation)',
		licence: 'No licence terms came with the copy used; it is shown with the credit its authors give',
		read: '2026-10-23',
		statements: [WAAS_MAP_STATEMENT]
	},
	{
		id: 'geonames',
		name: 'GeoNames gazetteer (South Africa and its neighbours)',
		usedFor:
			'The Map’s search: the place and farm names it finds, after the map’s own layers, in South Africa and, where the map reaches over the border, in Botswana, Lesotho, Mozambique, Namibia, Eswatini and Zimbabwe.',
		publisher: 'GeoNames (geonames.org)',
		licence: 'Creative Commons Attribution 4.0 International (CC BY 4.0)',
		licenceUrl: 'https://download.geonames.org/export/dump/readme.txt',
		read: '2026-10-13',
		statements: [GEONAMES_STATEMENT]
	},
	{
		id: 'grdc-caravan',
		name: 'GRDC-Caravan (the regional GR4J prior’s donor basins)',
		usedFor: 'The regional GR4J prior on the Calibration page: GR4J fitted, offline, to gauged basins in the region; only the fitted parameters are loaded, never the flows.',
		publisher: 'Färber et al. (2025) on Zenodo, from data held by the Global Runoff Data Centre (GRDC) and its providers',
		licence: 'Creative Commons Attribution 4.0 International (CC BY 4.0); South Africa’s and Namibia’s records “free to use”',
		licenceUrl: 'https://doi.org/10.5281/zenodo.15349031',
		read: '2026-10-28',
		statements: [CARAVAN_STATEMENT],
		citation: 'Färber, C. et al. (2025). GRDC-Caravan: extending Caravan with data from the Global Runoff Data Centre. Zenodo, https://doi.org/10.5281/zenodo.15349031. Kratzert, F. et al. (2023). Caravan, a global community dataset for large-sample hydrology. Scientific Data 10, 61.'
	},
	{
		id: 'hydroatlas',
		name: 'HydroATLAS v1.0 (BasinATLAS basin attributes)',
		usedFor: 'The regional GR4J prior: the donor basins’ aridity, rainfall, slope, soil texture and forest, on which they are compared.',
		publisher: 'WWF and McGill University (HydroSHEDS)',
		licence: 'Creative Commons Attribution 4.0 International (CC BY 4.0)',
		licenceUrl: 'https://www.hydrosheds.org/hydroatlas',
		read: '2026-10-28',
		statements: [HYDROATLAS_STATEMENT],
		citation: 'Linke, S. et al. (2019). Global hydro-environmental sub-basin and river reach characteristics at high spatial resolution. Scientific Data 6, 283.'
	},
	{
		id: 'soilgrids',
		name: 'SoilGrids 2.0 water retention',
		usedFor: 'The regional GR4J prior: a catchment’s and each donor’s root-zone plant-available water capacity, to which X1 is related.',
		publisher: 'ISRIC – World Soil Information',
		licence: 'Creative Commons Attribution 4.0 International (CC BY 4.0)',
		licenceUrl: 'https://www.isric.org/explore/soilgrids/faq-soilgrids',
		read: '2026-10-28',
		statements: [SOILGRIDS_STATEMENT],
		citation: 'Turek, M.E. et al. (2023). Global mapping of volumetric water retention at 100, 330 and 15 000 cm suction using the WoSIS database. International Soil and Water Conservation Research 11(2), 225–239.'
	},
	{
		id: 'isdasoil',
		name: 'iSDAsoil depth to bedrock',
		usedFor: 'The regional GR4J prior: where the root zone ends, for the soil water capacity.',
		publisher: 'Innovative Solutions for Decision Agriculture (iSDA)',
		licence: 'Creative Commons Attribution 4.0 International (CC BY 4.0)',
		licenceUrl: 'https://registry.opendata.aws/isdasoil/',
		read: '2026-10-28',
		statements: [ISDA_STATEMENT]
	},
	{
		id: 'deafrica',
		name: 'Digital Earth Africa Waterbodies and WOfS',
		usedFor: 'Dams seen from space: the water surface satellites saw on a traced dam, beside the model’s, on the Dams tab and the farm’s dam page.',
		publisher: 'Digital Earth Africa',
		licence: 'Creative Commons Attribution 4.0 (CC BY 4.0), commercial use allowed with attribution',
		licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
		read: '2026-10-27',
		statements: [DEAFRICA_STATEMENT]
	},
	{
		id: 'copernicus-sentinel',
		name: 'Copernicus Sentinel-2 and Sentinel-1 (Digital Earth Africa’s analysis-ready data)',
		usedFor:
			'Dams seen from space: the water inside each traced dam’s outline, from Sentinel-2 at 10 m and Sentinel-1 radar through cloud. The credit names the years of the views it stands under.',
		publisher: 'The European Union’s Copernicus programme and the European Space Agency; processed by Digital Earth Africa',
		licence: 'The legal notice on the use of Copernicus Sentinel data (Regulation (EU) No 1159/2013): free, full and open, modification and commercial use allowed with the credit',
		licenceUrl: 'https://sentinels.copernicus.eu/documents/247904/690755/Sentinel_Data_Legal_Notice',
		read: '2026-10-27',
		statements: [SENTINEL_STATEMENT]
	},
	{
		id: 'fonts',
		name: 'Noto Sans map labels',
		usedFor: 'The lettering of place names and catchment codes on the map.',
		publisher: 'The Noto Project Authors; packaged by Protomaps',
		licence: 'SIL Open Font License 1.1',
		licenceUrl: 'https://openfontlicense.org/open-font-license-official-text/',
		read: '2026-10-01',
		statements: ['Noto Sans © The Noto Project Authors, under the SIL Open Font License 1.1.']
	}
];

/** The day the licences above were last read (the latest of their `read` dates): the page's line under its title. */
export const LICENCES_READ = DATA_CREDITS.map((c) => c.read).reduce((a, b) => (a > b ? a : b));
