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
	type CropArea,
	type DemandObject,
	type CropDef,
	type FarmProjection,
	type ForecastSummary,
	type NetworkNode,
	type ProjectionRun,
	isLocale,
	LOCALES,
	type NoticeText,
	type RestrictionLevel,
	type Transfer
} from '@water-management/engine';
import { z } from 'zod';
import type { Db } from '../db/tx.js';
import { recordAudit } from '../history/record.js';
import { ApiError } from '../http/errors.js';
import { noticeChangedSubject, publishedSubject } from './decision.js';
import { DEFAULT_TIME_ZONE, localDate } from '../projects/timeZone.js';
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
	restriction: { level: RestrictionLevel; pct: number | null; notice: NoticeText };
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
/**
 * The notice by language code: each key a language of the table
 * (packages/engine/src/languages.ts), each value its words. A blank one is
 * no notice in that language; null or {} is none at all
 * (081_notice_languages.sql).
 */
export const NoticeTextBody = z
	.record(z.string(), text)
	.nullable()
	.superRefine((m, ctx) => {
		for (const code of Object.keys(m ?? {})) {
			if (!isLocale(code)) ctx.addIssue({ code: 'custom', path: [code], message: `unknown language "${code}"; the notice takes ${LOCALES.join(', ')}` });
		}
	})
	.transform((m): NoticeText => {
		const out: NoticeText = {};
		for (const code of LOCALES) if (m && Object.hasOwn(m, code) && m[code]) out[code] = m[code];
		return out;
	});
const isoDate = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
	.refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s, 'not a date');

/** The WUA's notice. A change replaces all of it. */
export const RestrictionBody = z
	.object({
		level: z.enum(['none', 'advisory', 'restricted']),
		pct: z.number().min(0).max(100).nullable().optional(),
		notice: NoticeTextBody.optional()
	})
	.strict()
	.refine((r) => r.level !== 'none' || r.pct == null, { message: 'no restriction carries no percentage', path: ['pct'] })
	.transform((r) => ({ level: r.level, pct: r.pct == null ? null : Math.round(r.pct * 100) / 100, notice: r.notice ?? {} }));

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
	notice: NoticeText;
	next_expected_on: string | null;
	catchment_view: StoredCatchmentView;
	superseded_at: Date | null;
	updated_at: Date | null;
	updated_by_name: string | null;
}

const SELECT_PUBLICATION = `
	SELECT p.id, p.run_id, p.published_at, pu.display_name AS published_by_name, p.note, p.restriction_level,
		p.restriction_pct, p.notice, p.next_expected_on, p.catchment_view, p.superseded_at,
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
		restriction: { level: r.restriction_level, pct: r.restriction_pct === null ? null : Number(r.restriction_pct), notice: r.notice },
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

/**
 * A farm's projection with its forecast days (WP-2.12) when the published run
 * is a forecast run: the farmer's "Next 14 days". Figures of the forecast
 * run's summary.forecast; the rest of the projection covers history only
 * (dataUntil is the day before the first forecast day).
 */
export function withFarmForecast(view: FarmProjection, forecast: { summary: ForecastSummary; madeOn: string } | null): FarmProjection {
	if (!forecast) return view;
	const f = forecast.summary;
	const farm = f.perFarm.find((p) => p.nodeId === view.nodeId);
	if (!farm) return view;
	return {
		...view,
		forecast: {
			from: f.from,
			to: f.to,
			days: f.days,
			madeOn: forecast.madeOn,
			minDamPct: farm.minDamPct,
			minDamDate: farm.minDamDate ?? null,
			deficitDays: farm.deficitDays,
			suppliedFraction: farm.suppliedFraction
		}
	};
}

/** A saved run's model snapshot and its series, as the engine's projection reads them. */
async function loadProjectionRun(
	db: Db,
	projectId: string,
	runId: string
): Promise<{
	run: ProjectionRun;
	engineVersion: string;
	runoffModel: string;
	calibration: StoredCatchmentView['calibration'];
	/** A forecast run's summary.forecast (WP-2.12) and the day it was made, in the project's time zone (058); null for an ordinary run. */
	forecast: { summary: ForecastSummary; madeOn: string } | null;
	/** SHA-256 (hex) of the run's inputs snapshot, for the decision log (decision.ts). */
	inputsSha256: string;
} | null> {
	const { rows } = await db.query<{
		start_date: string;
		end_date: string;
		engine_version: string;
		model: { nodes?: NetworkNode[]; transfers?: Transfer[]; crops?: CropDef[]; cropAreas?: CropArea[]; demandObjects?: DemandObject[] } | null;
		apan_mm: unknown;
		runoff_model: string;
		calibration: { nse?: number | null; pbias?: number | null; kge?: number | null } | null;
		observed_until: string | null;
		forecast: ForecastSummary | null;
		created_at: Date;
		time_zone: string | null;
		inputs_sha256: string;
	}>(
		// observed_until: the last day of the observed rain drivers in the run's
		// input snapshot (catchment gauge, CHIRPS), not the forecast: a run that
		// goes on past it on forecast rain is projected only to here. A forecast
		// run (WP-2.12) knows exactly: its history ends the day before its first
		// forecast day.
		`SELECT start_date, end_date, engine_version, inputs->'model' AS model,
			COALESCE(to_char((summary->'forecast'->>'from')::date - 1, 'YYYY-MM-DD'),
				(SELECT to_char(max((s.value->>'startDate')::date + (s.value->>'length')::int - 1), 'YYYY-MM-DD')
				 FROM jsonb_each(inputs->'series') s
				 WHERE s.key IN ('rain_catchment_mm', 'rain_chirps_mm') AND (s.value->>'length')::int > 0)) AS observed_until,
			summary->'forecast' AS forecast, created_at, encode(sha256(convert_to(inputs::text, 'UTF8')), 'hex') AS inputs_sha256, (SELECT p.time_zone FROM project p WHERE p.id = model_run.project_id) AS time_zone,
			COALESCE(inputs->'settings'->>'runoffModel', 'legacy') AS runoff_model, inputs->'settings'->'apanMm' AS apan_mm, summary->'calibration' AS calibration
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
			// Crops under their own irrigation efficiency (engine ≥ 0.43.0) set the farm's efficiency and consumptive share.
			crops: (model.crops ?? []) as CropDef[],
			cropAreas: (model.cropAreas ?? []) as CropArea[],
			apanMm: Array.isArray(r.apan_mm) ? r.apan_mm : [],
			// A unit with demand objects (engine ≥ 1.7.0) takes its consumptive share from its return flow.
			...(model.demandObjects?.length ? { demandObjects: model.demandObjects as DemandObject[] } : {}),
			series: (nodeId, key) => byKey.get(`${nodeId ?? ''}|${key}`)
		},
		engineVersion: r.engine_version,
		runoffModel: r.runoff_model,
		calibration: c ? { nse: c.nse ?? null, pbias: c.pbias ?? null, kge: c.kge ?? null } : null,
		forecast: r.forecast ? { summary: r.forecast, madeOn: localDate(r.created_at, r.time_zone ?? DEFAULT_TIME_ZONE) } : null,
		inputsSha256: r.inputs_sha256
	};
}

/**
 * Publish a run: supersede the current publication, store the new one with
 * its catchment view, and one projection per farm that still exists as a
 * farm, and record it in the decision log (the `publication.published` audit
 * event, decision.ts; `auto` for an auto run published by itself). One
 * transaction (the caller's), one publish at a time per project.
 */
export async function publishRun(
	db: Db,
	projectId: string,
	body: z.infer<typeof PublishBody>,
	opts: { auto?: boolean } = {}
): Promise<{ publication: Publication; farms: number }> {
	await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('run_publication:' || $1::text, 0))`, [projectId]);
	const loaded = await loadProjectionRun(db, projectId, body.runId);
	if (!loaded) throw new ApiError(400, 'no such run in this project');
	// Audit H1: a legacy-runoff run is a workbook comparison, not evidence.
	if (loaded.runoffModel === 'legacy') throw new ApiError(409, 'this run used the legacy runoff model (removed in engine 1.0.0), a workbook comparison only; run the model again to publish');
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
		views = snapshotFarms.filter((id) => liveIds.has(id)).map((id) => withFarmForecast(farmProjection(loaded.run, id, analysis!), loaded.forecast));
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
	const r = body.restriction ?? { level: 'none' as const, pct: null, notice: {} };
	const { rows } = await db.query<{ id: string }>(
		`INSERT INTO run_publication (project_id, run_id, published_by, note, restriction_level, restriction_pct, notice, next_expected_on, catchment_view)
		 VALUES ($1, $2, app_current_user_id(), $3, $4, $5, $6, $7, $8) RETURNING id`,
		[projectId, body.runId, body.note ?? '', r.level, r.pct, JSON.stringify(r.notice), body.nextExpectedOn ?? null, JSON.stringify(stored)]
	);
	const pubId = rows[0]!.id;
	if (views.length) {
		await db.query(
			`INSERT INTO publication_farm (publication_id, project_id, node_id, view)
			 SELECT $1, $2, (e->>'nodeId')::uuid, e FROM jsonb_array_elements($3::jsonb) e`,
			[pubId, projectId, JSON.stringify(views)]
		);
	}
	const publication = await getPublication(db, pubId);
	await recordAudit(db, projectId, 'publication.published', publishedSubject(publication, { inputsSha256: loaded.inputsSha256, views, auto: opts.auto }));
	return { publication, farms: views.length };
}

/** Change the current publication's notice, note or next date, without re-publishing, and record it in the decision log (`publication.notice_changed`). */
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
		set.push(['restriction_level', body.restriction.level], ['restriction_pct', body.restriction.pct], ['notice', JSON.stringify(body.restriction.notice)]);
	}
	// Guarded again in the UPDATE: a publish that superseded this one since the
	// check above (it waits on the row lock) must not let the edit land on history.
	const { rowCount } = await db.query(
		`UPDATE run_publication SET ${set.map(([k], i) => `${k} = $${i + 3}`).join(', ')}, updated_at = now(), updated_by = app_current_user_id()
		 WHERE project_id = $1 AND id = $2 AND superseded_at IS NULL`,
		[projectId, pubId, ...set.map(([, v]) => v)]
	);
	if (!rowCount) throw new ApiError(409, 'this publication has been superseded; change the current one');
	const publication = await getPublication(db, pubId);
	const fields = (['note', 'restriction', 'nextExpectedOn'] as const).filter((k) => body[k] !== undefined);
	await recordAudit(db, projectId, 'publication.notice_changed', noticeChangedSubject(publication, fields));
	return publication;
}
