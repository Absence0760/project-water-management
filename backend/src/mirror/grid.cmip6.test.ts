// The mirror's fourth grid (issue #621): NEX-GDDP-CMIP6's 0.25° cells, which
// tile D1 exactly, the same definition as ingest/grid.py CMIP6, so a reader of
// `cmip6/<model>/<scenario>` and ingest/cmip6_delta.py agree on every cell.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CMIP6_PRODUCT, gridOf, MIRROR_REGION, productGrid, productStep, regionSize } from './grid.js';

describe('the cmip6 grid (0.25°, issue #621)', () => {
	it('names the cmip6 products, and only theirs', () => {
		for (const p of ['cmip6/ACCESS-CM2/historical', 'cmip6/SYN-A/ssp245', 'cmip6/MPI-ESM1-2-HR/ssp585']) {
			expect(productGrid(p), p).toEqual({ step: 0.25, kind: 'monthly' });
			expect(productStep(p)).toBe(0.25);
		}
		for (const p of ['cmip6/SYN-A/ssp126', 'cmip6/SYN-A', 'cmip6//historical', 'cmip6/-A/historical', 'cmip6/SYN-A/ssp245/pr_mm']) expect(productGrid(p), p).toBeNull();
		expect(CMIP6_PRODUCT.exec('cmip6/SYN-B/ssp585')?.slice(1)).toEqual(['SYN-B', 'ssp585']);
		// Positive control: the other grids are untouched.
		expect(productGrid('era5l')).toMatchObject({ step: 0.1, kind: 'finals' });
	});

	it('tiles D1 exactly: 110 rows × 124 columns, [0, 0] centred at 35.375° S, 10.125° E', () => {
		expect(regionSize(MIRROR_REGION, 0.25)).toEqual({ rows: 110, cols: 124 });
		expect(gridOf(MIRROR_REGION, 0.25)).toEqual({ origin: { lat: -35.375, lon: 10.125 }, step: 0.25 });
	});

	it('agrees with the ingest’s definition (ingest/grid.py)', () => {
		const py = readFileSync(new URL('../../../ingest/grid.py', import.meta.url), 'utf8');
		expect(py).toContain('CMIP6 = _grid(0.25,');
		expect(py).toContain('CMIP6_PRODUCT = re.compile(r"^cmip6/[A-Za-z0-9][A-Za-z0-9-]*/(historical|ssp245|ssp585)$")');
	});
});
