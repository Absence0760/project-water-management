// The data credits (dataCredits.ts, /data-sources and the map's attribution):
// each licensor's required wording matches the licence as read and recorded
// in docs/maps.md § Sources (and the Copernicus liability sentence in
// docs/followups.md), and the map's own notices say the same.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LICENCES_READ, licencesReadLine, COPERNICUS_LIABILITY, COPERNICUS_NOTICE, DATA_CREDITS, HYDRORIVERS_MAP_ATTRIBUTION, HYDROSHEDS_STATEMENT, WORLDCOVER_STATEMENT } from './dataCredits';
import { TERRAIN_ATTRIBUTION } from '$lib/components/map/mapStyle';
import { COPERNICUS_NOTICE as DELINEATION_NOTICE } from '$lib/components/map/delineation';

const doc = (name: string) => readFileSync(new URL(`../../../../../docs/${name}`, import.meta.url), 'utf8').replace(/\s+/g, ' ');

describe('the data credits', () => {
	it('quote each licence’s required wording as docs/maps.md records it', () => {
		const maps = doc('maps.md');
		expect(maps).toContain(HYDROSHEDS_STATEMENT);
		expect(maps).toContain(`"${COPERNICUS_NOTICE}"`);
		expect(maps).toContain(`"${WORLDCOVER_STATEMENT}"`);
		expect(doc('followups.md')).toContain(`"${COPERNICUS_LIABILITY}"`);
		// The page's "Licences last read" date is the one the Sources table records.
		expect(maps).toContain(`read ${LICENCES_READ}`);
		expect(licencesReadLine('2026-10-01')).toBe('Licences last read 1 October 2026');
	});

	it('carry the HydroSHEDS statement, the Copernicus notice and its liability sentence, and the WorldCover credit', () => {
		const all = DATA_CREDITS.flatMap((c) => c.statements).join('\n');
		for (const s of [HYDROSHEDS_STATEMENT, COPERNICUS_NOTICE, COPERNICUS_LIABILITY, WORLDCOVER_STATEMENT]) expect(all).toContain(s);
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

	it('say what the map’s own notices say: the relief’s attribution and a delineated polygon’s notice', () => {
		expect(TERRAIN_ATTRIBUTION).toContain(COPERNICUS_NOTICE);
		expect(DELINEATION_NOTICE).toBe(`P${COPERNICUS_NOTICE.slice(1)}.`);
		expect(HYDRORIVERS_MAP_ATTRIBUTION).toContain('© World Wildlife Fund, Inc. (2006-2022)');
	});
});
