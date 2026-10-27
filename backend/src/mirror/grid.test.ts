import { describe, expect, it } from 'vitest';
import { cellCentre, chcCell } from '../feeds/cellCache.js';
import { FeedFormatError } from '../feeds/errors.js';
import {
	cellsByChunk,
	chcCellOf,
	chunkOf,
	dateOfDoy,
	dayIndex,
	doyIndex,
	gridOf,
	isLeapYear,
	MIRROR_REGION,
	mirrorCell,
	MirrorOutsideRegionError,
	regionSize
} from './grid.js';

describe('the mirror grid (D1)', () => {
	it('is 620 columns × 550 rows, its origin the south-west cell’s centre', () => {
		expect(regionSize(MIRROR_REGION)).toEqual({ rows: 550, cols: 620 });
		expect(gridOf(MIRROR_REGION)).toEqual({ origin: { lat: -35.475, lon: 10.025 }, step: 0.05 });
	});

	it('maps a CHC cell to (y, x), y growing north and x east', () => {
		// The south-west and north-east corners of the region.
		expect(mirrorCell(chcCell(-35.475, 10.025))).toEqual({ y: 0, x: 0 });
		expect(mirrorCell(chcCell(-8.025, 40.975))).toEqual({ y: 549, x: 619 });
		// One cell north is y + 1; one east is x + 1.
		expect(mirrorCell(chcCell(-35.425, 10.075))).toEqual({ y: 1, x: 1 });
		// The fixture grid's north-west cell (fixtures/feeds/chirps-sample.json).
		expect(mirrorCell(chcCell(-20.025, 25.025))).toEqual({ y: 309, x: 300 });
	});

	it('round-trips every corner through chcCellOf, and lands on the same cell centre', () => {
		for (const m of [{ y: 0, x: 0 }, { y: 549, x: 619 }, { y: 309, x: 300 }, { y: 19, x: 20 }]) {
			const c = chcCellOf(m);
			expect(mirrorCell(c)).toEqual(m);
			const centre = cellCentre(c);
			expect(centre.lat).toBeCloseTo(-35.475 + m.y * 0.05, 9);
			expect(centre.lon).toBeCloseTo(10.025 + m.x * 0.05, 9);
		}
	});

	it('refuses a cell outside the region with a clear FeedFormatError', () => {
		for (const [lat, lon] of [
			[-35.525, 20],
			[-7.975, 20],
			[-20, 9.975],
			[-20, 41.025],
			[51.5, -0.1]
		] as const) {
			const err = (() => {
				try {
					mirrorCell(chcCell(lat, lon));
				} catch (e) {
					return e;
				}
			})();
			expect(err).toBeInstanceOf(MirrorOutsideRegionError);
			expect(err).toBeInstanceOf(FeedFormatError);
			expect((err as Error).message).toMatch(/outside the region the rain data copy holds \(10–41° E, 8–35\.5° S\)/);
		}
		// Positive control: the edge cells just inside are held.
		expect(() => mirrorCell(chcCell(-35.475, 40.975))).not.toThrow();
	});
});

describe('the D2 day indices', () => {
	it('knows leap years', () => {
		expect([1900, 2000, 2023, 2024, 2100].map(isLeapYear)).toEqual([false, true, false, true, false]);
	});

	it('counts the day of year from 1 January, so 31 December is 364 or 365', () => {
		expect(doyIndex('2024-01-01')).toBe(0);
		expect(doyIndex('2024-02-29')).toBe(59);
		expect(doyIndex('2024-03-01')).toBe(60);
		expect(doyIndex('2023-03-01')).toBe(59);
		expect(doyIndex('2024-12-31')).toBe(365);
		expect(doyIndex('2023-12-31')).toBe(364);
	});

	it('has no date for index 365 in a non-leap year', () => {
		expect(dateOfDoy(2023, 365)).toBeNull();
		expect(dateOfDoy(2024, 365)).toBe('2024-12-31');
		expect(dateOfDoy(2023, 364)).toBe('2023-12-31');
		expect(dateOfDoy(2023, -1)).toBeNull();
	});

	it('counts the daily layout’s days from firstDay', () => {
		expect(dayIndex('2026-01-01', '2026-01-01')).toBe(0);
		expect(dayIndex('2025-12-30', '2026-01-02')).toBe(3);
	});
});

describe('chunk maths', () => {
	it('places an index in its chunk', () => {
		expect(chunkOf(0, 20)).toEqual({ chunk: 0, offset: 0 });
		expect(chunkOf(19, 20)).toEqual({ chunk: 0, offset: 19 });
		expect(chunkOf(20, 20)).toEqual({ chunk: 1, offset: 0 });
		expect(chunkOf(549, 110)).toEqual({ chunk: 4, offset: 109 });
		expect(chunkOf(619, 124)).toEqual({ chunk: 4, offset: 123 });
	});

	it('groups cells by chunk, each group with its own bounding box', () => {
		const groups = cellsByChunk(
			[
				{ y: 19, x: 19 },
				{ y: 20, x: 19 },
				{ y: 0, x: 5 },
				{ y: 25, x: 21 }
			],
			20,
			20
		);
		expect(groups).toEqual([
			{ y0: 0, y1: 19, x0: 5, x1: 19, cells: [0, 2] },
			{ y0: 20, y1: 20, x0: 19, x1: 19, cells: [1] },
			{ y0: 25, y1: 25, x0: 21, x1: 21, cells: [3] }
		]);
	});
});
