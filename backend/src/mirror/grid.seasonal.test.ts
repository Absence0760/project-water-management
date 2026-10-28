// The mirror's third grid (issue #620): C3S's seasonal forecasts and
// hindcasts on 1° cells centred on whole degrees over D1 snapped outward, the
// same definition as ingest/grid.py C3S, so a reader of `c3s/<init>` or
// `c3s-hc/<system>/<MM>` and the ingest agree on every cell.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { gridOf, MIRROR_REGION, productGrid, productStep, regionSize, SEASONAL_REGION, seasonalRegion } from './grid.js';

describe('the seasonal grid (1°, issue #620)', () => {
	it('names the c3s products, and only theirs', () => {
		for (const p of ['c3s/2026-10', 'c3s/2027-01', 'c3s-hc/ecmwf-51/10', 'c3s-hc/meteo_france-9/01']) {
			expect(productGrid(p), p).toEqual({ step: 1, kind: 'seasonal', region: SEASONAL_REGION });
			expect(productStep(p)).toBe(1);
		}
		for (const p of ['c3s/2026-13', 'c3s/2026-10-01', 'c3s', 'c3s-hc/ecmwf/10', 'c3s-hc/ecmwf-51/00', 'c3s-hc/ecmwf-51']) expect(productGrid(p), p).toBeNull();
		// Positive control: the other grids are untouched and keep D1.
		expect(productGrid('ecmwf/2026-02-09')).toEqual({ step: 0.1, kind: 'daily' });
	});

	it('is D1 snapped outward to whole-degree centres: 29 rows × 32 columns, [0, 0] at 36° S, 10° E', () => {
		expect(SEASONAL_REGION).toEqual({ w: 9.5, s: -36.5, e: 41.5, n: -7.5 });
		expect(seasonalRegion(MIRROR_REGION, 1)).toEqual(SEASONAL_REGION);
		expect(regionSize(SEASONAL_REGION, 1)).toEqual({ rows: 29, cols: 32 });
		expect(gridOf(SEASONAL_REGION, 1)).toEqual({ origin: { lat: -36, lon: 10 }, step: 1 });
		// A region already on whole degrees keeps its centres: only the half-cell widening.
		expect(seasonalRegion({ w: 10, s: -36, e: 41, n: -8 })).toEqual(SEASONAL_REGION);
	});

	it('agrees with the ingest’s definition (ingest/grid.py)', () => {
		const py = readFileSync(new URL('../../../ingest/grid.py', import.meta.url), 'utf8');
		expect(py).toContain('def seasonal_region(region: dict = REGION, step: float = 1.0)');
		expect(py).toContain('[0, 0] centred at 36 S, 10 E');
	});
});
