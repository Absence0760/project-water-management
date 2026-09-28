// Messages between the page (runner.ts) and the import worker
// (import.worker.ts), and how a failure crosses the boundary: a
// WorkbookImportError becomes a plain object with its code and the fields
// the UI needs (the missing named ranges, the sheet and cell), since class
// instances don't survive postMessage. Type-only imports and ./errors (no
// parser), so the page side stays light.
import { InvalidWorkbookError, NotB023WorkbookError, UnreadableWorkbookError, WorkbookImportError, WorkbookTooLargeError, type WorkbookImportErrorCode } from './errors';
import type { ImportResult } from './extract';
import type { GaugeScaling } from './gauge';

/** The importer's options a user can change on the review screen. */
export interface WorkbookImportOptions {
	/** Import the gauge column as a reference gauge on another river, optionally undoing a known scaling. */
	gaugeAsReference?: boolean | GaugeScaling;
}

export type ToWorker =
	/** Read the file, then extract the project with these options. */
	| { type: 'parse'; file: Blob; fileName: string; options: WorkbookImportOptions }
	/** Extract again from the workbook already read, with other options. */
	| { type: 'extract'; options: WorkbookImportOptions };

export interface WorkbookImportProgress {
	/** 'read': parsing a sheet of the file (the slow part); 'extract': building the project from it. */
	stage: 'read' | 'extract';
	sheet: string;
	/** 1-based step within the stage. */
	step: number;
	steps: number;
}

/** A failure, as the page receives it. `message` may quote the file: render it as text. */
export interface WorkbookImportFailure {
	code: WorkbookImportErrorCode | 'internal';
	message: string;
	/** not-b023: every required named range the workbook lacks. */
	missing?: string[];
	/** unreadable: why (not-zip, encrypted, zip64, method, corrupt, not-workbook). */
	reason?: string;
	/** too-large: which limit. */
	what?: 'bytes' | 'sheets' | 'unpacked';
	/** invalid-workbook: where. */
	sheet?: string;
	cell?: string;
}

export type FromWorker =
	| { type: 'progress'; progress: WorkbookImportProgress }
	| { type: 'result'; result: ImportResult }
	| { type: 'error'; error: WorkbookImportFailure };

/** Any thrown value → the failure the page shows. */
export function toFailure(e: unknown): WorkbookImportFailure {
	if (e instanceof WorkbookImportError) {
		const out: WorkbookImportFailure = { code: e.code, message: e.message };
		if (e instanceof NotB023WorkbookError) out.missing = [...e.missing];
		if (e instanceof UnreadableWorkbookError) out.reason = e.reason;
		if (e instanceof WorkbookTooLargeError) out.what = e.what;
		if (e instanceof InvalidWorkbookError) {
			if (e.sheet !== undefined) out.sheet = e.sheet;
			if (e.cell !== undefined) out.cell = e.cell;
		}
		return out;
	}
	return { code: 'internal', message: e instanceof Error ? e.message : String(e) };
}
