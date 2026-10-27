// After the cutover (issue #604 R3-C): with CHIRPS_SOURCE=mirror and
// DWS_SOURCE=store, every feed fetch is read in the worker's own job, so a
// production-shaped worker (on Lambda, FEED_SOURCE=live) sends no
// FetchRequest and makes no live request, for each source, whether
// FEED_FETCHER is unset (as Terraform renders it then, infra/feeds.tf) or
// still sqs (the apply between the flag flip and the queues going). Negative
// control: a source still on the old value with FEED_FETCHER unset would go
// inline, and the live client refuses that on Lambda (feeds/http.ts), so the
// job fails rather than ask an upstream.
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
vi.mock('../transport.js', async (orig) => ({
	...(await orig<typeof import('../transport.js')>()),
	sendToQueue: async (_url: string | undefined, _name: string, message: unknown) => void sent.push(message)
}));
import { MIRROR_FIXTURE_DIR } from '../../../scripts/gen-mirror-fixture.js';
import { asOwner, signUp } from '../../__tests__/helpers.js';
import { FIXTURE_CELL } from '../../feeds/fixtures.js';
import { runTick } from '../runner.js';

type User = Awaited<ReturnType<typeof signUp>>;

const tmp: string[] = [];
afterAll(() => tmp.forEach((d) => rmSync(d, { recursive: true, force: true })));
afterEach(async () => {
	sent.length = 0;
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	await asOwner('DELETE FROM data_feed');
	await asOwner(`DELETE FROM job WHERE kind IN ('feed_fetch', 'feed_ingest')`);
	await asOwner('DELETE FROM chirps_cell_year');
	await asOwner('DELETE FROM chirps_file');
});

const tick = () => runTick({ feeds: false, reports: false, alerts: false });
const today = () => new Date().toISOString().slice(0, 10);
const add = (iso: string, n: number) => fromEpochDay(toEpochDay(iso) + n);

const CONFIGS = {
	chirps: () => ({ cells: [{ ...FIXTURE_CELL(), weight: 1 }], product: 'sat', startDate: '2025-12-15' }),
	chirps_gefs: () => ({ cells: [{ ...FIXTURE_CELL(), weight: 1 }] }),
	dws: () => ({ station: 'X0H000', startDate: add(today(), -100) })
} as const;
type Source = keyof typeof CONFIGS;

async function feed(owner: User, source: Source) {
	const pid = (await owner.call('POST', '/projects', { name: `Cutover ${source}` })).body.project.id as string;
	const r = await owner.call('POST', `/projects/${pid}/feeds`, { source, config: CONFIGS[source]() });
	expect(r.status, JSON.stringify(r.body)).toBe(201);
	const feedId = r.body.feed.id as string;
	await owner.call('POST', `/projects/${pid}/feeds/${feedId}/run-now`);
	return feedId;
}
const feedRow = async (id: string) =>
	(await asOwner('SELECT consecutive_failures, last_error, last_attempt_at FROM data_feed WHERE id = $1', [id]))[0] as {
		consecutive_failures: number;
		last_error: string | null;
		last_attempt_at: Date | null;
	};

/** A production-shaped worker after the cutover: on Lambda, live, reading our copy (a private copy of the fixture one) and the store. */
function cutoverWorker(feedFetcher: 'sqs' | undefined) {
	const dir = mkdtempSync(join(tmpdir(), 'wm-cutover-'));
	tmp.push(dir);
	cpSync(MIRROR_FIXTURE_DIR, dir, { recursive: true });
	vi.stubEnv('FEED_SOURCE', 'live');
	vi.stubEnv('MIRROR_URL', pathToFileURL(`${dir}/`).href);
	vi.stubEnv('CHIRPS_SOURCE', 'mirror');
	vi.stubEnv('DWS_SOURCE', 'store');
	if (feedFetcher) {
		vi.stubEnv('FEED_FETCHER', feedFetcher);
		vi.stubEnv('FETCH_REQUESTS_QUEUE_URL', 'https://sqs.test/fetch-requests');
	} else vi.stubEnv('FEED_FETCHER', '');
	return dir;
}

/** Run the queued fetch as the worker Lambda would (AWS_LAMBDA_FUNCTION_NAME only for the tick: sign-up is the API's). */
async function tickOnLambda() {
	vi.stubEnv('AWS_LAMBDA_FUNCTION_NAME', 'water-management-worker');
	try {
		return await tick();
	} finally {
		vi.stubEnv('AWS_LAMBDA_FUNCTION_NAME', '');
	}
}

describe('after the cutover (CHIRPS_SOURCE=mirror, DWS_SOURCE=store) no feed fetch leaves the worker', () => {
	for (const feedFetcher of [undefined, 'sqs'] as const) {
		for (const source of Object.keys(CONFIGS) as Source[]) {
			it(`${source}, FEED_FETCHER ${feedFetcher ?? 'unset'}: no FetchRequest, no live request, no failure`, async () => {
				cutoverWorker(feedFetcher);
				const owner = await signUp(`Cutover-${source}-${feedFetcher ?? 'unset'}`);
				const feedId = await feed(owner, source);
				const fetchSpy = vi.spyOn(globalThis, 'fetch');
				const r = await tickOnLambda();
				expect(r).toMatchObject({ done: 1, failed: 0 });
				expect(sent).toEqual([]);
				expect(fetchSpy).not.toHaveBeenCalled();
				// The fetch ran (it looked), and nothing failed: the copy or store answered, or the feed waits for it.
				const row = await feedRow(feedId);
				expect(row).toMatchObject({ consecutive_failures: 0, last_error: null });
				expect(row.last_attempt_at).not.toBeNull();
			});
		}
	}

	it('negative control: a source still on the old value with FEED_FETCHER unset would fetch inline, and the live client refuses it on Lambda', async () => {
		cutoverWorker(undefined);
		vi.stubEnv('CHIRPS_SOURCE', 'chc');
		const owner = await signUp('CutoverNegative');
		await feed(owner, 'chirps');
		const fetchSpy = vi.spyOn(globalThis, 'fetch');
		const r = await tickOnLambda();
		expect(r.done).toBe(0);
		expect(sent).toEqual([]);
		expect(fetchSpy).not.toHaveBeenCalled();
		// Dead at once (no retry can fix a configuration), saying why.
		const [job] = await asOwner(`SELECT status, last_error FROM job WHERE kind = 'feed_fetch' ORDER BY created_at DESC LIMIT 1`);
		expect(job.status).toBe('dead');
		expect(job.last_error).toMatch(/^this worker may not fetch chirps from the source itself/);
	});
});

describe('a CHIRPS fetch from the copy then fills the gap-filling products (issue #604 R4-B)', () => {
	it('a broken ERA5-Land copy: the CHIRPS days still commit, the job is done, and the feed records the failed fill', async () => {
		const dir = cutoverWorker(undefined);
		writeFileSync(join(dir, 'era5l', 'zarr.json'), 'not json');
		const owner = await signUp('CutoverGapFill');
		const feedId = await feed(owner, 'chirps');
		const [{ project_id: pid }] = await asOwner('SELECT project_id FROM data_feed WHERE id = $1', [feedId]);
		expect((await owner.call('PATCH', `/projects/${pid}`, { settings: { gapRain: { product: 'era5l', imergLate: false } } })).status).toBe(200);
		expect(await tickOnLambda()).toMatchObject({ done: 1, failed: 0 });
		const [row] = await asOwner('SELECT consecutive_failures, last_error, last_meta FROM data_feed WHERE id = $1', [feedId]);
		expect(row).toMatchObject({ consecutive_failures: 0, last_error: null });
		// The CHIRPS answer's own meta (the ingest wrote it), and the fill's outcome merged in after it.
		expect(row.last_meta).toMatchObject({ product: 'sat', gapEra5l: 'failed:format' });
		const [series] = await asOwner(`SELECT cardinality("values") AS n FROM time_series WHERE feed_id = $1`, [feedId]);
		expect(series.n).toBeGreaterThan(0);
	});
});
