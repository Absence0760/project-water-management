// Observed actual ET against a unit's modelled irrigation use (issue #623
// step 5; water-use/observed/routes.ts), end to end against Postgres with the
// observations loaded the way the worker loads them (277's
// app_et_observation_load):
//  - a viewer reads a unit's dekads paired with the newest run's crop ET,
//    effective rain and irrigation reaching the crop, summed over the same
//    days, with the bands, the planted area and the credit; a dekad seen
//    through cloud and one after the run are listed, not compared;
//  - a unit with no observations (the usual case: the fetch is off) answers
//    an empty `sources`;
//  - `run` picks another of the project's runs; another project's run, a
//    malformed id, or a node that isn't the project's is 404, a gauge 400,
//    and no response carries database text;
//  - a stranger is 404 and a farmer 403 on the workspace route (positive
//    control: the viewer is answered); under the farmer's own RLS the read
//    gives their unit's rows (positive control) and never a neighbour's.
//
// Run under a skewed TZ (CLAUDE.md rule 7): the dekads are calendar days.
// DB test files run one at a time; this one removes its project after itself.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwner, monthly, node, signUp } from '../../__tests__/helpers.js';
import { withoutUser, withUser, type Db } from '../../db/tx.js';
import { etObservationsOf } from './read.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let viewer: User;
let farmer: User;
let stranger: User;
let projectId: string;
let otherProjectId: string;
let runId: string;
let olderRunId: string;
const outlet = node('Weir', null);
const farmA = node('Farm A', outlet.id);
const farmB = node('Farm B', outlet.id);
// 200 ha behind a 1 000 m³ dam: the run can't supply it.
const farmC = node('Farm C', outlet.id, { damCapacityM3: 1_000 });
const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.8) };
const AREA = 100_000;

const box = (x: number) => ({ type: 'Polygon', coordinates: [[[x, -33.7], [x + 0.01, -33.7], [x + 0.01, -33.69], [x, -33.69], [x, -33.7]]] });
async function parcel(nodeId: string, x: number) {
	const res = await owner.call('POST', `/projects/${projectId}/map/features`, { kind: 'farm_parcel', name: 'Parcel', nodeId, geometry: box(x) });
	expect(res.status, JSON.stringify(res.body)).toBe(201);
}
const load = (db: Db, nodeId: string, rows: [string, number, number][]) =>
	db
		.query<{ applied: boolean }>(
			`SELECT applied FROM app_et_observation_load('wapor', $1, $2::date[], $3::float8[], $4::float8[], $5::float8[], 'cropland', $6::text[], $7::text[], 'WAPOR-3', now())`,
			[nodeId, rows.map((r) => r[0]), rows.map((r) => r[1]), rows.map((r) => r[2]), rows.map(() => 120_000), rows.map((r) => `WAPOR-3.L2-AETI-D.${r[0]}.tif`), rows.map(() => '"e1"')]
		)
		.then((r) => expect(r.rows[0]!.applied).toBe(true));
const series = async (key: string) =>
	((await asOwner(`SELECT "values" FROM run_series WHERE run_id = $1 AND node_id = $2 AND key = $3`, [runId, farmA.id, key]))[0] as { values: number[] }).values;
const sum = (v: number[], from: number, days: number) => v.slice(from, from + days).reduce((s, x) => s + x, 0);
const etObserved = (u: User, nodeId: string, q = '', pid = projectId) => u.call('GET', `/projects/${pid}/nodes/${nodeId}/et-observed${q}`);

const zone = process.env.TZ;
beforeAll(async () => {
	process.env.TZ = 'Pacific/Kiritimati';
	[owner, viewer, farmer, stranger] = (await Promise.all(['ETCowner', 'ETCviewer', 'ETCfarmer', 'ETCstranger'].map((n) => signUp(n)))) as [User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Observed ET compared' })).body.project.id;
	const model = { nodes: [outlet, farmA, farmB, farmC], crops: [crop], cropAreas: [
			{ nodeId: farmA.id, cropId: crop.id, areaM2: AREA },
			{ nodeId: farmC.id, cropId: crop.id, areaM2: 2_000_000 }
		], transfers: [] };
	expect((await owner.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
	expect((await owner.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(150) } })).status).toBe(200);
	const rain = Array.from({ length: 60 }, (_, i) => (i % 7 === 0 ? 12 : 0));
	expect((await owner.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: rain })).status).toBe(200);
	const older = await owner.call('POST', `/projects/${projectId}/runs`, { label: 'Older' });
	expect(older.status, JSON.stringify(older.body)).toBe(201);
	olderRunId = older.body.run.id;
	await asOwner(`UPDATE model_run SET created_at = now() - interval '1 day' WHERE id = $1`, [olderRunId]);
	const run = await owner.call('POST', `/projects/${projectId}/runs`, { label: 'Newest' });
	expect(run.status).toBe(201);
	runId = run.body.run.id;
	// A snapshot row naming a crop the model lacks (the API refuses one; an older or hand-edited snapshot may hold it):
	// the engine skips it, and so must the planted area.
	await asOwner(
		`UPDATE model_run SET inputs = jsonb_set(inputs, '{model,cropAreas}', (inputs->'model'->'cropAreas') || jsonb_build_array(jsonb_build_object('nodeId', $2::text, 'cropId', $3::text, 'areaM2', 500000))) WHERE id = $1`,
		[runId, farmC.id, crypto.randomUUID()]
	);
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: farmer.email, nodeIds: [farmA.id] })).status).toBe(201);
	otherProjectId = (await stranger.call('POST', '/projects', { name: 'Elsewhere ET' })).body.project.id;

	await parcel(farmA.id, 21.3);
	await parcel(farmB.id, 21.32);
	await parcel(farmC.id, 21.34);
	await withoutUser(async (db) => {
		// Farm A: two clear dekads, one through cloud, one after the run (it ends 2020-02-29).
		await load(db, farmA.id, [
			['2020-01-01', 4, 1],
			['2020-01-11', 4, 0.5],
			['2020-01-21', 5, 0.95],
			['2020-03-01', 3, 1]
		]);
		await load(db, farmC.id, [['2020-02-01', 4, 1]]);
	});
}, 120_000);

afterAll(async () => {
	process.env.TZ = zone;
	await asOwner('DELETE FROM project WHERE id = ANY($1::uuid[])', [[projectId, otherProjectId]]);
});

describe('GET /projects/:id/nodes/:nodeId/et-observed', () => {
	it('pairs the unit’s dekads with the newest run’s crop ET and irrigation over the same days, with the credit (viewer)', async () => {
		const res = await etObserved(viewer, farmA.id);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body).toMatchObject({ nodeId: farmA.id, name: 'Farm A', plantedAreaM2: AREA, run: { id: runId, label: 'Newest', inRun: true } });
		expect(res.body.thresholds).toEqual({ minValidShare: 0.8, withinShare: 0.25, floorMmDay: 0.5, areaRatio: 1.5 });
		expect(res.body.sources).toHaveLength(1);
		const s = res.body.sources[0];
		expect(s.source).toBe('wapor');
		expect(s.attribution).toBe('FAO WaPOR v3, CC BY 4.0');
		expect(s.area).toMatchObject({ areaM2: 120_000, mask: 'cropland', differs: false });
		expect(s.area.ratioToPlanted).toBeCloseTo(1.2, 12);
		expect(s.points.map((p: { dekad: string; days: number; compared: boolean; skip: string | null }) => [p.dekad, p.days, p.compared, p.skip])).toEqual([
			['2020-01-01', 10, true, null],
			['2020-01-11', 10, false, 'partly-seen'],
			['2020-01-21', 11, true, null],
			['2020-03-01', 10, false, 'outside-run']
		]);
		const gross = await series('gross_demand');
		const rain = await series('effective_rain');
		expect(gross).toHaveLength(60);
		const third = s.points[2];
		expect(third.observedEtM3).toBeCloseTo((5 * 11 * AREA) / 1000, 9);
		expect(third.requirementM3).toBeCloseTo(sum(gross.map((v) => Math.max(0, v)), 20, 11), 6);
		expect(third.effectiveRainM3).toBeCloseTo(sum(rain, 20, 11), 6);
		expect(third.observedIrrigationM3).toBeCloseTo(Math.max(0, third.observedEtM3 - third.effectiveRainM3), 6);
		// The crop gets F × G ÷ D each day (e × G).
		const [F, D, G] = [await series('crop_requirement'), await series('demand'), await series('supplied')];
		const use = F.slice(20, 31).reduce((t, f, i) => t + (D[20 + i]! > 0 ? f * Math.min(1, G[20 + i]! / D[20 + i]!) : 0), 0);
		expect(use).toBeGreaterThan(0);
		expect(third.modelledIrrigationM3).toBeCloseTo(use, 6);
		// The crop ET the run supplied: its effective rain and the irrigation reaching it, never above the requirement.
		expect(third.modelledEtM3).toBeCloseTo(third.effectiveRainM3 + use, 6);
		expect(third.modelledEtM3).toBeLessThanOrEqual(third.requirementM3 + 1e-6);
		expect(s.summary).toMatchObject({ compared: 2, skipped: 2 });
		const obs = (4 * 10 + 5 * 11) * AREA / 1000;
		const mod = s.points[0].modelledEtM3 + third.modelledEtM3;
		expect(s.summary.etBiasPct).toBeCloseTo(((mod - obs) / obs) * 100, 6);
		expect(s.seasons.map((x: { label: string; compared: number }) => [x.label, x.compared])).toEqual([['Oct 2019 – Mar 2020', 2]]);
	});

	it('compares an under-supplied unit’s ET as the run supplied it, below its requirement, on the planted area of known crops', async () => {
		const res = await etObserved(viewer, farmC.id);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.plantedAreaM2).toBe(2_000_000);
		const p = res.body.sources[0].points[0];
		expect(p.compared).toBe(true);
		expect(p.observedEtM3).toBeCloseTo((4 * 10 * 2_000_000) / 1000, 6);
		expect(p.modelledEtM3).toBeCloseTo(p.effectiveRainM3 + p.modelledIrrigationM3, 6);
		expect(p.modelledEtM3).toBeLessThan(0.9 * p.requirementM3);
	});

	it('answers an empty list for a unit with no observations: the usual case, the fetch being off', async () => {
		const res = await etObserved(viewer, farmB.id);
		expect(res.status).toBe(200);
		expect(res.body.sources).toEqual([]);
		// Farm B plants nothing: no area to put a depth on.
		expect(res.body.plantedAreaM2).toBe(0);
	});

	it('compares with the run named, and answers 404 for another project’s run, a malformed id or another project’s node, 400 for a gauge', async () => {
		const res = await etObserved(viewer, farmA.id, `?run=${olderRunId}`);
		expect(res.status).toBe(200);
		expect(res.body.run.id).toBe(olderRunId);
		expect((await etObserved(viewer, farmA.id, `?run=${crypto.randomUUID()}`)).status).toBe(404);
		const bad = await etObserved(viewer, farmA.id, '?run=not-a-uuid');
		expect(bad.status).toBe(404);
		expect(bad.body.error).toBe('not found');
		expect((await etObserved(viewer, 'not-a-uuid')).status).toBe(404);
		expect((await etObserved(viewer, crypto.randomUUID())).status).toBe(404);
		const gauge = await etObserved(viewer, outlet.id);
		expect(gauge.status).toBe(400);
		expect(JSON.stringify(gauge.body)).not.toMatch(/relation|column|syntax|violates/i);
	});

	it('is 404 to a stranger and 403 to a farmer (the viewer above is the positive control)', async () => {
		const s = await etObserved(stranger, farmA.id);
		expect(s.status).toBe(404);
		expect(JSON.stringify(s.body)).not.toContain('Farm A');
		expect((await etObserved(farmer, farmA.id)).status).toBe(403);
		// The stranger asking their own project for this project's unit: not found, nothing of it.
		const cross = await etObserved(stranger, farmA.id, '', otherProjectId);
		expect(cross.status).toBe(404);
	});

	it('reads, under a farmer’s own RLS, their unit’s rows (positive control) and never a neighbour’s', async () => {
		await withoutUser((db) => load(db, farmB.id, [['2020-01-01', 3, 1]]));
		const own = await withUser(farmer.id, (db) => etObservationsOf(db, projectId, farmA.id));
		expect(own.map((o) => o.dekad)).toEqual(['2020-01-01', '2020-01-11', '2020-01-21', '2020-03-01']);
		expect(await withUser(farmer.id, (db) => etObservationsOf(db, projectId, farmB.id))).toEqual([]);
		// The viewer sees the neighbour's (positive control for the empty answer above).
		expect((await withUser(viewer.id, (db) => etObservationsOf(db, projectId, farmB.id))).length).toBe(1);
		await asOwner('DELETE FROM et_observation WHERE node_id = $1', [farmB.id]);
	});
});
