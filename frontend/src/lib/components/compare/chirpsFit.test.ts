import { describe, expect, it } from 'vitest';
import { chirpsFitNote } from './chirpsFit';

describe('chirpsFitNote', () => {
	it('names the pooled factors and, when they differ, the water years left out', () => {
		expect(
			chirpsFitNote({ pooledFactor: { a: 2, b: 1.9, delta: -0.1 }, excludedWaterYearsA: [1999, 2003], excludedWaterYearsB: [2003], changed: true })
		).toBe(
			'The CHIRPS bias factors differ between the runs (pooled factor 2.00 → 1.90; water years left out of the fit: 1999/00, 2003/04 → 2003/04), ' +
				'so rain differs on the days CHIRPS fills in for blank catchment rain. Keep-dry or missing periods, the rain records, the CHIRPS setting or the engine version can each move them.'
		);
	});

	it('leaves the years out when they are the same, and says when a side has no fit', () => {
		expect(chirpsFitNote({ pooledFactor: { a: 2, b: 2.1, delta: 0.1 }, excludedWaterYearsA: [], excludedWaterYearsB: [], changed: true })).toMatch(
			/^The CHIRPS bias factors differ between the runs \(pooled factor 2\.00 → 2\.10\), so/
		);
		expect(chirpsFitNote({ pooledFactor: { a: null, b: 2, delta: null }, excludedWaterYearsA: null, excludedWaterYearsB: [], changed: true })).toMatch(
			/pooled factor none → 2\.00; water years left out of the fit: no fit → none\)/
		);
	});
});
