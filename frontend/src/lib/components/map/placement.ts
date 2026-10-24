// Where Start and Divide put each point on the elevation model's channel
// (backend delineation/pointPlacement.ts; docs/maps.md § Start from the map):
// the line each card shows, and "Use that channel" for a point beside a much
// larger one. The editor's choices live in the sheet's draft, keyed by the
// map feature's id ('' for the outlet gauge), and go with every proposal
// until changed.
import type { PlacementChoice, PointPlacement } from '#lib/api/types.js';
import { fmtNum } from '#lib/format/number.js';

/** The key the outlet gauge's choices are kept under (the server's too). */
export const OUTLET_KEY = '';

/** The editor's placement choices, by point: the larger channel taken. */
export interface PlacementChoices {
	useLarger: Record<string, boolean>;
}

export const emptyPlacement = (): PlacementChoices => ({ useLarger: {} });

/** A point's choices for a request (only what is set). */
export function choiceFor(c: PlacementChoices, key: string): PlacementChoice {
	return c.useLarger[key] ? { useLarger: true } : {};
}

/** A propose body with the choices added: the outlet gauge's (when there is one) and each point's. */
export function withPlacement<P extends { featureId: string }, B extends { outletFeatureId: string | null; points: P[] }>(
	body: B,
	c: PlacementChoices
): B & { outletUseLarger?: boolean; points: (P & PlacementChoice)[] } {
	const o = body.outletFeatureId ? choiceFor(c, OUTLET_KEY) : {};
	return {
		...body,
		...(o.useLarger ? { outletUseLarger: true } : {}),
		points: body.points.map((p) => ({ ...p, ...choiceFor(c, p.featureId) }))
	};
}

const km2 = (v: number) => (v < 10 ? `${fmtNum(v, 2)} km²` : `${fmtNum(v, 0)} km²`);

/** Whether a plan's method version placed its points by the mapped river's rules (start-7 to start-14; gone since start-15, issue #472). */
export function placedByMappedRivers(methodVersion: string | null | undefined): boolean {
	const n = /^start-(\d+)$/.exec(methodVersion ?? '')?.[1];
	return n !== undefined && Number(n) < 15;
}

/**
 * A card's line on where its point went: how it was placed and how far it moved. Null when there is nothing to say. A plan
 * proposed before start-15 (`methodVersion`) reads as it was placed: `matched` or `junction` with its reach, and `snapped` as the
 * most-drained cell nearby, with its unmatched-reach caveat.
 */
export function placementLine(pl: PointPlacement | null | undefined, movedM: number | null, methodVersion?: string | null): string | null {
	const moved = movedM === null ? '' : `, ${fmtNum(movedM, 0)} m from the point`;
	const reach = pl?.reach ? `river reach ${pl.reach.reachId} (${km2(pl.reach.upstreamKm2)})` : '';
	if (!pl) return movedM === null ? null : `Moved ${fmtNum(movedM, 0)} m onto the river.`;
	switch (pl.placedBy) {
		case 'matched':
			return `On the channel matching ${reach}${pl.reach?.chosen ? ', picked at the confluence' : ''}${moved}.`;
		case 'junction':
			return `At the elevation model’s junction for ${reach}, picked at the confluence${moved}.`;
		case 'larger':
			return `On the larger channel, as you chose${moved}.`;
		case 'exact':
			return 'On the delineated outlet, as Delineate placed it.';
		case 'polygon':
			if (pl.damPosition === 'off_channel') return 'On the river where the dam’s own outflow joins it, as marked: off-channel, so the dam takes only its own catchment’s runoff.';
			if (pl.damPosition === 'on_channel') return 'At the dam polygon’s most-drained cell, on the river, as marked.';
			return pl.larger?.outline
				? `At the outflow of the dam’s own outline: a much larger channel (${km2(pl.larger.km2)}) only clips its edge, so the dam was taken as off that channel.`
				: 'At the dam polygon’s most-drained cell (its outflow).';
		case 'boundary':
			return 'At the most-drained cell inside the boundary.';
		case 'unit':
			return 'Its boundary’s outflow: the most-drained cell inside it above the outlet, where its order is read from.';
		default:
			return placedByMappedRivers(methodVersion)
				? `Snapped to the most-drained cell nearby${moved}${pl.unmatched && pl.reach ? `: no channel near it matches ${reach}, so it may be on another stream` : ''}.`
				: `On the nearest terrain channel${moved}.`;
	}
}
