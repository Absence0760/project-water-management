// The MAP grid layer's state (mapGridLayer.svelte.ts, docs/maps.md § MAP grid):
// nothing asked while off or zoomed out too far; asked once per project,
// dataset and snapped view while on; a picked dataset asks again; points and
// their range drawn from the answer; an error kept until Retry. The request
// is the deps' `load`, so the test needs no API client (and no SvelteKit $env).
import { flushSync } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MapGridLayer as Answer } from '$lib/api/types';
import { MapGridLayer } from './mapGridLayer.svelte';
import { mapGridViewBbox } from './mapLayers';

const dataset = (name: string) => ({ dataset: name, source: 'Invented', version: '1', attribution: 'test', cellDeg: 0.01, cells: 9, synthetic: name === 'synthetic' });
const answer = (cells: [number, number, number][], extra: Partial<Answer> = {}): Answer => ({
	bbox: [0, 0, 1, 1],
	dataset: dataset('synthetic'),
	datasets: [dataset('synthetic')],
	cells,
	tooDense: false,
	max: 5000,
	...extra
});

let cleanup: (() => void) | null = null;
afterEach(() => {
	cleanup?.();
	cleanup = null;
});

type Load = (id: string, bbox: readonly [number, number, number, number], dataset: string | null) => Promise<Answer>;

function setup(load: Load) {
	const deps = $state({ on: false, view: null as [number, number, number, number] | null, projectId: 'p1' });
	let layer!: MapGridLayer;
	cleanup = $effect.root(() => {
		layer = new MapGridLayer({ projectId: () => deps.projectId, on: () => deps.on, view: () => deps.view, load });
	});
	flushSync();
	return { deps, layer };
}

const VIEW: [number, number, number, number] = [21.301, -33.649, 21.329, -33.621];

describe('MapGridLayer', () => {
	it('asks nothing while off, and draws nothing', () => {
		const load = vi.fn<Load>(async () => answer([]));
		const { deps, layer } = setup(load);
		deps.view = VIEW;
		flushSync();
		expect(layer.on).toBe(false);
		expect(layer.points).toEqual([]);
		expect(load).not.toHaveBeenCalled();
	});

	it('says zoom in, without asking, while the view is too wide or not known yet', () => {
		const load = vi.fn<Load>(async () => answer([]));
		const { deps, layer } = setup(load);
		deps.on = true;
		flushSync();
		expect(layer.zoomIn).toBe(true);
		deps.view = [18, -35, 22, -31];
		flushSync();
		expect(layer.zoomIn).toBe(true);
		expect(load).not.toHaveBeenCalled();
	});

	it('asks once per snapped view and dataset, draws the points with their range, and asks again for a picked dataset', async () => {
		const load = vi.fn<Load>(async (_id, _b, ds) => answer(ds === 'coarse' ? [[21.3, -33.6, 400]] : [[21.305, -33.645, 790], [21.315, -33.645, 612]]));
		const { deps, layer } = setup(load);
		deps.view = VIEW;
		deps.on = true;
		flushSync();
		expect(load).toHaveBeenCalledExactlyOnceWith('p1', mapGridViewBbox(VIEW), null);
		await vi.waitFor(() => expect(layer.loading).toBe(false));
		expect(layer.points).toEqual([
			{ lon: 21.305, lat: -33.645, mapMm: 790 },
			{ lon: 21.315, lat: -33.645, mapMm: 612 }
		]);
		expect(layer.range).toEqual([612, 790]);
		// A pan inside the same snapped box asks nothing.
		deps.view = [21.302, -33.648, 21.328, -33.622];
		flushSync();
		expect(load).toHaveBeenCalledTimes(1);
		layer.pick('coarse');
		flushSync();
		expect(load).toHaveBeenLastCalledWith('p1', mapGridViewBbox(VIEW), 'coarse');
		await vi.waitFor(() => expect(layer.points).toEqual([{ lon: 21.3, lat: -33.6, mapMm: 400 }]));
		// Back to the default: answered from the cache.
		layer.pick(null);
		flushSync();
		expect(load).toHaveBeenCalledTimes(2);
		expect(layer.points).toHaveLength(2);
	});

	it('draws nothing for a view the server says is too dense', async () => {
		const { deps, layer } = setup(vi.fn<Load>(async () => answer([], { tooDense: true })));
		deps.view = VIEW;
		deps.on = true;
		flushSync();
		await vi.waitFor(() => expect(layer.answer?.tooDense).toBe(true));
		expect(layer.points).toEqual([]);
		expect(layer.range).toBeNull();
	});

	it('keeps an error until Retry, which asks again', async () => {
		let fail = true;
		const load = vi.fn<Load>(async () => {
			if (fail) throw new Error('offline');
			return answer([[21.305, -33.645, 790]]);
		});
		const { deps, layer } = setup(load);
		deps.view = VIEW;
		deps.on = true;
		flushSync();
		await vi.waitFor(() => expect(layer.error).toBe('offline'));
		fail = false;
		layer.retry();
		await vi.waitFor(() => expect(layer.points).toHaveLength(1));
		expect(layer.error).toBeNull();
	});
});
