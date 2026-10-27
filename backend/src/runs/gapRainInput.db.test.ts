// The gap-filling products from the copy to a run (issue #604 R4-B,
// settings.gapRain; feeds/gapRainFill.ts fills the cache on the CHIRPS
// feed's fetch, runs/gapRainInput.ts reads it into the run's input): only
// when the settings ask, only on the fetch of the feed whose cells the runs
// read, ERA5-Land as the feed's weighted mean, IMERG Late split by version,
// and a run that reads them says which product filled each day.
//
// Reads a private copy of the committed fixture copy (its invented 0.1°
// values: era5l 2024–2025, imerg_late 2026-01-25 to 2026-02-08 with V08
// from 2026-02-07; scripts/gen-mirror-fixture.ts).
//
// DB test files run one at a time; this one removes every feed, feed job,
// cached cell and mirror row after each test.
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ERA5L_SERIES_KEY, imergSeriesKey } from '@water-management/engine';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { MIRROR_FIXTURE_DIR } from '../../scripts/gen-mirror-fixture.js';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { openStore } from '../mirror/store.js';
import { productVersions, readProductSeries } from '../feeds/fromMirror.js';
import { fillGapProducts, GAP_FILL_BUDGET_MS, GAP_FILL_MARGIN_MS } from '../feeds/gapRainFill.js';
import { loadModelInput, loadRunInput } from './execute.js';
import { gapRainInputs } from './gapRainInput.js';
import { GAP_VIEW_MAX_DAYS, gapRainProducts } from '../feeds/gapRainView.js';
import { toEpochDay } from '@water-management/engine/calendar';

const daysIn = (w: { start: string; end: string }) => toEpochDay(w.end) - toEpochDay(w.start) + 1;

const tmp: string[] = [];
afterAll(() => tmp.forEach((d) => rmSync(d, { recursive: true, force: true })));
afterEach(async () => {
	await asOwner('DELETE FROM data_feed');
	await asOwner(`DELETE FROM job WHERE kind IN ('feed_fetch', 'feed_ingest')`);
	for (const t of ['chirps_cell_year', 'chirps_file', 'chirps_cell_stale', 'chirps_revision', 'mirror_change', 'mirror_manifest', 'mirror_copy']) await asOwner(`DELETE FROM ${t}`);
});

function copy() {
	return copyAt().store;
}
function copyAt() {
	const dir = mkdtempSync(join(tmpdir(), 'wm-gap-rain-'));
	tmp.push(dir);
	cpSync(MIRROR_FIXTURE_DIR, dir, { recursive: true });
	return { dir, store: openStore(pathToFileURL(`${dir}/`).href) };
}
const lastMeta = async (feed: string) => (await asOwner('SELECT last_meta FROM data_feed WHERE id = $1', [feed]))[0].last_meta as Record<string, unknown> | null;

const CELLS = [
	{ lat: -20.025, lon: 25.025, weight: 1 },
	{ lat: -20.075, lon: 25.075, weight: 3 },
	{ lat: -20.125, lon: 25.025, weight: 1 }
];
const origin = 'fixtures' as const;
const TODAY = '2026-02-10';

/** A project with a CHIRPS feed writing its outlet CHIRPS series (from 2025-11-01) and a catchment rain record, and a running feed_fetch job maker. */
async function project(gapRain: unknown) {
	const owner = await signUp('GapRain');
	const pid = (await owner.call('POST', '/projects', { name: 'Gap rain' })).body.project.id as string;
	const apanMm = new Array(12).fill(150);
	expect((await owner.call('PATCH', `/projects/${pid}`, { settings: { apanMm, calibration: { catchmentAreaKm2: 10 }, ...(gapRain !== undefined ? { gapRain } : {}) } })).status).toBe(200);
	const addFeed = async (cells = CELLS, targetName?: string) => {
		const f = await owner.call('POST', `/projects/${pid}/feeds`, { source: 'chirps', config: { cells, startDate: '2025-11-01' }, ...(targetName ? { targetName } : {}) });
		expect(f.status, JSON.stringify(f.body)).toBe(201);
		return f.body.feed.id as string;
	};
	const feed = await addFeed();
	const chirps = (
		await asOwner(
			`INSERT INTO time_series (project_id, kind, name, unit, start_date, "values", feed_id) VALUES ($1, 'rain_chirps_mm', 'CHIRPS', 'mm', '2025-11-01', '{1,2,3}', $2) RETURNING id`,
			[pid, feed]
		)
	)[0].id as string;
	await asOwner(`INSERT INTO time_series (project_id, kind, name, unit, start_date, "values") VALUES ($1, 'rain_catchment_mm', 'Gauge', 'mm', '2025-11-01', '{1,null,3}')`, [pid]);
	const job = async (feedId = feed) => {
		await asOwner(`UPDATE job SET status = 'done', finished_at = now(), locked_until = NULL, lease_token = NULL WHERE payload->>'feedId' = $1 AND status IN ('queued', 'running')`, [feedId]);
		const id = (
			await asOwner(
				`WITH me AS (SELECT set_config('app.current_user_id', $3::text, false))
				 INSERT INTO job (project_id, kind, acting_user_id, payload) SELECT $1::uuid, 'feed_fetch', $3::uuid, jsonb_build_object('feedId', $2::text) FROM me RETURNING id`,
				[pid, feedId, owner.id]
			)
		)[0].id as string;
		await asOwner(`UPDATE job SET status = 'running', locked_until = now() + interval '5 minutes', lease_token = gen_random_uuid(), started_at = now() WHERE id = $1`, [id]);
		return id;
	};
	return { owner, pid, feed, chirps, job, addFeed };
}

describe('settings.gapRain: the copy to the run', () => {
	it('fills ERA5-Land and IMERG Late on the runs’ CHIRPS feed’s fetch, and the run input reads them, IMERG by version', async () => {
		const store = copy();
		const p = await project({ product: 'chirpsThenEra5l', imergLate: true });
		const jobId = await p.job();
		const outcome = await withUser(p.owner.id, (db) => fillGapProducts(db, { id: p.feed, projectId: p.pid }, { jobId, today: TODAY, store, origin }));
		expect(outcome).toEqual([
			{ product: 'era5l', windows: 1, status: 'ok' },
			{ product: 'imerg_late', windows: 1, status: 'ok' }
		]);
		// Each product's outcome on the feed (254), where GET …/feeds and the Data tab read it.
		expect(await lastMeta(p.feed)).toMatchObject({ gapEra5l: 'ok', gapImergLate: 'ok' });
		const inputs = (await withUser(p.owner.id, (db) => gapRainInputs(db, p.pid, { gapRain: { product: 'chirpsThenEra5l', imergLate: true } }, p.chirps, TODAY)))!;
		expect(Object.keys(inputs).sort()).toEqual([ERA5L_SERIES_KEY, imergSeriesKey('V07'), imergSeriesKey('V08')].sort());
		// ERA5-Land: the feed's weighted mean from the record's first day, as the cache serves it.
		const era5 = await withUser(p.owner.id, (db) => readProductSeries(db, 'era5l', CELLS, { start: '2025-11-01', end: TODAY }, { origin }));
		expect(inputs[ERA5L_SERIES_KEY]).toEqual({ startDate: '2025-11-01', values: era5.values, provenance: { product: 'ERA5-Land', version: 'daily' } });
		expect(era5.values.at(-1)).not.toBeNull();
		// IMERG Late: each version's own days, V07 to 2026-02-06 and V08 from 2026-02-07.
		const v07 = inputs[imergSeriesKey('V07')]!;
		const v08 = inputs[imergSeriesKey('V08')]!;
		expect([v07.startDate, v07.values.length, v07.provenance]).toEqual(['2026-01-25', 13, { product: 'IMERG Late', version: 'V07' }]);
		expect([v08.startDate, v08.values.length]).toEqual(['2026-02-07', 2]);
		const versions = await withUser(p.owner.id, (db) => productVersions(db, 'imerg_late', { start: '2026-01-25', end: '2026-02-08' }, { origin }));
		expect(versions.filter((v) => v === 'V08')).toHaveLength(2);
		// A second fetch reads the one window again: its days past ERA5-Land's last (2025-12-30) wait for the copy.
		const again = await withUser(p.owner.id, async (db) => fillGapProducts(db, { id: p.feed, projectId: p.pid }, { jobId: await p.job(), today: TODAY, store, origin }));
		expect(again.find((o) => o.product === 'era5l')).toEqual({ product: 'era5l', windows: 1, status: 'ok' });
	});

	it('does nothing with CHIRPS alone, nor on another CHIRPS feed’s fetch (the runs’ feed is the positive control)', async () => {
		const store = copy();
		const none = await project(undefined);
		expect(await withUser(none.owner.id, async (db) => fillGapProducts(db, { id: none.feed, projectId: none.pid }, { jobId: await none.job(), today: TODAY, store, origin }))).toEqual([]);
		expect(await withUser(none.owner.id, (db) => gapRainInputs(db, none.pid, {}, none.chirps, TODAY))).toBeNull();
		expect(await asOwner('SELECT count(*)::int AS n FROM chirps_cell_year')).toEqual([{ n: 0 }]);

		const p = await project({ product: 'era5l', imergLate: false });
		const other = await p.addFeed([{ lat: -20.025, lon: 25.025, weight: 1 }], 'Other CHIRPS');
		expect(await withUser(p.owner.id, async (db) => fillGapProducts(db, { id: other, projectId: p.pid }, { jobId: await p.job(other), today: TODAY, store, origin }))).toEqual([]);
		expect(await asOwner('SELECT count(*)::int AS n FROM chirps_cell_year')).toEqual([{ n: 0 }]);
		expect((await withUser(p.owner.id, async (db) => fillGapProducts(db, { id: p.feed, projectId: p.pid }, { jobId: await p.job(), today: TODAY, store, origin })))[0]!.status).toBe('ok');
	});

	it('a copy without the product writes nothing and the run input simply lacks it', async () => {
		const empty = openStore(pathToFileURL(`${mkdtempSync(join(tmpdir(), 'wm-gap-empty-'))}/`).href);
		const p = await project({ product: 'era5l', imergLate: true });
		const out = await withUser(p.owner.id, async (db) => fillGapProducts(db, { id: p.feed, projectId: p.pid }, { jobId: await p.job(), today: TODAY, store: empty, origin }));
		expect(out.map((o) => o.status)).toEqual(['not_ready', 'not_ready']);
		expect(await lastMeta(p.feed)).toMatchObject({ gapEra5l: 'not_ready', gapImergLate: 'not_ready' });
		expect(await withUser(p.owner.id, (db) => gapRainInputs(db, p.pid, { gapRain: { product: 'era5l', imergLate: true } }, p.chirps, TODAY))).toEqual({});
	});

	it('a broken ERA5-Land copy: the fill is rolled back to its savepoint, the CHIRPS days commit, the failure is recorded and the view says so', async () => {
		const { dir, store } = copyAt();
		writeFileSync(join(dir, 'era5l', 'zarr.json'), 'not json');
		const p = await project({ product: 'era5l', imergLate: true });
		const out = await withUser(p.owner.id, async (db) => {
			// The CHIRPS days the same fetch wrote first (fetchFromMirror), in the same transaction.
			await db.query(`UPDATE time_series SET "values" = '{1,2,3,4}' WHERE id = $1`, [p.chirps]);
			return fillGapProducts(db, { id: p.feed, projectId: p.pid }, { jobId: await p.job(), today: TODAY, store, origin });
		});
		// ERA5-Land failed, as the copy's format; IMERG Late, in its own savepoint, still filled (the positive control).
		expect(out).toEqual([
			{ product: 'era5l', windows: 0, status: 'failed', error: 'format' },
			{ product: 'imerg_late', windows: 1, status: 'ok' }
		]);
		expect((await asOwner('SELECT "values" FROM time_series WHERE id = $1', [p.chirps]))[0].values).toEqual([1, 2, 3, 4]);
		expect(await asOwner(`SELECT count(*)::int AS n FROM chirps_cell_year WHERE product = 'era5l'`)).toEqual([{ n: 0 }]);
		expect(await lastMeta(p.feed)).toMatchObject({ gapEra5l: 'failed:format', gapImergLate: 'ok' });
		// The Data tab's data: "couldn't fill ERA5-Land", not "nothing held yet"; GET …/feeds carries it as lastMeta.
		const view = await p.owner.call('GET', `/projects/${p.pid}/feeds/gap-rain`);
		expect(view.status).toBe(200);
		expect(view.body.era5l).toBeNull();
		expect(view.body.fill.era5l).toMatchObject({ status: 'failed', error: 'format' });
		expect(view.body.fill.imergLate).toMatchObject({ status: 'ok', error: null });
		const feeds = (await p.owner.call('GET', `/projects/${p.pid}/feeds`)).body.feeds as { id: string; lastMeta: Record<string, unknown> | null }[];
		expect(feeds.find((f) => f.id === p.feed)!.lastMeta).toMatchObject({ gapEra5l: 'failed:format' });
	});

	it('an unexpected error in the fill is not swallowed: rolled back to its savepoint and thrown, so the fetch fails', async () => {
		const store = copy();
		const broken = { get: async (key: string, o?: unknown) => (key.startsWith('/era5l/') ? Promise.reject(new Error('a bug')) : store.get(key as never, o as never)), set: store.set.bind(store) } as typeof store;
		const p = await project({ product: 'era5l', imergLate: false });
		await expect(
			withUser(p.owner.id, async (db) => {
				await db.query(`UPDATE time_series SET "values" = '{9}' WHERE id = $1`, [p.chirps]);
				return fillGapProducts(db, { id: p.feed, projectId: p.pid }, { jobId: await p.job(), today: TODAY, store: broken, origin });
			})
		).rejects.toThrow('a bug');
		// The job's transaction rolled back whole: nothing recorded, the job retries.
		expect((await asOwner('SELECT "values" FROM time_series WHERE id = $1', [p.chirps]))[0].values).toEqual([1, 2, 3]);
		expect((await lastMeta(p.feed))?.gapEra5l).toBeUndefined();
	});

	it('stops in time: past its budget or the job’s deadline it leaves the older windows for the next fetch, which reads them', async () => {
		const store = copy();
		const p = await project({ product: 'era5l', imergLate: false });
		// A record from 2023: four year-long windows back from TODAY.
		await asOwner(`UPDATE time_series SET start_date = '2023-01-01' WHERE project_id = $1 AND kind = 'rain_catchment_mm'`, [p.pid]);
		const fill = (opts: { deadline?: number; now?: () => number }) =>
			withUser(p.owner.id, async (db) => fillGapProducts(db, { id: p.feed, projectId: p.pid }, { jobId: await p.job(), today: TODAY, store, origin, ...opts }));
		// The job's deadline closer than the margin: no window is read, and the rest waits.
		const t0 = 1_000_000;
		expect(await fill({ now: () => t0, deadline: t0 + GAP_FILL_MARGIN_MS - 1 })).toEqual([{ product: 'era5l', windows: 0, status: 'ok', more: true }]);
		expect(await asOwner(`SELECT count(*)::int AS n FROM chirps_cell_year WHERE product = 'era5l'`)).toEqual([{ n: 0 }]);
		// The budget spent after the newest window: one read, the rest waits.
		// The clock: read at the start and before the first window, then the budget is gone.
		let calls = 0;
		const clock = () => (++calls <= 2 ? t0 : t0 + GAP_FILL_BUDGET_MS);
		expect(await fill({ now: clock })).toEqual([{ product: 'era5l', windows: 1, status: 'ok', more: true }]);
		// The next fetch, with time to spare, reads the older windows the copy holds (2024–2025) and finishes.
		const next = await fill({});
		expect(next).toHaveLength(1);
		expect(next[0]).toMatchObject({ product: 'era5l', status: 'ok' });
		expect(next[0]!.windows).toBeGreaterThanOrEqual(1);
		expect(next[0]!.more).toBeUndefined();
	});

	it('a project’s live run input carries them, and only with the setting', async () => {
		const store = copy();
		const p = await project({ product: 'era5l', imergLate: false });
		await withUser(p.owner.id, async (db) => fillGapProducts(db, { id: p.feed, projectId: p.pid }, { jobId: await p.job(), today: TODAY, store, origin }));
		const input = await withUser(p.owner.id, (db) => loadModelInput(db, p.pid));
		expect(Object.keys(input.series)).toContain(ERA5L_SERIES_KEY);
		expect(input.settings.gapRain).toEqual({ product: 'era5l', imergLate: false });
		// A run made from it fills the gauge's blank day from ERA5-Land, says so per day, and its stored input gives it back.
		const run = await p.owner.call('POST', `/projects/${p.pid}/runs`, { label: 'ERA5-Land gaps' });
		expect(run.status, JSON.stringify(run.body)).toBe(201);
		const runId = run.body.run.id as string;
		const [stored] = await asOwner(`SELECT summary->'gapRain' AS gap, inputs->'series'->'${ERA5L_SERIES_KEY}'->'provenance' AS prov FROM model_run WHERE id = $1`, [runId]);
		expect(stored.prov).toEqual({ product: 'ERA5-Land', version: 'daily' });
		expect(stored.gap.product).toBe('era5l');
		expect(stored.gap.segments[0]).toMatchObject({ from: '2025-11-02', product: 'era5l' });
		const [source] = await asOwner(`SELECT "values" FROM run_series WHERE run_id = $1 AND key = 'rain_source'`, [runId]);
		expect(source.values.slice(0, 3)).toEqual([0, 5, 0]);
		const rerun = await withUser(p.owner.id, (db) => loadRunInput(db, runId));
		expect(rerun.series[ERA5L_SERIES_KEY as 'rain_era5l_mm']).toEqual(input.series[ERA5L_SERIES_KEY as 'rain_era5l_mm']);
		expect((await p.owner.call('PATCH', `/projects/${p.pid}`, { settings: { gapRain: null } })).status).toBe(200);
		const plain = await withUser(p.owner.id, (db) => loadModelInput(db, p.pid));
		expect(Object.keys(plain.series).sort()).toEqual(['rain_catchment_mm', 'rain_chirps_mm']);
	});

	it('the Data tab’s view (GET …/feeds/gap-rain, issue #604 R4-E): the products over the feed’s cells as the run reads them, IMERG with its version per day', async () => {
		const store = copy();
		const p = await project({ product: 'chirpsThenEra5l', imergLate: true });
		await withUser(p.owner.id, async (db) => fillGapProducts(db, { id: p.feed, projectId: p.pid }, { jobId: await p.job(), today: TODAY, store, origin }));
		const other = await p.addFeed([{ lat: -30.025, lon: 20.025, weight: 1 }], 'Other CHIRPS');
		await asOwner(`INSERT INTO time_series (project_id, kind, name, unit, start_date, "values", feed_id) VALUES ($1, 'rain_chirps_mm', 'Other CHIRPS', 'mm', '2025-11-01', '{1}', $2)`, [p.pid, other]);
		const view = await withUser(p.owner.id, (db) => gapRainProducts(db, p.pid, null, TODAY));
		expect(view.gapRain).toEqual({ product: 'chirpsThenEra5l', imergLate: true });
		expect(view.feed).toBe(p.feed);
		expect(view.feeds.map((f) => [f.seriesName, f.runsRead])).toEqual([
			['CHIRPS', true],
			['Other CHIRPS', false]
		]);
		expect(view.window).toEqual({ start: '2025-11-01', end: TODAY });
		expect(view.record).toEqual({ start: '2025-11-01', end: TODAY });
		// ERA5-Land: what the run's input reads, to the day.
		const inputs = (await withUser(p.owner.id, (db) => gapRainInputs(db, p.pid, { gapRain: view.gapRain }, p.chirps, TODAY)))!;
		expect(view.era5l!.startDate).toBe(inputs[ERA5L_SERIES_KEY]!.startDate);
		expect(view.era5l!.values).toEqual(inputs[ERA5L_SERIES_KEY]!.values);
		expect(view.era5l!.held).toBe(view.era5l!.values.filter((v) => v !== null).length);
		// IMERG Late: one series, each day with its version (V07 to 2026-02-06, V08 after).
		expect(view.imergLate!.startDate).toBe('2026-01-25');
		expect(view.imergLate!.versions).toHaveLength(view.imergLate!.values.length);
		expect(view.imergLate!.versions.at(-1)).toBe('V08');
		expect(view.imergLate!.versions[0]).toBe('V07');
		// Another feed's cells, which no fetch filled: nothing held, said by null.
		const elsewhere = await withUser(p.owner.id, (db) => gapRainProducts(db, p.pid, other, TODAY));
		expect([elsewhere.feed, elsewhere.era5l, elsewhere.imergLate]).toEqual([other, null, null]);
		// Through the API: a viewer may read it; a stranger gets 404; a malformed feed id is 400.
		const ok = await p.owner.call('GET', `/projects/${p.pid}/feeds/gap-rain?feed=${p.feed}`);
		expect(ok.status).toBe(200);
		expect(ok.body.feed).toBe(p.feed);
		const stranger = await signUp('GapRainStranger');
		expect((await stranger.call('GET', `/projects/${p.pid}/feeds/gap-rain`)).status).toBe(404);
		expect((await p.owner.call('GET', `/projects/${p.pid}/feeds/gap-rain?feed=nope`)).status).toBe(400);
	});

	it('the view reads at most ten years: the record’s last ten by default, `from`/`to` further back, and refuses more', async () => {
		const p = await project({ product: 'era5l', imergLate: true });
		await asOwner(`UPDATE time_series SET start_date = '1990-01-01' WHERE project_id = $1 AND kind = 'rain_catchment_mm'`, [p.pid]);
		const get = (q = '') => p.owner.call('GET', `/projects/${p.pid}/feeds/gap-rain${q}`);
		const today = new Date().toISOString().slice(0, 10);
		const byDefault = await get();
		expect(byDefault.status).toBe(200);
		expect(byDefault.body.record).toEqual({ start: '1990-01-01', end: today });
		expect(byDefault.body.window.end).toBe(today);
		expect(daysIn(byDefault.body.window)).toBe(GAP_VIEW_MAX_DAYS);
		// Further back, as asked (ten years at most).
		expect((await get('?from=1990-01-01&to=1999-12-31')).body.window).toEqual({ start: '1990-01-01', end: '1999-12-31' });
		// More than ten years, a `from` alone that reaches past them, after `to`, or not a date: 400.
		expect((await get('?from=1990-01-01&to=2005-01-01')).status).toBe(400);
		expect((await get('?from=1990-01-01')).status).toBe(400);
		expect((await get('?from=2000-01-02&to=2000-01-01')).status).toBe(400);
		expect((await get('?to=2000-02-30')).status).toBe(400);
	});

	it('the view with no CHIRPS feed: no feed, nothing read', async () => {
		const owner = await signUp('GapRainNoFeed');
		const pid = (await owner.call('POST', '/projects', { name: 'No feed' })).body.project.id as string;
		expect(await withUser(owner.id, (db) => gapRainProducts(db, pid, null, TODAY))).toEqual({
			gapRain: null,
			feeds: [],
			feed: null,
			window: null,
			record: null,
			fill: { era5l: null, imergLate: null },
			era5l: null,
			imergLate: null
		});
	});
});
