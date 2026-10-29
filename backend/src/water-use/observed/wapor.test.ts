// What a WaPOR dekad file is and one unit's mean from it (wapor.ts, issue #623).
import { describe, expect, it } from 'vitest';
import { outlineMask } from '../../raster/mask.js';
import { dekadEnd, dekadOf, dekadOfFileName, endedDekads, nextDekad, previousDekad, unitMean, unitWeights, waporFileName, waporUrl } from './wapor.js';

describe('dekads', () => {
	it('steps through the three dekads of a month, the third running to the month’s end', () => {
		expect(dekadOf('2024-02-29')).toBe('2024-02-21');
		expect(dekadOf('2024-02-10')).toBe('2024-02-01');
		expect(dekadOf('2024-02-11')).toBe('2024-02-11');
		expect(nextDekad('2024-12-21')).toBe('2025-01-01');
		expect(previousDekad('2025-01-01')).toBe('2024-12-21');
		expect(previousDekad('2024-03-11')).toBe('2024-03-01');
		expect(dekadEnd('2024-02-21')).toBe('2024-02-29');
		expect(dekadEnd('2023-02-21')).toBe('2023-02-28');
		expect(dekadEnd('2024-01-11')).toBe('2024-01-20');
	});

	it('lists the dekads that have ended before today, newest first', () => {
		expect(endedDekads('2024-01-01', '2024-01-21')).toEqual(['2024-01-11', '2024-01-01']);
		// The 21st's dekad ends on the 31st: not ended on the 31st itself.
		expect(endedDekads('2024-01-01', '2024-01-31')[0]).toBe('2024-01-11');
		expect(endedDekads('2024-01-01', '2024-02-01')[0]).toBe('2024-01-21');
	});

	it('names FAO’s file for a dekad and reads the name back', () => {
		expect(waporFileName('2024-01-11')).toBe('WAPOR-3.L2-AETI-D.2024-01-D2.tif');
		expect(waporUrl('2026-10-21')).toBe('https://storage.googleapis.com/fao-gismgr-wapor-3-data/DATA/WAPOR-3/MAPSET/L2-AETI-D/WAPOR-3.L2-AETI-D.2026-10-D3.tif');
		expect(dekadOfFileName('WAPOR-3.L2-AETI-D.2026-10-D3.tif')).toBe('2026-10-21');
		expect(dekadOfFileName('WAPOR-3.L2-AETI-D.2026-10-D4.tif')).toBeNull();
		expect(dekadOfFileName('../WAPOR-3.L2-AETI-D.2026-10-D1.tif')).toBeNull();
	});
});

describe('a unit’s mean', () => {
	// A 1/1024° grid with its corner at 21° E, 33° S; a parcel 8 × 4 pixels.
	const px = 1 / 1024;
	const grid = { epsg: 4326, originX: 21, originY: -33, pixelSizeX: px, pixelSizeY: px };
	const parcel = {
		type: 'MultiPolygon' as const,
		coordinates: [
			[
				[
					[21, -33],
					[21 + 8 * px, -33],
					[21 + 8 * px, -33 - 4 * px],
					[21, -33 - 4 * px],
					[21, -33]
				] as [number, number][]
			]
		]
	};
	const cog = { nodata: -9999, scale: 0.1, offset: 0 };
	const win = { col0: 0, row0: 0, col1: 7, row1: 3 };

	it('averages over the parcel’s valid pixels, ×0.1, with the valid share and the area', () => {
		const m = outlineMask(parcel, grid);
		expect(m.inside).toBe(32);
		const u = unitWeights(m, grid, undefined);
		expect(u.label).toBe('parcel');
		const samples = new Int16Array(32).fill(40);
		// A quarter cloud (nodata), and a pixel no actual ET can be (−5 mm/day).
		for (let i = 0; i < 8; i++) samples[i] = -9999;
		samples[8] = -50;
		samples[9] = 60;
		const r = unitMean(u, win, samples, cog)!;
		// 22 pixels at 4.0, one at 6.0: (22 × 4 + 6) ÷ 23.
		expect(r.etaMmDay).toBeCloseTo((22 * 4 + 6) / 23, 3);
		expect(r.validShare).toBeCloseTo(23 / 32, 4);
		expect(r.areaM2).toBeCloseTo(32 * m.pixelAreaM2, 1);
	});

	it('weights each pixel by its cell’s cropland share, and falls back to the whole parcel where the land cover maps none', () => {
		const m = outlineMask(parcel, grid);
		// One 0.0025° cell (33.0025–33° S, 21–21.0025° E) holds the parcel's north-west corner.
		const row = Math.floor((-33 - 0.5 * px) / 0.0025);
		const col = Math.floor((21 + 0.5 * px) / 0.0025);
		const u = unitWeights(m, grid, { dataset: 'synthetic', cellDeg: 0.0025, cells: [[row, col, 0.5]] });
		expect(u.label).toBe('cropland');
		// Columns and rows 0–2 have centres inside it (column 2's is 21 + 2.5/1024 = 21.00244° E): 9 pixels at 0.5.
		expect(u.total).toBeCloseTo(0.5 * 9, 6);
		const samples = new Int16Array(32);
		for (let r = 0; r < 4; r++) for (let c = 0; c < 8; c++) samples[r * 8 + c] = c < 3 && r < 3 ? 20 : 90;
		const mean = unitMean(u, win, samples, cog)!;
		// Only the cropland's pixels count: 2.0 mm/day, not the parcel's mostly 9.0.
		expect(mean.etaMmDay).toBe(2);
		expect(mean.validShare).toBe(1);
		expect(mean.areaM2).toBeCloseTo(4.5 * m.pixelAreaM2, 1);
		// Cropland elsewhere only: the whole parcel, labelled.
		const none = unitWeights(m, grid, { dataset: 'synthetic', cellDeg: 0.0025, cells: [[row + 5, col, 1]] });
		expect(none.label).toBe('parcel');
		expect(none.total).toBe(32);
	});

	it('says nothing when no pixel centre is inside, and nothing is valid off the file', () => {
		const tiny = {
			type: 'MultiPolygon' as const,
			coordinates: [[[[21 + 0.1 * px, -33 - 0.1 * px], [21 + 0.3 * px, -33 - 0.1 * px], [21 + 0.3 * px, -33 - 0.3 * px], [21 + 0.1 * px, -33 - 0.1 * px]] as [number, number][]]]
		};
		const m = outlineMask(tiny, grid);
		expect(unitMean(unitWeights(m, grid, undefined), null, null, cog)).toBeNull();
		const u = unitWeights(outlineMask(parcel, grid), grid, undefined);
		expect(unitMean(u, null, null, cog)).toMatchObject({ etaMmDay: 0, validShare: 0 });
	});
});
