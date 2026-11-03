// Sub-catchments from clicks on the rivers (docs/maps.md § Sub-catchments
// from clicks, docs/api.md § Delineation). Each click is an outlet on a river;
// its piece is its incremental catchment: the land whose water reaches it
// before any other click. The lowest click (the one most water drains
// through) owns everything else above it.
//
// Within the catchment: with a catchment boundary on the map, a click outside
// it is refused (422, naming the catchment), and when the boundary came from
// Delineate its accepted outlet is the lowest point, ahead of every click: its
// piece (click -1 in the answer, "Sub-catchment at the outlet") is the land
// between the lowest clicks and the outlet. A boundary drawn or uploaded by
// hand has no outlet stored, so the lowest click stays the outlet there. Both
// are read from the database on every request, never taken from the browser.
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
import { withUser, type Db } from '../db/tx.js';
import { panReferenceLoader } from './panReference.js';
import type { Geometry, Position } from '../geo/geojson.js';
import { pointInGeometry } from '../geo/geojson.js';
import { loadFeature, toFeature } from '../geo/routes.js';
import { recordAudit } from '../history/record.js';
import { readJson } from '../http/body.js';
import { ApiError } from '../http/errors.js';
import { logEvent } from '../logging/logEvent.js';
import { safeError } from '../logging/safeError.js';
import { requireRole } from '../projects/access.js';
import { beginDemAttempt, finishDemAttempt } from './attempt.js';
import { DelineationRefused, type LargerChannel } from './delineate.js';
import { configuredDem } from './dem.js';
import { MinKm2 } from './requests.js';
import { delineateUnits, type SubcatchmentRequest, type Subcatchments } from './subcatchments.js';

/** Clicks one request may carry: Start from the map's cap on points. */
export const CLICKS_MAX = 50;

const Lon = z.number().finite().min(-180).max(180);
const Lat = z.number().finite().min(-90).max(90);
/** A click, on a terrain channel (place.ts): `minKm2`, the least area of the channels the Map drew at its zoom (requests.ts MinKm2). */
const Click = z.object({ lon: Lon, lat: Lat, minKm2: MinKm2.optional() }).strict();
export const ClicksBody = z.object({ clicks: z.array(Click).min(1).max(CLICKS_MAX) }).strict();

type Poly = Extract<Geometry, { type: 'Polygon' }>;

/** The catchment's outlet's piece, in place of a click's index (OUTLET_KEY in the routing). */
export const OUTLET_CLICK = -1;
/** The catchment outlet's id among the routed points: no click's (their ids are their indices). */
export const OUTLET_KEY = 'outlet';

/**
 * The catchment boundary the clicks divide (the project's first `catchment_boundary`), with its outlet when it came from
 * Delineate (its accepted proposal's snapped outlet, as Start from the map reads it, start.ts readMapInputs); null without one.
 */
export interface Within {
	featureId: string;
	name: string;
	geometry: Geometry;
	outlet: Position | null;
}

/** The catchment the clicks are within, as the answer reports it: whose outlet ends the pieces. */
export interface WithinAnswer {
	featureId: string;
	name: string;
	/** `delineation`: the boundary's delineated outlet is the lowest point; `lowest`: drawn or uploaded by hand, the lowest click is. */
	outlet: 'delineation' | 'lowest';
}

export interface ClickPiece {
	/** The click's index in the request; OUTLET_CLICK (-1) for the catchment outlet's piece. */
	click: number;
	/** The click, on the terrain channel nearest it (place.ts). */
	point: Position;
	/** How far the click moved to the nearest terrain channel (m). */
	snapDistanceM: number | null;
	/** The click whose piece this one's water flows into next (OUTLET_CLICK: the outlet's piece); null for the lowest. */
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
	/** Off the terrain channels beside a much larger channel: that channel, to offer instead (the click stays where it snapped). */
	larger: LargerChannel | null;
}

export interface ClickPieces {
	/** One per click kept, in click order. */
	pieces: ClickPiece[];
	/** Clicks that are not pieces, with why (on another river, or on the same spot as another click). */
	dropped: { click: number; reason: string }[];
	/** The lowest click's index (OUTLET_CLICK when the catchment's outlet is): it owns what drains to it through no other click. */
	lowest: number;
	/** The catchment boundary the clicks are within; null with none on the map (the clicks anywhere, as before). */
	within: WithinAnswer | null;
	cellSizeM: number;
	dataset: { label: string; fingerprint: string };
	method: string;
	methodVersion: string;
}

/** A routed point's id as a click: its index, or OUTLET_CLICK for the catchment's outlet. */
const clickOf = (id: string) => (id === OUTLET_KEY ? OUTLET_CLICK : Number(id));

/** What the routing's sentences call the lowest point, once the catchment's outlet is it. */
const OUTLET_WORDS = 'the catchment’s outlet';

/** The partition's answer in clicks: the lowest click's piece is its "rest". Pure. */
export function toClickPieces(r: Subcatchments, within: WithinAnswer | null = null): ClickPieces {
	const lowest = clickOf(r.outlet.id!);
	const index = (id: string | null) => (id === null ? lowest : clickOf(id));
	const atOutlet = lowest === OUTLET_CLICK;
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
			larger: r.outlet.larger ?? null
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
			larger: u.larger ?? null
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
	const words = (t: string) => (atOutlet ? t.replaceAll('the lowest click', OUTLET_WORDS) : t);
	return {
		pieces,
		dropped: r.dropped.map((d) => ({ click: clickOf(d.id), reason: words(d.reason) })).sort((a, b) => a.click - b.click),
		lowest,
		within,
		cellSizeM: r.cellSizeM,
		dataset: { label: r.dataset.label, fingerprint: r.dataset.fingerprint },
		method: atOutlet && within ? r.method.replace('(the outlet: the click most water drains through)', `(the outlet: ${withinName(within)}’s delineated outlet)`) : r.method,
		methodVersion: r.methodVersion
	};
}

/** A piece's name: its click's number, as the map's badge shows it; the catchment outlet's piece says so. */
export const pieceName = (click: number) => (click === OUTLET_CLICK ? 'Sub-catchment at the outlet' : `Sub-catchment ${click + 1}`);

/** The boundary's name in a sentence. */
export const withinName = (w: Pick<Within, 'name'>) => (w.name.trim() ? `“${w.name.trim()}”` : 'the catchment boundary');

/** The project's catchment boundary and its delineated outlet (one read, as the request's user). */
export async function readWithin(db: Db, projectId: string): Promise<Within | null> {
	const { rows } = await db.query<{ id: string; name: string; geometry: Geometry }>(
		`SELECT id, name, geometry FROM map_feature WHERE project_id = $1 AND kind = 'catchment_boundary' ORDER BY created_at LIMIT 1`,
		[projectId]
	);
	const b = rows[0];
	if (!b) return null;
	const { rows: d } = await db.query<{ outlet_lon: number; outlet_lat: number }>(
		`SELECT outlet_lon, outlet_lat FROM delineation_proposal WHERE project_id = $1 AND feature_id = $2 AND status = 'accepted' ORDER BY decided_at DESC LIMIT 1`,
		[projectId, b.id]
	);
	return { featureId: b.id, name: b.name, geometry: b.geometry, outlet: d[0] ? [d[0].outlet_lon, d[0].outlet_lat] : null };
}

/** The first click outside the boundary (its index), or -1 when every one is inside. Pure. */
export function outsideClick(within: Pick<Within, 'geometry'>, clicks: readonly { lon: number; lat: number }[]): number {
	return clicks.findIndex((c) => !pointInGeometry([c.lon, c.lat], within.geometry));
}

/** The refusal for a click outside the catchment boundary. Pure. */
export const outsideText = (within: Pick<Within, 'name'>, i: number) =>
	`Click ${i + 1} is outside ${withinName(within)}, the catchment boundary: every sub-catchment lies within it. Click a terrain channel inside the boundary.`;

/** The refusal when a click drains more water than the delineated outlet: it is on another river, past the boundary's edge. Pure. */
export const pastOutletText = (within: Pick<Within, 'name'>, i: number) =>
	`Click ${i + 1} drains more water than ${withinName(within)}’s outlet, so it isn’t on a river inside the catchment: click a terrain channel inside the boundary.`;

/**
 * The routing request for the clicks: the lowest point is the outlet, the delineated outlet ahead of the clicks (on its own
 * cell, as Start places it) when the boundary has one, so it wins a tie with a click on it. Pure.
 */
export function clickRequest(clicks: readonly { lon: number; lat: number; minKm2?: number }[], within: Within | null): SubcatchmentRequest {
	const points: SubcatchmentRequest['points'] = clicks.map((c, i) => ({ id: String(i), name: `click ${i + 1}`, role: 'abstraction', minKm2: c.minKm2, geometry: { type: 'Point', coordinates: [c.lon, c.lat] } }));
	const outlet = within?.outlet;
	return {
		outlet: 'lowest',
		boundary: null,
		points: outlet ? [{ id: OUTLET_KEY, name: OUTLET_WORDS, role: 'abstraction', geometry: { type: 'Point', coordinates: outlet }, exact: true }, ...points] : points
	};
}

/** Count the attempt (editor only), route the clicks, free the attempt. Refusals are 422 with the sentence. */
async function route(userId: string, projectId: string, clicks: readonly z.infer<typeof Click>[]): Promise<ClickPieces> {
	const { attempt, within } = await withUser(userId, async (db) => {
		await requireRole(db, projectId, 'editor');
		const within = await readWithin(db, projectId);
		// Refused before any elevation-model work, so a click outside costs no attempt.
		const outside = within ? outsideClick(within, clicks) : -1;
		if (within && outside >= 0) throw new ApiError(422, outsideText(within, outside), { reason: 'outside_boundary' });
		return { attempt: await beginDemAttempt(db, 'delineation'), within };
	});
	const answer: WithinAnswer | null = within ? { featureId: within.featureId, name: within.name, outlet: within.outlet ? 'delineation' : 'lowest' } : null;
	try {
		const dem = configuredDem();
		if (!dem) throw new ApiError(409, 'Sub-catchments are off: the server has no elevation model (DEM_URL is empty).');
		try {
			const r = await delineateUnits(dem, clickRequest(clicks, within), { panReference: panReferenceLoader((fn) => withUser(userId, fn, { readOnly: true }), projectId) });
			// A click that drains more than the delineated outlet is on another river (just inside the boundary's edge).
			if (within?.outlet && r.outlet.id !== OUTLET_KEY) throw new ApiError(422, pastOutletText(within, Number(r.outlet.id)), { reason: 'outside_boundary' });
			return toClickPieces(r, answer);
		} catch (err) {
			if (err instanceof ApiError) throw err;
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
		`${p.drainsInto === null ? (p.click === OUTLET_CLICK ? 'the catchment’s delineated outlet' : 'the lowest click') : `drains into ${pieceName(p.drainsInto).toLowerCase()}`}; ` +
		`${p.totalAreaM2 !== null ? `${km2(p.totalAreaM2)} upstream in all` : 'more upstream than was routed'}${inflows.length ? `; an inflow enters at ${inflows.join(' and ')}` : ''}. ` +
		`${p.nonContributingM2 ? `${km2(p.nonContributingM2)} of its own area drains into pans (non-contributing in WR2012’s sense; still in its area). ` : ''}` +
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
					`INSERT INTO map_feature (project_id, kind, name, geometry, properties, area_m2, non_contributing_m2, created_by)
					 VALUES ($1, 'other', $2, $3, $4, $5, $6, app_current_user_id()) RETURNING id`,
					// What of it drains into pans (195): Use this area offers its effective area.
					[id, pieceName(p.click), JSON.stringify(p.geometry), JSON.stringify({ description: pieceDescription(r, p) }), p.areaM2, p.nonContributingM2 === null ? null : Math.min(p.nonContributingM2, p.areaM2)]
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
