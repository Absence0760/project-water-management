// The Waterbodies loader's checks (loadWaterbodies.ts waterbodyRecords): what a
// clip of DE Africa's v0.0.3 polygons loads and what it skips. No DB.
import { describe, expect, it } from 'vitest';
import type { Position } from '../../geo/geojson.js';
import { waterbodyRecords } from './loadWaterbodies.js';

/** A 30 m pixel's corner near the Western Cape, at column i, row j. */
const at = (i: number, j: number): Position => [Math.round((19.5 + i * 0.0003) * 1e7) / 1e7, Math.round((-33.9 + j * 0.0003) * 1e7) / 1e7];
const pixel = (i: number, j: number): Position[] => [at(i, j), at(i, j + 1), at(i + 1, j + 1), at(i + 1, j), at(i, j)];
const feature = (uid: string, coordinates: Position[][]) => ({ type: 'Feature', properties: { uid }, geometry: { type: 'Polygon', coordinates } });

describe('waterbodyRecords', () => {
	it('loads a raster-traced waterbody whose islands touch its outline and each other at pixel corners (218 of 15 442 were skipped)', () => {
		// A 6 × 6 dam with a notch of land at the top (pixel 2, 5); an island diagonally below the notch, and a second touching the first.
		const shell = [[0, 0], [6, 0], [6, 6], [3, 6], [3, 5], [2, 5], [2, 6], [0, 6], [0, 0]].map(([i, j]) => at(i!, j!));
		const doc = { type: 'FeatureCollection', features: [feature('k6jb4uqef0', [shell, pixel(3, 4), pixel(4, 3)])] };
		const { records, problems } = waterbodyRecords(doc);
		expect(problems).toEqual([]);
		expect(records.map((r) => r.uid)).toEqual(['k6jb4uqef0']);
		// 35 pixels of water less the two islands, about 920 m² a pixel (0.0003° square) at 34° S.
		expect(records[0]!.areaM2 / 33).toBeGreaterThan(900);
		expect(records[0]!.areaM2 / 33).toBeLessThan(940);
	});

	it('still skips one whose islands touch in a loop, cutting a pixel of water off, with the reason', () => {
		const shell = [[0, 0], [5, 0], [5, 5], [0, 5], [0, 0]].map(([i, j]) => at(i!, j!));
		// Four islands round the water pixel (2, 2), each touching the next at a corner, the loop closed.
		const doc = { type: 'FeatureCollection', features: [feature('k3vg4j1v5s', [shell, pixel(2, 3), pixel(3, 2), pixel(2, 1), pixel(1, 2)])] };
		const { records, problems } = waterbodyRecords(doc);
		expect(records).toEqual([]);
		expect(problems).toEqual([expect.stringMatching(/^feature 1 \(k3vg4j1v5s\): has holes that cut it into pieces/)]);
	});
});
