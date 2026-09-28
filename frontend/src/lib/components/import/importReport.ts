// The import report the dialog sends beside the document on POST
// /projects/import (docs/api.md § Import report): the notes and unmapped
// report the review showed, the file name and the importer, kept with the
// project (017_project_import) so a reviewer can read them long after.
//
// The server refuses a report over its caps (backend/src/projects/
// importReport.ts), which would fail the whole import; so this trims to the
// same caps first, clipping long strings and dropping items past the limits,
// and records how many were dropped (`notesOmitted` / `unmappedOmitted`).
import type { ImportReport } from '$lib/api';
import type { ImportNote, UnmappedItem } from '$lib/spreadsheet/import/report';

/** IMPORT_REPORT_MAX_ITEMS, IMPORT_REPORT_MAX_BYTES and IMPORT_REPORT_LIMITS in backend/src/projects/importReport.ts. */
export const REPORT_MAX_ITEMS = 500;
export const REPORT_MAX_BYTES = 512 * 1024;
export const REPORT_LIMITS = {
	fileName: 255,
	importerVersion: 100,
	message: 2000,
	sheet: 100,
	cell: 20,
	element: 200,
	text: 8192
} as const;

/** Code of a project-file import's notes (plain sentences, with no code of their own). */
export const PROJECT_FILE_NOTE_CODE = 'project-file-note';

/** `s` cut to `max` characters (an ellipsis marks the cut), without NUL, which the server refuses. */
export function clip(s: string, max: number): string {
	const t = s.replaceAll('\u0000', '');
	return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

const clipOpt = (s: string | undefined, max: number) => (s === undefined ? undefined : clip(s, max));
const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;

function clipWhere<T extends { sheet?: string; cell?: string; element?: string }>(x: T): T {
	const out = { ...x };
	if (x.sheet !== undefined) out.sheet = clipOpt(x.sheet, REPORT_LIMITS.sheet);
	if (x.cell !== undefined) out.cell = clipOpt(x.cell, REPORT_LIMITS.cell);
	if (x.element !== undefined) out.element = clipOpt(x.element, REPORT_LIMITS.element);
	return out;
}

/**
 * The report for an import: every string clipped, each list cut to the item
 * cap, then items dropped from the end of the longer list until both fit the
 * size cap together. Nothing is reordered, so what's kept reads as the review
 * showed it.
 */
export function buildImportReport(input: {
	source: ImportReport['source'];
	fileName: string;
	importerVersion: string;
	notes: readonly ImportNote[];
	unmapped: readonly UnmappedItem[];
}): ImportReport {
	const notes = input.notes
		.slice(0, REPORT_MAX_ITEMS)
		.map((n) => clipWhere({ ...n, message: clip(n.message, REPORT_LIMITS.message) }));
	const unmapped = input.unmapped
		.slice(0, REPORT_MAX_ITEMS)
		.map((u) => clipWhere({ ...u, message: clip(u.message, REPORT_LIMITS.message), ...(u.text !== undefined ? { text: clip(u.text, REPORT_LIMITS.text) } : {}) }));
	let size = bytes(notes) + bytes(unmapped);
	while (size > REPORT_MAX_BYTES && (notes.length || unmapped.length)) {
		const list: object[] = unmapped.length >= notes.length ? unmapped : notes;
		const dropped = list.pop()!;
		// The item and the comma before it (none for the last one left).
		size -= bytes(dropped) + (list.length ? 1 : 0);
	}
	return {
		source: input.source,
		fileName: clip(input.fileName.trim(), REPORT_LIMITS.fileName) || 'unnamed file',
		importerVersion: clip(input.importerVersion, REPORT_LIMITS.importerVersion),
		notes,
		unmapped,
		notesOmitted: input.notes.length - notes.length,
		unmappedOmitted: input.unmapped.length - unmapped.length
	};
}

/** A project-file import's notes (plain sentences shown above the preview) as report notes. */
export function projectFileNotes(sentences: readonly string[]): ImportNote[] {
	// The code isn't one of the workbook importer's (ImportNoteCode); the server takes any lower-case code.
	return sentences.map((message) => ({ code: PROJECT_FILE_NOTE_CODE as ImportNote['code'], severity: 'info', message }));
}

/** Which importer made a report: the reader and the app build it ran in (`version` from $app/environment). */
export function importerVersion(source: ImportReport['source'], build: string): string {
	return `${source === 'b023-workbook' ? 'b023 browser importer' : 'project file'} (web build ${build})`;
}
