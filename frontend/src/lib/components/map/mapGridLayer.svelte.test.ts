// A MAP grid layer's state (mapGridLayer.svelte.ts, docs/maps.md § MAP grid):
// nothing asked while off or zoomed out too far; asked once per project and
// snapped view while on, always for its own dataset (the WAAS 2007 MAP's
// WAAS-SWCape-2007, the CCWR MAP's Lynch-2004); points, their range and what
// the map draws (with the credit line only while points are drawn) from the
// answer; the synthetic grid drawn in its place where only that is loaded,
// never another real grid; its status line by its own name, "not loaded"
// included; an error
// kept until Retry. The request is the deps' `load`, so the test needs no API
// client (and no SvelteKit $env).
import { flushSync } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MapGridLayer as Answer } from '#lib/api/types.js';
import { MapGridLayer } from './mapGridLayer.svelte';
import { mapGridViewBbox, type MapGridKind } from './mapLayers';

const dataset = (name: string) => ({ dataset: name, source: 'Invented', version: '1', attribution: 'test', cellDeg: 0.01, cells: 9, synthetic: name === 'synthetic' });
const answer = (cells: [number, number, number][], extra: Partial<Answer> = {}): Answer => ({
	bbox: [0, 0, 1, 1],
	dataset: dataset('Invented'),
	datasets: [dataset('Invented')],
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

type Load = (id: string, bbox: readonly [number, number, number, number], dataset: string) => Promise<Answer>;

function setup(load: Load, kind: MapGridKind = 'waas') {
	const deps = $state({ on: false, view: null as [number, number, number, number] | null, projectId: 'p1' });
	let layer!: MapGridLayer;
	cleanup = $effect.root(() => {
		layer = new MapGridLayer({ kind, projectId: () => deps.projectId, on: () => deps.on, view: () => deps.view, load });
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

	it('asks once per snapped view for its own dataset, and draws the points with their range', async () => {
		const load = vi.fn<Load>(async () => answer([[21.305, -33.645, 790], [21.315, -33.645, 612]]));
		const { deps, layer } = setup(load);
		deps.view = VIEW;
		deps.on = true;
		flushSync();
		expect(load).toHaveBeenCalledExactlyOnceWith('p1', mapGridViewBbox(VIEW), 'WAAS-SWCape-2007');
		await vi.waitFor(() => expect(layer.loading).toBe(false));
		expect(layer.points).toEqual([
			{ lon: 21.305, lat: -33.645, mapMm: 790 },
			{ lon: 21.315, lat: -33.645, mapMm: 612 }
		]);
		expect(layer.range).toEqual([612, 790]);
		expect(layer.draw).toEqual({ points: layer.points, cellDeg: 0.01, attribution: 'test' });
		expect(layer.status).toBe('2 WAAS 2007 MAP points shown.');
		// A pan inside the same snapped box asks nothing.
		deps.view = [21.302, -33.648, 21.328, -33.622];
		flushSync();
		expect(load).toHaveBeenCalledTimes(1);
		// Off: nothing drawn, so nothing credited.
		deps.on = false;
		flushSync();
		expect(layer.draw).toEqual({ points: [], cellDeg: 0.01, attribution: null });
		expect(layer.status).toBeNull();
	});

	it('is the WAAS 2007 MAP (`mapgrid`) or the CCWR MAP (`ccwrgrid`), each asking for its own grid', async () => {
		const load = vi.fn<Load>(async () => answer([[21.3, -33.6, 400]]));
		const { deps, layer } = setup(load, 'ccwr');
		expect([layer.kind, layer.layer, layer.label, layer.dataset]).toEqual(['ccwr', 'ccwrgrid', 'CCWR MAP', 'Lynch-2004']);
		deps.view = VIEW;
		deps.on = true;
		flushSync();
		expect(layer.status).toBe('Loading the CCWR MAP…');
		expect(load).toHaveBeenCalledExactlyOnceWith('p1', mapGridViewBbox(VIEW), 'Lynch-2004');
		await vi.waitFor(() => expect(layer.status).toBe('1 CCWR MAP point shown.'));
		cleanup?.();
		const waas = setup(vi.fn<Load>(async () => answer([]))).layer;
		expect([waas.kind, waas.layer, waas.label, waas.dataset]).toEqual(['waas', 'mapgrid', 'WAAS 2007 MAP', 'WAAS-SWCape-2007']);
	});

	it('says its grid isn’t loaded when the server has none by that label, nor the synthetic grid, and draws nothing', async () => {
		const load = vi.fn<Load>(async () => answer([], { dataset: null, datasets: [] }));
		const { deps, layer } = setup(load, 'ccwr');
		deps.view = VIEW;
		deps.on = true;
		flushSync();
		await vi.waitFor(() => expect(layer.status).toBe('No CCWR MAP is loaded.'));
		expect(load).toHaveBeenCalledOnce();
		expect(layer.standIn).toBe(false);
		expect(layer.points).toEqual([]);
		expect(layer.draw.attribution).toBeNull();
	});

	it('never stands another real grid in for its own: the WAAS 2007 MAP draws nothing beside a loaded Lynch-2004', async () => {
		const load = vi.fn<Load>(async () => answer([], { dataset: null, datasets: [dataset('Lynch-2004')] }));
		const { deps, layer } = setup(load);
		deps.view = VIEW;
		deps.on = true;
		flushSync();
		await vi.waitFor(() => expect(layer.status).toBe('No WAAS 2007 MAP is loaded.'));
		expect(load).toHaveBeenCalledExactlyOnceWith('p1', mapGridViewBbox(VIEW), 'WAAS-SWCape-2007');
		expect(layer.points).toEqual([]);
	});

	it('draws the synthetic grid in its place where only that is loaded (a dev laptop), and says so', async () => {
		const load = vi.fn<Load>(async (_id, _bbox, asked) =>
			asked === 'synthetic' ? answer([[21.305, -33.645, 790]], { dataset: dataset('synthetic') }) : answer([], { dataset: null, datasets: [dataset('synthetic')] })
		);
		const { deps, layer } = setup(load, 'ccwr');
		deps.view = VIEW;
		deps.on = true;
		flushSync();
		await vi.waitFor(() => expect(layer.status).toBe('1 synthetic test point shown.'));
		expect(load.mock.calls.map((c) => c[2])).toEqual(['Lynch-2004', 'synthetic']);
		expect(layer.standIn).toBe(true);
		expect(layer.answer?.dataset?.dataset).toBe('synthetic');
		expect(layer.points).toEqual([{ lon: 21.305, lat: -33.645, mapMm: 790 }]);
		// Its own grid's answer, once loaded, is never a stand-in.
		cleanup?.();
		const own = setup(vi.fn<Load>(async () => answer([[21.305, -33.645, 790]], { dataset: dataset('Lynch-2004') })), 'ccwr');
		own.deps.view = VIEW;
		own.deps.on = true;
		flushSync();
		await vi.waitFor(() => expect(own.layer.status).toBe('1 CCWR MAP point shown.'));
		expect(own.layer.standIn).toBe(false);
	});

		it('draws nothing for a view the server says is too dense', async () => {
		const { deps, layer } = setup(vi.fn<Load>(async () => answer([], { tooDense: true })));
		deps.view = VIEW;
		deps.on = true;
		flushSync();
		await vi.waitFor(() => expect(layer.answer?.tooDense).toBe(true));
		expect(layer.status).toBe('Too many WAAS 2007 MAP points in view: zoom in.');
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
