// Where Start and Divide put each point on the DEM's channel (the
// hydrologist's review, finding 3; docs/design/start-from-map.md §
// Sub-catchments: the method). The same rules as Delineate and
// Sub-catchments from clicks (place.ts, junction.ts, reach.ts): each point's
// nearest river reach gives the upstream area its channel is matched to; at
// a confluence the editor picks the river (asked for every such point at
// once); a point snapped beside a much larger channel keeps that channel in
// the plan, as a warning the editor can act on ("Use that channel"). Before
// start-7 Start and Divide snapped every point 150 m with none of this, so a
// gauge on a HydroRIVERS line landed in a gully beside its river and the
// dams above it were dropped as "not upstream".
import { z } from 'zod';
import type { Db } from '../db/tx.js';
import type { Position } from '../geo/geojson.js';
import { bearingWord, type LargerChannel } from './delineate.js';
import { MATCH_RADIUS_M } from './place.js';
import { ConfluenceAmbiguity, ReachChoiceBody, reachFor, ReachNotNear, type ConfluenceChoice, type NearReach, type ReachAtClick } from './reach.js';
import type { DamPosition, PlacedBy, PlacementHints, UnitPiece } from './subcatchments.js';

/** A point's placement choices in a propose body: the river picked at a confluence, and the larger channel chosen over a snap. */
export const PlacementChoice = {
	/** The river reach the point means at a confluence: one of a 422 `confluence`'s choices for it. */
	reach: ReachChoiceBody.optional(),
	/** Put it on the much larger channel the last proposal named beside it (found again by the server, never sent). */
	useLarger: z.boolean().optional()
};

/** A point to place: a map point's position, and the editor's choices for it. */
export interface PointToPlace {
	key: string;
	name: string;
	at: Position;
	reach?: { dataset: string; reachId: number } | null;
	useLarger?: boolean;
}

/** Points at confluences, every one of them at once: the editor picks each one's river (422 `confluence`). */
export class PointsAtConfluence extends Error {
	constructor(readonly points: { featureId: string; name: string; choices: ConfluenceChoice[] }[]) {
		const names = points.map((p) => `“${p.name}”`);
		super(
			`${names.length === 1 ? `${names[0]} is` : `${names.slice(0, -1).join(', ')} and ${names.at(-1)} are`} at a confluence of rivers of different sizes, so the elevation model can’t tell which river ${names.length === 1 ? 'it is' : 'each is'} on: pick the river for ${names.length === 1 ? 'it' : 'each'}.`
		);
	}
}

export interface PointReach {
	/** The reach the point is matched to (its area the expected one), or null when none is within MATCH_RADIUS_M. */
	reach: ReachAtClick | null;
	/** Picked by the editor at a confluence. */
	chosen: boolean;
	hints: PlacementHints;
}

/**
 * Each point's reach and placement hints, by key (one transaction's reads). A point whose picked reach isn't near it is
 * refused (400, ReachNotNear with its name); points at confluences without a pick are collected into one PointsAtConfluence.
 */
export async function pointReaches(db: Db, points: readonly PointToPlace[]): Promise<Map<string, PointReach>> {
	const out = new Map<string, PointReach>();
	const ambiguous: PointsAtConfluence['points'] = [];
	for (const p of points) {
		try {
			const f = await reachFor(db, p.at, p.reach ?? null);
			out.set(p.key, {
				reach: f.reach,
				chosen: !!p.reach,
				hints: { expectedKm2: f.reach?.upstreamKm2 ?? null, head: f.reach?.head ?? null, chosen: !!p.reach, reachDistanceM: f.reach?.distanceM ?? null, junction: f.junction, useLarger: !!p.useLarger }
			});
		} catch (err) {
			if (err instanceof ConfluenceAmbiguity) ambiguous.push({ featureId: p.key, name: p.name, choices: err.choices });
			else if (err instanceof ReachNotNear) throw new ReachNotNearPoint(p.name);
			else throw err;
		}
	}
	if (ambiguous.length) throw new PointsAtConfluence(ambiguous);
	return out;
}

/** A point's picked reach isn't within 1 km of it (it moved, or another reach's id): 400. */
export class ReachNotNearPoint extends Error {
	constructor(readonly pointName: string) {
		super(`The river picked for “${pointName}” isn’t within ${MATCH_RADIUS_M / 1000} km of it: pick one of the rivers offered for it.`);
	}
}

/** How a point of a plan was put on the channel, for the sheet and the record. */
export interface PointPlacement {
	placedBy: PlacedBy;
	/** The river reach near it (matched to, picked at a confluence, or near but unmatched); null when none was within 1 km. */
	reach: { dataset: string; reachId: number; upstreamKm2: number; chosen: boolean } | null;
	/** Snapped beside a much larger channel: that channel, which "Use that channel" puts the point on. */
	larger: LargerChannel | null;
	/** A reach was near but no channel near the point matched its area: it may be on another stream. */
	unmatched: boolean;
	/** A dam polygon placed by the position the editor marked on the map (194), not by its outline; absent when unset. */
	damPosition?: DamPosition;
}

/** A plan's placement record from the partition's facts and the reach looked up. Pure. */
export function placementOf(piece: Pick<UnitPiece, 'placedBy' | 'larger' | 'unmatched' | 'damPosition'>, r: PointReach | undefined): PointPlacement {
	return {
		placedBy: piece.placedBy ?? 'snapped',
		// The reach's own area, as the River network layer shows it (its area at the point is what the point was matched to).
		reach: r?.reach ? { dataset: r.reach.dataset, reachId: r.reach.reachId, upstreamKm2: r.reach.reachKm2, chosen: r.chosen } : null,
		larger: piece.larger ?? null,
		unmatched: !!piece.unmatched,
		...(piece.damPosition ? { damPosition: piece.damPosition } : {})
	};
}

const km2Text = (v: number) => (v < 10 ? `${v.toFixed(2)} km²` : `${Math.round(v).toLocaleString('en-ZA')} km²`);

/**
 * The warnings a point's placement gives (none when it was matched, put at a junction or on a channel the editor chose):
 * a much larger channel beside it, and a reach near it that no channel matched. `point` is its position as given. Pure.
 */
export function placementWarnings(name: string, point: Position, pl: PointPlacement, outlet = false): string[] {
	const out: string[] = [];
	const whose = outlet ? `the outlet (${name})` : name;
	if (pl.larger?.outline) {
		out.push(
			`${name}’s outline also covers a much larger channel ${Math.round(pl.larger.distanceM)} m ${bearingWord(point, pl.larger.at)} of its outflow: at least ${km2Text(pl.larger.km2)} drains through it, but only a cell or two of it lies inside the outline, so the dam was taken as off that channel (filled by a pump or a furrow) and its outflow put where its own water leaves it (${km2Text(pl.larger.pointKm2)}). If the dam is on that river, use that channel; otherwise keep it.`
		);
	} else if (pl.larger) {
		out.push(
			`A much larger channel runs ${Math.round(pl.larger.distanceM)} m ${bearingWord(point, pl.larger.at)} of ${whose}: at least ${km2Text(pl.larger.km2)} drains through it, against ${km2Text(pl.larger.pointKm2)} where the point was put. River lines can sit a few hundred metres off the channel the elevation model sees. ${outlet ? 'Every unit is placed against the outlet, so check it first: use' : 'Use'} that channel, or keep the point if it is on the small stream.`
		);
	}
	if (pl.unmatched && pl.reach && pl.placedBy === 'snapped') {
		out.push(
			`${outlet ? 'The outlet' : name} is within 1 km of river reach ${pl.reach.reachId} (${km2Text(pl.reach.upstreamKm2)}), but no channel near it matches that area, so it was snapped to the channel nearest it: it may be on another stream. Check it on the map.`
		);
	}
	return out;
}
