// 252_cache_products: the cell cache and the copy's revision tables take the
// 0.1° products (era5l, imerg_late) and refuse any other, each on its own
// grid and from its own first day, and the functions that write them follow
// (issue #604 R4-B). Every refusal has its positive control.
//
// DB test files run one at a time; this one removes every row it made.
import { afterEach, describe, expect, it } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { cellCentre } from '../feeds/cellCache.js';
import { withoutUser, withUser } from './tx.js';

afterEach(async () => {
	await asOwner('DELETE FROM mirror_change');
	await asOwner('DELETE FROM mirror_copy');
	await asOwner('DELETE FROM mirror_manifest');
	await asOwner('DELETE FROM chirps_cell_year');
	await asOwner('DELETE FROM chirps_file');
	await asOwner('DELETE FROM chirps_cell_stale');
	await asOwner('DELETE FROM chirps_revision');
	await asOwner(`DELETE FROM job WHERE kind IN ('feed_fetch', 'feed_ingest')`);
	await asOwner('DELETE FROM data_feed');
});

const yearRow = (product: string, row: number, col: number, year: number) =>
	asOwner(
		`INSERT INTO chirps_cell_year (origin, product, row_idx, col_idx, year, vals, final, final_through)
		 VALUES ('chc', $1, $2, $3, $4, array_fill(NULL::real, ARRAY[366]), array_fill(false, ARRAY[366]), make_date($4, 12, 31))`,
		[product, row, col, year]
	);
const refused = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ code: '23514' });

describe('252: the tables take era5l and imerg_late, on their grid, from their first day', () => {
	it('chirps_cell_year: the new products (positive control) and no unknown one', async () => {
		await yearRow('era5l', 954, 1900, 2024);
		await yearRow('imerg_late', 954, 1900, 2024);
		await yearRow('sat', 1909, 3800, 2024);
		await refused(yearRow('gpcp', 954, 1900, 2024));
		await refused(yearRow('ERA5L', 954, 1900, 2024));
	});

	it('chirps_cell_year: a 0.1° product’s cell inside its 1200 × 3600 grid; CHIRPS’s inside 2400 × 7200', async () => {
		await yearRow('era5l', 1199, 3599, 2024);
		await yearRow('sat', 2399, 7199, 2024);
		await refused(yearRow('era5l', 1200, 100, 2024));
		await refused(yearRow('imerg_late', 100, 3600, 2024));
		await refused(yearRow('sat', 2400, 100, 2024));
	});

	it('chirps_cell_year and chirps_file: each product from its first year or day', async () => {
		await yearRow('era5l', 1, 1, 1950);
		await yearRow('imerg_late', 1, 1, 2000);
		await refused(yearRow('rnl', 1, 1, 1950));
		await refused(yearRow('era5l', 1, 1, 1949));
		await refused(yearRow('imerg_late', 1, 1, 1999));
		const file = (product: string, day: string) => asOwner(`INSERT INTO chirps_file (origin, product, day) VALUES ('chc', $1, $2)`, [product, day]);
		await file('era5l', '1950-01-01');
		await file('imerg_late', '2000-06-01');
		await refused(file('imerg_late', '2000-05-31'));
		await refused(file('rnl', '1980-12-31'));
		await refused(file('gpcp', '2024-01-01'));
	});

	it('chirps_cell_stale, chirps_revision, mirror_manifest, mirror_change: the new products, not an unknown one', async () => {
		const stale = (product: string, row: number) => asOwner(`INSERT INTO chirps_cell_stale (origin, product, row_idx, col_idx, day) VALUES ('chc', $1, $2, 5, '2024-01-01')`, [product, row]);
		await stale('era5l', 1199);
		await refused(stale('era5l', 1200));
		await refused(stale('gpcp', 10));
		const rev = (product: string) => asOwner(`INSERT INTO chirps_revision (origin, product, day, cells_changed) VALUES ('chc', $1, '2024-01-01', 1)`, [product]);
		await rev('imerg_late');
		await refused(rev('gpcp'));
		const man = (product: string) => asOwner(`INSERT INTO mirror_manifest (origin, product, revision, manifest) VALUES ('chc', $1, 1, '{}')`, [product]);
		await man('era5l');
		await man('imerg_late');
		await refused(man('prelim'));
		const chg = (product: string, r1: number, c1: number) =>
			asOwner(
				`INSERT INTO mirror_change (origin, product, target_revision, idx, revision, day_from, day_to, r0, r1, c0, c1) VALUES ('chc', $1, 1, 1, 1, '2024-01-01', '2024-01-02', 0, $2, 0, $3)`,
				[product, r1, c1]
			);
		await chg('era5l', 1199, 3599);
		await refused(chg('imerg_late', 1200, 10));
		await chg('sat', 2399, 7199);
		await refused(chg('gpcp', 10, 10));
	});

	it('mirror_copy: the new products; era5l with no prelim_through, imerg_late (as prelim) with no final_through', async () => {
		const copy = (product: string, final: string | null, prelim: string | null) =>
			asOwner(`INSERT INTO mirror_copy (origin, product, revision, final_through, prelim_through) VALUES ('chc', $1, 1, $2, $3)`, [product, final, prelim]);
		await copy('era5l', '2024-01-01', null);
		await copy('imerg_late', null, '2024-02-01');
		await copy('sat', '2024-01-01', '2024-02-01');
		await refused(copy('gpcp', null, null));
		await asOwner('DELETE FROM mirror_copy');
		await refused(copy('era5l', '2024-01-01', '2024-02-01'));
		await refused(copy('imerg_late', '2024-01-01', null));
		await refused(copy('prelim', '2024-01-01', null));
		await refused(copy('rnl', '2024-01-01', '2024-02-01'));
	});
});

describe('252: the functions take the new products', () => {
	/** A CHIRPS feed (product sat) with a running feed_fetch job: the caller the cache's writers ask for. */
	async function feedJob() {
		const owner = await signUp('Cache252');
		const pid = (await owner.call('POST', '/projects', { name: 'Cache 252' })).body.project.id as string;
		const f = await owner.call('POST', `/projects/${pid}/feeds`, { source: 'chirps', config: { cells: [{ ...cellCentre({ row: 1600, col: 4100 }), weight: 1 }], startDate: '2024-01-01' } });
		expect(f.status, JSON.stringify(f.body)).toBe(201);
		const feed = f.body.feed.id as string;
		await asOwner(`DELETE FROM job WHERE payload->>'feedId' = $1`, [feed]);
		const job = (
			await asOwner(
				`WITH me AS (SELECT set_config('app.current_user_id', $3::text, false))
				 INSERT INTO job (project_id, kind, acting_user_id, payload) SELECT $1::uuid, 'feed_fetch', $3::uuid, jsonb_build_object('feedId', $2::text) FROM me RETURNING id`,
				[pid, feed, owner.id]
			)
		)[0].id as string;
		await asOwner(`UPDATE job SET status = 'running', locked_until = now() + interval '5 minutes', lease_token = gen_random_uuid(), started_at = now() WHERE id = $1`, [job]);
		const merge = (product: string, read: string, row: number, col: number, vals: (number | null)[], first = '2024-03-01') =>
			withUser(owner.id, (db) => db.query('SELECT chirps_cache_merge($1, $2, $3, $4, $5, $6, $7, $8) AS n', [feed, 'chc', product, first, read, [row], [col], vals]));
		return { owner, feed, job, merge };
	}

	it('chirps_cache_merge: a sat feed’s fetch writes era5l and imerg_late on their grid; never an unknown product, a 0.05° index past the 0.1° grid, or a preliminary day', async () => {
		const { merge } = await feedJob();
		expect((await merge('era5l', 'ff', 954, 1900, [1.5, 0])).rows[0].n).toBe(2);
		expect((await merge('imerg_late', 'f', 954, 1900, [2.5])).rows[0].n).toBe(1);
		// The feed's own product, as before (positive control for the rest).
		expect((await merge('sat', 'f', 1909, 3800, [3])).rows[0].n).toBe(1);
		// No feed is of an unknown product, so no job may write it.
		await expect(merge('gpcp', 'f', 954, 1900, [1])).rejects.toMatchObject({ code: '42501' });
		await refused(merge('era5l', 'f', 1909, 3800, [1]));
		await refused(merge('imerg_late', 'p', 954, 1900, [1]));
		await refused(merge('era5l', 'f', 954, 1900, [1], '1949-12-31'));
		// rnl is still the feed's product only: this feed is sat's.
		await expect(merge('rnl', 'f', 1909, 3800, [1])).rejects.toMatchObject({ code: '42501' });
		expect(await asOwner(`SELECT product, row_idx, year, vals[61] AS v FROM chirps_cell_year ORDER BY product`)).toEqual([
			{ product: 'era5l', row_idx: 954, year: 2024, v: 1.5 },
			{ product: 'imerg_late', row_idx: 954, year: 2024, v: 2.5 },
			{ product: 'sat', row_idx: 1909, year: 2024, v: 3 }
		]);
	});

	it('app_mirror_apply_revision and app_mirror_record_copy: an era5l manifest on the 0.1° grid, not on CHC’s', async () => {
		const m = (step: number, origin: { lat: number; lon: number }) => ({
			product: 'era5l',
			revision: 1,
			region: { w: 10, s: -35.5, e: 41, n: -8 },
			grid: { origin, step },
			years: { first: 1950, last: 2025 },
			finalThrough: '1950-01-31',
			prelimThrough: null,
			files: [],
			changes: []
		});
		const good = m(0.1, { lat: -35.45, lon: 10.05 });
		const apply = (doc: unknown) => withoutUser((db) => db.query('SELECT * FROM app_mirror_apply_revision($1, $2, $3, $4, $5)', ['chc', 'era5l', 1, '[]', JSON.stringify(doc)]));
		await refused(apply(m(0.05, { lat: -35.475, lon: 10.025 })));
		await refused(apply({ ...good, region: { w: 10.05, s: -35.5, e: 41, n: -8 } }));
		expect((await apply(good)).rows).toEqual([{ revision: 1, applied: true, marked: 0, remaining: 0 }]);
		const record = (product: string, doc: unknown) => withoutUser((db) => db.query('SELECT app_mirror_record_copy($1, $2, $3)', ['chc', product, JSON.stringify(doc)]));
		await record('era5l', good);
		await record('imerg_late', { ...good, product: 'imerg_late', finalThrough: null, prelimThrough: '2026-02-08' });
		await refused(record('imerg_late', { ...good, product: 'imerg_late', finalThrough: '2026-02-08' }));
		await refused(record('era5l', { ...good, prelimThrough: '1950-01-31' }));
		await refused(record('era5l', { ...good, finalThrough: '1949-12-31' }));
		await refused(record('gpcp', { ...good, product: 'gpcp' }));
		expect(await asOwner(`SELECT product, to_char(final_through, 'YYYY-MM-DD') AS f FROM mirror_copy ORDER BY product`)).toEqual([
			{ product: 'era5l', f: '1950-01-31' },
			{ product: 'imerg_late', f: null }
		]);
	});
});
