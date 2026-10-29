import { describe, expect, it } from 'vitest';
import { outlineMask, sceneWindow, type OutlineGeometry } from '../../../raster/mask.js';
import { toUtm } from '../../../raster/utm.js';
import { openCog } from '../../../raster/cog.js';
import { writeCog } from '../../../raster/cogWrite.js';
import { observation, tally, WOFS_ACCEPT, WOFS_DRY, WOFS_WET } from './sum.js';

const EPSG = 32634;
const P = { lon: 19.05, lat: -33.95 };
const pp = toUtm(P.lon, P.lat, EPSG);
/** A 30 m grid on which P is the exact centre of pixel (100, 100). */
const GRID = { epsg: EPSG, originX: pp.x - 100.5 * 30, originY: pp.y + 100.5 * 30, pixelSizeX: 30, pixelSizeY: 30 };

/** A lon/lat square ring around (lon, lat), `d` degrees from the centre to each side. */
const square = (lon: number, lat: number, d: number) => [
	[lon - d, lat - d],
	[lon + d, lat - d],
	[lon + d, lat + d],
	[lon - d, lat + d],
	[lon - d, lat - d]
];

describe('tally and observation', () => {
	const g: OutlineGeometry = { type: 'Polygon', coordinates: [square(P.lon, P.lat, 0.002)] };

	it('gives no observation for an outline no pixel centre falls inside', () => {
		// ~5 m square, ~15 m (half a pixel) east of P's centre: between centres.
		const m = outlineMask({ type: 'Polygon', coordinates: [square(P.lon + 15 / 92_400, P.lat, 0.00005)] }, GRID);
		expect(m.inside).toBe(0);
		expect(observation(tally(m, sceneWindow(m, { width: 1000, height: 1000 }), new Uint8Array(m.width * m.height)), m.pixelAreaM2)).toBeNull();
	});

	it('counts 128 as clear wet, 0 as clear dry, anything else as not clear', () => {
		const m = outlineMask(g, GRID);
		const win = sceneWindow(m, { width: 1000, height: 1000 })!;
		const w = win.col1 - win.col0 + 1;
		const samples = new Uint8Array(w * (win.row1 - win.row0 + 1));
		// Every inside pixel cycles through: wet, dry, cloud (64), wet under cloud shadow (160), no data (1).
		const cycle = [WOFS_WET, WOFS_DRY, 64, 160, 1];
		let n = 0;
		const want = { wet: 0, clear: 0, nodata: 0 };
		for (let r = 0; r < m.height; r++) {
			for (let c = 0; c < m.width; c++) {
				if (!m.mask[r * m.width + c]) continue;
				const v = cycle[n++ % cycle.length]!;
				samples[(m.row0 + r - win.row0) * w + (m.col0 + c - win.col0)] = v;
				if (v === WOFS_WET) want.wet++;
				if (v === WOFS_WET || v === WOFS_DRY) want.clear++;
				if (v === 1) want.nodata++;
			}
		}
		// Outside the outline: wet everywhere it isn't set, which must not count.
		for (let i = 0; i < samples.length; i++) if (samples[i] === 0 && !insideAt(i)) samples[i] = WOFS_WET;
		function insideAt(i: number) {
			const r = Math.floor(i / w) + win.row0 - m.row0;
			const c = (i % w) + win.col0 - m.col0;
			return m.mask[r * m.width + c] === 1;
		}
		const t = tally(m, win, samples);
		expect(t).toEqual({ inside: m.inside, covered: m.inside - want.nodata, clear: want.clear, wet: want.wet });
		const o = observation(t, m.pixelAreaM2)!;
		expect(o.wetAreaM2).toBeCloseTo(want.wet * m.pixelAreaM2, 2);
		expect(o.pctObserved).toBeCloseTo((want.clear / m.inside) * 100, 3);
	});

	it('counts the part of the outline off the scene as not clear', () => {
		const m = outlineMask(g, GRID);
		// A scene that ends at column 100: the outline's east half is off it.
		const scene = { width: 101, height: 1000 };
		const win = sceneWindow(m, scene)!;
		expect(win.col1).toBe(100);
		const samples = new Uint8Array((win.col1 - win.col0 + 1) * (win.row1 - win.row0 + 1)).fill(WOFS_WET);
		const t = tally(m, win, samples);
		expect(t.wet).toBe(t.clear);
		expect(t.clear).toBeGreaterThan(0);
		expect(t.clear).toBeLessThan(m.inside);
		// Wholly off the scene: nothing clear at all.
		expect(sceneWindow(m, { width: 50, height: 1000 })).toBeNull();
		expect(tally(m, null, null)).toEqual({ inside: m.inside, covered: 0, clear: 0, wet: 0 });
		expect(observation(tally(m, null, null), m.pixelAreaM2)).toBeNull();
	});

	it('is 0 % observed under cloud, and nothing at all off the footprint', () => {
		const m = outlineMask(g, GRID);
		const win = sceneWindow(m, { width: 1000, height: 1000 })!;
		const n = (win.col1 - win.col0 + 1) * (win.row1 - win.row0 + 1);
		expect(observation(tally(m, win, new Uint8Array(n).fill(64)), m.pixelAreaM2)).toEqual({ wetAreaM2: 0, pctObserved: 0, clearPx: 0, coveredPx: m.inside });
		expect(observation(tally(m, win, new Uint8Array(n).fill(1)), m.pixelAreaM2)).toBeNull();
	});
});

describe('WOFS_ACCEPT', () => {
	const open = (bytes: Uint8Array) => openCog(async (a, b) => bytes.subarray(a, b + 1), WOFS_ACCEPT);
	const base = { width: 32, height: 32, tile: 32, epsg: EPSG, originX: 300_000, originY: -3_700_000 };

	it('reads a WOfS scene and refuses another sample type, a geographic grid or a scale', async () => {
		expect(await open(writeCog({ ...base, values: new Uint8Array(32 * 32) }))).toMatchObject({ sampleType: 'uint8', crs: 'utm' });
		await expect(open(writeCog({ ...base, values: new Uint16Array(32 * 32) }))).rejects.toThrow(/uint16, not uint8/);
		await expect(open(writeCog({ ...base, values: new Uint8Array(32 * 32), epsg: 4326, originX: 19, originY: -33, pixelSize: 1 / 1024 }))).rejects.toThrow(/geographic coordinates/);
		await expect(open(writeCog({ ...base, values: new Uint8Array(32 * 32), scaleOffset: { scale: 2, offset: 0 } }))).rejects.toThrow(/scale or offset/);
	});
});
