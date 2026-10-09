import { describe, expect, it } from 'vitest';
import {
	IMPORT_MAX_BYTES,
	ImportFileError,
	importBody,
	importTooLarge,
	jsonErrorAt,
	parseProjectFileText,
	readImportFile,
	summarizeImport
} from './projectFile';

const node = (id: string, kind: string, downstreamNodeId: string | null = null) => ({ id, kind, name: id, downstreamNodeId });

/** A synthetic export: two farms, a gauge and a user, one crop, two series. */
const exported = {
	format: 'water-management/project',
	version: 1,
	exportedAt: '2026-09-25T10:00:00.000Z',
	engineVersion: '0.26.1',
	name: 'Example valley',
	description: '',
	settings: {},
	model: {
		nodes: [node('g', 'gauge'), node('f1', 'farm', 'g'), node('f2', 'farm', 'f1'), node('u', 'user', 'g')],
		crops: [{ id: 'c', name: 'Citrus', cropFactor: [] }],
		cropAreas: [
			{ nodeId: 'f1', cropId: 'c', areaM2: 1 },
			{ nodeId: 'f2', cropId: 'c', areaM2: 2 }
		],
		transfers: []
	},
	series: [
		{ kind: 'rain_catchment_mm', name: '', unit: 'mm', startDate: '2024-02-27', values: [1, null, 0, 2] },
		{ kind: 'flow_observed_m3s', name: 'Weir', unit: 'm3/s', startDate: '2024-01-01', values: [] }
	]
};

describe('parseProjectFileText', () => {
	it('reads an export as-is, keeping its informational keys (the server ignores them)', () => {
		const { file, notes } = parseProjectFileText(JSON.stringify(exported));
		expect(file).toEqual(exported);
		expect(notes).toEqual([]);
	});

	it('tolerates a byte-order mark and a workbook importer file without a format marker', () => {
		const { format: _f, version: _v, exportedAt: _e, engineVersion: _g, ...plain } = exported;
		expect(parseProjectFileText(`﻿${JSON.stringify(plain)}`).file.name).toBe('Example valley');
	});

	it('notes a file with no time series', () => {
		expect(parseProjectFileText(JSON.stringify({ ...exported, series: [] })).notes).toEqual([
			'The file has no time series. Add rainfall (and flow) on the Data tab before running the model.'
		]);
		expect(parseProjectFileText(JSON.stringify({ ...exported, series: undefined })).notes).toHaveLength(1);
	});

	it("says an export's notes won't be imported", () => {
		const note = { body: 'Dam raised in 2019', author: 'A', target: 'project', visibility: 'team' };
		expect(parseProjectFileText(JSON.stringify({ ...exported, notes: [note] })).notes).toEqual([
			"The file holds 1 note from the project it came from. Notes aren't imported: they stay with the project they were written in."
		]);
		expect(parseProjectFileText(JSON.stringify({ ...exported, notes: [note, note] })).notes[0]).toMatch(/^The file holds 2 notes /);
		expect(parseProjectFileText(JSON.stringify({ ...exported, notes: [] })).notes).toEqual([]);
	});

	it('refuses what is not a project file, with a readable reason', () => {
		const bad = (text: string) => {
			try {
				parseProjectFileText(text);
			} catch (e) {
				expect(e).toBeInstanceOf(ImportFileError);
				return (e as Error).message;
			}
			throw new Error(`accepted: ${text}`);
		};
		expect(bad('date,value\n2024-01-01,1')).toBe("This file isn't valid JSON, so it can't be a project file.");
		expect(bad('[1,2]')).toBe("This JSON file isn't a project file.");
		expect(bad('null')).toBe("This JSON file isn't a project file.");
		expect(bad(JSON.stringify({ ...exported, format: 'something-else' }))).toBe("This JSON file isn't a project file.");
		expect(bad(JSON.stringify({ name: 'x', model: { nodes: [] } }))).toMatch(/It has no model/);
		expect(bad(JSON.stringify({ ...exported, series: {} }))).toMatch(/series aren't a list/);
	});

	it('names the line and column where broken JSON stops, when the browser says where (issue #456)', () => {
		expect(() => parseProjectFileText('{\n  "name": "x",\n}')).toThrow(/^This file isn't valid JSON \(line 3, column 1\), so it can't be a project file\.$/);
		// Each engine's wording: V8's line and column, Firefox's, and an older V8's character position (counted past a BOM).
		expect(jsonErrorAt('Expected double-quoted property name in JSON at position 11 (line 3 column 1)', '')).toBe('line 3, column 1');
		expect(jsonErrorAt("JSON.parse: expected ',' or '}' after property value in object at line 2 column 9 of the JSON data", '')).toBe('line 2, column 9');
		expect(jsonErrorAt('Unexpected token } in JSON at position 14', '﻿{\r\n  "a": 1,\r\n}')).toBe('line 3, column 1');
		expect(jsonErrorAt('JSON Parse error: Unexpected identifier "date"', 'date')).toBe('');
	});

	it('keeps a missing name as empty, for the preview to ask for one', () => {
		const { name: _n, ...unnamed } = exported;
		expect(parseProjectFileText(JSON.stringify(unnamed)).file.name).toBe('');
	});
});

describe('readImportFile', () => {
	it('reads a .json file', async () => {
		const f = new File([JSON.stringify(exported)], 'example-valley_project_2026-09-25.json', { type: 'application/json' });
		expect((await readImportFile(f)).file.name).toBe('Example valley');
	});

	it('refuses another file type and a file over the server cap before reading it', async () => {
		await expect(readImportFile(new File(['x'], 'rain.csv', { type: 'text/csv' }))).rejects.toThrow(/isn't a project file/);
		const big = new File([new Uint8Array(IMPORT_MAX_BYTES + 1)], 'big.json', { type: 'application/json' });
		await expect(readImportFile(big)).rejects.toThrow(/at most 5 MB/);
	});
});

describe('summarizeImport', () => {
	it('counts nodes by kind, crops, planted areas, transfers and each series’ days and dates', () => {
		expect(summarizeImport(parseProjectFileText(JSON.stringify(exported)).file)).toEqual({
			farms: 2,
			gauges: 1,
			users: 1,
			crops: 1,
			cropAreas: 2,
			transfers: 0,
			series: [
				// 2024 is a leap year: four days from 27 February end on 1 March.
				{ kind: 'rain_catchment_mm', name: '', startDate: '2024-02-27', days: 4, endDate: '2024-03-01' },
				{ kind: 'flow_observed_m3s', name: 'Weir', startDate: '2024-01-01', days: 0, endDate: null }
			]
		});
	});
});

describe('importBody', () => {
	it('sends the preview’s trimmed name and measures the UTF-8 body against the cap', () => {
		const file = parseProjectFileText(JSON.stringify(exported)).file;
		const { file: out, bytes } = importBody(file, '  Droëvlei — copy  ');
		expect(out.name).toBe('Droëvlei — copy');
		expect(out.model).toBe(file.model);
		expect(bytes).toBe(new TextEncoder().encode(JSON.stringify(out)).length);
		expect(bytes).toBeGreaterThan(JSON.stringify(out).length); // ë and — are multi-byte
		expect(importTooLarge(bytes)).toBeNull();
		expect(importTooLarge(IMPORT_MAX_BYTES + 1)).toMatch(/^The file is 5\.00 MB; a project file can be at most 5 MB\./);
	});

	it('sends the name as the server stores it: whitespace runs one space, bidi controls dropped (issue #383)', () => {
		const file = parseProjectFileText(JSON.stringify(exported)).file;
		expect(importBody(file, ' Upper\n Berg\u202e ').file.name).toBe('Upper Berg');
	});

	it("leaves an export's notes out of the body (the server ignores them)", () => {
		const withNotes = { ...exported, notes: [{ body: 'x'.repeat(4000), target: 'project', visibility: 'team' }] };
		const file = parseProjectFileText(JSON.stringify(withNotes)).file;
		const { file: out, bytes } = importBody(file, 'Example valley');
		expect(out).not.toHaveProperty('notes');
		expect(out.model).toBe(file.model);
		expect(bytes).toBe(new TextEncoder().encode(JSON.stringify(out)).length);
		expect(bytes).toBeLessThan(4000);
	});

	it('counts the import report that rides beside the document', () => {
		const file = parseProjectFileText(JSON.stringify(exported)).file;
		const report = {
			source: 'project-file' as const,
			fileName: 'catchment.json',
			importerVersion: 'project file (web build 1)',
			notes: [],
			unmapped: [],
			notesOmitted: 0,
			unmappedOmitted: 0
		};
		const plain = importBody(file, 'P');
		const withReport = importBody(file, 'P', report);
		expect(withReport.file).toEqual(plain.file);
		expect(withReport.bytes).toBe(new TextEncoder().encode(JSON.stringify({ ...plain.file, importReport: report })).length);
		expect(withReport.bytes).toBeGreaterThan(plain.bytes);
	});
});
