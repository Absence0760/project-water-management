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
import { afterEach, describe, expect, it } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { withoutUser, withUser } from '../db/tx.js';
import { cellCentre } from './cellCache.js';
import { applyMirrorRevision, type MirrorChange, type MirrorManifest, mirrorRevision } from './mirrorRevision.js';

afterEach(async () => {
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
		expect(await apply(manifest(1, []))).toEqual({ revision: 1, applied: true, marked: 0 });
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
		expect(r).toEqual({ revision: 1, applied: true, marked: 3 });
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
		expect(await apply(manifest(1, [nothing, narrow]))).toEqual({ revision: 1, applied: true, marked: 1 });
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
		expect(await apply(manifest(1, [c1]))).toEqual({ revision: 1, applied: true, marked: 2 });
		// The re-check reads them and clears the rows; re-applying revision 1 must not mark them again.
		await asOwner('DELETE FROM chirps_cell_stale');
		expect(await apply(manifest(1, [c1]))).toEqual({ revision: 1, applied: false, marked: 0 });
		expect(await stale()).toEqual([]);
		// Revision 2 with the manifest's whole list: only revision 2's days.
		expect(await apply(manifest(2, [c1, c2]))).toEqual({ revision: 2, applied: true, marked: 1 });
		expect((await stale()).map((s) => s.day)).toEqual(['2024-03-05']);
		// An older manifest (read before the last apply) changes nothing, and leaves the stored manifest as it was.
		await asOwner('DELETE FROM chirps_cell_stale');
		expect(await apply(manifest(1, [c1]))).toEqual({ revision: 2, applied: false, marked: 0 });
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
			['more than 1000 changes', ['chc', 'sat', 1, new Array(1001).fill(ok), manifest(1, [])]],
			[
				'more than 4000 days in one call',
				['chc', 'sat', 1, Array.from({ length: 12 }, (_, i) => change(1, [`${2010 + i}-01-01`, `${2010 + i}-12-31`])), manifest(1, [])]
			]
		];
		for (const [what, args] of bad) {
			const [o, p, rev, changes, m] = args;
			await expect(applyRaw([o, p, rev, JSON.stringify(changes), JSON.stringify(m)]), what).rejects.toMatchObject({ code: '23514' });
		}
		expect(await stale()).toEqual([]);
		expect(await storedRevision()).toBeNull();
		// Positive control: the same call in bounds lands.
		expect(await apply(manifest(1, [ok]))).toEqual({ revision: 1, applied: true, marked: 1 });
	});
});
