// The observed wet days' query (evidence/damObservations.ts, report format
// evidence-21, issue #604 R5-C; Sentinel-2 from evidence-24, issue #624 step
// 7): a project's dams on the given units with their WOfS and Sentinel-2 rows
// in the period, under the reader's RLS. Invented dams and values.
//
// DB test files run one at a time; this one removes its observation rows after each test.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { asOwner, node, signUp } from '../__tests__/helpers.js';
import { withoutUser, withUser } from '../db/tx.js';
import { loadDamObservations } from './damObservations.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let viewer: User;
let farmer: User;
let stranger: User;
let projectId: string;
let otherProjectId: string;
const outlet = node('Weir', null);
const farmA = node('Farm A', outlet.id);
const farmB = node('Farm B', outlet.id);
let damA: string;
let damA2: string;
let damB: string;
let damOther: string;

const box = (x: number, d = 0.002) => [
	[x, -33.68],
	[x + d, -33.68],
	[x + d, -33.68 + d],
	[x, -33.68 + d],
	[x, -33.68]
];
async function dam(u: User, pid: string, name: string, x: number, nodeId: string | null): Promise<string> {
	const res = await u.call('POST', `/projects/${pid}/map/features`, { kind: 'dam', name, nodeId, geometry: { type: 'Polygon', coordinates: [box(x)] } });
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.feature.id as string;
}
/** Loads rows for a dam as the worker does (app_dam_observation_load, 261; Sentinel sources since 278). */
const load = (source: 'wofs' | 's2' | 's1' | 'waterbodies', key: string, rows: [string, number, number][]) =>
	withoutUser((db) =>
		db.query('SELECT written FROM app_dam_observation_load($1, $2, $3::date[], $4::float8[], $5::float8[], $6::text[], $7)', [
			source,
			key,
			rows.map((r) => r[0]),
			rows.map((r) => r[1]),
			rows.map((r) => r[2]),
			rows.map(() => (source === 'waterbodies' ? key : `synthetic-${source}-item`)),
			new Date()
		])
	);
const read = (u: User, pid: string, nodeIds: string[], start = '2020-01-01', end = '2020-12-31') => withUser(u.id, (db) => loadDamObservations(db, pid, nodeIds, start, end));

beforeAll(async () => {
	[owner, viewer, farmer, stranger] = (await Promise.all(['Wowner', 'Wviewer', 'Wfarmer', 'Wstranger'].map((n) => signUp(n)))) as [User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Wet days' })).body.project.id;
	expect((await owner.call('PUT', `/projects/${projectId}/model`, { nodes: [outlet, farmA, farmB], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: farmer.email, nodeIds: [farmA.id] })).status).toBe(201);
	otherProjectId = (await stranger.call('POST', '/projects', { name: 'Elsewhere' })).body.project.id;
	damA = await dam(owner, projectId, 'Upper', 21.31, farmA.id);
	damA2 = await dam(owner, projectId, 'Lower', 21.32, farmA.id);
	damB = await dam(owner, projectId, 'Neighbour', 21.35, farmB.id);
	damOther = await dam(stranger, otherProjectId, 'Elsewhere', 21.4, null);
}, 60_000);

afterEach(async () => {
	await asOwner('DELETE FROM dam_observation');
});
afterAll(async () => {
	await asOwner('DELETE FROM project WHERE id = ANY($1::uuid[])', [[projectId, otherProjectId]]);
});

async function seed() {
	await load('wofs', damA, [
		['2019-12-31', 100, 100], // before the period
		['2020-01-05', 1800, 100],
		['2020-01-13', 0, 95],
		['2021-01-01', 100, 100] // after it
	]);
	await load('wofs', damB, [['2020-01-05', 900, 100]]);
	await load('wofs', damOther, [['2020-01-05', 700, 100]]);
}

describe('loadDamObservations', () => {
	it('gives the dams on the units asked for, each with its WOfS rows in the period, oldest first', async () => {
		await seed();
		const got = await read(owner, projectId, [farmA.id]);
		expect(got.map((d) => d.featureId).sort()).toEqual([damA, damA2].sort());
		expect(got.find((d) => d.featureId === damA)).toEqual({
			featureId: damA,
			name: 'Upper',
			nodeId: farmA.id,
			rows: [
				{ source: 'wofs', date: '2020-01-05', wetAreaM2: 1800, pctObserved: 100 },
				{ source: 'wofs', date: '2020-01-13', wetAreaM2: 0, pctObserved: 95 }
			]
		});
		// A dam with no rows is still listed, with none.
		expect(got.find((d) => d.featureId === damA2)!.rows).toEqual([]);
	});

	it('reads WOfS and Sentinel-2 rows, never Waterbodies’ or Sentinel-1 radar’s', async () => {
		await seed();
		await load('s2', damA, [
			['2019-12-30', 800, 100], // before the period
			['2020-01-05', 2500, 100], // the same date as a WOfS row: both kept
			['2020-01-10', 0, 99]
		]);
		// Radar: never alone a wet or dry call, so § 7 doesn't count it.
		await load('s1', damA, [['2020-01-07', 3000, 100]]);
		// A Waterbodies row for the same dam (written as the schema owner: its loader goes through a waterbody match).
		await asOwner(
			`INSERT INTO dam_observation (project_id, feature_id, source, obs_date, wet_area_m2, pct_observed, upstream_key)
			 VALUES ($1, $2, 'waterbodies', '2020-02-01', 5000, 100, 'zzzzza0001')`,
			[projectId, damA]
		);
		// Positive controls: the radar and Waterbodies rows are there to be left out.
		expect(await asOwner(`SELECT source FROM dam_observation WHERE feature_id = $1 AND source IN ('waterbodies', 's1') ORDER BY source`, [damA])).toEqual([{ source: 's1' }, { source: 'waterbodies' }]);
		const rows = (await read(owner, projectId, [farmA.id])).find((d) => d.featureId === damA)!.rows;
		expect(rows).toEqual([
			{ source: 's2', date: '2020-01-05', wetAreaM2: 2500, pctObserved: 100 },
			{ source: 's2', date: '2020-01-10', wetAreaM2: 0, pctObserved: 99 },
			{ source: 'wofs', date: '2020-01-05', wetAreaM2: 1800, pctObserved: 100 },
			{ source: 'wofs', date: '2020-01-13', wetAreaM2: 0, pctObserved: 95 }
		]);
	});

	it('a farmer reads their own dam’s Sentinel-2 rows (positive control), never a neighbour’s', async () => {
		await load('s2', damA, [['2020-01-05', 2500, 100]]);
		await load('s2', damB, [['2020-01-05', 2500, 100]]);
		const got = await read(farmer, projectId, [farmA.id, farmB.id]);
		expect(got.find((d) => d.featureId === damA)!.rows).toHaveLength(1);
		expect(got.some((d) => d.featureId === damB)).toBe(false);
		expect(await read(stranger, projectId, [farmA.id, farmB.id])).toEqual([]);
	});

	it('gives nothing for no units, or ids that aren’t a node’s', async () => {
		await seed();
		expect(await read(owner, projectId, [])).toEqual([]);
		expect(await read(owner, projectId, ['F1', 'not-a-uuid'])).toEqual([]);
	});

	describe('RLS', () => {
		it('a member reads them (positive control); a stranger reads nothing of the project', async () => {
			await seed();
			expect((await read(viewer, projectId, [farmA.id, farmB.id])).map((d) => d.featureId).sort()).toEqual([damA, damA2, damB].sort());
			expect(await read(stranger, projectId, [farmA.id, farmB.id])).toEqual([]);
		});

		it('a farmer reads their own farm’s dams (positive control), never a neighbour’s', async () => {
			await seed();
			const got = await read(farmer, projectId, [farmA.id, farmB.id]);
			expect(got.map((d) => d.featureId).sort()).toEqual([damA, damA2].sort());
			expect(got.find((d) => d.featureId === damA)!.rows).toHaveLength(2);
		});

		it('another project’s dam is never read through this one', async () => {
			await seed();
			expect((await read(stranger, otherProjectId, [farmA.id])).length).toBe(0);
			expect((await read(owner, otherProjectId, [farmA.id])).length).toBe(0);
		});
	});
});
