// The portable "project document": everything needed to recreate a project
// (settings, model, input series). `GET /projects/:id/export.json` writes it and
// `POST /projects/import` / `pnpm import:project` read it (projects/import.ts),
// so a project round-trips export → import. The Python workbook importer
// (scripts/wbt-import) emits the same shape.
//
// The export also carries the project's notes (037_notes.sql) as a record:
// what the team wrote down belongs with the project's data. The importer
// doesn't read them back (ProjectFile has no `notes`, so zod drops the key):
// a note is its author's words, RLS lets a note be inserted only as
// yourself, and re-authoring them as the importer would misattribute them
// (docs/data-model.md § Notes).
import { cleanModelNames, DAY_BOUNDARIES, ENGINE_VERSION, SERIES_KINDS, type DayBoundary, type ProjectModel } from '@water-management/engine';
import { z } from 'zod';
import type { Db } from '../db/tx.js';
import { projectName } from '../http/visibleName.js';
import { ModelBody } from '../model/validate.js';
import { loadModel } from '../model/store.js';
import { MAX_SERIES_VALUES, SeriesStartDate } from '../series/routes.js';
import { checkProvenance, ProvenanceFields, SERIES_PER_PROJECT_MAX, SourceField, toCanonicalUnit } from '../series/merge.js';
import { targetOf } from '../notes/routes.js';
import { mergeSettings, SettingsPatch } from './settings.js';
import { DEFAULT_TIME_ZONE, TimeZone } from './timeZone.js';

/** Marker written into exports; the importer ignores unknown top-level keys. */
export const PROJECT_DOCUMENT_FORMAT = 'water-management/project';
export const PROJECT_DOCUMENT_VERSION = 1;

export const ProjectFile = z.object({
	/** Cleaned and checked as POST /projects's name is (http/visibleName.ts). */
	name: projectName,
	description: z.string().max(5000).default(''),
	/** The project's time zone (058_project_time_zone); absent in a file from before it = the default. */
	timeZone: TimeZone.default(DEFAULT_TIME_ZONE),
	settings: SettingsPatch.default({}),
	// A document is a bulk import, like a workbook's: a name over several lines (a file exported before
	// issue #385, a hand-edited one) is made one line (cleanModelNames), where the editor's PUT /model refuses it.
	model: z.preprocess(cleanModelNames, ModelBody),
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
				values: z.array(z.number().finite().nullable()).max(MAX_SERIES_VALUES),
				// What the values are (032_series_provenance.sql), e.g. CHIRPS 2.0; absent = not recorded.
				...ProvenanceFields,
				// How sub-daily readings were added up into days (033_series_day_boundary.sql); absent = daily values.
				dayBoundary: z.enum(DAY_BOUNDARIES).optional(),
				// A flow record's gauge node in the document's model (084_gauge_records); absent = the outlet.
				siteNodeId: z.string().uuid().optional(),
				// Where the values came from, and the unit they were first given in (107_series_source.sql); absent = not recorded.
				source: SourceField,
				sourceUnit: z.string().trim().min(1).max(20).optional(),
				sourceUnitFactor: z.number().finite().positive().optional()
			})
			.superRefine(checkProvenance)
			.refine((s) => (s.sourceUnit === undefined) === (s.sourceUnitFactor === undefined), {
				path: ['sourceUnitFactor'],
				message: 'give sourceUnit and sourceUnitFactor together'
			})
			// Stored in the kind's canonical unit, as PUT …/series stores it (series/merge.ts).
			.transform(toCanonicalUnit)
		)
		// A project's series cap (series/limits.ts), so one file can't create more than the series routes allow.
		.max(SERIES_PER_PROJECT_MAX, `a project holds at most ${SERIES_PER_PROJECT_MAX} series`)
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
	/** IANA zone (058_project_time_zone): dates the project's downloads. */
	timeZone: string;
	/** Stored settings merged over the defaults, so the file is self-contained. */
	settings: Record<string, unknown>;
	model: ProjectModel;
	/** product / productVersion only on a series that records them (032_series_provenance.sql). */
	series: {
		kind: string;
		name: string;
		unit: string;
		startDate: string;
		values: (number | null)[];
		product?: string;
		productVersion?: string;
		dayBoundary?: DayBoundary;
		siteNodeId?: string;
		/** Only on a series that records them (107_series_source.sql). */
		source?: string;
		sourceUnit?: string;
		sourceUnitFactor?: number;
	}[];
	/** The notes the exporter can see, oldest first; informational, the importer ignores them. */
	notes: ProjectDocumentNote[];
}

/**
 * A note as the export writes it. Never a deleted note (the API lists none to
 * anyone, so neither does the export, though RLS shows editors their bodies).
 * `visibility` says who saw it in the app: `team`, or `farm` (also the farm's
 * linked farmers). `nodeId` is the node's id in this document's model;
 * `runId`/`runLabel` name a run the document doesn't carry.
 */
export interface ProjectDocumentNote {
	body: string;
	/** Display name; null once that account is gone. */
	author: string | null;
	createdAt: string;
	editedAt: string | null;
	target: 'project' | 'node' | 'run' | 'setting';
	nodeId: string | null;
	nodeName: string | null;
	runId: string | null;
	runLabel: string | null;
	settingKey: string | null;
	visibility: 'team' | 'farm';
}

/**
 * The project's notes for the export, as the caller sees them (RLS), without
 * deleted ones. Only viewers and above can export, and they see every
 * undeleted note, `farm` ones included, so the file is what they can read in
 * the app. Notes on a scenario (115_scenario_share_notes) stay out, as the
 * scenarios themselves do: they are about an application, not the model.
 */
export async function loadDocumentNotes(db: Db, projectId: string): Promise<ProjectDocumentNote[]> {
	const { rows } = await db.query<{
		body: string;
		author: string | null;
		created_at: Date;
		edited_at: Date | null;
		node_id: string | null;
		node_name: string | null;
		run_id: string | null;
		run_label: string | null;
		setting_key: string | null;
		visibility: 'team' | 'farm';
	}>(
		`SELECT n.body, u.display_name AS author, n.created_at, n.edited_at, n.node_id, nd.name AS node_name,
			n.run_id, r.label AS run_label, n.setting_key, n.visibility
		 FROM note n
		 LEFT JOIN app_user u ON u.id = n.author_id
		 LEFT JOIN node nd ON nd.id = n.node_id
		 LEFT JOIN model_run r ON r.id = n.run_id
		 WHERE n.project_id = $1 AND n.deleted_at IS NULL AND n.scenario_id IS NULL
		 ORDER BY n.created_at, n.id`,
		[projectId]
	);
	return rows.map((r) => ({
		body: r.body,
		author: r.author,
		createdAt: r.created_at.toISOString(),
		editedAt: r.edited_at?.toISOString() ?? null,
		target: targetOf({ ...r, scenario_id: null }) as ProjectDocumentNote['target'],
		nodeId: r.node_id,
		nodeName: r.node_name,
		runId: r.run_id,
		runLabel: r.run_label,
		settingKey: r.setting_key,
		visibility: r.visibility
	}));
}

/** Read a project as a portable document (caller has already checked access). */
export async function loadProjectDocument(db: Db, projectId: string, now = new Date()): Promise<ProjectDocument | null> {
	const { rows } = await db.query<{ name: string; description: string; timeZone: string; settings: unknown }>(
		'SELECT name, description, time_zone AS "timeZone", settings FROM project WHERE id = $1',
		[projectId]
	);
	const p = rows[0];
	if (!p) return null;
	const model = await loadModel(db, projectId);
	const { rows: stored } = await db.query<
		Omit<ProjectDocument['series'][number], 'dayBoundary' | 'siteNodeId' | 'source' | 'sourceUnit' | 'sourceUnitFactor'> & {
			product: string | null;
			productVersion: string | null;
			dayBoundary: DayBoundary | null;
			siteNodeId: string | null;
			source: string | null;
			sourceUnit: string | null;
			sourceUnitFactor: number | null;
		}
	>(
		`SELECT kind, name, unit, start_date AS "startDate", "values", product, product_version AS "productVersion", day_boundary AS "dayBoundary",
			site_node_id AS "siteNodeId", source, source_unit AS "sourceUnit", source_unit_factor AS "sourceUnitFactor"
		 FROM time_series WHERE project_id = $1 ORDER BY kind, name`,
		[projectId]
	);
	// A site whose node has left the model (084: the record keeps it, the run warns) has nothing to point at in the file.
	const nodeIds = new Set(model.nodes.map((n) => n.id));
	const series = stored.map(({ product, productVersion, dayBoundary, siteNodeId, source, sourceUnit, sourceUnitFactor, ...s }) => ({
		...s,
		...(product !== null && productVersion !== null ? { product, productVersion } : {}),
		...(dayBoundary !== null ? { dayBoundary } : {}),
		...(siteNodeId !== null && nodeIds.has(siteNodeId) ? { siteNodeId } : {}),
		...(source !== null ? { source } : {}),
		...(sourceUnit !== null && sourceUnitFactor !== null ? { sourceUnit, sourceUnitFactor } : {})
	}));
	return {
		format: PROJECT_DOCUMENT_FORMAT,
		version: PROJECT_DOCUMENT_VERSION,
		exportedAt: now.toISOString(),
		engineVersion: ENGINE_VERSION,
		name: p.name,
		description: p.description,
		timeZone: p.timeZone,
		settings: mergeSettings(p.settings) as unknown as Record<string, unknown>,
		model,
		series,
		notes: await loadDocumentNotes(db, projectId)
	};
}
