// Reading a file the import dialog was given into a project document to
// preview and POST (docs/ui.md § Project list, "Import a project file"). Only
// the shape the preview needs is checked here: the server validates the
// document in full and answers with every problem, so this never duplicates
// its rules. A workbook source (WP-1.31) adds its own branch to
// `readImportFile` and returns the same `ParsedImport`, with its notes.
import { cleanName } from '$lib/format/visibleName';
import type { ImportReport, ProjectFile } from '$lib/api';

/** File types the picker offers. */
export const IMPORT_ACCEPT = '.json,application/json';

/** The server's body cap for POST /projects/import (IMPORT_MAX_BYTES in backend/src/projects/import.ts). */
export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;

/** The document marker an export writes (PROJECT_DOCUMENT_FORMAT in backend/src/projects/document.ts). */
const FORMAT = 'water-management/project';

/** A file read and ready to preview: the document, plus notes the importer wants the user to read first. */
export interface ParsedImport {
	file: ProjectFile;
	/** Plain sentences, shown above the preview. A workbook's importer notes go here. */
	notes: string[];
}

/** A file that can't be imported, with a message for the user. */
export class ImportFileError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ImportFileError';
	}
}

/** Read a picked file. Throws ImportFileError with a readable message. */
export async function readImportFile(f: File): Promise<ParsedImport> {
	if (f.size > IMPORT_MAX_BYTES) throw new ImportFileError(tooLarge(f.size));
	if (!/\.json$/i.test(f.name) && f.type !== 'application/json') {
		throw new ImportFileError(`“${f.name}” isn't a project file. Choose the .json file a project export or the workbook importer wrote.`);
	}
	return parseProjectFileText(await f.text());
}

/** Parse a project file's text into a document and its notes. */
export function parseProjectFileText(text: string): ParsedImport {
	let raw: unknown;
	try {
		raw = JSON.parse(text.replace(/^﻿/, ''));
	} catch (e) {
		const at = jsonErrorAt(e instanceof Error ? e.message : '', text);
		throw new ImportFileError(`This file isn't valid JSON${at ? ` (${at})` : ''}, so it can't be a project file.`);
	}
	const doc = raw as Record<string, unknown> | null;
	if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new ImportFileError(notAProject);
	if (doc.format !== undefined && doc.format !== FORMAT) throw new ImportFileError(notAProject);
	const model = doc.model as Record<string, unknown> | undefined;
	if (!model || typeof model !== 'object' || !['nodes', 'crops', 'cropAreas', 'transfers'].every((k) => Array.isArray(model[k]))) {
		throw new ImportFileError(`${notAProject} It has no model (hydrological units, crops, crop areas and transfers).`);
	}
	if (doc.series !== undefined && !Array.isArray(doc.series)) throw new ImportFileError(`${notAProject} Its series aren't a list.`);
	const file = { ...doc, name: typeof doc.name === 'string' ? doc.name : '' } as ProjectFile;

	const notes: string[] = [];
	if (!(file.series ?? []).length) notes.push('The file has no time series. Add rainfall (and flow) on the Data tab before running the model.');
	// An export carries the project's notes as a record; the server doesn't import them (docs/data-model.md § Notes).
	const kept = Array.isArray(doc.notes) ? doc.notes.length : 0;
	if (kept) notes.push(`The file holds ${kept === 1 ? '1 note' : `${kept} notes`} from the project it came from. Notes aren't imported: they stay with the project they were written in.`);
	return { file, notes };
}

const notAProject = "This JSON file isn't a project file.";

/**
 * Where JSON.parse stopped, as "line 3, column 5", from the browser's
 * message (issue #456): V8 and Firefox name the line and column, older V8
 * only the character position (counted here, from 0, in the text it parsed,
 * which had any byte-order mark removed). '' when the message names neither
 * (Safari; V8 when the first character is already wrong).
 */
export function jsonErrorAt(message: string, text: string): string {
	const lc = /line (\d+) column (\d+)/i.exec(message);
	if (lc) return `line ${lc[1]}, column ${lc[2]}`;
	const pos = /position (\d+)/i.exec(message);
	if (!pos) return '';
	const before = text.replace(/^﻿/, '').slice(0, Number(pos[1]));
	const lines = before.split(/\r\n|\r|\n/);
	return `line ${lines.length}, column ${lines.at(-1)!.length + 1}`;
}

function tooLarge(bytes: number): string {
	const mb = (n: number, digits: number) => (n / 1024 / 1024).toFixed(digits);
	return `The file is ${mb(bytes, 2)} MB; a project file can be at most ${mb(IMPORT_MAX_BYTES, 0)} MB. Remove series the model doesn't need from it, import it, then upload those series as CSV.`;
}

/** What the preview shows about a document. */
export interface ImportSummary {
	farms: number;
	gauges: number;
	users: number;
	crops: number;
	cropAreas: number;
	transfers: number;
	series: { kind: string; name: string; startDate: string; days: number; endDate: string | null }[];
}

export function summarizeImport(file: ProjectFile): ImportSummary {
	const nodes = file.model.nodes;
	const count = (kind: string) => nodes.filter((n) => n.kind === kind).length;
	return {
		farms: count('farm'),
		gauges: count('gauge'),
		users: count('user'),
		crops: file.model.crops.length,
		cropAreas: file.model.cropAreas.length,
		transfers: file.model.transfers.length,
		series: (file.series ?? []).map((s) => ({
			kind: String(s.kind),
			name: typeof s.name === 'string' ? s.name : '',
			startDate: String(s.startDate),
			days: Array.isArray(s.values) ? s.values.length : 0,
			endDate: Array.isArray(s.values) && s.values.length ? addDays(String(s.startDate), s.values.length - 1) : null
		}))
	};
}

/** `iso` + `n` days, or null when `iso` isn't a date (the server reports that). */
function addDays(iso: string, n: number): string | null {
	const ms = Date.parse(`${iso}T00:00:00Z`);
	return Number.isNaN(ms) ? null : new Date(ms + n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The document as it will be sent: the preview's name, without the export's
 * notes, and the body's size against the server's cap, counting the import
 * report that rides beside it.
 */
export function importBody(file: ProjectFile, name: string, report?: ImportReport): { file: ProjectFile; bytes: number } {
	// The server ignores an export's notes, so they aren't sent (or counted against the cap).
	const { notes: _notes, ...rest } = file;
	const out = { ...rest, name: cleanName(name) } as ProjectFile;
	return { file: out, bytes: new TextEncoder().encode(JSON.stringify(report ? { ...out, importReport: report } : out)).length };
}

export function importTooLarge(bytes: number): string | null {
	return bytes > IMPORT_MAX_BYTES ? tooLarge(bytes) : null;
}
