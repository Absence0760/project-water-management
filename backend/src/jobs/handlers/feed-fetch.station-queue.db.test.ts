// A production-shaped worker (FEED_FETCHER=sqs) routes a station API feed's fetch to its own queue
// (STATION_FETCH_REQUESTS_QUEUE_URL, issue #784; infra/feeds.tf "Station fetches apart"), grouped by its host, and a
// DWS feed's to the shared fetch-requests queue (positive control). With no station queue the job fails at once,
// saying why, and nothing is sent: never the shared queue.
//
// DB test files run one at a time; afterEach removes every feed and feed job.
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { sent } = vi.hoisted(() => ({ sent: [] as { url: string | undefined; name: string; group?: string }[] }));
vi.mock('../transport.js', async (orig) => ({
	...(await orig<typeof import('../transport.js')>()),
	sendToQueue: async (url: string | undefined, name: string, _message: unknown, fifo?: { group: string }) => {
		if (!url) throw new Error(`${name} is not set`);
		sent.push({ url, name, group: fifo?.group });
	}
}));
import { asOwner, signUp } from '../../__tests__/helpers.js';
import { STATION_FIXTURE_KEY } from '../../feeds/stationFixtures.js';
import { runTick } from '../runner.js';

type User = Awaited<ReturnType<typeof signUp>>;

const SHARED = 'https://sqs.test/fetch-requests.fifo';
const STATION = 'https://sqs.test/station-fetch-requests.fifo';

afterEach(async () => {
	sent.length = 0;
	vi.unstubAllEnvs();
	await asOwner('DELETE FROM data_feed');
	await asOwner(`DELETE FROM job WHERE kind IN ('feed_fetch', 'feed_ingest')`);
});

const tick = () => runTick({ feeds: false, reports: false, alerts: false });
const today = () => new Date().toISOString().slice(0, 10);
const BODIES = {
	station_api: {
		config: {
			url: 'https://station.example/v1/keyed/daily.json?station={station}&start={start}&end={end}',
			station: 'ST-001',
			auth: { kind: 'bearer' },
			format: { format: 'json', records: 'data', time: 'date', value: 'rain_mm', timeFormat: 'YYYY-MM-DD', resolution: 'daily' }
		},
		credential: { secret: STATION_FIXTURE_KEY }
	},
	dws: { config: { station: 'X0H000', startDate: fromEpochDay(toEpochDay(today()) - 100) } }
} as const;

async function runFeed(owner: User, source: keyof typeof BODIES) {
	const pid = (await owner.call('POST', '/projects', { name: `Queue ${source}` })).body.project.id as string;
	const r = await owner.call('POST', `/projects/${pid}/feeds`, { source, ...BODIES[source] });
	expect(r.status, JSON.stringify(r.body)).toBe(201);
	const fid = r.body.feed.id as string;
	expect((await owner.call('POST', `/projects/${pid}/feeds/${fid}/run-now`)).status).toBe(202);
	return { fid, result: await tick() };
}

function sqsWorker(station: string | undefined) {
	vi.stubEnv('FEED_FETCHER', 'sqs');
	vi.stubEnv('FETCH_REQUESTS_QUEUE_URL', SHARED);
	vi.stubEnv('STATION_FETCH_REQUESTS_QUEUE_URL', station ?? '');
}

describe('feed_fetch routes station API fetches to their own queue', () => {
	it('a station API feed goes to STATION_FETCH_REQUESTS_QUEUE_URL, grouped by its host', async () => {
		sqsWorker(STATION);
		const { result } = await runFeed(await signUp('QueueStation'), 'station_api');
		expect(result).toMatchObject({ done: 1, failed: 0 });
		expect(sent).toEqual([{ url: STATION, name: 'STATION_FETCH_REQUESTS_QUEUE_URL', group: 'station:station.example' }]);
	});

	it('a DWS feed still goes to the shared fetch-requests queue (positive control)', async () => {
		sqsWorker(STATION);
		const { result } = await runFeed(await signUp('QueueDws'), 'dws');
		expect(result).toMatchObject({ done: 1, failed: 0 });
		expect(sent).toEqual([{ url: SHARED, name: 'FETCH_REQUESTS_QUEUE_URL', group: 'dws' }]);
	});

	it('with no station queue the fetch fails at once, saying why, and nothing goes to the shared queue', async () => {
		sqsWorker(undefined);
		const { result } = await runFeed(await signUp('QueueStationOff'), 'station_api');
		expect(result.done).toBe(0);
		expect(sent).toEqual([]);
		const jobs = (await asOwner(`SELECT status, attempts, last_error FROM job WHERE kind = 'feed_fetch'`)) as { status: string; last_error: string | null }[];
		expect(jobs).toHaveLength(1);
		expect(jobs[0]!.status).toBe('dead');
		expect(jobs[0]!.last_error).toMatch(/STATION_FETCH_REQUESTS_QUEUE_URL is not set/);
	});
});
