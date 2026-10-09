// The re-check of cached CHIRPS finals CHC rewrites in place
// (210_chirps_final_recheck.sql; docs/architecture.md § Data feeds →
// Re-checking finals): who may read and write its tables (with positive
// controls), what chirps_recheck_claim gives a fetch and its bounds, what
// chirps_recheck_apply does with a changed and an unchanged tag, and the
// whole loop on the fixtures, with the rewrite fixture (chirps-rewrite.json)
// standing in for CHC: the files are HEADed, the rewritten ones' cached
// finals re-read, the series of every feed over the cell refreshed and the
// revision in the History, preliminary values untouched.
//
// DB test files run one at a time; like cellCache.db.test.ts this file
// removes every feed, feed job and cached cell after each test.
import { afterEach, describe, expect, it, vi } from 'vitest';

const { sent } = vi.hoisted(() => ({ sent: [] as unknown[] }));
vi.mock('../jobs/transport.js', async (orig) => ({
	...(await orig<typeof import('../jobs/transport.js')>()),
	sendToQueue: async (_url: string | undefined, _name: string, message: unknown) => void sent.push(message)
}));
import pg from 'pg';
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { parseFetchRequest } from '../jobs/transport.js';
import { revisedDays, staleLeft } from './cellCacheStore.js';
import { runFetch } from './fetch.js';
import { fixtureHttp } from './fixtures.js';
import { acceptIngestResult } from './schedule.js';
import { withoutUser, withUser } from '../db/tx.js';
import { runTick } from '../jobs/runner.js';
import { chcCell } from './cellCache.js';
import { FIXTURE_CELL, REWRITE_FIXTURE } from './fixtures.js';

type User = Awaited<ReturnType<typeof signUp>>;

afterEach(async () => {
	sent.length = 0;
	vi.unstubAllEnvs();
	await asOwner('DELETE FROM data_feed');
	await asOwner(`DELETE FROM job WHERE kind IN ('feed_fetch', 'feed_ingest')`);
	await asOwner('DELETE FROM chirps_cell_year');
	await asOwner('DELETE FROM chirps_file');
	await asOwner('DELETE FROM chirps_cell_stale');
	await asOwner('DELETE FROM chirps_revision');
});

const tick = () => runTick({ feeds: false, reports: false, alerts: false });
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (n: number) => fromEpochDay(toEpochDay(today()) + n);
const cell = () => ({ ...FIXTURE_CELL(), weight: 1 });
const home = () => chcCell(FIXTURE_CELL().lat, FIXTURE_CELL().lon);

async function project(owner: User, name = 'Recheck') {
	return (await owner.call('POST', '/projects', { name })).body.project.id as string;
}
async function chirpsFeed(owner: User, pid: string, config: Record<string, unknown> = { cells: [cell()], startDate: '2024-01-01' }, targetName?: string) {
	const r = await owner.call('POST', `/projects/${pid}/feeds`, { source: 'chirps', config, ...(targetName ? { targetName } : {}) });
	expect(r.status, JSON.stringify(r.body)).toBe(201);
	return r.body.feed.id as string;
}
/** A running job of `kind` for feed `feedId`, as `u` (what the functions ask of their caller). */
async function runningJob(u: User, pid: string, feedId: string, kind = 'feed_fetch') {
	await asOwner(`DELETE FROM job WHERE kind = 'feed_fetch' AND payload->>'feedId' = $1 AND status = 'queued'`, [feedId]);
	const id = (
		await asOwner(
			`WITH me AS (SELECT set_config('app.current_user_id', $3::text, false))
			 INSERT INTO job (project_id, kind, acting_user_id, payload) SELECT $1::uuid, $2, $3::uuid, jsonb_build_object('feedId', $4::text) FROM me RETURNING id`,
			[pid, kind, u.id, feedId]
		)
	)[0].id as string;
	await asOwner(`UPDATE job SET status = 'running', locked_until = now() + interval '5 minutes', lease_token = gen_random_uuid(), started_at = now() WHERE id = $1`, [id]);
	return id;
}
const claim = (u: User, feedId: string, args: unknown[]) =>
	withUser(u.id, (db) =>
		db.query<{ kind: string; day: string }>(`SELECT kind, to_char(day, 'YYYY-MM-DD') AS day FROM chirps_recheck_claim($1, $2, $3, $4, $5, $6, $7, $8) ORDER BY kind, day`, [feedId, ...args])
	);
const apply = (u: User, feedId: string, jobId: string, args: unknown[]) =>
	withUser(u.id, (db) => db.query<{ n: number }>('SELECT chirps_recheck_apply($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) AS n', [feedId, jobId, ...args]));
/** One cached cell-year row for (1600, col), 2024, with values `vals` (366, null = none) and `final`. */
async function cacheRow(col: number, vals: (number | null)[], final: boolean[]) {
	await asOwner(
		`INSERT INTO chirps_cell_year (origin, product, row_idx, col_idx, year, vals, final, final_through) VALUES ('chc', 'sat', 1600, $1, 2024, $2::real[], $3::boolean[], '2024-12-31')`,
		[col, vals, final]
	);
}
const doy = (iso: string) => toEpochDay(iso) - toEpochDay(`${iso.slice(0, 4)}-01-01`);
const fileRow = async (day: string) =>
	(await asOwner(`SELECT tag, checked_at IS NOT NULL AS checked, claim_job, revisions FROM chirps_file WHERE origin = 'chc' AND product = 'sat' AND day = $1`, [day]))[0] as
		| { tag: string | null; checked: boolean; claim_job: string | null; revisions: number }
		| undefined;
const stale = async () =>
	(await asOwner(`SELECT col_idx, to_char(day, 'YYYY-MM-DD') AS day FROM chirps_cell_stale ORDER BY col_idx, day`)) as { col_idx: number; day: string }[];

describe('the re-check tables: shared reference data', () => {
	it('any signed-in session reads them, nobody without one; water_app writes none of them, not even a project owner', async () => {
		const owner = await signUp('RecheckReader');
		await asOwner(`INSERT INTO chirps_file (origin, product, day, tag) VALUES ('chc', 'sat', '2024-03-01', '"a"')`);
		await asOwner(`INSERT INTO chirps_cell_stale (origin, product, row_idx, col_idx, day) VALUES ('chc', 'sat', 1600, 4100, '2024-03-01')`);
		await asOwner(`INSERT INTO chirps_revision (origin, product, day, cells_changed) VALUES ('chc', 'sat', '2024-03-01', 1)`);
		for (const table of ['chirps_file', 'chirps_cell_stale', 'chirps_revision']) {
			// Positive control: a signed-in session, member of nothing, reads the row.
			expect((await withUser(owner.id, (db) => db.query(`SELECT 1 FROM ${table}`))).rows, table).toHaveLength(1);
			expect((await withoutUser((db) => db.query(`SELECT 1 FROM ${table}`))).rows, table).toHaveLength(0);
			for (const sql of [`UPDATE ${table} SET day = day`, `DELETE FROM ${table}`]) {
				await expect(withUser(owner.id, (db) => db.query(sql)), sql).rejects.toMatchObject({ code: '42501' });
			}
		}
		await expect(withUser(owner.id, (db) => db.query(`INSERT INTO chirps_file (origin, product, day) VALUES ('chc', 'sat', '2024-03-02')`))).rejects.toMatchObject({ code: '42501' });
	});

	it('the claim and the apply take only a running data-feed job of the caller’s CHIRPS feed (positive control: one can)', async () => {
		const owner = await signUp('RecheckGate');
		const other = await signUp('RecheckOther');
		const pid = await project(owner);
		const feed = await chirpsFeed(owner, pid);
		const claimArgs = ['chc', 'sat', [1600], [4100], 1, 1, 90];
		const applyArgs = ['chc', 'sat', [], [], [], [], [1600], [4100], []];
		await expect(claim(owner, feed, claimArgs)).rejects.toMatchObject({ code: '42501' });
		await expect(apply(owner, feed, crypto.randomUUID(), applyArgs)).rejects.toMatchObject({ code: '42501' });
		// Another person's running job of the feed doesn't count for them.
		const job = await runningJob(owner, pid, feed);
		await expect(claim(other, feed, claimArgs)).rejects.toMatchObject({ code: '42501' });
		await expect(apply(other, feed, job, applyArgs)).rejects.toMatchObject({ code: '42501' });
		expect((await claim(owner, feed, claimArgs)).rows).toEqual([]);
		expect((await apply(owner, feed, job, applyArgs)).rows[0]!.n).toBe(0);
		// The claim is the fetch's: an ingest job doesn't claim, but applies (the fetch's lease gone).
		const ingest = await runningJob(owner, pid, feed, 'feed_ingest');
		await asOwner(`UPDATE job SET locked_until = now() - interval '1 second' WHERE id = $1`, [job]);
		await expect(claim(owner, feed, claimArgs)).rejects.toMatchObject({ code: '42501' });
		expect((await apply(owner, feed, job, applyArgs)).rows[0]!.n).toBe(0);
		expect(ingest).toBeTruthy();
	});
});

describe('chirps_recheck_claim', () => {
	it('gives the cells’ stale days first, then untagged files they hold final, then tagged files to HEAD oldest checked first, within its bounds', async () => {
		const owner = await signUp('Claimer');
		const pid = await project(owner);
		const feed = await chirpsFeed(owner, pid);
		const job = await runningJob(owner, pid, feed);
		const vals = new Array(366).fill(1);
		await cacheRow(4100, vals, new Array(366).fill(true));
		// Tagged files 1–5 March, checked long ago (1st oldest) except the 5th (yesterday: not due); an untagged 10 March; a stale 20 March.
		for (const [d, ago] of [['01', 400], ['02', 300], ['03', 200], ['04', 100], ['05', 1]] as const) {
			await asOwner(`INSERT INTO chirps_file (origin, product, day, tag, checked_at) VALUES ('chc', 'sat', $1, '"t"', now() - make_interval(days => $2))`, [`2024-03-${d}`, ago]);
		}
		await asOwner(`INSERT INTO chirps_file (origin, product, day) VALUES ('chc', 'sat', '2024-03-10')`);
		await asOwner(`INSERT INTO chirps_cell_stale (origin, product, row_idx, col_idx, day) VALUES ('chc', 'sat', 1600, 4100, '2024-03-20')`);
		const got = (await claim(owner, feed, ['chc', 'sat', [1600], [4100], 3, 2, 90])).rows;
		expect(got).toEqual([
			{ kind: 'head', day: '2024-03-01' },
			{ kind: 'head', day: '2024-03-02' },
			{ kind: 'head', day: '2024-03-03' },
			{ kind: 'reread', day: '2024-03-20' },
			{ kind: 'verify', day: '2024-03-10' }
		]);
		expect(await fileRow('2024-03-01')).toMatchObject({ checked: true, claim_job: job });
		// Claimed means checked now: a second claim takes the one tagged file left due, and no untagged one.
		expect((await claim(owner, feed, ['chc', 'sat', [1600], [4100], 3, 2, 90])).rows).toEqual([
			{ kind: 'head', day: '2024-03-04' },
			{ kind: 'reread', day: '2024-03-20' }
		]);
		// An untagged file the cells don't hold final isn't theirs to verify.
		await asOwner(`INSERT INTO chirps_file (origin, product, day) VALUES ('chc', 'sat', '2023-06-01')`);
		expect((await claim(owner, feed, ['chc', 'sat', [1600], [4100], 0, 2, 90])).rows).toEqual([{ kind: 'reread', day: '2024-03-20' }]);
		// Its bounds: at most 40 files and 10 days a fetch, an interval of 1 day to 10 years.
		for (const bad of [
			['chc', 'sat', [1600], [4100], 41, 1, 90],
			['chc', 'sat', [1600], [4100], 1, 11, 90],
			['chc', 'sat', [1600], [4100], 1, 1, 0],
			['web', 'sat', [1600], [4100], 1, 1, 90]
		]) {
			await expect(claim(owner, feed, bad), JSON.stringify(bad)).rejects.toMatchObject({ code: '23514' });
		}
	});
});

describe('chirps_recheck_apply', () => {
	async function setup(name: string) {
		const owner = await signUp(name);
		const pid = await project(owner);
		const feed = await chirpsFeed(owner, pid);
		const job = await runningJob(owner, pid, feed);
		// Two cells final at 1 mm on 1 March, and a third holding only a preliminary value that day.
		const day = doy('2024-03-01');
		const fin = new Array(366).fill(false);
		fin[day] = true;
		const vals = new Array(366).fill(null);
		vals[day] = 1;
		await cacheRow(4100, vals, fin);
		await cacheRow(4101, vals, fin);
		await cacheRow(4102, vals, new Array(366).fill(false));
		await asOwner(`INSERT INTO chirps_file (origin, product, day, tag, checked_at) VALUES ('chc', 'sat', '2024-03-01', '"old"', now() - interval '200 days')`);
		return { owner, pid, feed, job };
	}

	it('an unchanged tag changes nothing; a changed one marks every cached final of the day stale (never a preliminary one), and takes the new tag', async () => {
		const { owner, feed, job } = await setup('ApplyHead');
		expect((await claim(owner, feed, ['chc', 'sat', [1600], [4100], 1, 0, 90])).rows).toEqual([{ kind: 'head', day: '2024-03-01' }]);
		expect((await apply(owner, feed, job, ['chc', 'sat', ['2024-03-01'], ['"old"'], [], [], [1600], [4100], []])).rows[0]!.n).toBe(0);
		expect(await stale()).toEqual([]);
		expect(await fileRow('2024-03-01')).toMatchObject({ tag: '"old"', claim_job: null, revisions: 0 });
		// Not claimed any more: the same answer again is ignored, whatever tag it says.
		await apply(owner, feed, job, ['chc', 'sat', ['2024-03-01'], ['"new"'], [], [], [1600], [4100], []]);
		expect(await stale()).toEqual([]);
		// Claimed again (due again), and now the tag differs: both finals are stale, the preliminary cell isn't.
		await asOwner(`UPDATE chirps_file SET checked_at = now() - interval '200 days'`);
		await claim(owner, feed, ['chc', 'sat', [1600], [4100], 1, 0, 90]);
		expect((await apply(owner, feed, job, ['chc', 'sat', ['2024-03-01'], ['"new"'], [], [], [1600], [4100], []])).rows[0]!.n).toBe(0);
		expect(await stale()).toEqual([
			{ col_idx: 4100, day: '2024-03-01' },
			{ col_idx: 4101, day: '2024-03-01' }
		]);
		expect(await fileRow('2024-03-01')).toMatchObject({ tag: '"new"', revisions: 1 });
		// The values aren't touched until a read.
		expect((await asOwner(`SELECT vals[$1] AS v FROM chirps_cell_year WHERE col_idx = 4100`, [doy('2024-03-01') + 1]))[0].v).toBe(1);
	});

	it('a read of a stale day replaces the final (the one path that does), clears it, and logs the revision; only the cells read', async () => {
		const { owner, feed, job } = await setup('ApplyRead');
		await asOwner(`INSERT INTO chirps_cell_stale (origin, product, row_idx, col_idx, day) VALUES ('chc', 'sat', 1600, 4100, '2024-03-01'), ('chc', 'sat', 1600, 4101, '2024-03-01')`);
		await asOwner(`UPDATE chirps_file SET tag = '"new"'`);
		expect((await apply(owner, feed, job, ['chc', 'sat', [], [], ['2024-03-01'], ['"new"'], [1600], [4100], [1.25]])).rows[0]!.n).toBe(1);
		const v = await asOwner(`SELECT col_idx, vals[$1] AS v, final[$1] AS f FROM chirps_cell_year ORDER BY col_idx`, [doy('2024-03-01') + 1]);
		expect(v).toEqual([
			{ col_idx: 4100, v: 1.25, f: true },
			{ col_idx: 4101, v: 1, f: true },
			{ col_idx: 4102, v: 1, f: false }
		]);
		// 4101 is still stale, for its own feed to read; the tag was known and is unchanged, so nothing more is marked.
		expect(await stale()).toEqual([{ col_idx: 4101, day: '2024-03-01' }]);
		expect(await asOwner(`SELECT to_char(day, 'YYYY-MM-DD') AS day, cells_changed, tag_before, tag_after FROM chirps_revision`)).toEqual([
			{ day: '2024-03-01', cells_changed: 1, tag_before: '"new"', tag_after: '"new"' }
		]);
		// The same read again: the value is already there, nothing changes, nothing is logged.
		await asOwner(`INSERT INTO chirps_cell_stale (origin, product, row_idx, col_idx, day) VALUES ('chc', 'sat', 1600, 4100, '2024-03-01')`);
		expect((await apply(owner, feed, job, ['chc', 'sat', [], [], ['2024-03-01'], ['"new"'], [1600], [4100], [1.25]])).rows[0]!.n).toBe(0);
	});

	it('an untagged file read again whose values differ is a rewrite: the other cells’ finals of the day become stale too', async () => {
		const { owner, feed, job } = await setup('ApplyVerify');
		await asOwner(`UPDATE chirps_file SET tag = NULL, checked_at = NULL`);
		expect((await claim(owner, feed, ['chc', 'sat', [1600], [4100], 0, 1, 90])).rows).toEqual([{ kind: 'verify', day: '2024-03-01' }]);
		expect((await apply(owner, feed, job, ['chc', 'sat', [], [], ['2024-03-01'], ['"v2"'], [1600], [4100], [3]])).rows[0]!.n).toBe(1);
		expect(await stale()).toEqual([{ col_idx: 4101, day: '2024-03-01' }]);
		expect(await fileRow('2024-03-01')).toMatchObject({ tag: '"v2"', claim_job: null, revisions: 1 });
	});

	it('leaves alone a day the re-check didn’t ask for (a lapsed claim); refuses, whole, an implausible value or tag and a malformed answer; writes nothing', async () => {
		const { owner, pid, feed, job } = await setup('ApplyRefuse');
		// Not stale for these cells, not claimed by this fetch: ignored, nothing written.
		expect((await apply(owner, feed, job, ['chc', 'sat', [], [], ['2024-03-01'], ['"x"'], [1600], [4100], [2]])).rows[0]!.n).toBe(0);
		expect(await fileRow('2024-03-01')).toMatchObject({ tag: '"old"', revisions: 0 });
		// Another feed's fetch job (even the caller's own) can't answer this feed's claim.
		const otherFeed = await chirpsFeed(owner, pid, undefined, 'other rain');
		await claim(owner, feed, ['chc', 'sat', [1600], [4100], 1, 0, 90]);
		const stranger = crypto.randomUUID();
		await expect(apply(owner, feed, stranger, ['chc', 'sat', ['2024-03-01'], ['"new"'], [], [], [1600], [4100], []])).rejects.toMatchObject({ code: '42501' });
		const theirs = await runningJob(owner, pid, otherFeed);
		await expect(apply(owner, feed, theirs, ['chc', 'sat', ['2024-03-01'], ['"new"'], [], [], [1600], [4100], []])).rejects.toMatchObject({ code: '42501' });
		// Positive control: this feed's own fetch can.
		await apply(owner, feed, job, ['chc', 'sat', ['2024-03-01'], ['"new"'], [], [], [1600], [4100], []]);
		expect(await fileRow('2024-03-01')).toMatchObject({ tag: '"new"', revisions: 1 });
		await asOwner('DELETE FROM chirps_cell_stale');
		const bad = [
			['chc', 'sat', [], [], ['2024-03-01'], ['"x"'], [1600], [4100], [2500]],
			['chc', 'sat', ['2024-03-01'], ['bad\ttag'], [], [], [1600], [4100], []],
			['chc', 'sat', ['1997-12-31'], ['"x"'], [], [], [1600], [4100], []],
			['chc', 'sat', [], [], ['2024-03-01'], ['"x"'], [1600], [4100], [2, 3]]
		];
		await asOwner(`INSERT INTO chirps_cell_stale (origin, product, row_idx, col_idx, day) VALUES ('chc', 'sat', 1600, 4101, '2024-03-02')`);
		for (const args of bad) await expect(apply(owner, feed, job, args), JSON.stringify(args)).rejects.toMatchObject({ code: '23514' });
		expect((await asOwner(`SELECT vals[$1] AS v FROM chirps_cell_year WHERE col_idx = 4100`, [doy('2024-03-01') + 1]))[0].v).toBe(1);
		expect(await asOwner('SELECT 1 FROM chirps_revision')).toEqual([]);
	});

	it('a HEAD that finds the file gone (or untagged) releases the claim and keeps the tag; nothing goes stale', async () => {
		const { owner, feed, job } = await setup('ApplyGone');
		await claim(owner, feed, ['chc', 'sat', [1600], [4100], 1, 0, 90]);
		await apply(owner, feed, job, ['chc', 'sat', ['2024-03-01'], [null], [], [], [1600], [4100], []]);
		expect(await fileRow('2024-03-01')).toMatchObject({ tag: '"old"', claim_job: null, revisions: 0 });
		expect(await stale()).toEqual([]);
	});

	it('an untagged file read again with the same values records its tag and marks nothing; a read of a gone file clears the cells’ stale rows, logging nothing', async () => {
		const { owner, feed, job } = await setup('ApplySame');
		await asOwner(`UPDATE chirps_file SET tag = NULL, checked_at = NULL`);
		await claim(owner, feed, ['chc', 'sat', [1600], [4100], 0, 1, 90]);
		expect((await apply(owner, feed, job, ['chc', 'sat', [], [], ['2024-03-01'], ['"v1"'], [1600], [4100], [1]])).rows[0]!.n).toBe(0);
		expect(await fileRow('2024-03-01')).toMatchObject({ tag: '"v1"', claim_job: null, revisions: 0 });
		expect(await stale()).toEqual([]);
		// Gone: the cell's cached value stays, and it isn't read again.
		await asOwner(`INSERT INTO chirps_cell_stale (origin, product, row_idx, col_idx, day) VALUES ('chc', 'sat', 1600, 4100, '2024-03-01')`);
		expect((await apply(owner, feed, job, ['chc', 'sat', [], [], ['2024-03-01'], [null], [1600], [4100], [null]])).rows[0]!.n).toBe(0);
		expect(await stale()).toEqual([]);
		expect((await asOwner(`SELECT vals[$1] AS v FROM chirps_cell_year WHERE col_idx = 4100`, [doy('2024-03-01') + 1]))[0].v).toBe(1);
		expect(await asOwner('SELECT 1 FROM chirps_revision')).toEqual([]);
	});

	it('another fetch’s claim isn’t this one’s: its HEAD answer is ignored, and the file isn’t claimed twice', async () => {
		const { owner, pid, feed, job } = await setup('ApplyTheirs');
		await claim(owner, feed, ['chc', 'sat', [1600], [4100], 1, 0, 90]);
		await asOwner(`UPDATE job SET locked_until = now() - interval '1 second' WHERE id = $1`, [job]);
		const second = await runningJob(owner, pid, feed);
		expect((await claim(owner, feed, ['chc', 'sat', [1600], [4100], 1, 0, 90])).rows).toEqual([]);
		await apply(owner, feed, second, ['chc', 'sat', ['2024-03-01'], ['"new"'], [], [], [1600], [4100], []]);
		expect(await fileRow('2024-03-01')).toMatchObject({ tag: '"old"', claim_job: job });
		expect(await stale()).toEqual([]);
	});
});

describe('revisedDays and staleLeft (cellCacheStore.ts)', () => {
	const owner = () => new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });

	it('takes every revision committed since the marker, never one still running when it looked: that one comes next time', async () => {
		const u = await signUp('Revised');
		const look = (since: string | null, max = 400) => withUser(u.id, (db) => revisedDays(db, 'chc', 'sat', since, max));
		// A feed that never looked starts from now.
		const start = await look(null);
		expect(start).toMatchObject({ days: [], more: false });
		await asOwner(`INSERT INTO chirps_revision (origin, product, day, cells_changed) VALUES ('chc', 'sat', '2024-03-01', 1)`);
		// A revision still being written when the feed looks, committed only after.
		const late = owner();
		await late.connect();
		try {
			await late.query('BEGIN');
			await late.query(`INSERT INTO chirps_revision (origin, product, day, cells_changed) VALUES ('chc', 'sat', '2024-03-02', 1)`);
			const first = await look(start.next);
			expect(first.days).toEqual(['2024-03-01']);
			await late.query('COMMIT');
			const second = await look(first.next);
			expect(second.days).toEqual(['2024-03-02']);
			// And once taken, it isn't taken again; other products' aren't this one's.
			await asOwner(`INSERT INTO chirps_revision (origin, product, day, cells_changed) VALUES ('chc', 'rnl', '2024-03-03', 1), ('fixtures', 'sat', '2024-03-04', 1)`);
			expect((await look(second.next)).days).toEqual([]);
		} finally {
			await late.end();
		}
	});

	it('stopping at its own transaction’s revisions, it looks next from the oldest still running, so one committing later is taken then', async () => {
		const owner2 = await signUp('RevisedOwn');
		const pid = await project(owner2);
		const feed = await chirpsFeed(owner2, pid);
		const job = await runningJob(owner2, pid, feed);
		const fin = new Array(366).fill(false);
		fin[doy('2024-03-01')] = true;
		const vals = new Array(366).fill(null);
		vals[doy('2024-03-01')] = 1;
		await cacheRow(4100, vals, fin);
		await asOwner(`INSERT INTO chirps_file (origin, product, day, tag) VALUES ('chc', 'sat', '2024-03-01', '"t"')`);
		await asOwner(`INSERT INTO chirps_cell_stale (origin, product, row_idx, col_idx, day) VALUES ('chc', 'sat', 1600, 4100, '2024-03-01')`);
		const start = await withUser(owner2.id, (db) => revisedDays(db, 'chc', 'sat', null, 1));
		await asOwner(`INSERT INTO chirps_revision (origin, product, day, cells_changed) VALUES ('chc', 'sat', '2024-01-01', 1)`);
		const late = owner();
		await late.connect();
		try {
			await late.query('BEGIN');
			await late.query(`INSERT INTO chirps_revision (origin, product, day, cells_changed) VALUES ('chc', 'sat', '2024-02-01', 1)`);
			// The re-check's own revision (2024-03-01), in this transaction, after the committed one: the cap of 1 stops before it.
			const r = await withUser(owner2.id, async (db) => {
				await db.query('SELECT chirps_recheck_apply($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)', [feed, job, 'chc', 'sat', [], [], ['2024-03-01'], ['"t"'], [1600], [4100], [2]]);
				return revisedDays(db, 'chc', 'sat', start.next, 1);
			});
			expect(r).toMatchObject({ days: ['2024-01-01'], more: true });
			await late.query('COMMIT');
			const next = await withUser(owner2.id, (db) => revisedDays(db, 'chc', 'sat', r.next, 400));
			expect(next.days).toEqual(['2024-02-01', '2024-03-01']);
		} finally {
			await late.end();
		}
	});

	it('a marker past every transaction there is (a restored dump numbers them afresh) starts again from now', async () => {
		const u = await signUp('RevisedReset');
		const r = await withUser(u.id, (db) => revisedDays(db, 'chc', 'sat', '99999999999', 400));
		expect(r.days).toEqual([]);
		expect(BigInt(r.next) < 99999999999n).toBe(true);
	});

	it('stops at the cap between whole transactions, says so, and the next look takes the rest', async () => {
		const u = await signUp('RevisedCap');
		const look = (since: string | null, max: number) => withUser(u.id, (db) => revisedDays(db, 'chc', 'sat', since, max));
		const start = await look(null, 3);
		for (const days of [['2024-01-01', '2024-01-02'], ['2024-01-03', '2024-01-04'], ['2024-01-05']]) {
			await asOwner(`INSERT INTO chirps_revision (origin, product, day, cells_changed) SELECT 'chc', 'sat', d::date, 1 FROM unnest($1::text[]) d`, [days]);
		}
		const a = await look(start.next, 3);
		expect(a).toMatchObject({ days: ['2024-01-01', '2024-01-02'], more: true });
		const b = await look(a.next, 3);
		expect(b).toMatchObject({ days: ['2024-01-03', '2024-01-04', '2024-01-05'], more: false });
	});

	it('staleLeft: whether these cells hold a stale day of this origin and product', async () => {
		const u = await signUp('StaleLeft');
		await asOwner(`INSERT INTO chirps_cell_stale (origin, product, row_idx, col_idx, day) VALUES ('chc', 'sat', 1600, 4100, '2024-03-01')`);
		const left = (origin: 'chc' | 'fixtures', product: 'sat' | 'rnl', col: number) => withUser(u.id, (db) => staleLeft(db, origin, product, [{ row: 1600, col }]));
		expect(await left('chc', 'sat', 4100)).toBe(true);
		expect(await left('chc', 'sat', 4101)).toBe(false);
		expect(await left('chc', 'rnl', 4100)).toBe(false);
		expect(await left('fixtures', 'sat', 4100)).toBe(false);
	});
});

describe('the re-check end to end, on the fixtures with a rewrite (FEED_FETCHER=inline)', () => {
	/** Run every queued feed fetch, now (a follow-up waits a minute), until none is left or `max` ticks. */
	async function drain(max = 30) {
		for (let i = 0; i < max; i++) {
			await asOwner(`UPDATE job SET run_after = now() WHERE kind = 'feed_fetch' AND status = 'queued'`);
			if (!(await tick()).done) return i;
		}
		throw new Error('the feed fetches never stopped');
	}
	const series = async (u: User, pid: string) => {
		const list = (await u.call('GET', `/projects/${pid}/series`)).body.series as { id: string; kind: string }[];
		const meta = list.find((s) => s.kind === 'rain_chirps_mm')!;
		return (await u.call('GET', `/projects/${pid}/series/${meta.id}`)).body as { startDate: string; values: (number | null)[] };
	};
	const at = (s: { startDate: string; values: (number | null)[] }, day: string) => s.values[toEpochDay(day) - toEpochDay(s.startDate)];
	const cached = async (day: string) =>
		(await asOwner(`SELECT vals[$2] AS v, final[$2] AS f FROM chirps_cell_year WHERE origin = 'fixtures' AND product = 'sat' AND year = $1 AND row_idx = $3 AND col_idx = $4`, [
			Number(day.slice(0, 4)),
			doy(day) + 1,
			home().row,
			home().col
		]))[0] as { v: number; f: boolean };

	it('HEADs the cached finals, re-reads the rewritten ones, refreshes every feed over the cell with a History event; the rest and the preliminary days stay', async () => {
		const rw = REWRITE_FIXTURE();
		const a = await signUp('RewriteA');
		const b = await signUp('RewriteB');
		const config = { cells: [cell()], startDate: addDays(-(rw.fromDaysAgo + 10)) };
		const pa = await project(a, 'A');
		const fa = await chirpsFeed(a, pa, config);
		await a.call('POST', `/projects/${pa}/feeds/${fa}/run-now`);
		await drain();
		const pb = await project(b, 'B');
		const fb = await chirpsFeed(b, pb, config);
		await b.call('POST', `/projects/${pb}/feeds/${fb}/run-now`);
		await drain();
		const beforeA = await series(a, pa);
		const beforeB = await series(b, pb);
		expect(beforeB.values).toEqual(beforeA.values);
		// Every final read has its file's tag; nothing was due for a HEAD yet (each was just read).
		expect((await asOwner(`SELECT count(*)::int AS n FROM chirps_file WHERE origin = 'fixtures' AND (tag IS NULL OR revisions > 0)`))[0].n).toBe(0);
		const prelimDay = addDays(-10);
		const prelimBefore = await cached(prelimDay);
		expect(prelimBefore.f).toBe(false);

		// Ninety days on (as far as the cycle is concerned), CHC rewrites some finals in place.
		await asOwner(`UPDATE chirps_file SET checked_at = now() - interval '91 days' WHERE origin = 'fixtures'`);
		vi.stubEnv('FEED_FIXTURE_REWRITE', '1');
		await a.call('POST', `/projects/${pa}/feeds/${fa}/run-now`);
		const first = (await tick()).done;
		expect(first).toBe(1);
		// One fetch checks at most 40 files (and reads none yet: nothing was stale when it was claimed).
		const meta = (await asOwner('SELECT last_meta FROM data_feed WHERE id = $1', [fa]))[0].last_meta as Record<string, unknown>;
		expect(meta).toMatchObject({ filesChecked: 40, recheckDaysRead: 0 });
		expect(typeof meta.revisionXmin).toBe('string');
		await drain();

		const rewritten = (day: string) => {
			const back = toEpochDay(today()) - toEpochDay(day);
			return back >= rw.toDaysAgo && back <= rw.fromDaysAgo;
		};
		// B's next fetch (its daily one) reads nothing of it again, A's re-read having cleared the cell, but refreshes its days.
		await b.call('POST', `/projects/${pb}/feeds/${fb}/run-now`);
		await drain();
		const afterA = await series(a, pa);
		const afterB = await series(b, pb);
		let changed = 0;
		for (let d = toEpochDay(afterA.startDate); d < toEpochDay(afterA.startDate) + afterA.values.length; d++) {
			const day = fromEpochDay(d);
			const was = at(beforeA, day);
			if (rewritten(day)) {
				expect(at(afterA, day), day).toBeCloseTo(was! * rw.factor, 1);
				if (was) changed++;
			} else {
				expect(at(afterA, day), day).toBe(was);
			}
			// B never read the cell again (A's re-read cleared it), and its series has the new values all the same.
			expect(at(afterB, day), day).toBe(at(afterA, day));
		}
		expect(changed).toBeGreaterThan(5);
		// Only rewritten days with rain changed files (a dry day's file is the same bytes); each re-read once.
		const files = await asOwner(`SELECT to_char(day, 'YYYY-MM-DD') AS day, revisions FROM chirps_file WHERE origin = 'fixtures' AND revisions > 0 ORDER BY day`);
		expect(files.length).toBe(changed);
		expect(files.every((f: { day: string; revisions: number }) => rewritten(f.day) && f.revisions === 1)).toBe(true);
		expect(await asOwner('SELECT 1 FROM chirps_cell_stale')).toEqual([]);
		expect((await asOwner('SELECT sum(cells_changed)::int AS n FROM chirps_revision'))[0].n).toBe(changed);
		// The preliminary day is as it was, still preliminary.
		expect(await cached(prelimDay)).toEqual(prelimBefore);
		// The History of both projects names the revision.
		for (const pid of [pa, pb]) {
			const events = await asOwner(`SELECT subject FROM audit_event WHERE project_id = $1 AND kind = 'series.merged' AND subject ? 'chirpsRevision'`, [pid]);
			expect(events.length, pid).toBeGreaterThan(0);
			expect(events.reduce((n: number, e: { subject: { daysChanged: number } }) => n + e.subject.daysChanged, 0)).toBe(changed);
		}
		// The cycle goes on: nothing is due again for 90 days, so a fetch now checks no file.
		await a.call('POST', `/projects/${pa}/feeds/${fa}/run-now`);
		await drain();
		expect((await asOwner('SELECT last_meta FROM data_feed WHERE id = $1', [fa]))[0].last_meta).not.toHaveProperty('filesChecked');
	});

	describe('in production’s shape (FEED_FETCHER=sqs, the fetcher answering from the fixtures)', () => {
		type Msg = { fetchJobId: string; feedId: string; feedVersion: string; request: { start: string; end: string; cells?: { cells: [number, number][]; plan: string }; recheck?: { cells: [number, number][]; head: string[]; read: string[] } } };
		async function fetchJob(): Promise<Msg | null> {
			await asOwner(`UPDATE job SET run_after = now() WHERE kind = 'feed_fetch' AND status = 'queued'`);
			vi.stubEnv('FEED_FETCHER', 'sqs');
			vi.stubEnv('FETCH_REQUESTS_QUEUE_URL', 'https://sqs.test/fetch-requests');
			sent.length = 0;
			const done = (await tick()).done;
			vi.unstubAllEnvs();
			return done ? ((sent[0] as Msg | undefined) ?? null) : null;
		}
		async function answer(m: Msg, result?: unknown, rewrite = false) {
			const req = parseFetchRequest(JSON.stringify(m));
			if (!req) throw new Error('the fetcher would refuse the request');
			const r = result ?? (await runFetch(req.request, fixtureHttp(undefined, { rewrite })));
			expect(await acceptIngestResult({ v: 1, type: 'ingest', fetchJobId: m.fetchJobId, feedId: m.feedId, feedVersion: m.feedVersion, result: r })).toBe('queued');
			expect((await tick()).done).toBe(1);
			return r;
		}

		it('a backfill window carries no HEADs; a caught-up fetch carries at most 40, then the stale days at most 10 at a time, applied through feed_ingest', async () => {
			const rw = REWRITE_FIXTURE();
			const u = await signUp('RecheckSqs');
			const pid = await project(u);
			const feed = await chirpsFeed(u, pid, { cells: [cell()], startDate: addDays(-(rw.fromDaysAgo + 10)) });
			// A tagged file due for a check (an old one, another cell's): a backfill doesn't take it.
			await asOwner(`INSERT INTO chirps_file (origin, product, day, tag, checked_at) VALUES ('chc', 'sat', '2020-01-01', '"t"', now() - interval '1 year')`);
			await u.call('POST', `/projects/${pid}/feeds/${feed}/run-now`);
			const backfill = (await fetchJob())!;
			expect(backfill.request.end < addDays(-1)).toBe(true);
			expect(backfill.request.recheck).toBeUndefined();
			await answer(backfill);
			const caught = (await fetchJob())!;
			expect(caught.request.end).toBe(addDays(-1));
			expect(caught.request.recheck).toEqual({ cells: [[home().row, home().col]], head: ['2020-01-01'], read: [] });
			await answer(caught);
			expect(await fetchJob()).toBeNull();
			const before = (await asOwner(`SELECT count(*)::int AS n FROM audit_event WHERE project_id = $1 AND subject ? 'chirpsRevision'`, [pid]))[0].n;
			expect(before).toBe(0);

			// CHC rewrites; the next caught-up fetch HEADs the 40 oldest-checked files.
			await asOwner(`UPDATE chirps_file SET checked_at = now() - interval '91 days' WHERE origin = 'chc'`);
			await u.call('POST', `/projects/${pid}/feeds/${feed}/run-now`);
			const heads = (await fetchJob())!;
			expect(heads.request.recheck!.head).toHaveLength(40);
			expect(heads.request.recheck!.read).toEqual([]);
			await answer(heads, undefined, true);
			const marked = (await stale()).length;
			expect(marked).toBeGreaterThan(10);
			// The stale days come back in a minute, ten at a time, read from the rewritten files.
			let reads = 0;
			for (let m = await fetchJob(); m; m = await fetchJob()) {
				expect(m.request.recheck!.read.length).toBeLessThanOrEqual(10);
				expect(m.request.recheck!.head.length).toBeLessThanOrEqual(40);
				reads += m.request.recheck!.read.length;
				await answer(m, undefined, true);
			}
			expect(reads).toBe(marked);
			expect(await stale()).toEqual([]);
			expect((await asOwner('SELECT count(*)::int AS n FROM chirps_revision'))[0].n).toBe(marked);
			const events = await asOwner(`SELECT subject FROM audit_event WHERE project_id = $1 AND kind = 'series.merged' AND subject ? 'chirpsRevision'`, [pid]);
			expect(events.reduce((n: number, e: { subject: { daysChanged: number } }) => n + e.subject.daysChanged, 0)).toBe(marked);
		});

		it('refuses, whole, an answer whose re-read days don’t give a value per cell of the feed; nothing is cached or written', async () => {
			const u = await signUp('RecheckBad');
			const pid = await project(u);
			const feed = await chirpsFeed(u, pid, { cells: [cell()], startDate: addDays(-60) });
			await u.call('POST', `/projects/${pid}/feeds/${feed}/run-now`);
			const m = (await fetchJob())!;
			const good = (await runFetch(parseFetchRequest(JSON.stringify(m))!.request, fixtureHttp())) as { cells: unknown; meta: unknown };
			await asOwner(`INSERT INTO chirps_cell_stale (origin, product, row_idx, col_idx, day) VALUES ('chc', 'sat', $1, $2, '2024-03-01')`, [home().row, home().col]);
			await answer(m, { ...good, recheck: { head: [], read: [{ day: '2024-03-01', tag: '"x"', values: [0, 0] }] } });
			const row = (await asOwner('SELECT consecutive_failures, last_error FROM data_feed WHERE id = $1', [feed]))[0];
			expect(row.consecutive_failures).toBe(1);
			expect(row.last_error).toMatch(/not valid/);
			expect(await asOwner(`SELECT 1 FROM chirps_cell_year WHERE origin = 'chc'`)).toEqual([]);
		});
	});
});
