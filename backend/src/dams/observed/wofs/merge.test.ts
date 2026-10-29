// Joining one date's views of a dam (merge.ts) and placing a view's pixels on
// its grid's lattice (sum.ts viewPixels).
import { describe, expect, it } from 'vitest';
import { outlineMask, type MaskGrid, type OutlineMask } from '../../../raster/mask.js';
import { better, mergeViews, type SceneView } from './merge.js';
import type { SceneItem } from './stac.js';
import { observation, PX_COVERED, PX_DRY, PX_OFF, PX_WET, viewPixels } from './sum.js';

const PX = 0.0002;
const tile = (lon: number, lat: number): MaskGrid => ({ epsg: 4326, originX: lon, originY: lat, pixelSizeX: PX, pixelSizeY: PX });

describe('viewPixels', () => {
	it('puts neighbouring 1° tiles on one lattice, a pixel at the same column and row in both', () => {
		// A dam across 20° E: 10 pixels each side.
		const dam = { type: 'Polygon' as const, coordinates: [[[19.998, -32.5], [20.002, -32.5], [20.002, -32.4996], [19.998, -32.4996], [19.998, -32.5]]] };
		const west = tile(19, -32);
		const east = tile(20, -32);
		const a = viewPixels(west, outlineMask(dam, west), new Uint8Array(0));
		const b = viewPixels(east, outlineMask(dam, east), new Uint8Array(0));
		expect(a.lattice).toBe(b.lattice);
		expect([a.col0, a.row0, a.width, a.height]).toEqual([b.col0, b.row0, b.width, b.height]);
		expect(a.mask).toEqual(b.mask);
	});

	it('puts grids of another CRS, pixel size or sub-pixel origin on other lattices', () => {
		const m: OutlineMask = { col0: 0, row0: 0, width: 1, height: 1, mask: Uint8Array.of(1), inside: 1, pixelAreaM2: 1 };
		const at = (g: MaskGrid) => viewPixels(g, m, Uint8Array.of(0)).lattice;
		const base = at(tile(19, -32));
		expect(at(tile(19, -33))).toBe(base);
		expect(at({ ...tile(19, -32), epsg: 32734 })).not.toBe(base);
		expect(at({ ...tile(19, -32), pixelSizeX: 0.0001, pixelSizeY: 0.0001 })).not.toBe(base);
		expect(at(tile(19 + PX / 2, -32))).not.toBe(base);
		// UTM: MGRS tiles of one zone (origins whole 10 m pixels apart) share a lattice.
		const utm = (x: number, y: number) => at({ epsg: 32734, originX: x, originY: y, pixelSizeX: 10, pixelSizeY: 10 });
		expect(utm(600000, 6500040)).toBe(utm(690240, 6400020));
	});
});

/** A 4 × 1 strip of inside pixels on lattice `lattice`, at column `col0`, with these classes. */
function view(itemId: string, classes: number[], opts: { col0?: number; lattice?: string; pixels?: false } = {}): SceneView<SceneItem> {
	const mask = new Uint8Array(classes.length).fill(1);
	const t = { inside: classes.length, covered: 0, clear: 0, wet: 0 };
	for (const c of classes) {
		if (c >= PX_COVERED) t.covered++;
		if (c >= PX_DRY) t.clear++;
		if (c === PX_WET) t.wet++;
	}
	const scene: SceneItem = { itemId, date: '2026-05-20', datetime: '2026-05-20T17:33:11.000Z', url: `https://example.test/${itemId}.tif` };
	return {
		scene,
		etag: `"${itemId}"`,
		...observation(t, 100)!,
		...(opts.pixels === false
			? {}
			: { pixels: { lattice: opts.lattice ?? 'L', col0: opts.col0 ?? 0, row0: 0, width: classes.length, height: 1, mask, classes: Uint8Array.from(classes), pixelAreaM2: 100 } })
	};
}

describe('mergeViews', () => {
	it('fills the better view’s off-scene pixels from the other tile, and records the tile that filled them', () => {
		// West tile sees the west half wet, east tile the east half: the dam whole.
		const west = view('a', [PX_WET, PX_WET, PX_OFF, PX_OFF]);
		const east = view('b', [PX_OFF, PX_OFF, PX_DRY, PX_WET]);
		expect(west.pctObserved).toBe(50);
		const got = mergeViews([east, west])!;
		expect(got).toMatchObject({ pctObserved: 100, wetAreaM2: 300, clearPx: 4, coveredPx: 4 });
		// Equal views: the lower item id is the base, the row's upstream key.
		expect(got.scene.itemId).toBe('a');
		expect(got.fills).toEqual([{ scene: east.scene, etag: '"b"' }]);
	});

	it('never replaces a pixel the base saw, even under cloud: only gaps off its scene are filled', () => {
		const base = view('a', [PX_WET, PX_WET, PX_COVERED, PX_OFF]);
		const other = view('b', [PX_DRY, PX_DRY, PX_DRY, PX_DRY]);
		// `other` is the better view here (4 clear): it is the base, and nothing of it is replaced.
		expect(mergeViews([base, other])).toBe(other);
		const cloudy = view('c', [PX_COVERED, PX_COVERED, PX_COVERED, PX_COVERED]);
		const got = mergeViews([view('d', [PX_WET, PX_WET, PX_WET, PX_OFF]), cloudy])!;
		expect(got.scene.itemId).toBe('d');
		// The fourth pixel from the cloudy view: covered, not clear.
		expect(got).toMatchObject({ clearPx: 3, coveredPx: 4, pctObserved: 75 });
	});

	it('fills each gap from the next-best view that has data there', () => {
		const base = view('a', [PX_WET, PX_WET, PX_OFF, PX_OFF]);
		// c (1 clear, 2 covered) is better than b (1 clear, 1 covered): its cloud fills column 2, though b saw it clearly.
		const b = view('b', [PX_OFF, PX_OFF, PX_DRY, PX_OFF]);
		const c = view('c', [PX_OFF, PX_OFF, PX_COVERED, PX_WET]);
		const got = mergeViews([b, c, base])!;
		expect(got).toMatchObject({ scene: { itemId: 'a' }, clearPx: 3, coveredPx: 4, wetAreaM2: 300 });
		expect(got.fills!.map((f) => f.scene.itemId)).toEqual(['c']);
	});

	it('matches pixels by their lattice column, not their place in each view', () => {
		const base = view('a', [PX_WET, PX_WET, PX_OFF, PX_OFF]);
		// A view whose window starts two columns east: its first two pixels are the base's last two.
		const east = view('b', [PX_DRY, PX_WET], { col0: 2 });
		expect(mergeViews([base, east])).toMatchObject({ clearPx: 4, wetAreaM2: 300, pctObserved: 100 });
	});

	it('keeps the better view where views can’t be joined: other lattices, or no pixels', () => {
		const a = view('a', [PX_WET, PX_WET, PX_OFF, PX_OFF], { lattice: 'zone 34' });
		const b = view('b', [PX_OFF, PX_OFF, PX_DRY, PX_DRY], { lattice: 'zone 35' });
		expect(mergeViews([a, b])).toBe(a);
		const c = view('c', [PX_OFF, PX_OFF, PX_WET, PX_WET], { pixels: false });
		expect(mergeViews([c, view('d', [PX_DRY, PX_OFF, PX_OFF, PX_OFF])])).toBe(c);
		expect(mergeViews([])).toBeNull();
	});

	it('is the base itself when nothing filled a pixel', () => {
		const a = view('a', [PX_WET, PX_WET, PX_DRY, PX_OFF]);
		const b = view('b', [PX_WET, PX_OFF, PX_OFF, PX_OFF]);
		expect(mergeViews([b, a])).toBe(a);
		expect(better(a, b)).toBe(a);
	});
});
