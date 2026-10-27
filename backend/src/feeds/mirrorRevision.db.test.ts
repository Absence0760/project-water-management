// A revision of our CHIRPS copy reaching the cell cache without a feed
// (245_mirror_revision.sql, issue #604 R1-E): who may call it and read its
// table (with positive controls), which cached cell-days it marks stale (only
// cached finals of the changed days inside the region; never an uncached
// cell, a preliminary value, a day outside the change or a cell outside the
// region), that the re-check (210) then claims them, that an older or equal
// revision changes nothing, and its bounds.
//
// DB test files run one at a time; this one removes every cached cell, stale
// row, revision and manifest it made after each test.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { withoutUser, withUser } from '../db/tx.js';
import { cellCentre } from './cellCache.js';
import { claimRecheck } from './cellCacheStore.js';
import { applyMirrorRevision, type MirrorChange, type MirrorManifest, mirrorCopy, mirrorRevision, recordMirrorCopy } from './mirrorRevision.js';

afterEach(async () => {
	vi.unstubAllEnvs();
	await asOwner('DELETE FROM mirror_change');
	await asOwner('DELETE FROM mirror_copy');
	await asOwner('DELETE FROM chirps_cell_year');
	await asOwner('DELETE FROM chirps_file');
	await asOwner('DELETE FROM chirps_cell_stale');
	await asOwner('DELETE FROM chirps_revision');
	await asOwner('DELETE FROM mirror_manifest');
	await asOwner(`DELETE FROM job WHERE kind IN ('feed_fetch', 'feed_ingest')`);
	await asOwner('DELETE FROM data_feed');
});

// The D1 region: CHC rows 1360–1909, columns 3800–4419.
const REGION = { w: 10, s: -35.5, e: 41, n: -8 };
const IN = { row: 1600, col: 4100 };
const IN2 = { row: 1600, col: 4101 };
const OUT = { row: 1000, col: 4100 }; // 10° N, outside the region

const change = (revision: number, days: [string, string], extra: Partial<MirrorChange> = {}): MirrorChange => ({ revision, days, cellsChanged: 5, maxAbsDiff: 1.5, ...extra });
const manifest = (revision: number, changes: MirrorChange[], extra: Record<string, unknown> = {}): MirrorManifest => ({
	product: 'sat',
	revision,
	region: REGION,
	grid: { origin: { lat: -35.475, lon: 10.025 }, step: 0.05 },
	years: { first: 1998, last: 2024 },
	finalThrough: '2024-12-31',
	prelimThrough: null,
	files: [],
	changes,
	...extra
});
const apply = (m: MirrorManifest) => withoutUser((db) => applyMirrorRevision(db, 'chc', 'sat', m));
const applyRaw = (args: unknown[]) => withoutUser((db) => db.query('SELECT * FROM app_mirror_apply_revision($1, $2, $3, $4, $5)', args));

const doy = (iso: string) => Math.round((Date.parse(iso) - Date.parse(`${iso.slice(0, 4)}-01-01`)) / 86_400_000);
/** A cached 2024 row for `cell`: a value of 3 mm on each day of `days`, final unless `prelim`. */
async function cacheRow(cell: { row: number; col: number }, days: string[], { prelim = false, year = 2024 } = {}) {
	const vals: (number | null)[] = new Array(366).fill(null);
	const final: boolean[] = new Array(366).fill(false);
	for (const d of days) {
		vals[doy(d)] = 3;
		final[doy(d)] = !prelim;
	}
	await asOwner(
		`INSERT INTO chirps_cell_year (origin, product, row_idx, col_idx, year, vals, final, final_through) VALUES ('chc', 'sat', $1, $2, $3, $4::real[], $5::boolean[], $6)`,
		[cell.row, cell.col, year, vals, final, prelim ? `${year - 1}-12-31` : `${year}-12-31`]
	);
	await asOwner(`INSERT INTO chirps_file (origin, product, day) SELECT 'chc', 'sat', d::date FROM unnest($1::text[]) AS d ON CONFLICT DO NOTHING`, [days]);
}
const span = (from: string, n: number) => Array.from({ length: n }, (_, i) => new Date(Date.parse(from) + i * 86_400_000).toISOString().slice(0, 10));
const stale = async () =>
	(await asOwner(`SELECT row_idx, col_idx, to_char(day, 'YYYY-MM-DD') AS day FROM chirps_cell_stale ORDER BY row_idx, col_idx, day`)) as { row_idx: number; col_idx: number; day: string }[];
const storedRevision = async () => ((await asOwner(`SELECT revision FROM mirror_manifest WHERE origin = 'chc' AND product = 'sat'`))[0]?.revision as number | undefined) ?? null;

describe('mirror_manifest and the apply: who may', () => {
	it('a signed-in session reads mirror_manifest, nobody writes it; only a session with no user applies or reads a revision (positive controls)', async () => {
		const u = await signUp('MirrorReader');
		// Positive control: the worker's session (no user) applies a revision and reads it back.
		expect(await apply(manifest(1, []))).toEqual({ revision: 1, applied: true, marked: 0, remaining: 0 });
		expect(await withoutUser((db) => mirrorRevision(db, 'chc', 'sat'))).toBe(1);
		expect(await withoutUser((db) => mirrorRevision(db, 'chc', 'rnl'))).toBeNull();
		// A signed-in session reads the table (reference data, nothing about anyone); none without a user.
		expect((await withUser(u.id, (db) => db.query('SELECT revision FROM mirror_manifest'))).rows).toEqual([{ revision: 1 }]);
		expect((await withoutUser((db) => db.query('SELECT 1 FROM mirror_manifest'))).rows).toHaveLength(0);
		// water_app writes it directly in neither context.
		for (const sql of [
			`INSERT INTO mirror_manifest (origin, product, revision, manifest) VALUES ('chc', 'rnl', 9, '{}')`,
			'UPDATE mirror_manifest SET revision = 9',
			'DELETE FROM mirror_manifest'
		]) {
			await expect(withUser(u.id, (db) => db.query(sql)), sql).rejects.toMatchObject({ code: '42501' });
			await expect(withoutUser((db) => db.query(sql)), sql).rejects.toMatchObject({ code: '42501' });
		}
		// Nor the stale rows: the apply is the way in.
		await expect(
			withoutUser((db) => db.query(`INSERT INTO chirps_cell_stale (origin, product, row_idx, col_idx, day) VALUES ('chc', 'sat', 1600, 4100, '2024-03-01')`))
		).rejects.toMatchObject({ code: '42501' });
		// A signed-in session can't call the functions, even a project owner's.
		await expect(withUser(u.id, (db) => applyMirrorRevision(db, 'chc', 'sat', manifest(2, [])))).rejects.toMatchObject({ code: '42501' });
		await expect(withUser(u.id, (db) => mirrorRevision(db, 'chc', 'sat'))).rejects.toMatchObject({ code: '42501' });
		expect(await storedRevision()).toBe(1);
	});
});

describe('app_mirror_apply_revision: what it marks', () => {
	it('marks only cached finals of the changed days inside the region, and logs no revision until a re-read changes a value', async () => {
		const days = span('2024-02-27', 10); // 27 Feb – 7 Mar (2024 is a leap year)
		await cacheRow(IN, days);
		await cacheRow(IN2, days, { prelim: true }); // preliminary: the final will replace it anyway
		await cacheRow(OUT, days); // cached final, but outside the region
		await cacheRow(IN, ['2023-03-01'], { year: 2023 }); // the same cell, another year
		const r = await apply(manifest(1, [change(1, ['2024-03-01', '2024-03-03'])]));
		// Positive control: the cached in-region cell is marked on exactly the changed days.
		expect(r).toEqual({ revision: 1, applied: true, marked: 3, remaining: 0 });
		expect(await stale()).toEqual(['2024-03-01', '2024-03-02', '2024-03-03'].map((day) => ({ row_idx: IN.row, col_idx: IN.col, day })));
		// Nothing before or after the days, nothing preliminary, nothing outside the region, no uncached cell, no other year.
		expect(await asOwner('SELECT count(*)::int AS n FROM chirps_revision')).toEqual([{ n: 0 }]);
		const stored = await asOwner(`SELECT revision, manifest -> 'changes' AS changes FROM mirror_manifest WHERE origin = 'chc' AND product = 'sat'`);
		expect(stored).toEqual([{ revision: 1, changes: [change(1, ['2024-03-01', '2024-03-03'])] }]);
	});

	it('a change’s own region narrows the cells; a change of no cells marks nothing; the fixtures’ cache is apart', async () => {
		await cacheRow(IN, ['2024-03-01']);
		await cacheRow({ row: 1700, col: 4100 }, ['2024-03-01']);
		await asOwner(
			`INSERT INTO chirps_cell_year (origin, product, row_idx, col_idx, year, vals, final, final_through)
			 SELECT 'fixtures', product, row_idx, col_idx, year, vals, final, final_through FROM chirps_cell_year WHERE row_idx = 1600`
		);
		// Rows 1600–1619 only (lat −20 to −21).
		const narrow = change(1, ['2024-03-01', '2024-03-01'], { region: { w: 10, s: -21, e: 41, n: -20 } });
		const nothing = change(1, ['2024-03-01', '2024-03-01'], { cellsChanged: 0, maxAbsDiff: 0 });
		expect(await apply(manifest(1, [nothing, narrow]))).toEqual({ revision: 1, applied: true, marked: 1, remaining: 0 });
		expect(await stale()).toEqual([{ row_idx: 1600, col_idx: 4100, day: '2024-03-01' }]);
		expect(await asOwner(`SELECT origin FROM chirps_cell_stale`)).toEqual([{ origin: 'chc' }]);
	});

	it('hands the marked days to the feeds’ re-check: a fetch over the cell claims them to read again (210)', async () => {
		await cacheRow(IN, span('2024-03-01', 3));
		await apply(manifest(1, [change(1, ['2024-03-01', '2024-03-02'])]));
		const owner = await signUp('MirrorFeed');
		const pid = (await owner.call('POST', '/projects', { name: 'Mirror' })).body.project.id as string;
		const f = await owner.call('POST', `/projects/${pid}/feeds`, { source: 'chirps', config: { cells: [{ ...cellCentre(IN), weight: 1 }], startDate: '2024-01-01' } });
		expect(f.status, JSON.stringify(f.body)).toBe(201);
		const feed = f.body.feed.id as string;
		await asOwner(`DELETE FROM job WHERE payload->>'feedId' = $1 AND status = 'queued'`, [feed]);
		const job = (
			await asOwner(
				`WITH me AS (SELECT set_config('app.current_user_id', $3::text, false))
				 INSERT INTO job (project_id, kind, acting_user_id, payload) SELECT $1::uuid, 'feed_fetch', $3::uuid, jsonb_build_object('feedId', $2::text) FROM me RETURNING id`,
				[pid, feed, owner.id]
			)
		)[0].id as string;
		await asOwner(`UPDATE job SET status = 'running', locked_until = now() + interval '5 minutes', lease_token = gen_random_uuid(), started_at = now() WHERE id = $1`, [job]);
		const { rows } = await withUser(owner.id, (db) =>
			db.query(`SELECT kind, to_char(day, 'YYYY-MM-DD') AS day FROM chirps_recheck_claim($1, 'chc', 'sat', $2, $3, 0, 10, 90) WHERE kind = 'reread' ORDER BY day`, [feed, [IN.row], [IN.col]])
		);
		expect(rows).toEqual([
			{ kind: 'reread', day: '2024-03-01' },
			{ kind: 'reread', day: '2024-03-02' }
		]);
	});
});

describe('app_mirror_apply_revision: revisions', () => {
	it('an equal or older revision changes nothing and returns the stored one; a newer one applies only its newer changes', async () => {
		await cacheRow(IN, span('2024-03-01', 10));
		const c1 = change(1, ['2024-03-01', '2024-03-02']);
		const c2 = change(2, ['2024-03-05', '2024-03-05']);
		expect(await apply(manifest(1, [c1]))).toEqual({ revision: 1, applied: true, marked: 2, remaining: 0 });
		// The re-check reads them and clears the rows; re-applying revision 1 must not mark them again.
		await asOwner('DELETE FROM chirps_cell_stale');
		expect(await apply(manifest(1, [c1]))).toEqual({ revision: 1, applied: false, marked: 0, remaining: 0 });
		expect(await stale()).toEqual([]);
		// Revision 2 with the manifest's whole list: only revision 2's days.
		expect(await apply(manifest(2, [c1, c2]))).toEqual({ revision: 2, applied: true, marked: 1, remaining: 0 });
		expect((await stale()).map((s) => s.day)).toEqual(['2024-03-05']);
		// An older manifest (read before the last apply) changes nothing, and leaves the stored manifest as it was.
		await asOwner('DELETE FROM chirps_cell_stale');
		expect(await apply(manifest(1, [c1]))).toEqual({ revision: 2, applied: false, marked: 0, remaining: 0 });
		expect(await stale()).toEqual([]);
		expect(await asOwner(`SELECT revision, (manifest ->> 'revision')::int AS m FROM mirror_manifest`)).toEqual([{ revision: 2, m: 2 }]);
	});
});

describe('app_mirror_apply_revision: bounds', () => {
	it('refuses a call out of bounds whole (23514), marking and recording nothing', async () => {
		await cacheRow(IN, span('2024-03-01', 3));
		const ok = change(1, ['2024-03-01', '2024-03-01']);
		const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
		const bad: [string, unknown[]][] = [
			['an unknown product', ['chc', 'prelim', 1, [], { ...manifest(1, []), product: 'prelim' }]],
			['an unknown origin', ['dynamical', 'sat', 1, [], manifest(1, [])]],
			['revision 0', ['chc', 'sat', 0, [], manifest(0, [])]],
			['a manifest of another product', ['chc', 'sat', 1, [], { ...manifest(1, []), product: 'rnl' }]],
			['a manifest of another revision', ['chc', 'sat', 1, [], manifest(2, [])]],
			['a region off the 0.05° lattice', ['chc', 'sat', 1, [ok], manifest(1, [ok], { region: { ...REGION, w: 10.02 } })]],
			['a region turned inside out', ['chc', 'sat', 1, [ok], manifest(1, [ok], { region: { ...REGION, w: 41, e: 10 } })]],
			['a region off the grid', ['chc', 'sat', 1, [ok], manifest(1, [ok], { region: { ...REGION, s: -61 } })]],
			['another grid step', ['chc', 'sat', 1, [ok], manifest(1, [ok], { grid: { origin: { lat: 0, lon: 0 }, step: 0.1 } })]],
			['changes that are not a list', ['chc', 'sat', 1, { revision: 1 }, manifest(1, [])]],
			['a change of a later revision than the manifest', ['chc', 'sat', 1, [change(2, ['2024-03-01', '2024-03-01'])], manifest(1, [])]],
			['days backwards', ['chc', 'sat', 1, [change(1, ['2024-03-02', '2024-03-01'])], manifest(1, [])]],
			['more than 366 days', ['chc', 'sat', 1, [change(1, ['2023-01-01', '2024-01-02'])], manifest(1, [])]],
			['a day before the product begins', ['chc', 'sat', 1, [change(1, ['1997-12-31', '1998-01-02'])], manifest(1, [])]],
			['a day after today', ['chc', 'sat', 1, [change(1, ['2024-03-01', tomorrow])], manifest(1, [])]],
			['a day that is not a date', ['chc', 'sat', 1, [change(1, ['2023-02-29', '2023-03-01'])], manifest(1, [])]],
			['a day not written ISO', ['chc', 'sat', 1, [change(1, ['2024-3-1', '2024-03-01'])], manifest(1, [])]],
			['a negative cellsChanged', ['chc', 'sat', 1, [change(1, ['2024-03-01', '2024-03-01'], { cellsChanged: -1 })], manifest(1, [])]],
			['no maxAbsDiff', ['chc', 'sat', 1, [{ revision: 1, days: ['2024-03-01', '2024-03-01'], cellsChanged: 1 }], manifest(1, [])]],
			['a change’s region outside the manifest’s', ['chc', 'sat', 1, [change(1, ['2024-03-01', '2024-03-01'], { region: { w: 5, s: -30, e: 20, n: -20 } })], manifest(1, [])]],
			['more than 1000 changes', ['chc', 'sat', 1, new Array(1001).fill(ok), manifest(1, [])]]
		];
		for (const [what, args] of bad) {
			const [o, p, rev, changes, m] = args;
			await expect(applyRaw([o, p, rev, JSON.stringify(changes), JSON.stringify(m)]), what).rejects.toMatchObject({ code: '23514' });
		}
		expect(await stale()).toEqual([]);
		expect(await storedRevision()).toBeNull();
		// Positive control: the same call in bounds lands.
		expect(await apply(manifest(1, [ok]))).toEqual({ revision: 1, applied: true, marked: 1, remaining: 0 });
	});
});

/** A project with a CHIRPS feed over IN, and a running feed_fetch job of it queued now (what the cache functions ask of their caller). */
async function feedJob(name: string) {
	const owner = await signUp(name);
	const pid = (await owner.call('POST', '/projects', { name })).body.project.id as string;
	const f = await owner.call('POST', `/projects/${pid}/feeds`, { source: 'chirps', config: { cells: [{ ...cellCentre(IN), weight: 1 }], startDate: '2024-01-01' } });
	expect(f.status, JSON.stringify(f.body)).toBe(201);
	const feed = f.body.feed.id as string;
	/** A new running fetch of the feed, queued now; the one before it is finished (the functions act for the running one). */
	const job = async () => {
		await asOwner(`DELETE FROM job WHERE payload->>'feedId' = $1 AND status = 'queued'`, [feed]);
		await asOwner(
			`UPDATE job SET status = 'done', finished_at = now(), locked_until = NULL, lease_token = NULL WHERE payload->>'feedId' = $1 AND status = 'running'`,
			[feed]
		);
		const id = (
			await asOwner(
				`WITH me AS (SELECT set_config('app.current_user_id', $3::text, false))
				 INSERT INTO job (project_id, kind, acting_user_id, payload) SELECT $1::uuid, 'feed_fetch', $3::uuid, jsonb_build_object('feedId', $2::text) FROM me RETURNING id`,
				[pid, feed, owner.id]
			)
		)[0].id as string;
		await asOwner(`UPDATE job SET status = 'running', locked_until = now() + interval '5 minutes', lease_token = gen_random_uuid(), started_at = now() WHERE id = $1`, [id]);
		return id;
	};
	return { owner, feed, job };
}
type Owner = Awaited<ReturnType<typeof signUp>>;
/** A re-check answer from fetch `job`: day `day` read again for `cells`, each at `v` mm. */
const reread = (u: Owner, feed: string, job: string, day: string, cells: { row: number; col: number }[], v: number) =>
	withUser(u.id, (db) =>
		db.query('SELECT chirps_recheck_apply($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)', [
			feed,
			job,
			'chc',
			'sat',
			[],
			[],
			[day],
			[null],
			cells.map((c) => c.row),
			cells.map((c) => c.col),
			cells.map(() => v)
		])
	);
const markedAt = async (cell: { row: number; col: number }, day: string) =>
	(await asOwner(`SELECT marked_at FROM chirps_cell_stale WHERE row_idx = $1 AND col_idx = $2 AND day = $3`, [cell.row, cell.col, day]))[0]?.marked_at as Date | undefined;

describe('app_mirror_apply_revision: a revision of more than 4000 days, in parts (246)', () => {
	// Twelve whole years: 2010–2019 are 3652 days, and 2020 (366) would pass 4000, so the first part is ten entries.
	const years = Array.from({ length: 12 }, (_, i) => 2010 + i);
	const big = () => manifest(1, years.map((y) => change(1, [`${y}-01-01`, `${y}-12-31`])));
	const cacheYears = async () => {
		for (const y of years) await cacheRow(IN, [`${y}-06-01`], { year: y });
	};
	const staleYears = async () => (await stale()).map((r) => Number(r.day.slice(0, 4)));

	it('marks the first part, records nothing, says how much is left; the next call marks the rest and records the revision', async () => {
		await cacheYears();
		expect(await apply(big())).toEqual({ revision: null, applied: false, marked: 10, remaining: 2 });
		expect(await staleYears()).toEqual(years.slice(0, 10));
		expect(await storedRevision()).toBeNull();
		expect(await withoutUser((db) => mirrorRevision(db, 'chc', 'sat'))).toBeNull();
		expect(await apply(big())).toEqual({ revision: 1, applied: true, marked: 2, remaining: 0 });
		expect(await staleYears()).toEqual(years);
		// Recorded: the same revision again changes nothing.
		await asOwner('DELETE FROM chirps_cell_stale');
		expect(await apply(big())).toEqual({ revision: 1, applied: false, marked: 0, remaining: 0 });
		expect(await stale()).toEqual([]);
	});

	it('resumes after a crash: a part that committed isn’t marked again, one that rolled back is done again; a different list starts over', async () => {
		await cacheYears();
		await apply(big());
		// The re-check read the first part's days in the meantime and cleared them.
		await asOwner('DELETE FROM chirps_cell_stale');
		// The worker dies inside the second part: it rolls back whole, nothing logged.
		await expect(
			withoutUser(async (db) => {
				await applyMirrorRevision(db, 'chc', 'sat', big());
				throw new Error('the worker stopped');
			})
		).rejects.toThrow('the worker stopped');
		expect(await stale()).toEqual([]);
		expect((await asOwner(`SELECT count(*)::int AS n FROM mirror_change`))[0].n).toBe(10);
		// The next tick carries on after the ten entries the first part logged.
		expect(await apply(big())).toEqual({ revision: 1, applied: true, marked: 2, remaining: 0 });
		expect(await staleYears()).toEqual([2020, 2021]);

		// Positive control for the skip: a revision whose entries don't match what was logged for it starts over.
		await asOwner('DELETE FROM chirps_cell_stale');
		const m2 = manifest(2, years.map((y) => change(2, [`${y}-01-01`, `${y}-12-31`])));
		expect(await apply(m2)).toMatchObject({ applied: false, marked: 10, remaining: 2 });
		await asOwner(`UPDATE mirror_change SET day_to = day_to - 1 WHERE target_revision = 2 AND idx = 3`);
		await asOwner('DELETE FROM chirps_cell_stale');
		expect(await apply(m2)).toMatchObject({ applied: false, marked: 10, remaining: 2 });
		expect(await staleYears()).toEqual(years.slice(0, 10));
	});
});

describe('the stale-mark race (246): a fetch that read before a revision doesn’t undo it', () => {
	it('a re-read clears a mark made before its fetch was queued (positive control), keeps one made after, and a revision refreshes a mark already there', async () => {
		const { owner, feed, job } = await feedJob('RaceReread');
		await cacheRow(IN, ['2024-03-01', '2024-03-02', '2024-03-03']);
		// Before the fetch: revision 1 marks 1 March, and the fetch, queued after it, reads it again and clears it.
		await apply(manifest(1, [change(1, ['2024-03-01', '2024-03-01'])]));
		const first = await job();
		await reread(owner, feed, first, '2024-03-01', [IN], 3);
		expect(await stale()).toEqual([]);

		// A fetch is queued; revision 2 lands while it is out; its answer (read from the copy before) comes back after.
		const second = await job();
		await asOwner(`UPDATE job SET created_at = now() - interval '1 minute' WHERE id = $1`, [second]);
		await apply(manifest(2, [change(2, ['2024-03-02', '2024-03-02'])]));
		await reread(owner, feed, second, '2024-03-02', [IN], 3);
		expect(await stale()).toEqual([{ row_idx: IN.row, col_idx: IN.col, day: '2024-03-02' }]);
		// The next fetch, queued after, reads it again and clears it.
		await reread(owner, feed, await job(), '2024-03-02', [IN], 4);
		expect(await stale()).toEqual([]);

		// A mark already there from long ago takes the revision's time, so the fetch out meanwhile keeps it too.
		await asOwner(`INSERT INTO chirps_cell_stale (origin, product, row_idx, col_idx, day, marked_at) VALUES ('chc', 'sat', $1, $2, '2024-03-03', now() - interval '1 day')`, [IN.row, IN.col]);
		const third = await job();
		await asOwner(`UPDATE job SET created_at = now() - interval '1 minute' WHERE id = $1`, [third]);
		await apply(manifest(3, [change(3, ['2024-03-03', '2024-03-03'])]));
		expect((await markedAt(IN, '2024-03-03'))!.getTime()).toBeGreaterThan(Date.now() - 60_000);
		await reread(owner, feed, third, '2024-03-03', [IN], 3);
		expect(await stale()).toEqual([{ row_idx: IN.row, col_idx: IN.col, day: '2024-03-03' }]);
	});

	it('a merge of finals read before a change applied since marks them (the revision couldn’t: nobody had cached them); one queued after doesn’t', async () => {
		const { owner, feed, job } = await feedJob('RaceMerge');
		await cacheRow(IN, ['2024-03-01']);
		// The merge acts for the feed's running job: the one job() just started.
		const merge = (cell: { row: number; col: number }) =>
			withUser(owner.id, (db) => db.query('SELECT chirps_cache_merge($1, $2, $3, $4, $5, $6, $7, $8)', [feed, 'chc', 'sat', '2024-03-01', 'fff', [cell.row], [cell.col], [3, 3, 3]]));
		const early = await job();
		await asOwner(`UPDATE job SET created_at = now() - interval '1 minute' WHERE id = $1`, [early]);
		// Revision 1 changes 1–2 March. IN2 isn't cached, so nothing of it is marked.
		expect(await apply(manifest(1, [change(1, ['2024-03-01', '2024-03-02'])]))).toMatchObject({ marked: 1 });
		await asOwner('DELETE FROM chirps_cell_stale');
		// The fetch queued before lands IN2's values for 1–3 March: the changed days are marked, the 3rd isn't.
		expect(early).toBeTruthy();
		await merge(IN2);
		expect(await stale()).toEqual([
			{ row_idx: IN2.row, col_idx: IN2.col, day: '2024-03-01' },
			{ row_idx: IN2.row, col_idx: IN2.col, day: '2024-03-02' }
		]);
		// Positive control: a fetch queued after the revision read the copy as revised: nothing marked.
		await asOwner('DELETE FROM chirps_cell_stale');
		await job();
		const later = { row: IN2.row, col: IN2.col + 1 };
		await merge(later);
		expect(await stale()).toEqual([]);
	});
});

describe('CHIRPS_SOURCE=mirror: no file of CHC’s is HEADed (the copy’s revisions replace it)', () => {
	it('claims no HEAD for the chc origin with mirror; with chc it does (positive control), and the stale days are read either way', async () => {
		const { owner, feed, job } = await feedJob('RecheckGuard');
		await job();
		await cacheRow(IN, ['2024-03-01', '2024-03-02']);
		await asOwner(`UPDATE chirps_file SET tag = '"t"', checked_at = now() - interval '1 year' WHERE day = '2024-03-01'`);
		await asOwner(`INSERT INTO chirps_cell_stale (origin, product, row_idx, col_idx, day) VALUES ('chc', 'sat', $1, $2, '2024-03-02')`, [IN.row, IN.col]);
		const claim = () => withUser(owner.id, (db) => claimRecheck(db, feed, 'chc', 'sat', [IN], { heads: 40, reads: 10, intervalDays: 90 }));
		vi.stubEnv('CHIRPS_SOURCE', 'mirror');
		expect(await claim()).toEqual({ read: ['2024-03-02'], head: [] });
		vi.stubEnv('CHIRPS_SOURCE', 'chc');
		expect(await claim()).toEqual({ read: ['2024-03-02'], head: ['2024-03-01'] });
	});
});

describe('mirror_copy: how far the copy runs, for the API (246)', () => {
	const copyManifest = (product: string, extra: Record<string, unknown> = {}) => ({ product, revision: 3, finalThrough: null, prelimThrough: null, ...extra });
	it('the worker records each product’s manifest; any signed-in session reads it; nobody else writes it; bounds', async () => {
		const u = await signUp('CopyReader');
		await withoutUser((db) => recordMirrorCopy(db, 'chc', 'sat', copyManifest('sat', { finalThrough: '2024-12-31', prelimThrough: '2025-01-20' })));
		await withoutUser((db) => recordMirrorCopy(db, 'chc', 'rnl', copyManifest('rnl', { finalThrough: '2024-11-30' })));
		await withoutUser((db) => recordMirrorCopy(db, 'chc', 'prelim', copyManifest('prelim', { prelimThrough: '2025-01-20' })));
		// A new month: the same revision, finalThrough moves.
		await withoutUser((db) => recordMirrorCopy(db, 'chc', 'rnl', copyManifest('rnl', { finalThrough: '2024-12-31' })));
		const copy = await withUser(u.id, (db) => mirrorCopy(db, 'chc'));
		expect(copy).toMatchObject({
			sat: { revision: 3, finalThrough: '2024-12-31', prelimThrough: '2025-01-20' },
			rnl: { revision: 3, finalThrough: '2024-12-31', prelimThrough: null },
			prelim: { revision: 3, finalThrough: null, prelimThrough: '2025-01-20' }
		});
		expect(copy.sat!.seenAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
		expect(await withUser(u.id, (db) => mirrorCopy(db, 'fixtures'))).toEqual({});
		expect((await withoutUser((db) => db.query('SELECT 1 FROM mirror_copy'))).rows).toEqual([]);
		await expect(withUser(u.id, (db) => recordMirrorCopy(db, 'chc', 'sat', copyManifest('sat')))).rejects.toMatchObject({ code: '42501' });
		await expect(withUser(u.id, (db) => db.query('DELETE FROM mirror_copy'))).rejects.toMatchObject({ code: '42501' });
		const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
		for (const [product, m] of [
			['sat', copyManifest('rnl')],
			['gefs', copyManifest('gefs')],
			['sat', copyManifest('sat', { revision: 0 })],
			['sat', copyManifest('sat', { finalThrough: '2023-02-29' })],
			['sat', copyManifest('sat', { finalThrough: tomorrow })],
			['prelim', copyManifest('prelim', { finalThrough: '2024-01-01' })],
			['rnl', copyManifest('rnl', { prelimThrough: '2024-01-01' })]
		] as const) {
			await expect(withoutUser((db) => recordMirrorCopy(db, 'chc', product as 'sat', m)), JSON.stringify(m)).rejects.toMatchObject({ code: '23514' });
		}
		expect((await withUser(u.id, (db) => mirrorCopy(db, 'chc'))).sat!.finalThrough).toBe('2024-12-31');
	});
});
