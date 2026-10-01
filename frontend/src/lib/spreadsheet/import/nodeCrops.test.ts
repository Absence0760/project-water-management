// The node-based workbook's crop sheets (./nodeCrops.ts, issue #289), on the
// synthetic layout in ./testWorkbook.ts syntheticNodeBased(): read through the
// streaming reader from .xlsx bytes, and through SheetJS for parity.
import { describe, expect, it } from 'vitest';
import { WorkbookTooLargeError } from './errors';
import { findSheet, MAX_NODE_CROP_WARNINGS, type NodeCropSet, nodeCropSheetsToRead, readNodeCrops, readNodeCropWorkbook } from './nodeCrops';
import { syntheticB023, syntheticNodeBased, WorkbookBuilder } from './testWorkbook';
import { readWorkbook } from './workbook';

const MONTHS = ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'];
const CAL = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const read = (b: WorkbookBuilder, name = 'node.xlsx') => readNodeCropWorkbook(b.toFile(), name);
const codes = (s: NodeCropSet) => s.warnings.map((w) => w.code);

describe('readNodeCrops: the synthetic node-based workbook', () => {
	it('reads the crops (Oct..Sep), their efficiency, the farms’ areas and the A-pan block, with no warnings', async () => {
		const set = await read(syntheticNodeBased());
		expect(set).toMatchObject({ source: 'node-based', shape: 'fao-et0', fileName: 'node.xlsx', sheets: { factors: 'Crop_Factors', areas: 'Crop_Areas' } });
		expect(set.warnings).toEqual([]);
		expect(set.crops.map((c) => c.name)).toEqual(['Lucerne', 'Olives', 'Wine grapes']);
		expect(set.crops[0]!.cropFactor).toEqual([0.8, 0.95, 1.05, 1.05, 1, 0.9, 0.75, 0.6, 0.5, 0.5, 0.6, 0.7]);
		expect(set.crops.map((c) => c.efficiency)).toEqual([0.8, 0.9, 0.85]);
		expect(set.apanMm).toEqual([160, 200, 240, 250, 210, 180, 125, 90, 70, 75, 100, 125]);
		expect(set.effectiveRainFraction![0]).toBe(0.6);
		expect(set.areaCrops).toEqual(['Lucerne', 'Olives', 'Wine grapes']);
		expect(set.farms).toEqual([
			{ name: 'Farm North', areas: [{ crop: 'Lucerne', m2: 120000 }, { crop: 'Olives', m2: 0 }, { crop: 'Wine grapes', m2: 45000 }] },
			{ name: 'Farm South', areas: [{ crop: 'Lucerne', m2: 0 }, { crop: 'Olives', m2: 80000 }, { crop: 'Wine grapes', m2: 30000 }] },
			{ name: 'Farm East', areas: [{ crop: 'Lucerne', m2: 25000 }, { crop: 'Olives', m2: 15000 }, { crop: 'Wine grapes', m2: 0 }] }
		]);
		// It survives postMessage.
		expect(structuredClone(set)).toEqual(set);
	});

	it('reads the same set through SheetJS (reader parity)', async () => {
		const b = syntheticNodeBased();
		expect(readNodeCrops(b.build(), 'node.xlsx')).toEqual(await read(b));
	});

	it('refuses a file over the size limit before reading it, as the b023 import does', async () => {
		await expect(readNodeCropWorkbook(syntheticNodeBased().toFile(), 'big.xlsx', { maxBytes: 100 })).rejects.toBeInstanceOf(WorkbookTooLargeError);
	});

	it('parses only the two crop sheets', async () => {
		const b = syntheticNodeBased().set('Elements', 'A1', 'Farm North');
		const src = await readWorkbook(b.toFile(), { sheets: nodeCropSheetsToRead });
		expect(src.sheetNames).toContain('Elements');
		expect(src.sheet('Elements')).toBeUndefined();
		expect(src.sheet('Crop_Factors')).toBeDefined();
	});
});

describe('readNodeCrops: headers', () => {
	it('finds sheets ignoring case, spaces and underscores, preferring an exact match', () => {
		expect(findSheet(['crop factors', 'Other'], 'Crop_Factors')).toBe('crop factors');
		expect(findSheet(['CROP-AREAS'], 'Crop_Areas')).toBe('CROP-AREAS');
		expect(findSheet(['Crop Factors', 'Crop_Factors'], 'Crop_Factors')).toBe('Crop_Factors');
		expect(findSheet(['Crop demand'], 'Crop_Factors')).toBeNull();
	});

	it('maps a calendar-order header (Jan..Dec, full names) onto water-year months', async () => {
		const b = new WorkbookBuilder();
		const full = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
		b.row('Crop Factors', 'C5', ['Crop', ...full]);
		b.row('Crop Factors', 'C6', ['Lucerne', 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((v) => (typeof v === 'number' ? v / 10 : v)));
		const set = await read(b);
		expect(set.crops[0]!.cropFactor).toEqual([1, 1.1, 1.2, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]);
		expect(set.crops[0]!.efficiency).toBeNull();
		expect(set.apanMm).toBeNull();
	});

	it('takes the table headed "Crops", not the A-pan block’s month header above it', async () => {
		const set = await read(syntheticNodeBased());
		expect(set.crops.some((c) => /a-pan|rain/i.test(c.name))).toBe(false);
	});

	it('without a "Crops" label, takes the last month header', async () => {
		const b = syntheticNodeBased().set('Crop_Factors', 'A7', 'Name');
		expect((await read(b)).crops.map((c) => c.name)).toEqual(['Lucerne', 'Olives', 'Wine grapes']);
	});

	it('warns no-header when no row names the twelve months', async () => {
		const b = new WorkbookBuilder().row('Crop_Factors', 'A1', ['Crops', 'Summer', 'Winter']).row('Crop_Areas', 'A1', ['Farm', 'Lucerne']);
		const set = await read(b);
		expect(set.crops).toEqual([]);
		expect(set.warnings[0]).toMatchObject({ code: 'no-header', sheet: 'Crop_Factors' });
	});

	it('warns odd-header for a month row that repeats a month, and reads nothing from it', async () => {
		const b = new WorkbookBuilder().row('Crop_Factors', 'A1', ['Crops', ...MONTHS.slice(0, 11), 'Aug']).row('Crop_Factors', 'A2', ['Lucerne', ...Array(12).fill(1)]);
		const set = await read(b);
		expect(set.crops).toEqual([]);
		expect(set.warnings[0]).toMatchObject({ code: 'odd-header', sheet: 'Crop_Factors', cell: 'B1' });
	});

	it('warns odd-header for a broken month row above a good header, and still reads the table', async () => {
		const b = syntheticNodeBased().set('Crop_Factors', 'M1', 'Oct');
		const set = await read(b);
		expect(set.crops).toHaveLength(3);
		expect(set.warnings).toEqual([expect.objectContaining({ code: 'odd-header', cell: 'B1' })]);
		// The A-pan row then reads against the crop header's columns.
		expect(set.apanMm![0]).toBe(160);
	});

	it('warns no-rows for a header with no crops or farms under it', async () => {
		const b = new WorkbookBuilder().row('Crop_Factors', 'A1', ['Crops', ...MONTHS]).row('Crop_Areas', 'A1', ['Farm', 'Lucerne']);
		expect(codes(await read(b))).toEqual(['no-rows', 'no-rows']);
	});

	it('warns no-header for a crop-areas sheet with no "Farm" row followed by crop names', async () => {
		const b = syntheticNodeBased().set('Crop_Areas', 'A2', 'Name');
		const set = await read(b);
		expect(set.farms).toEqual([]);
		expect(set.warnings).toEqual([expect.objectContaining({ code: 'no-header', sheet: 'Crop_Areas' })]);
	});

	it('ends each table at a "Total" row', async () => {
		const b = syntheticNodeBased().row('Crop_Factors', 'A11', ['Total', ...Array(12).fill(3)]).row('Crop_Areas', 'A6', ['Totals', 145000, 95000, 75000]);
		const set = await read(b);
		expect(set.crops.map((c) => c.name)).toEqual(['Lucerne', 'Olives', 'Wine grapes']);
		expect(set.farms.map((f) => f.name)).toEqual(['Farm North', 'Farm South', 'Farm East']);
		expect(set.warnings).toEqual([]);
	});

	it('finds the crop names left of a unit column between them and the months', async () => {
		const b = new WorkbookBuilder().row('Crop_Factors', 'A1', ['Crops', 'Unit', ...MONTHS]).row('Crop_Factors', 'A2', ['Lucerne', 'Kc', ...Array(12).fill(0.5)]);
		expect((await read(b)).crops).toEqual([{ name: 'Lucerne', cropFactor: Array(12).fill(0.5), efficiency: null }]);
	});

	it('warns no-header for a farm header with no crop columns', async () => {
		const b = syntheticNodeBased().row('Crop_Areas', 'B2', ['Total area m²', null, null, null]);
		const set = await read(b);
		expect(set.farms).toEqual([]);
		expect(set.warnings).toEqual([expect.objectContaining({ code: 'no-header', sheet: 'Crop_Areas', cell: 'A2' })]);
	});

	it('reads areas in hectares as m² when the header says hectares and never m²', async () => {
		const b = syntheticNodeBased().set('Crop_Areas', 'C1', 'Areas (ha)').set('Crop_Areas', 'B3', 12);
		const set = await read(b);
		expect(set.farms[0]!.areas[0]).toEqual({ crop: 'Lucerne', m2: 120000 });
		expect(codes(set)).toEqual(['areas-in-hectares']);
		// The synthetic header says m²: no conversion.
		expect((await read(syntheticNodeBased())).farms[0]!.areas[0]!.m2).toBe(120000);
	});

	it('reads hectare crop columns as hectares even beside a "Total area m²" column, and drops the unit from the crop names', async () => {
		const b = syntheticNodeBased().row('Crop_Areas', 'B2', ['Lucerne (ha)', 'Olives (ha)', 'Wine grapes (ha)', 'Total area m²']).row('Crop_Areas', 'B3', [12, 0, 4.5, 165000]);
		const set = await read(b);
		expect(set.areaCrops).toEqual(['Lucerne', 'Olives', 'Wine grapes']);
		expect(set.farms[0]!.areas).toEqual([
			{ crop: 'Lucerne', m2: 120000 },
			{ crop: 'Olives', m2: 0 },
			{ crop: 'Wine grapes', m2: 45000 }
		]);
		expect(codes(set)).toEqual(['areas-in-hectares']);
	});

	it('a crop column saying m² wins over a hectare title above another column', async () => {
		const b = syntheticNodeBased().set('Crop_Areas', 'A1', 'Farm areas (ha)').set('Crop_Areas', 'B2', 'Lucerne (m²)');
		const set = await read(b);
		expect(set.farms[0]!.areas[0]).toEqual({ crop: 'Lucerne', m2: 120000 });
		expect(set.warnings).toEqual([]);
	});

	it('takes the first A-pan row when there are two', async () => {
		const b = syntheticNodeBased().row('Crop_Factors', 'A3', ['S-pan or A-pan (check)', ...Array(12).fill(1)]);
		expect((await read(b)).apanMm![0]).toBe(160);
	});

	it('ends each table at the first row without a name', async () => {
		const b = syntheticNodeBased().set('Crop_Factors', 'A9', null).set('Crop_Areas', 'A4', null);
		const set = await read(b);
		expect(set.crops.map((c) => c.name)).toEqual(['Lucerne']);
		expect(set.farms.map((f) => f.name)).toEqual(['Farm North']);
	});
});

describe('readNodeCrops: warnings', () => {
	it('missing sheets: a b023 workbook reads as no crops, with a warning that points at [Crop demand]', async () => {
		const set = await read(syntheticB023());
		expect(set.crops).toEqual([]);
		expect(set.sheets).toEqual({ factors: null, areas: null });
		expect(set.warnings.map((w) => [w.code, w.sheet])).toEqual([
			['missing-sheet', 'Crop_Factors'],
			['missing-sheet', 'Crop_Areas']
		]);
		expect(set.warnings[0]!.message).toContain('[Crop demand]');
	});

	it('a missing [Crop_Areas] still loads the factors, without cross-sheet warnings', async () => {
		const b = new WorkbookBuilder().row('Crop_Factors', 'A1', ['Crops', ...MONTHS]).row('Crop_Factors', 'A2', ['Lucerne', ...Array(12).fill(0.5)]);
		const set = await read(b);
		expect(set.crops).toHaveLength(1);
		expect(codes(set)).toEqual(['missing-sheet']);
	});

	it('not-a-number: text or an error in a factor reads as 0, with the cell', async () => {
		const b = syntheticNodeBased().set('Crop_Factors', 'C8', 'n/a').set('Crop_Factors', 'D9', { error: 0x2a });
		const set = await read(b);
		expect(set.crops[0]!.cropFactor[1]).toBe(0);
		expect(set.crops[1]!.cropFactor[2]).toBe(0);
		expect(set.warnings).toEqual([
			expect.objectContaining({ code: 'not-a-number', sheet: 'Crop_Factors', cell: 'C8', message: expect.stringContaining("Lucerne's crop factor, Nov") }),
			expect.objectContaining({ code: 'not-a-number', cell: 'D9', message: expect.stringContaining('#N/A') })
		]);
	});

	it('a blank factor reads as 0 without a warning (the crop is off that month)', async () => {
		const set = await read(syntheticNodeBased().set('Crop_Factors', 'B10', null));
		expect(set.crops[2]!.cropFactor[0]).toBe(0);
		expect(set.warnings).toEqual([]);
	});

	it('out-of-range: a negative factor or area reads as 0, a factor above 1.5 is kept, an efficiency outside 0–1 is dropped', async () => {
		const b = syntheticNodeBased()
			.set('Crop_Factors', 'B8', -0.2)
			.set('Crop_Factors', 'C8', 85)
			.set('Crop_Factors', 'O9', 90)
			.set('Crop_Areas', 'B3', -5);
		const set = await read(b);
		expect(set.crops[0]!.cropFactor.slice(0, 2)).toEqual([0, 85]);
		expect(set.crops[1]!.efficiency).toBeNull();
		expect(set.farms[0]!.areas[0]).toEqual({ crop: 'Lucerne', m2: 0 });
		expect(set.warnings.map((w) => [w.code, w.cell])).toEqual([
			['out-of-range', 'B8'],
			['out-of-range', 'C8'],
			['out-of-range', 'O9'],
			['out-of-range', 'B3']
		]);
	});

	it('out-of-range A-pan and effective rainfall fraction', async () => {
		const b = syntheticNodeBased().set('Crop_Factors', 'B2', 2500).set('Crop_Factors', 'B4', 1.4);
		const set = await read(b);
		expect(set.warnings.map((w) => [w.code, w.cell])).toEqual([
			['out-of-range', 'B2'],
			['out-of-range', 'B4']
		]);
	});

	it('duplicate crops, crop columns and farms keep the first', async () => {
		const b = syntheticNodeBased().set('Crop_Factors', 'A9', 'lucerne').set('Crop_Areas', 'A4', 'Farm North').set('Crop_Areas', 'C2', 'Lucerne');
		const set = await read(b);
		expect(set.crops.map((c) => c.name)).toEqual(['Lucerne', 'Wine grapes']);
		expect(set.farms.map((f) => f.name)).toEqual(['Farm North', 'Farm East']);
		expect(set.areaCrops).toEqual(['Lucerne', 'Wine grapes']);
		expect(codes(set)).toEqual(['duplicate', 'duplicate', 'duplicate']);
	});

	it('a crop in one sheet but not the other (names match ignoring case)', async () => {
		const b = syntheticNodeBased().set('Crop_Factors', 'A9', 'Figs').set('Crop_Areas', 'D2', 'WINE GRAPES');
		const set = await read(b);
		expect(set.warnings.map((w) => [w.code, w.message.split(' ')[0]])).toEqual([
			['crop-not-in-areas', 'Figs'],
			['crop-not-in-factors', 'Olives']
		]);
	});

	it(`keeps at most ${MAX_NODE_CROP_WARNINGS} warnings and says how many more`, async () => {
		const b = new WorkbookBuilder().row('Crop_Factors', 'A1', ['Crops', ...CAL]);
		for (let r = 2; r <= 12; r++) b.row('Crop_Factors', `A${r}`, [`Crop ${r}`, ...Array(12).fill('x')]);
		const set = await read(b);
		expect(set.warnings).toHaveLength(MAX_NODE_CROP_WARNINGS + 1);
		expect(set.warnings.at(-1)).toEqual({ code: 'truncated', message: '33 more warnings not shown.' });
	});
});
