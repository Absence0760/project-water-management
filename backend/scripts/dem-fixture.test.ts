import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FIXTURE_FILE } from '../src/delineation/fixture.js';
import { buildFixture } from './dem-fixture.js';

describe('the committed synthetic DEM', () => {
	it('is exactly what the generator writes (re-run `pnpm -C backend gen:dem-fixture` after changing the terrain)', () => {
		expect(Buffer.compare(buildFixture(), readFileSync(FIXTURE_FILE))).toBe(0);
	});
});
