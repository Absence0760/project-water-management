// Which queue a fetch request goes to (feed-fetch.ts fetchQueue, issue #784): station API feeds to their own, with
// its own fetcher trigger (infra/feeds.tf, "Station fetches apart"), every other source to fetch-requests, and a
// station fetch never to the shared queue, even when its own is unset.
import { describe, expect, it } from 'vitest';
import { FEED_SOURCES } from '../../feeds/config.js';
import { fetchQueue } from './feed-fetch.js';

const env = { FETCH_REQUESTS_QUEUE_URL: 'https://sqs.test/fetch-requests.fifo', STATION_FETCH_REQUESTS_QUEUE_URL: 'https://sqs.test/station-fetch-requests.fifo' };

describe('fetchQueue', () => {
	it('sends a station API fetch to its own queue', () => {
		expect(fetchQueue('station_api', env)).toEqual({ url: env.STATION_FETCH_REQUESTS_QUEUE_URL, name: 'STATION_FETCH_REQUESTS_QUEUE_URL' });
	});

	it('sends every other source to fetch-requests (positive control)', () => {
		const others = FEED_SOURCES.filter((s) => s !== 'station_api');
		expect(others).toEqual(expect.arrayContaining(['chirps', 'chirps_gefs', 'dws']));
		for (const source of others) expect(fetchQueue(source, env), source).toEqual({ url: env.FETCH_REQUESTS_QUEUE_URL, name: 'FETCH_REQUESTS_QUEUE_URL' });
	});

	it('never falls back to the shared queue when the station queue is unset', () => {
		const q = fetchQueue('station_api', { FETCH_REQUESTS_QUEUE_URL: env.FETCH_REQUESTS_QUEUE_URL });
		expect(q.url).toBeUndefined();
		expect(q.name).toBe('STATION_FETCH_REQUESTS_QUEUE_URL');
	});
});
