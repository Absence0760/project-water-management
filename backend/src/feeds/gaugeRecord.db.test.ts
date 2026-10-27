// Our store of DWS gauge flow (247_gauge_record, issue #604 R3-B): who reads
// and writes it, the bounds and the precedence of its writers, the operator's
// import of a DWS reply, a DWS feed reading it (DWS_SOURCE=store) exactly as
// it reads DWS's page, waiting for days the store doesn't hold, and the
// worker's handover with the weekly pass through the mirror bucket.
//
// DB test files run one at a time; this one removes every feed, feed job and
// gauge record after each test.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { importDws, parseArgs, SYNTHETIC_DWS_REPLY } from '../../scripts/import-dws.js';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { withoutUser, withUser } from '../db/tx.js';
import { readStations, runDwsWeekly, writeStations } from '../ingest/dws.js';
import { runTick } from '../jobs/runner.js';
import { openStore } from '../mirror/store.js';
import { fixtureHttp } from './fixtures.js';
import { loadWebFile, resetDwsTick, runDwsTick } from './gaugeRecordLoad.js';

type User = Awaited<ReturnType<typeof signUp>>;

const tmp: string[] = [];
afterAll(() => tmp.forEach((d) => rmSync(d, { recursive: true, force: true })));
afterEach(async () => {
	vi.unstubAllEnvs();
	resetDwsTick();
	await asOwner('DELETE FROM data_feed');
	await asOwner(`DELETE FROM job WHERE kind IN ('feed_fetch', 'feed_ingest')`);
	await asOwner('DELETE FROM gauge_record');
	await asOwner('DELETE FROM gauge_record_span');
});

const OWNER_URL = () => process.env.TEST_MIGRATION_DATABASE_URL!;
const today = () => new Date().toISOString().slice(0, 10);
const add = (iso: string, n: number) => fromEpochDay(toEpochDay(iso) + n);
const tick = () => runTick({ feeds: false, reports: false, alerts: false });
const code = async (p: Promise<unknown>) => ((await p.then(() => null, (e: { code?: string }) => e)) as { code?: string } | null)?.code;

/** gauge_record_write as the schema owner (the operator's import). */
const write = (o: { origin?: string; station?: string; source: string; from: string; to: string; rows: [string, number | null, string | null][]; at?: string; reference?: string | null }) =>
	asOwner('SELECT written, applied FROM gauge_record_write($1, $2, $3, $4, $5, $6::date[], $7::double precision[], $8::text[], $9, $10)', [
		o.origin ?? 'dws',
		o.station ?? 'X0H000',
		o.source,
		o.from,
		o.to,
		o.rows.map((r) => r[0]),
		o.rows.map((r) => r[1]),
		o.rows.map((r) => r[2]),
		o.at ?? new Date().toISOString(),
		o.reference === undefined ? (o.source === 'dws-request' ? 'SYNTHETIC-REPLY' : null) : o.reference
	]).then((r) => r[0] as { written: number; applied: boolean });

const current = async (station = 'X0H000', origin = 'dws') =>
	(await asOwner(`SELECT to_char(day, 'YYYY-MM-DD') AS day, source, value, quality FROM gauge_record_current WHERE origin = $1 AND station = $2 ORDER BY day`, [origin, station])) as {
		day: string;
		source: string;
		value: number | null;
		quality: string | null;
	}[];

function mirrorDir() {
	const dir = mkdtempSync(join(tmpdir(), 'wm-gauge-'));
	tmp.push(dir);
	return { url: pathToFileURL(`${dir}/`).href, store: openStore(pathToFileURL(`${dir}/`).href) };
}

describe('gauge_record: shared reference data, read by any signed-in user, written only through its functions', () => {
	it('a signed-in user reads the rows, the spans and the current view (positive control); with no user, RLS shows nothing', async () => {
		await write({ source: 'dws-web', from: '2020-01-01', to: '2020-01-03', rows: [['2020-01-02', 1.5, '1']] });
		const u = await signUp('Reader');
		const seen = await withUser(u.id, async (db) => ({
			rows: (await db.query('SELECT count(*)::int AS n FROM gauge_record')).rows[0].n,
			spans: (await db.query('SELECT count(*)::int AS n FROM gauge_record_span')).rows[0].n,
			view: (await db.query('SELECT value FROM gauge_record_current')).rows
		}));
		expect(seen).toEqual({ rows: 1, spans: 1, view: [{ value: 1.5 }] });
		expect(await withoutUser(async (db) => (await db.query('SELECT count(*)::int AS n FROM gauge_record')).rows[0].n)).toBe(0);
	});

	it('water_app can’t write the tables directly, nor call the operator’s function', async () => {
		await write({ source: 'dws-web', from: '2020-01-01', to: '2020-01-01', rows: [['2020-01-01', 1, '1']] });
		const u = await signUp('Writer');
		const as = (sql: string) => code(withUser(u.id, (db) => db.query(sql)));
		expect(await as(`INSERT INTO gauge_record (origin, station, day, source, value, fetched_at) VALUES ('dws', 'X0H000', '2020-01-02', 'upload', 1, now())`)).toBe('42501');
		expect(await as(`UPDATE gauge_record SET value = 9`)).toBe('42501');
		expect(await as(`DELETE FROM gauge_record`)).toBe('42501');
		expect(await as(`INSERT INTO gauge_record_span (origin, station, source, day_from, day_to, fetched_at) VALUES ('dws', 'X0H000', 'upload', '2020-01-01', '2020-01-02', now())`)).toBe('42501');
		expect(
			await as(`SELECT gauge_record_write('dws', 'X0H000', 'upload', '2020-01-02', '2020-01-02', ARRAY['2020-01-02']::date[], ARRAY[1]::float8[], ARRAY['1'], now(), 'x')`)
		).toBe('42501');
		expect(await code(withoutUser((db) => db.query(`DELETE FROM gauge_record`)))).toBe('42501');
		expect((await current()).map((r) => r.value)).toEqual([1]);
	});

	it('the worker’s functions refuse a signed-in user, and run with no user (positive control)', async () => {
		const u = await signUp('NotWorker');
		const file = { station: 'X0H000', from: '2020-01-01', to: '2020-01-02', fetchedAt: new Date().toISOString(), rows: [['2020-01-01', 2, '1'] as [string, number, string]] };
		expect(await code(withUser(u.id, (db) => loadWebFile(db, 'dws', file)))).toBe('42501');
		expect(await code(withUser(u.id, (db) => db.query('SELECT app_dws_feed_stations()')))).toBe('42501');
		expect(await withoutUser((db) => loadWebFile(db, 'dws', file))).toBe(1);
		expect(await current()).toEqual([{ day: '2020-01-01', source: 'dws-web', value: 2, quality: '1' }]);
	});

	it('lists the stations of enabled DWS feeds only, each once, for the worker', async () => {
		const owner = await signUp('Stations');
		const pid = (await owner.call('POST', '/projects', { name: 'Gauges' })).body.project.id as string;
		const mk = async (station: string, name: string) => (await owner.call('POST', `/projects/${pid}/feeds`, { source: 'dws', config: { station }, targetName: name })).body.feed.id as string;
		await mk('X0H002', 'A');
		await mk('X0H002', 'B');
		const off = await mk('X0H003', 'C');
		await mk('X0H001', 'D');
		await owner.call('PATCH', `/projects/${pid}/feeds/${off}`, { enabled: false });
		const got = await withoutUser(async (db) => (await db.query<{ s: string }>('SELECT s FROM app_dws_feed_stations() AS s')).rows.map((r) => r.s));
		expect(got).toEqual(['X0H001', 'X0H002']);
	});
});

describe('gauge_record_write: bounds', () => {
	const ok = { source: 'upload', from: '2020-01-01', to: '2020-01-03', rows: [['2020-01-02', 1, '1']] as [string, number | null, string | null][] };
	it.each([
		['an unknown source', { source: 'scrape' }],
		['a reservoir code', { station: 'X0R000' }],
		['a malformed code', { station: 'x0h000' }],
		['an unknown origin', { origin: 'chc' }],
		['a span ending after today in South Africa', { to: '2999-01-01', rows: [] }],
		['a span longer than 20 years', { from: '1990-01-01', to: '2010-12-31', rows: [] }],
		['a span backwards', { from: '2020-01-03', to: '2020-01-01', rows: [] }],
		['a day outside the span', { rows: [['2020-01-04', 1, '1']] }],
		['a day listed twice', { rows: [['2020-01-02', 1, '1'], ['2020-01-02', 2, '1']] }],
		['a negative flow', { rows: [['2020-01-02', -1, '1']] }],
		['a flow above 100 000 m³/s', { rows: [['2020-01-02', 100001, '1']] }],
		['NaN', { rows: [['2020-01-02', Number.NaN, '1']] }],
		['a quality code with a space', { rows: [['2020-01-02', 1, '1 A']] }],
		['a fetch time in the future', { at: '2999-01-01T00:00:00Z' }],
		['a DWS reply with no reference', { source: 'dws-request', reference: null }],
		['an empty reference', { reference: ' ' }]
	] as const)('refuses %s (23514)', async (_what, over) => {
		expect(await code(write({ ...ok, ...over } as Parameters<typeof write>[0]))).toBe('23514');
		expect(await current()).toEqual([]);
	});

	it('positive control: a gap row, a quality-less row and the edges of the span load', async () => {
		expect(await write({ ...ok, rows: [['2020-01-01', null, '170'], ['2020-01-02', 0, null], ['2020-01-03', 100000, '1']] })).toEqual({ written: 3, applied: true });
	});

	it('the worker’s load takes at most 731 days (one pass’s window)', async () => {
		const at = new Date().toISOString();
		const load = (from: string, to: string) => withoutUser((db) => loadWebFile(db, 'dws', { station: 'X0H000', from, to, fetchedAt: at, rows: [] }));
		expect(await code(load('2018-01-01', '2020-01-02'))).toBe('23514');
		expect(await load('2018-01-01', '2019-12-31')).toBe(0);
	});
});

describe('precedence: a DWS reply, then the web pass, then an upload', () => {
	it('keeps each source’s rows and reads the best per day; a gap row counts as an answer', async () => {
		await write({ source: 'upload', from: '2020-01-01', to: '2020-01-04', rows: [['2020-01-01', 9, '1'], ['2020-01-02', 9, '1'], ['2020-01-03', 9, '1'], ['2020-01-04', 9, '1']] });
		await write({ source: 'dws-web', from: '2020-01-02', to: '2020-01-04', rows: [['2020-01-02', 5, '1'], ['2020-01-03', 5, '1'], ['2020-01-04', 5, '1']] });
		await write({ source: 'dws-request', from: '2020-01-03', to: '2020-01-04', rows: [['2020-01-03', 1, '1'], ['2020-01-04', null, '170']] });
		expect(await current()).toEqual([
			{ day: '2020-01-01', source: 'upload', value: 9, quality: '1' },
			{ day: '2020-01-02', source: 'dws-web', value: 5, quality: '1' },
			{ day: '2020-01-03', source: 'dws-request', value: 1, quality: '1' },
			{ day: '2020-01-04', source: 'dws-request', value: null, quality: '170' }
		]);
		// Every source's rows are kept.
		expect((await asOwner('SELECT count(*)::int AS n FROM gauge_record'))[0].n).toBe(9);
	});

	it('a load replaces its own source’s rows over its span (a day it no longer lists goes) and merges the span; other sources stay', async () => {
		const first = new Date(Date.now() - 60_000).toISOString();
		await write({ source: 'upload', from: '2020-01-01', to: '2020-01-03', rows: [['2020-01-02', 9, '1']] });
		await write({ source: 'dws-web', from: '2020-01-01', to: '2020-01-03', rows: [['2020-01-01', 1, '1'], ['2020-01-02', 2, '1']], at: first });
		await write({ source: 'dws-web', from: '2020-01-02', to: '2020-01-05', rows: [['2020-01-04', 4, '1']] });
		expect(await current()).toEqual([
			{ day: '2020-01-01', source: 'dws-web', value: 1, quality: '1' },
			{ day: '2020-01-02', source: 'upload', value: 9, quality: '1' },
			{ day: '2020-01-04', source: 'dws-web', value: 4, quality: '1' }
		]);
		expect(await asOwner(`SELECT source, to_char(day_from, 'YYYY-MM-DD') AS f, to_char(day_to, 'YYYY-MM-DD') AS t FROM gauge_record_span ORDER BY source, day_from`)).toEqual([
			{ source: 'dws-web', f: '2020-01-01', t: '2020-01-05' },
			{ source: 'upload', f: '2020-01-01', t: '2020-01-03' }
		]);
	});

	it('a load no newer than what the source already holds over the span changes nothing (a restarted worker re-reading last week’s file)', async () => {
		const newer = new Date().toISOString();
		const older = new Date(Date.now() - 86_400_000).toISOString();
		await write({ source: 'dws-web', from: '2020-01-01', to: '2020-01-05', rows: [['2020-01-02', 2, '1']], at: newer });
		expect(await write({ source: 'dws-web', from: '2020-01-01', to: '2020-01-03', rows: [['2020-01-02', 7, '1']], at: older })).toEqual({ written: 0, applied: false });
		expect(await write({ source: 'dws-web', from: '2020-01-01', to: '2020-01-05', rows: [['2020-01-02', 2, '1']], at: newer })).toEqual({ written: 0, applied: false });
		expect((await current()).map((r) => r.value)).toEqual([2]);
		// Positive control: a span reaching past what is held applies.
		expect(await write({ source: 'dws-web', from: '2020-01-01', to: '2020-01-06', rows: [['2020-01-02', 7, '1']], at: older })).toEqual({ written: 1, applied: true });
	});
});

describe('pnpm import:dws (the operator loads DWS’s reply)', () => {
	it('loads the synthetic reply as dws-request with its reference, a gap row kept and a day not listed left out, and loads again idempotently', async () => {
		const args = parseArgs([SYNTHETIC_DWS_REPLY, '--reference', 'SYNTHETIC-REPLY-0001'], { FEED_SOURCE: 'live' });
		if (typeof args === 'string') throw new Error(args);
		const got = await importDws(OWNER_URL(), args);
		expect(got).toMatchObject({ station: 'X0H001', written: 89, gaps: 1 });
		const rows = await current('X0H001');
		expect(rows).toHaveLength(89);
		expect(rows.every((r) => r.source === 'dws-request')).toBe(true);
		expect(rows.find((r) => r.day === '2010-02-20')).toEqual({ day: '2010-02-20', source: 'dws-request', value: null, quality: '170' });
		expect(rows.find((r) => r.day === '2010-03-05')).toMatchObject({ value: 2.918, quality: '50' });
		expect(rows.some((r) => r.day === '2010-02-10')).toBe(false);
		expect(await asOwner(`SELECT reference, to_char(day_from, 'YYYY-MM-DD') AS f, to_char(day_to, 'YYYY-MM-DD') AS t FROM gauge_record_span WHERE station = 'X0H001'`)).toEqual([
			{ reference: 'SYNTHETIC-REPLY-0001', f: '2010-01-01', t: '2010-03-31' }
		]);
		expect((await importDws(OWNER_URL(), args)).written).toBe(89);
		expect(await current('X0H001')).toEqual(rows);
	});

	it('records the span asked for with --from/--to, and refuses rows outside it', async () => {
		const wide = parseArgs([SYNTHETIC_DWS_REPLY, '--reference', 'R', '--from', '2009-12-01', '--to', '2010-04-30', '--origin', 'dws']);
		if (typeof wide === 'string') throw new Error(wide);
		await importDws(OWNER_URL(), wide);
		expect(await asOwner(`SELECT to_char(day_from, 'YYYY-MM-DD') AS f, to_char(day_to, 'YYYY-MM-DD') AS t FROM gauge_record_span`)).toEqual([{ f: '2009-12-01', t: '2010-04-30' }]);
		const narrow = parseArgs([SYNTHETIC_DWS_REPLY, '--reference', 'R', '--from', '2010-02-01', '--to', '2010-02-28', '--origin', 'dws']);
		if (typeof narrow === 'string') throw new Error(narrow);
		await expect(importDws(OWNER_URL(), narrow)).rejects.toThrow(/outside --from\/--to/);
	});
});

describe('a DWS feed reading the store (DWS_SOURCE=store)', () => {
	async function dwsFeed(owner: User, config: Record<string, unknown>, name = 'Store') {
		const pid = (await owner.call('POST', '/projects', { name })).body.project.id as string;
		const r = await owner.call('POST', `/projects/${pid}/feeds`, { source: 'dws', config });
		expect(r.status, JSON.stringify(r.body)).toBe(201);
		const feedId = r.body.feed.id as string;
		await owner.call('POST', `/projects/${pid}/feeds/${feedId}/run-now`);
		return { pid, feedId };
	}
	const feedRow = async (id: string) =>
		(await asOwner('SELECT consecutive_failures, last_error, last_meta, last_attempt_at, to_char(last_data_date, $2) AS last_data_date FROM data_feed WHERE id = $1', [id, 'YYYY-MM-DD']))[0] as {
			consecutive_failures: number;
			last_error: string | null;
			last_meta: Record<string, unknown> | null;
			last_attempt_at: Date | null;
			last_data_date: string | null;
		};
	const flow = async (u: User, pid: string) => {
		const list = (await u.call('GET', `/projects/${pid}/series`)).body.series as { id: string; kind: string }[];
		const meta = list.find((s) => s.kind === 'flow_observed_m3s');
		return meta ? ((await u.call('GET', `/projects/${pid}/series/${meta.id}`)).body as { startDate: string; values: (number | null)[] }) : null;
	};

	it('writes exactly what the live path writes from the synthetic page (fixtures mode seeds the store from it)', async () => {
		const owner = await signUp('SameAsLive');
		const config = { station: 'X0H000', startDate: add(today(), -400) };
		vi.stubEnv('DWS_SOURCE', 'live');
		const live = await dwsFeed(owner, config, 'Live');
		expect((await tick()).done).toBe(1);
		const liveRow = await feedRow(live.feedId);
		const liveSeries = await flow(owner, live.pid);
		expect(await current('X0H000', 'fixtures')).toEqual([]);

		vi.stubEnv('DWS_SOURCE', 'store');
		const store = await dwsFeed(owner, config, 'Store');
		expect((await tick()).done).toBe(1);
		const storeRow = await feedRow(store.feedId);
		expect(storeRow).toMatchObject({ consecutive_failures: 0, last_error: null, last_data_date: liveRow.last_data_date });
		expect(storeRow.last_meta).toEqual(liveRow.last_meta);
		// The same series, bar its own id and write time.
		const same = (x: Awaited<ReturnType<typeof flow>>) => x && { ...x, id: undefined, updatedAt: undefined };
		expect(same(await flow(owner, store.pid))).toEqual(same(liveSeries));
		expect(liveSeries!.values.some((v) => v === null)).toBe(true);
		// The seed: the window's days, as the synthetic page lists them, under origin fixtures.
		const seeded = await current('X0H000', 'fixtures');
		expect(seeded.length).toBeGreaterThan(300);
		expect(seeded.every((r) => r.source === 'dws-web')).toBe(true);
	});

	it('a startDate in the future asks for no days, as the live path: an empty answer, recorded as a success', async () => {
		vi.stubEnv('DWS_SOURCE', 'store');
		const owner = await signUp('Future');
		const { feedId } = await dwsFeed(owner, { station: 'X0H000', startDate: add(today(), 10) });
		expect((await tick()).done).toBe(1);
		expect(await feedRow(feedId)).toMatchObject({ consecutive_failures: 0, last_error: null, last_meta: { days: 0, merged: 0 } });
	});

	describe('a live store (FEED_SOURCE=live: no seeding, only what was loaded)', () => {
		const live = () => {
			vi.stubEnv('FEED_SOURCE', 'live');
			vi.stubEnv('DWS_SOURCE', 'store');
		};

		it('waits without an error while the store holds nothing for the station, then reads it once loaded', async () => {
			live();
			const owner = await signUp('Waits');
			const start = add(today(), -100);
			const { pid, feedId } = await dwsFeed(owner, { station: 'X0H000', startDate: start });
			expect((await tick()).done).toBe(1);
			const waited = await feedRow(feedId);
			expect(waited).toMatchObject({ consecutive_failures: 0, last_error: null, last_meta: null, last_data_date: null });
			expect(waited.last_attempt_at).not.toBeNull();
			expect(await flow(owner, pid)).toBeNull();

			// The weekly pass lands: the window's days, one a gap row, one not listed.
			await withoutUser((db) =>
				loadWebFile(db, 'dws', {
					station: 'X0H000',
					from: add(today(), -729),
					to: today(),
					fetchedAt: new Date().toISOString(),
					rows: [
						[add(start, 0), 1.5, '1'],
						[add(start, 1), null, '170'],
						[add(start, 3), 2.5, '50']
					]
				})
			);
			await owner.call('POST', `/projects/${pid}/feeds/${feedId}/run-now`);
			expect((await tick()).done).toBe(1);
			expect(await flow(owner, pid)).toMatchObject({ startDate: start, values: [1.5, null, null, 2.5] });
			expect(await feedRow(feedId)).toMatchObject({
				consecutive_failures: 0,
				last_data_date: add(start, 3),
				last_meta: { days: 4, gaps: 2, rejected: 1, 'quality 1': 1, 'quality 170': 1, 'quality 50': 1, through: today() }
			});
		});

		it('waits for a window that starts after the store’s newest day, and a backfill window stops at it', async () => {
			live();
			const owner = await signUp('Walks');
			// A reply covering 2010; the feed's history starts in 2009, its first window two years long.
			await write({ source: 'dws-request', from: '2009-06-01', to: '2010-12-31', rows: [['2010-03-01', 4, '1'], ['2010-12-31', 5, '1']] });
			const { pid, feedId } = await dwsFeed(owner, { station: 'X0H000', startDate: '2009-06-01' });
			expect((await tick()).done).toBe(1);
			// The window 2009-06-01 … 2011-05-31 reaches past the store's newest day: read and recorded to 2010-12-31 only.
			expect(await feedRow(feedId)).toMatchObject({ consecutive_failures: 0, last_data_date: '2010-12-31', last_meta: { through: '2010-12-31' } });
			expect((await flow(owner, pid))!.values.filter((v) => v !== null)).toEqual([4, 5]);
			// The next window starts after it: nothing held there yet, so it waits, without a failure.
			await asOwner(`UPDATE job SET run_after = now() WHERE kind = 'feed_fetch' AND status = 'queued'`);
			expect((await tick()).done).toBe(1);
			expect(await feedRow(feedId)).toMatchObject({ consecutive_failures: 0, last_error: null, last_meta: { through: '2010-12-31' } });
		});
	});
});

describe('the worker’s handover with the weekly pass (DWS_WEEKLY=on, a live process)', () => {
	it('publishes the stations, loads what the pass fetched, and does nothing twice', async () => {
		const { store } = mirrorDir();
		const owner = await signUp('Handover');
		const pid = (await owner.call('POST', '/projects', { name: 'Handover' })).body.project.id as string;
		await owner.call('POST', `/projects/${pid}/feeds`, { source: 'dws', config: { station: 'X0H000' } });
		const env = { DWS_WEEKLY: 'on', FEED_SOURCE: 'live' };

		// Off unless on, in a live process.
		expect(await runDwsTick({ store, env: { DWS_WEEKLY: 'on', FEED_SOURCE: 'fixtures' } })).toBeNull();
		expect(await runDwsTick({ store, env: { FEED_SOURCE: 'live' } })).toBeNull();

		expect(await runDwsTick({ store, env })).toEqual({ stations: 1, published: true, loaded: 0, unchanged: 0, failed: 0 });
		expect((await readStations(store))!.stations).toEqual(['X0H000']);
		// The pass, here against the synthetic page.
		const t = today();
		await runDwsWeekly({ store, http: fixtureHttp(() => t), today: t, intervalMs: 0 });
		expect(await runDwsTick({ store, env })).toEqual({ stations: 1, published: false, loaded: 1, unchanged: 0, failed: 0 });
		const rows = await current('X0H000', 'dws');
		expect(rows.length).toBeGreaterThan(600);
		expect(rows.every((r) => r.source === 'dws-web')).toBe(true);
		// Nothing new: nothing written. A restarted worker reloads, and the function skips it.
		expect(await runDwsTick({ store, env })).toEqual({ stations: 1, published: false, loaded: 0, unchanged: 0, failed: 0 });
		resetDwsTick();
		expect(await runDwsTick({ store, env })).toEqual({ stations: 1, published: false, loaded: 0, unchanged: 1, failed: 0 });
	});

	it('rewrites the list only when the stations change', async () => {
		const { store } = mirrorDir();
		const env = { DWS_WEEKLY: 'on', FEED_SOURCE: 'live' };
		await writeStations(store, { v: 1, at: '2026-01-01T00:00:00.000Z', stations: [] });
		expect(await runDwsTick({ store, env })).toMatchObject({ stations: 0, published: false });
		expect((await readStations(store))!.at).toBe('2026-01-01T00:00:00.000Z');
	});
});
