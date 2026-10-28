// Dams seen from space against the run (issue #604 R5-B; dams/observed/routes.ts,
// farms/view.ts dam-observed), end to end against Postgres with observations
// loaded the way the worker loads them (249's functions):
//  - a viewer reads each unit's dam: its views paired with the newest run's
//    dam_area on the same day, flagged, with the full area, the summary, the
//    match and the credit; a polygon linked to no unit is listed, never
//    compared; a Waterbodies polygon merged with a neighbour isn't compared;
//  - `run` picks another of the project's runs; another project's run, or a
//    malformed id, is 404;
//  - a stranger is 404 and a farmer 403 on the workspace route (positive
//    control: the viewer is answered); the farmer reads their own farm's newest
//    clear view on the farm route, never a neighbour's farm (404; positive
//    control: a viewer previews that farm).
//
// DB test files run one at a time; this one removes its observations after itself.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwner, monthly, node, signUp } from '../../__tests__/helpers.js';
import { type Db, withoutUser } from '../../db/tx.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let viewer: User;
let farmer: User;
let stranger: User;
let projectId: string;
let otherProjectId: string;
let runId: string;
let olderRunId: string;
let otherRunId: string;
const outlet = node('Weir', null);
const farmA = node('Farm A', outlet.id, { damAreaFullM2: 40_000 });
const farmB = node('Farm B', outlet.id);

const box = (x: number, d = 0.002) => [
	[
		[x, -33.68],
		[x + d, -33.68],
		[x + d, -33.68 + d],
		[x, -33.68 + d],
		[x, -33.68]
	]
];

async function dam(name: string, x: number, nodeId: string | null): Promise<string> {
	const res = await owner.call('POST', `/projects/${projectId}/map/features`, { kind: 'dam', name, nodeId, geometry: { type: 'Polygon', coordinates: box(x) } });
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.feature.id as string;
}
const updatedAt = async (featureId: string) => ((await asOwner('SELECT updated_at FROM map_feature WHERE id = $1', [featureId]))[0] as { updated_at: Date }).updated_at;
const match = async (db: Db, featureId: string, status: string, uid: string | null) =>
	expect(
		(await db.query('SELECT applied FROM app_dam_match_write($1, $2, $3, $4, $5, $6, NULL)', [featureId, status, uid, uid ? 0.95 : null, uid ? 0.9 : null, await updatedAt(featureId)])).rows[0]!.applied
	).toBe(true);
const load = (db: Db, source: string, key: string, rows: [string, number, number][]) =>
	db.query('SELECT written FROM app_dam_observation_load($1, $2, $3::date[], $4::float8[], $5::float8[], $6::text[], $7)', [
		source,
		key,
		rows.map((r) => r[0]),
		rows.map((r) => r[1]),
		rows.map((r) => r[2]),
		rows.map(() => (source === 'wofs' ? 'ga_ls_wofs_synthetic_1' : key)),
		new Date()
	]);

let damA: string;
let damB: string;
let loose: string;
/** The run's dam_area for Farm A, as stored. */
let damAreaA: number[];

beforeAll(async () => {
	[owner, viewer, farmer, stranger] = (await Promise.all(['Sowner', 'Sviewer', 'Sfarmer', 'Sstranger'].map((n) => signUp(n)))) as [User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Dams seen from space' })).body.project.id;
	expect((await owner.call('PUT', `/projects/${projectId}/model`, { nodes: [outlet, farmA, farmB], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
	expect((await owner.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(150) } })).status).toBe(200);
	const rain = Array.from({ length: 30 }, (_, i) => (i % 5 === 0 ? 30 : 0));
	expect((await owner.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: rain })).status).toBe(200);
	const older = await owner.call('POST', `/projects/${projectId}/runs`, { label: 'Older' });
	expect(older.status, JSON.stringify(older.body)).toBe(201);
	olderRunId = older.body.run.id;
	// The newest by created_at (the Dams tab's pick), whatever the clock's resolution.
	await asOwner(`UPDATE model_run SET created_at = now() - interval '1 day' WHERE id = $1`, [olderRunId]);
	const run = await owner.call('POST', `/projects/${projectId}/runs`, { label: 'Newest' });
	expect(run.status).toBe(201);
	runId = run.body.run.id;
	for (const [u, role] of [[viewer, 'viewer']] as const) expect((await owner.call('POST', `/projects/${projectId}/members`, { email: u.email, role })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: farmer.email, nodeIds: [farmA.id] })).status).toBe(201);

	otherProjectId = (await stranger.call('POST', '/projects', { name: 'Elsewhere space' })).body.project.id;
	otherRunId = crypto.randomUUID();

	damA = await dam('Dam A', 21.31, farmA.id);
	damB = await dam('Dam B', 21.35, farmB.id);
	loose = await dam('Loose dam', 21.39, null);
	damAreaA = ((await asOwner(`SELECT "values" FROM run_series WHERE run_id = $1 AND node_id = $2 AND key = 'dam_area'`, [runId, farmA.id]))[0] as { values: number[] }).values;
	expect(damAreaA).toHaveLength(30);

	await withoutUser(async (db) => {
		await match(db, damA, 'matched', 'zzzzzr5b01');
		await match(db, damB, 'merged', 'zzzzzr5b02');
		// Farm A: a clear Waterbodies view, a clear WOfS view, a cloudy one, and one after the run.
		await load(db, 'waterbodies', 'zzzzzr5b01', [['2020-01-05', 39_000, 100]]);
		await load(db, 'wofs', damA, [
			['2020-01-10', 12_000, 96],
			['2020-01-12', 5_000, 40],
			['2020-03-01', 20_000, 100]
		]);
		await load(db, 'wofs', damB, [['2020-01-10', 3_000, 100]]);
		await load(db, 'wofs', loose, [['2020-01-10', 1_000, 100]]);
	});
	// Farm B's Waterbodies polygon is merged: its row comes from a uid matched to it before the merge (the loader
	// only writes to 'matched' dams), so plant it as the owner to see the read path leave it out.
	await asOwner(`INSERT INTO dam_observation (project_id, feature_id, source, obs_date, wet_area_m2, pct_observed, upstream_key) VALUES ($1, $2, 'waterbodies', '2020-01-10', 90000, 100, 'zzzzzr5b02')`, [projectId, damB]);
}, 120_000);

afterAll(async () => {
	await asOwner('DELETE FROM project WHERE id = ANY($1::uuid[])', [[projectId, otherProjectId]]);
});

const observations = (u: User, q = '', pid = projectId) => u.call('GET', `/projects/${pid}/dams/observations${q}`);

describe('GET /projects/:id/dams/observations', () => {
	it('pairs each unit’s views with the newest run’s dam_area that day, flagged, with the summary, the match and the credit (viewer)', async () => {
		const res = await observations(viewer);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.attribution).toBe('Digital Earth Africa, CC BY 4.0');
		expect(res.body.thresholds).toMatchObject({ minPctObserved: 90, fullShare: 0.95, withinShare: 0.1 });
		expect(res.body.run).toMatchObject({ id: runId, label: 'Newest' });
		const a = res.body.dams.find((d: { nodeId: string }) => d.nodeId === farmA.id);
		expect(a.features).toEqual([{ id: damA, name: 'Dam A', nodeId: farmA.id, match: { status: 'matched', damShare: 0.95, waterbodyShare: 0.9 } }]);
		expect(a.fullArea).toEqual({ areaM2: 40_000, from: 'entered' });
		expect(a.inRun).toBe(true);
		expect(a.points.map((p: { date: string; source: string; compared: boolean; skip: string | null; modelledAreaM2: number | null }) => [p.date, p.source, p.compared, p.skip, p.modelledAreaM2])).toEqual([
			['2020-01-05', 'waterbodies', true, null, damAreaA[4]],
			['2020-01-10', 'wofs', true, null, damAreaA[9]],
			['2020-01-12', 'wofs', false, 'partly-seen', damAreaA[11]],
			['2020-03-01', 'wofs', false, 'outside-run', null]
		]);
		// 39 000 m² of 40 000: seen full.
		expect(a.points[0]).toMatchObject({ seenFull: true, seenEmpty: false });
		expect(a.summary).toMatchObject({ compared: 2, skipped: 2, latestClear: { date: '2020-03-01', source: 'wofs', wetAreaM2: 20_000 } });
		const bias = (damAreaA[4]! - 39_000 + damAreaA[9]! - 12_000) / 2 / 40_000 * 100;
		expect(a.summary.biasPctOfFull).toBeCloseTo(bias, 9);
	});

	it('leaves out a merged Waterbodies polygon’s views, and lists a polygon linked to no unit without comparing it', async () => {
		const res = await observations(viewer);
		const b = res.body.dams.find((d: { nodeId: string }) => d.nodeId === farmB.id);
		expect(b.features[0].match.status).toBe('merged');
		expect(b.points.map((p: { source: string; skip: string | null }) => [p.source, p.skip])).toEqual([
			['waterbodies', 'not-this-dam'],
			['wofs', null]
		]);
		// Farm B has no area entered: the run's own estimate from its capacity.
		expect(b.fullArea.from).toBe('estimated');
		const l = res.body.dams.find((d: { features: { id: string }[] }) => d.features[0]!.id === loose);
		expect(l).toMatchObject({ nodeId: null, fullArea: null, inRun: false });
		expect(l.points.map((p: { skip: string | null }) => p.skip)).toEqual(['no-run']);
	});

	it('compares with the run named, and answers 404 for another project’s run or a malformed id', async () => {
		const res = await observations(viewer, `?run=${olderRunId}`);
		expect(res.status).toBe(200);
		expect(res.body.run.id).toBe(olderRunId);
		expect((await observations(viewer, `?run=${otherRunId}`)).status).toBe(404);
		expect((await observations(viewer, '?run=not-a-uuid')).status).toBe(404);
		expect((await observations(viewer, '?node=not-a-uuid')).status).toBe(404);
		const one = await observations(viewer, `?node=${farmB.id}`);
		expect(one.body.dams.map((d: { nodeId: string }) => d.nodeId)).toEqual([farmB.id]);
	});

	it('is 404 to a stranger and 403 to a farmer (the viewer above is the positive control)', async () => {
		const s = await observations(stranger);
		expect(s.status).toBe(404);
		expect(JSON.stringify(s.body)).not.toContain('Dam A');
		expect((await observations(farmer)).status).toBe(403);
		// The stranger's own project answers, with nothing of this one's.
		const own = await observations(stranger, '', otherProjectId);
		expect(own.status).toBe(200);
		expect(own.body.dams).toEqual([]);
	});
});

describe('GET /projects/:id/farm/:nodeId/dam-observed', () => {
	it('gives the farmer their own dam’s newest clear view, its full area and the credit, and nothing else', async () => {
		const res = await farmer.call('GET', `/projects/${projectId}/farm/${farmA.id}/dam-observed`);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body).toEqual({ outlines: 1, latest: { date: '2020-03-01', wetAreaM2: 20_000, source: 'wofs' }, fullAreaM2: 40_000, attribution: 'Digital Earth Africa, CC BY 4.0' });
	});

	it('is 404 to the farmer for a neighbour’s farm (positive control: a viewer previews it)', async () => {
		const res = await farmer.call('GET', `/projects/${projectId}/farm/${farmB.id}/dam-observed`);
		expect(res.status).toBe(404);
		expect(JSON.stringify(res.body)).not.toContain('Dam B');
		const v = await viewer.call('GET', `/projects/${projectId}/farm/${farmB.id}/dam-observed`);
		expect(v.status).toBe(200);
		expect(v.body).toMatchObject({ outlines: 1, latest: { date: '2020-01-10', wetAreaM2: 3_000 } });
		expect((await stranger.call('GET', `/projects/${projectId}/farm/${farmA.id}/dam-observed`)).status).toBe(404);
	});
});
