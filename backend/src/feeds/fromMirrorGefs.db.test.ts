// A CHIRPS-GEFS feed fetch read from our own copy (fromMirrorGefs.ts, issue
// #604 R3-A), end to end through the job queue: the forecast written is the
// one the per-feed fetch writes from the files, no FetchRequest leaves even
// with FEED_FETCHER=sqs, a copy holding no issue it may use waits without a
// failure, and CHIRPS_SOURCE=chc keeps the per-feed path.
//
// DB test files run one at a time; this one removes every feed and feed job
// after each test.
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { sent } = vi.hoisted(() => ({ sent: [] as unknown[] }));
vi.mock('../jobs/transport.js', async (orig) => ({
	...(await orig<typeof import('../jobs/transport.js')>()),
	sendToQueue: async (_url: string | undefined, _name: string, message: unknown) => void sent.push(message)
}));
import { MIRROR_FIXTURE_DIR } from '../../scripts/gen-mirror-fixture.js';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { runTick } from '../jobs/runner.js';
import { runFetch, utcToday } from './fetch.js';
import { FIXTURE_CELL, fixtureHttp } from './fixtures.js';

type User = Awaited<ReturnType<typeof signUp>>;

const tmp: string[] = [];
afterAll(() => tmp.forEach((d) => rmSync(d, { recursive: true, force: true })));
afterEach(async () => {
	sent.length = 0;
	vi.unstubAllEnvs();
	await asOwner('DELETE FROM data_feed');
	await asOwner(`DELETE FROM job WHERE kind IN ('feed_fetch', 'feed_ingest')`);
});
beforeEach(() => vi.stubEnv('CHIRPS_SOURCE', 'mirror'));

const tick = () => runTick({ feeds: false, reports: false, alerts: false });

async function feed(owner: User, config: Record<string, unknown>) {
	const pid = (await owner.call('POST', '/projects', { name: 'Forecast from the copy' })).body.project.id as string;
	const r = await owner.call('POST', `/projects/${pid}/feeds`, { source: 'chirps_gefs', config });
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
	(await asOwner('SELECT consecutive_failures, last_error, last_meta, last_attempt_at, last_success_at, fetch_job_id, to_char(last_data_date, $2) AS last_data_date FROM data_feed WHERE id = $1', [id, 'YYYY-MM-DD']))[0] as {
		consecutive_failures: number;
		last_error: string | null;
		last_meta: Record<string, unknown> | null;
		last_attempt_at: Date | null;
		last_success_at: Date | null;
		fetch_job_id: string | null;
		last_data_date: string | null;
	};

const CONFIG = { cells: [{ ...FIXTURE_CELL(), weight: 1 }, { lat: -30.02, lon: 22.03, weight: 2 }] };

describe('a CHIRPS-GEFS feed reads our copy (CHIRPS_SOURCE=mirror)', () => {
	it('fixtures mode: writes the forecast the files give, with the same issue and meta, sending nothing even with FEED_FETCHER=sqs', async () => {
		vi.stubEnv('FEED_FETCHER', 'sqs');
		vi.stubEnv('FETCH_REQUESTS_QUEUE_URL', 'https://sqs.test/fetch-requests');
		const today = utcToday();
		const owner = await signUp('GefsMirror');
		const f = await feed(owner, CONFIG);
		expect((await tick()).done).toBe(1);
		expect(sent).toEqual([]);
		expect((await asOwner(`SELECT count(*)::int AS n FROM job WHERE kind = 'feed_ingest'`))[0].n).toBe(0);
		const direct = await runFetch({ source: 'chirps_gefs', config: CONFIG as never, start: today, end: today, today }, fixtureHttp());
		expect(direct.ok).toBe(true);
		const d = direct as { startDate: string; values: number[]; meta: Record<string, unknown> };
		const got = (await forecast(owner, f.pid))!;
		expect(got.startDate).toBe(today);
		expect(got.values).toEqual(d.values);
		expect(got.values).toHaveLength(16);
		expect(await feedRow(f.feedId)).toMatchObject({
			consecutive_failures: 0,
			last_error: null,
			fetch_job_id: null,
			last_data_date: fromEpochDay(toEpochDay(today) + 15),
			last_meta: { ...d.meta, issued: today, days: 16, merged: 16 }
		});
	});

	it('a copy holding no issue yet: the feed waits, with no failure, no backoff and nothing written', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'wm-gefs-db-'));
		tmp.push(dir);
		cpSync(MIRROR_FIXTURE_DIR, dir, { recursive: true });
		rmSync(join(dir, 'gefs', 'index.json'));
		vi.stubEnv('FEED_SOURCE', 'live');
		vi.stubEnv('MIRROR_URL', pathToFileURL(`${dir}/`).href);
		const owner = await signUp('GefsMirrorEmpty');
		const f = await feed(owner, CONFIG);
		expect((await tick()).done).toBe(1);
		expect(sent).toEqual([]);
		expect(await forecast(owner, f.pid)).toBeNull();
		const row = await feedRow(f.feedId);
		expect(row).toMatchObject({ consecutive_failures: 0, last_error: null, last_success_at: null, last_data_date: null });
		expect(row.last_attempt_at).not.toBeNull();
	});

	it('CHIRPS_SOURCE=chc keeps the per-feed path: with FEED_FETCHER=sqs the request goes to the fetcher', async () => {
		vi.stubEnv('CHIRPS_SOURCE', 'chc');
		vi.stubEnv('FEED_FETCHER', 'sqs');
		vi.stubEnv('FETCH_REQUESTS_QUEUE_URL', 'https://sqs.test/fetch-requests');
		const owner = await signUp('GefsChc');
		const f = await feed(owner, CONFIG);
		expect((await tick()).done).toBe(1);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ type: 'fetch', feedId: f.feedId, request: { source: 'chirps_gefs' } });
		expect(await forecast(owner, f.pid)).toBeNull();
	});
});
