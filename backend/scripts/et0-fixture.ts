// The committed copy's reference evapotranspiration (issue #604 R5-E):
// `agera5_et0` (finals layout, 2025-01-01 to 2025-12-31, one file per CDS
// month request as ingest/agera5.py writes them, each holding its month's
// days) and `power_et0` (daily layout, 2025-12-01 to 2026-02-06 through
// prelimThrough, a file a day as ingest/nasapower.py writes them), over the
// 4 × 4 block of 0.1° cells fromMirrorEt0.ts ET0_FIXTURE names, as the copy
// stood on its `today`. Called by gen-mirror-fixture.ts (pnpm
// gen:mirror-fixture), so src/mirror/fixture.test.ts covers it too. No real
// place or measurement: a smooth seasonal curve (high in January, the
// southern summer) plus a fixed step per cell, and POWER's a tenth above
// AgERA5's, so a test can tell which product a day came from.
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import { ET0_FIXTURE } from '../src/feeds/fromMirrorEt0.js';
import { type Block, ensureDaily, ensureFinals, writeDailyDays, writeFinalsYear } from '../src/mirror/arrays.js';
import { dateOfDoy, gridOf, isLeapYear, MIRROR_REGION, PRODUCT_GRIDS, regionSize } from '../src/mirror/grid.js';
import { manifestHash, writeManifest } from '../src/mirror/manifest.js';
import type { MirrorStore } from '../src/mirror/store.js';

/** What the fixture holds. */
export const ET0_FIXTURE_HOLDS = {
	agera5: { year: 2025, finalThrough: '2025-12-31' },
	power: { first: '2025-12-01', through: '2026-02-06' }
} as const;

/** The fixture's AgERA5 reference ET on a day at a cell (i north, j east within the block), mm/day. */
export function et0FixtureValue(day: string, i: number, j: number, product: 'agera5' | 'power'): number {
	const doy = toEpochDay(day) - toEpochDay(`${day.slice(0, 4)}-01-01`);
	const v = 4.5 + 2.5 * Math.cos((2 * Math.PI * (doy - 15)) / 365) + 0.1 * i + 0.05 * j;
	return Math.fround(product === 'power' ? v * 1.1 : v);
}

const STEP = 0.1;

/** One day of the region on the 0.1° grid, NaN outside the block: what a file's valuesSha256 hashes. */
function regionDay(block: Block, values: Float32Array): Float32Array {
	const { rows, cols } = regionSize(MIRROR_REGION, STEP);
	const day = new Float32Array(rows * cols).fill(Number.NaN);
	for (let i = 0; i < block.h; i++) day.set(values.subarray(i * block.w, (i + 1) * block.w), (block.y0 + i) * cols + block.x0);
	return day;
}

export async function writeEt0Fixture(store: MirrorStore, fetchedAt = `${ET0_FIXTURE.today}T00:00:00Z`): Promise<void> {
	const block: Block = { ...ET0_FIXTURE.block };
	const n = block.h * block.w;
	const dayValues = (day: string, product: 'agera5' | 'power') => {
		const out = new Float32Array(n);
		for (let i = 0; i < block.h; i++) for (let j = 0; j < block.w; j++) out[i * block.w + j] = et0FixtureValue(day, i, j, product);
		return out;
	};
	const base = { revision: 1, region: { ...MIRROR_REGION }, grid: gridOf(MIRROR_REGION, STEP), changes: [] };

	// agera5_et0: one year chunk; one file per month, each holding exactly its month's days.
	const a = ET0_FIXTURE_HOLDS.agera5;
	const finals = await ensureFinals(store, 'agera5_et0', a.year, { firstYear: PRODUCT_GRIDS.agera5_et0.firstYear });
	const values = new Float32Array(366 * n).fill(Number.NaN);
	const months = new Map<string, Float32Array[]>();
	for (let doy = 0; doy < (isLeapYear(a.year) ? 366 : 365); doy++) {
		const day = dateOfDoy(a.year, doy)!;
		const v = dayValues(day, 'agera5');
		values.set(v, doy * n);
		(months.get(day.slice(0, 7)) ?? months.set(day.slice(0, 7), []).get(day.slice(0, 7))!).push(regionDay(block, v));
	}
	await writeFinalsYear(finals, a.year, block, values);
	await writeManifest(store, {
		...base,
		product: 'agera5_et0',
		years: { first: a.year, last: a.year },
		finalThrough: a.finalThrough,
		prelimThrough: null,
		files: [...months.keys()].sort().map((m) => ({
			url: `cds://sis-agrometeorological-indicators/reference_evapotranspiration/${m}`,
			etag: null,
			lastModified: null,
			size: null,
			valuesSha256: manifestHash(months.get(m)!),
			revision: 1,
			fetchedAt
		}))
	});

	// power_et0: a day at a time, one file a day.
	const p = ET0_FIXTURE_HOLDS.power;
	const count = toEpochDay(p.through) - toEpochDay(p.first) + 1;
	const daily = await ensureDaily(store, 'power_et0', p.first, count);
	const files = [];
	for (let d = 0; d < count; d++) {
		const day = fromEpochDay(toEpochDay(p.first) + d);
		const v = dayValues(day, 'power');
		await writeDailyDays(daily, d, block, v);
		files.push({ url: `power://temporal/daily/regional/fao56-et0/${day}`, etag: null, lastModified: null, size: null, valuesSha256: manifestHash([regionDay(block, v)]), revision: 1, fetchedAt });
	}
	await writeManifest(store, {
		...base,
		product: 'power_et0',
		years: { first: Number(p.first.slice(0, 4)), last: Number(p.through.slice(0, 4)) },
		finalThrough: null,
		prelimThrough: p.through,
		files
	});
}
