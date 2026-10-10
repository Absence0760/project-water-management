import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { tileId } from '../src/delineation/pmtiles.js';
import { fixtureOccurrence, WATER_FIXTURE_FILE, WATER_FIXTURE_TILE, WATER_FIXTURE_X0, WATER_FIXTURE_Y0, WATER_FIXTURE_ZOOM } from '../src/delineation/waterFixture.js';
import { archiveDifferences } from './pmtiles-content.js';
import { buildWaterFixture } from './water-fixture.js';

// By content, not bytes (scripts/pmtiles-content.ts): the bytes also depend on the zlib that compressed them.
describe('the committed synthetic water occurrence raster', () => {
	const committed = readFileSync(WATER_FIXTURE_FILE);

	it('holds what the generator writes (re-run `pnpm -C backend gen:water-fixture` after changing the water)', () => {
		expect(archiveDifferences(buildWaterFixture(), committed)).toEqual([]);
	});

	it('fails on a one-cell, one-percent change in the water (positive control)', () => {
		// The dam's middle (150, 330: the first tile across, the second down), 86 % instead of 85 %.
		const changed = buildWaterFixture((x, y) => fixtureOccurrence(x, y) + (x === 150 && y === 330 ? 1 : 0));
		const id = tileId(WATER_FIXTURE_ZOOM, WATER_FIXTURE_X0, WATER_FIXTURE_Y0 + 1);
		expect(archiveDifferences(changed, committed)).toEqual([expect.stringMatching(new RegExp(`^tile ${id}: 1 pixel\\(s\\) differ, first at \\(150, ${330 - WATER_FIXTURE_TILE}\\)`))]);
	});
});
