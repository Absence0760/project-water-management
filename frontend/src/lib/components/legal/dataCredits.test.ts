// The data credits (dataCredits.ts, /data-sources and the map's attribution):
// each licensor's required wording matches the licence as read and recorded
// in docs/maps.md § Sources (and the Copernicus liability sentence in
// docs/followups.md), and the map's own notices say the same.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LICENCES_READ, licencesReadLine, readDay, COPERNICUS_LIABILITY, COPERNICUS_NOTICE, DATA_CREDITS, DPET_STATEMENT, HYDRORIVERS_MAP_ATTRIBUTION, HYDROSHEDS_STATEMENT, JRC_WATER_STATEMENT, WORLDCOVER_STATEMENT } from './dataCredits';
import { TERRAIN_ATTRIBUTION } from '$lib/components/map/mapStyle';
import { COPERNICUS_NOTICE as DELINEATION_NOTICE } from '$lib/components/map/delineation';

const doc = (name: string) => readFileSync(new URL(`../../../../../docs/${name}`, import.meta.url), 'utf8').replace(/\s+/g, ' ');

describe('the data credits', () => {
	it('quote each licence’s required wording as docs/maps.md records it', () => {
		const maps = doc('maps.md');
		expect(maps).toContain(HYDROSHEDS_STATEMENT);
		expect(maps).toContain(`"${COPERNICUS_NOTICE}"`);
		expect(maps).toContain(`"${WORLDCOVER_STATEMENT}"`);
		expect(maps).toContain(`"${JRC_WATER_STATEMENT}"`);
		expect(maps).toContain(`"${DPET_STATEMENT}"`);
		expect(doc('followups.md')).toContain(`"${COPERNICUS_LIABILITY}"`);
		// Each credit's read date is one the Sources table records, and the page's "Licences last read" is the latest.
		for (const c of DATA_CREDITS) expect(maps, c.name).toContain(`read ${c.read}`);
		expect(LICENCES_READ).toBe([...DATA_CREDITS.map((c) => c.read)].sort().at(-1));
		expect(licencesReadLine('2026-10-01')).toBe('Licences last read 1 October 2026');
		expect(readDay('2026-10-02')).toBe('2 October 2026');
	});

	it('carry the HydroSHEDS statement, the Copernicus notice and its liability sentence, and the WorldCover credit', () => {
		const all = DATA_CREDITS.flatMap((c) => c.statements).join('\n');
		for (const s of [HYDROSHEDS_STATEMENT, COPERNICUS_NOTICE, COPERNICUS_LIABILITY, WORLDCOVER_STATEMENT, JRC_WATER_STATEMENT, DPET_STATEMENT]) expect(all).toContain(s);
		expect(HYDROSHEDS_STATEMENT).toContain('This product [Water Management] incorporates data from the HydroSHEDS version 1 database');
	});

	it('give every dataset its own section id, a licence link and at least one statement', () => {
		expect(new Set(DATA_CREDITS.map((c) => c.id)).size).toBe(DATA_CREDITS.length);
		for (const c of DATA_CREDITS) {
			expect(c.id, c.name).toMatch(/^[a-z][a-z-]*$/);
			expect(c.licenceUrl, c.name).toMatch(/^https:\/\//);
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
	});

	it('say what the map’s own notices say: the relief’s attribution and a delineated polygon’s notice', () => {
		expect(TERRAIN_ATTRIBUTION).toContain(COPERNICUS_NOTICE);
		expect(DELINEATION_NOTICE).toBe(`P${COPERNICUS_NOTICE.slice(1)}.`);
		expect(HYDRORIVERS_MAP_ATTRIBUTION).toContain('© World Wildlife Fund, Inc. (2006-2022)');
	});
});
