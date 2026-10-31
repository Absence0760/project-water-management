// A daily reference evapotranspiration feed read from our copy
// (fromMirrorEt0.ts, issue #604 R5-E), end to end through the job queue: the
// feed writes `evap_et0_mm` from AgERA5, with NASA POWER on the newest days,
// no FetchRequest leaves even with FEED_FETCHER=sqs, a day POWER filled is
// replaced by AgERA5's once the copy holds its month (the merge replaces the
// feed's own days, and the product recorded for each, 292), a copy holding neither product waits without a failure,
// and a cell outside the region fails naming it.
//
// DB test files run one at a time; this one removes every feed and feed job
// after each test.
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

const { sent } = vi.hoisted(() => ({ sent: [] as unknown[] }));
vi.mock('../jobs/transport.js', async (orig) => ({
	...(await orig<typeof import('../jobs/transport.js')>()),
	sendToQueue: async (_url: string | undefined, _name: string, message: unknown) => void sent.push(message)
}));
import { et0FixtureValue, ET0_FIXTURE_HOLDS } from '../../scripts/et0-fixture.js';
import { MIRROR_FIXTURE_DIR } from '../../scripts/gen-mirror-fixture.js';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { runTick } from '../jobs/runner.js';
import { type Block, ensureFinals, writeFinalsYear } from '../mirror/arrays.js';
import { PRODUCT_GRIDS } from '../mirror/grid.js';
import { readManifest, writeManifest } from '../mirror/manifest.js';
import { openStore } from '../mirror/store.js';
import { withUser } from '../db/tx.js';
import { et0FeedDays, runEt0Products } from '../runs/execute.js';
import { utcToday } from './fetch.js';
import { ET0_FIXTURE } from './fromMirrorEt0.js';

type User = Awaited<ReturnType<typeof signUp>>;

const tmp: string[] = [];
afterAll(() => tmp.forEach((d) => rmSync(d, { recursive: true, force: true })));
afterEach(async () => {
	sent.length = 0;
	vi.unstubAllEnvs();
	await asOwner('DELETE FROM data_feed');
	await asOwner(`DELETE FROM job WHERE kind IN ('feed_fetch', 'feed_ingest')`);
});

const tick = () => runTick({ feeds: false, reports: false, alerts: false });

async function feed(owner: User, config: Record<string, unknown>) {
	const pid = (await owner.call('POST', '/projects', { name: 'Reference ET from the copy' })).body.project.id as string;
	const r = await owner.call('POST', `/projects/${pid}/feeds`, { source: 'agera5_et0', config });
	expect(r.status, JSON.stringify(r.body)).toBe(201);
	const feedId = r.body.feed.id as string;
	await owner.call('POST', `/projects/${pid}/feeds/${feedId}/run-now`);
	return { pid, feedId };
}
const et0 = async (u: User, pid: string) => {
	const list = (await u.call('GET', `/projects/${pid}/series`)).body.series as { id: string; kind: string }[];
	const meta = list.find((s) => s.kind === 'evap_et0_mm');
	return meta ? ((await u.call('GET', `/projects/${pid}/series/${meta.id}`)).body as { startDate: string; values: (number | null)[] }) : null;
};
const feedRow = async (id: string) =>
	(await asOwner('SELECT consecutive_failures, last_error, last_meta, last_attempt_at, last_success_at, to_char(last_data_date, $2) AS last_data_date FROM data_feed WHERE id = $1', [id, 'YYYY-MM-DD']))[0] as {
		consecutive_failures: number;
		last_error: string | null;
		last_meta: Record<string, unknown> | null;
		last_attempt_at: Date | null;
		last_success_at: Date | null;
		last_data_date: string | null;
	};

const { y0, x0 } = ET0_FIXTURE.block;
/** A 0.05° cell centre inside the fixture block's 0.1° cell (y0 + 1, x0 + 2). */
const CELL = { lat: -35.5 + (y0 + 1) * 0.1 + 0.025, lon: 10 + (x0 + 2) * 0.1 + 0.025, weight: 1 };
const round2 = (v: number) => Math.round(v * 100) / 100;

/** A private copy of the committed fixture, read as the live copy. */
function liveCopy() {
	const dir = mkdtempSync(join(tmpdir(), 'wm-et0-db-'));
	tmp.push(dir);
	cpSync(MIRROR_FIXTURE_DIR, dir, { recursive: true });
	vi.stubEnv('FEED_SOURCE', 'live');
	vi.stubEnv('MIRROR_URL', pathToFileURL(`${dir}/`).href);
	return openStore(pathToFileURL(`${dir}/`).href);
}

describe('a reference ET feed reads our copy', () => {
	it('fixtures mode: a year of AgERA5 to the newest days, POWER after, sending nothing even with FEED_FETCHER=sqs', async () => {
		vi.stubEnv('FEED_FETCHER', 'sqs');
		vi.stubEnv('FETCH_REQUESTS_QUEUE_URL', 'https://sqs.test/fetch-requests');
		const today = utcToday();
		const shift = toEpochDay(today) - toEpochDay(ET0_FIXTURE.today);
		const owner = await signUp('Et0Mirror');
		const f = await feed(owner, { cells: [CELL] });
		expect((await tick()).done).toBe(1);
		expect(sent).toEqual([]);
		const got = (await et0(owner, f.pid))!;
		const powerThrough = fromEpochDay(toEpochDay(ET0_FIXTURE_HOLDS.power.through) + shift);
		const agera5Through = fromEpochDay(toEpochDay(ET0_FIXTURE_HOLDS.agera5.finalThrough) + shift);
		expect(fromEpochDay(toEpochDay(got.startDate) + got.values.length - 1)).toBe(powerThrough);
		const at = (day: string) => got.values[toEpochDay(day) - toEpochDay(got.startDate)];
		const fixtureDay = (day: string) => fromEpochDay(toEpochDay(day) - shift);
		expect(at(agera5Through)).toBe(round2(et0FixtureValue(fixtureDay(agera5Through), 1, 2, 'agera5')));
		expect(at(powerThrough)).toBe(round2(et0FixtureValue(fixtureDay(powerThrough), 1, 2, 'power')));
		const row = await feedRow(f.feedId);
		expect(row).toMatchObject({ consecutive_failures: 0, last_error: null, last_data_date: powerThrough });
		expect(row.last_meta).toMatchObject({ agera5Through, powerDays: toEpochDay(powerThrough) - toEpochDay(agera5Through) });
	});

	it('a run’s credits read the product the feed recorded for each day (292), not where AgERA5 last reached, nor days a person wrote', async () => {
		const today = utcToday();
		const shift = toEpochDay(today) - toEpochDay(ET0_FIXTURE.today);
		const owner = await signUp('Et0Credits');
		const f = await feed(owner, { cells: [CELL] });
		expect((await tick()).done).toBe(1);
		const got = (await et0(owner, f.pid))!;
		const seriesId = ((await owner.call('GET', `/projects/${f.pid}/series`)).body.series as { id: string; kind: string }[]).find((x) => x.kind === 'evap_et0_mm')!.id;
		const last = fromEpochDay(toEpochDay(got.startDate) + got.values.length - 1);
		const agera5Through = fromEpochDay(toEpochDay(ET0_FIXTURE_HOLDS.agera5.finalThrough) + shift);
		const powerFrom = fromEpochDay(toEpochDay(agera5Through) + 1);
		const read = () => withUser(owner.id, (db) => et0FeedDays(db, seriesId));
		// The ingest recorded each day's product as it wrote it.
		expect(await read()).toEqual({ agera5: [[got.startDate, agera5Through]], power: [[powerFrom, last]], unrecorded: [] });
		// A run over every day credits both; one that ends on AgERA5's last day, AgERA5 alone; one over POWER's days, POWER alone.
		const info = (first: string, to: string) => ({ used: true, dailyDays: 1, fallbackDays: 0, invalidDays: 0, first, last: to });
		const credit = async (first: string, to: string) => runEt0Products({ et0Feed: (await read())! }, info(first, to));
		expect(await credit(got.startDate, last)).toEqual(['agera5_et0', 'power_et0']);
		expect(await credit(got.startDate, agera5Through)).toEqual(['agera5_et0']);
		expect(await credit(powerFrom, last)).toEqual(['power_et0']);
		// A long pause: the feed's latest fetch says AgERA5 reached past every POWER day it never re-read (the old
		// split at last_meta.agera5Through credited them to AgERA5 alone). The record still says POWER.
		await asOwner(`UPDATE data_feed SET last_meta = last_meta || jsonb_build_object('agera5Through', $2::text) WHERE id = $1`, [f.feedId, last]);
		expect(await credit(powerFrom, last)).toEqual(['power_et0']);
		// Days written before the record existed: no product recorded, so both are credited for them.
		await asOwner('UPDATE time_series SET feed_power_days = NULL WHERE id = $1', [seriesId]);
		expect(await read()).toEqual({ agera5: [[got.startDate, agera5Through]], power: [], unrecorded: [[powerFrom, last]] });
		expect(await credit(powerFrom, last)).toEqual(['agera5_et0', 'power_et0']);
		expect(await credit(got.startDate, agera5Through)).toEqual(['agera5_et0']);
		// A person wrote over the last days (031_feed_days: their merge releases them, and their products with them).
		const name = ((await owner.call('GET', `/projects/${f.pid}/series/${seriesId}`)).body as { name: string }).name;
		const merged = await owner.call('POST', `/projects/${f.pid}/series/merge`, { kind: 'evap_et0_mm', name, unit: 'mm', startDate: powerFrom, values: Array(toEpochDay(last) - toEpochDay(powerFrom) + 1).fill(5) });
		expect(merged.status, JSON.stringify(merged.body)).toBe(200);
		expect(await read()).toEqual({ agera5: [[got.startDate, agera5Through]], power: [], unrecorded: [] });
		expect(await credit(got.startDate, last)).toEqual(['agera5_et0']);
		// No feed's series (an upload), or none at all: nothing to read; the trigger clears the products with the feed's days.
		await asOwner('UPDATE time_series SET feed_id = NULL WHERE id = $1', [seriesId]);
		expect(await asOwner('SELECT feed_days, feed_agera5_days, feed_power_days FROM time_series WHERE id = $1', [seriesId])).toEqual([{ feed_days: null, feed_agera5_days: null, feed_power_days: null }]);
		expect(await read()).toBeNull();
		expect(await withUser(owner.id, (db) => et0FeedDays(db, undefined))).toBeNull();
	});

	it('a day NASA POWER filled is replaced by AgERA5’s once the copy holds its month', async () => {
		const store = liveCopy();
		const owner = await signUp('Et0Replace');
		const f = await feed(owner, { cells: [CELL], startDate: '2025-12-01' });
		// As the copy stood: the feed is read on the copy's own day, so stub the clock to it.
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date(`${ET0_FIXTURE.today}T06:00:00Z`));
		try {
			expect((await tick()).done).toBe(1);
			const before = (await et0(owner, f.pid))!;
			const jan5 = toEpochDay('2026-01-05') - toEpochDay(before.startDate);
			expect(before.values[jan5]).toBe(round2(et0FixtureValue('2026-01-05', 1, 2, 'power')));
			// The copy gains AgERA5's January (8 mm a day at every block cell), as ingest/agera5.py would write it.
			const finals = await ensureFinals(store, 'agera5_et0', 2026, { firstYear: PRODUCT_GRIDS.agera5_et0.firstYear });
			const block: Block = { ...ET0_FIXTURE.block };
			const n = block.h * block.w;
			const values = new Float32Array(366 * n).fill(Number.NaN);
			values.fill(8, 0, 31 * n);
			await writeFinalsYear(finals, 2026, block, values);
			const m = (await readManifest(store, 'agera5_et0'))!;
			m.files.push({ url: 'cds://sis-agrometeorological-indicators/reference_evapotranspiration/2026-01', etag: null, lastModified: null, size: null, valuesSha256: '0'.repeat(64), revision: 1, fetchedAt: `${ET0_FIXTURE.today}T00:00:00Z` });
			m.years = { first: 2025, last: 2026 };
			m.finalThrough = '2026-01-31';
			await writeManifest(store, m);
			await owner.call('POST', `/projects/${f.pid}/feeds/${f.feedId}/run-now`);
			expect((await tick()).done).toBe(1);
			const after = (await et0(owner, f.pid))!;
			expect(after.values[toEpochDay('2026-01-05') - toEpochDay(after.startDate)]).toBe(8);
			// A day past AgERA5's month is still POWER's.
			expect(after.values[toEpochDay('2026-02-03') - toEpochDay(after.startDate)]).toBe(round2(et0FixtureValue('2026-02-03', 1, 2, 'power')));
			expect((await feedRow(f.feedId)).last_meta).toMatchObject({ agera5Through: '2026-01-31' });
			// The record moved with the values: January is AgERA5's now, February's days still POWER's (292).
			const seriesId = ((await owner.call('GET', `/projects/${f.pid}/series`)).body.series as { id: string; kind: string }[]).find((x) => x.kind === 'evap_et0_mm')!.id;
			const last = fromEpochDay(toEpochDay(after.startDate) + after.values.length - 1);
			expect(await withUser(owner.id, (db) => et0FeedDays(db, seriesId))).toEqual({ agera5: [[after.startDate, '2026-01-31']], power: [['2026-02-01', last]], unrecorded: [] });
		} finally {
			vi.useRealTimers();
		}
	});

	it('a copy holding neither product: the feed waits, with no failure and nothing written', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'wm-et0-empty-'));
		tmp.push(dir);
		vi.stubEnv('FEED_SOURCE', 'live');
		vi.stubEnv('MIRROR_URL', pathToFileURL(`${dir}/`).href);
		const owner = await signUp('Et0Empty');
		const f = await feed(owner, { cells: [CELL] });
		expect((await tick()).done).toBe(1);
		expect(await et0(owner, f.pid)).toBeNull();
		const row = await feedRow(f.feedId);
		expect(row).toMatchObject({ consecutive_failures: 0, last_error: null, last_success_at: null, last_data_date: null });
		expect(row.last_attempt_at).not.toBeNull();
	});

	it('a cell outside the copy’s region fails the fetch, naming the region', async () => {
		const owner = await signUp('Et0Outside');
		const f = await feed(owner, { cells: [{ lat: -5.025, lon: 30.025 }] });
		expect((await tick()).done).toBe(1);
		const row = await feedRow(f.feedId);
		expect(row.consecutive_failures).toBe(1);
		expect(row.last_error).toMatch(/outside the region/);
	});
});
