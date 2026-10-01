// The rain feed from the map's catchment boundary in one action (issue #326
// B-rain; docs/api.md § Data feeds, docs/maps.md § Rain from the boundary).
//
//   GET  /projects/:id/feeds/chirps/from-boundary   (editor) the proposal: the
//        CHIRPS cells the boundary covers, area-weighted (boundaryCells.ts),
//        the boundary it came from, and what applying it would do.
//   POST /projects/:id/feeds/chirps/from-boundary   (owner, as every feed
//        change) apply it: create the CHIRPS feed with those cells, or give an
//        existing one them, recorded in the History naming the boundary.
//
// The map proposes, the modeller decides: nothing changes until Apply, and
// Apply names the boundary version it was shown (its updatedAt), so a
// boundary redrawn in between is refused rather than applied unseen.
//
// A feed never splices two areas into one record: the days already in a
// series were averaged over its old cells, so new cells go to a feed whose
// series holds nothing yet, or to a new feed writing a separate series.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import type { Geometry } from '../geo/geojson.js';
import { withUser, type Db } from '../db/tx.js';
import { readJson } from '../http/body.js';
import { ApiError } from '../http/errors.js';
import { recordAudit } from '../history/record.js';
import { requireRole } from '../projects/access.js';
import { boundaryCells, type BoundaryCell } from './boundaryCells.js';
import { type BoundaryMark, FeedInput, type GridConfig } from './config.js';
import { attachSlot, conflict, feedSubject, versionCheck } from './routes.js';
import { createFeed, getFeed, listFeeds, targetSeries, updateFeed, type FeedMeta } from './store.js';

/** The series a boundary feed writes: CHIRPS as the reference rainfall, never the catchment rain itself (docs/model.md). */
export const BOUNDARY_TARGET_KIND = 'rain_chirps_mm';
/** The name of a separate series for the boundary's rain, when the default one already holds a record ("CHIRPS boundary", "… 2"). */
export const BOUNDARY_SERIES_NAME = 'CHIRPS boundary';

interface BoundaryRow {
	id: string;
	name: string;
	geometry: Geometry;
	area_m2: number;
	updated_at: Date;
}

async function loadBoundary(db: Db, projectId: string): Promise<BoundaryRow> {
	const { rows } = await db.query<BoundaryRow>(
		`SELECT id, name, geometry, area_m2, updated_at FROM map_feature WHERE project_id = $1 AND kind = 'catchment_boundary'`,
		[projectId]
	);
	if (!rows[0]) {
		throw new ApiError(409, 'the project has no catchment boundary on its map: draw or upload one on the Map tab first', { code: 'no_boundary' });
	}
	return rows[0];
}

const mark = (b: BoundaryRow): BoundaryMark => ({
	featureId: b.id,
	name: b.name,
	updatedAt: b.updated_at.toISOString(),
	areaKm2: Math.round(b.area_m2 / 1e3) / 1e3
});

function cellsOf(b: BoundaryRow) {
	const r = boundaryCells(b.geometry);
	if ('problem' in r) throw new ApiError(409, r.problem.charAt(0).toUpperCase() + r.problem.slice(1), { code: 'boundary_cells' });
	return r;
}

/** A feed's listed cells as the feed config keeps them (weight only; the share is the proposal's to show). */
const configCells = (cells: readonly BoundaryCell[]) => cells.map(({ lat, lon, weight }) => ({ lat, lon, weight }));

/** Whether the feed already reads this version of the boundary. */
const readsBoundary = (f: Pick<FeedMeta, 'source' | 'config'>, b: BoundaryRow) => {
	const m = f.source === 'chirps' ? (f.config as GridConfig).boundary : undefined;
	return !!m && m.featureId === b.id && m.updatedAt === b.updated_at.toISOString();
};

/** The CHIRPS feeds a boundary could go to, and the name of a free series of the target kind. */
async function choices(db: Db, projectId: string, b: BoundaryRow) {
	const feeds = (await listFeeds(db, projectId)).filter((f) => f.source === 'chirps');
	const current = feeds.find((f) => readsBoundary(f, b)) ?? null;
	// A feed may take new cells only while its series holds nothing (no record to splice onto).
	const open: FeedMeta[] = [];
	for (const f of feeds) if (!(await targetSeries(db, projectId, f.targetKind, f.targetName))?.filled) open.push(f);
	return { feeds, current, open };
}

/** The first target name for a new feed whose series is empty and that no feed writes: '' (the default series) if it can, else "CHIRPS boundary", "… 2". */
async function freeName(db: Db, projectId: string, feeds: readonly FeedMeta[]): Promise<string> {
	const taken = new Set(feeds.filter((f) => f.targetKind === BOUNDARY_TARGET_KIND).map((f) => f.targetName));
	for (let i = 1; i < 100; i++) {
		const name = i === 1 ? '' : i === 2 ? BOUNDARY_SERIES_NAME : `${BOUNDARY_SERIES_NAME} ${i - 1}`;
		if (taken.has(name)) continue;
		if (!(await targetSeries(db, projectId, BOUNDARY_TARGET_KIND, name))?.filled) return name;
	}
	throw new ApiError(409, 'no free series name for the boundary’s rain');
}

const ApplyBody = z
	.object({
		/** The boundary the proposal was made from, and its version: a boundary changed since is refused. */
		featureId: z.uuid(),
		updatedAt: z.iso.datetime({ offset: true }),
		/** Give these cells to this CHIRPS feed (its series must hold nothing yet); absent: attach a new feed. */
		feedId: z.uuid().optional(),
		/** A new feed's series name (rain_chirps_mm); absent: the one the proposal named. */
		targetName: z.string().trim().max(100).optional()
	})
	.strict();

export const feedFromBoundaryRoutes = new Hono<AuthEnv>()
	.get('/:id/feeds/chirps/from-boundary', async (c) =>
		withUser(c.get('userId'), async (db) => {
			const id = c.req.param('id');
			const role = await requireRole(db, id, 'editor');
			const b = await loadBoundary(db, id);
			const r = cellsOf(b);
			const { current, open, feeds } = await choices(db, id, b);
			// What Apply would do: nothing (already read), give the cells to a feed whose series is empty, or attach one.
			const apply = current
				? { action: 'none' as const, feedId: current.id }
				: open[0]
					? { action: 'update' as const, feedId: open[0].id, targetKind: open[0].targetKind, targetName: open[0].targetName }
					: { action: 'create' as const, targetKind: BOUNDARY_TARGET_KIND, targetName: await freeName(db, id, feeds) };
			return c.json({
				boundary: mark(b),
				cells: r.cells,
				rows: r.rows,
				cellsKm2: r.cellsKm2,
				insideKm2: r.insideKm2,
				method: `area-weighted over ${r.cells.length} CHIRPS v3 cell${r.cells.length === 1 ? '' : 's'} (0.05°), each by the share of it inside the boundary`,
				apply,
				canApply: role === 'owner'
			});
		})
	)
	.post('/:id/feeds/chirps/from-boundary', async (c) => {
		const body = ApplyBody.parse(await readJson(c));
		const id = c.req.param('id');
		const out = await withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'owner');
			const b = await loadBoundary(db, id);
			if (b.id !== body.featureId || b.updated_at.getTime() !== new Date(body.updatedAt).getTime()) {
				throw new ApiError(409, 'the catchment boundary changed since this proposal: look at the new proposal before applying it', { code: 'boundary_changed' });
			}
			const r = cellsOf(b);
			const from = { featureId: b.id, name: b.name };
			if (body.feedId) {
				const cur = await getFeed(db, id, body.feedId);
				if (!cur) throw new ApiError(404, 'not found');
				if (cur.source !== 'chirps') throw new ApiError(409, 'only a CHIRPS daily rainfall feed reads the boundary’s cells');
				if ((await targetSeries(db, id, cur.targetKind, cur.targetName))?.filled) {
					throw new ApiError(
						409,
						'the feed’s series already holds days averaged over its old cells, and a feed never splices two areas into one record: attach a new feed for the boundary instead, into a separate series',
						{ code: 'series_area' }
					);
				}
				const old = cur.config as GridConfig;
				const input = FeedInput.parse({
					source: 'chirps',
					config: {
						cells: configCells(r.cells),
						boundary: mark(b),
						...(old.product !== undefined ? { product: old.product } : {}),
						...(old.startDate !== undefined ? { startDate: old.startDate } : {}),
						...(old.staleAfterDays !== undefined ? { staleAfterDays: old.staleAfterDays } : {})
					},
					targetKind: cur.targetKind,
					targetName: cur.targetName,
					schedule: cur.schedule,
					enabled: cur.enabled
				});
				// Same product, same series: nothing for the version check to ask (its series is empty besides).
				const { input: checked } = await versionCheck(db, id, input, false);
				if (!(await updateFeed(db, id, cur.id, checked).catch(conflict))) throw new ApiError(404, 'not found');
				await recordAudit(db, id, 'feed.configured', { ...feedSubject(cur.id, 'changed', checked), boundary: from, cells: r.cells.length });
				return { feed: await getFeed(db, id, cur.id), created: false };
			}
			await attachSlot(db, id);
			const targetName = body.targetName ?? (await freeName(db, id, (await listFeeds(db, id)).filter((f) => f.source === 'chirps')));
			if ((await targetSeries(db, id, BOUNDARY_TARGET_KIND, targetName))?.filled) {
				throw new ApiError(
					409,
					'that series already holds a record; the boundary’s rain goes into a series of its own, so the two can be compared rather than spliced',
					{ code: 'series_area' }
				);
			}
			const input = FeedInput.parse({
				source: 'chirps',
				config: { cells: configCells(r.cells), boundary: mark(b) },
				targetKind: BOUNDARY_TARGET_KIND,
				targetName
			});
			const { input: checked } = await versionCheck(db, id, input, true);
			const fid = await createFeed(db, id, checked).catch(conflict);
			await recordAudit(db, id, 'feed.configured', { ...feedSubject(fid, 'created', checked), boundary: from, cells: r.cells.length });
			return { feed: await getFeed(db, id, fid), created: true };
		});
		return c.json({ feed: out.feed }, out.created ? 201 : 200);
	});
