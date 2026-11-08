// The A-pan and S-pan grid layers' state (evaporationGridLayer.svelte.ts,
// docs/maps.md § A-pan and S-pan grids): nothing asked while off or zoomed out
// too far; asked once per project, kind, dataset, month and snapped view while
// on (the year's total first); a picked month or dataset asks again, and going
// back is answered from the cache; what the map draws (points, month, cell
// size, and the credit line only while a point is drawn); an error kept until
// Retry. The request is the deps' `load`, so the test needs no API client.
import { flushSync } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EvaporationGridKind, EvaporationGridLayer as Answer } from '#lib/api/types.js';
import { EvaporationGridLayer } from './evaporationGridLayer.svelte';
import { mapGridViewBbox } from './mapLayers';

const dataset = (name: string, kind: EvaporationGridKind = 'apan') => ({
	dataset: name,
	kind,
	label: kind === 'apan' ? 'modelled A-pan (not a measured pan)' : 'Symons-pan (S-pan) evaporation',
	source: 'Invented',
	version: '1',
	method: 'm',
	attribution: `credit of ${name}`,
	firstYear: 1950,
	lastYear: 1999,
	cellDeg: 1 / 60,
	synthetic: false
});
const answer = (cells: [number, number, number][], extra: Partial<Answer> = {}): Answer => ({
	bbox: [0, 0, 1, 1],
	kind: 'apan',
	month: null,
	dataset: dataset('Atlas-Apan-2007'),
	datasets: [dataset('Atlas-Apan-2007')],
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

type Load = (id: string, kind: EvaporationGridKind, bbox: readonly [number, number, number, number], dataset: string | null, month: number | null) => Promise<Answer>;

function setup(load: Load, kind: EvaporationGridKind = 'apan') {
	const deps = $state({ on: false, view: null as [number, number, number, number] | null, projectId: 'p1' });
	let layer!: EvaporationGridLayer;
	cleanup = $effect.root(() => {
		layer = new EvaporationGridLayer({ kind, projectId: () => deps.projectId, on: () => deps.on, view: () => deps.view, load });
	});
	flushSync();
	return { deps, layer };
}

const VIEW: [number, number, number, number] = [21.301, -33.699, 21.349, -33.651];

describe('EvaporationGridLayer', () => {
	it('asks nothing while off or zoomed out too far, and draws nothing', () => {
		const load = vi.fn<Load>(async () => answer([]));
		const { deps, layer } = setup(load);
		deps.view = VIEW;
		flushSync();
		expect(layer.on).toBe(false);
		expect(layer.draw).toEqual({ points: [], month: null, cellDeg: null, attribution: null });
		deps.on = true;
		deps.view = [18, -35, 22, -31];
		flushSync();
		expect(layer.zoomIn).toBe(true);
		expect(layer.status).toBeNull();
		expect(load).not.toHaveBeenCalled();
	});

	it('asks for its own kind and the year’s total first, then again for a picked month; going back comes from the cache', async () => {
		const load = vi.fn<Load>(async (_id, _k, _b, _ds, month) => answer(month === 1 ? [[21.30833, -33.69167, 250]] : [[21.30833, -33.69167, 1812], [21.325, -33.69167, 1840]], { month }));
		const { deps, layer } = setup(load, 'span');
		deps.view = VIEW;
		deps.on = true;
		flushSync();
		expect(layer.kind).toBe('span');
		expect(load).toHaveBeenCalledExactlyOnceWith('p1', 'span', mapGridViewBbox(VIEW), null, null);
		await vi.waitFor(() => expect(layer.loading).toBe(false));
		expect(layer.points).toEqual([
			{ lon: 21.30833, lat: -33.69167, mm: 1812 },
			{ lon: 21.325, lat: -33.69167, mm: 1840 }
		]);
		expect(layer.range).toEqual([1812, 1840]);
		// The Layers box's live region says it.
		expect(layer.status).toBe('2 S-pan grid points shown.');
		expect(layer.draw).toMatchObject({ month: null, cellDeg: 1 / 60, attribution: 'credit of Atlas-Apan-2007' });
		layer.pickMonth(1);
		flushSync();
		expect(load).toHaveBeenLastCalledWith('p1', 'span', mapGridViewBbox(VIEW), null, 1);
		await vi.waitFor(() => expect(layer.points).toEqual([{ lon: 21.30833, lat: -33.69167, mm: 250 }]));
		expect(layer.draw.month).toBe(1);
		layer.pickMonth(null);
		flushSync();
		expect(load).toHaveBeenCalledTimes(2);
		expect(layer.points).toHaveLength(2);
		layer.pick('other');
		flushSync();
		expect(load).toHaveBeenLastCalledWith('p1', 'span', mapGridViewBbox(VIEW), 'other', null);
	});

	it('credits nothing while the server says the view is too dense (no point drawn)', async () => {
		const { deps, layer } = setup(vi.fn<Load>(async () => answer([], { tooDense: true })));
		deps.view = VIEW;
		deps.on = true;
		flushSync();
		await vi.waitFor(() => expect(layer.answer?.tooDense).toBe(true));
		expect(layer.points).toEqual([]);
		expect(layer.draw.attribution).toBeNull();
		expect(layer.status).toBe('Too many A-pan grid points in view: zoom in.');
	});

	it('keeps an error until Retry, which asks again', async () => {
		let fail = true;
		const load = vi.fn<Load>(async () => {
			if (fail) throw new Error('offline');
			return answer([[21.30833, -33.69167, 1812]]);
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
