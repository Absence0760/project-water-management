// The farmer's farm view (roadmap WP-2.6 API, design docs/design/farmer-view.md
// §9, §10; docs/api.md § Farm). Every route admits the `farmer` role, and
// viewer and above too, so the WUA can preview a farm as its farmer sees it.
// A farmer reaches only the farms linked to them: any other node answers 404,
// the same as a node that doesn't exist. Everything comes from the project's
// *current* publication; a response names no other node (no id, no name)
// beyond the gauges, which are public infrastructure.
import { FARMER_K, FARMER_SERIES_KEYS, fromEpochDay, toEpochDay, type FarmIndex, type FarmProjection, type FarmView, type NoticeText, type RestrictionLevel } from '@water-management/engine';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import type { Db } from '../db/tx.js';
import { withUser } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { attachment, collectCsv, dailyCsvLines, dayRange, exportFilename, type DailyColumn } from '../export/csv.js';
import { nodeColumnHeader } from '../export/run-tables.js';
import { rank, requireRole, UUID, type Role } from '../projects/access.js';
import { localDate } from '../projects/timeZone.js';
import { isStale } from '../portfolio/status.js';
import type { StoredCatchmentView } from '../publish/publish.js';

const isoDate = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/)
	.refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && fromEpochDay(toEpochDay(s)) === s, 'not a date');
const CsvQuery = z
	.object({ from: isoDate.optional(), to: isoDate.optional() })
	.refine((q) => !q.from || !q.to || q.from <= q.to, { message: '`from` must not be after `to`', path: ['from'] });

const notFound = () => new ApiError(404, 'not found');
const notPublished = () => new ApiError(404, 'not published yet');

/** The farms this caller may open in the project: a farmer's linked farms, or every farm for viewer and above. */
async function reachableFarms(db: Db, projectId: string, role: Role): Promise<{ nodeId: string; name: string }[]> {
	const farmerOnly = rank[role] < rank.viewer;
	const { rows } = await db.query<{ nodeId: string; name: string }>(
		`SELECT id AS "nodeId", name FROM node
		 WHERE project_id = $1 AND kind = 'farm' ${farmerOnly ? 'AND id IN (SELECT app_farm_nodes($1))' : ''}
		 ORDER BY sort_order, name`,
		[projectId]
	);
	return rows;
}

/** 404 unless the caller may open this farm: linked to it (a farmer), or it is a farm of the project (viewer and above). */
async function requireFarm(db: Db, projectId: string, nodeId: string): Promise<Role> {
	const role = await requireRole(db, projectId, 'farmer');
	if (!UUID.test(nodeId)) throw notFound();
	const farmerOnly = rank[role] < rank.viewer;
	const { rows } = await db.query(
		`SELECT 1 FROM node WHERE project_id = $1 AND id = $2 AND kind = 'farm' ${farmerOnly ? 'AND id IN (SELECT app_farm_nodes($1))' : ''}`,
		[projectId, nodeId]
	);
	if (!rows[0]) throw notFound();
	return role;
}

interface CurrentFarmRow {
	run_id: string;
	published_at: Date;
	published_by_name: string | null;
	restriction_level: RestrictionLevel;
	restriction_pct: string | null;
	notice: NoticeText;
	next_expected_on: string | null;
	catchment_view: StoredCatchmentView;
	view: FarmProjection | null;
}

/** The current publication, with this farm's projection (view null when the farm isn't in it). null without a publication. */
export async function currentFor(db: Db, projectId: string, nodeId: string): Promise<CurrentFarmRow | null> {
	const { rows } = await db.query<CurrentFarmRow>(
		`SELECT p.run_id, p.published_at, u.display_name AS published_by_name, p.restriction_level, p.restriction_pct,
			p.notice, p.next_expected_on, p.catchment_view, f.view
		 FROM run_publication p
		 LEFT JOIN app_user u ON u.id = p.published_by
		 LEFT JOIN publication_farm f ON f.publication_id = p.id AND f.node_id = $2
		 WHERE p.project_id = $1 AND p.superseded_at IS NULL`,
		[projectId, nodeId]
	);
	return rows[0] ?? null;
}

/**
 * A farm's stored projection as its farmer is shown it. The aggregate rule
 * (D2, design §10.3): the even share is a catchment ratio, shown only with at
 * least k − 1 other holders. cutBeyondShare is measured against that share,
 * so it goes with it (it would bound K_tot). The farm page and the
 * data-subject export (auth/export.ts) both go through here.
 */
export async function farmerProjection(db: Db, projectId: string, view: FarmProjection): Promise<FarmProjection> {
	const { rows: h } = await db.query<{ n: number | null }>('SELECT app_other_farm_holders($1) AS n', [projectId]);
	if ((h[0]?.n ?? 0) >= FARMER_K - 1) return view;
	return { ...view, river: { ...view.river, equitableFraction: null, aboveBelowShareM3Day: null, cutBeyondShare: false } };
}

export const farmViewRoutes = new Hono<AuthEnv>()
	// The caller's farms in this project, and whether anything is published.
	.get('/:id/farm', async (c) => {
		const id = c.req.param('id');
		return withUser(c.get('userId'), async (db) => {
			const role = await requireRole(db, id, 'farmer');
			const { rows: p } = await db.query<{ name: string }>('SELECT name FROM project WHERE id = $1', [id]);
			const { rows: pub } = await db.query<{ published_at: Date; restriction_level: RestrictionLevel }>(
				'SELECT published_at, restriction_level FROM run_publication WHERE project_id = $1 AND superseded_at IS NULL',
				[id]
			);
			const body: FarmIndex = {
				project: { id, name: p[0]!.name },
				farms: await reachableFarms(db, id, role),
				publication: pub[0] ? { publishedAt: pub[0].published_at.toISOString(), restriction: { level: pub[0].restriction_level } } : null
			};
			return c.json(body);
		});
	})
	// Everything the farm page renders, in one response (design §9).
	.get('/:id/farm/:nodeId', async (c) => {
		const { id, nodeId } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			await requireFarm(db, id, nodeId);
			const cur = await currentFor(db, id, nodeId);
			if (!cur?.view) throw notPublished();
			const { rows: p } = await db.query<{ name: string; timeZone: string }>('SELECT name, time_zone AS "timeZone" FROM project WHERE id = $1', [id]);
			const farm = await farmerProjection(db, id, cur.view);
			const { rows: ctx } = await db.query<{ farms_upstream: number; farms_downstream: number; farm_count: number }>(
				'SELECT farms_upstream, farms_downstream, farm_count FROM app_farm_context($1, $2)',
				[id, nodeId]
			);
			const cv = cur.catchment_view;
			const outlet = cv.sites.find((s) => s.isOutlet) ?? cv.sites[0];
			const body: FarmView = {
				project: { id, name: p[0]!.name },
				farm,
				context: { farmsUpstream: ctx[0]?.farms_upstream ?? 0, farmsDownstream: ctx[0]?.farms_downstream ?? 0, farmCount: ctx[0]?.farm_count ?? 0 },
				publication: {
					publishedAt: cur.published_at.toISOString(),
					publishedBy: cur.published_by_name ?? 'a former member',
					engineVersion: cv.engineVersion,
					restriction: {
						level: cur.restriction_level,
						pct: cur.restriction_pct === null ? null : Number(cur.restriction_pct),
						// Every language the WUA wrote it in: the page picks the reader's (design §7).
						notice: cur.notice
					},
					nextExpectedOn: cur.next_expected_on
				},
				outlet30: { name: outlet?.name ?? '', daysNotMet: outlet?.daysNotMet.last30 ?? 0, days: cv.last30.days },
				// Counted to today where the catchment is (project.time_zone, 058), not UTC's day.
				stale: isStale(farm.dataUntil, localDate(new Date(), p[0]!.timeZone))
			};
			return c.json(body);
		});
	})
	// "Who can see my farm" (design §10.2): names and roles, never emails.
	.get('/:id/farm/:nodeId/access', async (c) => {
		const { id, nodeId } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			await requireFarm(db, id, nodeId);
			const { rows } = await db.query<{ display_name: string; role: Role; is_you: boolean }>(
				'SELECT display_name, role, is_you FROM app_farm_access($1, $2)',
				[id, nodeId]
			);
			return c.json({ people: rows.map((r) => ({ displayName: r.display_name, role: r.role, you: r.is_you })) });
		});
	})
	// The farm's own daily figures from the published run: the farm allowlist
	// only (FARMER_SERIES_KEYS), with the export CSV's rules (export/csv.ts).
	.get('/:id/farm/:nodeId/export.csv', async (c) => {
		const { id, nodeId } = c.req.param();
		const q = CsvQuery.parse(c.req.query());
		return withUser(c.get('userId'), async (db) => {
			await requireFarm(db, id, nodeId);
			const cur = await currentFor(db, id, nodeId);
			if (!cur?.view) throw notPublished();
			const { rows } = await db.query<{ key: string; label: string | null; unit: string | null; values: (number | null)[] }>(
				`SELECT key, meta->>'label' AS label, meta->>'unit' AS unit, "values"
				 FROM run_series WHERE run_id = $1 AND node_id = $2 AND key = ANY($3::text[])`,
				[cur.run_id, nodeId, FARMER_SERIES_KEYS]
			);
			const byKey = new Map(rows.map((r) => [r.key, r]));
			const columns: DailyColumn[] = FARMER_SERIES_KEYS.flatMap((k) => {
				const r = byKey.get(k);
				return r ? [{ header: nodeColumnHeader(k, r.label ?? k, r.unit, 'farm'), values: r.values }] : [];
			});
			if (!columns.length) throw notPublished();
			const start = cur.catchment_view.runStart;
			// To dataUntil, never into forecast days past it (the projection stops there too).
			const to = q.to && q.to < cur.view.dataUntil ? q.to : cur.view.dataUntil;
			const range = dayRange(start, Math.max(...columns.map((col) => col.values.length)), q.from, to);
			if (!range) throw new ApiError(400, `the window is outside the published figures (${start} … ${cur.view.dataUntil})`);
			const body = collectCsv(dailyCsvLines(start, columns, range));
			if (body === null) throw new ApiError(413, 'export too large; narrow it with ?from=YYYY-MM-DD&to=YYYY-MM-DD');
			const { rows: p } = await db.query<{ name: string; timeZone: string }>('SELECT name, time_zone AS "timeZone" FROM project WHERE id = $1', [id]);
			return c.body(body, 200, {
				'Content-Type': 'text/csv; charset=utf-8',
				'Content-Disposition': attachment(exportFilename(p[0]!.name, [cur.view.name, 'daily'], 'csv', p[0]!.timeZone)),
				'Cache-Control': 'no-store'
			});
		});
	});
