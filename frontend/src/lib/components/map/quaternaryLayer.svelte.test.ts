// The quaternary outlines layer's state (quaternaryLayer.svelte.ts, issue
// #326 A6): asked once per project and bbox while on, a stale answer dropped,
// an error kept until Retry. The request is the deps' `load`, so the test
// needs no API client (and no SvelteKit $env).
import { flushSync } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MapFeature, QuaternaryLayer as Answer } from '$lib/api/types';
import { QuaternaryLayer } from './quaternaryLayer.svelte';
import { quaternaryBbox } from './mapLayers';
import { deferred, square } from './layerTesting';

const answer = (...codes: string[]): Answer => ({
	bbox: [0, 0, 1, 1],
	quaternaries: codes.map((code) => ({ code, dataset: 'synthetic', synthetic: true, geometry: { type: 'Polygon', coordinates: [] } as never })),
	truncated: false,
	datasets: []
});

let cleanup: (() => void) | null = null;
afterEach(() => {
	cleanup?.();
	cleanup = null;
});

type Load = (id: string, bbox: readonly [number, number, number, number]) => Promise<Answer>;

/** A layer on reactive deps the test changes: on, the features, the project. */
function setup(load: Load) {
	const deps = $state({ on: false, features: [] as MapFeature[], projectId: 'p1' });
	let layer!: QuaternaryLayer;
	cleanup = $effect.root(() => {
		layer = new QuaternaryLayer({ projectId: () => deps.projectId, on: () => deps.on, features: () => deps.features, load });
	});
	flushSync();
	return { deps, layer };
}

describe('QuaternaryLayer', () => {
	it('asks nothing while off, and draws nothing', () => {
		const load = vi.fn<Load>(async () => answer('A21A'));
		const { deps, layer } = setup(load);
		deps.features = [square('b', 28, -26)];
		flushSync();
		expect(layer.on).toBe(false);
		expect(layer.nothingAround).toBe(false);
		expect(layer.outlines).toEqual([]);
		expect(load).not.toHaveBeenCalled();
	});

	it('says there is nothing around while on with no features, without asking', () => {
		const load = vi.fn<Load>(async () => answer());
		const { deps, layer } = setup(load);
		deps.on = true;
		flushSync();
		expect(layer.nothingAround).toBe(true);
		expect(load).not.toHaveBeenCalled();
	});

	it('asks once per project and bbox, and draws the outlines it was given', async () => {
		const load = vi.fn<Load>(async () => answer('A21A', 'A21B'));
		const { deps, layer } = setup(load);
		const f = [square('b', 28, -26)];
		deps.features = f;
		deps.on = true;
		flushSync();
		expect(load).toHaveBeenCalledExactlyOnceWith('p1', quaternaryBbox(f));
		expect(layer.loading).toBe(true);
		await vi.waitFor(() => expect(layer.loading).toBe(false));
		expect(layer.outlines.map((o) => o.code)).toEqual(['A21A', 'A21B']);
		// The same bbox again (a new array, the same shapes): no second request.
		deps.features = [square('b', 28, -26)];
		flushSync();
		expect(load).toHaveBeenCalledTimes(1);
		// Off hides the outlines and clears the pick; on again with the same bbox doesn't ask again.
		layer.picked = 'A21A';
		deps.on = false;
		flushSync();
		expect(layer.outlines).toEqual([]);
		expect(layer.picked).toBeNull();
		deps.on = true;
		flushSync();
		expect(load).toHaveBeenCalledTimes(1);
		// A new bbox, or another project, asks again.
		deps.features = [square('b', 29, -27)];
		flushSync();
		deps.projectId = 'p2';
		flushSync();
		expect(load.mock.calls.map((c) => c[0])).toEqual(['p1', 'p1', 'p2']);
		await vi.waitFor(() => expect(layer.loading).toBe(false));
	});

	it('drops an answer that arrives after a newer request', async () => {
		const first = deferred<Answer>();
		const second = deferred<Answer>();
		const load = vi.fn<Load>().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
		const { deps, layer } = setup(load);
		deps.on = true;
		deps.features = [square('b', 28, -26)];
		flushSync();
		deps.features = [square('b', 29, -27)];
		flushSync();
		expect(load).toHaveBeenCalledTimes(2);
		second.resolve(answer('NEW'));
		await vi.waitFor(() => expect(layer.loading).toBe(false));
		first.resolve(answer('OLD'));
		await first.promise;
		await Promise.resolve();
		expect(layer.outlines.map((o) => o.code)).toEqual(['NEW']);
		expect(layer.loading).toBe(false);
	});

	it('keeps the error until Retry asks again', async () => {
		const load = vi.fn<Load>().mockRejectedValueOnce(new Error('Server error')).mockResolvedValueOnce(answer('A21A'));
		const { deps, layer } = setup(load);
		deps.on = true;
		deps.features = [square('b', 28, -26)];
		flushSync();
		await vi.waitFor(() => expect(layer.error).toBe('Server error'));
		expect(layer.loading).toBe(false);
		expect(layer.outlines).toEqual([]);
		layer.retry();
		await vi.waitFor(() => expect(layer.outlines.map((o) => o.code)).toEqual(['A21A']));
		expect(layer.error).toBeNull();
		expect(load).toHaveBeenCalledTimes(2);
	});

	it('retry with no features asks nothing', () => {
		const load = vi.fn<Load>(async () => answer());
		const { layer } = setup(load);
		layer.retry();
		expect(load).not.toHaveBeenCalled();
	});
});
