// Start and Divide on a catchment too large for the request (#646 item 3 and
// the hydrologist's review F10, F11; 272_plan_request, start.ts, divide.ts,
// planRequests.ts, jobs/handlers/delineate-plan.ts), end to end against
// Postgres and the committed synthetic DEM. Its valley fits the request's
// smallest window, so these tests narrow the windows (delineationLimits), as
// requests.db.test.ts does for a click:
//  - F10: beside the units' boundaries, an undrawn headwater drains into the
//    unit below it (the drains-into proposed and ticked), every area reaches
//    the outflow once, and the areas add up to the boundary; without a DEM
//    the rest drains into the outflow, saying so;
//  - F11: a Start too large to route answers at once (201) with the plan a
//    server without a DEM would make (each unit its boundary's area, no
//    order, a warning saying what wasn't checked), never a 422;
//  - the worker: that Start also queues a plan request, whose job proposes
//    the routed plan in place of the quick one while it is open, and is
//    superseded (storing nothing) once the quick one was applied; at the
//    worker's own cap it records the refusal and the quick plan stands; a
//    unit's boundary deleted before the job runs is `map_changed`; a Divide
//    too large is 202 with its request, and the job proposes the division;
//  - a plan request is never a click's: each GET shows only its own kind;
//    a viewer reads one, a stranger gets 404.
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { runTick } from '../jobs/runner.js';
import { fixtureLonLat, OUTLET_CELL, valleyUnitRing } from './fixture.js';
import { delineationLimits } from './requests.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let editor: User;
let viewer: User;
let stranger: User;
const FIXTURE = fileURLToPath(new URL('../../fixtures/dem/synthetic-dem.pmtiles', import.meta.url));
const before = { dem: process.env.DEM_URL, limits: { ...delineationLimits } };
const pos = (x: number, y: number) => fixtureLonLat(x + 0.5, y + 0.5);
const valleyUnit = (from: number, to: number) => ({ type: 'Polygon', coordinates: [valleyUnitRing(from, to)] });
const projects: string[] = [];
/** Only this file's projects' jobs. */
const tick = () => runTick({ feeds: false, reports: false, alerts: false, projectIds: projects });

async function newProject(name: string) {
	const id = (await owner.call('POST', '/projects', { name })).body.project.id as string;
	for (const [u, role] of [
		[editor, 'editor'],
		[viewer, 'viewer']
	] as const)
		expect((await owner.call('POST', `/projects/${id}/members`, { email: u.email, role })).status).toBe(201);
	projects.push(id);
	return { id, at: (p: string) => `/projects/${id}${p}` };
}
async function feature(at: (p: string) => string, body: Record<string, unknown>): Promise<string> {
	const r = await owner.call('POST', at('/map/features'), body);
	expect(r.status, JSON.stringify(r.body)).toBe(201);
	return r.body.feature.id as string;
}
/** A valley with its outlet gauge, and two units drawn as their boundaries: Lower at the outlet, Middle above it; the headwater above row 200 is nobody's. */
async function valley(name: string) {
	const p = await newProject(name);
	const [lon, lat] = pos(OUTLET_CELL.x, OUTLET_CELL.y);
	const gauge = await feature(p.at, { kind: 'gauge', name: 'Valley weir', lon, lat });
	const lower = await feature(p.at, { kind: 'other', name: 'Lower', geometry: valleyUnit(300, 400) });
	const middle = await feature(p.at, { kind: 'other', name: 'Middle', geometry: valleyUnit(200, 300) });
	const body = { outletFeatureId: gauge, points: [{ featureId: lower, role: 'unit' }, { featureId: middle, role: 'unit' }] };
	return { ...p, gauge, lower, middle, body };
}
const requestRow = async (rid: string) => (await asOwner('SELECT status, plan_kind, from_window, fallback_proposal_id, plan_proposal_id, refusal_code, refusal FROM delineation_request WHERE id = $1', [rid]))[0]!;

beforeAll(async () => {
	[owner, editor, viewer, stranger] = (await Promise.all(['Powner', 'Peditor', 'Pviewer', 'Pstranger'].map((n) => signUp(n)))) as [User, User, User, User];
	process.env.DEM_URL = FIXTURE;
}, 60_000);

afterEach(async () => {
	Object.assign(delineationLimits, before.limits);
	process.env.DEM_URL = FIXTURE;
	await asOwner(`UPDATE job SET status = 'dead', finished_at = now(), last_error = 'test over' WHERE project_id = ANY($1) AND status IN ('queued', 'failed')`, [projects]);
	await asOwner(`UPDATE delineation_request SET status = 'superseded', finished_at = now() WHERE project_id = ANY($1) AND status = 'queued'`, [projects]);
});

afterAll(() => {
	if (before.dem === undefined) delete process.env.DEM_URL;
	else process.env.DEM_URL = before.dem;
});

describe('the rest of the catchment drains where its flow path meets a unit (F10)', () => {
	it('drains an undrawn headwater into the unit below it, and every area reaches the outflow once', async () => {
		const v = await valley('Rest drains, DEM');
		const r = await editor.call('POST', v.at('/map/start'), v.body);
		expect(r.status, JSON.stringify(r.body)).toBe(201);
		expect(r.body.request).toBeNull();
		const { plan, methodVersion } = r.body.proposal;
		expect(methodVersion).toBe('start-17');
		expect(plan.units.map((u: { key: string; drainsInto: string | null }) => [u.key, u.drainsInto])).toEqual([
			[v.middle, v.lower],
			[v.lower, null]
		]);
		// The headwater is the rest: proposed to drain into Middle, the first unit its water meets, never straight to the outflow.
		expect(plan.rest).toMatchObject({ drainsInto: v.middle, drainsIntoProposed: true, geometry: null });
		const [{ b }] = await asOwner(`SELECT sum(area_m2) FILTER (WHERE id = ANY($1::uuid[])) AS b FROM map_feature WHERE project_id = $2`, [[v.lower, v.middle], v.id]);
		// The catchment above the outlet on the DEM less the units' boundaries.
		expect(plan.rest.areaM2).toBeCloseTo(plan.catchment.areaM2 - b, 0);
		expect(plan.rest.areaM2).toBeGreaterThan(0.2 * plan.catchment.areaM2);

		const ticks = plan.units.map((u: { key: string; name: string }) => ({ key: u.key, name: u.name, area: true, drainsInto: true, runoffToDam: false }));
		const url = v.at(`/map/start/${r.body.proposal.id}/apply`);
		// Its order can't be ticked without the rest in the model.
		expect((await editor.call('POST', url, { outletName: 'Valley weir', units: ticks, rest: { include: false, name: 'Headwater', area: false, drainsInto: true } })).status).toBe(400);
		const ok = await editor.call('POST', url, { outletName: 'Valley weir', units: ticks, rest: { include: true, name: 'Headwater', area: true, drainsInto: true } });
		expect(ok.status, JSON.stringify(ok.body)).toBe(200);
		const nodes = ok.body.model.nodes as { id: string; name: string; downstreamNodeId: string | null; areaKm2: number }[];
		const by = Object.fromEntries(nodes.map((n) => [n.name, n]));
		expect(by['Headwater']!.downstreamNodeId).toBe(by['Middle']!.id);
		expect(by['Middle']!.downstreamNodeId).toBe(by['Lower']!.id);
		expect(by['Lower']!.downstreamNodeId).toBe(by['Valley weir']!.id);
		// Mass balance over the tree: what drains through each node is its own area plus everything above it, and the outflow
		// receives the whole catchment exactly once. Lower's upstream inflow now carries the headwater as well as Middle.
		const through = (id: string): number => nodes.filter((n) => n.downstreamNodeId === id).reduce((a, n) => a + n.areaKm2 + through(n.id), 0);
		const total = nodes.reduce((a, n) => a + n.areaKm2, 0);
		expect(through(by['Valley weir']!.id)).toBeCloseTo(total, 9);
		expect(total).toBeCloseTo(plan.catchment.areaM2 / 1e6, 6);
		expect(through(by['Lower']!.id)).toBeCloseTo(by['Middle']!.areaKm2 + by['Headwater']!.areaKm2, 9);
		const [decision] = await asOwner('SELECT decision FROM start_proposal WHERE id = $1', [r.body.proposal.id]);
		expect(decision!.decision.rest).toMatchObject({ include: true, drainsInto: true });
	});

	it('without a DEM, keeps the rest draining into the outflow and says so; its order can’t be ticked', async () => {
		process.env.DEM_URL = '';
		const v = await valley('Rest drains, no DEM');
		await feature(v.at, { kind: 'catchment_boundary', name: 'Valley', geometry: valleyUnit(0, 400) });
		const r = await editor.call('POST', v.at('/map/start'), { points: v.body.points });
		expect(r.status, JSON.stringify(r.body)).toBe(201);
		const { plan } = r.body.proposal;
		expect(plan.rest.drainsIntoProposed).toBeUndefined();
		expect(plan.warnings).toContain('The rest of the catchment drains into the outflow gauge until you set the order on the Network: without routing, nothing says where it lies.');
		const ticks = plan.units.map((u: { key: string; name: string }) => ({ key: u.key, name: u.name, area: true, drainsInto: false, runoffToDam: false }));
		const bad = await editor.call('POST', v.at(`/map/start/${r.body.proposal.id}/apply`), { outletName: 'Weir', units: ticks, rest: { include: true, name: 'Rest', area: true, drainsInto: true } });
		expect(bad.status).toBe(400);
		expect(bad.body.error).toMatch(/no proposed order/);
	});
});

describe('a Start too large to route within the request (F11, #646 item 3)', () => {
	it('answers at once with the plan without the order, and the worker’s routed plan replaces it while it is open', async () => {
		const v = await valley('Start, too large');
		// The valley needs a window of about 300 cells: the request stops at 256, and the worker starts at 1 024.
		delineationLimits.requestWindows = [256];
		const r = await editor.call('POST', v.at('/map/start'), v.body);
		expect(r.status, JSON.stringify(r.body)).toBe(201);
		const quick = r.body.proposal;
		expect(quick).toMatchObject({ status: 'proposed', fromDem: false, dataset: null, methodVersion: 'start-17' });
		expect(quick.method).toMatch(/^Too large to route on the elevation model in a request/);
		expect(quick.plan.warnings[0]).toMatch(/too large to route on the elevation model within a request, so the order wasn’t proposed and no unit’s area was checked against it\. Each unit’s area is its own boundary’s/);
		// Each unit is its boundary, with its area; the order is the user's (the outflow gauge) until the routed plan comes.
		const areas = new Map((await asOwner('SELECT id, area_m2 FROM map_feature WHERE id = ANY($1::uuid[])', [[v.lower, v.middle]])).map((f) => [f.id, f.area_m2 as number]));
		expect(quick.plan.units.map((u: { key: string; areaM2: number; drainsIntoProposed: boolean }) => [u.key, u.areaM2, u.drainsIntoProposed])).toEqual([
			[v.lower, areas.get(v.lower), false],
			[v.middle, areas.get(v.middle), false]
		]);
		const q = r.body.request;
		expect(q).toMatchObject({ kind: 'start', status: 'queued', fallbackId: quick.id, proposal: null, refusal: null });
		expect(await requestRow(q.id)).toMatchObject({ plan_kind: 'start', from_window: 1024, fallback_proposal_id: quick.id });
		const [job] = await asOwner('SELECT j.kind, j.dedupe_key, j.payload FROM job j JOIN delineation_request r ON r.job_id = j.id WHERE r.id = $1', [q.id]);
		expect(job).toMatchObject({ kind: 'delineate', dedupe_key: `delineate:${editor.id}`, payload: { requestId: q.id } });
		// The Start sheet picks it up from the GET; Delineate's never does, nor its request route.
		expect((await viewer.call('GET', v.at('/map/start'))).body.request).toMatchObject({ id: q.id, status: 'queued' });
		expect((await viewer.call('GET', v.at('/map/delineation'))).body.request).toBeNull();
		expect((await viewer.call('GET', v.at(`/map/delineation/requests/${q.id}`))).status).toBe(404);
		expect((await stranger.call('GET', v.at(`/map/start/requests/${q.id}`))).status).toBe(404);

		await tick();
		const done = (await viewer.call('GET', v.at(`/map/start/requests/${q.id}`))).body.request;
		expect(done).toMatchObject({ kind: 'start', status: 'proposed', refusal: null, error: null });
		expect(done.proposal).toMatchObject({ status: 'proposed', fromDem: true, mode: 'start', createdBy: 'Peditor' });
		expect(done.proposal.plan.windowCells).toBe(1024);
		expect(done.proposal.plan.units.map((u: { key: string; drainsInto: string | null }) => [u.key, u.drainsInto])).toEqual([
			[v.middle, v.lower],
			[v.lower, null]
		]);
		expect(done.proposal.plan.rest).toMatchObject({ drainsInto: v.middle, drainsIntoProposed: true });
		expect((await asOwner('SELECT status FROM start_proposal WHERE id = $1', [quick.id]))[0]!.status).toBe('superseded');
		const state = (await viewer.call('GET', v.at('/map/start'))).body;
		expect(state.request).toBeNull();
		expect(state.proposals[0]).toMatchObject({ id: done.proposal.id, status: 'proposed' });
		const audit = await asOwner(`SELECT subject, actor_user_id FROM audit_event WHERE project_id = $1 AND kind = 'map.start_proposed' AND subject->>'proposalId' = $2`, [v.id, done.proposal.id]);
		expect(audit[0]).toMatchObject({ actor_user_id: editor.id, subject: { fromDem: true, background: true } });
	});

	it('gives way at once to a newer Start that fits the request: its job cancelled, no stale wait on reopening', async () => {
		const v = await valley('Start, too large, proposed again');
		delineationLimits.requestWindows = [256];
		const r = await editor.call('POST', v.at('/map/start'), v.body);
		expect(r.body.request).toMatchObject({ status: 'queued' });
		delineationLimits.requestWindows = before.limits.requestWindows;
		const again = await editor.call('POST', v.at('/map/start'), v.body);
		expect(again.status).toBe(201);
		expect(again.body.request).toBeNull();
		expect(await requestRow(r.body.request.id)).toMatchObject({ status: 'superseded' });
		const [job] = await asOwner('SELECT j.status FROM job j JOIN delineation_request r ON r.job_id = j.id WHERE r.id = $1', [r.body.request.id]);
		expect(job!.status).toBe('dead');
		expect((await viewer.call('GET', v.at('/map/start'))).body.request).toBeNull();
	});

	it('stores nothing once the quick plan was applied: the request is superseded', async () => {
		const v = await valley('Start, too large, applied first');
		delineationLimits.requestWindows = [256];
		const r = await editor.call('POST', v.at('/map/start'), v.body);
		expect(r.status).toBe(201);
		const quick = r.body.proposal;
		const ticks = quick.plan.units.map((u: { key: string; name: string }) => ({ key: u.key, name: u.name, area: true, drainsInto: false, runoffToDam: false }));
		expect((await editor.call('POST', v.at(`/map/start/${quick.id}/apply`), { outletName: 'Weir', units: ticks, rest: { include: false, name: 'Rest', area: false } })).status).toBe(200);
		const proposals = (await asOwner('SELECT count(*)::int AS n FROM start_proposal WHERE project_id = $1', [v.id]))[0]!.n;
		await tick();
		expect(await requestRow(r.body.request.id)).toMatchObject({ status: 'superseded', plan_proposal_id: null });
		expect((await asOwner('SELECT count(*)::int AS n FROM start_proposal WHERE project_id = $1', [v.id]))[0]!.n).toBe(proposals);
		expect((await asOwner('SELECT status FROM start_proposal WHERE id = $1', [quick.id]))[0]!.status).toBe('applied');
	});

	it('records the refusal at the worker’s own cap, the quick plan standing; with no larger window, nothing is queued', async () => {
		const v = await valley('Start, past the worker');
		delineationLimits.requestWindows = [128];
		delineationLimits.jobWindows = [128, 192];
		const r = await editor.call('POST', v.at('/map/start'), v.body);
		expect(r.status, JSON.stringify(r.body)).toBe(201);
		await tick();
		const done = (await editor.call('GET', v.at(`/map/start/requests/${r.body.request.id}`))).body.request;
		expect(done).toMatchObject({ status: 'refused', proposal: null, refusal: { reason: 'too_large' } });
		expect(done.refusal.message).toMatch(/can’t order or check the units here/);
		expect((await asOwner('SELECT status FROM start_proposal WHERE id = $1', [r.body.proposal.id]))[0]!.status).toBe('proposed');

		// The worker goes no further than the request: the quick plan alone, no request.
		delineationLimits.jobWindows = [128];
		const again = await editor.call('POST', v.at('/map/start'), v.body);
		expect(again.status).toBe(201);
		expect(again.body.request).toBeNull();
		expect(again.body.proposal.fromDem).toBe(false);
	});

	it('refuses `map_changed` when a unit’s boundary is gone before the job reads the map', async () => {
		const v = await valley('Start, map changed');
		delineationLimits.requestWindows = [256];
		const r = await editor.call('POST', v.at('/map/start'), v.body);
		expect(r.status).toBe(201);
		expect((await owner.call('DELETE', v.at(`/map/features/${v.middle}`))).status).toBe(204);
		await tick();
		expect(await requestRow(r.body.request.id)).toMatchObject({ status: 'refused', refusal_code: 'map_changed', refusal: expect.stringMatching(/not on this catchment’s map/) });
	});
});

describe('a Divide too large to route within the request (#646 item 3)', () => {
	it('is queued (202), and the worker proposes the division', async () => {
		const v = await valley('Divide, too large');
		process.env.DEM_URL = '';
		const s = await editor.call('POST', v.at('/map/start'), v.body);
		const ticks = s.body.proposal.plan.units.map((u: { key: string; name: string }) => ({ key: u.key, name: u.name, area: false, drainsInto: false, runoffToDam: false }));
		expect((await editor.call('POST', v.at(`/map/start/${s.body.proposal.id}/apply`), { outletName: 'Weir', units: ticks, rest: { include: false, name: 'Rest', area: false } })).status).toBe(200);
		process.env.DEM_URL = FIXTURE;
		const nodes = (await editor.call('GET', `/projects/${v.id}/model`)).body.nodes as { id: string; name: string }[];
		const nodeOf = (name: string) => nodes.find((n) => n.name === name)!.id;
		delineationLimits.requestWindows = [256];
		const body = { outletFeatureId: v.gauge, points: [{ featureId: v.lower, nodeId: nodeOf('Lower') }, { featureId: v.middle, nodeId: nodeOf('Middle') }] };
		const r = await editor.call('POST', v.at('/map/divide'), body);
		expect(r.status, JSON.stringify(r.body)).toBe(202);
		expect(r.body.request).toMatchObject({ kind: 'divide', status: 'queued', fallbackId: null });
		await tick();
		const done = (await viewer.call('GET', v.at(`/map/start/requests/${r.body.request.id}`))).body.request;
		expect(done).toMatchObject({ status: 'proposed', proposal: { mode: 'divide', status: 'proposed' } });
		expect(done.proposal.plan.windowCells).toBe(1024);
		expect(done.proposal.plan.units.map((u: { key: string; drainsInto: string | null }) => [u.key, u.drainsInto])).toEqual([
			[v.middle, v.lower],
			[v.lower, null]
		]);
		expect(done.proposal.plan.rest).toMatchObject({ drainsInto: v.middle, drainsIntoProposed: true });
	});
});

describe('RLS on a plan request (272)', () => {
	it('a viewer reads it but can’t change it; the editor who queued it can (positive control); a click and a plan never mix', async () => {
		const v = await valley('Plan request, RLS');
		delineationLimits.requestWindows = [256];
		const r = await editor.call('POST', v.at('/map/start'), v.body);
		const rid = r.body.request.id as string;
		const { withUser } = await import('../db/tx.js');
		expect((await withUser(viewer.id, (db) => db.query('SELECT id FROM delineation_request WHERE id = $1', [rid]))).rowCount).toBe(1);
		expect((await withUser(viewer.id, (db) => db.query(`UPDATE delineation_request SET status = 'superseded', finished_at = now() WHERE id = $1`, [rid]))).rowCount).toBe(0);
		expect((await withUser(stranger.id, (db) => db.query('SELECT id FROM delineation_request WHERE id = $1', [rid]))).rowCount).toBe(0);
		expect((await withUser(editor.id, (db) => db.query(`UPDATE delineation_request SET status = 'superseded', finished_at = now() WHERE id = $1`, [rid]))).rowCount).toBe(1);
		// A request is a click or a plan, never both nor neither.
		await expect(asOwner(`INSERT INTO delineation_request (project_id, click_kind, click_lon, click_lat, plan_kind, plan_body, from_window) VALUES ($1, 'outlet', 20.7, -33.4, 'start', '{}', 1024)`, [v.id])).rejects.toMatchObject({ code: '23514' });
		await expect(asOwner(`INSERT INTO delineation_request (project_id, from_window) VALUES ($1, 1024)`, [v.id])).rejects.toMatchObject({ code: '23514' });
		// The proposal links are same-project by construction (composite keys): another project's proposal is refused, this one's
		// (the positive control) taken; a link only with `proposed`.
		const other = await valley('Plan request, other project');
		process.env.DEM_URL = '';
		const theirs = (await editor.call('POST', other.at('/map/start'), other.body)).body.proposal.id as string;
		process.env.DEM_URL = FIXTURE;
		const insert = (pid: string) =>
			asOwner(`INSERT INTO delineation_request (project_id, plan_kind, plan_body, from_window, fallback_proposal_id) VALUES ($1, 'start', '{}', 1024, $2) RETURNING id`, [v.id, pid]);
		await expect(insert(theirs)).rejects.toMatchObject({ code: '23503' });
		const mine = (await insert(r.body.proposal.id))[0]!.id as string;
		await expect(asOwner(`UPDATE delineation_request SET plan_proposal_id = $2 WHERE id = $1`, [mine, r.body.proposal.id])).rejects.toMatchObject({ code: '23514' });
		// A finished request keeps its plan: the final trigger compares the plan's columns too.
		await expect(asOwner(`UPDATE delineation_request SET plan_body = '{"points": []}' WHERE id = $1`, [rid])).rejects.toMatchObject({ code: '23514' });
		await expect(asOwner(`UPDATE delineation_request SET plan_kind = 'divide' WHERE id = $1`, [rid])).rejects.toMatchObject({ code: '23514' });
		// A Divide has no fallback.
		await expect(asOwner(`INSERT INTO delineation_request (project_id, plan_kind, plan_body, from_window, fallback_proposal_id) VALUES ($1, 'divide', '{}', 1024, $2)`, [v.id, r.body.proposal.id])).rejects.toMatchObject({ code: '23514' });
	});
});
