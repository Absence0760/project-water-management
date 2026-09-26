// Publishing a run (roadmap WP-2.3, 022_publication.sql, docs/api.md §
// Publication): the run stakeholders see, with the WUA's restriction notice,
// projected once per farm (FarmProjection) and for the catchment
// (catchment_view) with the engine's pure helpers.
import {
	analyseSeason,
	catchmentView,
	farmProjection,
	PROJECTION_SERIES,
	ProjectionInputError,
	upgradeLegacyModel,
	type CatchmentView,
	type NetworkNode,
	type ProjectionRun,
	type RestrictionLevel,
	type Transfer
} from '@water-management/engine';
import { z } from 'zod';
import type { Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { recentShortfall, type RecentShortfall } from './recent.js';

/** Newest publications kept per project (the run_publication_cap trigger, 022_publication.sql, keeps the same number). */
export const PUBLICATION_HISTORY_MAX = 12;
/** Longest note or notice, in characters (022_publication.sql CHECKs). */
export const PUBLICATION_TEXT_MAX = 2000;

/** What a publication stores for the catchment: the engine's CatchmentView plus the run's meta. Counts and dates only. */
export interface StoredCatchmentView extends CatchmentView {
	engineVersion: string;
	runoffModel: string;
	/** The run's calibration headline over its calibration window; null without observed flow. */
	calibration: { nse: number | null; pbias: number | null; kge: number | null } | null;
	/**
	 * Farms short in the 7 and 30 days to dataUntil, for the portfolio
	 * dashboard (WP-2.14). Staff only: a farmer's publication response leaves
	 * it out (neighbours' shortfalls), and the share link's allowlist never
	 * copies it. Absent on publications made before it existed.
	 */
	recent?: RecentShortfall;
}

export interface PublicationMeta {
	id: string;
	runId: string;
	publishedAt: string;
	publishedBy: string | null;
	restriction: { level: RestrictionLevel };
	supersededAt: string | null;
}

export interface Publication extends Omit<PublicationMeta, 'restriction'> {
	/** The modeller's note: viewers and above only (absent for a farmer). */
	note?: string;
	restriction: { level: RestrictionLevel; pct: number | null; noticeEn: string | null; noticeAf: string | null };
	nextExpectedOn: string | null;
	catchmentView: StoredCatchmentView;
	updatedAt: string | null;
	updatedBy: string | null;
}

/** Text the database can hold: trimmed, no NUL; empty means none. */
const text = z
	.string()
	.trim()
	.max(PUBLICATION_TEXT_MAX)
	.refine((s) => !s.includes('\u0000'), 'text cannot contain NUL characters');
const notice = text.nullable().transform((s) => (s ? s : null));
const isoDate = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
	.refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s, 'not a date');

/** The WUA's notice. A change replaces all of it. */
export const RestrictionBody = z
	.object({
		level: z.enum(['none', 'advisory', 'restricted']),
		pct: z.number().min(0).max(100).nullable().optional(),
		noticeEn: notice.optional(),
		noticeAf: notice.optional()
	})
	.strict()
	.refine((r) => r.level !== 'none' || r.pct == null, { message: 'no restriction carries no percentage', path: ['pct'] })
	.transform((r) => ({ level: r.level, pct: r.pct == null ? null : Math.round(r.pct * 100) / 100, noticeEn: r.noticeEn ?? null, noticeAf: r.noticeAf ?? null }));

export const PublishBody = z
	.object({
		runId: z.string().uuid(),
		note: text.optional(),
		restriction: RestrictionBody.optional(),
		nextExpectedOn: isoDate.nullable().optional()
	})
	.strict();

export const PatchBody = z
	.object({
		note: text.optional(),
		restriction: RestrictionBody.optional(),
		nextExpectedOn: isoDate.nullable().optional()
	})
	.strict()
	.refine((b) => b.note !== undefined || b.restriction !== undefined || b.nextExpectedOn !== undefined, 'send note, restriction or nextExpectedOn');

interface PublicationRow {
	id: string;
	run_id: string;
	published_at: Date;
	published_by_name: string | null;
	note: string;
	restriction_level: RestrictionLevel;
	restriction_pct: string | null;
	notice_en: string | null;
	notice_af: string | null;
	next_expected_on: string | null;
	catchment_view: StoredCatchmentView;
	superseded_at: Date | null;
	updated_at: Date | null;
	updated_by_name: string | null;
}

const SELECT_PUBLICATION = `
	SELECT p.id, p.run_id, p.published_at, pu.display_name AS published_by_name, p.note, p.restriction_level,
		p.restriction_pct, p.notice_en, p.notice_af, p.next_expected_on, p.catchment_view, p.superseded_at,
		p.updated_at, uu.display_name AS updated_by_name
	FROM run_publication p
	LEFT JOIN app_user pu ON pu.id = p.published_by
	LEFT JOIN app_user uu ON uu.id = p.updated_by`;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** The catchment view without its staff-only part (recent farm shortfall counts), for a farmer. */
function staffOnlyRemoved(cv: StoredCatchmentView): StoredCatchmentView {
	const { recent: _recent, ...rest } = cv;
	return rest;
}

function toPublication(r: PublicationRow, withNote: boolean): Publication {
	return {
		id: r.id,
		runId: r.run_id,
		publishedAt: r.published_at.toISOString(),
		publishedBy: r.published_by_name,
		...(withNote ? { note: r.note } : {}),
		restriction: { level: r.restriction_level, pct: r.restriction_pct === null ? null : Number(r.restriction_pct), noticeEn: r.notice_en, noticeAf: r.notice_af },
		nextExpectedOn: r.next_expected_on,
		catchmentView: withNote ? r.catchment_view : staffOnlyRemoved(r.catchment_view),
		supersededAt: iso(r.superseded_at),
		updatedAt: iso(r.updated_at),
		updatedBy: r.updated_by_name
	};
}

const toMeta = (r: PublicationRow): PublicationMeta => ({
	id: r.id,
	runId: r.run_id,
	publishedAt: r.published_at.toISOString(),
	publishedBy: r.published_by_name,
	restriction: { level: r.restriction_level },
	supersededAt: iso(r.superseded_at)
});

/** The current publication and the history (newest first, the current one included). */
export async function listPublications(db: Db, projectId: string, withNote: boolean): Promise<{ current: Publication | null; history: PublicationMeta[] }> {
	const { rows } = await db.query<PublicationRow>(`${SELECT_PUBLICATION} WHERE p.project_id = $1 ORDER BY p.published_at DESC, p.id DESC`, [projectId]);
	const cur = rows.find((r) => r.superseded_at === null);
	return { current: cur ? toPublication(cur, withNote) : null, history: rows.map(toMeta) };
}

async function getPublication(db: Db, id: string): Promise<Publication> {
	const { rows } = await db.query<PublicationRow>(`${SELECT_PUBLICATION} WHERE p.id = $1`, [id]);
	return toPublication(rows[0]!, true);
}

/** A saved run's model snapshot and its series, as the engine's projection reads them. */
async function loadProjectionRun(
	db: Db,
	projectId: string,
	runId: string
): Promise<{ run: ProjectionRun; engineVersion: string; runoffModel: string; calibration: StoredCatchmentView['calibration'] } | null> {
	const { rows } = await db.query<{
		start_date: string;
		end_date: string;
		engine_version: string;
		model: { nodes?: NetworkNode[]; transfers?: Transfer[] } | null;
		runoff_model: string;
		calibration: { nse?: number | null; pbias?: number | null; kge?: number | null } | null;
		observed_until: string | null;
	}>(
		// observed_until: the last day of the observed rain drivers in the run's
		// input snapshot (catchment gauge, CHIRPS), not the forecast: a run that
		// goes on past it on forecast rain is projected only to here.
		`SELECT start_date, end_date, engine_version, inputs->'model' AS model,
			(SELECT max((s.value->>'startDate')::date + (s.value->>'length')::int - 1)
			 FROM jsonb_each(inputs->'series') s
			 WHERE s.key IN ('rain_catchment_mm', 'rain_chirps_mm') AND (s.value->>'length')::int > 0) AS observed_until,
			COALESCE(inputs->'settings'->>'runoffModel', 'legacy') AS runoff_model, summary->'calibration' AS calibration
		 FROM model_run WHERE project_id = $1 AND id = $2`,
		[projectId, runId]
	);
	const r = rows[0];
	if (!r) return null;
	const model = upgradeLegacyModel(r.model ?? {});
	const nodes = (model.nodes ?? []) as NetworkNode[];
	const keys = [...new Set(Object.values(PROJECTION_SERIES).flat())];
	const { rows: series } = await db.query<{ node_id: string | null; key: string; values: (number | null)[] }>(
		`SELECT node_id, key, "values" FROM run_series WHERE run_id = $1 AND key = ANY($2::text[])`,
		[runId, keys]
	);
	const byKey = new Map(series.map((s) => [`${s.node_id ?? ''}|${s.key}`, s.values]));
	const c = r.calibration;
	return {
		run: {
			startDate: r.start_date,
			endDate: r.end_date,
			...(r.observed_until ? { dataUntil: r.observed_until } : {}),
			nodes,
			transfers: (model.transfers ?? []) as Transfer[],
			series: (nodeId, key) => byKey.get(`${nodeId ?? ''}|${key}`)
		},
		engineVersion: r.engine_version,
		runoffModel: r.runoff_model,
		calibration: c ? { nse: c.nse ?? null, pbias: c.pbias ?? null, kge: c.kge ?? null } : null
	};
}

/**
 * Publish a run: supersede the current publication, store the new one with
 * its catchment view, and one projection per farm that still exists as a
 * farm. One transaction (the caller's), one publish at a time per project.
 */
export async function publishRun(db: Db, projectId: string, body: z.infer<typeof PublishBody>): Promise<{ publication: Publication; farms: number }> {
	await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('run_publication:' || $1::text, 0))`, [projectId]);
	const loaded = await loadProjectionRun(db, projectId, body.runId);
	if (!loaded) throw new ApiError(400, 'no such run in this project');
	// Audit H1: a legacy-runoff run is a workbook comparison, not evidence.
	if (loaded.runoffModel === 'legacy') throw new ApiError(409, 'this run used the legacy runoff model, a workbook comparison only; run a conceptual model to publish');
	let analysis;
	let views;
	try {
		analysis = analyseSeason(loaded.run);
		// Only farms that are still farms of the project: a node deleted or turned into a gauge since the run has no farmers to show it to.
		const snapshotFarms = loaded.run.nodes.filter((n) => n.kind === 'farm').map((n) => n.id);
		const { rows: live } = await db.query<{ id: string }>(`SELECT id FROM node WHERE project_id = $1 AND kind = 'farm' AND id = ANY($2::uuid[])`, [
			projectId,
			snapshotFarms
		]);
		const liveIds = new Set(live.map((r) => r.id));
		views = snapshotFarms.filter((id) => liveIds.has(id)).map((id) => farmProjection(loaded.run, id, analysis!));
	} catch (err) {
		if (err instanceof ProjectionInputError) throw new ApiError(409, `this run can't be published: ${err.message}`);
		throw err;
	}
	const stored: StoredCatchmentView = {
		...catchmentView(loaded.run, analysis),
		engineVersion: loaded.engineVersion,
		runoffModel: loaded.runoffModel,
		calibration: loaded.calibration,
		recent: recentShortfall(loaded.run, analysis)
	};
	await db.query('UPDATE run_publication SET superseded_at = now() WHERE project_id = $1 AND superseded_at IS NULL', [projectId]);
	const r = body.restriction ?? { level: 'none' as const, pct: null, noticeEn: null, noticeAf: null };
	const { rows } = await db.query<{ id: string }>(
		`INSERT INTO run_publication (project_id, run_id, published_by, note, restriction_level, restriction_pct, notice_en, notice_af, next_expected_on, catchment_view)
		 VALUES ($1, $2, app_current_user_id(), $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
		[projectId, body.runId, body.note ?? '', r.level, r.pct, r.noticeEn, r.noticeAf, body.nextExpectedOn ?? null, JSON.stringify(stored)]
	);
	const pubId = rows[0]!.id;
	if (views.length) {
		await db.query(
			`INSERT INTO publication_farm (publication_id, project_id, node_id, view)
			 SELECT $1, $2, (e->>'nodeId')::uuid, e FROM jsonb_array_elements($3::jsonb) e`,
			[pubId, projectId, JSON.stringify(views)]
		);
	}
	return { publication: await getPublication(db, pubId), farms: views.length };
}

/** Change the current publication's notice, note or next date, without re-publishing. */
export async function patchPublication(db: Db, projectId: string, pubId: string, body: z.infer<typeof PatchBody>): Promise<Publication> {
	const { rows } = await db.query<{ superseded: boolean }>('SELECT superseded_at IS NOT NULL AS superseded FROM run_publication WHERE project_id = $1 AND id = $2', [
		projectId,
		pubId
	]);
	if (!rows[0]) throw new ApiError(404, 'not found');
	if (rows[0].superseded) throw new ApiError(409, 'this publication has been superseded; change the current one');
	const set: [string, unknown][] = [];
	if (body.note !== undefined) set.push(['note', body.note]);
	if (body.nextExpectedOn !== undefined) set.push(['next_expected_on', body.nextExpectedOn]);
	if (body.restriction) {
		set.push(['restriction_level', body.restriction.level], ['restriction_pct', body.restriction.pct], ['notice_en', body.restriction.noticeEn], ['notice_af', body.restriction.noticeAf]);
	}
	// Guarded again in the UPDATE: a publish that superseded this one since the
	// check above (it waits on the row lock) must not let the edit land on history.
	const { rowCount } = await db.query(
		`UPDATE run_publication SET ${set.map(([k], i) => `${k} = $${i + 3}`).join(', ')}, updated_at = now(), updated_by = app_current_user_id()
		 WHERE project_id = $1 AND id = $2 AND superseded_at IS NULL`,
		[projectId, pubId, ...set.map(([, v]) => v)]
	);
	if (!rowCount) throw new ApiError(409, 'this publication has been superseded; change the current one');
	return getPublication(db, pubId);
}
