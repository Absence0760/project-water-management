// An ECMWF ENS forecast feed read from our copy (fromMirrorEcmwf.ts, issue
// #604 R4-C), end to end through the job queue: the forecast written is the
// copy's ensemble mean (not yet calibrated, then quantile-mapped once a fit is
// in the copy), no FetchRequest leaves even with FEED_FETCHER=sqs or
// CHIRPS_SOURCE=chc (there is no per-feed path to ECMWF), and a copy holding
// no issue it may use waits without a failure.
//
// DB test files run one at a time; this one removes every feed and feed job
// after each test.
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { ecmwfFixtureMean } from '../../scripts/ecmwf-fixture.js';
import { MIRROR_FIXTURE_DIR } from '../../scripts/gen-mirror-fixture.js';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { ECMWF_STATS, writeEcmwfIndex, writeEcmwfIssue } from '../ingest/ecmwf.js';
import { runTick } from '../jobs/runner.js';
import { openStore } from '../mirror/store.js';
import { utcToday } from './fetch.js';
import { ECMWF_FIXTURE, NOT_CALIBRATED } from './fromMirrorEcmwf.js';

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
	const pid = (await owner.call('POST', '/projects', { name: 'ECMWF from the copy' })).body.project.id as string;
	const r = await owner.call('POST', `/projects/${pid}/feeds`, { source: 'ecmwf_ens', config });
	expect(r.status, JSON.stringify(r.body)).toBe(201);
	const feedId = r.body.feed.id as string;
	await owner.call('POST', `/projects/${pid}/feeds/${feedId}/run-now`);
	return { pid, feedId };
}
const forecast = async (u: User, pid: string) => {
	const list = (await u.call('GET', `/projects/${pid}/series`)).body.series as { id: string; kind: string }[];
	const meta = list.find((s) => s.kind === 'rain_forecast_mm');
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

/** A 0.05° cell centre inside the fixture block's 0.1° cell (row y0 + 1, column x0 + 2). */
const { y0, x0 } = ECMWF_FIXTURE.block;
const CELL = { lat: -35.5 + (y0 + 1) * 0.1 + 0.025, lon: 10 + (x0 + 2) * 0.1 + 0.025, weight: 1 };

/** A private copy of the committed fixture, read as the live copy. */
function liveCopy() {
	const dir = mkdtempSync(join(tmpdir(), 'wm-ecmwf-db-'));
	tmp.push(dir);
	cpSync(MIRROR_FIXTURE_DIR, dir, { recursive: true });
	vi.stubEnv('FEED_SOURCE', 'live');
	vi.stubEnv('MIRROR_URL', pathToFileURL(`${dir}/`).href);
	return { dir, store: openStore(pathToFileURL(`${dir}/`).href) };
}

describe('an ECMWF ENS feed reads our copy', () => {
	it('fixtures mode: writes the copy’s ensemble mean from today, 15 days, not yet calibrated, sending nothing even with FEED_FETCHER=sqs and CHIRPS_SOURCE=chc', async () => {
		vi.stubEnv('CHIRPS_SOURCE', 'chc');
		vi.stubEnv('FEED_FETCHER', 'sqs');
		vi.stubEnv('FETCH_REQUESTS_QUEUE_URL', 'https://sqs.test/fetch-requests');
		const today = utcToday();
		const owner = await signUp('EcmwfMirror');
		const f = await feed(owner, { cells: [CELL] });
		expect((await tick()).done).toBe(1);
		expect(sent).toEqual([]);
		const got = (await forecast(owner, f.pid))!;
		expect(got.startDate).toBe(today);
		expect(got.values).toEqual(Array.from({ length: 15 }, (_, d) => Math.round(Math.fround(ecmwfFixtureMean(d, 1, 2)) * 100) / 100));
		expect(await feedRow(f.feedId)).toMatchObject({
			consecutive_failures: 0,
			last_error: null,
			last_data_date: fromEpochDay(toEpochDay(today) + 14),
			last_meta: { days: 15, issued: today, model: 'ECMWF ENS mean', calibration: NOT_CALIBRATED, merged: 15 }
		});
	});

	it('a live copy: today’s issue, quantile-mapped once the fit is in the copy', async () => {
		const today = utcToday();
		const { dir, store } = liveCopy();
		// Today's issue: a mean of 5 mm on day 0 at the cell, one more each day.
		const block = { y0: y0 + 1, x0: x0 + 2, h: 1, w: 1 };
		const values = Float32Array.from({ length: ECMWF_STATS.length * 15 }, (_, i) => 5 + (i % 15));
		await writeEcmwfIssue(store, today, block, values);
		await writeEcmwfIndex(store, { issues: [today], archived: [] });
		const qm = {
			v: 1,
			product: 'ecmwf',
			stat: 'mean',
			fittedAt: '2027-03-01T10:00:00Z',
			method: 'test',
			observed: { product: 'sat', fallback: 'prelim', scale: 1 },
			forecasts: { issues: 90, first: '2026-11-01', last: '2027-02-28' },
			// Every month, so a day after a month's end is mapped too: halves everything up to 100 mm.
			groups: [{ id: 'D1-all', region: { w: 10, s: -35.5, e: 41, n: -8 }, months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], samples: 5000, pairs: [[0, 0], [100, 50]] }]
		};
		writeFileSync(join(dir, 'ecmwf', 'qm.json'), JSON.stringify(qm));
		const owner = await signUp('EcmwfLive');
		const f = await feed(owner, { cells: [CELL] });
		expect((await tick()).done).toBe(1);
		const got = (await forecast(owner, f.pid))!;
		expect(got.startDate).toBe(today);
		expect(got.values.slice(0, 3)).toEqual([2.5, 3, 3.5]);
		expect((await feedRow(f.feedId)).last_meta).toMatchObject({ issued: today, calibration: 'quantile-mapped 2027-03-01T10:00:00Z' });
	});

	it('a copy holding no issue it may use: the feed waits, with no failure, no backoff and nothing written', async () => {
		liveCopy();
		// The committed issue is months old: neither today's nor yesterday's.
		expect(ECMWF_FIXTURE.issue < fromEpochDay(toEpochDay(utcToday()) - 1)).toBe(true);
		const owner = await signUp('EcmwfMirrorOld');
		const f = await feed(owner, { cells: [CELL] });
		expect((await tick()).done).toBe(1);
		expect(sent).toEqual([]);
		expect(await forecast(owner, f.pid)).toBeNull();
		const row = await feedRow(f.feedId);
		expect(row).toMatchObject({ consecutive_failures: 0, last_error: null, last_success_at: null, last_data_date: null });
		expect(row.last_attempt_at).not.toBeNull();
	});

	it('a cell outside the copy’s region fails the fetch, naming the region', async () => {
		const owner = await signUp('EcmwfOutside');
		const f = await feed(owner, { cells: [{ lat: -5.025, lon: 30.025 }] });
		expect((await tick()).done).toBe(1);
		const row = await feedRow(f.feedId);
		expect(row.consecutive_failures).toBe(1);
		expect(row.last_error).toMatch(/outside the region the rain data copy holds/);
	});
});
