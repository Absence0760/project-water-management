import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WATER_FIXTURE_FILE } from '../src/delineation/waterFixture.js';
import { buildWaterFixture } from './water-fixture.js';

describe('the committed synthetic water occurrence raster', () => {
	it('is exactly what the generator writes (re-run `pnpm -C backend gen:water-fixture` after changing the water)', () => {
		expect(Buffer.compare(buildWaterFixture(), readFileSync(WATER_FIXTURE_FILE))).toBe(0);
	});
});
