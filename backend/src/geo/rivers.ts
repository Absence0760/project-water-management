// The river network on the catchment map (issue #345; docs/maps.md § River
// network, docs/api.md § Catchment map):
//
//   GET  /projects/:id/map/rivers?bbox=minLon,minLat,maxLon,maxLat   the reaches whose box meets the bbox (viewer)
//   POST /projects/:id/map/rivers/add                                one reach added as the project's river feature (editor)
//
// It reads river_reference (171), the network the operator loads (the repo
// ships a synthetic one; the real one is HydroRIVERS, docs/maps.md §
// Sources). The table is global, but the routes are a project's: the caller
// must be a member, checked under RLS (withUser). The layer proposes; the
// modeller decides: a reach becomes one of the project's `river` features
// only through `add`, one reach at a time, with its source copied into the
// feature's description and its id into `ref`, so the gauges-off-the-rivers
// check (frontend mapChecks.ts) measures against it like any drawn river.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser, type Db } from '../db/tx.js';
import { recordAudit } from '../history/record.js';
import { readJson } from '../http/body.js';
import { ApiError } from '../http/errors.js';
import { requireRole } from '../projects/access.js';
import { FEATURE_NAME_MAX, FEATURE_PROPERTIES, type Geometry } from './geojson.js';
import { BboxQuery } from './quaternaryLayer.js';
import { loadFeature, toFeature } from './routes.js';

/** The committed synthetic network's dataset label. */
export const SYNTHETIC_RIVERS = 'synthetic';
/** The most reaches one answer carries, the highest Strahler orders first; past it `truncated` says so. */
export const RIVER_LAYER_MAX = 1000;
/** The widest bbox asked for, in degrees each way: a catchment's surroundings (a real network has thousands of reaches a degree). */
export const RIVER_BBOX_MAX_DEG = 2;
/** The `ref` a reach added to a project carries: the dataset and reach id, so the layer knows it is there and it can't be added twice. */
export const riverRef = (dataset: string, reachId: number | string) => `river-network:${dataset}:${reachId}`;

export interface RiverReach {
	dataset: string;
	reachId: number;
	name: string;
	strahler: number | null;
	upstreamKm2: number | null;
	lengthKm: number | null;
	dischargeM3s: number | null;
	/** True for the repo's invented network: never real rivers. */
	synthetic: boolean;
	source: string;
	geometry: Geometry;
	/** The project's river feature made from this reach, if it was added; null otherwise. */
	featureId: string | null;
}

interface ReachRow {
	dataset: string;
	reach_id: string;
	name: string;
	strahler: number | null;
	upstream_km2: number | null;
	length_km: number | null;
	discharge_m3s: number | null;
	source: string;
	geometry: Geometry;
}

const toReach = (r: ReachRow, featureId: string | null): RiverReach => ({
	dataset: r.dataset,
	reachId: Number(r.reach_id),
	name: r.name,
	strahler: r.strahler,
	upstreamKm2: r.upstream_km2,
	lengthKm: r.length_km,
	dischargeM3s: r.discharge_m3s,
	synthetic: r.dataset === SYNTHETIC_RIVERS,
	source: r.source,
	geometry: r.geometry,
	featureId
});

export async function riverDatasets(db: Db): Promise<{ dataset: string; count: number }[]> {
	const { rows } = await db.query<{ dataset: string; count: number }>('SELECT dataset, count(*)::integer AS count FROM river_reference GROUP BY dataset ORDER BY dataset');
	return rows;
}

export const AddReach = z
	.object({
		dataset: z.string().min(1).max(50),
		reachId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
	})
	.strict();

const fmt = (n: number) => (n >= 100 ? Math.round(n).toLocaleString('en-ZA') : String(Math.round(n * 10) / 10));

/** The description a reach added to a project carries: where it came from, and its order and upstream area when known. */
export function reachDescription(r: Pick<RiverReach, 'reachId' | 'strahler' | 'upstreamKm2' | 'source'>): string {
	const facts = [r.strahler !== null ? `Strahler order ${r.strahler}` : null, r.upstreamKm2 !== null ? `${fmt(r.upstreamKm2)} km² upstream` : null].filter(Boolean).join(', ');
	return `From the river network, reach ${r.reachId}${facts ? ` (${facts})` : ''}: ${r.source}`.slice(0, FEATURE_PROPERTIES.description);
}

export const riverRoutes = new Hono<AuthEnv>()
	.get('/:id/map/rivers', async (c) => {
		const { bbox } = BboxQuery.parse(c.req.query());
		if (bbox.e - bbox.w > RIVER_BBOX_MAX_DEG || bbox.n - bbox.s > RIVER_BBOX_MAX_DEG)
			throw new ApiError(400, `Ask for at most ${RIVER_BBOX_MAX_DEG}° each way around the catchment.`);
		const id = c.req.param('id');
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'viewer');
			// The bounding-box index (river_reference_bbox_idx) narrows it; the biggest rivers come first, so a cut keeps them.
			const { rows } = await db.query<ReachRow>(
				`SELECT dataset, reach_id, name, strahler, upstream_km2, length_km, discharge_m3s, source, geometry FROM river_reference
				 WHERE max_lon >= $1 AND min_lon <= $3 AND max_lat >= $2 AND min_lat <= $4
				 ORDER BY strahler DESC NULLS LAST, upstream_km2 DESC NULLS LAST, dataset, reach_id
				 LIMIT $5`,
				[bbox.w, bbox.s, bbox.e, bbox.n, RIVER_LAYER_MAX + 1]
			);
			const { rows: added } = await db.query<{ id: string; ref: string }>(
				`SELECT id, properties ->> 'ref' AS ref FROM map_feature WHERE project_id = $1 AND kind = 'river' AND properties ->> 'ref' LIKE 'river-network:%'`,
				[id]
			);
			const byRef = new Map(added.map((a) => [a.ref, a.id]));
			return c.json({
				bbox: [bbox.w, bbox.s, bbox.e, bbox.n],
				reaches: rows.slice(0, RIVER_LAYER_MAX).map((r) => toReach(r, byRef.get(riverRef(r.dataset, r.reach_id)) ?? null)),
				truncated: rows.length > RIVER_LAYER_MAX,
				datasets: await riverDatasets(db)
			});
		});
	})
	.post('/:id/map/rivers/add', async (c) => {
		const body = AddReach.parse(await readJson(c));
		const id = c.req.param('id');
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			const { rows } = await db.query<ReachRow>(
				'SELECT dataset, reach_id, name, strahler, upstream_km2, length_km, discharge_m3s, source, geometry FROM river_reference WHERE dataset = $1 AND reach_id = $2',
				[body.dataset, body.reachId]
			);
			if (!rows[0]) throw new ApiError(404, 'That reach is not in the loaded river network.');
			const reach = toReach(rows[0], null);
			const ref = riverRef(reach.dataset, reach.reachId);
			// Two adds of the same reach at once: the second waits here, then sees the first's feature.
			await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${id}|${ref}`]);
			const { rows: dup } = await db.query<{ id: string }>(`SELECT id FROM map_feature WHERE project_id = $1 AND kind = 'river' AND properties ->> 'ref' = $2`, [id, ref]);
			if (dup[0]) throw new ApiError(409, 'That reach is on the map already.');
			const name = (reach.name || `Reach ${reach.reachId}`).slice(0, FEATURE_NAME_MAX);
			const properties = { description: reachDescription(reach), ref };
			const { rows: ins } = await db.query<{ id: string }>(
				`INSERT INTO map_feature (project_id, kind, name, geometry, properties, created_by)
				 VALUES ($1, 'river', $2, $3, $4, app_current_user_id()) RETURNING id`,
				[id, name, JSON.stringify(reach.geometry), JSON.stringify(properties)]
			);
			const feature = toFeature(await loadFeature(db, id, ins[0]!.id));
			await recordAudit(db, id, 'map.feature_created', { featureId: feature.id, kind: 'river', name, nodeId: null, from: 'river_network', dataset: reach.dataset, reachId: reach.reachId });
			return c.json({ feature }, 201);
		});
	});
