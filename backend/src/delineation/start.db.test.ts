// Starting an empty model from the map (issue #326 C3; 178_start_proposal.sql,
// delineation/start.ts), end to end against Postgres and the committed
// synthetic DEM (backend/fixtures/dem/):
//  - without a DEM the points become units with no area, all draining into
//    the outflow gauge, and the rest of the catchment is the boundary;
//  - with one, a gauge at the outlet, a dam and an abstraction point up the
//    river give two units in order, their areas adding up to the catchment;
//    a boundary that came from Delineate lends its outlet;
//  - apply writes only the ticked values: the ticked areas as parcels
//    linked to their units (area "from the map"), the ticked order, runoff
//    to the dam; unticked, the area stays 0 and the unit drains into the
//    outflow gauge; one model revision; the points linked to their nodes;
//  - refused: a model with nodes (409, to propose and to apply), a decided
//    proposal (409), ticks that don't match the plan, two nodes of one name,
//    an area ticked that wasn't proposed (400); a viewer can't propose (403)
//    and a stranger gets 404.
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwner, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { DAM_CELL, fixtureLonLat, OUTLET_CELL } from './fixture.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let viewer: User;
let stranger: User;
const FIXTURE = fileURLToPath(new URL('../../fixtures/dem/synthetic-dem.pmtiles', import.meta.url));
const before = process.env.DEM_URL;
const pos = (x: number, y: number) => fixtureLonLat(x + 0.5, y + 0.5);
const SQUARE = [[[20.7, -33.5], [20.78, -33.5], [20.78, -33.42], [20.7, -33.42], [20.7, -33.5]]];

async function newProject(name: string): Promise<{ id: string; at: (p: string) => string }> {
	const id = (await owner.call('POST', '/projects', { name })).body.project.id as string;
	expect((await owner.call('POST', `/projects/${id}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
	return { id, at: (p: string) => `/projects/${id}${p}` };
}
async function feature(at: (p: string) => string, body: Record<string, unknown>): Promise<string> {
	const r = await owner.call('POST', at('/map/features'), body);
	expect(r.status, JSON.stringify(r.body)).toBe(201);
	return r.body.feature.id as string;
}

beforeAll(async () => {
	[owner, viewer, stranger] = (await Promise.all(['Sowner', 'Sviewer', 'Sstranger'].map((n) => signUp(n)))) as [User, User, User];
}, 60_000);

afterAll(() => {
	if (before === undefined) delete process.env.DEM_URL;
	else process.env.DEM_URL = before;
});

describe('without an elevation model', () => {
	it('proposes the points as units with no area, all draining into the outflow gauge; the rest is the boundary', async () => {
		process.env.DEM_URL = '';
		const p = await newProject('Start, no DEM');
		const boundary = await feature(p.at, { kind: 'catchment_boundary', name: 'Drawn', geometry: { type: 'Polygon', coordinates: SQUARE } });
		const dam = await feature(p.at, { kind: 'dam', name: 'Upper dam', lon: 20.74, lat: -33.45 });
		const pump = await feature(p.at, { kind: 'other', name: '', lon: 20.75, lat: -33.47 });
		// A gauge outside the boundary isn't in the catchment: dropped, saying so.
		const away = await feature(p.at, { kind: 'gauge', name: 'Far weir', lon: 20.9, lat: -33.47 });
		const get = await viewer.call('GET', p.at('/map/start'));
		expect(get.body).toMatchObject({ elevation: false, dataset: null, modelEmpty: true, proposals: [] });
		const r = await owner.call('POST', p.at('/map/start'), { points: [{ featureId: dam, role: 'dam' }, { featureId: pump, role: 'abstraction' }, { featureId: away, role: 'gauge' }] });
		expect(r.status, JSON.stringify(r.body)).toBe(201);
		const plan = r.body.proposal.plan;
		expect(plan.dropped).toEqual([{ featureId: away, name: 'Far weir', reason: 'is outside the catchment boundary' }]);
		expect(r.body.proposal).toMatchObject({ status: 'proposed', fromDem: false, dataset: null, methodVersion: 'start-5' });
		expect(plan.units.map((u: { name: string; areaM2: null; drainsInto: null; drainsIntoProposed: boolean }) => [u.name, u.areaM2, u.drainsInto, u.drainsIntoProposed])).toEqual([
			['Upper dam', null, null, false],
			['Abstraction unit 1', null, null, false]
		]);
		const [{ area_m2 }] = await asOwner('SELECT area_m2 FROM map_feature WHERE id = $1', [boundary]);
		expect(plan.rest.areaM2).toBeCloseTo(area_m2, 3);
		expect(plan.warnings[0]).toMatch(/no elevation model/);

		// An area or an order that wasn't proposed can't be ticked.
		const ticks = (over: Record<string, boolean> = {}) =>
			plan.units.map((u: { key: string; name: string }) => ({ key: u.key, name: u.name, area: false, drainsInto: false, runoffToDam: false, ...over }));
		const bad = await owner.call('POST', p.at(`/map/start/${r.body.proposal.id}/apply`), { outletName: 'Weir', units: ticks({ area: true }), rest: { include: true, name: 'Rest', area: true } });
		expect(bad.status).toBe(400);
		expect(bad.body.error).toMatch(/no proposed area/);

		const ok = await owner.call('POST', p.at(`/map/start/${r.body.proposal.id}/apply`), { outletName: 'Weir', units: ticks(), rest: { include: true, name: 'Rest', area: true } });
		expect(ok.status, JSON.stringify(ok.body)).toBe(200);
		const nodes = ok.body.model.nodes as { id: string; name: string; kind: string; downstreamNodeId: string | null; areaKm2: number }[];
		const weir = nodes.find((n) => n.name === 'Weir')!;
		expect(weir).toMatchObject({ kind: 'gauge', downstreamNodeId: null });
		expect(nodes.filter((n) => n.kind === 'farm').map((n) => [n.name, n.downstreamNodeId, n.areaKm2])).toEqual([
			['Upper dam', weir.id, 0],
			['Abstraction unit 1', weir.id, 0],
			['Rest', weir.id, area_m2 / 1e6]
		]);
		// The rest's area came from the boundary, saved as its parcel: "from the map".
		const [rest] = await asOwner(`SELECT n.area_source, f.kind, f.node_id = n.id AS linked FROM node n JOIN map_feature f ON f.id = n.area_feature_id WHERE n.project_id = $1 AND n.name = 'Rest'`, [p.id]);
		expect(rest).toEqual({ area_source: 'map', kind: 'farm_parcel', linked: true });
		// The points stand for their units now.
		const links = await asOwner(`SELECT f.name, n.name AS node FROM map_feature f JOIN node n ON n.id = f.node_id WHERE f.project_id = $1 AND f.kind IN ('dam', 'other') ORDER BY f.name`, [p.id]);
		expect(links).toEqual([
			{ name: '', node: 'Abstraction unit 1' },
			{ name: 'Upper dam', node: 'Upper dam' }
		]);
	});
});

describe('with the synthetic DEM', () => {
	let p: Awaited<ReturnType<typeof newProject>>;
	let gauge: string;
	let dam: string;
	let pump: string;

	beforeAll(async () => {
		process.env.DEM_URL = FIXTURE;
		p = await newProject('Start, DEM');
		gauge = await feature(p.at, { kind: 'gauge', name: 'Valley weir', lon: pos(OUTLET_CELL.x, OUTLET_CELL.y)[0], lat: pos(OUTLET_CELL.x, OUTLET_CELL.y)[1] });
		dam = await feature(p.at, { kind: 'dam', name: 'Valley dam', lon: pos(DAM_CELL.x, DAM_CELL.y + 1)[0], lat: pos(DAM_CELL.x, DAM_CELL.y + 1)[1] });
		pump = await feature(p.at, { kind: 'other', name: 'Top pump', lon: pos(DAM_CELL.x, DAM_CELL.y - 100)[0], lat: pos(DAM_CELL.x, DAM_CELL.y - 100)[1] });
	});

	it('proposes two units in order, upstream first, their areas and the rest adding up to the catchment', async () => {
		const get = await viewer.call('GET', p.at('/map/start'));
		expect(get.body).toMatchObject({ elevation: true, modelEmpty: true });
		// A viewer reads but can't propose; a stranger can't see it at all.
		const body = { outletFeatureId: gauge, points: [{ featureId: dam, role: 'dam' }, { featureId: pump, role: 'abstraction' }] };
		expect((await viewer.call('POST', p.at('/map/start'), body)).status).toBe(403);
		expect((await stranger.call('POST', p.at('/map/start'), body)).status).toBe(404);
		expect((await stranger.call('GET', p.at('/map/start'))).status).toBe(404);

		const r = await owner.call('POST', p.at('/map/start'), body);
		expect(r.status, JSON.stringify(r.body)).toBe(201);
		const { plan } = r.body.proposal;
		expect(r.body.proposal).toMatchObject({ fromDem: true, dataset: expect.stringMatching(/Synthetic DEM/), datasetFingerprint: expect.stringMatching(/^[0-9a-f]{16}$/) });
		expect(plan.outlet).toMatchObject({ featureId: gauge, name: 'Valley weir', foundIn: 'gauge' });
		expect(plan.units.map((u: { name: string }) => u.name)).toEqual(['Top pump', 'Valley dam']);
		const [top, mid] = plan.units;
		expect(top.drainsInto).toBe(dam);
		expect(mid.drainsInto).toBeNull();
		expect(top.geometry.type).toBe('Polygon');
		const sum = top.areaM2 + mid.areaM2 + plan.rest.areaM2;
		expect(Math.abs(sum / plan.catchment.areaM2 - 1)).toBeLessThan(0.02);
		expect(mid.totalAreaM2).toBeCloseTo(top.areaM2 + mid.areaM2, 0);
		// A second proposal supersedes the first.
		const again = await owner.call('POST', p.at('/map/start'), body);
		expect(again.status).toBe(201);
		const [first] = await asOwner('SELECT status FROM start_proposal WHERE id = $1', [r.body.proposal.id]);
		expect(first!.status).toBe('superseded');
	});

	it('applies only the ticked values, as one revision, and refuses a second apply', async () => {
		const open = (await viewer.call('GET', p.at('/map/start'))).body.proposals[0];
		expect(open.status).toBe('proposed');
		const [top, mid] = open.plan.units;
		const url = p.at(`/map/start/${open.id}/apply`);
		const units = [
			// The pump: its area ticked, its order not (so it drains into the outflow gauge).
			{ key: top.key, name: 'Top pump', area: true, drainsInto: false, runoffToDam: false },
			// The dam: its order and runoff to the dam ticked, its area not.
			{ key: mid.key, name: 'Valley dam', area: false, drainsInto: true, runoffToDam: true }
		];
		// Ticks that don't match the plan, and two nodes of one name, are refused.
		expect((await owner.call('POST', url, { outletName: 'Valley weir', units: units.slice(0, 1), rest: { include: false, name: 'Rest', area: false } })).status).toBe(400);
		const dup = await owner.call('POST', url, { outletName: 'Valley dam', units, rest: { include: false, name: 'Rest', area: false } });
		expect(dup.status).toBe(400);
		expect(dup.body.error).toMatch(/Two nodes would be called/);
		// runoffToDam is a dam unit's only.
		expect((await owner.call('POST', url, { outletName: 'Valley weir', units: [{ ...units[0], runoffToDam: true }, units[1]], rest: { include: false, name: 'Rest', area: false } })).status).toBe(400);

		const [{ rev }] = await asOwner('SELECT coalesce(max(id), 0) AS rev FROM model_revision WHERE project_id = $1', [p.id]);
		const ok = await owner.call('POST', url, { outletName: 'Valley weir', units, rest: { include: true, name: 'Rest of the valley', area: true } });
		expect(ok.status, JSON.stringify(ok.body)).toBe(200);
		const nodes = ok.body.model.nodes as { id: string; name: string; kind: string; downstreamNodeId: string | null; areaKm2: number; pctRunoffToDam: number }[];
		const by = Object.fromEntries(nodes.map((n) => [n.name, n]));
		expect(by['Valley weir']).toMatchObject({ kind: 'gauge', downstreamNodeId: null });
		expect(by['Top pump']).toMatchObject({ kind: 'farm', downstreamNodeId: by['Valley weir']!.id, pctRunoffToDam: 0 });
		expect(by['Top pump']!.areaKm2).toBeCloseTo(top.areaM2 / 1e6, 6);
		expect(by['Valley dam']).toMatchObject({ kind: 'farm', downstreamNodeId: by['Valley weir']!.id, areaKm2: 0, pctRunoffToDam: 1 });
		expect(by['Rest of the valley']!.areaKm2).toBeGreaterThan(0);
		const sources = await asOwner(
			`SELECT n.name, n.area_source, f.kind, f.node_id = n.id AS linked, f.properties ->> 'description' AS description
			 FROM node n LEFT JOIN map_feature f ON f.id = n.area_feature_id WHERE n.project_id = $1 ORDER BY n.sort_order`,
			[p.id]
		);
		expect(sources.map((s) => [s.name, s.area_source, s.kind])).toEqual([
			['Valley weir', 'typed', null],
			['Top pump', 'map', 'farm_parcel'],
			['Valley dam', 'typed', null],
			['Rest of the valley', 'map', 'farm_parcel']
		]);
		expect(sources[1]!.description).toMatch(/Sub-catchment delineated from Synthetic DEM.*start-5/);
		// The gauge stands for the outflow gauge; the dam for its unit.
		const links = await asOwner('SELECT f.id, f.node_id FROM map_feature f WHERE f.id = ANY($1::uuid[])', [[gauge, dam]]);
		expect(new Map(links.map((l) => [l.id, l.node_id]))).toEqual(new Map([[gauge, by['Valley weir']!.id], [dam, by['Valley dam']!.id]]));
		// One revision; the proposal is applied with the ticks and the nodes made.
		// (The project's first change also records the baseline before it.)
		const revs = await asOwner(`SELECT reason FROM model_revision WHERE project_id = $1 AND id > $2 AND source <> 'baseline'`, [p.id, rev]);
		expect(revs).toHaveLength(1);
		expect(revs[0]!.reason).toMatch(/^Started from the map: 4 nodes; 2 areas and 1 drains-into from Synthetic DEM/);
		expect(ok.body.proposal).toMatchObject({ status: 'applied', decidedBy: expect.any(String) });
		expect(ok.body.proposal.decision.units.map((u: { name: string; area: boolean; drainsInto: boolean }) => [u.name, u.area, u.drainsInto])).toEqual([
			['Top pump', true, false],
			['Valley dam', false, true]
		]);
		expect(ok.body.proposal.decision.revisionId).toEqual(expect.any(String));

		// Decided once; and a model with nodes is never started again.
		expect((await owner.call('POST', url, { outletName: 'X', units, rest: { include: false, name: 'R', area: false } })).status).toBe(409);
		const again = await owner.call('POST', p.at('/map/start'), { points: [] });
		expect(again.status).toBe(409);
		expect(again.body.error).toMatch(/nodes already/);
		expect((await viewer.call('GET', p.at('/map/start'))).body.modelEmpty).toBe(false);
	});

	it('refuses to apply once the model gained nodes since the proposal; a discarded proposal can’t be applied', async () => {
		const q = await newProject('Start, raced');
		const g = await feature(q.at, { kind: 'gauge', name: 'Weir', lon: pos(OUTLET_CELL.x, OUTLET_CELL.y)[0], lat: pos(OUTLET_CELL.x, OUTLET_CELL.y)[1] });
		const r = await owner.call('POST', q.at('/map/start'), { outletFeatureId: g, points: [] });
		expect(r.status, JSON.stringify(r.body)).toBe(201);
		const weir = node('Typed weir', null);
		expect((await owner.call('PUT', q.at('/model'), { nodes: [weir], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
		const apply = await owner.call('POST', q.at(`/map/start/${r.body.proposal.id}/apply`), { outletName: 'Weir', units: [], rest: { include: true, name: 'Rest', area: true } });
		expect(apply.status).toBe(409);
		expect(apply.body.error).toMatch(/nodes already/);
		// Nothing changed: the typed node is the model.
		expect((await owner.call('GET', q.at('/model'))).body.nodes.map((n: { name: string }) => n.name)).toEqual(['Typed weir']);
		expect((await owner.call('POST', q.at(`/map/start/${r.body.proposal.id}/discard`))).status).toBe(200);
		expect((await owner.call('POST', q.at(`/map/start/${r.body.proposal.id}/discard`))).status).toBe(409);
	});

	it('takes the outlet from a boundary that came from Delineate', async () => {
		const q = await newProject('Start, delineated');
		const [lon, lat] = pos(OUTLET_CELL.x, OUTLET_CELL.y);
		const d = await owner.call('POST', q.at('/map/delineation'), { lon, lat, from: 'outlet' });
		expect(d.status).toBe(201);
		expect((await owner.call('POST', q.at(`/map/delineation/${d.body.proposal.id}/accept`), { as: 'catchment_boundary' })).status).toBe(200);
		const r = await owner.call('POST', q.at('/map/start'), { points: [] });
		expect(r.status, JSON.stringify(r.body)).toBe(201);
		expect(r.body.proposal.plan.outlet).toMatchObject({ foundIn: 'delineation', featureId: null, name: 'Outflow gauge' });
		expect(r.body.proposal.plan.outlet.point).toEqual(d.body.proposal.outlet);
		expect(r.body.proposal.plan.warnings).toEqual([]);
		expect(Math.abs(r.body.proposal.plan.rest.areaM2 / d.body.proposal.areaM2 - 1)).toBeLessThan(0.02);
	});

	it('puts a gauge inside the catchment in the order as a gauge node, the dam above it draining into it', async () => {
		const q = await newProject('Start, gauge');
		const weir = await feature(q.at, { kind: 'gauge', name: 'Weir', lon: pos(OUTLET_CELL.x, OUTLET_CELL.y)[0], lat: pos(OUTLET_CELL.x, OUTLET_CELL.y)[1] });
		const d = await feature(q.at, { kind: 'dam', name: 'Dam', lon: pos(DAM_CELL.x, DAM_CELL.y + 1)[0], lat: pos(DAM_CELL.x, DAM_CELL.y + 1)[1] });
		const mid = await feature(q.at, { kind: 'gauge', name: 'Mid weir', lon: pos(DAM_CELL.x, DAM_CELL.y + 60)[0], lat: pos(DAM_CELL.x, DAM_CELL.y + 60)[1] });
		// Only a gauge point is a gauge node.
		const notGauge = await owner.call('POST', q.at('/map/start'), { outletFeatureId: weir, points: [{ featureId: d, role: 'gauge' }] });
		expect(notGauge.status).toBe(400);
		expect(notGauge.body.error).toMatch(/not a gauge point/);
		const r = await owner.call('POST', q.at('/map/start'), { outletFeatureId: weir, points: [{ featureId: d, role: 'dam' }, { featureId: mid, role: 'gauge' }] });
		expect(r.status, JSON.stringify(r.body)).toBe(201);
		const plan = r.body.proposal.plan;
		expect(plan.units.map((u: { name: string; role: string; drainsInto: string | null; areaM2: number | null }) => [u.name, u.role, u.drainsInto, u.areaM2 === null])).toEqual([
			['Dam', 'dam', mid, false],
			['Mid weir', 'gauge', null, true]
		]);
		// What the gauge measures is shown; it owns no land.
		expect(plan.units[1].totalAreaM2).toBeGreaterThan(plan.units[0].areaM2);
		const units = plan.units.map((u: { key: string; name: string }) => ({ key: u.key, name: u.name, area: false, drainsInto: true, runoffToDam: false }));
		const ok = await owner.call('POST', q.at(`/map/start/${r.body.proposal.id}/apply`), { outletName: 'Weir', units, rest: { include: false, name: 'Rest', area: false } });
		expect(ok.status, JSON.stringify(ok.body)).toBe(200);
		const by = Object.fromEntries((ok.body.model.nodes as { id: string; name: string; kind: string; downstreamNodeId: string | null }[]).map((n) => [n.name, n]));
		expect(by['Mid weir']).toMatchObject({ kind: 'gauge', downstreamNodeId: by['Weir']!.id });
		expect(by['Dam']).toMatchObject({ kind: 'farm', downstreamNodeId: by['Mid weir']!.id });
		// The gauge point stands for its gauge node.
		const [link] = await asOwner('SELECT node_id FROM map_feature WHERE id = $1', [mid]);
		expect(link!.node_id).toBe(by['Mid weir']!.id);
	});

	it('refuses an outlet that is not a gauge point, and a point from another project', async () => {
		const q = await newProject('Start, refused');
		const dm = await feature(q.at, { kind: 'dam', name: 'D', lon: 20.74, lat: -33.45 });
		const notGauge = await owner.call('POST', q.at('/map/start'), { outletFeatureId: dm, points: [] });
		expect(notGauge.status).toBe(400);
		expect(notGauge.body.error).toMatch(/gauge point/);
		await feature(q.at, { kind: 'catchment_boundary', name: 'B', geometry: { type: 'Polygon', coordinates: SQUARE } });
		const foreign = await owner.call('POST', q.at('/map/start'), { outletFeatureId: null, points: [{ featureId: dam, role: 'dam' }] });
		expect(foreign.status).toBe(400);
		expect(foreign.body.error).toMatch(/not on this catchment’s map/);
	});
});

describe('bounds', () => {
	it('caps proposals at 30 a project an hour (429), another project unaffected; prunes superseded and discarded ones past 50', async () => {
		process.env.DEM_URL = '';
		const q = await newProject('Start, capped');
		await feature(q.at, { kind: 'catchment_boundary', name: 'B', geometry: { type: 'Polygon', coordinates: SQUARE } });
		const plan = JSON.stringify({ units: [], rest: { name: 'Rest', areaM2: null, geometry: null } });
		// 60 old discarded ones (past the hour) and 29 superseded this hour, planted as the schema owner.
		await asOwner(
			`INSERT INTO start_proposal (project_id, status, plan, from_dem, method, method_version, created_at, decided_at)
			 SELECT $1, 'discarded', $2, false, 'planted', 'start-1', now() - interval '2 hours' - g * interval '1 minute', now() - interval '2 hours'
			 FROM generate_series(1, 60) g`,
			[q.id, plan]
		);
		await asOwner(
			`INSERT INTO start_proposal (project_id, status, plan, from_dem, method, method_version, created_at)
			 SELECT $1, 'superseded', $2, false, 'planted', 'start-1', now() - g * interval '1 minute' FROM generate_series(1, 29) g`,
			[q.id, plan]
		);
		const ok = await owner.call('POST', q.at('/map/start'), { points: [] });
		expect(ok.status, JSON.stringify(ok.body)).toBe(201);
		const [{ n, open }] = await asOwner(
			`SELECT count(*) FILTER (WHERE status IN ('superseded', 'discarded'))::int AS n, count(*) FILTER (WHERE status = 'proposed')::int AS open FROM start_proposal WHERE project_id = $1`,
			[q.id]
		);
		expect(n).toBe(50);
		expect(open).toBe(1);
		const capped = await owner.call('POST', q.at('/map/start'), { points: [] });
		expect(capped.status).toBe(429);
		// The open proposal survived the refusal; another project is not throttled.
		const [{ still }] = await asOwner(`SELECT count(*)::int AS still FROM start_proposal WHERE project_id = $1 AND status = 'proposed'`, [q.id]);
		expect(still).toBe(1);
		const other = await newProject('Start, not capped');
		await feature(other.at, { kind: 'catchment_boundary', name: 'B', geometry: { type: 'Polygon', coordinates: SQUARE } });
		expect((await owner.call('POST', other.at('/map/start'), { points: [] })).status).toBe(201);
	});
});

describe('RLS', () => {
	it('lets a viewer read a proposal but not change or delete it; an editor can (positive control)', async () => {
		process.env.DEM_URL = '';
		const q = await newProject('Start, RLS');
		await feature(q.at, { kind: 'catchment_boundary', name: 'B', geometry: { type: 'Polygon', coordinates: SQUARE } });
		const spid = (await owner.call('POST', q.at('/map/start'), { points: [] })).body.proposal.id as string;
		const asViewer = (sql: string) => withUser(viewer.id, (db) => db.query(sql, [spid]));
		expect((await asViewer('SELECT id FROM start_proposal WHERE id = $1')).rowCount).toBe(1);
		expect((await asViewer("UPDATE start_proposal SET status = 'discarded', decided_at = now() WHERE id = $1")).rowCount).toBe(0);
		expect((await asViewer('DELETE FROM start_proposal WHERE id = $1')).rowCount).toBe(0);
		expect((await withUser(stranger.id, (db) => db.query('SELECT id FROM start_proposal WHERE id = $1', [spid]))).rowCount).toBe(0);
		// A second open proposal in the project is refused by the partial unique index.
		await expect(withUser(owner.id, (db) => db.query(`INSERT INTO start_proposal (project_id, plan, from_dem, method, method_version) VALUES ($1, '{}', false, 'm', 'start-1')`, [q.id]))).rejects.toMatchObject({ code: '23505' });
		expect((await withUser(owner.id, (db) => db.query('DELETE FROM start_proposal WHERE id = $1', [spid]))).rowCount).toBe(1);
	});
});
