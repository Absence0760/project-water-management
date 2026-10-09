import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FIXTURE_FILE, FIXTURE_TILE, FIXTURE_X0, FIXTURE_Y0, FIXTURE_ZOOM, fixtureElevation } from '../src/delineation/fixture.js';
import { tileId } from '../src/delineation/pmtiles.js';
import { buildFixture } from './dem-fixture.js';
import { archiveDifferences } from './pmtiles-content.js';

// By content, not bytes (scripts/pmtiles-content.ts): the bytes also depend on the zlib that compressed them.
describe('the committed synthetic DEM', () => {
	const committed = readFileSync(FIXTURE_FILE);

	it('holds what the generator writes (re-run `pnpm -C backend gen:dem-fixture` after changing the terrain)', () => {
		expect(archiveDifferences(buildFixture(), committed)).toEqual([]);
	});

	it('fails on a terrain change as small as Terrarium stores (positive control)', () => {
		// One cell of the second tile across, 1/256 m higher.
		const cx = FIXTURE_TILE + 44;
		const cy = 40;
		const changed = buildFixture((x, y) => fixtureElevation(x, y) + (x === cx && y === cy ? 1 / 256 : 0));
		expect(archiveDifferences(changed, committed)).toEqual([expect.stringMatching(new RegExp(`^tile ${tileId(FIXTURE_ZOOM, FIXTURE_X0 + 1, FIXTURE_Y0)}: 1 pixel\\(s\\) differ, first at \\(44, 40\\)`))]);
	});
});
