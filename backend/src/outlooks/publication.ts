// A seasonal outlook published to farmers (issue #53 R5, farmer-view ask E3;
// 103_outlook_triggers_publication.sql, docs/api.md § Seasonal outlooks).
// The WUA chooses one level of a complete outlook and publishes it; every
// farm of the project gets its own figures at that level (the engine's
// farmOutlookProjection), stored with the publication, which the farm page
// reads back (farms/view.ts). One current publication per project: a new one
// ends the last, and the WUA can withdraw it. The app never picks the level.
import { farmOutlookProjection, type FarmOutlookProjection, type SeasonalOutlook } from '@water-management/engine';
import { z } from 'zod';
import type { Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';

export const PublishOutlookBody = z.object({ levelId: z.string().min(1).max(8) }).strict();

export interface OutlookPublicationRow {
	id: string;
	outlookId: string | null;
	level: { id: string; label: string };
	decisionDate: string;
	seasonEnd: string;
	reviewDate: string | null;
	engineVersion: string;
	publishedBy: string | null;
	publishedAt: string;
	endedAt: string | null;
	/** Farms with figures in it. */
	farms: number;
}

const pubSelect = `SELECT p.id, p.outlook_id AS "outlookId", jsonb_build_object('id', p.level_id, 'label', p.level_label) AS level,
	to_char(p.decision_date, 'YYYY-MM-DD') AS "decisionDate", to_char(p.season_end, 'YYYY-MM-DD') AS "seasonEnd",
	to_char(p.review_date, 'YYYY-MM-DD') AS "reviewDate", p.engine_version AS "engineVersion", u.display_name AS "publishedBy",
	p.published_at AS "publishedAt", p.ended_at AS "endedAt",
	(SELECT count(*)::int FROM outlook_publication_farm f WHERE f.publication_id = p.id) AS farms
	FROM outlook_publication p LEFT JOIN app_user u ON u.id = p.published_by`;

/** The project's current outlook publication, or null (RLS: every member). */
export async function currentOutlookPublication(db: Db, projectId: string): Promise<OutlookPublicationRow | null> {
	const { rows } = await db.query<OutlookPublicationRow>(`${pubSelect} WHERE p.project_id = $1 AND p.ended_at IS NULL`, [projectId]);
	return rows[0] ?? null;
}

/** Today where the catchment is (project.time_zone, 058). */
async function projectToday(db: Db, projectId: string): Promise<string> {
	const { rows } = await db.query<{ today: string }>(`SELECT to_char((now() AT TIME ZONE time_zone)::date, 'YYYY-MM-DD') AS today FROM project WHERE id = $1`, [projectId]);
	return rows[0]!.today;
}

/**
 * Publish one level of a complete outlook to the project's farmers, as the
 * transaction's user (an editor): end the current publication, write the new
 * one (its guard copies the season, review date and engine from the
 * outlook), and each farm's projection. Refused: an outlook that isn't this
 * project's (404) or isn't complete (409), a level it doesn't have (422) or
 * that didn't run (409), one computed before per-farm figures (engine <
 * 1.18.0: run it again, 409), and a season already over (409).
 */
export async function publishOutlook(db: Db, projectId: string, outlookId: string, levelId: string): Promise<OutlookPublicationRow> {
	const { rows } = await db.query<{ status: string; result: SeasonalOutlook | null; reviewDate: string | null; seasonEnd: string }>(
		`SELECT status, result, to_char(review_date, 'YYYY-MM-DD') AS "reviewDate", to_char(season_end, 'YYYY-MM-DD') AS "seasonEnd"
		 FROM seasonal_outlook WHERE project_id = $1 AND id = $2`,
		[projectId, outlookId]
	);
	const o = rows[0];
	if (!o) throw new ApiError(404, 'not found');
	if (o.status !== 'complete' || !o.result) throw new ApiError(409, 'the outlook is still running: publish it once it is complete');
	if (o.seasonEnd < (await projectToday(db, projectId))) throw new ApiError(409, `the outlook's season ended on ${o.seasonEnd}: there is nothing left of it to publish`);
	const { rows: farms } = await db.query<{ id: string }>(`SELECT id FROM node WHERE project_id = $1 AND kind = 'farm' ORDER BY sort_order, name, id`, [projectId]);
	const views: { nodeId: string; view: FarmOutlookProjection }[] = [];
	for (const f of farms) {
		const got = farmOutlookProjection(o.result, levelId, f.id, o.reviewDate);
		if (got.problem !== null) {
			if (got.problem === 'noSuchLevel') throw new ApiError(422, `the outlook has no level ${levelId}`);
			if (got.problem === 'levelNotRun') throw new ApiError(409, 'that level did not run, so there are no figures to publish for it');
			throw new ApiError(409, 'this outlook was computed before farms had figures of their own: run it again to publish it');
		}
		views.push({ nodeId: f.id, view: got.projection });
	}
	await db.query(`UPDATE outlook_publication SET ended_at = now() WHERE project_id = $1 AND ended_at IS NULL`, [projectId]);
	const { rows: pub } = await db.query<{ id: string }>(
		`INSERT INTO outlook_publication (project_id, outlook_id, level_id, level_label, decision_date, season_end, engine_version)
		 SELECT project_id, id, $3, $3, decision_date, season_end, engine_version FROM seasonal_outlook WHERE project_id = $1 AND id = $2 RETURNING id`,
		[projectId, outlookId, levelId]
	);
	const pubId = pub[0]!.id;
	for (const v of views) {
		await db.query(`INSERT INTO outlook_publication_farm (publication_id, project_id, node_id, view) VALUES ($1, $2, $3, $4)`, [pubId, projectId, v.nodeId, JSON.stringify(v.view)]);
	}
	return (await currentOutlookPublication(db, projectId))!;
}

/** End the current publication without a successor; 404 when there is none. */
export async function withdrawOutlookPublication(db: Db, projectId: string): Promise<OutlookPublicationRow> {
	const { rows } = await db.query<{ id: string }>(`UPDATE outlook_publication SET ended_at = now() WHERE project_id = $1 AND ended_at IS NULL RETURNING id`, [projectId]);
	if (!rows[0]) throw new ApiError(404, 'no outlook is published');
	const { rows: got } = await db.query<OutlookPublicationRow>(`${pubSelect} WHERE p.id = $1`, [rows[0].id]);
	return got[0]!;
}

/**
 * The farm page's outlook (farms/view.ts): this farm's figures in the
 * current publication, with when it was published; null when there is none,
 * the farm has no row in it, or its season has ended by `today` (the
 * project's own day, project.time_zone). RLS: a farmer reads
 * only their own farms' rows.
 */
export async function farmOutlook(db: Db, projectId: string, nodeId: string, today: string): Promise<(FarmOutlookProjection & { publishedAt: string }) | null> {
	const { rows } = await db.query<{ view: FarmOutlookProjection; publishedAt: Date }>(
		`SELECT f.view, p.published_at AS "publishedAt" FROM outlook_publication p
		 JOIN outlook_publication_farm f ON f.publication_id = p.id AND f.node_id = $2
		 WHERE p.project_id = $1 AND p.ended_at IS NULL AND p.season_end >= $3::date`,
		[projectId, nodeId, today]
	);
	const r = rows[0];
	return r ? { ...r.view, publishedAt: new Date(r.publishedAt).toISOString() } : null;
}
