import { describe, expect, it } from 'vitest';
import { readCropAreas, readCrops } from './crops';
import { InvalidWorkbookError } from './errors';
import { Report } from './report';
import { syntheticB023 } from './testWorkbook';
import { B023Workbook } from './workbook';

describe('readCrops', () => {
	it('reads 12 factors per crop from the Oct column, the A-pan row and effective rain', () => {
		const t = readCrops(new B023Workbook(syntheticB023().build()), new Report());
		expect(t.crops.map((c) => c.name)).toEqual(['Maize', 'Wheat']);
		expect(t.crops[0]!.cropFactor).toEqual([0.3, 0.5, 0.8, 1.1, 1.1, 0.9, 0.5, 0.3, 0, 0, 0, 0.1]);
		expect(t.apan).toEqual([150, 190, 230, 240, 200, 170, 120, 90, 70, 75, 95, 120]);
		expect(t.effectiveRainFraction).toBe(0.7);
	});

	it('takes the last A-pan row, and defaults a blank effective rain to 0.65', () => {
		const b = syntheticB023().set('Crop demand', 'D25', 'A-Pan (adjusted)').row('Crop demand', 'F25', new Array(12).fill(1)).set('Crop demand', 'F23', null);
		const t = readCrops(new B023Workbook(b.build()), new Report());
		expect(t.apan).toEqual(new Array(12).fill(1));
		expect(t.effectiveRainFraction).toBe(0.65);
	});

	it('stops when the header has no Oct, the months are out of order, or there is no A-pan row', () => {
		expect(() => readCrops(new B023Workbook(syntheticB023().set('Crop demand', 'F29', 'October').build()), new Report())).toThrow(
			"[Crop demand] factor header has no 'Oct' column"
		);
		expect(() => readCrops(new B023Workbook(syntheticB023().set('Crop demand', 'G29', 'Dec').build()), new Report())).toThrow(InvalidWorkbookError);
		expect(() => readCrops(new B023Workbook(syntheticB023().set('Crop demand', 'D20', 'Evaporation').build()), new Report())).toThrow(
			"[Crop demand] has no 'A-pan' evaporation row"
		);
	});
});

describe('readCropAreas', () => {
	it('reads m² per crop per farm, keeping zeros for the caller to drop', () => {
		const areas = readCropAreas(new B023Workbook(syntheticB023().build()), new Report());
		expect([...areas].map(([f, m]) => [f, [...m]])).toEqual([
			[
				'Farm A',
				[
					['Maize', 10000],
					['Wheat', 0]
				]
			],
			[
				'Farm B',
				[
					['Maize', 0],
					['Wheat', 5000]
				]
			]
		]);
	});

	it('lists an area that is text, not a number', () => {
		const report = new Report();
		readCropAreas(new B023Workbook(syntheticB023().set('Farm demand', 'H26', '5 ha').build()), report);
		expect(report.unmapped).toEqual([expect.objectContaining({ code: 'non-numeric-value', sheet: 'Farm demand', cell: 'H26', element: 'Farm B' })]);
	});
});
