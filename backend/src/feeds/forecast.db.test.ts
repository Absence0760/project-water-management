// The CHIRPS-GEFS forecast's issues in the series (feeds/ingest.ts): each
// issue replaces the one before from its issue date on, an older issue never
// overwrites a newer one (the production path's ingest-results queue can
// deliver out of order), and a forecast result must be keyed by its issue.
//
// DB test files run one at a time; like feeds.db.test.ts, afterEach removes
// every feed so no other file's tick finds one due.
import { fromEpochDay, toEpochDay } from '@water-management/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { forecastRainSource } from '../runs/execute.js';
import { fetchWindow, utcToday } from './fetch.js';
import { FIXTURE_CELL } from './fixtures.js';
import { ingestResult } from './ingest.js';
import { feedForJob } from './store.js';

type User = Awaited<ReturnType<typeof signUp>>;

afterEach(async () => {
	await asOwner('DELETE FROM data_feed');
});

const day = (n: number) => fromEpochDay(toEpochDay(utcToday()) + n);
/** A whole 16-day issue, every day `mm`. */
const issue = (issuedOffset: number, mm: number) => ({
	ok: true,
	startDate: day(issuedOffset),
	values: new Array(16).fill(mm),
	meta: { days: 16, issued: day(issuedOffset) }
});

async function forecastFeed(name: string) {
	const owner = await signUp(name);
	const pid = (await owner.call('POST', '/projects', { name })).body.project.id as string;
	const feedId = (await owner.call('POST', `/projects/${pid}/feeds`, { source: 'chirps_gefs', config: { cells: [{ ...FIXTURE_CELL(), weight: 1 }] } })).body.feed
		.id as string;
	// As the feed_ingest handler does: read the feed, then ingest, in one transaction as the acting user.
	const ingest = (raw: unknown) =>
		withUser(owner.id, async (db) => {
			const feed = (await feedForJob(db, pid, feedId))!;
			return ingestResult(db, feed, raw, fetchWindow('chirps_gefs', feed.config, feed.lastDataDate, utcToday()));
		});
	return { owner, pid, feedId, ingest };
}

const forecast = async (u: User, pid: string) => {
	const list = (await u.call('GET', `/projects/${pid}/series`)).body.series as { id: string; kind: string }[];
	const meta = list.find((s) => s.kind === 'rain_forecast_mm');
	return meta ? ((await u.call('GET', `/projects/${pid}/series/${meta.id}`)).body as { startDate: string; values: (number | null)[] }) : null;
};
const feedRow = async (id: string) =>
	(await asOwner(
		`SELECT to_char(last_data_date, 'YYYY-MM-DD') AS last_data_date, last_meta, consecutive_failures, last_error, last_success_at, last_attempt_at
		 FROM data_feed WHERE id = $1`,
		[id]
	))[0] as {
		last_data_date: string | null;
		last_success_at: Date | null;
		last_attempt_at: Date | null;
		last_meta: Record<string, unknown> | null;
		consecutive_failures: number;
		last_error: string | null;
	};

describe('forecast issues in the series', () => {
	it('each issue replaces the last from its issue date on; the days before it keep what they had', async () => {
		const { owner, pid, feedId, ingest } = await forecastFeed('Superseder');
		expect(await ingest(issue(-1, 1))).toEqual({ merged: 16, lastDate: day(14) });
		expect(await ingest(issue(0, 5))).toEqual({ merged: 16, lastDate: day(15) });
		const s = (await forecast(owner, pid))!;
		expect(s.startDate).toBe(day(-1));
		// Yesterday's lead-0 day, then today's issue whole: no day of the older issue left inside the newer one's horizon.
		expect(s.values).toEqual([1, ...new Array(16).fill(5)]);
		expect(await feedRow(feedId)).toMatchObject({ last_data_date: day(15), last_meta: { issued: day(0), merged: 16 } });
	});

	it('an older issue arriving after a newer one (a delayed or redelivered ingest-results message) changes nothing but the check time', async () => {
		const { owner, pid, feedId, ingest } = await forecastFeed('LateIssue');
		// Yesterday's issue stands in for "the newer one": today's is the newest the source can have.
		await ingest(issue(-1, 5));
		// Checked an hour ago, so a new check time is plainly later.
		await asOwner(`UPDATE data_feed SET last_attempt_at = now() - interval '1 hour' WHERE id = $1`, [feedId]);
		const before = await feedRow(feedId);
		expect(await ingest(issue(-2, 1))).toEqual({ merged: 0, lastDate: null });
		expect((await forecast(owner, pid))!).toEqual(expect.objectContaining({ startDate: day(-1), values: new Array(16).fill(5) }));
		// Nor does its health: the newer issue's meta, data date and success
		// stand. The fetch did reach the source, though, so its check time moves (#33).
		const after = await feedRow(feedId);
		expect({ ...after, last_attempt_at: null }).toEqual({ ...before, last_attempt_at: null });
		expect(after.last_attempt_at!.getTime()).toBeGreaterThan(before.last_attempt_at!.getTime());

		// Positive controls: the same issue again (a re-fetch) and a newer one both merge.
		expect(await ingest(issue(-1, 6))).toEqual({ merged: 16, lastDate: day(14) });
		expect(await ingest(issue(0, 7))).toEqual({ merged: 16, lastDate: day(15) });
		expect((await forecast(owner, pid))!.values).toEqual([6, ...new Array(16).fill(7)]);
		expect((await feedRow(feedId)).last_meta).toMatchObject({ issued: day(0) });
	});

	it('two ingests of one feed at once: the older issue waits for the newer to commit, then sees it and is dropped', async () => {
		const { owner, pid, feedId, ingest } = await forecastFeed('RacingIssues');
		let newerIngested!: () => void;
		let commitNewer!: () => void;
		const newerHasIngested = new Promise<void>((r) => (newerIngested = r));
		const newerMayCommit = new Promise<void>((r) => (commitNewer = r));
		const newer = withUser(owner.id, async (db) => {
			const feed = (await feedForJob(db, pid, feedId))!;
			const out = await ingestResult(db, feed, issue(0, 5), fetchWindow('chirps_gefs', feed.config, null, utcToday()));
			newerIngested();
			await newerMayCommit;
			return out;
		});
		await newerHasIngested;
		let olderDone = false;
		const older = ingest(issue(-1, 1)).finally(() => (olderDone = true));
		// Commit the newer once the older has finished or is waiting on a lock.
		const waiting = async () => (await asOwner('SELECT 1 FROM pg_locks WHERE NOT granted')).length > 0;
		await expect.poll(async () => olderDone || (await waiting()), { timeout: 10_000 }).toBe(true);
		commitNewer();
		expect(await newer).toEqual({ merged: 16, lastDate: day(15) });
		expect(await older).toEqual({ merged: 0, lastDate: null });
		expect((await forecast(owner, pid))!).toEqual(expect.objectContaining({ startDate: day(0), values: new Array(16).fill(5) }));
		expect((await feedRow(feedId)).last_meta).toMatchObject({ issued: day(0) });
	});

	it('a forecast run credits CHIRPS-GEFS only while the feed wrote every forecast day: a person’s write makes it “other”', async () => {
		const { owner, pid, ingest } = await forecastFeed('GefsSource');
		await ingest(issue(0, 5));
		const seriesId = ((await owner.call('GET', `/projects/${pid}/series`)).body.series as { id: string; kind: string }[]).find((x) => x.kind === 'rain_forecast_mm')!.id;
		const source = (from: string) => withUser(owner.id, (db) => forecastRainSource(db, seriesId, from));
		expect(await source(day(0))).toBe('chirps_gefs');
		expect(await source(day(3))).toBe('chirps_gefs');
		// A day before the feed's first is not its own.
		expect(await source(day(-1))).toBe('other');
		// A person's replace makes every day theirs (031_feed_days).
		expect((await owner.call('PUT', `/projects/${pid}/series`, { kind: 'rain_forecast_mm', unit: 'mm', startDate: day(0), values: new Array(16).fill(5) })).status).toBe(200);
		expect(await source(day(0))).toBe('other');
		// No series at all: nothing to credit.
		expect(await withUser(owner.id, (db) => forecastRainSource(db, undefined, day(0)))).toBe('other');
	});

	it.each([
		['no issue date', { ...issue(0, 1), meta: { days: 16 } }],
		['an issue date that is not a date', { ...issue(0, 1), meta: { days: 16, issued: 'today' } }],
		['days that start away from the issue date', { ...issue(0, 1), startDate: day(-30) }],
		['more days than an issue has', { ...issue(0, 1), values: new Array(17).fill(1) }]
	])('refuses a forecast result with %s: a failed fetch, nothing written', async (_, raw) => {
		const { owner, pid, feedId, ingest } = await forecastFeed('Unkeyed');
		expect(await ingest(raw)).toEqual({ merged: 0, lastDate: null });
		expect(await forecast(owner, pid)).toBeNull();
		expect(await feedRow(feedId)).toMatchObject({ consecutive_failures: 1, last_error: 'the fetcher’s answer was not valid, so nothing was written' });
	});
});
