// Where Start and Divide put each point on the DEM's channel (the
// hydrologist's review, finding 3; docs/design/start-from-map.md §
// Sub-catchments: the method). The same rule as Delineate and Sub-catchments
// from clicks (place.ts): each point goes on the terrain channel nearest it,
// and the mapped river network never moves it (issue #472); a point off the
// channels snapped beside a much larger channel keeps that channel in the
// plan, as a warning the editor can act on ("Use that channel").
import { z } from 'zod';
import type { Position } from '../geo/geojson.js';
import { bearingWord, type LargerChannel } from './delineate.js';
import type { DamPosition, PlacedBy, UnitPiece } from './subcatchments.js';

/** A point's placement choice in a propose body: the larger channel chosen over a snap. */
export const PlacementChoice = {
	/** Put it on the much larger channel the last proposal named beside it (found again by the server, never sent). */
	useLarger: z.boolean().optional()
};

/** How a point of a plan was put on the channel, for the sheet and the record. */
export interface PointPlacement {
	placedBy: PlacedBy;
	/** Snapped beside a much larger channel: that channel, which "Use that channel" puts the point on. */
	larger: LargerChannel | null;
	/** A dam polygon placed by the position the editor marked on the map (194), not by its outline; absent when unset. */
	damPosition?: DamPosition;
}

/** A plan's placement record from the partition's facts. Pure. */
export function placementOf(piece: Pick<UnitPiece, 'placedBy' | 'larger' | 'damPosition'>): PointPlacement {
	return {
		placedBy: piece.placedBy ?? 'snapped',
		larger: piece.larger ?? null,
		...(piece.damPosition ? { damPosition: piece.damPosition } : {})
	};
}

const km2Text = (v: number) => (v < 10 ? `${v.toFixed(2)} km²` : `${Math.round(v).toLocaleString('en-ZA')} km²`);

/**
 * The warnings a point's placement gives (none on a channel the editor chose): a much larger channel beside it. `point` is its
 * position as given. Pure.
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
			`A much larger terrain channel runs ${Math.round(pl.larger.distanceM)} m ${bearingWord(point, pl.larger.at)} of ${whose}: at least ${km2Text(pl.larger.km2)} drains through it, against ${km2Text(pl.larger.pointKm2)} where the point was put. ${outlet ? 'Every unit is placed against the outlet, so check it first: use' : 'Use'} that channel, or keep the point if it is on the small stream.`
		);
	}
	return out;
}
