// The import report kept with a project (017_project_import; docs/api.md §
// Projects, "Import report"): what the importer flagged when the project was
// imported, the notes and the unmapped report the review showed. The client
// sends it as an optional `importReport` key beside the project document on
// POST /projects/import; it is stored in the import's transaction and read
// back by GET /projects/:id/import-report.
//
// Every string in it comes from the file (farm names, formula text) through
// the client, so it is untrusted: zod caps every list and string here, and the
// frontend renders it as text only (docs/security.md § Import reports).
//
// Reached from lambda.ts through the routes: never import dotenv here.
import { z } from 'zod';
import type { Db } from '../db/tx.js';

/** Most notes, and most unmapped items, one report keeps (017_project_import.sql CHECK). */
export const IMPORT_REPORT_MAX_ITEMS = 500;
/**
 * Most bytes the notes and unmapped lists take together, as JSON. The
 * database's backstop CHECK is 1 MiB over its own (slightly wider) jsonb text.
 */
export const IMPORT_REPORT_MAX_BYTES = 512 * 1024;
/** Per-field string caps; the frontend clips to the same (components/import/importReport.ts). */
export const IMPORT_REPORT_LIMITS = {
	fileName: 255,
	importerVersion: 100,
	code: 64,
	message: 2000,
	sheet: 100,
	cell: 20,
	element: 200,
	text: 8192
} as const;

/** A string of at most `max` characters; Postgres can't hold NUL, so it's refused here, not as a database error. */
const text = (max: number) =>
	z
		.string()
		.max(max)
		.refine((s) => !s.includes('\u0000'), 'cannot contain NUL characters');
const L = IMPORT_REPORT_LIMITS;
const code = z.string().regex(/^[a-z0-9-]+$/, 'lower-case letters, digits and hyphens').max(L.code);
const where = { sheet: text(L.sheet).optional(), cell: text(L.cell).optional(), element: text(L.element).optional() };

/** ImportNote (frontend/src/lib/spreadsheet/import/report.ts). Unknown keys are dropped. */
export const ImportReportNote = z.object({ code, severity: z.enum(['info', 'warning']), message: text(L.message).min(1), ...where });
/** UnmappedItem: `text` is the formula or cell text verbatim. */
export const ImportReportUnmapped = z.object({ code, message: text(L.message).min(1), ...where, text: text(L.text).optional() });

const omitted = z.number().int().min(0).max(1_000_000).default(0);

export const ImportReport = z
	.object({
		source: z.enum(['b023-workbook', 'project-file']),
		fileName: text(L.fileName).trim().min(1),
		importerVersion: text(L.importerVersion).trim().min(1),
		notes: z.array(ImportReportNote).max(IMPORT_REPORT_MAX_ITEMS).default([]),
		unmapped: z.array(ImportReportUnmapped).max(IMPORT_REPORT_MAX_ITEMS).default([]),
		/** Items found beyond what was kept (the client trims to the caps). */
		notesOmitted: omitted,
		unmappedOmitted: omitted
	})
	.refine(
		(r) => Buffer.byteLength(JSON.stringify(r.notes)) + Buffer.byteLength(JSON.stringify(r.unmapped)) <= IMPORT_REPORT_MAX_BYTES,
		{ message: `the notes and unmapped lists together may be at most ${IMPORT_REPORT_MAX_BYTES / 1024} KB`, path: ['notes'] }
	);
export type ImportReport = z.infer<typeof ImportReport>;

/** The optional report on an import body: `{ ...projectFile, importReport? }`. Issues carry the `importReport` path. */
const ImportBodyReport = z.object({ importReport: ImportReport.optional() });

/** The import body's report, validated; undefined when it has none. Throws ZodError (→ 400). */
export function parseImportReport(raw: unknown): ImportReport | undefined {
	return ImportBodyReport.parse(raw).importReport;
}

/** Store `report` for the project just created, inside the import's `withUser` transaction. */
export async function insertImportReport(db: Db, projectId: string, report: ImportReport): Promise<void> {
	// imported_by / imported_at are stamped by the trigger, which also refuses
	// a project this transaction didn't create (017_project_import.sql).
	await db.query(
		`INSERT INTO project_import (project_id, imported_by, source, file_name, importer_version, notes, unmapped, notes_omitted, unmapped_omitted)
		 VALUES ($1, app_current_user_id(), $2, $3, $4, $5, $6, $7, $8)`,
		[
			projectId,
			report.source,
			report.fileName,
			report.importerVersion,
			JSON.stringify(report.notes),
			JSON.stringify(report.unmapped),
			report.notesOmitted,
			report.unmappedOmitted
		]
	);
}

/** GET /projects/:id/import-report's body: the newest import's report, or null when the project wasn't imported. */
export async function latestImportReport(db: Db, projectId: string) {
	const { rows } = await db.query(
		`SELECT i.imported_at AS "importedAt", u.display_name AS "importedBy", i.source, i.file_name AS "fileName",
			i.importer_version AS "importerVersion", i.notes, i.unmapped,
			i.notes_omitted AS "notesOmitted", i.unmapped_omitted AS "unmappedOmitted"
		 FROM project_import i LEFT JOIN app_user u ON u.id = i.imported_by
		 WHERE i.project_id = $1 ORDER BY i.imported_at DESC, i.id LIMIT 1`,
		[projectId]
	);
	const r = rows[0];
	return r ? { ...r, importedAt: (r.importedAt as Date).toISOString() } : null;
}
