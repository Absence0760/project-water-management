import { describe, expect, it } from 'vitest';
import { FeedFormatError } from '../feeds/errors.js';
import { openCog, readWindow } from './cog.js';
import { writeCog } from './cogWrite.js';
import { geographicCellAreaM2, outlineMask, sceneWindow, type MaskGrid, type OutlineGeometry } from './mask.js';
import { toUtm } from './utm.js';

const EPSG = 32634;
const P = { lon: 19.05, lat: -33.95 };
const pp = toUtm(P.lon, P.lat, EPSG);
/** A 30 m grid on which P is the exact centre of pixel (100, 100). */
const GRID: MaskGrid = { epsg: EPSG, originX: pp.x - 100.5 * 30, originY: pp.y + 100.5 * 30, pixelSizeX: 30, pixelSizeY: 30 };

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


describe('outlineMask on a geographic (EPSG:4326) grid', () => {
	const D = 1 / 1024;
	/** A WaPOR-like 1/1024° grid on which P is the exact centre of pixel (100, 100). */
	const GEO: MaskGrid = { epsg: 4326, originX: P.lon - 100.5 * D, originY: P.lat + 100.5 * D, pixelSizeX: D, pixelSizeY: D };

	/** Brute force in lon/lat: every pixel centre against every ring, even-odd per polygon, any polygon. */
	function bruteGeo(g: OutlineGeometry) {
		const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
		const inPoly = (rings: number[][][], x: number, y: number) => {
			let inside = false;
			for (const ring of rings) {
				for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
					const [ax, ay] = ring[i] as [number, number];
					const [bx, by] = ring[j] as [number, number];
					if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
				}
			}
			return inside;
		};
		const set = new Set<string>();
		for (let r = 0; r < 220; r++) {
			for (let c = 0; c < 220; c++) {
				const x = GEO.originX + (c + 0.5) * D;
				const y = GEO.originY - (r + 0.5) * D;
				if (polys.some((rings) => inPoly(rings, x, y))) set.add(`${c},${r}`);
			}
		}
		return set;
	}

	it('takes a pixel when its centre is inside, and only then', () => {
		expect([...maskSet({ type: 'Polygon', coordinates: [square(P.lon, P.lat, 0.0003)] }, GEO)]).toEqual(['100,100']);
		// Half a pixel east of P's centre: between centres.
		expect(outlineMask({ type: 'Polygon', coordinates: [square(P.lon + D / 2, P.lat, 0.0001)] }, GEO).inside).toBe(0);
	});

	it('agrees with a brute-force point-in-polygon test: irregular, a hole, a MultiPolygon', () => {
		const ring = [
			[19.0, -33.99],
			[19.06, -34.0],
			[19.09, -33.96],
			[19.07, -33.91],
			// Off P, which is a pixel centre: a vertex exactly on one is a tie the two tests may break differently.
			[19.0503, -33.9497],
			[19.02, -33.9],
			[19.0, -33.99]
		];
		const irregular: OutlineGeometry = { type: 'Polygon', coordinates: [ring] };
		expect(maskSet(irregular, GEO)).toEqual(bruteGeo(irregular));
		const holed: OutlineGeometry = { type: 'Polygon', coordinates: [square(P.lon, P.lat, 0.05), square(P.lon, P.lat, 0.01)] };
		const got = maskSet(holed, GEO);
		expect(got).toEqual(bruteGeo(holed));
		expect(got.has('100,100')).toBe(false);
		const multi: OutlineGeometry = { type: 'MultiPolygon', coordinates: [[square(P.lon - 0.01, P.lat, 0.02)], [square(P.lon + 0.01, P.lat, 0.02)]] };
		expect(maskSet(multi, GEO)).toEqual(bruteGeo(multi));
	});

	it('gives the pixel its ellipsoidal ground area at the outline’s latitude', () => {
		const m = outlineMask({ type: 'Polygon', coordinates: [square(P.lon, P.lat, 0.01)] }, GEO);
		// The exact WGS 84 area of a cell between two latitudes (the authalic integral), against M·N·cos φ·Δφ·Δλ.
		const a = 6_378_137;
		const f = 1 / 298.257223563;
		const e = Math.sqrt(f * (2 - f));
		const g = (deg: number) => {
			const s = Math.sin((deg * Math.PI) / 180);
			return s / (1 - e * e * s * s) + Math.log((1 + e * s) / (1 - e * s)) / (2 * e);
		};
		const exact = (lat: number) => ((a * a * (1 - e * e) * ((D * Math.PI) / 180)) / 2) * Math.abs(g(lat + D / 2) - g(lat - D / 2));
		expect(m.pixelAreaM2 / exact(P.lat) - 1).toBeLessThan(1e-6);
		// ~94 m × ~108 m at 34° S.
		expect(m.pixelAreaM2).toBeGreaterThan(9_000);
		expect(m.pixelAreaM2).toBeLessThan(10_500);
		expect(geographicCellAreaM2(0, 1, 1)).toBeCloseTo(exact(0) * 1024 * 1024, -3);
	});

	it('sums a geographic float32 COG inside an outline, through the reader', async () => {
		// 220 × 220 pixels of GEO, each pixel's value its column + 1000 × its row.
		const values = Float32Array.from({ length: 220 * 220 }, (_, i) => (i % 220) + 1000 * Math.floor(i / 220));
		const bytes = writeCog({ width: 220, height: 220, values, epsg: 4326, originX: GEO.originX, originY: GEO.originY, pixelSize: D, tile: 64, compression: 5, bigTiff: true });
		const read = async (a: number, b: number) => bytes.subarray(a, b + 1);
		const cog = (await openCog(read, { crs: ['geographic'], sampleTypes: ['float32'] }))!;
		const g: OutlineGeometry = { type: 'Polygon', coordinates: [square(P.lon, P.lat, 0.02)] };
		const m = outlineMask(g, cog);
		const win = sceneWindow(m, cog)!;
		const samples = await readWindow(read, cog, win);
		let sum = 0;
		const w = win.col1 - win.col0 + 1;
		for (let r = win.row0; r <= win.row1; r++) for (let c = win.col0; c <= win.col1; c++) if (m.mask[(r - m.row0) * m.width + (c - m.col0)]) sum += samples[(r - win.row0) * w + (c - win.col0)]!;
		let want = 0;
		for (const key of bruteGeo(g)) {
			const [c, r] = key.split(',').map(Number) as [number, number];
			want += c + 1000 * r;
		}
		expect(m.inside).toBe(bruteGeo(g).size);
		expect(sum).toBe(want);
	});
});
