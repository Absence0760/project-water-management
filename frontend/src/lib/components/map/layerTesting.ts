// Shared by the map layer state classes' tests (riverLayer, quaternaryLayer):
// a promise the test settles by hand, and a square feature at a spot.
import type { MapFeature } from '$lib/api/types';

export function deferred<T>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** A small square feature at (lon, lat), with optional properties. */
export const square = (id: string, lon: number, lat: number, kind: MapFeature['kind'] = 'catchment_boundary', properties: Record<string, unknown> = {}): MapFeature =>
	({
		id,
		kind,
		nodeId: null,
		name: id,
		properties,
		geometry: {
			type: 'Polygon',
			coordinates: [
				[
					[lon, lat],
					[lon + 0.1, lat],
					[lon + 0.1, lat + 0.1],
					[lon, lat + 0.1],
					[lon, lat]
				]
			]
		}
	}) as unknown as MapFeature;
