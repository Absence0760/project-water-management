import { describe, expect, it } from 'vitest';
import { grossDemandNote, nonCropDemand, nonCropDemandObject, readCropAreas, readCrops, readFarmGross } from './crops';
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

describe('readFarmGross', () => {
	it('reads the gross demand per farm, and no days without zFarmDemand_GrossMthDays', () => {
		const b = syntheticB023().row('Farm demand', 'Q25', new Array(12).fill(12.5));
		const { gross, days } = readFarmGross(new B023Workbook(b.build()));
		expect([...gross.keys()]).toEqual(['Farm A', 'Farm B']);
		expect(gross.get('Farm A')).toEqual(new Array(12).fill(12.5));
		expect(gross.get('Farm B')).toEqual(new Array(12).fill(0));
		expect(days).toBeNull();
	});

	it('reads the days per month when the workbook names them', () => {
		const b = syntheticB023()
			.row('Farm demand', 'Q19', DAYS)
			.name('zFarmDemand_GrossMthDays', "'Farm demand'!$Q$19:$AB$19");
		expect(readFarmGross(new B023Workbook(b.build())).days).toEqual(DAYS);
	});
});

const DAYS = [31, 30, 31, 31, 28.25, 31, 30, 31, 30, 31, 31, 30];
const APAN = new Array(12).fill(200);
const FACTORS = new Map([
	['Orchard', new Array(12).fill(0.5)],
	['Vegetables', new Array(12).fill(0.3)]
]);
const formula = (perCrop: Map<string, number>) =>
	DAYS.map((d, m) => [...perCrop].reduce((s, [c, a]) => s + (FACTORS.has(c) ? (a * FACTORS.get(c)![m]! * APAN[m]!) / 1000 / d : 0), 0));

describe('grossDemandNote (gross_demand_note)', () => {
	it("leaves the sheet's rounding alone", () => {
		const areas = new Map([
			['Orchard', 100000],
			['Vegetables', 20000]
		]);
		expect(grossDemandNote('A', areas, formula(areas).map((v) => Math.round(v * 10) / 10), FACTORS, APAN, DAYS)).toBeNull();
	});

	it('warns about a demand typed over the formula on a farm with no crop areas', () => {
		const note = grossDemandNote('Town dam', new Map([['Orchard', 0]]), new Array(12).fill(800), FACTORS, APAN, DAYS);
		expect(note).toMatch(/^WARNING: \[Farm demand\] Town dam: the gross demand in 12 of 12 months /);
		expect(note).toContain('the workbook has 800 m³/day on average, the crop areas give 0.');
	});

	it('warns about a formula that skips a crop', () => {
		const areas = new Map([
			['Orchard', 100000],
			['Vegetables', 200000]
		]);
		const gross = formula(new Map([['Orchard', 100000]])).map((v) => Math.round(v * 10) / 10);
		expect(grossDemandNote('B', areas, gross, FACTORS, APAN, DAYS)).toContain('in 12 of 12 months');
	});

	it('leaves a difference under 1 % or under 1 m³/day alone, and skips undefined crops', () => {
		const big = new Map([['Orchard', 1000000]]);
		expect(grossDemandNote('C', big, formula(big).map((v) => v * 1.009), FACTORS, APAN, DAYS)).toBeNull();
		const small = new Map([['Orchard', 1000]]);
		expect(grossDemandNote('D', small, formula(small).map((v) => v + 0.9), FACTORS, APAN, DAYS)).toBeNull();
		const hops = new Map([
			['Orchard', 100000],
			['Hops', 50000]
		]);
		expect(grossDemandNote('E', hops, formula(new Map([['Orchard', 100000]])), FACTORS, APAN, DAYS)).toBeNull();
	});
});

describe('nonCropDemand (non_crop_demand): the part above the crop areas becomes a demand object (issue #54, 2b)', () => {
	it('takes all of a typed demand on a farm with no crops, and says so', () => {
		const none = new Map([['Orchard', 0]]);
		expect(nonCropDemand(none, new Array(12).fill(800), FACTORS, APAN, DAYS)).toEqual(new Array(12).fill(800));
		expect(grossDemandNote('Town dam', none, new Array(12).fill(800), FACTORS, APAN, DAYS)).toContain('is imported as the demand object "Non-crop demand"');
	});

	it('adds only the months typed over on top of crops, so crops + object give the workbook', () => {
		const areas = new Map([['Orchard', 100000]]);
		const crops = formula(areas);
		const gross = crops.map((v, m) => Math.round(v * 10) / 10 + (m < 6 ? 300 : 0));
		const extra = nonCropDemand(areas, gross, FACTORS, APAN, DAYS)!;
		for (let m = 0; m < 12; m++) {
			expect(extra[m]).toBeCloseTo(m < 6 ? 300 : 0, 1);
			expect(crops[m]! + extra[m]!).toBeCloseTo(gross[m]!, 1);
		}
	});

	it('gives nothing for a formula that skips a crop, and names both directions when both happen', () => {
		const areas = new Map([
			['Orchard', 100000],
			['Vegetables', 200000]
		]);
		expect(nonCropDemand(areas, formula(new Map([['Orchard', 100000]])), FACTORS, APAN, DAYS)).toBeNull();
		const one = new Map([['Orchard', 100000]]);
		const mixed = formula(one).map((v, m) => v + (m === 0 ? 500 : m === 1 ? -200 : 0));
		expect(grossDemandNote('M', one, mixed, FACTORS, APAN, DAYS)).toContain('In 1 month(s) the crop areas give more than the workbook');
	});

	it('makes a municipal object without crops, returning the farm’s return flow', () => {
		const o = nonCropDemandObject((k) => `id:${k}`, 'Town dam', 'n1', new Array(12).fill(800), false, 0.2);
		expect(o).toMatchObject({ id: 'id:demand-object:Town dam', category: 'municipal', returnPct: 0.2, sizing: 'monthly', priority: 'shared', destination: 'internal', enabled: true, source: 'other' });
		expect(nonCropDemandObject((k) => k, 'F', 'n2', new Array(12).fill(1), true, 0).category).toBe('other');
	});
});
