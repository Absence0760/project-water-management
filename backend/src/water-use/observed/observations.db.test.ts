// The worker's functions for observed actual ET (276_et_observation, issue
// #623): app_et_observation_load (its bounds, the upsert and its revision,
// the units it refuses), the load marks, and et_parcels_changed (a unit
// whose parcels change loses its rows; a rename keeps them). Who may read
// and write is observations.security.db.test.ts.
//
// Run under a skewed TZ (CLAUDE.md rule 7): the loader's "today" is the UTC
// day, whatever the session's zone.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { asOwner, node, signUp } from '../../__tests__/helpers.js';
import { type Db, withoutUser } from '../../db/tx.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let projectId: string;
let otherProjectId: string;
const outlet = node('Weir', null);
const farmA = node('Farm A', outlet.id);
const farmB = node('Farm B', outlet.id);
const bare = node('No parcels', outlet.id);
const otherOutlet = node('Other weir', null);
const farmOther = node('Other farm', otherOutlet.id);
let parcelA: string;

const code = async (p: Promise<unknown>) => ((await p.then(() => null, (e: { code?: string }) => e)) as { code?: string } | null)?.code ?? 'ok';
const box = (x: number) => ({ type: 'Polygon', coordinates: [[[x, -33.7], [x + 0.01, -33.7], [x + 0.01, -33.69], [x, -33.69], [x, -33.7]]] });

async function parcel(nodeId: string, x: number, pid = projectId): Promise<string> {
	const res = await owner.call('POST', `/projects/${pid}/map/features`, { kind: 'farm_parcel', name: 'Parcel', nodeId, geometry: box(x) });
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.feature.id as string;
}

type Row = { dekad: string; eta: number; valid?: number; area?: number; file?: string; etag?: string | null };
type Opts = { source?: string; mask?: string; version?: string; at?: Date | string };
const load = (db: Db, nodeId: string, rows: Row[], o: Opts = {}) =>
	db
		.query<{ written: number; revised: number; applied: boolean }>(
			`SELECT written, revised, applied FROM app_et_observation_load($1, $2, $3::date[], $4::float8[], $5::float8[], $6::float8[], $7, $8::text[], $9::text[], $10, $11)`,
			[
				o.source ?? 'wapor',
				nodeId,
				rows.map((r) => r.dekad),
				rows.map((r) => r.eta),
				rows.map((r) => r.valid ?? 1),
				rows.map((r) => r.area ?? 100_000),
				o.mask ?? 'cropland',
				rows.map((r) => r.file ?? `WAPOR-3.L2-AETI-D.${r.dekad}.tif`),
				rows.map((r) => (r.etag === undefined ? '"e1"' : r.etag)),
				o.version ?? 'WAPOR-3',
				o.at ?? new Date()
			]
		)
		.then((r) => r.rows[0]!);
const worker = <T>(f: (db: Db) => Promise<T>) => withoutUser(f);
const held = async (nodeId: string) =>
	(await asOwner(
		`SELECT to_char(dekad, 'YYYY-MM-DD') AS dekad, source, eta_mm_day, valid_share, mask, upstream_etag, revision FROM et_observation WHERE node_id = $1 ORDER BY source, dekad`,
		[nodeId]
	)) as { dekad: string; source: string; eta_mm_day: number; valid_share: number; mask: string; upstream_etag: string | null; revision: number }[];

const zone = process.env.TZ;
beforeAll(async () => {
	// UTC+14: a day ahead of UTC for most of it, so a "today" read in local time would be caught.
	process.env.TZ = 'Pacific/Kiritimati';
	owner = await signUp('Etowner');
	projectId = (await owner.call('POST', '/projects', { name: 'Observed ET' })).body.project.id;
	expect((await owner.call('PUT', `/projects/${projectId}/model`, { nodes: [outlet, farmA, farmB, bare], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
	otherProjectId = (await owner.call('POST', '/projects', { name: 'Observed ET, other' })).body.project.id;
	expect((await owner.call('PUT', `/projects/${otherProjectId}/model`, { nodes: [otherOutlet, farmOther], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
	parcelA = await parcel(farmA.id, 21.3);
	await parcel(farmB.id, 21.32);
}, 60_000);

afterEach(async () => {
	await asOwner('DELETE FROM et_observation');
	await asOwner('DELETE FROM et_observation_load_mark');
});
afterAll(async () => {
	process.env.TZ = zone;
	await asOwner('DELETE FROM project WHERE id = ANY($1::uuid[])', [[projectId, otherProjectId]]);
});

describe('app_et_observation_load', () => {
	it('upserts a unit’s dekads, rewrites only a changed row, and counts its revision', async () => {
		const first = [
			{ dekad: '2024-01-01', eta: 3.1, valid: 0.9 },
			{ dekad: '2024-01-11', eta: 4.2 },
			{ dekad: '2024-01-21', eta: 5.0 }
		];
		expect(await worker((db) => load(db, farmA.id, first))).toEqual({ written: 3, revised: 0, applied: true });
		// The same file again: nothing written.
		expect(await worker((db) => load(db, farmA.id, first))).toEqual({ written: 0, revised: 0, applied: true });
		// FAO rewrote the second dekad (a new ETag and value), and a new dekad came: one revised, one new; the first stays.
		expect(
			await worker((db) =>
				load(db, farmA.id, [
					{ dekad: '2024-01-11', eta: 4.4, etag: '"e2"' },
					{ dekad: '2024-02-01', eta: 5.5 }
				])
			)
		).toEqual({ written: 2, revised: 1, applied: true });
		expect(await held(farmA.id)).toEqual([
			{ dekad: '2024-01-01', source: 'wapor', eta_mm_day: 3.1, valid_share: 0.9, mask: 'cropland', upstream_etag: '"e1"', revision: 1 },
			{ dekad: '2024-01-11', source: 'wapor', eta_mm_day: 4.4, valid_share: 1, mask: 'cropland', upstream_etag: '"e2"', revision: 2 },
			{ dekad: '2024-01-21', source: 'wapor', eta_mm_day: 5.0, valid_share: 1, mask: 'cropland', upstream_etag: '"e1"', revision: 1 },
			{ dekad: '2024-02-01', source: 'wapor', eta_mm_day: 5.5, valid_share: 1, mask: 'cropland', upstream_etag: '"e1"', revision: 1 }
		]);
		// The other source is its own series; an empty file applies and writes nothing.
		expect(await worker((db) => load(db, farmA.id, [{ dekad: '2024-01-11', eta: 3.9, etag: null }], { source: 'ssebop', mask: 'parcel', version: 'v6.1' }))).toEqual({
			written: 1,
			revised: 0,
			applied: true
		});
		expect(await worker((db) => load(db, farmA.id, []))).toEqual({ written: 0, revised: 0, applied: true });
		expect((await held(farmA.id)).map((r) => `${r.source} ${r.dekad}`)).toContain('ssebop 2024-01-11');
	});

	it('stamps the unit’s project on each row', async () => {
		await worker((db) => load(db, farmA.id, [{ dekad: '2024-01-11', eta: 4 }]));
		expect(await asOwner('SELECT project_id FROM et_observation WHERE node_id = $1', [farmA.id])).toEqual([{ project_id: projectId }]);
	});

	it('refuses a node that is gone, isn’t a unit, or has no parcels (applied false, nothing written); a unit with parcels (positive control) loads', async () => {
		for (const n of [crypto.randomUUID(), outlet.id, bare.id]) {
			expect(await worker((db) => load(db, n, [{ dekad: '2024-01-11', eta: 4 }])), n).toEqual({ written: 0, revised: 0, applied: false });
		}
		expect((await asOwner('SELECT count(*)::int AS n FROM et_observation'))[0].n).toBe(0);
		expect((await worker((db) => load(db, farmB.id, [{ dekad: '2024-01-11', eta: 4 }]))).applied).toBe(true);
	});

	it('refuses a file fetched before the unit’s parcels last changed; one fetched after (positive control) loads', async () => {
		const before = new Date(Date.now() - 60_000);
		const redraw = await owner.call('PATCH', `/projects/${projectId}/map/features/${parcelA}`, { geometry: box(21.301) });
		expect(redraw.status).toBe(200);
		expect(await worker((db) => load(db, farmA.id, [{ dekad: '2024-01-11', eta: 4 }], { at: before }))).toEqual({ written: 0, revised: 0, applied: false });
		expect((await worker((db) => load(db, farmA.id, [{ dekad: '2024-01-11', eta: 4 }]))).applied).toBe(true);
	});

	it('holds every bound (23514), and the in-bounds file (positive control) loads', async () => {
		const today = new Date();
		const tomorrowDekad = (() => {
			// The next dekad's first day after today (UTC): always in the future.
			const y = today.getUTCFullYear();
			const m = today.getUTCMonth();
			const d = today.getUTCDate();
			const next = d < 11 ? new Date(Date.UTC(y, m, 11)) : d < 21 ? new Date(Date.UTC(y, m, 21)) : new Date(Date.UTC(y, m + 1, 1));
			return next.toISOString().slice(0, 10);
		})();
		const ok: Row = { dekad: '2024-01-11', eta: 4 };
		const cases: [string, Row[], Opts][] = [
			['an unknown source', [ok], { source: 'modis' }],
			['an unknown mask', [ok], { mask: 'veld' }],
			['an empty version', [ok], { version: '' }],
			['a version with a space', [ok], { version: 'WAPOR 3' }],
			['a day that starts no dekad', [{ ...ok, dekad: '2024-01-12' }], {}],
			['a dekad before 2012', [{ ...ok, dekad: '2011-12-21' }], {}],
			['a dekad not yet begun', [{ ...ok, dekad: tomorrowDekad }], {}],
			['a dekad listed twice', [ok, { ...ok, eta: 5 }], {}],
			['a negative mean', [{ ...ok, eta: -0.1 }], {}],
			['a mean over 50 mm/day', [{ ...ok, eta: 50.1 }], {}],
			['a NaN mean', [{ ...ok, eta: Number.NaN }], {}],
			['a share over 1', [{ ...ok, valid: 1.01 }], {}],
			['a zero area', [{ ...ok, area: 0 }], {}],
			['an infinite area', [{ ...ok, area: Number.POSITIVE_INFINITY }], {}],
			['a file with a space', [{ ...ok, file: 'a b.tif' }], {}],
			['an empty file', [{ ...ok, file: '' }], {}],
			['an ETag with a control character', [{ ...ok, etag: '"e\n1"' }], {}],
			['an ETag over 200 characters', [{ ...ok, etag: 'x'.repeat(201) }], {}],
			['a fetch time in the future', [ok], { at: new Date(Date.now() + 3_600_000) }]
		];
		for (const [what, rows, o] of cases) expect(await code(worker((db) => load(db, farmA.id, rows, o))), what).toBe('23514');
		// Arrays of different lengths, and more than 2000 rows.
		expect(
			await code(
				worker((db) =>
					db.query(
						`SELECT app_et_observation_load('wapor', $1, ARRAY['2024-01-11']::date[], ARRAY[1, 2]::float8[], ARRAY[1]::float8[], ARRAY[1]::float8[], 'parcel', ARRAY['f'], ARRAY[NULL]::text[], 'v', now())`,
						[farmA.id]
					)
				)
			)
		).toBe('23514');
		const many: Row[] = Array.from({ length: 2001 }, (_, i) => ({ dekad: `20${12 + Math.floor(i / 36)}-01-01`, eta: 1 }));
		expect(await code(worker((db) => load(db, farmA.id, many)))).toBe('23514');
		expect((await asOwner('SELECT count(*)::int AS n FROM et_observation'))[0].n).toBe(0);
		expect((await worker((db) => load(db, farmA.id, [ok]))).applied).toBe(true);
	});

	it('keeps a row to its unit’s project (assert_same_project, 23503), even written as the owner', async () => {
		expect(
			await code(
				asOwner(
					`INSERT INTO et_observation (project_id, node_id, source, dekad, eta_mm_day, valid_share, area_m2, mask, upstream_file, upstream_version)
					 VALUES ($1, $2, 'wapor', '2024-01-11', 1, 1, 1, 'parcel', 'f', 'v')`,
					[otherProjectId, farmA.id]
				)
			)
		).toBe('23503');
	});
});

describe('a unit whose parcels change', () => {
	const seed = async () => {
		await asOwner('DELETE FROM et_observation');
		for (const n of [farmA.id, farmB.id]) expect((await worker((db) => load(db, n, [{ dekad: '2024-01-11', eta: 4 }]))).written).toBe(1);
		await worker((db) => db.query(`SELECT app_et_load_mark_write('wapor', $1, now(), now(), false)`, [farmA.id]));
	};
	const marks = async (nodeId: string) =>
		(await asOwner('SELECT source, fetched_at, parcels_changed_at FROM et_observation_load_mark WHERE node_id = $1 ORDER BY source', [nodeId])) as {
			source: string;
			fetched_at: Date | null;
			parcels_changed_at: Date | null;
		}[];

	it('keeps its rows through a rename (positive control), and loses them, with the loaded mark cleared, through a redraw; a neighbour’s stay', async () => {
		await seed();
		expect((await owner.call('PATCH', `/projects/${projectId}/map/features/${parcelA}`, { name: 'Parcel renamed' })).status).toBe(200);
		expect((await held(farmA.id)).length).toBe(1);
		expect((await marks(farmA.id)).find((m) => m.source === 'wapor')!.fetched_at).not.toBeNull();
		expect((await owner.call('PATCH', `/projects/${projectId}/map/features/${parcelA}`, { geometry: box(21.302) })).status).toBe(200);
		expect(await held(farmA.id)).toEqual([]);
		const m = await marks(farmA.id);
		expect(m.map((x) => x.source)).toEqual(['ssebop', 'wapor']);
		for (const x of m) {
			expect(x.fetched_at).toBeNull();
			expect(x.parcels_changed_at).not.toBeNull();
		}
		expect((await held(farmB.id)).length).toBe(1);
	});

	it('loses them when a parcel is added, deleted, or moved to another unit (both units)', async () => {
		await seed();
		const added = await parcel(farmA.id, 21.35);
		expect(await held(farmA.id)).toEqual([]);
		expect((await held(farmB.id)).length).toBe(1);

		await seed();
		expect((await owner.call('PATCH', `/projects/${projectId}/map/features/${added}`, { nodeId: farmB.id })).status).toBe(200);
		expect(await held(farmA.id)).toEqual([]);
		expect(await held(farmB.id)).toEqual([]);

		await seed();
		expect((await owner.call('DELETE', `/projects/${projectId}/map/features/${added}`)).status).toBe(204);
		expect(await held(farmB.id)).toEqual([]);
		expect((await held(farmA.id)).length).toBe(1);
	});

	it('goes with the unit when it is deleted, its parcels kept unlinked, without an error', async () => {
		const extra = node('Short-lived', outlet.id);
		expect((await owner.call('PUT', `/projects/${projectId}/model`, { nodes: [outlet, farmA, farmB, bare, extra], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
		const p = await parcel(extra.id, 21.37);
		expect((await worker((db) => load(db, extra.id, [{ dekad: '2024-01-11', eta: 4 }]))).written).toBe(1);
		expect((await owner.call('PUT', `/projects/${projectId}/model`, { nodes: [outlet, farmA, farmB, bare], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
		expect(await held(extra.id)).toEqual([]);
		expect(await marks(extra.id)).toEqual([]);
		expect(await asOwner('SELECT node_id FROM map_feature WHERE id = $1', [p])).toEqual([{ node_id: null }]);
		await asOwner('DELETE FROM map_feature WHERE id = $1', [p]);
	});
});

describe('the load marks', () => {
	it('records a load and a failure, clears the failure on the next load, and records nothing for a unit that is gone', async () => {
		const write = (nodeId: string, failed: boolean, at: Date | null = new Date()) =>
			worker(async (db) => (await db.query<{ applied: boolean }>(`SELECT applied FROM app_et_load_mark_write('wapor', $1, $2, $2, $3)`, [nodeId, at, failed])).rows[0]!.applied);
		const read = () => worker(async (db) => (await db.query('SELECT node_id, fetched_at, failed_at FROM app_et_load_marks() WHERE node_id = $1', [farmB.id])).rows);
		expect(await write(farmB.id, true)).toBe(true);
		let [m] = await read();
		expect(m.failed_at).not.toBeNull();
		expect(m.fetched_at).toBeNull();
		expect(await write(farmB.id, false)).toBe(true);
		[m] = await read();
		expect(m.failed_at).toBeNull();
		expect(m.fetched_at).not.toBeNull();
		expect(await write(crypto.randomUUID(), false)).toBe(false);
		expect(await code(write(farmB.id, false, null))).toBe('23514');
		expect(await code(worker((db) => db.query(`SELECT app_et_load_mark_write('modis', $1, now(), now(), false)`, [farmB.id])))).toBe('23514');
	});
});
