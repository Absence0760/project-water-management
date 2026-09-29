// The farmer's farm view (roadmap WP-2.6 API, design docs/design/farmer-view.md
// §9, §10; docs/api.md § Farm). Every route admits the `farmer` role, and
// viewer and above too, so the WUA can preview a farm as its farmer sees it.
// A farmer reaches only the farms linked to them: any other node answers 404,
// the same as a node that doesn't exist. Everything comes from the project's
// *current* publication; a response names no other node (no id, no name)
// beyond the gauges, which are public infrastructure.
import { FARMER_K, FARMER_SERIES_KEYS, fromEpochDay, toEpochDay, type FarmHistoryEntry, type FarmIndex, type FarmProjection, type FarmSeries, type FarmView, type NoticeText, type RestrictionLevel } from '@water-management/engine';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import type { Db } from '../db/tx.js';
import { withUser } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { attachment, collectCsv, dailyCsvLines, dayRange, exportFilename, type DailyColumn } from '../export/csv.js';
import { nodeColumnHeader } from '../export/run-tables.js';
import { farmOutlook } from '../outlooks/publication.js';
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

/** The chart series route's window by default: the year to dataUntil (roadmap WP-2.6; a whole run is too much for a phone). */
export const FARM_SERIES_DEFAULT_DAYS = 365;
/** The widest window one series request answers: ten years, about 40 kB of JSON. */
export const FARM_SERIES_MAX_DAYS = 3653;
const SeriesQuery = z
	.object({ key: z.enum(FARMER_SERIES_KEYS), from: isoDate.optional(), to: isoDate.optional() })
	.refine((q) => !q.from || !q.to || q.from <= q.to, { message: '`from` must not be after `to`', path: ['from'] });

/** How many of the farm's publications its history lists, newest first. */
export const FARM_HISTORY_LIMIT = 12;

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

/**
 * The current publication, with this farm's projection (view null when the
 * farm isn't in it). null without a publication. A projection stored before
 * `dataFrom` existed gets it from the catchment view's `runStart` (the same
 * run's first day), so every reader sees the field.
 */
export async function currentFor(db: Db, projectId: string, nodeId: string): Promise<CurrentFarmRow | null> {
	const { rows } = await db.query<CurrentFarmRow>(
		`SELECT p.run_id, p.published_at, u.display_name AS published_by_name, p.restriction_level, p.restriction_pct,
			p.notice, p.next_expected_on, p.catchment_view,
			CASE WHEN f.view IS NULL OR f.view ? 'dataFrom' THEN f.view
				ELSE f.view || jsonb_build_object('dataFrom', p.catchment_view->'runStart') END AS view
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
 * data-subject export (auth/export.ts) both go through here. Counted as
 * `nodeId`'s own farmer would count it (096), so the WUA's "Preview as
 * farmer" hides the even share where that farmer's page does.
 */
export async function farmerProjection(db: Db, projectId: string, nodeId: string, view: FarmProjection): Promise<FarmProjection> {
	const { rows: h } = await db.query<{ n: number | null }>('SELECT app_other_farm_holders($1, $2) AS n', [projectId, nodeId]);
	if ((h[0]?.n ?? 0) >= FARMER_K - 1) return view;
	return { ...view, river: { ...view.river, equitableFraction: null, aboveBelowShareM3Day: null, cutBeyondShare: false } };
}

export const farmViewRoutes = new Hono<AuthEnv>()
	// The caller's farms in this project, and whether anything is published.
	.get('/:id/farm', async (c) => {
		const id = c.req.param('id');
		return withUser(c.get('userId'), async (db) => {
			const role = await requireRole(db, id, 'farmer');
			const { rows: p } = await db.query<{ name: string; wuaName: string | null }>('SELECT name, wua_name AS "wuaName" FROM project WHERE id = $1', [id]);
			const { rows: pub } = await db.query<{ published_at: Date; restriction_level: RestrictionLevel }>(
				'SELECT published_at, restriction_level FROM run_publication WHERE project_id = $1 AND superseded_at IS NULL',
				[id]
			);
			const body: FarmIndex = {
				project: { id, name: p[0]!.name, wuaName: p[0]!.wuaName },
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
			const { rows: p } = await db.query<{ name: string; timeZone: string; wuaName: string | null }>(
				'SELECT name, time_zone AS "timeZone", wua_name AS "wuaName" FROM project WHERE id = $1',
				[id]
			);
			const farm = await farmerProjection(db, id, nodeId, cur.view);
			const { rows: ctx } = await db.query<{ farms_upstream: number; farms_downstream: number; farm_count: number }>(
				'SELECT farms_upstream, farms_downstream, farm_count FROM app_farm_context($1, $2)',
				[id, nodeId]
			);
			const cv = cur.catchment_view;
			const outlet = cv.sites.find((s) => s.isOutlet) ?? cv.sites[0];
			// Counted to today where the catchment is (project.time_zone, 058), not UTC's day or the phone's.
			const today = localDate(new Date(), p[0]!.timeZone);
			const body: FarmView = {
				project: { id, name: p[0]!.name, wuaName: p[0]!.wuaName, timeZone: p[0]!.timeZone },
				today,
				farm,
				context: { farmsUpstream: ctx[0]?.farms_upstream ?? 0, farmsDownstream: ctx[0]?.farms_downstream ?? 0, farmCount: ctx[0]?.farm_count ?? 0 },
				publication: {
					publishedAt: cur.published_at.toISOString(),
					// null once that account is gone: the page words it in the reader's language.
					publishedBy: cur.published_by_name,
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
				stale: isStale(farm.dataUntil, today),
				// The seasonal outlook the WUA published, this farm's own figures (issue #53 R5, E3), until its season ends there.
				outlook: await farmOutlook(db, id, nodeId, today)
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
	// One of the farm's own daily series from the published run, for a chart:
	// the farm allowlist only (FARMER_SERIES_KEYS), the year to dataUntil by
	// default, never past dataUntil (the forecast days are the projection's).
	.get('/:id/farm/:nodeId/series', async (c) => {
		const { id, nodeId } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			await requireFarm(db, id, nodeId);
			// After the farm check: another farm answers 404 whatever the query.
			const q = SeriesQuery.parse(c.req.query());
			const cur = await currentFor(db, id, nodeId);
			if (!cur?.view) throw notPublished();
			const start = cur.catchment_view.runStart;
			const until = cur.view.dataUntil;
			const to = q.to && q.to < until ? q.to : until;
			const from = q.from ?? fromEpochDay(toEpochDay(to) - (FARM_SERIES_DEFAULT_DAYS - 1));
			const lo = Math.max(0, toEpochDay(from) - toEpochDay(start));
			const hi = toEpochDay(to) - toEpochDay(start);
			if (hi < lo) throw new ApiError(400, `the window is outside the published figures (${start} … ${until})`);
			if (hi - lo + 1 > FARM_SERIES_MAX_DAYS) throw new ApiError(400, `at most ${FARM_SERIES_MAX_DAYS} days at a time; narrow it with ?from=YYYY-MM-DD&to=YYYY-MM-DD`);
			// Postgres arrays are 1-based; the slice keeps a decades-long run on the server.
			const { rows } = await db.query<{ label: string | null; unit: string | null; values: (number | null)[] }>(
				`SELECT meta->>'label' AS label, meta->>'unit' AS unit, "values"[$4:$5] AS "values"
				 FROM run_series WHERE run_id = $1 AND node_id = $2 AND key = $3`,
				[cur.run_id, nodeId, q.key, lo + 1, hi + 1]
			);
			const r = rows[0];
			if (!r) throw notPublished();
			const body: FarmSeries = { key: q.key, label: r.label ?? q.key, unit: r.unit, startDate: fromEpochDay(toEpochDay(start) + lo), values: r.values };
			return c.json(body, 200, { 'Cache-Control': 'no-store' });
		});
	})
	// The farm across the WUA's publications (roadmap WP-2.6): what each one
	// said about this farm, newest first. Only the farm's own figures: never
	// the even share, which is a catchment ratio (design §10.3).
	.get('/:id/farm/:nodeId/history', async (c) => {
		const { id, nodeId } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			await requireFarm(db, id, nodeId);
			const { rows } = await db.query<{ published_at: Date; superseded_at: Date | null; restriction_level: RestrictionLevel; restriction_pct: string | null; view: FarmProjection }>(
				`SELECT p.published_at, p.superseded_at, p.restriction_level, p.restriction_pct, f.view
				 FROM publication_farm f JOIN run_publication p ON p.id = f.publication_id
				 WHERE f.project_id = $1 AND f.node_id = $2
				 ORDER BY p.published_at DESC LIMIT $3`,
				[id, nodeId, FARM_HISTORY_LIMIT]
			);
			const publications: FarmHistoryEntry[] = rows.map((r) => ({
				publishedAt: r.published_at.toISOString(),
				current: r.superseded_at === null,
				dataUntil: r.view.dataUntil,
				season: {
					from: r.view.season.from,
					to: r.view.season.to,
					demandM3: r.view.season.demandM3,
					suppliedM3: r.view.season.suppliedM3,
					fraction: r.view.season.fraction,
					shortDays: r.view.season.shortDays
				},
				damPct: r.view.dam?.pct ?? null,
				model: { headline: r.view.river.headline, band: r.view.river.band },
				restriction: { level: r.restriction_level, pct: r.restriction_pct === null ? null : Number(r.restriction_pct) }
			}));
			return c.json({ publications });
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
