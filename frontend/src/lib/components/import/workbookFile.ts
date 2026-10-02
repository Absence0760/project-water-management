// The b023 workbook source of the import dialog (WP-1.31; docs/ui.md §
// Project list, "Import a b023 workbook"). The workbook is read in a worker
// ($lib/spreadsheet/import/runner.ts, loaded on demand); this module is the
// dialog's view logic around it: which files are workbooks, what each
// failure says, the gauge and run-of-river options, and the review's notes and unmapped
// report. Type-only imports from the parser, so no SheetJS here.
import { B023_CHIRPS_DEFAULT, provenanceKey } from '@water-management/engine';
import type { ProjectFile } from '$lib/api';
import { provenanceFields } from '$lib/series/provenance';
import type { ImportResult } from '$lib/spreadsheet/import/extract';
import type { ImportNote, UnmappedItem } from '$lib/spreadsheet/import/report';
import type { WorkbookImportFailure, WorkbookImportOptions, WorkbookImportProgress } from '$lib/spreadsheet/import/messages';
import type { ParsedImport } from './projectFile';

/** File types the workbook picker offers: .xlsx and .xlsm (b023 workbooks are macro-enabled). */
export const WORKBOOK_ACCEPT =
	'.xlsx,.xlsm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel.sheet.macroEnabled.12';

/** Largest workbook the reader accepts (MAX_WORKBOOK_BYTES in $lib/spreadsheet/import/workbook.ts). */
export const WORKBOOK_MAX_MB = 150;

export function isWorkbookFile(f: { name: string; type: string }): boolean {
	return /\.xls[xm]$/i.test(f.name) || /spreadsheetml\.sheet$|macroEnabled\.12$/.test(f.type);
}

/** What the review shows beyond the preview: the importer's notes and the unmapped report. */
export interface WorkbookReport {
	notes: ImportNote[];
	unmapped: UnmappedItem[];
	/** The workbook has a gauge column (so the gauge-as-reference option applies). */
	hasGauge: boolean;
	/** The workbook has a CHIRPS column (so the review asks which product and version it is). */
	hasChirps: boolean;
	/**
	 * The units the importer flags as probable run-of-river, in network order
	 * (so the run-of-river option applies when there are any). The flag is the
	 * same whether the option is on or off.
	 */
	runOfRiverUnits: string[];
}

/**
 * What the review preselects for the workbook's CHIRPS column: v2.0, what
 * the b023 workbooks were built on (issue #40 part c). The feed writes v3.0,
 * so the label is what later stops the feed splicing one onto the other.
 */
export const DEFAULT_CHIRPS_KEY = provenanceKey(B023_CHIRPS_DEFAULT);

/**
 * The document with the review's answer on its CHIRPS series: `key` is a
 * provenance key ('CHIRPS/2.0'), '' for "not known" (stored as not recorded).
 * Other series are left as they are.
 */
export function withChirpsProvenance(file: ProjectFile, key: string): ProjectFile {
	if (!file.series?.some((s) => s.kind === 'rain_chirps_mm')) return file;
	const f = provenanceFields(key);
	return { ...file, series: file.series.map((s) => (s.kind === 'rain_chirps_mm' ? { ...s, ...f } : s)) };
}

const GAUGE_KINDS = new Set(['flow_observed_m3s', 'flow_reference_m3s']);

/** The worker's result → the dialog's preview input and the report. */
export function fromResult(r: ImportResult): { parsed: ParsedImport; report: WorkbookReport } {
	return {
		// The preview lists the importer's notes itself, with their severity, so none go in `notes` here.
		parsed: { file: r.project as unknown as ProjectFile, notes: [] },
		report: {
			notes: r.notes,
			unmapped: r.unmapped,
			hasGauge: r.project.series.some((s) => GAUGE_KINDS.has(s.kind)),
			hasChirps: r.project.series.some((s) => s.kind === 'rain_chirps_mm'),
			runOfRiverUnits: r.notes.flatMap((n) => (n.code === 'probable-run-of-river' && n.element ? [n.element] : []))
		}
	};
}

/** "Reading Flow data (7 of 9)" and a 0–1 fraction over both stages (reading is nearly all the time). */
export function progressText(p: WorkbookImportProgress | null): { text: string; fraction: number } {
	if (!p) return { text: 'Opening the workbook…', fraction: 0 };
	const within = p.steps ? p.step / p.steps : 1;
	return p.stage === 'read'
		? { text: `Reading sheet ${p.sheet} (${p.step} of ${p.steps})…`, fraction: 0.9 * within }
		: { text: `Building the project: ${p.sheet} (${p.step} of ${p.steps})…`, fraction: 0.9 + 0.1 * within };
}

/** The gauge options from the review's inputs, or why they don't go together. */
export function gaugeOptions(asReference: boolean, scalingFrom: string, scaleFactor: string): { options: WorkbookImportOptions } | { error: string } {
	if (!asReference) return { options: {} };
	const from = scalingFrom.trim();
	const factor = scaleFactor.trim();
	if (!from && !factor) return { options: { gaugeAsReference: true } };
	if (!from || !factor) return { error: 'Give both the date the scaling starts and its factor, or neither.' };
	const n = Number(factor.replace(',', '.'));
	if (!Number.isFinite(n) || n <= 0) return { error: 'The scale factor must be a positive number.' };
	return { options: { gaugeAsReference: { scalingFrom: from, scaleFactor: n } } };
}

/**
 * The importer's options from the review: the gauge options (gaugeOptions)
 * and, when `runOfRiver` is on, the run-of-river option (issue #54, 2c/2d;
 * the Python importer's --run-of-river).
 */
export function workbookOptions(
	asReference: boolean,
	scalingFrom: string,
	scaleFactor: string,
	runOfRiver: boolean
): { options: WorkbookImportOptions } | { error: string } {
	const gauge = gaugeOptions(asReference, scalingFrom, scaleFactor);
	if ('error' in gauge || !runOfRiver) return gauge;
	return { options: { ...gauge.options, runOfRiver: true } };
}

/** How the dialog shows a failure: a headline, the detail, and a list (the missing named ranges) when there is one. */
export interface FailureView {
	title: string;
	detail: string;
	list?: string[];
	/** How many more list items than are shown. */
	more?: number;
}

const SHOWN_NAMES = 8;

export function describeFailure(f: WorkbookImportFailure): FailureView {
	switch (f.code) {
		case 'not-b023': {
			const missing = f.missing ?? [];
			return {
				title: "This isn't a b023 Water Balance Tool workbook.",
				detail: `Every b023 workbook has these named ranges, and this one lacks ${missing.length === 1 ? 'it' : `${missing.length} of them`}:`,
				list: missing.slice(0, SHOWN_NAMES),
				more: Math.max(0, missing.length - SHOWN_NAMES)
			};
		}
		case 'unsupported-version':
			return { title: 'This Water Balance Tool build isn’t supported.', detail: f.message };
		case 'too-large':
			return {
				title: 'This workbook is too large to import.',
				detail:
					f.what === 'bytes'
						? `${f.message} If it is a real catchment workbook, ask your administrator to import it with the command-line importer.`
						: f.what === 'sheets'
							? f.message
							: `${f.message} That's far beyond any real b023 workbook, so the file may be damaged.`
			};
		case 'unreadable':
			return { title: "The file couldn't be opened as a workbook.", detail: f.message };
		case 'invalid-workbook':
			return {
				title: 'The workbook has a problem the importer can’t get past.',
				detail: `${f.message}${f.sheet ? ` (sheet ${f.sheet}${f.cell ? `, cell ${f.cell}` : ''})` : ''} Fix it in the workbook, save it, and try again.`
			};
		case 'invalid-options':
			return { title: 'Those import options don’t go together.', detail: f.message };
		default:
			return { title: 'Something went wrong reading the workbook.', detail: f.message };
	}
}

/** Where a note or unmapped item points ("Flow data, B12"), or ''. */
export function location(item: { sheet?: string; cell?: string }): string {
	if (!item.sheet) return item.cell ?? '';
	return item.cell ? `${item.sheet}, ${item.cell}` : item.sheet;
}
