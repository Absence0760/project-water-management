import { describe, expect, it } from 'vitest';
import type { ImportResult } from '$lib/spreadsheet/import/extract';
import type { ProjectFile } from '$lib/api';
import { DEFAULT_CHIRPS_KEY, describeFailure, fromResult, gaugeOptions, isWorkbookFile, location, progressText, withChirpsProvenance } from './workbookFile';

describe('the CHIRPS column’s product and version (issue #40c)', () => {
	const file = (kinds: string[]) =>
		({ name: 'W', model: { nodes: [], crops: [], cropAreas: [], transfers: [] }, series: kinds.map((kind) => ({ kind, unit: 'mm', startDate: '2001-01-01', values: [1] })) }) as ProjectFile;
	it('is v2.0 unless the review says otherwise, what b023 workbooks were built on', () => {
		expect(DEFAULT_CHIRPS_KEY).toBe('CHIRPS/2.0');
	});
	it('labels the CHIRPS series only, with the answer or as not recorded', () => {
		const out = withChirpsProvenance(file(['rain_catchment_mm', 'rain_chirps_mm']), 'CHIRPS sat/3.0');
		expect(out.series).toEqual([
			{ kind: 'rain_catchment_mm', unit: 'mm', startDate: '2001-01-01', values: [1] },
			{ kind: 'rain_chirps_mm', unit: 'mm', startDate: '2001-01-01', values: [1], product: 'CHIRPS sat', productVersion: '3.0' }
		]);
		expect(withChirpsProvenance(file(['rain_chirps_mm']), '').series![0]).toMatchObject({ product: null, productVersion: null });
		const none = file(['rain_catchment_mm']);
		expect(withChirpsProvenance(none, DEFAULT_CHIRPS_KEY)).toBe(none);
	});
});

describe('isWorkbookFile', () => {
	it('knows .xlsx and .xlsm by name or type, and nothing else', () => {
		expect(isWorkbookFile({ name: 'Catchment_WBT_b023.xlsm', type: '' })).toBe(true);
		expect(isWorkbookFile({ name: 'x.XLSX', type: '' })).toBe(true);
		expect(isWorkbookFile({ name: 'download', type: 'application/vnd.ms-excel.sheet.macroEnabled.12' })).toBe(true);
		expect(isWorkbookFile({ name: 'project.json', type: 'application/json' })).toBe(false);
		expect(isWorkbookFile({ name: 'old.xls', type: 'application/vnd.ms-excel' })).toBe(false);
	});
});

describe('describeFailure', () => {
	it('lists the missing named ranges of a non-b023 workbook, eight at most', () => {
		const missing = Array.from({ length: 11 }, (_, i) => `zName${i}`);
		const v = describeFailure({ code: 'not-b023', message: '…', missing });
		expect(v.title).toBe("This isn't a b023 Water Balance Tool workbook.");
		expect(v.detail).toContain('lacks 11 of them');
		expect(v.list).toEqual(missing.slice(0, 8));
		expect(v.more).toBe(3);
		expect(describeFailure({ code: 'not-b023', message: '…', missing: ['zAppSet_MonthDays'] })).toMatchObject({ list: ['zAppSet_MonthDays'], more: 0 });
	});

	it('gives each kind of failure its own headline, keeping the importer’s message', () => {
		const msg = 'The file is 151 MB; the limit is 150 MB.';
		expect(describeFailure({ code: 'too-large', what: 'bytes', message: msg })).toMatchObject({ title: 'This workbook is too large to import.', detail: expect.stringContaining(msg) });
		expect(describeFailure({ code: 'too-large', what: 'unpacked', message: 'x' }).detail).toContain('damaged');
		expect(describeFailure({ code: 'unreadable', message: 'u' })).toEqual({ title: "The file couldn't be opened as a workbook.", detail: 'u' });
		expect(describeFailure({ code: 'unsupported-version', message: 'b031' }).title).toContain('build');
		expect(describeFailure({ code: 'invalid-workbook', message: 'Dates jump.', sheet: 'Flow data', cell: 'B12' }).detail).toBe(
			'Dates jump. (sheet Flow data, cell B12) Fix it in the workbook, save it, and try again.'
		);
		expect(describeFailure({ code: 'internal', message: 'boom' })).toEqual({ title: 'Something went wrong reading the workbook.', detail: 'boom' });
	});
});

describe('gaugeOptions', () => {
	it('is off, on, or on with a scaling given as both a date and a factor', () => {
		expect(gaugeOptions(false, '2021-10-01', '0.8')).toEqual({ options: {} });
		expect(gaugeOptions(true, '', ' ')).toEqual({ options: { gaugeAsReference: true } });
		expect(gaugeOptions(true, '2021-10-01', '0,8')).toEqual({ options: { gaugeAsReference: { scalingFrom: '2021-10-01', scaleFactor: 0.8 } } });
		expect(gaugeOptions(true, '2021-10-01', '')).toEqual({ error: 'Give both the date the scaling starts and its factor, or neither.' });
		expect(gaugeOptions(true, '2021-10-01', '-1')).toEqual({ error: 'The scale factor must be a positive number.' });
		expect(gaugeOptions(true, '2021-10-01', 'abc')).toEqual({ error: 'The scale factor must be a positive number.' });
	});
});

describe('fromResult and progress', () => {
	const result = (kinds: string[]): ImportResult =>
		({
			project: { name: 'P', description: '', settings: {}, model: { nodes: [], crops: [], cropAreas: [], transfers: [] }, series: kinds.map((kind) => ({ kind })) },
			notes: [{ code: 'dam-area-unknown', severity: 'info', message: 'n' }],
			unmapped: []
		}) as unknown as ImportResult;

	it('offers the gauge option only when the workbook has a gauge column', () => {
		expect(fromResult(result(['rain_catchment_mm', 'flow_observed_m3s'])).report.hasGauge).toBe(true);
		expect(fromResult(result(['flow_reference_m3s'])).report.hasGauge).toBe(true);
		expect(fromResult(result(['rain_catchment_mm', 'flow_logger_m3s'])).report.hasGauge).toBe(false);
		// … and asks the CHIRPS column's version only when there is one.
		expect(fromResult(result(['rain_chirps_mm'])).report.hasChirps).toBe(true);
		expect(fromResult(result(['rain_catchment_mm'])).report.hasChirps).toBe(false);
		// The notes are shown by the review with their severity, not as the preview's plain notes.
		expect(fromResult(result([])).parsed.notes).toEqual([]);
		expect(fromResult(result([])).report.notes).toHaveLength(1);
	});

	it('words the progress and weighs reading as most of the time', () => {
		expect(progressText(null)).toEqual({ text: 'Opening the workbook…', fraction: 0 });
		const mid = progressText({ stage: 'read', sheet: 'Flow data', step: 7, steps: 9 });
		expect(mid.text).toBe('Reading sheet Flow data (7 of 9)…');
		expect(mid.fraction).toBeCloseTo(0.7, 10);
		const done = progressText({ stage: 'extract', sheet: 'Flow data', step: 7, steps: 7 });
		expect(done.fraction).toBeCloseTo(1, 10);
		expect(done.text).toBe('Building the project: Flow data (7 of 7)…');
	});

	it('writes a location from a sheet and cell', () => {
		expect(location({ sheet: 'Transfers', cell: 'S7' })).toBe('Transfers, S7');
		expect(location({ sheet: 'Flow data' })).toBe('Flow data');
		expect(location({})).toBe('');
	});
});
