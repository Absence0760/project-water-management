import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { pointInRing } from '../geo/geojson.js';
import { configuredWater, TRACE_METHOD_VERSION, traceDam, TraceRefused } from './damTrace.js';
import { openDem } from './dem.js';
import { DAM_CLICK, DAM_NEAR_CLICK, DRY_CLICK, fixtureOccurrence, LAKE_CLICK, WATER_FIXTURE_CELLS, WATER_FIXTURE_FILE, WATER_FIXTURE_ZOOM, waterLonLat } from './waterFixture.js';

// Against the committed synthetic water occurrence raster (backend/fixtures/
// water/, waterFixture.ts): a dam with a seldom-wet edge and an island, a
// thin stream to a pond, and a lake the raster's edge cuts off.
const water = openDem(fileURLToPath(WATER_FIXTURE_FILE));

async function refusal(p: Promise<unknown>): Promise<TraceRefused> {
	const e = await p.then(
		() => null,
		(err: unknown) => err
	);
	expect(e).toBeInstanceOf(TraceRefused);
	return e as TraceRefused;
}

/** The cells the fixture says are wet at a share, connected to (x, y) by edges, with enclosed dry cells filled: what a trace should find. */
function expectedCells(x: number, y: number, min: number): number {
	const n = WATER_FIXTURE_CELLS;
	const mask = new Uint8Array(n * n);
	const stack = [y * n + x];
	mask[y * n + x] = 1;
	while (stack.length) {
		const i = stack.pop()!;
		const cx = i % n;
		const cy = (i - cx) / n;
		for (const [nx, ny] of [
			[cx - 1, cy],
			[cx + 1, cy],
			[cx, cy - 1],
			[cx, cy + 1]
		]) {
			const j = ny! * n + nx!;
			if (nx! >= 0 && ny! >= 0 && nx! < n && ny! < n && !mask[j] && fixtureOccurrence(nx!, ny!) >= min) {
				mask[j] = 1;
				stack.push(j);
			}
		}
	}
	let c = 0;
	for (const m of mask) c += m;
	return c;
}

describe('traceDam (synthetic water occurrence)', () => {
	it('outlines the dam at the default share (25 %): its edge in, a valid polygon round the click, the method recorded', async () => {
		const t = await traceDam(water, DAM_CLICK);
		expect(t.minOccurrence).toBe(25);
		expect(t.cells).toBe(expectedCells(144, 330, 25));
		expect(t.geometry.coordinates).toHaveLength(1);
		const ring = t.geometry.coordinates[0]!;
		expect(ring[0]).toEqual(ring.at(-1));
		expect(pointInRing(DAM_CLICK, ring)).toBe(true);
		// The island is filled: an outline has no holes, and the island's middle is inside.
		expect(pointInRing(waterLonLat(153.5, 330.5), ring)).toBe(true);
		// The polygon's area is the cells' (with the island) within a few percent: simplification and the chamfer move it a little.
		const cellM2 = t.cellSizeM * t.cellSizeM;
		expect(Math.abs(t.areaM2 / ((t.cells + 13) * cellM2) - 1)).toBeLessThan(0.08);
		expect(t.snapDistanceM).toBeLessThan(0.1);
		expect(t.zoom).toBe(WATER_FIXTURE_ZOOM);
		expect(t.methodVersion).toBe(TRACE_METHOD_VERSION);
		expect(t.method).toMatch(/at least 25 % of the observations/);
		expect(t.dataset.label).toMatch(/Synthetic water occurrence/);
	});

	it('takes only the often-wet middle at 50 %, and joins the stream and the pond at 10 %', async () => {
		const half = await traceDam(water, DAM_CLICK, 50);
		const quarter = await traceDam(water, DAM_CLICK, 25);
		const tenth = await traceDam(water, DAM_CLICK, 10);
		expect(half.cells).toBe(expectedCells(144, 330, 50));
		expect(half.areaM2).toBeLessThan(quarter.areaM2 * 0.7);
		expect(tenth.cells).toBe(expectedCells(144, 330, 10));
		expect(tenth.cells).toBeGreaterThan(quarter.cells + 33);
		// The pond is inside the 10 % outline only.
		const pond = waterLonLat(150.5, 377.5);
		expect(pointInRing(pond, tenth.geometry.coordinates[0]!)).toBe(true);
		expect(pointInRing(pond, quarter.geometry.coordinates[0]!)).toBe(false);
	});

	it('moves a click just off the water onto it, and says how far', async () => {
		const t = await traceDam(water, DAM_NEAR_CLICK);
		expect(t.cells).toBe(expectedCells(144, 330, 25));
		expect(t.snapDistanceM).toBeGreaterThan(0);
		// TRACE_SNAP_M in whole cells (60 m is two 32 m cells here).
		expect(t.snapDistanceM).toBeLessThanOrEqual(2 * t.cellSizeM + 0.1);
	});

	it('refuses dry land, a lake the data cuts off, and a point outside the data, each with its reason', async () => {
		expect((await refusal(traceDam(water, DRY_CLICK))).code).toBe('no_water');
		const lake = await refusal(traceDam(water, LAKE_CLICK));
		expect(lake.code).toBe('no_data');
		expect(lake.message).toMatch(/edge of the water occurrence data/);
		expect((await refusal(traceDam(water, [25, -30]))).code).toBe('outside');
	});

	it('is off without WATER_URL, and opens the raster it names', () => {
		expect(configuredWater({})).toBeNull();
		expect(configuredWater({ WATER_URL: '  ' })).toBeNull();
		expect(configuredWater({ WATER_URL: fileURLToPath(WATER_FIXTURE_FILE) })).not.toBeNull();
	});
});

describe('the e2e copy of the fixture’s points', () => {
	it('matches the fixture (e2e/support/water.ts can’t import backend source)', () => {
		const text = readFileSync(new URL('../../../e2e/support/water.ts', import.meta.url), 'utf8');
		const pair = (name: string) => JSON.parse(new RegExp(`${name}: \\[number, number\\] = (\\[[^\\]]+\\])`).exec(text)![1]!);
		expect(pair('WATER_DAM')).toEqual(DAM_CLICK);
		expect(pair('WATER_DRY')).toEqual(DRY_CLICK);
	});
});
