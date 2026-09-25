import { describe, expect, it } from 'vitest';
import type { ImportNote, UnmappedItem } from '$lib/spreadsheet/import/report';
import { buildImportReport, clip, importerVersion, projectFileNotes, REPORT_LIMITS, REPORT_MAX_BYTES, REPORT_MAX_ITEMS } from './importReport';

const note: ImportNote = { code: 'dam-area-unknown', severity: 'info', message: 'dams have no surface area', sheet: 'Farm spec' };
const item: UnmappedItem = { code: 'transfer-inout-formula', message: 'hand-written InOut formula', sheet: 'Transfers', cell: 'T7', element: 'Echo Farm', text: '=S7*0.9-V7' };
const base = { source: 'b023-workbook' as const, fileName: 'synthetic_b023.xlsx', importerVersion: 'b023 browser importer (web build 1)' };
const size = (r: { notes: unknown; unmapped: unknown }) => new TextEncoder().encode(JSON.stringify(r.notes)).length + new TextEncoder().encode(JSON.stringify(r.unmapped)).length;

describe('buildImportReport', () => {
	it('keeps a normal report as the review showed it', () => {
		expect(buildImportReport({ ...base, notes: [note], unmapped: [item] })).toEqual({
			...base,
			notes: [note],
			unmapped: [item],
			notesOmitted: 0,
			unmappedOmitted: 0
		});
	});

	it('clips every string to the server’s caps', () => {
		const r = buildImportReport({
			...base,
			fileName: `${'f'.repeat(300)}.xlsx`,
			notes: [{ ...note, message: 'm'.repeat(5000), sheet: 's'.repeat(200) }],
			unmapped: [{ ...item, text: '='.repeat(10_000), cell: 'c'.repeat(30), element: 'e'.repeat(300) }]
		});
		expect(r.fileName).toHaveLength(REPORT_LIMITS.fileName);
		expect(r.notes[0]!.message).toHaveLength(REPORT_LIMITS.message);
		expect(r.notes[0]!.message.endsWith('…')).toBe(true);
		expect(r.notes[0]!.sheet).toHaveLength(REPORT_LIMITS.sheet);
		expect(r.unmapped[0]!.text).toHaveLength(REPORT_LIMITS.text);
		expect(r.unmapped[0]!.cell).toHaveLength(REPORT_LIMITS.cell);
		expect(r.unmapped[0]!.element).toHaveLength(REPORT_LIMITS.element);
	});

	it('drops items past the item cap and counts them', () => {
		const r = buildImportReport({ ...base, notes: Array(REPORT_MAX_ITEMS + 7).fill(note), unmapped: [] });
		expect(r.notes).toHaveLength(REPORT_MAX_ITEMS);
		expect(r.notesOmitted).toBe(7);
		expect(r.unmappedOmitted).toBe(0);
	});

	it('drops items from the end of the longer list until both fit the size cap', () => {
		const long = { ...item, message: 'x'.repeat(REPORT_LIMITS.message), text: 'y'.repeat(2000) };
		const r = buildImportReport({ ...base, notes: Array(10).fill(note), unmapped: Array(REPORT_MAX_ITEMS).fill(long) });
		expect(size(r)).toBeLessThanOrEqual(REPORT_MAX_BYTES);
		// Close to the cap: only as many dropped as needed.
		expect(size(r)).toBeGreaterThan(REPORT_MAX_BYTES - 5000);
		expect(r.notes).toHaveLength(10);
		expect(r.unmapped.length + r.unmappedOmitted).toBe(REPORT_MAX_ITEMS);
		expect(r.unmappedOmitted).toBeGreaterThan(0);
	});

	it('counts bytes, not characters, for non-ASCII text', () => {
		const wide = { ...item, message: 'ä'.repeat(REPORT_LIMITS.message) };
		const r = buildImportReport({ ...base, notes: [], unmapped: Array(REPORT_MAX_ITEMS).fill(wide) });
		expect(size(r)).toBeLessThanOrEqual(REPORT_MAX_BYTES);
	});

	it('names a file with no name rather than sending an empty one', () => {
		expect(buildImportReport({ ...base, fileName: '   ', notes: [], unmapped: [] }).fileName).toBe('unnamed file');
	});
});

describe('clip', () => {
	it('leaves short text alone and removes NUL, which the server refuses', () => {
		expect(clip('=A1+B1', 10)).toBe('=A1+B1');
		expect(clip('a\u0000b', 10)).toBe('ab');
		expect(clip('abcdef', 4)).toBe('abc…');
	});
});

describe('projectFileNotes / importerVersion', () => {
	it('turns a project file’s sentences into info notes', () => {
		expect(projectFileNotes(['The file has no time series.'])).toEqual([
			{ code: 'project-file-note', severity: 'info', message: 'The file has no time series.' }
		]);
	});

	it('names the importer and the build', () => {
		expect(importerVersion('b023-workbook', '123')).toBe('b023 browser importer (web build 123)');
		expect(importerVersion('project-file', '123')).toBe('project file (web build 123)');
	});
});
