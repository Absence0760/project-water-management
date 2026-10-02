// Writes the synthetic water occurrence raster tracing a dam is tested
// against (backend/fixtures/water/synthetic-water.pmtiles; the water is
// defined in src/delineation/waterFixture.ts): Terrarium-encoded PNG tiles
// whose "height" is the occurrence in percent, in a PMTiles archive, the
// format bin/tiles-dev.sh water writes from JRC Global Surface Water.
// Invented water only. Deterministic: re-running it rewrites the same bytes.
//
//   pnpm -C backend gen:water-fixture
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { writePmtiles } from '../src/delineation/pmtiles.js';
import { encodePng } from '../src/delineation/png.js';
import {
	fixtureOccurrence,
	WATER_FIXTURE_BOUNDS,
	WATER_FIXTURE_FILE,
	WATER_FIXTURE_TILE,
	WATER_FIXTURE_TILES,
	WATER_FIXTURE_X0,
	WATER_FIXTURE_Y0,
	WATER_FIXTURE_ZOOM
} from '../src/delineation/waterFixture.js';

/** Terrarium for a whole-percent value: v + 32768 = R·256 + G, so R = 128, G = v, B = 0. */
const pixel = (v: number) => (0xff000000 | (128 << 16) | ((v & 255) << 8)) >>> 0;

/** The fixture's bytes (the test checks the committed file still equals them). */
export function buildWaterFixture(): Buffer {
	const tiles = [];
	for (let ty = 0; ty < WATER_FIXTURE_TILES; ty++) {
		for (let tx = 0; tx < WATER_FIXTURE_TILES; tx++) {
			const argb = new Uint32Array(WATER_FIXTURE_TILE * WATER_FIXTURE_TILE);
			for (let y = 0; y < WATER_FIXTURE_TILE; y++) {
				for (let x = 0; x < WATER_FIXTURE_TILE; x++) argb[y * WATER_FIXTURE_TILE + x] = pixel(fixtureOccurrence(tx * WATER_FIXTURE_TILE + x, ty * WATER_FIXTURE_TILE + y));
			}
			tiles.push({ z: WATER_FIXTURE_ZOOM, x: WATER_FIXTURE_X0 + tx, y: WATER_FIXTURE_Y0 + ty, data: encodePng({ width: WATER_FIXTURE_TILE, height: WATER_FIXTURE_TILE, argb }) });
		}
	}
	return writePmtiles(tiles, {
		tileType: 2,
		bounds: WATER_FIXTURE_BOUNDS,
		metadata: { name: 'Synthetic water occurrence (invented water, water-management test fixture)', version: '1', attribution: 'synthetic' }
	});
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const out = fileURLToPath(WATER_FIXTURE_FILE);
	const archive = buildWaterFixture();
	writeFileSync(out, archive);
	console.log(`Wrote ${out} (${(archive.length / 1024).toFixed(0)} KiB)`);
}
