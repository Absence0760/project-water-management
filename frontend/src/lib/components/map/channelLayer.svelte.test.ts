// The elevation model's channels layer (channelLayer.svelte.ts, issue #374):
// the tiles covering a view, the middle first, fetched one at a time while
// on, kept once fetched, none past the widest view, and a refusal stopping
// that view's tiles. The request is the deps' `load`, so no API client.
import { flushSync } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChannelTileAnswer } from '$lib/api/types';
import { ChannelLayer, CHANNEL_VIEW_MAX_DEG, tilesInView, type ChannelLayerDeps } from './channelLayer.svelte';

const tileAnswer = (i: number, j: number): ChannelTileAnswer => ({
	tile: [i, j],
	bounds: [i * 0.2, j * 0.2, (i + 1) * 0.2, (j + 1) * 0.2],
	minKm2: 1,
	lines: [{ coordinates: [[i * 0.2, j * 0.2], [i * 0.2 + 0.01, j * 0.2 + 0.01]], km2: 12 }],
	cellSizeM: 33,
	dataset: { label: 'GLO-30', fingerprint: '0123456789abcdef' },
	cached: false
});

let cleanup: (() => void) | null = null;
afterEach(() => {
	cleanup?.();
	cleanup = null;
});

function setup(load: ChannelLayerDeps['load']) {
	const deps = $state({ on: false, projectId: 'p1', view: null as [number, number, number, number] | null });
	let layer!: ChannelLayer;
	cleanup = $effect.root(() => {
		layer = new ChannelLayer({ projectId: () => deps.projectId, on: () => deps.on, view: () => deps.view, load });
	});
	flushSync();
	return { deps, layer };
}
const settle = async () => {
	for (let i = 0; i < 10; i++) await Promise.resolve();
	flushSync();
};

describe('tilesInView', () => {
	it('covers the view with 0.2° tiles, the middle first; none for a view wider than the limit', () => {
		const four = tilesInView([21.05, -28.5, 21.25, -28.35])!;
		expect(new Set(four.map((t) => t.join(',')))).toEqual(new Set(['105,-143', '105,-142', '106,-143', '106,-142']));
		// The middle (21.15° E, 28.43° S) lies in tile 105,-143: drawn first.
		expect(four[0]).toEqual([105, -143]);
		expect(tilesInView([21.11, -28.39, 21.15, -28.37])).toEqual([[105, -142]]);
		expect(tilesInView([20, -29, 20 + CHANNEL_VIEW_MAX_DEG + 0.01, -28.9])).toBeNull();
		expect(tilesInView(null)).toBeNull();
	});
});

describe('ChannelLayer', () => {
	it('fetches nothing while off; on, the view’s tiles one at a time, and keeps them when the view moves back', async () => {
		let inFlight = 0;
		let most = 0;
		const load = vi.fn<ChannelLayerDeps['load']>(async (_, [i, j]) => {
			inFlight++;
			most = Math.max(most, inFlight);
			await Promise.resolve();
			inFlight--;
			return tileAnswer(i, j);
		});
		const { deps, layer } = setup(load);
		deps.view = [21.05, -28.5, 21.25, -28.35];
		flushSync();
		await settle();
		expect(load).not.toHaveBeenCalled();
		expect(layer.lines).toEqual([]);
		deps.on = true;
		flushSync();
		await settle();
		expect(load).toHaveBeenCalledTimes(4);
		expect(most).toBe(1);
		expect(layer.tileCount).toBe(4);
		expect(layer.lines).toHaveLength(4);
		// Away and back: nothing asked again.
		deps.view = [21.11, -28.39, 21.15, -28.37];
		flushSync();
		await settle();
		expect(load).toHaveBeenCalledTimes(4);
		deps.on = false;
		flushSync();
		expect(layer.lines).toEqual([]);
	});

	it('says nothing is drawn while the map reports no view', () => {
		const { deps, layer } = setup(vi.fn());
		deps.on = true;
		flushSync();
		expect(layer.noView).toBe(true);
		expect(layer.zoomIn).toBe(false);
	});

	it('says to zoom in past the widest view and asks for nothing', async () => {
		const load = vi.fn<ChannelLayerDeps['load']>(async (_, [i, j]) => tileAnswer(i, j));
		const { deps, layer } = setup(load);
		deps.on = true;
		deps.view = [16, -35, 33, -22];
		flushSync();
		await settle();
		expect(layer.zoomIn).toBe(true);
		expect(load).not.toHaveBeenCalled();
	});

	it('stops a view’s tiles at a refusal and says why; the next view tries again', async () => {
		const load = vi.fn<ChannelLayerDeps['load']>(async () => {
			throw new Error('You have asked the elevation model 60 times in the last hour; try again later.');
		});
		const { deps, layer } = setup(load);
		deps.on = true;
		deps.view = [21.05, -28.5, 21.25, -28.35];
		flushSync();
		await settle();
		expect(load).toHaveBeenCalledTimes(1);
		expect(layer.error).toMatch(/60 times in the last hour/);
		load.mockImplementation(async (_, [i, j]) => tileAnswer(i, j));
		deps.view = [21.11, -28.39, 21.15, -28.37];
		flushSync();
		await settle();
		expect(layer.error).toBeNull();
		expect(layer.tileCount).toBe(1);
	});

	it('forgets one project’s tiles in another', async () => {
		const load = vi.fn<ChannelLayerDeps['load']>(async (_, [i, j]) => tileAnswer(i, j));
		const { deps, layer } = setup(load);
		deps.on = true;
		deps.view = [21.11, -28.39, 21.15, -28.37];
		flushSync();
		await settle();
		deps.projectId = 'p2';
		flushSync();
		await settle();
		expect(load).toHaveBeenCalledTimes(2);
		expect(load.mock.calls[1]![0]).toBe('p2');
		expect(layer.tileCount).toBe(1);
	});
});
