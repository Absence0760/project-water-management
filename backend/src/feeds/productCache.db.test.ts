// The copy's 0.1° rain products through the cell cache (fromMirror.ts
// fillProductCache, readProductSeries, productVersions; 252, issue #604
// R4-B): a CHIRPS feed's fetch fills era5l for a list of cells and a window
// from the copy, the series is the feeds' arithmetic on the 0.1° cells, a
// second fill reads nothing, a copy without the product writes nothing, and a
// revision of era5l marks its days stale and the next fill replays them,
// logging only the day whose value moved. imerg_late carries each day's
// version.
//
// Reads a private copy of the committed fixture copy (its invented 0.1°
// values, scripts/gen-mirror-fixture.ts inventedRain).
//
// DB test files run one at a time; this one removes every feed, feed job,
// cached cell and mirror row after each test.
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { toEpochDay } from '@water-management/engine/calendar';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { inventedRain, MIRROR_FIXTURE_DIR } from '../../scripts/gen-mirror-fixture.js';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { withoutUser, withUser } from '../db/tx.js';
import { openFinals, readFinalsBlock, writeFinalsYear } from '../mirror/arrays.js';
import { doyIndex, MIRROR_REGION, mirrorCell } from '../mirror/grid.js';
import { readManifest, writeManifest } from '../mirror/manifest.js';
import { openStore } from '../mirror/store.js';
import { productCell, uniqueCells } from './cellCache.js';
import { fillProductCache, productVersions, readProductSeries } from './fromMirror.js';
import { applyMirrorRevision, type MirrorManifest } from './mirrorRevision.js';

const tmp: string[] = [];
afterAll(() => tmp.forEach((d) => rmSync(d, { recursive: true, force: true })));
afterEach(async () => {
	await asOwner('DELETE FROM data_feed');
	await asOwner(`DELETE FROM job WHERE kind IN ('feed_fetch', 'feed_ingest')`);
	for (const t of ['chirps_cell_year', 'chirps_file', 'chirps_cell_stale', 'chirps_revision', 'mirror_change', 'mirror_manifest', 'mirror_copy']) await asOwner(`DELETE FROM ${t}`);
});

function copy() {
	const dir = mkdtempSync(join(tmpdir(), 'wm-product-cache-'));
	tmp.push(dir);
	cpSync(MIRROR_FIXTURE_DIR, dir, { recursive: true });
	return openStore(pathToFileURL(`${dir}/`).href);
}

// A feed's 0.05° cells: two in one 0.1° cell of the fixture's block (weights 1 and 3), one in the 0.1° cell south of it.
const CELLS = [
	{ lat: -20.025, lon: 25.025, weight: 1 },
	{ lat: -20.075, lon: 25.075, weight: 3 },
	{ lat: -20.125, lon: 25.025, weight: 1 }
];
const origin = 'fixtures' as const;
const TODAY = '2026-10-27';
const at = (lat: number, lon: number) => mirrorCell(productCell('era5l', lat, lon), MIRROR_REGION, 0.1);
const rain = (lat: number, lon: number, day: string, salt: number) => {
	const m = at(lat, lon);
	return inventedRain(m.y, m.x, toEpochDay(day), salt);
};
/** The feeds' weighted mean (meanOf: to 0.01 mm) of the invented values. */
const mean = (day: string, salt: number, override?: (lat: number, lon: number) => number | undefined) => {
	const s = CELLS.reduce((a, c) => a + (override?.(c.lat, c.lon) ?? rain(c.lat, c.lon, day, salt)) * c.weight, 0);
	return Math.round((s / CELLS.reduce((a, c) => a + c.weight, 0)) * 100) / 100;
};

/** A CHIRPS feed with a running feed_fetch job (a new one each call): who may fill the cache. */
async function feedJob() {
	const owner = await signUp('ProductCache');
	const pid = (await owner.call('POST', '/projects', { name: 'Product cache' })).body.project.id as string;
	const f = await owner.call('POST', `/projects/${pid}/feeds`, { source: 'chirps', config: { cells: CELLS, startDate: '2024-01-01' } });
	expect(f.status, JSON.stringify(f.body)).toBe(201);
	const feed = f.body.feed.id as string;
	const job = async () => {
		await asOwner(`DELETE FROM job WHERE payload->>'feedId' = $1 AND status = 'queued'`, [feed]);
		await asOwner(`UPDATE job SET status = 'done', finished_at = now(), locked_until = NULL, lease_token = NULL WHERE payload->>'feedId' = $1 AND status = 'running'`, [feed]);
		const id = (
			await asOwner(
				`WITH me AS (SELECT set_config('app.current_user_id', $3::text, false))
				 INSERT INTO job (project_id, kind, acting_user_id, payload) SELECT $1::uuid, 'feed_fetch', $3::uuid, jsonb_build_object('feedId', $2::text) FROM me RETURNING id`,
				[pid, feed, owner.id]
			)
		)[0].id as string;
		await asOwner(`UPDATE job SET status = 'running', locked_until = now() + interval '5 minutes', lease_token = gen_random_uuid(), started_at = now() WHERE id = $1`, [id]);
		return id;
	};
	return { owner, feed, job };
}

describe('the 0.1° products through the cell cache', () => {
	it('fills era5l for a cell list and window, serves the weighted series, and reads nothing the second time', async () => {
		const store = copy();
		const { owner, feed, job } = await feedJob();
		const cells = uniqueCells(CELLS, 'era5l');
		expect(cells).toHaveLength(2);
		const window = { start: '2024-12-30', end: '2025-01-03' };
		const fill = async () => {
			const jobId = await job();
			return withUser(owner.id, (db) => fillProductCache(db, { feedId: feed, jobId, product: 'era5l', cells, window, today: TODAY, store, origin }));
		};
		const first = await fill();
		expect(first.status).toBe('filled');
		expect(first.merged).toBeGreaterThan(0);
		const series = await withUser(owner.id, (db) => readProductSeries(db, 'era5l', CELLS, window, { origin }));
		expect(series).toEqual({
			startDate: '2024-12-30',
			values: ['2024-12-30', '2024-12-31', '2025-01-01', '2025-01-02', '2025-01-03'].map((d) => mean(d, 1)),
			prelimDays: 0,
			finalThrough: '2025-01-03'
		});
		// The rows are the 0.1° cells, final, tagged as the copy's.
		expect(await asOwner(`SELECT DISTINCT product, row_idx, col_idx FROM chirps_cell_year ORDER BY row_idx`)).toEqual(cells.map((c) => ({ product: 'era5l', row_idx: c.row, col_idx: c.col })));
		expect(await asOwner(`SELECT DISTINCT tag FROM chirps_file WHERE product = 'era5l'`)).toEqual([{ tag: 'mirror' }]);
		// Everything is cached final: nothing to read.
		expect(await fill()).toEqual({ status: 'cached', merged: 0, revised: 0 });
	});

	it('writes nothing while the copy has no such product, and only from a CHIRPS feed’s running fetch', async () => {
		const { owner, feed, job } = await feedJob();
		const empty = openStore(pathToFileURL(`${mkdtempSync(join(tmpdir(), 'wm-empty-'))}/`).href);
		const cells = uniqueCells(CELLS, 'imerg_late');
		const window = { start: '2026-02-01', end: '2026-02-02' };
		let jobId = await job();
		expect(await withUser(owner.id, (db) => fillProductCache(db, { feedId: feed, jobId, product: 'imerg_late', cells, window, today: TODAY, store: empty, origin }))).toEqual({
			status: 'not_ready',
			merged: 0,
			revised: 0
		});
		expect(await asOwner('SELECT count(*)::int AS n FROM chirps_cell_year')).toEqual([{ n: 0 }]);
		// No running job of the feed: refused (positive control: the same call with one fills).
		await asOwner(`UPDATE job SET status = 'done', finished_at = now(), locked_until = NULL, lease_token = NULL WHERE id = $1`, [jobId]);
		await expect(withUser(owner.id, (db) => fillProductCache(db, { feedId: feed, jobId, product: 'imerg_late', cells, window, today: TODAY, store: copy(), origin }))).rejects.toMatchObject({
			code: '42501'
		});
		jobId = await job();
		expect((await withUser(owner.id, (db) => fillProductCache(db, { feedId: feed, jobId, product: 'imerg_late', cells, window, today: TODAY, store: copy(), origin }))).status).toBe('filled');
		// Each day's IMERG version, read back by any signed-in session.
		const other = await signUp('ProductCacheReader');
		expect(await withUser(other.id, (db) => productVersions(db, 'imerg_late', { start: '2026-01-31', end: '2026-02-03' }, { origin }))).toEqual([null, 'V07', 'V07', null]);
		expect((await withUser(other.id, (db) => readProductSeries(db, 'imerg_late', CELLS, window, { origin }))).values).toEqual([mean('2026-02-01', 2), mean('2026-02-02', 2)]);
	});

	it('a revision of era5l marks its days stale; the next fill reads them again and logs only the day that changed', async () => {
		const store = copy();
		const { owner, feed, job } = await feedJob();
		const cells = uniqueCells(CELLS, 'era5l');
		const window = { start: '2025-03-01', end: '2025-03-05' };
		const fill = async () => {
			const jobId = await job();
			return withUser(owner.id, (db) => fillProductCache(db, { feedId: feed, jobId, product: 'era5l', cells, window, today: TODAY, store, origin }));
		};
		const manifest = (await readManifest(store, 'era5l'))!;
		// The cache's first manifest of era5l: the baseline over an empty cache marks nothing.
		expect(await withoutUser((db) => applyMirrorRevision(db, origin, 'era5l', manifest as MirrorManifest))).toMatchObject({ revision: 1, applied: true, marked: 0 });
		expect((await fill()).status).toBe('filled');

		// The copy revises 2025-03-02 (the first cell's 0.1° cell to 42.5 mm) and lists 2–3 March as changed.
		const f = (await openFinals(store, 'era5l'))!;
		const m = at(CELLS[0]!.lat, CELLS[0]!.lon);
		const block = { y0: m.y, x0: m.x, h: 1, w: 1 };
		const year = await readFinalsBlock(f, 2025, 0, 365, block);
		year.values[doyIndex('2025-03-02')] = 42.5;
		await writeFinalsYear(f, 2025, block, year.values);
		const revised = { ...manifest, revision: 2, changes: [{ revision: 2, days: ['2025-03-02', '2025-03-03'] as [string, string], cellsChanged: 1, maxAbsDiff: 40 }] };
		await writeManifest(store, revised);
		expect(await withoutUser((db) => applyMirrorRevision(db, origin, 'era5l', revised as MirrorManifest))).toMatchObject({ revision: 2, applied: true, marked: 4 });
		expect(await asOwner(`SELECT to_char(day, 'YYYY-MM-DD') AS day, count(*)::int AS n FROM chirps_cell_stale WHERE product = 'era5l' GROUP BY day ORDER BY day`)).toEqual([
			{ day: '2025-03-02', n: 2 },
			{ day: '2025-03-03', n: 2 }
		]);

		// The next fill replays them: one day logged (its value moved), the stale marks cleared, the series follows.
		expect(await fill()).toMatchObject({ status: 'filled', revised: 1 });
		expect(await asOwner(`SELECT product, to_char(day, 'YYYY-MM-DD') AS day, cells_changed FROM chirps_revision`)).toEqual([{ product: 'era5l', day: '2025-03-02', cells_changed: 1 }]);
		expect(await asOwner(`SELECT count(*)::int AS n FROM chirps_cell_stale`)).toEqual([{ n: 0 }]);
		const series = await withUser(owner.id, (db) => readProductSeries(db, 'era5l', CELLS, window, { origin }));
		const moved = productCell('era5l', CELLS[0]!.lat, CELLS[0]!.lon);
		expect(series.values[1]).toBe(
			mean('2025-03-02', 1, (lat, lon) => {
				const c = productCell('era5l', lat, lon);
				return c.row === moved.row && c.col === moved.col ? 42.5 : undefined;
			})
		);
		expect(series.values[2]).toBe(mean('2025-03-03', 1));
	});
});
