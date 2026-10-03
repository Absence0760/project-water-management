// The river reach a click means, for its upstream area: the expected area
// the outlet is matched to (place.ts, issue #374). Read from river_reference
// (171), the operator's loaded network (HydroRIVERS, or the synthetic set);
// none loaded, or none within the radius, means no expected area and the
// plain snap with its larger-channel guard.
//
// At a confluence the nearest line is a coin toss: a gauge on a junction sat
// 32 m from a 67 km² tributary, 92 m from the 422 km² river above the junction
// and 102 m from the 497 km² river below it, and the nearest won. So when reaches
// of clearly different areas lie within CONFLUENCE_M of the click, the server
// doesn't choose: it answers with the choices (ConfluenceChoice), each labelled
// by where it lies against the junction, and the caller asks the editor, who
// sends the one they meant back as `reach`.
import { z } from 'zod';
import type { Db } from '../db/tx.js';
import type { Position } from '../geo/geojson.js';
import { MATCH_RADIUS_M } from './place.js';

/** A river reach the editor picked at a confluence: which one, never its area (the server reads that). */
export const ReachChoiceBody = z.object({ dataset: z.string().min(1).max(100), reachId: z.number().int().nonnegative() }).strict();

/** How close (m) another reach must be to make a click ambiguous: HydroRIVERS' cells are ~460 m, so a junction's lines pass within a cell of it. */
export const CONFLUENCE_M = 200;
/** How different two reaches' areas must be to be different rivers to the click (rather than one river's two reaches). */
export const DISTINCT_FACTOR = 1.5;

export interface NearReach {
	dataset: string;
	reachId: number;
	/** Its upstream area at its downstream end (km²). */
	upstreamKm2: number;
	/** The click's distance from its line (m). */
	distanceM: number;
}

export interface ConfluenceChoice extends NearReach {
	/** above: it flows into the junction (its lower end is by the click); below: it flows out of it; along: the click is on its line. */
	role: 'above' | 'below' | 'along';
	/** In words, for a button: "the river below the junction", "the tributary above it", … */
	label: string;
}

/** The click is at a junction of reaches with different areas: the editor picks one (422 `confluence`). */
export class ConfluenceAmbiguity extends Error {
	constructor(readonly choices: ConfluenceChoice[]) {
		super(
			`This point is at a confluence: ${choices.map((c) => `${c.label} (${Math.round(c.upstreamKm2).toLocaleString('en-ZA')} km²)`).join(', ')}. Pick the river you mean.`
		);
	}
}

/** The reach the editor chose isn't near the point (moved, or another reach's id): 400. */
export class ReachNotNear extends Error {
	constructor() {
		super('That river reach isn’t within 1 km of the point: pick one of the rivers offered for it.');
	}
}

/** Metres from p to the segment a–b, on a local equirectangular plane. */
function segmentDistM(p: Position, a: Position, b: Position): number {
	const kx = 111320 * Math.cos((p[1] * Math.PI) / 180);
	const ky = 110950;
	const ax = (a[0] - p[0]) * kx;
	const ay = (a[1] - p[1]) * ky;
	const dx = (b[0] - a[0]) * kx;
	const dy = (b[1] - a[1]) * ky;
	const len2 = dx * dx + dy * dy;
	const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
	return Math.hypot(ax + t * dx, ay + t * dy);
}
const pointDistM = (p: Position, q: Position) => segmentDistM(p, q, q);

const linesOf = (coordinates: Position[] | Position[][]): Position[][] => (typeof coordinates[0]?.[0] === 'number' ? [coordinates as Position[]] : (coordinates as Position[][]));

/** The line's distance from p (m): a LineString or a MultiLineString's coordinates. */
export function lineDistM(p: Position, coordinates: Position[] | Position[][]): number {
	let best = Infinity;
	for (const line of linesOf(coordinates)) for (let i = 0; i + 1 < line.length; i++) best = Math.min(best, segmentDistM(p, line[i]!, line[i + 1]!));
	return best;
}

/** A reach near a click, with its line's upstream and downstream ends (HydroRIVERS lines run downstream). */
export interface NearReachLine extends NearReach {
	start: Position;
	end: Position;
}

/** Every reach with an upstream area within `radiusM` of the click, the nearest first. */
export async function reachesNear(db: Db, click: Position, radiusM = MATCH_RADIUS_M): Promise<NearReachLine[]> {
	const dLat = radiusM / 110950;
	const dLon = radiusM / (111320 * Math.cos((click[1] * Math.PI) / 180));
	// The bounding-box index (river_reference_bbox_idx) narrows it to the reaches whose box meets the click's.
	const { rows } = await db.query<{ dataset: string; reach_id: string; upstream_km2: number; geometry: { coordinates: Position[] | Position[][] } }>(
		`SELECT dataset, reach_id, upstream_km2, geometry FROM river_reference
		  WHERE upstream_km2 IS NOT NULL AND max_lon >= $1 AND min_lon <= $3 AND max_lat >= $2 AND min_lat <= $4
		  LIMIT 500`,
		[click[0] - dLon, click[1] - dLat, click[0] + dLon, click[1] + dLat]
	);
	const out: NearReachLine[] = [];
	for (const r of rows) {
		const d = lineDistM(click, r.geometry.coordinates);
		if (d > radiusM) continue;
		const lines = linesOf(r.geometry.coordinates);
		out.push({ dataset: r.dataset, reachId: Number(r.reach_id), upstreamKm2: r.upstream_km2, distanceM: d, start: lines[0]![0]!, end: lines.at(-1)!.at(-1)! });
	}
	return out.sort((a, b) => a.distanceM - b.distanceM);
}

/** The nearest reach with an upstream area within `radiusM` of the click, or null. */
export async function nearestReach(db: Db, click: Position, radiusM = MATCH_RADIUS_M): Promise<NearReach | null> {
	const [r] = await reachesNear(db, click, radiusM);
	return r ? { dataset: r.dataset, reachId: r.reachId, upstreamKm2: r.upstreamKm2, distanceM: r.distanceM } : null;
}

/**
 * The choices at a confluence, or null when the click means one river: when
 * two reaches within CONFLUENCE_M of it differ in area by DISTINCT_FACTOR,
 * every reach that close (one per place against the junction and area).
 * Labelled by where each lies against the junction: below it (the river the
 * others make) first, then those above it, the largest the main river. Pure.
 */
export function confluenceChoices(click: Position, near: readonly NearReachLine[]): ConfluenceChoice[] | null {
	const close = near.filter((r) => r.distanceM <= CONFLUENCE_M);
	const ratio = (a: NearReach, b: NearReach) => Math.max(a.upstreamKm2, b.upstreamKm2) / Math.min(a.upstreamKm2, b.upstreamKm2);
	// Ambiguous only when two of them are clearly different rivers (a tributary beside the main one); one river's two reaches aren't.
	if (!close.some((a) => close.some((b) => ratio(a, b) >= DISTINCT_FACTOR))) return null;
	const roleOf = (r: NearReachLine): ConfluenceChoice['role'] => {
		const toEnd = pointDistM(click, r.end);
		const toStart = pointDistM(click, r.start);
		if (Math.min(toEnd, toStart) > 2 * CONFLUENCE_M) return 'along';
		return toEnd <= toStart ? 'above' : 'below';
	};
	// Then every one that close is offered: above and below the junction differ by the tributary, the very choice a gauge
	// there turns on. Only two in the same place against the junction with about one area are one choice (the nearer kept).
	const kept: NearReachLine[] = [];
	for (const r of close) if (!kept.some((k) => roleOf(k) === roleOf(r) && ratio(k, r) < DISTINCT_FACTOR)) kept.push(r);
	const withRole = kept.map(({ start: _s, end: _e, ...r }) => ({ ...r, role: roleOf({ ...r, start: _s, end: _e }) }));
	const above = withRole.filter((r) => r.role === 'above');
	const mainAbove = above.reduce<(typeof above)[number] | null>((m, r) => (!m || r.upstreamKm2 > m.upstreamKm2 ? r : m), null);
	const labelOf = (r: (typeof withRole)[number]) =>
		r.role === 'below'
			? 'the river below the junction'
			: r.role === 'along'
				? 'the river along the point'
				: above.length < 2
					? 'the river above the junction'
					: r === mainAbove
						? 'the main river above the junction'
						: 'the tributary above the junction';
	const order = { below: 0, along: 1, above: 2 } as const;
	return withRole.sort((a, b) => order[a.role] - order[b.role] || b.upstreamKm2 - a.upstreamKm2).map((r) => ({ ...r, label: labelOf(r) }));
}

/**
 * The reach to match a click to: the one the editor `chose` (re-read here,
 * never taken from the request; refused unless within MATCH_RADIUS_M), else
 * the nearest, unless the click is at a confluence (ConfluenceAmbiguity).
 */
export async function reachFor(
	db: Db,
	click: Position,
	chosen?: { dataset: string; reachId: number } | null
): Promise<{ reach: NearReach | null; junction: { rivers: { key: string; role: ConfluenceChoice['role']; km2: number }[]; chosenKey: string } | null }> {
	const near = await reachesNear(db, click);
	const plain = (r: NearReachLine): NearReach => ({ dataset: r.dataset, reachId: r.reachId, upstreamKm2: r.upstreamKm2, distanceM: r.distanceM });
	const choices = confluenceChoices(click, near);
	if (chosen) {
		const r = near.find((x) => x.dataset === chosen.dataset && x.reachId === chosen.reachId);
		if (!r) throw new ReachNotNear();
		// At a confluence the junction's rivers go along, so the outlet is put at the DEM's own junction (junction.ts).
		const keyOf = (c: { dataset: string; reachId: number }) => `${c.dataset}:${c.reachId}`;
		return {
			reach: plain(r),
			junction: choices ? { rivers: choices.map((c) => ({ key: keyOf(c), role: c.role, km2: c.upstreamKm2 })), chosenKey: keyOf(r) } : null
		};
	}
	if (choices) throw new ConfluenceAmbiguity(choices);
	return { reach: near[0] ? plain(near[0]) : null, junction: null };
}
