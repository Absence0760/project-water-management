import { describe, expect, it } from 'vitest';
import { FeedFormatError } from '../../../feeds/errors.js';
import { observation, outlineMask, sceneWindow, tally, WOFS_DRY, WOFS_WET, type OutlineGeometry } from './sum.js';
import { toUtm } from './utm.js';

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

/** The pixels inside, by brute force: every centre ray-cast against every ring, even-odd per polygon, any polygon. */
function bruteForce(g: OutlineGeometry, grid = GRID) {
	const polys = (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).map((rings) =>
		rings.map((ring) => ring.map(([lon, lat]) => toUtm(lon!, lat!, grid.epsg)))
	);
	const inPoly = (rings: { x: number; y: number }[][], x: number, y: number) => {
		let inside = false;
		for (const ring of rings) {
			for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
				const a = ring[i]!;
				const b = ring[j]!;
				if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
			}
		}
		return inside;
	};
	const set = new Set<string>();
	for (let r = 0; r < 220; r++) {
		for (let c = 0; c < 220; c++) {
			const x = grid.originX + (c + 0.5) * 30;
			const y = grid.originY - (r + 0.5) * 30;
			if (polys.some((rings) => inPoly(rings, x, y))) set.add(`${c},${r}`);
		}
	}
	return set;
}

const maskSet = (g: OutlineGeometry, grid = GRID) => {
	const m = outlineMask(g, grid);
	const set = new Set<string>();
	for (let r = 0; r < m.height; r++) for (let c = 0; c < m.width; c++) if (m.mask[r * m.width + c]) set.add(`${m.col0 + c},${m.row0 + r}`);
	expect(set.size).toBe(m.inside);
	return set;
};

describe('outlineMask', () => {
	it('takes a pixel when its centre is inside, and only then', () => {
		// ~10 m around P: only P's pixel centre is inside.
		const tiny: OutlineGeometry = { type: 'Polygon', coordinates: [square(P.lon, P.lat, 0.0001)] };
		expect([...maskSet(tiny)]).toEqual(['100,100']);
	});

	it('has no pixels for an outline smaller than a pixel that misses every centre', () => {
		// ~5 m square, ~15 m (half a pixel) east of P's centre: between centres.
		const between: OutlineGeometry = { type: 'Polygon', coordinates: [square(P.lon + 15 / 92_400, P.lat, 0.00005)] };
		const m = outlineMask(between, GRID);
		expect(m.inside).toBe(0);
		expect(observation(tally(m, sceneWindow(m, { width: 1000, height: 1000 }), new Uint8Array(m.width * m.height)), m.pixelAreaM2)).toBeNull();
	});

	it('agrees with a brute-force point-in-polygon test on an irregular outline', () => {
		const ring = [
			[19.04, -33.955],
			[19.052, -33.958],
			[19.061, -33.951],
			[19.055, -33.944],
			[19.049, -33.949],
			[19.043, -33.942],
			[19.04, -33.955]
		];
		const g: OutlineGeometry = { type: 'Polygon', coordinates: [ring] };
		expect(maskSet(g)).toEqual(bruteForce(g));
	});

	it('leaves a hole out', () => {
		const g: OutlineGeometry = { type: 'Polygon', coordinates: [square(P.lon, P.lat, 0.01), square(P.lon, P.lat, 0.002)] };
		const got = maskSet(g);
		expect(got).toEqual(bruteForce(g));
		expect(got.has('100,100')).toBe(false);
		const solid = maskSet({ type: 'Polygon', coordinates: [square(P.lon, P.lat, 0.01)] });
		expect(got.size).toBeLessThan(solid.size);
	});

	it('unions a MultiPolygon, counting an overlap once, and reads an unclosed ring the same', () => {
		const a = square(P.lon - 0.003, P.lat, 0.004);
		const b = square(P.lon + 0.003, P.lat, 0.004);
		const g: OutlineGeometry = { type: 'MultiPolygon', coordinates: [[a], [b]] };
		const got = maskSet(g);
		expect(got).toEqual(bruteForce(g));
		const onlyA = maskSet({ type: 'Polygon', coordinates: [a] });
		const onlyB = maskSet({ type: 'Polygon', coordinates: [b] });
		const overlap = [...onlyA].filter((k) => onlyB.has(k)).length;
		expect(overlap).toBeGreaterThan(0);
		expect(got.size).toBe(onlyA.size + onlyB.size - overlap);
		expect(maskSet({ type: 'Polygon', coordinates: [a.slice(0, -1)] })).toEqual(onlyA);
	});

	it('gives the pixel its ground area: 900 m² over k²', () => {
		const m = outlineMask({ type: 'Polygon', coordinates: [square(P.lon, P.lat, 0.001)] }, GRID);
		// k at the outline's first vertex.
		expect(m.pixelAreaM2).toBeCloseTo(900 / toUtm(P.lon - 0.001, P.lat - 0.001, EPSG).k ** 2, 9);
		expect(Math.abs(m.pixelAreaM2 - 900)).toBeLessThan(0.01);
	});

	it('refuses what is not an outline', () => {
		expect(() => outlineMask({ type: 'Point', coordinates: [1, 2] } as unknown as OutlineGeometry, GRID)).toThrow(FeedFormatError);
		expect(() => outlineMask({ type: 'Polygon', coordinates: [[[19, -34], [19.1, -34]]] }, GRID)).toThrow(/fewer than 3/);
		expect(() => outlineMask({ type: 'Polygon', coordinates: [[[19, -34], [Number.NaN, -34], [19, -34.1]]] }, GRID)).toThrow(/not a number/);
	});
});

describe('tally and observation', () => {
	const g: OutlineGeometry = { type: 'Polygon', coordinates: [square(P.lon, P.lat, 0.002)] };

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
