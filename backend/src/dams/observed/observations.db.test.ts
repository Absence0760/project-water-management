// What satellites saw of each traced dam (249_dam_observation, issue #604
// R5): the worker's functions (the outlines, the candidates, the loader's
// bounds and targets, the match write), and a redrawn dam losing its match
// and observations. Who may read and write the tables (RLS, grants, the
// functions refusing a signed-in user) is observations.security.db.test.ts.
//
// DB test files run one at a time; this one removes its reference rows after each test.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { asOwner, node, signUp } from '../../__tests__/helpers.js';
import { type Db, withoutUser } from '../../db/tx.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let stranger: User;
let projectId: string;
let otherProjectId: string;
const outlet = node('Weir', null);
const farmA = node('Farm A', outlet.id);
const farmB = node('Farm B', outlet.id);

const box = (x: number, y: number, d: number) => [
	[x, y],
	[x + d, y],
	[x + d, y + d],
	[x, y + d],
	[x, y]
];
const code = async (p: Promise<unknown>) => ((await p.then(() => null, (e: { code?: string }) => e)) as { code?: string } | null)?.code ?? 'ok';

/** A dam polygon in a project, as an editor (the owner) through the API. */
async function dam(u: User, pid: string, name: string, x: number, nodeId: string | null = null): Promise<string> {
	const res = await u.call('POST', `/projects/${pid}/map/features`, { kind: 'dam', name, nodeId, geometry: { type: 'Polygon', coordinates: [box(x, -33.68, 0.002)] } });
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.feature.id as string;
}

const updatedAt = async (featureId: string) => ((await asOwner('SELECT updated_at FROM map_feature WHERE id = $1', [featureId]))[0] as { updated_at: Date }).updated_at;
const match = (db: Db, featureId: string, status: string, uid: string | null, at: Date, shares: [number, number] | null = uid ? [0.95, 0.9] : null) =>
	db
		.query<{ applied: boolean; dropped: number }>('SELECT applied, dropped FROM app_dam_match_write($1, $2, $3, $4, $5, $6, NULL)', [featureId, status, uid, shares?.[0] ?? null, shares?.[1] ?? null, at])
		.then((r) => r.rows[0]!);
const load = (db: Db, source: string, key: string, rows: [string, number, number, string][], at: Date | string = new Date()) =>
	db
		.query<{ written: number; dams: number; applied: boolean }>(
			'SELECT written, dams, applied FROM app_dam_observation_load($1, $2, $3::date[], $4::float8[], $5::float8[], $6::text[], $7)',
			[source, key, rows.map((r) => r[0]), rows.map((r) => r[1]), rows.map((r) => r[2]), rows.map((r) => r[3]), at]
		)
		.then((r) => r.rows[0]!);

let damA: string;
let damB: string;
let damOther: string;

beforeAll(async () => {
	[owner, stranger] = (await Promise.all(['Oowner', 'Ostranger'].map((n) => signUp(n)))) as [User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Observed dams' })).body.project.id;
	expect((await owner.call('PUT', `/projects/${projectId}/model`, { nodes: [outlet, farmA, farmB], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
	otherProjectId = (await stranger.call('POST', '/projects', { name: 'Elsewhere dams' })).body.project.id;
	damA = await dam(owner, projectId, 'Dam A', 21.31, farmA.id);
	damB = await dam(owner, projectId, 'Dam B', 21.35, farmB.id);
	damOther = await dam(stranger, otherProjectId, 'Other dam', 21.4);
}, 60_000);

afterEach(async () => {
	await asOwner('DELETE FROM dam_observation');
	await asOwner('DELETE FROM dam_waterbody_match');
	await asOwner('DELETE FROM waterbody_reference');
});
afterAll(async () => {
	await asOwner('DELETE FROM project WHERE id = ANY($1::uuid[])', [[projectId, otherProjectId]]);
});

/** Both project dams matched to their own waterbody, and a row of each source loaded for each. */
async function seed() {
	await withoutUser(async (db) => {
		expect((await match(db, damA, 'matched', 'zzzzza0001', await updatedAt(damA))).applied).toBe(true);
		expect((await match(db, damB, 'matched', 'zzzzzb0001', await updatedAt(damB))).applied).toBe(true);
		expect((await match(db, damOther, 'none', null, await updatedAt(damOther))).applied).toBe(true);
		expect(await load(db, 'waterbodies', 'zzzzza0001', [['2020-01-05', 1000, 90, 'zzzzza0001']])).toEqual({ written: 1, dams: 1, applied: true });
		expect(await load(db, 'waterbodies', 'zzzzzb0001', [['2020-01-05', 2000, 100, 'zzzzzb0001']])).toEqual({ written: 1, dams: 1, applied: true });
		for (const f of [damA, damB, damOther]) expect((await load(db, 'wofs', f, [['2020-01-06', 500, 80, 'ga_ls_wofs_synthetic_1']])).written).toBe(1);
	});
}

describe('the worker’s functions', () => {
	it('lists each dam’s match and newest observation per source; a reload of the reference set makes every match stale', async () => {
		await seed();
		const outlines = async () =>
			new Map(
				(
					await withoutUser(
						async (db) =>
							(
								await db.query<{ feature_id: string; status: string; uid: string; match_stale: boolean; waterbodies_newest: string; wofs_newest: string }>(
									`SELECT feature_id, status, uid, match_stale, to_char(waterbodies_newest, 'YYYY-MM-DD') AS waterbodies_newest, to_char(wofs_newest, 'YYYY-MM-DD') AS wofs_newest FROM app_dam_outlines()`
								)
							).rows
					)
				).map((r) => [r.feature_id, r])
			);
		expect((await outlines()).get(damA)).toMatchObject({ status: 'matched', uid: 'zzzzza0001', match_stale: false, waterbodies_newest: '2020-01-05', wofs_newest: '2020-01-06' });
		await asOwner(`INSERT INTO waterbody_reference (uid, dataset, geometry, min_lon, min_lat, max_lon, max_lat, area_m2, source, loaded_at)
			VALUES ('zzzzzc0001', 'test', '{"type":"Polygon","coordinates":[]}', 21.3, -33.7, 21.32, -33.67, 1000, 'test', now() + interval '1 second')`);
		expect((await outlines()).get(damA)!.match_stale).toBe(true);
	});

	it('returns the waterbodies whose box meets the box asked, and refuses a box over 1°', async () => {
		await asOwner(`INSERT INTO waterbody_reference (uid, dataset, geometry, min_lon, min_lat, max_lon, max_lat, area_m2, source) VALUES
			('zzzzzc0001', 'test', '{"type":"Polygon","coordinates":[]}', 21.30, -33.70, 21.32, -33.67, 1000, 'test'),
			('zzzzzc0002', 'test', '{"type":"Polygon","coordinates":[]}', 22.00, -33.70, 22.01, -33.69, 1000, 'test')`);
		const got = await withoutUser(async (db) => (await db.query<{ uid: string }>('SELECT uid FROM app_waterbody_candidates(21.31, -33.68, 21.312, -33.678)')).rows);
		expect(got.map((r) => r.uid)).toEqual(['zzzzzc0001']);
		expect(await code(withoutUser((db) => db.query('SELECT * FROM app_waterbody_candidates(21, -34, 22.5, -33)')))).toBe('23514');
	});

	it('loads a waterbody’s series into every dam matched to it, never a merged or unmatched one, and rewrites only changed rows', async () => {
		await withoutUser(async (db) => {
			await match(db, damA, 'matched', 'zzzzza0001', await updatedAt(damA));
			await match(db, damB, 'merged', 'zzzzza0001', await updatedAt(damB), [0.9, 0.2]);
			await match(db, damOther, 'matched', 'zzzzza0001', await updatedAt(damOther));
			const rows: [string, number, number, string][] = [
				['2020-01-05', 1000, 90, 'zzzzza0001'],
				['2020-01-21', 1200, 100, 'zzzzza0001']
			];
			expect(await load(db, 'waterbodies', 'zzzzza0001', rows)).toEqual({ written: 4, dams: 2, applied: true });
			expect(await load(db, 'waterbodies', 'zzzzza0001', rows)).toEqual({ written: 0, dams: 2, applied: true });
			expect(await load(db, 'waterbodies', 'zzzzza0001', [['2020-01-21', 1300, 100, 'zzzzza0001']])).toEqual({ written: 2, dams: 2, applied: true });
			expect(await load(db, 'waterbodies', 'zzzzzq0001', rows)).toEqual({ written: 0, dams: 0, applied: false });
		});
		const held = (await asOwner(`SELECT feature_id, project_id, wet_area_m2 FROM dam_observation WHERE obs_date = '2020-01-21' ORDER BY feature_id`)) as {
			feature_id: string;
			project_id: string;
			wet_area_m2: number;
		}[];
		expect(held.map((r) => r.feature_id).sort()).toEqual([damA, damOther].sort());
		expect(held.every((r) => r.wet_area_m2 === 1300)).toBe(true);
		// Each row in its own dam's project.
		expect(held.find((r) => r.feature_id === damOther)!.project_id).toBe(otherProjectId);
	});

	it('loads WOfS rows into the dam named, unless it changed after the fetch', async () => {
		const before = new Date(Date.now() - 60_000);
		await withoutUser(async (db) => {
			expect(await load(db, 'wofs', damA, [['2021-03-01', 10, 50, 'item-1']], before)).toEqual({ written: 0, dams: 0, applied: false });
			expect(await load(db, 'wofs', damA, [['2021-03-01', 10, 50, 'item-1']])).toEqual({ written: 1, dams: 1, applied: true });
			expect(await load(db, 'wofs', crypto.randomUUID(), [['2021-03-01', 10, 50, 'item-1']])).toEqual({ written: 0, dams: 0, applied: false });
		});
	});

	it('refuses rows out of bounds', async () => {
		const bad = async (source: string, key: string, rows: [string, number, number, string][]) => code(withoutUser((db) => load(db, source, key, rows)));
		expect(await bad('other', 'zzzzza0001', [])).toBe('23514');
		expect(await bad('waterbodies', 'NOT-A-UID', [])).toBe('23514');
		expect(await bad('wofs', 'not-a-uuid', [])).toBe('23514');
		expect(await bad('wofs', damA, [['1983-12-31', 1, 100, 'k']])).toBe('23514');
		expect(await bad('wofs', damA, [['2999-01-01', 1, 100, 'k']])).toBe('23514');
		expect(
			await bad('wofs', damA, [
				['2020-01-01', 1, 100, 'k'],
				['2020-01-01', 2, 100, 'k']
			])
		).toBe('23514');
		expect(await bad('wofs', damA, [['2020-01-01', -1, 100, 'k']])).toBe('23514');
		expect(await bad('wofs', damA, [['2020-01-01', Number.NaN, 100, 'k']])).toBe('23514');
		expect(await bad('wofs', damA, [['2020-01-01', 1, 101, 'k']])).toBe('23514');
		expect(await bad('wofs', damA, [['2020-01-01', 1, 100, 'a key']])).toBe('23514');
		expect(await code(withoutUser((db) => load(db, 'wofs', damA, [['2020-01-01', 1, 100, 'k']], new Date(Date.now() + 3_600_000))))).toBe('23514');
		expect(await code(withoutUser(async (db) => match(db, damA, 'matched', null, await updatedAt(damA))))).toBe('23514');
		expect(await code(withoutUser(async (db) => match(db, damA, 'sideways', 'zzzzza0001', await updatedAt(damA))))).toBe('23514');
	});

	it('unmatching a dam drops its Waterbodies observations, not its WOfS ones; a stale feature time changes nothing', async () => {
		await seed();
		await withoutUser(async (db) => {
			expect(await match(db, damA, 'matched', 'zzzzza0001', new Date(0))).toEqual({ applied: false, dropped: 0 });
			expect(await match(db, damA, 'merged', 'zzzzza0001', await updatedAt(damA), [0.9, 0.3])).toEqual({ applied: true, dropped: 1 });
		});
		const left = (await asOwner('SELECT source FROM dam_observation WHERE feature_id = $1', [damA])) as { source: string }[];
		expect(left.map((r) => r.source)).toEqual(['wofs']);
	});

	it('redrawing a dam drops its match and observations; renaming it doesn’t', async () => {
		await seed();
		const matchOf = async (f: string) => (await asOwner('SELECT status, uid FROM dam_waterbody_match WHERE feature_id = $1', [f])) as { status: string; uid: string | null }[];
		expect(await matchOf(damB)).toEqual([{ status: 'matched', uid: 'zzzzzb0001' }]);
		// A rename keeps the match and every observation (positive control for the redraw below).
		expect((await owner.call('PATCH', `/projects/${projectId}/map/features/${damB}`, { name: 'Dam B renamed' })).status).toBe(200);
		expect(((await asOwner('SELECT count(*)::int AS n FROM dam_observation WHERE feature_id = $1', [damB]))[0] as { n: number }).n).toBe(2);
		expect(await matchOf(damB)).toEqual([{ status: 'matched', uid: 'zzzzzb0001' }]);
		const redraw = await owner.call('PATCH', `/projects/${projectId}/map/features/${damB}`, { geometry: { type: 'Polygon', coordinates: [box(21.351, -33.68, 0.002)] } });
		expect(redraw.status, JSON.stringify(redraw.body)).toBe(200);
		expect(((await asOwner('SELECT count(*)::int AS n FROM dam_observation WHERE feature_id = $1', [damB]))[0] as { n: number }).n).toBe(0);
		expect(await matchOf(damB)).toEqual([]);
		// Dam A untouched.
		expect(((await asOwner('SELECT count(*)::int AS n FROM dam_observation WHERE feature_id = $1', [damA]))[0] as { n: number }).n).toBe(2);
		expect(await matchOf(damA)).toEqual([{ status: 'matched', uid: 'zzzzza0001' }]);
	});

	it('deleting a dam deletes its match and observations', async () => {
		await seed();
		const gone = await dam(owner, projectId, 'Short-lived dam', 21.38);
		await withoutUser(async (db) => {
			await match(db, gone, 'none', null, await updatedAt(gone));
			await load(db, 'wofs', gone, [['2020-02-01', 1, 100, 'k']]);
		});
		expect((await owner.call('DELETE', `/projects/${projectId}/map/features/${gone}`)).status).toBe(204);
		expect(((await asOwner('SELECT count(*)::int AS n FROM dam_observation WHERE feature_id = $1', [gone]))[0] as { n: number }).n).toBe(0);
		expect(((await asOwner('SELECT count(*)::int AS n FROM dam_waterbody_match WHERE feature_id = $1', [gone]))[0] as { n: number }).n).toBe(0);
	});
});
