// A much larger channel near a point (issue #374, backend delineation/place.ts):
// Delineate is refused with it (422 `larger_channel`), and a click's piece
// carries it. River lines can sit hundreds of metres off the channel the
// elevation model sees, so the app names that channel and offers it; the
// editor decides, since near a confluence it is the wrong river.
import { ApiError } from '$lib/api/client';
import type { ConfluenceChoice, LargerChannel } from '$lib/api/types';

/** The channel a Delineate refusal names, or null for any other error. */
export function largerChannelOf(err: unknown): LargerChannel | null {
	if (!(err instanceof ApiError) || err.status !== 422) return null;
	const d = err.details as { reason?: string; larger?: LargerChannel } | undefined;
	return d?.reason === 'larger_channel' && d.larger ? d.larger : null;
}

const km2Text = (v: number) => (v < 10 ? `${v.toFixed(2)} km²` : `${Math.round(v).toLocaleString('en-ZA')} km²`);

/** Which way `to` lies from `from`, in words. */
export function bearingWord(from: readonly [number, number], to: readonly [number, number]): string {
	const dx = (to[0] - from[0]) * Math.cos((from[1] * Math.PI) / 180);
	const dy = to[1] - from[1];
	const deg = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
	return ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round(deg / 45) % 8]!;
}

/** A short line for a click's piece: where the larger channel is and how big. */
export function largerLine(from: readonly [number, number], l: LargerChannel): string {
	return `a much larger channel (${km2Text(l.km2)}) runs ${Math.round(l.distanceM)} m ${bearingWord(from, l.at)}: the river line may sit off the channel the elevation model sees`;
}

/** The rivers a confluence refusal offers (and, in Sub-catchments, which click it is), or null for any other error. */
export function confluenceOf(err: unknown): { choices: ConfluenceChoice[]; click: number | null } | null {
	if (!(err instanceof ApiError) || err.status !== 422) return null;
	const d = err.details as { reason?: string; choices?: ConfluenceChoice[]; click?: number } | undefined;
	return d?.reason === 'confluence' && d.choices?.length ? { choices: d.choices, click: d.click ?? null } : null;
}

/** A choice's button: the river and its area ("the tributary above the junction, 67 km²"). */
export const choiceText = (c: ConfluenceChoice) => `${c.label.charAt(0).toUpperCase()}${c.label.slice(1)}, ${km2Text(c.upstreamKm2)}`;
