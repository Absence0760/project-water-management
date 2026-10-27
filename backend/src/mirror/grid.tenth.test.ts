// The mirror's 0.1° grid (issue #604 R4-B): the product registry, the region
// at 0.1°, its corners, a 0.05° cell to the 0.1° cell holding it, and the
// day-of-year maths the finals layout uses on either grid.
import { describe, expect, it } from 'vitest';
import { chcCell, gridCellCentre, productCell, uniqueCells } from '../feeds/cellCache.js';
import { dailyChunk, DAILY_CHUNK, DAILY_CHUNK_P1 } from './arrays.js';
import { chcCellOf, dateOfDoy, doyIndex, globalSize, gridOf, MIRROR_REGION, mirrorCell, MirrorOutsideRegionError, productGrid, productStep, regionSize } from './grid.js';

describe('the product registry', () => {
	it('names each product’s step and layout', () => {
		expect(productGrid('rnl')).toMatchObject({ step: 0.05, kind: 'finals', firstDay: '1981-01-01' });
		expect(productGrid('sat')).toMatchObject({ step: 0.05, kind: 'finals', firstDay: '1998-01-01' });
		expect(productGrid('prelim')).toMatchObject({ step: 0.05, kind: 'daily' });
		expect(productGrid('era5l')).toMatchObject({ step: 0.1, kind: 'finals', firstDay: '1950-01-01', firstYear: 1950 });
		expect(productGrid('imerg_late')).toMatchObject({ step: 0.1, kind: 'daily', firstDay: '2000-06-01' });
		expect(productGrid('gefs/2026-02-09')).toMatchObject({ step: 0.05, kind: 'daily' });
		expect(productGrid('ecmwf/2026-02-09')).toMatchObject({ step: 0.1, kind: 'daily' });
		expect(productGrid('gefs/latest')).toBeNull();
		expect(productGrid('toString')).toBeNull();
		expect(() => productStep('nope')).toThrow(RangeError);
	});

	it('chunks the daily layout into 25 chunks a day on either grid', () => {
		expect(dailyChunk(0.05)).toBe(DAILY_CHUNK);
		expect(dailyChunk(0.1)).toBe(DAILY_CHUNK_P1);
		for (const step of [0.05, 0.1]) {
			const { rows, cols } = regionSize(MIRROR_REGION, step);
			const [, ch, cw] = dailyChunk(step);
			expect(Math.ceil(rows / ch) * Math.ceil(cols / cw)).toBe(25);
		}
	});
});

describe('the 0.1° grid (D1 at 0.1°)', () => {
	it('is 310 columns × 275 rows, its origin the south-west cell’s centre (35.45° S, 10.05° E)', () => {
		expect(regionSize(MIRROR_REGION, 0.1)).toEqual({ rows: 275, cols: 310 });
		expect(gridOf(MIRROR_REGION, 0.1)).toEqual({ origin: { lat: -35.45, lon: 10.05 }, step: 0.1 });
		expect(globalSize(0.1)).toEqual({ rows: 1200, cols: 3600 });
		expect(globalSize(0.05)).toEqual({ rows: 2400, cols: 7200 });
	});

	it('maps the region’s corners, and one cell north and east', () => {
		expect(mirrorCell(productCell('era5l', -35.45, 10.05), MIRROR_REGION, 0.1)).toEqual({ y: 0, x: 0 });
		expect(mirrorCell(productCell('era5l', -8.05, 40.95), MIRROR_REGION, 0.1)).toEqual({ y: 274, x: 309 });
		expect(mirrorCell(productCell('era5l', -35.35, 10.15), MIRROR_REGION, 0.1)).toEqual({ y: 1, x: 1 });
		// The global 0.1° cell of the south-west corner: row (60 + 35.45 − 0.05) / 0.1, column (180 + 10) / 0.1.
		expect(productCell('era5l', -35.45, 10.05)).toEqual({ row: 954, col: 1900 });
		for (const m of [{ y: 0, x: 0 }, { y: 274, x: 309 }, { y: 150, x: 77 }]) {
			const c = chcCellOf(m, MIRROR_REGION, 0.1);
			expect(mirrorCell(c, MIRROR_REGION, 0.1)).toEqual(m);
			const centre = gridCellCentre(c, 0.1);
			expect(centre.lat).toBeCloseTo(-35.45 + m.y * 0.1, 9);
			expect(centre.lon).toBeCloseTo(10.05 + m.x * 0.1, 9);
		}
	});

	it('refuses a 0.1° cell outside the region, naming the point', () => {
		for (const [lat, lon] of [
			[-35.55, 20],
			[-7.95, 20],
			[-20, 9.95],
			[-20, 41.05]
		] as const) {
			expect(() => mirrorCell(productCell('imerg_late', lat, lon), MIRROR_REGION, 0.1)).toThrow(MirrorOutsideRegionError);
		}
	});

	it('maps each 0.05° cell to the 0.1° cell that holds it: four to one, edges as the 0.05° cell goes', () => {
		// The four 0.05° cells of the 0.1° cell 20.0–20.1° S, 25.0–25.1° E.
		const quarter = [
			[-20.025, 25.025],
			[-20.025, 25.075],
			[-20.075, 25.025],
			[-20.075, 25.075]
		] as const;
		const tenth = productCell('era5l', -20.05, 25.05);
		for (const [lat, lon] of quarter) {
			const c = chcCell(lat, lon);
			expect(productCell('era5l', lat, lon)).toEqual({ row: Math.floor(c.row / 2), col: Math.floor(c.col / 2) });
			expect(productCell('imerg_late', lat, lon)).toEqual(tenth);
		}
		// Its neighbours to the south and east are other cells.
		expect(productCell('era5l', -20.125, 25.025)).toEqual({ row: tenth.row + 1, col: tenth.col });
		expect(productCell('era5l', -20.025, 25.125)).toEqual({ row: tenth.row, col: tenth.col + 1 });
		// A point on a 0.1° edge goes where its 0.05° cell goes (east / south: pixelOf's rule).
		expect(productCell('era5l', -20.1, 25.1)).toEqual({ row: tenth.row + 1, col: tenth.col + 1 });
		// CHIRPS products are their own grid.
		expect(productCell('sat', -20.025, 25.075)).toEqual(chcCell(-20.025, 25.075));
		// A feed's cells, each 0.1° cell once.
		expect(uniqueCells(quarter.map(([lat, lon]) => ({ lat, lon })), 'era5l')).toEqual([tenth]);
		expect(uniqueCells(quarter.map(([lat, lon]) => ({ lat, lon })))).toHaveLength(4);
	});

	it('counts days of year the same on either grid, 29 February only in a leap year', () => {
		expect(doyIndex('2024-02-29')).toBe(59);
		expect(doyIndex('2024-12-31')).toBe(365);
		expect(doyIndex('2025-12-31')).toBe(364);
		expect(dateOfDoy(2025, 365)).toBeNull();
		expect(dateOfDoy(2024, 365)).toBe('2024-12-31');
		expect(dateOfDoy(2000, 365)).toBe('2000-12-31');
		expect(dateOfDoy(1900, 365)).toBeNull();
	});
});
