// The data credits (dataCredits.ts, /data-sources and the map's attribution):
// each licensor's required wording matches the licence as read and recorded
// in docs/maps.md § Sources (and the Copernicus liability sentence in
// docs/followups.md), and the map's own notices say the same.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEAFRICA_STATEMENT, SENTINEL_STATEMENT, CARAVAN_STATEMENT, HYDROATLAS_STATEMENT, ISDA_STATEMENT, SOILGRIDS_STATEMENT, LICENCES_READ, licencesReadLine, readDay, COPERNICUS_LIABILITY, COPERNICUS_NOTICE, DATA_CREDITS, DPET_STATEMENT, HYDRORIVERS_MAP_ATTRIBUTION, HYDROSHEDS_STATEMENT, JRC_WATER_MAP_ATTRIBUTION, JRC_WATER_STATEMENT, WORLDCOVER_STATEMENT, GEONAMES_STATEMENT, WAAS_MAP_MAP_ATTRIBUTION, WAAS_MAP_STATEMENT } from './dataCredits';
import { copernicusEra5lNotice, ECMWF_CREDIT, ERA5L_CITATION } from '@water-management/engine';
import { TERRAIN_ATTRIBUTION } from '#lib/components/map/mapStyle.js';
import { COPERNICUS_NOTICE as DELINEATION_NOTICE } from '#lib/components/map/delineation.js';

const doc = (name: string) => readFileSync(new URL(`../../../../../docs/${name}`, import.meta.url), 'utf8').replace(/\s+/g, ' ');

describe('the data credits', () => {
	it('quote each licence’s required wording as docs/maps.md records it', () => {
		const maps = doc('maps.md');
		expect(maps).toContain(HYDROSHEDS_STATEMENT);
		expect(maps).toContain(`"${COPERNICUS_NOTICE}"`);
		expect(maps).toContain(`"${WORLDCOVER_STATEMENT}"`);
		expect(maps).toContain(`"${JRC_WATER_STATEMENT}"`);
		expect(maps).toContain(`"${DPET_STATEMENT}"`);
		expect(maps).toContain(`"${GEONAMES_STATEMENT}"`);
		expect(maps).toContain(`"${WAAS_MAP_STATEMENT}"`);
		// The operator's decision behind the Southwestern Cape surface's use is on record with its credit line.
		expect(doc('legal/map-data-licences.md')).toContain(`"${WAAS_MAP_STATEMENT}"`);
		expect(doc('followups.md')).toContain(`"${COPERNICUS_LIABILITY}"`);
		// The regional prior's sources (issue #622): as data-sources.md and maps.md record them, and as the backend stores them.
		const sources = doc('data-sources.md');
		expect(sources).toContain(CARAVAN_STATEMENT);
		expect(sources).toContain(`"${HYDROATLAS_STATEMENT}"`);
		expect(maps).toContain(`"${SOILGRIDS_STATEMENT}"`);
		expect(maps).toContain(`"${ISDA_STATEMENT}"`);
		const geo = (f: string) => readFileSync(new URL(`../../../../../backend/src/geo/${f}`, import.meta.url), 'utf8');
		expect(geo('gr4jDonors.ts')).toContain(`${CARAVAN_STATEMENT} ${HYDROATLAS_STATEMENT}`);
		expect(geo('soilGrid.ts')).toContain(`${SOILGRIDS_STATEMENT} ${ISDA_STATEMENT}`);
		// Each credit's read date is one the Sources table records, and the page's "Licences last read" is the latest.
		for (const c of DATA_CREDITS) expect(maps, c.name).toContain(`read ${c.read}`);
		expect(LICENCES_READ).toBe([...DATA_CREDITS.map((c) => c.read)].sort().at(-1));
		expect(licencesReadLine('2026-10-01')).toBe('Licences last read 1 October 2026');
		expect(readDay('2026-10-02')).toBe('2 October 2026');
	});

	it('carry the HydroSHEDS statement, the Copernicus notice and its liability sentence, and the WorldCover credit', () => {
		const all = DATA_CREDITS.flatMap((c) => c.statements).join('\n');
		for (const s of [HYDROSHEDS_STATEMENT, COPERNICUS_NOTICE, COPERNICUS_LIABILITY, WORLDCOVER_STATEMENT, JRC_WATER_STATEMENT, DPET_STATEMENT]) expect(all).toContain(s);
		expect(HYDROSHEDS_STATEMENT).toContain('This product [Integrated Catchment - Water Balance Tool] incorporates data from the HydroSHEDS version 1 database');
	});

	it('give every dataset its own section id, a licence link and at least one statement', () => {
		expect(new Set(DATA_CREDITS.map((c) => c.id)).size).toBe(DATA_CREDITS.length);
		for (const c of DATA_CREDITS) {
			expect(c.id, c.name).toMatch(/^[a-z][a-z-]*$/);
			// A link wherever terms are published; only a dataset published with no terms names none, and says so.
			if (c.licenceUrl === undefined) expect(c.licence, c.name).toMatch(/^No licence terms came with/);
			else expect(c.licenceUrl, c.name).toMatch(/^https:\/\//);
			expect(c.statements.length, c.name).toBeGreaterThan(0);
		}
		// The map's credit links here by this id.
		expect(DATA_CREDITS.some((c) => c.id === 'hydrorivers')).toBe(true);
	});

	it('credit the evaporation and the water archive as the backend and the tile script write them', () => {
		const backend = (path: string) => readFileSync(new URL(`../../../../../backend/src/${path}`, import.meta.url), 'utf8').replace(/\s+/g, ' ');
		// DPET.attribution, stored on the dataset row and shown under every evaporation proposal.
		expect(backend('geo/evaporationGrid.ts')).toContain(`'${DPET_STATEMENT}'`);
		// The water archive's attribution, which the dam trace writes into a traced feature's description.
		const tiles = readFileSync(new URL('../../../../../bin/tiles-dev.sh', import.meta.url), 'utf8');
		expect(tiles).toContain(`m.attribution="${JRC_WATER_STATEMENT}"`);
		// The backend's copy, which flags a traced dam for the farm map's credit (geo/credits.ts).
		expect(backend('geo/credits.ts')).toContain(`JRC_WATER_STATEMENT = '${JRC_WATER_STATEMENT}'`);
		// The Southwestern Cape MAP surface's credit line, which a production load stores as the grid's attribution (the layer's credit keys on it).
		expect(backend('geo/rainMap.ts')).toContain(`WAAS_MAP_ATTRIBUTION = '${WAAS_MAP_STATEMENT}'`);
		// The dam observations' credits (issue #604 R5, #624): DE Africa's, and Copernicus's for the Sentinel views.
		expect(backend('dams/observed/upstream.ts')).toContain(`DEAFRICA_ATTRIBUTION = '${DEAFRICA_STATEMENT}'`);
		expect(backend('dams/observed/upstream.ts')).toContain(`SENTINEL_ATTRIBUTION = '${SENTINEL_STATEMENT}'`);
		expect(doc('maps.md')).toContain(`"${SENTINEL_STATEMENT}"`);
		expect(doc('data-sources.md')).toContain(`"${SENTINEL_STATEMENT}"`);
		// GeoNames' attribution, stored on every place a load takes without a source of its own (the Map's search shows it).
		expect(backend('geo/gazetteer.ts')).toContain(`GEONAMES_SOURCE = '${GEONAMES_STATEMENT}'`);
	});

	it('credit the rain copy’s other products with the engine’s notices, as docs/maps.md and docs/data-sources.md quote them (issue #604 R4-E)', () => {
		const maps = doc('maps.md');
		const byId = (id: string) => DATA_CREDITS.find((c) => c.id === id)!;
		expect(byId('era-land').statements).toEqual([copernicusEra5lNotice(new Date().getUTCFullYear())]);
		expect(maps).toContain(copernicusEra5lNotice('[year]'));
		expect(byId('era-land').citation).toBe(ERA5L_CITATION);
		expect(byId('imerg').statements[0]).toMatch(/^Huffman, G\.J\..* accessed \d{4}-\d{2}-\d{2}, doi:10\.5067\/GPM\/IMERGDL\/DAY\/07\.$/);
		expect(byId('ecmwf-ens').statements).toEqual([ECMWF_CREDIT]);
		expect(maps).toContain(`"${ECMWF_CREDIT}"`);
	});

	it('say what the map’s own notices say: the relief’s attribution and a delineated polygon’s notice', () => {
		expect(TERRAIN_ATTRIBUTION).toContain(COPERNICUS_NOTICE);
		expect(DELINEATION_NOTICE).toBe(`P${COPERNICUS_NOTICE.slice(1)}.`);
		expect(HYDRORIVERS_MAP_ATTRIBUTION).toContain('© World Wildlife Fund, Inc. (2006-2022)');
		// A traced dam's credit names JRC's source as its download page asks, and says the data was modified (1159/2013 Art. 8(3)).
		expect(JRC_WATER_MAP_ATTRIBUTION).toContain(JRC_WATER_STATEMENT);
		expect(JRC_WATER_MAP_ATTRIBUTION).toMatch(/modified$/);
		// The MAP grid's credit on the map is short (its link opens the authors' line whole): it names the study and the authors, as their line does.
		expect(WAAS_MAP_MAP_ATTRIBUTION).toBe('MAP grid: WAAS (2007), Beuster Clarke & Associates');
		for (const part of ['WAAS', 'Beuster Clarke & Associates', '2007']) expect(WAAS_MAP_STATEMENT).toContain(part);
		expect(WAAS_MAP_MAP_ATTRIBUTION.length).toBeLessThanOrEqual(HYDRORIVERS_MAP_ATTRIBUTION.length);
	});
});
