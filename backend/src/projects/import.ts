// Create a project from a portable project document (a `ProjectFile`): what
// `GET /projects/:id/export.json` writes and scripts/wbt-import produces. One
// code path for `POST /projects/import` (projects/routes.ts) and the
// `pnpm import:project` / `pnpm seed:examples` scripts, so both validate the
// same way and both go through RLS as the importing user (docs/api.md
// § Projects, "Import a project file").
//
// Reached from lambda.ts through the routes: never import dotenv (or a module
// that does) here, so esbuild keeps it out of the deployment bundle.
import { resolveFitRecord, type ProjectModel } from '@water-management/engine';
import type { Db } from '../db/tx.js';
import { withUser } from '../db/tx.js';
import { recordModelRevision } from '../history/record.js';
import { ApiError } from '../http/errors.js';
import { saveModel } from '../model/store.js';
import { modelProblems } from '../model/validate.js';
import { runLiveModel } from '../runs/execute.js';
import { requireTeamRole } from '../teams/access.js';
import { ProjectFile } from './document.js';
import { mergeSettings, remapSettingNodeIds } from './settings.js';

/**
 * Body cap for POST /projects/import: 5 MB, the same as the export cap
 * (MAX_EXPORT_BYTES), so every file GET /projects/:id/export.json writes
 * imports back. Its own constant because it can't follow the export cap up:
 * a Lambda request payload stops at 6 MB (the event JSON, where the body is
 * one escaped string, plus headers), and a request can't be streamed. A
 * catchment with a multi-decade daily record is well under 1 MB (docs/api.md
 * § Projects), so there is ample headroom. If projects ever outgrow it, the fix is a gzip request body
 * with a decompressed cap (the compressed body arrives base64-encoded, +33 %).
 * import.test.ts fails if the export cap is raised past this one.
 */
export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;

/** Label of the run an import starts with (`run=1` / `--run`). */
export const IMPORT_RUN_LABEL = 'Initial run (import)';

/**
 * Validate a project document: the zod shape (a ZodError → 400 with its
 * issues), then the structural rules zod can't express. Unknown top-level keys
 * (an export's `format`, `version`, `exportedAt`, `engineVersion`) are ignored.
 */
export function parseProjectFile(raw: unknown): ProjectFile {
	const data = ProjectFile.parse(raw);
	const problems = projectFileProblems(data);
	if (problems.length) throw new ApiError(400, 'invalid project file', problems.map((message) => ({ message })));
	return data;
}

/** Human-readable problems with a parsed document; empty = valid. */
export function projectFileProblems(data: ProjectFile): string[] {
	const problems = modelProblems(data.model as ProjectModel);
	// The database keeps one series per kind and name (UNIQUE (project_id, kind, name)).
	const seen = new Set<string>();
	for (const s of data.series) {
		const key = `${s.kind}/${s.name}`;
		if (seen.has(key)) problems.push(`duplicate series ${s.kind}${s.name ? ` "${s.name}"` : ''}`);
		seen.add(key);
		// A flow record's site (084_gauge_records): a gauge of the file's own model, not the outlet.
		if (s.siteNodeId !== undefined) {
			const site = data.model.nodes.find((n) => n.id === s.siteNodeId);
			const what = `series ${s.kind}${s.name ? ` "${s.name}"` : ''}`;
			if (s.kind !== 'flow_observed_m3s' && s.kind !== 'flow_logger_m3s') problems.push(`${what}: only a flow record has a site`);
			else if (!site) problems.push(`${what}: its site is not a node of the model`);
			else if (site.kind !== 'gauge' || site.downstreamNodeId === null) problems.push(`${what}: its site "${site.name}" is not a gauge above the outlet`);
		}
	}
	return problems;
}

export interface InsertOptions {
	/** Use this name instead of the document's. */
	name?: string;
	/** Put the project in this team (member or admin of it); null/omitted = personal. */
	teamId?: string | null;
}

/**
 * Insert a validated document as a new project inside the caller's `withUser`
 * transaction, so any failure rolls the whole import back. Returns its id.
 * Every id is fresh (the document's ids are only references between its own
 * rows), so one file can be imported any number of times.
 */
export async function insertProjectFile(db: Db, data: ProjectFile, opts: InsertOptions = {}): Promise<string> {
	// Same rule and messages as POST /projects: 404 unless you're in the team,
	// 403 for a team viewer. RLS (project_insert) enforces it as well.
	if (opts.teamId) await requireTeamRole(db, opts.teamId, 'member', 'team not found');
	const { model, ids } = freshIds(data.model as ProjectModel);
	const id = crypto.randomUUID();
	// Id generated here, not via RETURNING: RLS checks RETURNING rows against
	// the SELECT policy before the AFTER trigger has made the importer owner.
	await db.query(
		`INSERT INTO project (id, name, description, settings, created_by, team_id, time_zone)
		 VALUES ($1, $2, $3, $4, app_current_user_id(), $5, $6)`,
		[id, opts.name ?? data.name, data.description, JSON.stringify(importedSettings(data.settings, ids)), opts.teamId ?? null, data.timeZone]
	);
	await saveModel(db, id, model);
	for (const s of data.series) {
		await db.query(
			`INSERT INTO time_series (project_id, kind, name, unit, start_date, "values", product, product_version, day_boundary, site_node_id,
				source, source_unit, source_unit_factor)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
			[
				id,
				s.kind,
				s.name,
				s.unit,
				s.startDate,
				s.values,
				s.product ?? null,
				s.productVersion ?? null,
				s.dayBoundary ?? null,
				// The site follows its gauge to the fresh id (projectFileProblems checked it is one of the file's).
				s.siteNodeId ? (ids.get(s.siteNodeId) ?? null) : null,
				s.source ?? null,
				// The unit the values were first given in (107): the file's record of it, else the file's own unit.
				s.sourceUnit ?? s.givenUnit,
				s.sourceUnitFactor ?? s.unitFactor
			]
		);
	}
	// The project's history starts with the imported state (030_history.sql).
	await recordModelRevision(db, id, { source: 'import', before: null });
	return id;
}

/**
 * The stored settings for an import: the document's own (a workbook import's
 * partial settings stay partial, so later engine defaults still apply), with
 * node references following the fresh ids and the fit record's hand-edit list
 * recomputed, as PATCH does, so a file can't hide or invent an edit.
 */
function importedSettings(settings: ProjectFile['settings'], ids: ReadonlyMap<string, string>) {
	const out = remapSettingNodeIds(settings, ids);
	if (out.fitRecord !== undefined) out.fitRecord = resolveFitRecord(mergeSettings(out) as unknown as Parameters<typeof resolveFitRecord>[0]);
	return out;
}

export interface RunOutcome {
	runId?: string;
	/** Why the requested run failed; the import itself stands. */
	runError?: string;
}

/**
 * The run an import may ask for, in its own transaction after the import has
 * committed: a model that can't run yet (no A-pan evaporation, no rainfall) is
 * still worth importing, so a failure is reported, never thrown.
 */
export async function runImported(userId: string, projectId: string): Promise<RunOutcome> {
	try {
		// As POST …/runs: no connection is held while the engine runs.
		const id = await runLiveModel(userId, projectId, IMPORT_RUN_LABEL, 'manual', async (_db, run) => run.id);
		return { runId: id };
	} catch (err) {
		if (err instanceof ApiError) return { runError: `model run failed: ${err.message}` };
		// A database error carries a SQLSTATE; its text names schema details.
		if ((err as { code?: unknown }).code) {
			console.error('import run failed', err);
			return { runError: 'model run failed: the results could not be saved' };
		}
		return { runError: `model run failed: ${(err as Error).message}` };
	}
}

export interface ImportOptions extends InsertOptions {
	/** Also run the model once after importing. */
	run?: boolean;
}

/**
 * Import an already validated document (parseProjectFile) as `userId` in one
 * transaction, then run it if asked. The scripts' entry point; the route does
 * the same in steps so it can answer with the project as its transaction sees it.
 */
export async function importProjectFile(userId: string, data: ProjectFile, opts: ImportOptions = {}): Promise<{ projectId: string } & RunOutcome> {
	const projectId = await withUser(userId, (db) => insertProjectFile(db, data, opts));
	return { projectId, ...(opts.run ? await runImported(userId, projectId) : {}) };
}

/** Plain code-unit order, as the engine compares ids (packages/engine/src/order.ts cmpStr). */
const idOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Fresh ids for every model row, keeping internal references intact; `ids`
 * maps old → new.
 *
 * The new ids are random but keep the old ids' order. The engine sums and
 * breaks ties in id order (docs/model.md §6, "The ordering rule"), so ids
 * that sorted differently would change the floating-point order of those
 * sums, and on a real catchment that noise grows into different results at
 * dam triggers and empties. With the order kept, importing the same document
 * twice, or copying a project, runs exactly as the original.
 */
export function freshIds(m: ProjectModel): { model: ProjectModel; ids: ReadonlyMap<string, string> } {
	const old = new Set<string>();
	for (const n of m.nodes) old.add(n.id), n.downstreamNodeId && old.add(n.downstreamNodeId);
	for (const c of m.crops) old.add(c.id);
	for (const a of m.cropAreas) old.add(a.nodeId), old.add(a.cropId);
	for (const t of m.transfers) old.add(t.id), old.add(t.fromNodeId), old.add(t.toNodeId);
	for (const p of m.landCover ?? []) old.add(p.id), old.add(p.nodeId);
	for (const b of m.boreholes ?? []) old.add(b.id), old.add(b.nodeId);
	for (const o of m.demandObjects ?? []) old.add(o.id), old.add(o.nodeId);
	const sortedOld = [...old].sort(idOrder);
	const fresh = new Set<string>();
	while (fresh.size < sortedOld.length) fresh.add(crypto.randomUUID());
	const sortedFresh = [...fresh].sort(idOrder);
	const map = new Map(sortedOld.map((o, i) => [o, sortedFresh[i]!] as const));
	const id = (o: string) => map.get(o)!;
	return {
		model: {
			nodes: m.nodes.map((n) => ({ ...n, id: id(n.id), downstreamNodeId: n.downstreamNodeId && id(n.downstreamNodeId) })),
			crops: m.crops.map((c) => ({ ...c, id: id(c.id) })),
			cropAreas: m.cropAreas.map((a) => ({ ...a, nodeId: id(a.nodeId), cropId: id(a.cropId) })),
			transfers: m.transfers.map((t) => ({ ...t, id: id(t.id), fromNodeId: id(t.fromNodeId), toNodeId: id(t.toNodeId) })),
			landCover: (m.landCover ?? []).map((p) => ({ ...p, id: id(p.id), nodeId: id(p.nodeId) })),
			...(m.boreholes?.length ? { boreholes: m.boreholes.map((b) => ({ ...b, id: id(b.id), nodeId: id(b.nodeId) })) } : {}),
			...(m.demandObjects?.length ? { demandObjects: m.demandObjects.map((o) => ({ ...o, id: id(o.id), nodeId: id(o.nodeId) })) } : {})
		},
		ids: map
	};
}
