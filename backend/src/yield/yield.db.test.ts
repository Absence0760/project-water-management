// Firm yield end to end (WP-3.6, 040_yield.sql): the POST /yield request
// checks, the `yield` job run as its acting user (the memory transport: the
// test runs the tick itself), the stored results and their RLS, progress on
// the job list, the per-user limit, and the job failing closed when the user
// lost the editor role.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { runTick } from '../jobs/runner.js';

type User = Awaited<ReturnType<typeof signUp>>;

afterEach(() => vi.unstubAllEnvs());

/** A dam draining into an outlet gauge, 90 days of rain, one saved run. */
async function catchment(owner: User, name = 'Yield') {
	const projectId = (await owner.call('POST', '/projects', { name })).body.project.id as string;
	const outlet = node('Outlet', null);
	const dam = node('Dam', outlet.id, { pctRunoffToDam: 1, damCapacityM3: 50_000, damInitialPct: 1, damMinPct: 0 });
	const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.8) };
	const model = { nodes: [outlet, dam], crops: [crop], cropAreas: [{ nodeId: dam.id, cropId: crop.id, areaM2: 10_000 }], transfers: [] };
	expect((await owner.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
	expect((await owner.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(150) } })).status).toBe(200);
	const rain = Array.from({ length: 90 }, (_, i) => (i % 7 === 0 ? 20 : 0));
	expect((await owner.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: rain })).status).toBe(200);
	const run = await owner.call('POST', `/projects/${projectId}/runs`, { label: 'base' });
	expect(run.status, JSON.stringify(run.body)).toBe(201);
	return { projectId, outlet, dam, runId: run.body.run.id as string };
}

async function member(owner: User, projectId: string, u: User, role: 'viewer' | 'editor' | 'owner') {
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: u.email, role })).status).toBe(201);
}

const tick = () => runTick({ feeds: false, reports: false });
const job = async (id: string) => (await asOwner('SELECT status, last_error, progress FROM job WHERE id = $1', [id]))[0] as { status: string; last_error: string | null; progress: number | null };

describe('POST /projects/:id/yield', () => {
	it('an editor queues a firm yield; the job stores it and reports 100 % on the job list', async () => {
		const owner = await signUp('YieldOwner');
		const c = await catchment(owner);
		const res = await owner.call('POST', `/projects/${c.projectId}/yield`, { nodeId: c.dam.id, runId: c.runId, kind: 'firm' });
		expect(res.status, JSON.stringify(res.body)).toBe(202);
		const jobId = res.body.jobId as string;
		// The same request while it waits is that job, not a second one.
		const again = await owner.call('POST', `/projects/${c.projectId}/yield`, { nodeId: c.dam.id, runId: c.runId, kind: 'firm', params: {} });
		expect(again.status).toBe(200);
		expect(again.body.jobId).toBe(jobId);

		await tick();
		expect(await job(jobId)).toMatchObject({ status: 'done', last_error: null, progress: 100 });
		const listed = (await owner.call('GET', `/projects/${c.projectId}/jobs`)).body.jobs.find((j: { id: string }) => j.id === jobId);
		expect(listed).toMatchObject({ kind: 'yield', status: 'done', progress: 100 });

		const got = await owner.call('GET', `/projects/${c.projectId}/yield?runId=${c.runId}`);
		expect(got.status).toBe(200);
		expect(got.body.results).toHaveLength(1);
		const r = got.body.results[0];
		expect(r).toMatchObject({ runId: c.runId, scenarioId: null, nodeId: c.dam.id, jobId, kind: 'firm', params: { pattern: 'constant', assurance: 1, tolerance: 0.001, points: 11 } });
		expect(r.points.point.capacityM3).toBe(50_000);
		expect(r.points.point.yieldM3Day).toBeGreaterThan(0);
		expect(r.points.point.failureDays).toBe(0);
		expect(r.engineVersion).toMatch(/^\d+\.\d+\.\d+$/);
		// And by job.
		expect((await owner.call('GET', `/projects/${c.projectId}/yield?jobId=${jobId}`)).body.results.map((x: { id: string }) => x.id)).toEqual([r.id]);
	});

	it('a storage–yield curve: 11 points from 0 to 2× the dam, non-decreasing here', async () => {
		const owner = await signUp('YieldCurve');
		const c = await catchment(owner);
		const res = await owner.call('POST', `/projects/${c.projectId}/yield`, { nodeId: c.dam.id, runId: c.runId, kind: 'curve', params: { pattern: 'demand' } });
		expect(res.status, JSON.stringify(res.body)).toBe(202);
		await tick();
		expect((await job(res.body.jobId)).status).toBe('done');
		const [r] = (await owner.call('GET', `/projects/${c.projectId}/yield?runId=${c.runId}&nodeId=${c.dam.id}`)).body.results;
		expect(r.kind).toBe('curve');
		expect(r.points.baseCapacityM3).toBe(50_000);
		expect(r.points.points.map((p: { capacityM3: number }) => p.capacityM3)).toEqual(Array.from({ length: 11 }, (_, k) => k * 10_000));
		expect(r.points.monotone).toBe(true);
	});

	it('refuses a gauge, a node not in the run, both or neither target, and a curve for a farm with no dam', async () => {
		const owner = await signUp('YieldBad');
		const c = await catchment(owner);
		const post = (body: Record<string, unknown>) => owner.call('POST', `/projects/${c.projectId}/yield`, body);
		expect((await post({ nodeId: c.outlet.id, runId: c.runId, kind: 'firm' })).body.error).toBe('a yield is for a hydrological unit with land (a unit or its dam), not a gauge or other water user');
		expect((await post({ nodeId: crypto.randomUUID(), runId: c.runId, kind: 'firm' })).body.error).toBe('that hydrological unit is not in this run or scenario');
		expect((await post({ nodeId: c.dam.id, kind: 'firm' })).status).toBe(400);
		expect((await post({ nodeId: c.dam.id, runId: c.runId, scenarioId: crypto.randomUUID(), kind: 'firm' })).status).toBe(400);
		expect((await post({ nodeId: c.dam.id, runId: c.runId, kind: 'curve', params: { points: 30 } })).status).toBe(400);
		expect((await post({ nodeId: c.dam.id, runId: crypto.randomUUID(), kind: 'firm' })).status).toBe(404);
		const noDam = await post({ nodeId: c.dam.id, runId: c.runId, kind: 'curve' });
		expect(noDam.status).toBe(202); // this one has a dam; the scenario below takes it away
		const sid = (
			await owner.call('POST', `/projects/${c.projectId}/scenarios`, {
				name: 'No dam',
				baseRunId: c.runId,
				ops: [{ op: 'node.set', nodeId: c.dam.id, field: 'damCapacityM3', value: 0 }]
			})
		).body.scenario.id;
		const res = await post({ nodeId: c.dam.id, scenarioId: sid, kind: 'curve' });
		expect(res.status).toBe(400);
		expect(res.body).toMatchObject({ code: 'yield_no_dam', error: 'a storage–yield curve of a unit with no dam (capacity 0 m³) needs the largest capacity to size it to (params.maxCapacityM3)' });
		await tick();
	});

	it('refuses a forecast run with 409 (a yield is judged on history, issue #51); an ordinary run of the same data is accepted', async () => {
		const owner = await signUp('YieldForecast');
		const c = await catchment(owner, 'Yield forecast');
		// 14 days of forecast rain after the 90-day record (2020-01-01 … 2020-03-30).
		const put = await owner.call('PUT', `/projects/${c.projectId}/series`, { kind: 'rain_forecast_mm', unit: 'mm', startDate: '2020-03-31', values: new Array(14).fill(5) });
		expect(put.status).toBe(200);
		const f = await owner.call('POST', `/projects/${c.projectId}/runs`, { label: 'forecast', forecast: true });
		expect(f.status, JSON.stringify(f.body)).toBe(201);
		const refused = await owner.call('POST', `/projects/${c.projectId}/yield`, { nodeId: c.dam.id, runId: f.body.run.id, kind: 'firm' });
		expect(refused.status).toBe(409);
		expect(refused.body.error).toMatch(/forecast run/);
		expect((await asOwner(`SELECT count(*)::int AS n FROM job WHERE project_id = $1 AND kind = 'yield'`, [c.projectId]))[0].n).toBe(0);
		// Positive control: the ordinary run, made before the forecast was added.
		expect((await owner.call('POST', `/projects/${c.projectId}/yield`, { nodeId: c.dam.id, runId: c.runId, kind: 'firm' })).status).toBe(202);
	});

	it('a yield on a scenario runs its ops on the base run: a raised dam yields more', async () => {
		const owner = await signUp('YieldScenario');
		const c = await catchment(owner);
		const sid = (
			await owner.call('POST', `/projects/${c.projectId}/scenarios`, {
				name: 'Raise',
				baseRunId: c.runId,
				ops: [{ op: 'node.set', nodeId: c.dam.id, field: 'damCapacityM3', value: 200_000 }]
			})
		).body.scenario.id as string;
		const base = await owner.call('POST', `/projects/${c.projectId}/yield`, { nodeId: c.dam.id, runId: c.runId, kind: 'firm' });
		const raised = await owner.call('POST', `/projects/${c.projectId}/yield`, { nodeId: c.dam.id, scenarioId: sid, kind: 'firm' });
		expect([base.status, raised.status]).toEqual([202, 202]);
		await tick();
		const b = (await owner.call('GET', `/projects/${c.projectId}/yield?runId=${c.runId}`)).body.results[0];
		const s = (await owner.call('GET', `/projects/${c.projectId}/yield?scenarioId=${sid}`)).body.results[0];
		expect(s).toMatchObject({ scenarioId: sid, runId: null });
		expect(s.points.point.capacityM3).toBe(200_000);
		expect(s.points.point.yieldM3Day).toBeGreaterThan(b.points.point.yieldM3Day);
		// Each records the allocation mode it ran with (221, #523 G1c): here compare only.
		const modes = await asOwner('SELECT id, allocation_mode FROM yield_result WHERE id = ANY($1::uuid[])', [[b.id, s.id]]);
		expect(modes.map((m) => (m as { allocation_mode: string }).allocation_mode)).toEqual(['none', 'none']);
	});

	it('records the allocation mode the scenario ran with (221, #523 G1c): cap, kept when the op is later dropped', async () => {
		const owner = await signUp('YieldMode');
		const c = await catchment(owner);
		const at = `/projects/${c.projectId}`;
		const made = await owner.call('POST', `${at}/scenarios`, {
			name: 'Capped',
			baseRunId: c.runId,
			ops: [{ op: 'settings.set', path: 'allocationMode', value: 'cap' }]
		});
		expect(made.status, JSON.stringify(made.body)).toBe(201);
		const sid = made.body.scenario.id as string;
		const res = await owner.call('POST', `${at}/yield`, { nodeId: c.dam.id, scenarioId: sid, kind: 'firm' });
		expect(res.status, JSON.stringify(res.body)).toBe(202);
		await tick();
		expect(await job(res.body.jobId)).toMatchObject({ status: 'done', last_error: null });
		const read = async () => (await asOwner('SELECT allocation_mode FROM yield_result WHERE scenario_id = $1', [sid])) as { allocation_mode: string }[];
		expect(await read()).toEqual([{ allocation_mode: 'cap' }]);
		// The scenario dropping its op later doesn't rewrite what the yield ran with.
		expect((await owner.call('PATCH', `${at}/scenarios/${sid}`, { ops: [] })).status).toBe(200);
		expect(await read()).toEqual([{ allocation_mode: 'cap' }]);
	});

	it('at most 2 queued or running yield jobs per user (429 for a third, never for a repeat)', async () => {
		const owner = await signUp('YieldLimit');
		const c = await catchment(owner);
		const post = (assurance: number) => owner.call('POST', `/projects/${c.projectId}/yield`, { nodeId: c.dam.id, runId: c.runId, kind: 'firm', params: { assurance } });
		expect((await post(1)).status).toBe(202);
		expect((await post(0.9)).status).toBe(202);
		const third = await post(0.8);
		expect(third.status).toBe(429);
		expect(third.body.error).toMatch(/already have 2 yield calculations/);
		expect((await post(0.9)).status).toBe(200);
		await tick();
		expect((await post(0.8)).status).toBe(202);
		await tick();
	});

	it('the job fails closed when its user is no longer an editor', async () => {
		const owner = await signUp('YieldDemoteOwner');
		const ed = await signUp('YieldDemoted');
		const c = await catchment(owner);
		await member(owner, c.projectId, ed, 'editor');
		const res = await ed.call('POST', `/projects/${c.projectId}/yield`, { nodeId: c.dam.id, runId: c.runId, kind: 'firm' });
		expect(res.status).toBe(202);
		expect((await owner.call('PATCH', `/projects/${c.projectId}/members/${ed.id}`, { role: 'viewer' })).status).toBe(200);
		await tick();
		expect(await job(res.body.jobId)).toMatchObject({ status: 'dead', last_error: 'the user who queued this job no longer has the editor role on the project' });
		expect((await owner.call('GET', `/projects/${c.projectId}/yield?runId=${c.runId}`)).body.results).toEqual([]);
	});
});

/**
 * A proposed dam with no crops of its own (Hilltop, no dam in the base: capacity `cap`) draining to a farm with
 * crops (Riverside, no dam), then the outlet, and a user with no land: the operator's case, 2026-11-09.
 */
async function proposedDam(owner: User, cap = 0) {
	const projectId = (await owner.call('POST', '/projects', { name: 'Proposed dam' })).body.project.id as string;
	const outlet = node('Outlet', null);
	// The model's order is the units' sortOrder (then name): Riverside, Hilltop, Bare.
	const farm = node('Riverside', outlet.id, { sortOrder: 1, damCapacityM3: 0 });
	const dam = node('Hilltop', farm.id, { sortOrder: 2, pctRunoffToDam: 1, damCapacityM3: cap, damInitialPct: 0, damMinPct: 0 });
	const bare = node('Bare', outlet.id, { sortOrder: 3 });
	const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.8) };
	const model = { nodes: [outlet, farm, dam, bare], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 10_000 }], transfers: [] };
	expect((await owner.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
	expect((await owner.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(150) } })).status).toBe(200);
	const rain = Array.from({ length: 90 }, (_, i) => (i % 7 === 0 ? 20 : 0));
	expect((await owner.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: rain })).status).toBe(200);
	const run = await owner.call('POST', `/projects/${projectId}/runs`, { label: 'base' });
	expect(run.status, JSON.stringify(run.body)).toBe(201);
	return { projectId, outlet, farm, dam, bare, runId: run.body.run.id as string };
}

describe("another unit's irrigation demand shapes the draft (patternNodeId, engine 1.117.0)", () => {
	it('GET …/yield/options lists the units with whether each has demand; the job stores the shape and its unit’s name', async () => {
		const owner = await signUp('YieldShape');
		const c = await proposedDam(owner, 20_000);
		const opts = await owner.call('GET', `/projects/${c.projectId}/yield/options?nodeId=${c.dam.id}&runId=${c.runId}`);
		expect(opts.status, JSON.stringify(opts.body)).toBe(200);
		expect(opts.body).toEqual({
			damCapacityM3: 20_000,
			inflow: { runoffToDam: 1, upstreamToDam: 0, upstreamUnits: 0, riverToDam: false, transfersIn: 0, receives: true },
			units: [
				{ nodeId: c.farm.id, name: 'Riverside', demand: true },
				{ nodeId: c.dam.id, name: 'Hilltop', demand: false },
				{ nodeId: c.bare.id, name: 'Bare', demand: false }
			]
		});
		// A viewer reads them too (they preview a yield); an outsider gets 404.
		const viewer = await signUp('YieldShapeViewer');
		await member(owner, c.projectId, viewer, 'viewer');
		expect((await viewer.call('GET', `/projects/${c.projectId}/yield/options?nodeId=${c.dam.id}&runId=${c.runId}`)).status).toBe(200);
		expect((await (await signUp('YieldShapeOut')).call('GET', `/projects/${c.projectId}/yield/options?nodeId=${c.dam.id}&runId=${c.runId}`)).status).toBe(404);

		const res = await owner.call('POST', `/projects/${c.projectId}/yield`, { nodeId: c.dam.id, runId: c.runId, kind: 'firm', params: { pattern: 'demand', patternNodeId: c.farm.id } });
		expect(res.status, JSON.stringify(res.body)).toBe(202);
		await tick();
		expect(await job(res.body.jobId)).toMatchObject({ status: 'done', last_error: null });
		const [r] = (await owner.call('GET', `/projects/${c.projectId}/yield?jobId=${res.body.jobId}`)).body.results;
		expect(r.params).toEqual({ pattern: 'demand', patternNodeId: c.farm.id, patternNodeName: 'Riverside', assurance: 1, tolerance: 0.001, points: 11 });
		expect(r.points.point.yieldM3Day).toBeGreaterThan(0);
		// The dam's own id is the same request as none: its own (here empty) demand, which the job refuses.
		const own = await owner.call('POST', `/projects/${c.projectId}/yield`, { nodeId: c.dam.id, runId: c.runId, kind: 'firm', params: { pattern: 'demand', patternNodeId: c.dam.id } });
		expect(own.status).toBe(202);
		expect((await asOwner('SELECT payload FROM job WHERE id = $1', [own.body.jobId]))[0].payload.params).not.toHaveProperty('patternNodeId');
		await tick();
		expect((await job(own.body.jobId)).last_error).toMatch(/no irrigation demand/);
	});

	it('refuses a gauge, an unknown id, a unit with no demand and a non-demand pattern with 400, never DB text', async () => {
		const owner = await signUp('YieldShapeBad');
		const c = await proposedDam(owner, 20_000);
		const post = (params: Record<string, unknown>) => owner.call('POST', `/projects/${c.projectId}/yield`, { nodeId: c.dam.id, runId: c.runId, kind: 'firm', params });
		for (const id of [c.outlet.id, crypto.randomUUID()]) {
			expect((await post({ pattern: 'demand', patternNodeId: id })).body).toEqual({
				error: 'the unit chosen to shape the draft is not a hydrological unit of this run or scenario',
				code: 'yield_pattern_unit'
			});
		}
		const none = await post({ pattern: 'demand', patternNodeId: c.bare.id });
		expect(none.status).toBe(400);
		expect(none.body.code).toBe('yield_pattern_unit');
		expect(none.body.error).toMatch(/has no irrigation demand/);
		expect((await post({ pattern: 'constant', patternNodeId: c.farm.id })).status).toBe(400);
		expect((await asOwner(`SELECT count(*)::int AS n FROM job WHERE project_id = $1 AND kind = 'yield'`, [c.projectId]))[0].n).toBe(0);
		// Positive control: the farm with crops.
		expect((await post({ pattern: 'demand', patternNodeId: c.farm.id })).status).toBe(202);
	});
});

describe('a unit with no dam (capacity 0): no firm yield, a sizing curve to an entered largest capacity', () => {
	it('refuses the firm yield and an unbounded curve with 400 yield_no_dam; a curve to 300 000 m³ runs from 0', async () => {
		const owner = await signUp('YieldNoDam');
		const c = await proposedDam(owner, 0);
		const post = (kind: string, params: Record<string, unknown> = {}) => owner.call('POST', `/projects/${c.projectId}/yield`, { nodeId: c.dam.id, runId: c.runId, kind, params });
		const firm = await post('firm');
		expect(firm.status).toBe(400);
		expect(firm.body.code).toBe('yield_no_dam');
		expect(firm.body.error).toMatch(/^this hydrological unit has no dam in this run or scenario \(capacity 0 m³\)/);
		expect((await post('curve')).body.code).toBe('yield_no_dam');
		expect((await post('firm', { maxCapacityM3: 300_000 })).status).toBe(400);
		expect((await asOwner(`SELECT count(*)::int AS n FROM job WHERE project_id = $1 AND kind = 'yield'`, [c.projectId]))[0].n).toBe(0);
		expect((await owner.call('GET', `/projects/${c.projectId}/yield/options?nodeId=${c.dam.id}&runId=${c.runId}`)).body.damCapacityM3).toBe(0);

		const curve = await post('curve', { maxCapacityM3: 300_000, pattern: 'demand', patternNodeId: c.farm.id });
		expect(curve.status, JSON.stringify(curve.body)).toBe(202);
		await tick();
		expect(await job(curve.body.jobId)).toMatchObject({ status: 'done', last_error: null });
		const [r] = (await owner.call('GET', `/projects/${c.projectId}/yield?jobId=${curve.body.jobId}`)).body.results;
		expect(r.params.maxCapacityM3).toBe(300_000);
		expect(r.points.baseCapacityM3).toBe(0);
		expect(r.points.points.map((p: { capacityM3: number }) => p.capacityM3)).toEqual(Array.from({ length: 11 }, (_, k) => k * 30_000));
		expect(r.points.points.at(-1).yieldM3Day).toBeGreaterThan(r.points.points[0].yieldM3Day);
	});
});

describe('a dam that receives no water (the hydrologist, 2026-11-09): refused, then worked out once the scenario routes water in', () => {
	it('400 yield_no_inflow on a scenario that adds capacity only; positive once its runoff goes to the dam; results record the ops', async () => {
		const owner = await signUp('YieldNoInflow');
		const c = await proposedDam(owner, 0);
		// The unit as it was in the base: no dam and nothing routed into one.
		const routedNothing = await owner.call('POST', `/projects/${c.projectId}/scenarios`, {
			name: 'Hilltop Dam',
			baseRunId: c.runId,
			ops: [
				{ op: 'node.set', nodeId: c.dam.id, field: 'pctRunoffToDam', value: 0 },
				{ op: 'node.set', nodeId: c.dam.id, field: 'damCapacityM3', value: 80_000 }
			]
		});
		expect(routedNothing.status, JSON.stringify(routedNothing.body)).toBe(201);
		const sid = routedNothing.body.scenario.id as string;
		const post = (kind: string, params: Record<string, unknown> = {}) => owner.call('POST', `/projects/${c.projectId}/yield`, { nodeId: c.dam.id, scenarioId: sid, kind, params });
		const opts = await owner.call('GET', `/projects/${c.projectId}/yield/options?nodeId=${c.dam.id}&scenarioId=${sid}`);
		expect(opts.body).toMatchObject({ damCapacityM3: 80_000, inflow: { runoffToDam: 0, upstreamToDam: 0, riverToDam: false, transfersIn: 0, receives: false } });
		for (const r of [await post('firm'), await post('curve'), await post('curve', { maxCapacityM3: 200_000 })]) {
			expect(r.status).toBe(400);
			expect(r.body.code).toBe('yield_no_inflow');
			expect(r.body.error).toMatch(/^this hydrological unit's dam receives no water in this run or scenario/);
		}
		expect((await asOwner(`SELECT count(*)::int AS n FROM job WHERE project_id = $1 AND kind = 'yield'`, [c.projectId]))[0].n).toBe(0);

		// Route its runoff into the dam: the yield is worked out, and above 0.
		const before = (await owner.call('GET', `/projects/${c.projectId}/scenarios/${sid}`)).body.scenario;
		const routed = await owner.call('PATCH', `/projects/${c.projectId}/scenarios/${sid}`, {
			ops: [
				{ op: 'node.set', nodeId: c.dam.id, field: 'pctRunoffToDam', value: 1 },
				{ op: 'node.set', nodeId: c.dam.id, field: 'damCapacityM3', value: 80_000 }
			]
		});
		expect(routed.status, JSON.stringify(routed.body)).toBe(200);
		const after = routed.body.scenario;
		expect(after.opsSha256).not.toBe(before.opsSha256);
		const ok = await post('firm');
		expect(ok.status, JSON.stringify(ok.body)).toBe(202);
		await tick();
		expect(await job(ok.body.jobId)).toMatchObject({ status: 'done', last_error: null });
		const [r] = (await owner.call('GET', `/projects/${c.projectId}/yield?jobId=${ok.body.jobId}`)).body.results;
		expect(r.points.point.yieldM3Day).toBeGreaterThan(0);
		// The changes it ran on, for the panel's "worked out before the scenario's latest changes".
		expect(r.opsSha256).toBe(after.opsSha256);
		// A yield on a run records none (a run's input never changes).
		const c2 = await proposedDam(owner, 20_000);
		const runYield = await owner.call('POST', `/projects/${c2.projectId}/yield`, { nodeId: c2.dam.id, runId: c2.runId, kind: 'firm' });
		await tick();
		expect((await owner.call('GET', `/projects/${c2.projectId}/yield?jobId=${runYield.body.jobId}`)).body.results[0].opsSha256).toBeNull();
	});
});

describe('POST /projects/:id/yield/:jobId/cancel', () => {
	it('kills a waiting job at once; a viewer who didn’t queue it gets 404', async () => {
		const owner = await signUp('YieldCancel');
		const viewer = await signUp('YieldCancelViewer');
		const c = await catchment(owner);
		await member(owner, c.projectId, viewer, 'viewer');
		const jobId = (await owner.call('POST', `/projects/${c.projectId}/yield`, { nodeId: c.dam.id, runId: c.runId, kind: 'curve' })).body.jobId;
		expect((await viewer.call('POST', `/projects/${c.projectId}/yield/${jobId}/cancel`)).status).toBe(404);
		expect((await job(jobId)).status).toBe('queued');
		const res = await owner.call('POST', `/projects/${c.projectId}/yield/${jobId}/cancel`);
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ status: 'dead', cancelled: true });
		expect(await job(jobId)).toMatchObject({ status: 'dead', last_error: 'cancelled' });
		// Again: already dead, so this call changed nothing (285_cancel_job_outcome).
		expect((await owner.call('POST', `/projects/${c.projectId}/yield/${jobId}/cancel`)).body).toEqual({ status: 'dead', cancelled: false });
		await tick();
		expect((await owner.call('GET', `/projects/${c.projectId}/yield?runId=${c.runId}`)).body.results).toEqual([]);
		expect((await owner.call('POST', `/projects/${c.projectId}/yield/${crypto.randomUUID()}/cancel`)).status).toBe(404);
	});

	it('flags a running job, and its next progress report answers false', async () => {
		const owner = await signUp('YieldCancelRunning');
		const c = await catchment(owner);
		const jobId = (await owner.call('POST', `/projects/${c.projectId}/yield`, { nodeId: c.dam.id, runId: c.runId, kind: 'curve' })).body.jobId;
		// Claim it as a worker would, without running it.
		const [claimed] = (await asOwner(
			`UPDATE job SET status = 'running', attempts = 1, locked_until = now() + interval '1 minute', lease_token = gen_random_uuid(), started_at = now()
			 WHERE id = $1 RETURNING lease_token`,
			[jobId]
		)) as [{ lease_token: string }];
		const go = async () => ((await asOwner('SELECT app_job_progress($1, $2, 40) AS go', [jobId, claimed.lease_token])) as [{ go: boolean }])[0].go;
		expect(await go()).toBe(true);
		expect((await owner.call('POST', `/projects/${c.projectId}/yield/${jobId}/cancel`)).body).toEqual({ status: 'running', cancelled: true });
		expect(await go()).toBe(false);
		// Again: already flagged, so this call changed nothing.
		expect((await owner.call('POST', `/projects/${c.projectId}/yield/${jobId}/cancel`)).body).toEqual({ status: 'running', cancelled: false });
		await asOwner(`UPDATE job SET status = 'dead', finished_at = now(), locked_until = NULL, lease_token = NULL WHERE id = $1`, [jobId]);
	});
});

describe('GET /projects/:id/yield/jobs', () => {
	it("lists a dam's pending yield jobs with their target to any viewer; another project's member sees nothing", async () => {
		const owner = await signUp('YieldJobsOwner');
		const viewer = await signUp('YieldJobsViewer');
		const other = await signUp('YieldJobsOther');
		const c = await catchment(owner);
		await catchment(other, 'Other'); // a member of a project, just not this one
		await member(owner, c.projectId, viewer, 'viewer');
		const jobId = (await owner.call('POST', `/projects/${c.projectId}/yield`, { nodeId: c.dam.id, runId: c.runId, kind: 'curve', params: { assurance: 0.9 } })).body.jobId;

		// Positive control: a viewer who didn't queue it sees it, with what it is for.
		const seen = await viewer.call('GET', `/projects/${c.projectId}/yield/jobs?nodeId=${c.dam.id}&runId=${c.runId}`);
		expect(seen.status).toBe(200);
		expect(seen.body.jobs).toHaveLength(1);
		expect(seen.body.jobs[0]).toMatchObject({
			id: jobId,
			kind: 'yield',
			status: 'queued',
			target: { nodeId: c.dam.id, runId: c.runId, scenarioId: null, kind: 'curve', params: { assurance: 0.9, pattern: 'constant' } }
		});
		expect(seen.body.jobs[0]).not.toHaveProperty('payload');
		// Running, with its progress.
		const [claimed] = (await asOwner(
			`UPDATE job SET status = 'running', attempts = 1, locked_until = now() + interval '1 minute', lease_token = gen_random_uuid(), started_at = now()
			 WHERE id = $1 RETURNING lease_token`,
			[jobId]
		)) as [{ lease_token: string }];
		await asOwner('SELECT app_job_progress($1, $2, 40)', [jobId, claimed.lease_token]);
		expect((await viewer.call('GET', `/projects/${c.projectId}/yield/jobs?nodeId=${c.dam.id}`)).body.jobs[0]).toMatchObject({ id: jobId, status: 'running', progress: 40 });

		// Another dam, another run, a scenario: not this one's.
		expect((await owner.call('GET', `/projects/${c.projectId}/yield/jobs?nodeId=${c.outlet.id}`)).body.jobs).toEqual([]);
		expect((await owner.call('GET', `/projects/${c.projectId}/yield/jobs?nodeId=${c.dam.id}&runId=${crypto.randomUUID()}`)).body.jobs).toEqual([]);
		expect((await owner.call('GET', `/projects/${c.projectId}/yield/jobs?nodeId=${c.dam.id}&scenarioId=${crypto.randomUUID()}`)).body.jobs).toEqual([]);

		// Negative: another project's member gets 404, and RLS hides the row from them.
		expect((await other.call('GET', `/projects/${c.projectId}/yield/jobs?nodeId=${c.dam.id}`)).status).toBe(404);
		expect((await withUser(other.id, (db) => db.query('SELECT id FROM job WHERE id = $1', [jobId]))).rows).toEqual([]);

		// Bad queries.
		expect((await owner.call('GET', `/projects/${c.projectId}/yield/jobs`)).status).toBe(400);
		expect((await owner.call('GET', `/projects/${c.projectId}/yield/jobs?nodeId=x`)).status).toBe(400);
		expect((await owner.call('GET', `/projects/${c.projectId}/yield/jobs?nodeId=${c.dam.id}&runId=${c.runId}&scenarioId=${crypto.randomUUID()}`)).status).toBe(400);

		// Finished jobs drop off the list.
		await asOwner(`UPDATE job SET status = 'dead', finished_at = now(), locked_until = NULL, lease_token = NULL WHERE id = $1`, [jobId]);
		expect((await viewer.call('GET', `/projects/${c.projectId}/yield/jobs?nodeId=${c.dam.id}`)).body.jobs).toEqual([]);
	});
});

describe('yield_result RLS', () => {
	it('a viewer reads results but may not queue or write one; an outsider sees nothing', async () => {
		const owner = await signUp('YieldRlsOwner');
		const viewer = await signUp('YieldRlsViewer');
		const outsider = await signUp('YieldRlsOutsider');
		const c = await catchment(owner);
		await member(owner, c.projectId, viewer, 'viewer');
		expect((await owner.call('POST', `/projects/${c.projectId}/yield`, { nodeId: c.dam.id, runId: c.runId, kind: 'firm' })).status).toBe(202);
		await tick();

		// Positive control: the viewer sees the owner's result.
		const seen = await viewer.call('GET', `/projects/${c.projectId}/yield?runId=${c.runId}`);
		expect(seen.status).toBe(200);
		expect(seen.body.results).toHaveLength(1);
		expect((await withUser(viewer.id, (db) => db.query('SELECT id FROM yield_result WHERE project_id = $1', [c.projectId]))).rows).toHaveLength(1);

		expect((await viewer.call('POST', `/projects/${c.projectId}/yield`, { nodeId: c.dam.id, runId: c.runId, kind: 'firm' })).status).toBe(403);
		await expect(
			withUser(viewer.id, (db) =>
				db.query(`INSERT INTO yield_result (project_id, run_id, node_id, kind, params, points, engine_version) VALUES ($1, $2, $3, 'firm', '{}', '{}', 'x')`, [c.projectId, c.runId, c.dam.id])
			)
		).rejects.toMatchObject({ code: '42501' });

		expect((await outsider.call('GET', `/projects/${c.projectId}/yield?runId=${c.runId}`)).status).toBe(404);
		expect((await withUser(outsider.id, (db) => db.query('SELECT id FROM yield_result WHERE project_id = $1', [c.projectId]))).rows).toEqual([]);
	});

	it('a result names a run of its own project only', async () => {
		const owner = await signUp('YieldCross');
		const a = await catchment(owner, 'A');
		const b = await catchment(owner, 'B');
		await expect(
			withUser(owner.id, (db) =>
				db.query(`INSERT INTO yield_result (project_id, run_id, node_id, kind, params, points, engine_version) VALUES ($1, $2, $3, 'firm', '{}', '{}', 'x')`, [a.projectId, b.runId, a.dam.id])
			)
		).rejects.toMatchObject({ code: '23503' });
	});

	it('progress is written only by the lease holder of a running job', async () => {
		const owner = await signUp('YieldProgress');
		const c = await catchment(owner);
		const jobId = (await owner.call('POST', `/projects/${c.projectId}/yield`, { nodeId: c.dam.id, runId: c.runId, kind: 'firm' })).body.jobId;
		const [{ ok }] = (await asOwner('SELECT app_job_progress($1, gen_random_uuid(), 50) AS ok', [jobId])) as [{ ok: boolean }];
		expect(ok).toBe(false);
		expect((await job(jobId)).progress).toBeNull();
		// An enqueue can't forge one.
		await expect(
			withUser(owner.id, (db) => db.query(`INSERT INTO job (project_id, kind, progress, acting_user_id) VALUES ($1, 'rerun', 70, $2) RETURNING progress`, [c.projectId, owner.id]))
		).resolves.toMatchObject({ rows: [{ progress: null }] });
		await tick();
	});
});
