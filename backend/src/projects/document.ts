// The portable "project document": everything needed to recreate a project
// (settings, model, input series). `GET /projects/:id/export.json` writes it and
// `POST /projects/import` / `pnpm import:project` read it (projects/import.ts),
// so a project round-trips export → import. The Python workbook importer
// (scripts/wbt-import) emits the same shape.
import { ENGINE_VERSION, SERIES_KINDS, type ProjectModel } from '@water-management/engine';
import { z } from 'zod';
import type { Db } from '../db/tx.js';
import { ModelBody } from '../model/validate.js';
import { loadModel } from '../model/store.js';
import { MAX_SERIES_VALUES, SeriesStartDate } from '../series/routes.js';
import { toCanonicalUnit } from '../series/merge.js';
import { mergeSettings, SettingsPatch } from './settings.js';

/** Marker written into exports; the importer ignores unknown top-level keys. */
export const PROJECT_DOCUMENT_FORMAT = 'water-management/project';
export const PROJECT_DOCUMENT_VERSION = 1;

export const ProjectFile = z.object({
	name: z.string().min(1).max(200),
	description: z.string().max(5000).default(''),
	settings: SettingsPatch.default({}),
	model: ModelBody,
	series: z
		.array(
			z.object({
				// Same kinds as PUT /projects/:id/series, so a typo in a workbook
				// import fails loudly instead of storing a series no run reads.
				kind: z.enum(SERIES_KINDS),
				// The same bounds as PUT /projects/:id/series, so an import can't
				// store a series the series routes would refuse.
				name: z.string().trim().max(100).default(''),
				unit: z.string().trim().min(1).max(20),
				startDate: SeriesStartDate,
				values: z.array(z.number().finite().nullable()).max(MAX_SERIES_VALUES)
			})
			// Stored in the kind's canonical unit, as PUT …/series stores it (series/merge.ts).
			.transform(toCanonicalUnit)
		)
		.default([])
});
export type ProjectFile = z.infer<typeof ProjectFile>;

export interface ProjectDocument {
	format: typeof PROJECT_DOCUMENT_FORMAT;
	version: typeof PROJECT_DOCUMENT_VERSION;
	exportedAt: string;
	engineVersion: string;
	name: string;
	description: string;
	/** Stored settings merged over the defaults, so the file is self-contained. */
	settings: Record<string, unknown>;
	model: ProjectModel;
	series: { kind: string; name: string; unit: string; startDate: string; values: (number | null)[] }[];
}

/** Read a project as a portable document (caller has already checked access). */
export async function loadProjectDocument(db: Db, projectId: string, now = new Date()): Promise<ProjectDocument | null> {
	const { rows } = await db.query<{ name: string; description: string; settings: unknown }>(
		'SELECT name, description, settings FROM project WHERE id = $1',
		[projectId]
	);
	const p = rows[0];
	if (!p) return null;
	const model = await loadModel(db, projectId);
	const { rows: series } = await db.query<ProjectDocument['series'][number]>(
		`SELECT kind, name, unit, start_date AS "startDate", "values" FROM time_series WHERE project_id = $1 ORDER BY kind, name`,
		[projectId]
	);
	return {
		format: PROJECT_DOCUMENT_FORMAT,
		version: PROJECT_DOCUMENT_VERSION,
		exportedAt: now.toISOString(),
		engineVersion: ENGINE_VERSION,
		name: p.name,
		description: p.description,
		settings: mergeSettings(p.settings) as unknown as Record<string, unknown>,
		model,
		series
	};
}
