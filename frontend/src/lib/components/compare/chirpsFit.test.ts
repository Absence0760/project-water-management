import { describe, expect, it } from 'vitest';
import { chirpsFitNote } from './chirpsFit';

describe('chirpsFitNote', () => {
	it('names the pooled factors and, when they differ, the water years left out', () => {
		expect(
			chirpsFitNote({ pooledFactor: { a: 2, b: 1.9, delta: -0.1 }, excludedWaterYearsA: [1999, 2003], excludedWaterYearsB: [2003], changed: true })
		).toBe(
			'The CHIRPS bias factors differ between the runs (pooled factor 2.00 → 1.90; water years left out of the fit: 1999/00, 2003/04 → 2003/04), ' +
				'so rain differs on the days CHIRPS fills in for blank catchment rain. Keep-dry or missing periods, the rain records, the CHIRPS settings (bias correction, fit period, quantile map) or the engine version can each move them.'
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

	it('names a change of fit period, of the ranges under the same period, or of a reference window (engine ≥ 0.29.0)', () => {
		const base = { pooledFactor: { a: 2, b: 2, delta: 0 }, excludedWaterYearsA: [], excludedWaterYearsB: [], changed: true };
		const listed = 'listed water years: 1990/91–1999/00 (old network)';
		expect(chirpsFitNote({ ...base, fitPeriodA: 'whole record', fitPeriodB: listed, segmentsA: [], segmentsB: ['range 1990/91–1999/00 (old network)'] })).toMatch(
			/\(pooled factor 2\.00 → 2\.00; fit period: whole record → listed water years: 1990\/91–1999\/00 \(old network\)\)/
		);
		expect(
			chirpsFitNote({ ...base, fitPeriodA: listed, fitPeriodB: listed, segmentsA: ['range 1990/91–1999/00 (a)'], segmentsB: ['range 1990/91–1999/00 (old network)'] })
		).toMatch(/fit ranges: range 1990\/91–1999\/00 \(a\) → range 1990\/91–1999\/00 \(old network\)\)/);
		expect(
			chirpsFitNote({ ...base, fitPeriodA: 'whole record', fitPeriodB: 'whole record', fitWindowsA: ['whole record: 1990/91–2009/10'], fitWindowsB: ['whole record: 1990/91–2011/12'] })
		).toMatch(/fitted on: whole record: 1990\/91–2009\/10 → whole record: 1990\/91–2011\/12\)/);
		// Runs from before 0.29.0 carry none of these: nothing added.
		expect(chirpsFitNote(base)).toMatch(/^The CHIRPS bias factors differ between the runs \(pooled factor 2\.00 → 2\.00\), so/);
	});

	it('names the CHIRPS gap map turned on, off or changed (engine ≥ 1.53.0)', () => {
		const base = { pooledFactor: { a: 2, b: 2, delta: 0 }, excludedWaterYearsA: [], excludedWaterYearsB: [], changed: true };
		expect(chirpsFitNote({ ...base, quantileMapA: null, quantileMapB: 'wet days (≥ 1 mm) mapped' })).toMatch(/\(pooled factor 2\.00 → 2\.00; quantile map: off → wet days \(≥ 1 mm\) mapped\)/);
		expect(chirpsFitNote({ ...base, quantileMapA: 'x', quantileMapB: null })).toMatch(/quantile map: x → off\)/);
		// Positive control: the same map on both sides adds nothing.
		expect(chirpsFitNote({ ...base, quantileMapA: 'x', quantileMapB: 'x' })).toMatch(/^The CHIRPS bias factors differ between the runs \(pooled factor 2\.00 → 2\.00\), so/);
	});
});
