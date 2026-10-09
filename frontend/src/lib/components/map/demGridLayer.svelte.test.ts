// The DEM grid layer's state (demGridLayer.svelte.ts, docs/maps.md § DEM grid):
// nothing asked while off or zoomed out too far; asked once per project and
// snapped view while on; points and their range drawn from the answer; none
// for a view the server calls too dense; an error kept until Retry.
import { flushSync } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DemGridLayer as Answer } from '$lib/api/types';
import { DemGridLayer } from './demGridLayer.svelte';
import { demGridViewBbox } from './mapLayers';

const answer = (points: [number, number, number][], extra: Partial<Answer> = {}): Answer => ({
	bbox: [0, 0, 1, 1],
	dataset: { label: 'Synthetic DEM', attribution: '', zoom: 10 },
	stride: 10,
	cellM: 32,
	points,
	tooDense: false,
	max: 5000,
	...extra
});

let cleanup: (() => void) | null = null;
afterEach(() => {
	cleanup?.();
	cleanup = null;
});

type Load = (id: string, bbox: readonly [number, number, number, number]) => Promise<Answer>;

function setup(load: Load) {
	const deps = $state({ on: false, view: null as [number, number, number, number] | null, projectId: 'p1' });
	let layer!: DemGridLayer;
	cleanup = $effect.root(() => {
		layer = new DemGridLayer({ projectId: () => deps.projectId, on: () => deps.on, view: () => deps.view, load });
	});
	flushSync();
	return { deps, layer };
}

const VIEW: [number, number, number, number] = [20.701, -33.449, 20.779, -33.421];

describe('DemGridLayer', () => {
	it('asks nothing while off, and says zoom in while the view is too wide', () => {
		const load = vi.fn<Load>(async () => answer([]));
		const { deps, layer } = setup(load);
		deps.view = VIEW;
		flushSync();
		expect(layer.points).toEqual([]);
		deps.on = true;
		deps.view = [20, -34, 21, -33];
		flushSync();
		expect(layer.zoomIn).toBe(true);
		expect(load).not.toHaveBeenCalled();
	});

	it('asks once per snapped view, and draws the points with their elevation range', async () => {
		const load = vi.fn<Load>(async () => answer([[20.71, -33.43, 812], [20.72, -33.43, 640]]));
		const { deps, layer } = setup(load);
		deps.view = VIEW;
		deps.on = true;
		flushSync();
		expect(load).toHaveBeenCalledExactlyOnceWith('p1', demGridViewBbox(VIEW));
		await vi.waitFor(() => expect(layer.points).toHaveLength(2));
		expect(layer.points[0]).toEqual({ lon: 20.71, lat: -33.43, elevationM: 812 });
		expect(layer.range).toEqual([640, 812]);
		deps.view = [20.702, -33.448, 20.778, -33.422];
		flushSync();
		expect(load).toHaveBeenCalledTimes(1);
	});

	it('draws nothing for a view the server calls too dense, and keeps an error until Retry', async () => {
		let fail = true;
		const load = vi.fn<Load>(async () => {
			if (fail) throw new Error('offline');
			return answer([], { tooDense: true });
		});
		const { deps, layer } = setup(load);
		deps.view = VIEW;
		deps.on = true;
		flushSync();
		await vi.waitFor(() => expect(layer.error).toBe('offline'));
		fail = false;
		layer.retry();
		await vi.waitFor(() => expect(layer.answer?.tooDense).toBe(true));
		expect(layer.points).toEqual([]);
		expect(layer.error).toBeNull();
	});
});
