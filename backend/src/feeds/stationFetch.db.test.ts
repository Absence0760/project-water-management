// A station API feed fetched end to end on the fixtures (issue #784): the inline path (FEED_FETCHER=inline,
// FEED_SOURCE=fixtures) from Run now through the fetch job, the sealed key opened in the job, the synthetic API on
// station.example, and the ingest into rain_catchment_mm; a refused key and a missing one recorded on the feed with
// our message; and a caught-up fetch queueing no other (the chain 296 fixed for agera5_et0).
//
// DB test files run one at a time; afterEach removes every feed, so no other file's tick finds one due.
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { runTick } from '../jobs/runner.js';
import { FEED_KEY_PREFIX, FEED_REFUSED_PREFIX } from './errors.js';
import { STATION_FIRST_DAYS, STATION_KEY_PROBLEMS } from './sources/station.js';
import { STATION_FIXTURE_KEY, stationFixtureRain } from './stationFixtures.js';

type User = Awaited<ReturnType<typeof signUp>>;

afterEach(async () => {
	vi.unstubAllEnvs();
	await asOwner('DELETE FROM data_feed');
	await asOwner(`DELETE FROM job WHERE kind IN ('feed_fetch', 'feed_ingest')`);
});

const tick = () => runTick({ feeds: false, reports: false, alerts: false });
const config = (over: Record<string, unknown> = {}) => ({
	url: 'https://station.example/v1/keyed/daily.json?station={station}&start={start}&end={end}',
	station: 'ST-001',
	auth: { kind: 'bearer' },
	format: { format: 'json', records: 'data', time: 'date', value: 'rain_mm', timeFormat: 'YYYY-MM-DD', resolution: 'daily' },
	...over
});

async function attach(owner: User, body: Record<string, unknown>) {
	const pid = (await owner.call('POST', '/projects', { name: 'Station fetch' })).body.project.id as string;
	const created = await owner.call('POST', `/projects/${pid}/feeds`, { source: 'station_api', ...body });
	expect(created.status).toBe(201);
	const fid = created.body.feed.id as string;
	expect((await owner.call('POST', `/projects/${pid}/feeds/${fid}/run-now`)).status).toBe(202);
	expect((await tick()).done).toBe(1);
	const row = (
		await asOwner(`SELECT to_char(last_data_date, 'YYYY-MM-DD') AS last_data_date, consecutive_failures, last_error, last_meta FROM data_feed WHERE id = $1`, [fid])
	)[0] as { last_data_date: string | null; consecutive_failures: number; last_error: string | null; last_meta: Record<string, unknown> | null };
	return { pid, fid, row };
}

async function rain(owner: User, pid: string) {
	const list = (await owner.call('GET', `/projects/${pid}/series`)).body.series as { id: string; kind: string }[];
	const meta = list.find((s) => s.kind === 'rain_catchment_mm');
	return meta ? ((await owner.call('GET', `/projects/${pid}/series/${meta.id}`)).body as { startDate: string; values: (number | null)[] }) : null;
}

/** Yesterday in Johannesburg, the fixture's zone and the format's default: the newest day a daily station can have. */
const yesterday = () => fromEpochDay(toEpochDay(new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg' }).format(new Date())) - 1);

describe('station API feed: fetched inline from the synthetic API', () => {
	it('opens the sealed key, reads the days into rain_catchment_mm and queues no further fetch once caught up', async () => {
		const owner = await signUp('StationFetchOwner');
		const { pid, row } = await attach(owner, { config: config(), credential: { secret: STATION_FIXTURE_KEY } });
		expect(row).toMatchObject({ consecutive_failures: 0, last_error: null });
		const last = yesterday();
		const s = await rain(owner, pid);
		expect(s).not.toBeNull();
		const first = fromEpochDay(toEpochDay(last) + 1 - STATION_FIRST_DAYS);
		expect(s!.startDate >= first).toBe(true);
		// Every day the series holds is the fixture's rain for that date (a missing day stays a gap).
		s!.values.forEach((v, i) => expect(v).toBe(stationFixtureRain(fromEpochDay(toEpochDay(s!.startDate) + i))));
		const newest = fromEpochDay(toEpochDay(s!.startDate) + s!.values.length - 1);
		expect(newest <= last).toBe(true);
		expect(row.last_data_date).toBe(newest);
		expect(row.last_meta).toMatchObject({ through: last, requests: 3 });
		// The meta names no URL, host or key.
		expect(JSON.stringify(row.last_meta)).not.toMatch(/station\.example|keyed|fixture-station-key/);
		// Caught up: no other fetch queued behind it.
		expect(await asOwner(`SELECT id FROM job WHERE kind = 'feed_fetch' AND status = 'queued'`)).toEqual([]);
	});

	it('records a refused key as a refusal (the feed waits hours), naming no key, and writes nothing', async () => {
		const owner = await signUp('StationRefusedOwner');
		const { pid, row } = await attach(owner, { config: config(), credential: { secret: 'a-wrong-key-a-wrong-key' } });
		expect(row.consecutive_failures).toBe(1);
		expect(row.last_error!.startsWith(FEED_REFUSED_PREFIX)).toBe(true);
		expect(row.last_error).not.toContain('a-wrong-key');
		expect(await rain(owner, pid)).toBeNull();
	});

	it('records a missing key as the key’s problem, asking the API nothing', async () => {
		const owner = await signUp('StationNoKeyOwner');
		const { row } = await attach(owner, { config: config() });
		expect(row).toMatchObject({ consecutive_failures: 1, last_error: `${FEED_KEY_PREFIX}: ${STATION_KEY_PROBLEMS.missing[0]}` });
	});
});
