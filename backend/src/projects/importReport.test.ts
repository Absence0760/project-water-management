// The import report's zod schema (importReport.ts): what a client may store
// with an import, and the caps that keep a hostile client from storing
// megabytes of notes. Synthetic data only.
import { ZodError } from 'zod';
import { describe, expect, it } from 'vitest';
import { IMPORT_MAX_BYTES } from './import.js';
import { IMPORT_REPORT_LIMITS, IMPORT_REPORT_MAX_BYTES, IMPORT_REPORT_MAX_ITEMS, ImportReport, parseImportReport } from './importReport.js';

const note = { code: 'several-outlets', severity: 'info', message: 'more than one element drains nowhere', sheet: 'Network', cell: 'B4', element: 'Echo Farm' };
const item = { code: 'transfer-inout-formula', message: 'hand-written InOut formula', sheet: 'Transfers', cell: 'T7', element: 'Echo Farm', text: '=S7*0.9-V7' };
const report = (over: Record<string, unknown> = {}) => ({
	source: 'b023-workbook',
	fileName: 'synthetic_b023.xlsx',
	importerVersion: 'b023 web importer 1; engine 0.30.0',
	notes: [note],
	unmapped: [item],
	...over
});
const issues = (raw: unknown) => {
	try {
		ImportReport.parse(raw);
		return [];
	} catch (e) {
		return (e as ZodError).issues.map((i) => i.path.join('.'));
	}
};

describe('ImportReport', () => {
	it('accepts a workbook report and keeps every field the review shows', () => {
		expect(ImportReport.parse(report())).toEqual({ ...report(), notesOmitted: 0, unmappedOmitted: 0 });
	});

	it('accepts a project-file report with no lists (they default to empty)', () => {
		const r = ImportReport.parse({ source: 'project-file', fileName: 'catchment.json', importerVersion: 'project file 1' });
		expect(r).toMatchObject({ notes: [], unmapped: [], notesOmitted: 0, unmappedOmitted: 0 });
	});

	it('drops unknown keys, at the top and on each item, rather than storing them', () => {
		const r = ImportReport.parse(report({ extra: 'x', notes: [{ ...note, html: '<b>' }], unmapped: [{ ...item, formula: 1 }] }));
		expect(r).not.toHaveProperty('extra');
		expect(r.notes[0]).not.toHaveProperty('html');
		expect(r.unmapped[0]).not.toHaveProperty('formula');
	});

	it('refuses an unknown source, severity or malformed code', () => {
		expect(issues(report({ source: 'csv' }))).toEqual(['source']);
		expect(issues(report({ notes: [{ ...note, severity: 'error' }] }))).toEqual(['notes.0.severity']);
		expect(issues(report({ unmapped: [{ ...item, code: 'Not A Code' }] }))).toEqual(['unmapped.0.code']);
		expect(issues(report({ fileName: '   ' }))).toEqual(['fileName']);
		expect(issues(report({ notes: [{ ...note, message: '' }] }))).toEqual(['notes.0.message']);
	});

	it('caps each list at the item limit', () => {
		const many = (n: number) => Array.from({ length: n }, () => note);
		expect(issues(report({ notes: many(IMPORT_REPORT_MAX_ITEMS) }))).toEqual([]);
		expect(issues(report({ notes: many(IMPORT_REPORT_MAX_ITEMS + 1) }))).toEqual(['notes']);
		expect(issues(report({ unmapped: Array.from({ length: IMPORT_REPORT_MAX_ITEMS + 1 }, () => item) }))).toEqual(['unmapped']);
	});

	it('caps every string at its limit', () => {
		const L = IMPORT_REPORT_LIMITS;
		expect(issues(report({ fileName: 'f'.repeat(L.fileName) }))).toEqual([]);
		expect(issues(report({ fileName: 'f'.repeat(L.fileName + 1) }))).toEqual(['fileName']);
		expect(issues(report({ importerVersion: 'v'.repeat(L.importerVersion + 1) }))).toEqual(['importerVersion']);
		expect(issues(report({ notes: [{ ...note, message: 'm'.repeat(L.message + 1) }] }))).toEqual(['notes.0.message']);
		expect(issues(report({ notes: [{ ...note, sheet: 's'.repeat(L.sheet + 1) }] }))).toEqual(['notes.0.sheet']);
		expect(issues(report({ notes: [{ ...note, cell: 'c'.repeat(L.cell + 1) }] }))).toEqual(['notes.0.cell']);
		expect(issues(report({ unmapped: [{ ...item, element: 'e'.repeat(L.element + 1) }] }))).toEqual(['unmapped.0.element']);
		expect(issues(report({ unmapped: [{ ...item, text: 't'.repeat(L.text) }] }))).toEqual([]);
		expect(issues(report({ unmapped: [{ ...item, text: 't'.repeat(L.text + 1) }] }))).toEqual(['unmapped.0.text']);
		expect(issues(report({ unmapped: [{ ...item, code: 'c'.repeat(L.code + 1) }] }))).toEqual(['unmapped.0.code']);
	});

	it('caps the two lists together by size, within the item caps', () => {
		// 500 items of 2000-character messages each: within the item and string caps, far over the size cap.
		const big = Array.from({ length: IMPORT_REPORT_MAX_ITEMS }, () => ({ ...item, message: 'x'.repeat(IMPORT_REPORT_LIMITS.message) }));
		expect(Buffer.byteLength(JSON.stringify(big))).toBeGreaterThan(IMPORT_REPORT_MAX_BYTES);
		expect(issues(report({ unmapped: big }))).toEqual(['notes']);
		// The largest report is well inside the route's body cap, next to a project.
		expect(IMPORT_REPORT_MAX_BYTES * 2).toBeLessThan(IMPORT_MAX_BYTES);
	});

	it('refuses NUL characters, which Postgres text cannot hold', () => {
		expect(issues(report({ unmapped: [{ ...item, text: 'a\u0000b' }] }))).toEqual(['unmapped.0.text']);
	});

	it('keeps omitted counts to non-negative integers', () => {
		expect(ImportReport.parse(report({ notesOmitted: 3 })).notesOmitted).toBe(3);
		expect(issues(report({ unmappedOmitted: -1 }))).toEqual(['unmappedOmitted']);
		expect(issues(report({ notesOmitted: 1.5 }))).toEqual(['notesOmitted']);
	});
});

describe('parseImportReport', () => {
	it('is undefined for a plain project document (the existing contract)', () => {
		expect(parseImportReport({ name: 'x', model: {} })).toBeUndefined();
	});

	it('reads the importReport key beside the document, with issues under that path', () => {
		expect(parseImportReport({ name: 'x', importReport: report() })?.fileName).toBe('synthetic_b023.xlsx');
		try {
			parseImportReport({ importReport: report({ source: 'nope' }) });
			expect.unreachable();
		} catch (e) {
			expect((e as ZodError).issues.map((i) => i.path.join('.'))).toEqual(['importReport.source']);
		}
	});
});
