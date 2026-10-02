// The River network layer's state (riverLayer.svelte.ts, issue #345): asked
// once per project and bbox while on, a stale answer dropped, an error kept
// until Retry, a reach picked and added as the project's river feature. The
// requests are the deps' `load` and `add`, so the test needs no API client.
import { flushSync } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MapFeature, RiverLayer as Answer, RiverReach } from '$lib/api/types';
import { RiverLayer, type RiverLayerDeps } from './riverLayer.svelte';
import { reachRef, riverBbox, riverViewBbox } from './mapLayers';
import { deferred, square } from './layerTesting';

const reach = (reachId: number, over: Partial<RiverReach> = {}): RiverReach => ({
	dataset: 'synthetic',
	reachId,
	name: '',
	strahler: 3,
	upstreamKm2: 120,
	lengthKm: 4.2,
	dischargeM3s: 0.8,
	synthetic: true,
	source: 'synthetic river network',
	geometry: { type: 'LineString', coordinates: [[28, -26], [28.1, -26.1]] } as RiverReach['geometry'],
	featureId: null,
	...over
});
const answer = (...reaches: RiverReach[]): Answer => ({ bbox: [0, 0, 1, 1], reaches, truncated: false, datasets: [] });

let cleanup: (() => void) | null = null;
afterEach(() => {
	cleanup?.();
	cleanup = null;
});

/** A layer on reactive deps the test changes: on, the features, the project. */
function setup(load: RiverLayerDeps['load'], add: RiverLayerDeps['add'] = vi.fn()) {
	const deps = $state({ on: false, features: [] as MapFeature[], projectId: 'p1', view: null as [number, number, number, number] | null });
	let layer!: RiverLayer;
	cleanup = $effect.root(() => {
		layer = new RiverLayer({ projectId: () => deps.projectId, on: () => deps.on, features: () => deps.features, view: () => deps.view, load, add });
	});
	flushSync();
	return { deps, layer };
}

describe('RiverLayer', () => {
	it('with no features, asks for the map view once zoomed in, snapped so a small pan asks nothing new, and reuses an answer panned back to', async () => {
		const load = vi.fn<RiverLayerDeps['load']>(async () => answer(reach(1)));
		const { deps, layer } = setup(load);
		deps.on = true;
		// The whole country in view: too wide to ask for, so it says to zoom in.
		deps.view = [16.4, -34.9, 32.9, -22.1];
		flushSync();
		expect(layer.nothingAround).toBe(true);
		expect(load).not.toHaveBeenCalled();
		// Zoomed in near Upington: the view, snapped out to the grid.
		deps.view = [21.03, -28.62, 21.48, -28.31];
		flushSync();
		await vi.waitFor(() => expect(layer.answer).not.toBeNull());
		expect(layer.nothingAround).toBe(false);
		expect(load).toHaveBeenCalledTimes(1);
		expect(load).toHaveBeenLastCalledWith('p1', [21, -28.65, 21.5, -28.3]);
		// A small pan inside the same snapped bbox asks nothing.
		deps.view = [21.04, -28.61, 21.47, -28.32];
		flushSync();
		expect(load).toHaveBeenCalledTimes(1);
		// Away and back: the second view is asked for, the first comes from what was fetched.
		deps.view = [22.03, -28.62, 22.48, -28.31];
		flushSync();
		await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
		deps.view = [21.03, -28.62, 21.48, -28.31];
		flushSync();
		expect(load).toHaveBeenCalledTimes(2);
		expect(layer.answer?.reaches.map((r) => r.reachId)).toEqual([1]);
	});

	it('asks around the features once there are some, whatever the map shows', async () => {
		const load = vi.fn<RiverLayerDeps['load']>(async () => answer(reach(1)));
		const { deps } = setup(load);
		deps.on = true;
		deps.view = [21.03, -28.62, 21.48, -28.31];
		const f = [square('b', 28, -26)];
		deps.features = f;
		flushSync();
		await vi.waitFor(() => expect(load).toHaveBeenCalled());
		expect(load).toHaveBeenLastCalledWith('p1', riverBbox(f));
		expect(riverViewBbox(deps.view)).not.toEqual(riverBbox(f));
	});

	it('asks nothing while off, and says there is nothing around while on with no features', () => {
		const load = vi.fn<RiverLayerDeps['load']>(async () => answer(reach(1)));
		const { deps, layer } = setup(load);
		expect(layer.on).toBe(false);
		expect(layer.reaches).toEqual([]);
		deps.on = true;
		flushSync();
		expect(layer.nothingAround).toBe(true);
		expect(load).not.toHaveBeenCalled();
	});

	it('asks once per project and bbox, and hands the map each reach by key with its order', async () => {
		const load = vi.fn<RiverLayerDeps['load']>(async () => answer(reach(11, { strahler: 5 }), reach(12, { strahler: null })));
		const { deps, layer } = setup(load);
		const f = [square('b', 28, -26)];
		deps.features = f;
		deps.on = true;
		flushSync();
		expect(load).toHaveBeenCalledExactlyOnceWith('p1', riverBbox(f));
		await vi.waitFor(() => expect(layer.loading).toBe(false));
		expect(layer.reaches.map((r) => [r.key, r.strahler])).toEqual([
			['synthetic:11', 5],
			['synthetic:12', null]
		]);
		deps.features = [square('b', 28, -26)];
		flushSync();
		expect(load).toHaveBeenCalledTimes(1);
		deps.projectId = 'p2';
		flushSync();
		expect(load).toHaveBeenCalledTimes(2);
		await vi.waitFor(() => expect(layer.loading).toBe(false));
	});

	it('drops an answer that arrives after a newer request', async () => {
		const first = deferred<Answer>();
		const second = deferred<Answer>();
		const load = vi.fn<RiverLayerDeps['load']>().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
		const { deps, layer } = setup(load);
		deps.on = true;
		deps.features = [square('b', 28, -26)];
		flushSync();
		deps.features = [square('b', 29, -27)];
		flushSync();
		second.resolve(answer(reach(2)));
		await vi.waitFor(() => expect(layer.loading).toBe(false));
		first.resolve(answer(reach(1)));
		await first.promise;
		await Promise.resolve();
		expect(layer.reaches.map((r) => r.key)).toEqual(['synthetic:2']);
	});

	it('keeps the error until Retry asks again', async () => {
		const load = vi.fn<RiverLayerDeps['load']>().mockRejectedValueOnce(new Error('Server error')).mockResolvedValueOnce(answer(reach(1)));
		const { deps, layer } = setup(load);
		deps.on = true;
		deps.features = [square('b', 28, -26)];
		flushSync();
		await vi.waitFor(() => expect(layer.error).toBe('Server error'));
		expect(layer.loading).toBe(false);
		layer.retry();
		await vi.waitFor(() => expect(layer.reaches).toHaveLength(1));
		expect(layer.error).toBeNull();
	});

	it('picks a reach (again unpicks it), clears the pick when turned off, and finds the feature made from it', async () => {
		const r = reach(7);
		const load = vi.fn<RiverLayerDeps['load']>(async () => answer(r));
		const { deps, layer } = setup(load);
		deps.on = true;
		deps.features = [square('b', 28, -26)];
		flushSync();
		await vi.waitFor(() => expect(layer.reaches).toHaveLength(1));
		layer.pick('synthetic:7');
		expect(layer.pickedReach).toEqual(r);
		layer.pick('synthetic:7');
		expect(layer.picked).toBeNull();
		// A key not in the answer picks nothing to show.
		layer.pick('synthetic:99');
		expect(layer.pickedReach).toBeNull();
		layer.pick('synthetic:7');
		deps.on = false;
		flushSync();
		expect(layer.picked).toBeNull();
		expect(layer.reaches).toEqual([]);
		// The project's river feature carries the reach's ref; another kind with the same ref isn't it.
		expect(layer.featureFor(r)).toBeNull();
		deps.features = [square('b', 28, -26), square('ot', 28, -26, 'other', { ref: reachRef(r) }), square('rv', 28, -26, 'river', { ref: reachRef(r) })];
		expect(layer.featureFor(r)?.id).toBe('rv');
	});

	it('credits HydroRIVERS while it draws any of its reaches, never the synthetic network', async () => {
		const real = reach(3, { dataset: 'HydroRIVERS-v10', source: 'HydroRIVERS v1.0', synthetic: false });
		const load = vi.fn<RiverLayerDeps['load']>().mockResolvedValueOnce(answer(reach(1))).mockResolvedValueOnce(answer(reach(1), real));
		const { deps, layer } = setup(load);
		deps.on = true;
		deps.features = [square('b', 28, -26)];
		flushSync();
		await vi.waitFor(() => expect(layer.reaches).toHaveLength(1));
		expect(layer.credited).toBe(false);
		deps.features = [square('b', 29, -27)];
		flushSync();
		await vi.waitFor(() => expect(layer.reaches).toHaveLength(2));
		expect(layer.credited).toBe(true);
		deps.on = false;
		flushSync();
		expect(layer.credited).toBe(false);
	});

	it('adds a reach through the deps, showing it is adding, and keeps why an add failed', async () => {
		const made = square('rv', 28, -26, 'river');
		const pending = deferred<MapFeature>();
		const add = vi.fn<RiverLayerDeps['add']>().mockReturnValueOnce(pending.promise).mockRejectedValueOnce(new Error('Not allowed'));
		const { layer } = setup(vi.fn(), add);
		const r = reach(7, { dataset: 'hydrorivers' });
		const going = layer.add(r);
		expect(layer.adding).toBe('hydrorivers:7');
		expect(add).toHaveBeenCalledExactlyOnceWith('p1', 'hydrorivers', 7);
		pending.resolve(made);
		await expect(going).resolves.toBe(made);
		expect(layer.adding).toBeNull();
		await expect(layer.add(r)).resolves.toBeNull();
		expect(layer.addError).toBe('Not allowed');
		// A new pick clears it.
		layer.pick('hydrorivers:7');
		expect(layer.addError).toBeNull();
	});
});
