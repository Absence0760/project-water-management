// Sub-catchments from clicks on the rivers (docs/maps.md § Sub-catchments
// from clicks, docs/api.md § Delineation). Each click is an outlet on a river;
// its piece is its incremental catchment: the land whose water reaches it
// before any other click. The lowest click (the one most water drains
// through) owns everything else above it.
//
//   POST /projects/:id/map/subcatchments        the pieces for these clicks (editor; nothing stored)
//   POST /projects/:id/map/subcatchments/save   the same, saved as "other" polygons, one per piece (editor)
//
// The preview stores nothing: the map redraws the pieces after every click.
// Save never takes a geometry from the request: it routes the same clicks
// again and saves what the elevation model gives. Both count against the
// per-account cap on elevation-model work (delineation/attempt.ts) before
// reading the DEM, and run between two short transactions, never holding a
// database connection while they route flow, as delineation does.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser } from '../db/tx.js';
import type { Geometry, Position } from '../geo/geojson.js';
import { loadFeature, toFeature } from '../geo/routes.js';
import { recordAudit } from '../history/record.js';
import { readJson } from '../http/body.js';
import { ApiError } from '../http/errors.js';
import { logEvent } from '../logging/logEvent.js';
import { safeError } from '../logging/safeError.js';
import { requireRole } from '../projects/access.js';
import { beginDemAttempt, finishDemAttempt } from './attempt.js';
import { DelineationRefused, type LargerChannel } from './delineate.js';
import { ConfluenceAmbiguity, ReachChoiceBody, reachFor, ReachNotNear, type NearReach, type ReachAtClick } from './reach.js';
import { configuredDem } from './dem.js';
import { delineateUnits, type PlacedBy, type Subcatchments } from './subcatchments.js';

/** Clicks one request may carry: Start from the map's cap on points. */
export const CLICKS_MAX = 50;

const Lon = z.number().finite().min(-180).max(180);
const Lat = z.number().finite().min(-90).max(90);
/** A click; `reach` is the river reach it means at a confluence (one of a 422 `confluence`'s choices). */
const Click = z.object({ lon: Lon, lat: Lat, reach: ReachChoiceBody.optional() }).strict();
export const ClicksBody = z.object({ clicks: z.array(Click).min(1).max(CLICKS_MAX) }).strict();

type Poly = Extract<Geometry, { type: 'Polygon' }>;

export interface ClickPiece {
	/** The click's index in the request. */
	click: number;
	/** The click, snapped onto the channel (the cell most water drains through nearby). */
	point: Position;
	/** How far the click moved to the channel (m). */
	snapDistanceM: number | null;
	/** The click whose piece this one's water flows into next; null for the lowest click. */
	drainsInto: number | null;
	/** Its incremental catchment; null when it is open, or its cells couldn't be outlined as a valid polygon (the area still counts them). */
	geometry: Poly | null;
	/** The piece's own geodesic area (m²); null when it is open. */
	areaM2: number | null;
	/** Everything upstream of the click, its own piece included (m²); null when it, or a piece above it, is open. */
	totalAreaM2: number | null;
	/** Of its own area, what drains into pans (pans.ts, start-11; m²): reported, not taken out. Null when it is open. */
	nonContributingM2: number | null;
	/**
	 * Its catchment runs past the window routed around the clicks (or the DEM's data), so it has no whole piece:
	 * an inflow point, the water from above it entering the pieces below as an inflow.
	 */
	open: boolean;
	/** How the click was put on the channel: matched to its nearby river reach's upstream area, or snapped to the most-drained cell near it. */
	placedBy: 'matched' | 'snapped' | 'junction';
	/** The river reach it was matched to. */
	reach: { dataset: string; reachId: number; upstreamKm2: number } | null;
	/** Snapped beside a much larger channel: that channel, to offer instead (the click stays where it snapped). */
	larger: LargerChannel | null;
	/** A river reach was near but no channel near the click matched its area: the reach (it may be on another stream). */
	unmatched: { dataset: string; reachId: number; upstreamKm2: number } | null;
}

export interface ClickPieces {
	/** One per click kept, in click order. */
	pieces: ClickPiece[];
	/** Clicks that are not pieces, with why (on another river, or on the same spot as another click). */
	dropped: { click: number; reason: string }[];
	/** The lowest click's index: it owns what drains to it through no other click. */
	lowest: number;
	cellSizeM: number;
	dataset: { label: string; fingerprint: string };
	method: string;
	methodVersion: string;
}

/** A click is a point, so only these three placements reach it (no polygon, no delineated outlet, no editor's choice of a larger channel). */
const clickPlacedBy = (h: PlacedBy | undefined): ClickPiece['placedBy'] => (h === 'matched' || h === 'junction' ? h : 'snapped');

/** The partition's answer in clicks: the lowest click's piece is its "rest". Pure. */
export function toClickPieces(r: Subcatchments, reaches: readonly ((NearReach & Partial<Pick<ReachAtClick, 'reachKm2'>>) | null)[] = []): ClickPieces {
	const reachOf = (i: number) => {
		const x = reaches[i];
		// The reach's own area, as the River network layer shows it (not its area at the click, which the point was matched to).
		return x ? { dataset: x.dataset, reachId: x.reachId, upstreamKm2: x.reachKm2 ?? x.upstreamKm2 } : null;
	};
	const lowest = Number(r.outlet.id);
	const index = (id: string | null) => (id === null ? lowest : Number(id));
	const all = [
		{
			click: lowest,
			point: r.outlet.point,
			snapDistanceM: r.outlet.snapDistanceM,
			drainsInto: null,
			geometry: r.rest.geometry,
			areaM2: r.rest.areaM2,
			totalAreaM2: r.catchment.areaM2,
			nonContributingM2: r.rest.nonContributingM2 as number | null,
			open: !!r.rest.open,
			placedBy: clickPlacedBy(r.outlet.placedBy),
			reach: r.outlet.placedBy === 'matched' || r.outlet.placedBy === 'junction' ? reachOf(lowest) : null,
			larger: r.outlet.larger ?? null,
			unmatched: r.outlet.unmatched ? reachOf(lowest) : null
		},
		...r.units.map((u) => ({
			click: Number(u.id),
			point: u.point,
			snapDistanceM: u.snapDistanceM,
			drainsInto: index(u.drainsInto) as number | null,
			geometry: u.geometry,
			areaM2: u.areaM2,
			totalAreaM2: u.totalAreaM2,
			nonContributingM2: u.nonContributingM2 as number | null,
			open: !!u.open,
			placedBy: clickPlacedBy(u.placedBy),
			reach: u.placedBy === 'matched' || u.placedBy === 'junction' ? reachOf(Number(u.id)) : null,
			larger: u.larger ?? null,
			unmatched: u.unmatched ? reachOf(Number(u.id)) : null
		}))
	];
	// A total is known only when nothing above the click is open: the open pieces' areas count only what was routed.
	const unknown = new Set<number>();
	for (const p of all) {
		if (!p.open) continue;
		for (let k: number | null = p.click, guard = 0; k !== null && guard <= all.length; guard++) {
			unknown.add(k);
			k = all.find((x) => x.click === k)!.drainsInto;
		}
	}
	const pieces: ClickPiece[] = all
		.map((p) => ({
			...p,
			geometry: p.open ? null : p.geometry,
			areaM2: p.open ? null : p.areaM2,
			nonContributingM2: p.open ? null : p.nonContributingM2,
			totalAreaM2: unknown.has(p.click) ? null : p.totalAreaM2
		}))
		.sort((a, b) => a.click - b.click);
	return {
		pieces,
		dropped: r.dropped.map((d) => ({ click: Number(d.id), reason: d.reason })).sort((a, b) => a.click - b.click),
		lowest,
		cellSizeM: r.cellSizeM,
		dataset: { label: r.dataset.label, fingerprint: r.dataset.fingerprint },
		method: r.method,
		methodVersion: r.methodVersion
	};
}

/** A piece's name: its click's number, as the map's badge shows it. */
export const pieceName = (click: number) => `Sub-catchment ${click + 1}`;

/** Count the attempt (editor only), route the clicks, free the attempt. Refusals are 422 with the sentence. */
async function route(userId: string, projectId: string, clicks: readonly z.infer<typeof Click>[]): Promise<ClickPieces> {
	const { attempt, reaches, junctions } = await withUser(userId, async (db) => {
		await requireRole(db, projectId, 'editor');
		// Each click's nearest river reach, for matching it to the reach's upstream area (issue #374).
		const reaches: (ReachAtClick | null)[] = [];
		const junctions: (Awaited<ReturnType<typeof reachFor>>['junction'])[] = [];
		for (const [i, c] of clicks.entries()) {
			try {
				const f = await reachFor(db, [c.lon, c.lat], c.reach ?? null);
				reaches.push(f.reach);
				junctions.push(f.junction);
			} catch (err) {
				// At a confluence the editor picks the river (the click's reach), naming the click so the client asks about that one.
				if (err instanceof ConfluenceAmbiguity) throw new ApiError(422, `Click ${i + 1}: ${err.message}`, { reason: 'confluence', click: i, choices: err.choices });
				if (err instanceof ReachNotNear) throw new ApiError(400, `Click ${i + 1}: ${err.message}`);
				throw err;
			}
		}
		return { attempt: await beginDemAttempt(db, 'delineation'), reaches, junctions };
	});
	try {
		const dem = configuredDem();
		if (!dem) throw new ApiError(409, 'Sub-catchments are off: the server has no elevation model (DEM_URL is empty).');
		try {
			const r = await delineateUnits(dem, {
				outlet: 'lowest',
				boundary: null,
				points: clicks.map((c, i) => ({ id: String(i), name: `click ${i + 1}`, role: 'abstraction', geometry: { type: 'Point', coordinates: [c.lon, c.lat] }, expectedKm2: reaches[i]?.upstreamKm2 ?? null, reachDistanceM: reaches[i]?.distanceM ?? null, chosen: !!c.reach, junction: junctions[i] ?? null }))
			});
			return toClickPieces(r, reaches);
		} catch (err) {
			if (err instanceof DelineationRefused) throw new ApiError(422, err.message, { reason: err.code });
			logEvent('error', { event: 'subcatchments_failed', ...safeError(err) });
			throw new ApiError(503, 'The elevation model could not be read just now. Try again; if it keeps failing, the operator should check DEM_URL.');
		}
	} finally {
		await finishDemAttempt(userId, attempt);
	}
}

const km2 = (m2: number) => `${(m2 / 1e6).toFixed(2)} km²`;
const deg = (v: number) => (Math.round(v * 1e5) / 1e5).toFixed(5);

/** A saved piece's description: its outlet, where it drains, what is upstream (and the inflows entering it), the dataset and method. Pure. */
export function pieceDescription(r: ClickPieces, p: ClickPiece): string {
	const inflows = r.pieces.filter((q) => q.open && q.drainsInto === p.click).map((q) => pieceName(q.click).toLowerCase());
	return (
		`The land draining to ${deg(p.point[0])}° E, ${deg(Math.abs(p.point[1]))}° ${p.point[1] < 0 ? 'S' : 'N'} before any other click; ` +
		`${p.drainsInto === null ? 'the lowest click' : `drains into ${pieceName(p.drainsInto).toLowerCase()}`}; ` +
		`${p.totalAreaM2 !== null ? `${km2(p.totalAreaM2)} upstream in all` : 'more upstream than was routed'}${inflows.length ? `; an inflow enters at ${inflows.join(' and ')}` : ''}. ` +
		`${p.nonContributingM2 ? `${km2(p.nonContributingM2)} of its own area drains into pans (non-contributing in WR2012’s sense; still in its area). ` : ''}` +
		`${p.reach ? `Placed on the channel whose upstream area best matches reach ${p.reach.reachId} of ${p.reach.dataset} (${Math.round(p.reach.upstreamKm2)} km²). ` : ''}` +
		`Delineated from ${r.dataset.label} (${r.methodVersion}); check it against the map.`
	).slice(0, 500);
}

/** What a save says it did: the pieces and their area, the inflow points not saved, and any piece that couldn't be outlined. Pure. */
export function saveSummary(r: ClickPieces, saved: readonly ClickPiece[]): string {
	const open = r.pieces.filter((p) => p.open).map((p) => p.click);
	const left = r.pieces.length - saved.length - open.length;
	const areaM2 = saved.reduce((s, p) => s + (p.areaM2 ?? 0), 0);
	return (
		`${saved.length === 1 ? '1 sub-catchment' : `${saved.length} sub-catchments`}, ${km2(areaM2)} in all` +
		`${open.length ? `; ${open.length === 1 ? '1 inflow point' : `${open.length} inflow points`} not saved (${open.map(pieceName).join(', ')})` : ''}` +
		`${left ? `; ${left} couldn’t be outlined and weren’t saved` : ''}`
	);
}

export const clickRoutes = new Hono<AuthEnv>()
	.post('/:id/map/subcatchments', async (c) => {
		const body = ClicksBody.parse(await readJson(c));
		return c.json(await route(c.get('userId'), c.req.param('id'), body.clicks));
	})
	.post('/:id/map/subcatchments/save', async (c) => {
		const body = ClicksBody.parse(await readJson(c));
		const id = c.req.param('id');
		const userId = c.get('userId');
		const r = await route(userId, id, body.clicks);
		const saved = r.pieces.filter((p): p is ClickPiece & { geometry: Poly; areaM2: number } => p.geometry !== null && p.areaM2 !== null);
		if (!saved.length) throw new ApiError(422, 'None of the pieces is whole and outlined, so there is nothing to save. Move the clicks onto the rivers and try again.');
		return withUser(userId, async (db) => {
			await requireRole(db, id, 'editor');
			const ids: string[] = [];
			for (const p of saved) {
				const { rows } = await db.query<{ id: string }>(
					`INSERT INTO map_feature (project_id, kind, name, geometry, properties, area_m2, created_by)
					 VALUES ($1, 'other', $2, $3, $4, $5, app_current_user_id()) RETURNING id`,
					[id, pieceName(p.click), JSON.stringify(p.geometry), JSON.stringify({ description: pieceDescription(r, p) }), p.areaM2]
				);
				ids.push(rows[0]!.id);
			}
			const areaM2 = saved.reduce((s, p) => s + p.areaM2, 0);
			await recordAudit(db, id, 'map.subcatchments_saved', {
				featureIds: ids,
				pieces: saved.length,
				inflows: r.pieces.filter((p) => p.open).length,
				areaKm2: Math.round(areaM2 / 1e4) / 100,
				dataset: r.dataset.label,
				methodVersion: r.methodVersion
			});
			const features = [];
			for (const fid of ids) features.push(toFeature(await loadFeature(db, id, fid)));
			return c.json(
				{ features, dropped: r.dropped, summary: saveSummary(r, saved) },
				201
			);
		});
	});
