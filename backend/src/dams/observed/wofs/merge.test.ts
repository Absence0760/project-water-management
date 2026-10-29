// Joining one date's views of a dam (merge.ts) and placing a view's pixels on
// its grid's lattice (sum.ts viewPixels).
import { describe, expect, it } from 'vitest';
import { outlineMask, type MaskGrid, type OutlineMask } from '../../../raster/mask.js';
import { fromUtm } from '../../../raster/utm.js';
import { better, lookupOn, mergeViews, type SceneView } from './merge.js';
import type { SceneItem } from './stac.js';
import { observation, PX_COVERED, PX_DRY, PX_OFF, PX_WET, viewPixels, type ViewPixels } from './sum.js';

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
		expect(a.grid).toEqual({ epsg: 4326, pixelSizeX: PX, pixelSizeY: PX, fracX: 0, fracY: 0 });
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
		// The grid as numbers: 200 020 m is 6 667⅓ pixels of 30 m: a third of a pixel off the whole-pixel lattice.
		expect(viewPixels({ epsg: 32635, originX: 200020, originY: -3310020, pixelSizeX: 30, pixelSizeY: 30 }, m, Uint8Array.of(0)).grid).toEqual({
			epsg: 32635,
			pixelSizeX: 30,
			pixelSizeY: 30,
			fracX: 0.333,
			fracY: 0
		});
	});
});

/** A 4 × 1 strip of inside pixels on lattice `lattice`, at column `col0`, with these classes. */
function view(itemId: string, classes: number[], opts: { col0?: number; lattice?: string; epsg?: number; pixels?: false } = {}): SceneView<SceneItem> {
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
			: {
					pixels: {
						lattice: opts.lattice ?? 'L',
						grid: { epsg: opts.epsg ?? 4326, pixelSizeX: PX, pixelSizeY: PX, fracX: 0, fracY: 0 },
						col0: opts.col0 ?? 0,
						row0: 0,
						width: classes.length,
						height: 1,
						mask,
						classes: Uint8Array.from(classes),
						pixelAreaM2: 100
					}
				})
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

	it('keeps the better view where views can’t be joined: two geographic lattices, or no pixels', () => {
		// Two EPSG:4326 lattices (another pixel size, or a sub-pixel origin): only UTM views are joined across lattices.
		const a = view('a', [PX_WET, PX_WET, PX_OFF, PX_OFF], { lattice: '4326/a' });
		const b = view('b', [PX_OFF, PX_OFF, PX_DRY, PX_DRY], { lattice: '4326/b' });
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

// A dam across the zone 34 / 35 line at 24° E, 30° S, seen on one date by a
// zone 34 Landsat-like scene west of the line and a zone 35 one east of it
// (30 m pixels, DE Africa's north codes with negative northings; the zone 35
// grid's origin is a third of a pixel off, so no pixel lines up with
// anything but by the projection).
describe('mergeViews across two UTM zones', () => {
	// An ellipse ~1.2 km east–west and ~0.67 km north–south centred on the zone line: ~690 pixels of 30 m.
	const ring: number[][] = [];
	for (let i = 0; i <= 48; i++) {
		const t = (2 * Math.PI * (i % 48)) / 48;
		ring.push([24 + 0.006 * Math.cos(t), -30 + 0.003 * Math.sin(t)]);
	}
	const dam = { type: 'Polygon' as const, coordinates: [ring] };
	const zone34: MaskGrid = { epsg: 32634, originX: 780000, originY: -3310000, pixelSizeX: 30, pixelSizeY: 30 };
	const zone35: MaskGrid = { epsg: 32635, originX: 200020, originY: -3310020, pixelSizeX: 30, pixelSizeY: 30 };
	/** The water: the dam's southern part, south of 29.9995° S (a shoreline the zone line crosses). */
	const wetAt = (lat: number) => lat < -29.9995;

	/** One scene's view: each inside pixel classified by `see` from its centre (PX_OFF where the scene has no data). */
	function zoneView(itemId: string, grid: MaskGrid, see: (lon: number, lat: number) => number): SceneView<SceneItem> {
		const m = outlineMask(dam, grid);
		const classes = new Uint8Array(m.width * m.height);
		const t = { inside: m.inside, covered: 0, clear: 0, wet: 0 };
		for (let r = 0; r < m.height; r++) {
			for (let c = 0; c < m.width; c++) {
				if (!m.mask[r * m.width + c]) continue;
				const g = fromUtm(grid.originX + (m.col0 + c + 0.5) * grid.pixelSizeX, grid.originY - (m.row0 + r + 0.5) * grid.pixelSizeY, grid.epsg);
				const v = see(g.lon, g.lat);
				classes[r * m.width + c] = v;
				if (v >= PX_COVERED) t.covered++;
				if (v >= PX_DRY) t.clear++;
				if (v === PX_WET) t.wet++;
			}
		}
		const scene: SceneItem = { itemId, date: '2026-05-20', datetime: '2026-05-20T08:10:00.000Z', url: `https://example.test/${itemId}.tif` };
		return { scene, ...observation(t, m.pixelAreaM2)!, pixels: viewPixels(grid, m, classes) };
	}
	/** Clear but for at most one pixel a row (the seam), and 98 % observed or more. */
	const expectSeamOnly = (v: SceneView<SceneItem>) => {
		const p = v.pixels!;
		const inside = p.mask.reduce((n, x) => n + x, 0);
		expect(inside - v.clearPx).toBeLessThanOrEqual(p.height);
		expect(v.pctObserved).toBeGreaterThanOrEqual(98);
	};
	const clearly = (lat: number) => (wetAt(lat) ? PX_WET : PX_DRY);
	/** What one scene seeing the whole dam clearly on zone 34's grid would give: the truth the join is held to. */
	const whole = zoneView('whole', zone34, (_lon, lat) => clearly(lat));

	it('joins a dam seen half by each zone into one ~100 % observed view, with the wet area of a whole view', () => {
		const west = zoneView('LC08_west', zone34, (lon, lat) => (lon < 24 ? clearly(lat) : PX_OFF));
		const east = zoneView('LC08_east', zone35, (lon, lat) => (lon >= 24 ? clearly(lat) : PX_OFF));
		expect(west.pctObserved).toBeGreaterThan(40);
		expect(west.pctObserved).toBeLessThan(60);
		expect(east.pctObserved).toBeLessThan(60);
		const got = mergeViews([east, west])!;
		const base = better(west, east);
		expect(got.scene).toBe(base.scene);
		expect(got.fills!.map((f) => f.scene.itemId)).toEqual([(base === west ? east : west).scene.itemId]);
		// Resampling loses at most a pixel a row along the seam (a base pixel whose centre falls in one of the other
		// view's pixels off its scene, though that pixel's other half was seen): 98 % or more here, never past 100.
		expectSeamOnly(got);
		expect(got.pctObserved).toBeLessThanOrEqual(100);
		// The counts stay in the base's pixels at the base's ground area (its zone's k), whichever zone that is.
		const p = got.pixels!;
		expect(p.pixelAreaM2).toBe(base.pixels!.pixelAreaM2);
		const wetPx = [...p.classes].filter((v, i) => p.mask[i] && v === PX_WET).length;
		expect(got.wetAreaM2).toBeCloseTo(wetPx * p.pixelAreaM2, 1);
		// The wet area agrees with a whole view's to 1 %: nearest neighbour moves the shoreline by under a pixel where it
		// crosses the zone line, and the two grids cut the outline's edge differently.
		expect(Math.abs(got.wetAreaM2 - whole.wetAreaM2) / whole.wetAreaM2).toBeLessThan(0.01);
		expect(got.wetAreaM2).toBeGreaterThan(0.3 * whole.wetAreaM2 + 0.3 * whole.wetAreaM2);
	});

	it('takes the other zone into whichever view is the base, west or east', () => {
		// The east scene sees a little more: it is the base, and the west fills it.
		const west = zoneView('a_west', zone34, (lon, lat) => (lon < 23.999 ? clearly(lat) : PX_OFF));
		const east = zoneView('b_east', zone35, (lon, lat) => (lon >= 23.999 ? clearly(lat) : PX_OFF));
		const got = mergeViews([west, east])!;
		expect(got.scene.itemId).toBe('b_east');
		expect(got.pixels!.grid.epsg).toBe(32635);
		expectSeamOnly(got);
		expect(Math.abs(got.wetAreaM2 - whole.wetAreaM2) / whole.wetAreaM2).toBeLessThan(0.01);
	});

	it('never replaces a pixel the base saw, even under cloud, from the other zone', () => {
		// The base sees past the line to 24.004° E, with a cloud over 23.999–24.001° E; the east scene sees from the line clearly.
		const west = zoneView('a_west', zone34, (lon, lat) => (lon >= 24.004 ? PX_OFF : lon >= 23.999 && lon < 24.001 ? PX_COVERED : clearly(lat)));
		const east = zoneView('b_east', zone35, (lon, lat) => (lon >= 24 ? clearly(lat) : PX_OFF));
		expect(better(west, east)).toBe(west);
		const got = mergeViews([east, west])!;
		expect(got.scene.itemId).toBe('a_west');
		const before: ViewPixels = west.pixels!;
		const after = got.pixels!;
		let filled = 0;
		for (let i = 0; i < before.classes.length; i++) {
			if (!before.mask[i]) continue;
			if (before.classes[i] !== PX_OFF) expect(after.classes[i]).toBe(before.classes[i]);
			else if (after.classes[i] !== PX_OFF) filled++;
		}
		expect(filled).toBeGreaterThan(0);
		// Everything is covered; the cloud's pixels stay not clear.
		const cloud = [...before.classes].filter((v, i) => before.mask[i] && v === PX_COVERED).length;
		expect(cloud).toBeGreaterThan(0);
		expect(got.coveredPx).toBeGreaterThanOrEqual(Math.floor(0.99 * before.classes.filter((_, i) => before.mask[i]).length));
		expect(got.clearPx).toBe(got.coveredPx - cloud);
	});

	it('leaves gaps no zone saw: a scene off the dam fills nothing', () => {
		const west = zoneView('a_west', zone34, (lon, lat) => (lon < 24 ? clearly(lat) : PX_OFF));
		// The east scene's footprint starts 24.003° E: the strip between stays unseen.
		const east = zoneView('b_east', zone35, (lon, lat) => (lon >= 24.003 ? clearly(lat) : PX_OFF));
		const got = mergeViews([east, west])!;
		expect(got.pctObserved).toBeLessThan(95);
		expect(got.pctObserved).toBeGreaterThan(west.pctObserved);
	});
});

describe('lookupOn', () => {
	/** A one-row view on a 30 m UTM grid of zone 34 whose origin is `fracX` of a pixel off, inside where `mask` is 1. */
	const strip = (lattice: string, fracX: number, mask: number[], classes: number[]): ViewPixels => ({
		lattice,
		grid: { epsg: 32734, pixelSizeX: 30, pixelSizeY: 30, fracX, fracY: 0 },
		col0: 26000,
		row0: -223000,
		width: mask.length,
		height: 1,
		mask: Uint8Array.from(mask),
		classes: Uint8Array.from(classes),
		pixelAreaM2: 900
	});
	// p's pixel 26002 has its centre 26002.5 pixels east; on q's lattice (0.4 of a pixel on) that is 26002.1, in q's
	// pixel 26002 (its centre 0.4 of a pixel away; 26001's is 0.6).
	const p = strip('p', 0, [1, 1, 1, 1, 1], [PX_OFF, PX_OFF, PX_OFF, PX_OFF, PX_OFF]);

	it('takes the class of the other view’s pixel the point falls in', () => {
		const q = strip('q', 0.4, [1, 1, 1, 1, 1], [PX_DRY, PX_DRY, PX_WET, PX_DRY, PX_DRY]);
		expect(lookupOn(p, q)(26002, -223000)).toBe(PX_WET);
	});

	it('takes the nearest of the other view’s outline pixels within a pixel where that one is outside its outline', () => {
		const q = strip('q', 0.4, [1, 1, 0, 0, 0], [PX_DRY, PX_WET, PX_OFF, PX_OFF, PX_OFF]);
		expect(lookupOn(p, q)(26002, -223000)).toBe(PX_WET);
		// Past one pixel, nothing: p's 26003 is 1.6 pixels from q's nearest outline pixel's centre.
		expect(lookupOn(p, q)(26003, -223000)).toBe(PX_OFF);
	});

	it('never looks past a pixel the other view has no data for: off its scene is not seen', () => {
		const q = strip('q', 0.4, [1, 1, 1, 1, 1], [PX_DRY, PX_WET, PX_OFF, PX_OFF, PX_OFF]);
		expect(lookupOn(p, q)(26002, -223000)).toBe(PX_OFF);
	});

	it('reads one lattice directly', () => {
		const q = strip('p', 0, [1, 1, 1, 1, 1], [PX_DRY, PX_DRY, PX_COVERED, PX_DRY, PX_DRY]);
		expect(lookupOn(p, q)(26002, -223000)).toBe(PX_COVERED);
		expect(lookupOn(p, q)(26009, -223000)).toBe(PX_OFF);
	});
});
