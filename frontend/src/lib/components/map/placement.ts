// Where Start and Divide put each point on the elevation model's channel
// (start-7, backend delineation/pointPlacement.ts; docs/maps.md § Start from
// the map): the line each card shows, the river asked for at a confluence,
// and "Use that channel" for a point snapped beside a much larger one. The
// editor's choices live in the sheet's draft, keyed by the map feature's id
// ('' for the outlet gauge), and go with every proposal until changed.
import { ApiError } from '$lib/api/client';
import type { ConfluencePoint, PlacementChoice, PointPlacement } from '$lib/api/types';
import { fmtNum } from '$lib/format/number';

/** The key the outlet gauge's choices are kept under (the server's too). */
export const OUTLET_KEY = '';

/** The editor's placement choices, by point: the river picked at a confluence, the larger channel taken. */
export interface PlacementChoices {
	reaches: Record<string, { dataset: string; reachId: number }>;
	useLarger: Record<string, boolean>;
}

export const emptyPlacement = (): PlacementChoices => ({ reaches: {}, useLarger: {} });

/** A point's choices for a request (only what is set). */
export function choiceFor(c: PlacementChoices, key: string): PlacementChoice {
	return { ...(c.reaches[key] ? { reach: c.reaches[key] } : {}), ...(c.useLarger[key] ? { useLarger: true } : {}) };
}

/** A propose body with the choices added: the outlet gauge's (when there is one) and each point's. */
export function withPlacement<P extends { featureId: string }, B extends { outletFeatureId: string | null; points: P[] }>(
	body: B,
	c: PlacementChoices
): B & { outletReach?: PlacementChoice['reach']; outletUseLarger?: boolean; points: (P & PlacementChoice)[] } {
	const o = body.outletFeatureId ? choiceFor(c, OUTLET_KEY) : {};
	return {
		...body,
		...(o.reach ? { outletReach: o.reach } : {}),
		...(o.useLarger ? { outletUseLarger: true } : {}),
		points: body.points.map((p) => ({ ...p, ...choiceFor(c, p.featureId) }))
	};
}

/** The points a 422 `confluence` asks about, or null for any other error. */
export function confluencePointsOf(err: unknown): ConfluencePoint[] | null {
	if (!(err instanceof ApiError) || err.status !== 422) return null;
	const d = err.details as { reason?: string; points?: ConfluencePoint[] } | undefined;
	return d?.reason === 'confluence' && d.points?.length ? d.points : null;
}

const km2 = (v: number) => (v < 10 ? `${fmtNum(v, 2)} km²` : `${fmtNum(v, 0)} km²`);

/** A card's line on where its point went: how it was placed, on which reach, and how far it moved. Null when there is nothing to say. */
export function placementLine(pl: PointPlacement | null | undefined, movedM: number | null): string | null {
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
			return pl.larger?.outline
				? `At the outflow of the dam’s own outline: a much larger channel (${km2(pl.larger.km2)}) only clips its edge, so the dam was taken as off that channel.`
				: 'At the dam polygon’s most-drained cell (its outflow).';
		case 'boundary':
			return 'At the most-drained cell inside the boundary.';
		default:
			return `Snapped to the most-drained cell nearby${moved}${pl.unmatched && pl.reach ? `: no channel near it matches ${reach}, so it may be on another stream` : ''}.`;
	}
}
