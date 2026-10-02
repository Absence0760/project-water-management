// Dividing a model that already has nodes from the map (#326 C3's follow-up;
// 182_divide_proposal.sql, delineation/divide.ts), end to end against
// Postgres and the committed synthetic DEM (backend/fixtures/dem/):
//  - the points stand for nodes (or a gauge point for a new gauge node); the
//    proposal gives each its own area and the point below it, beside the
//    node's current values, and names the units it leaves alone;
//  - apply takes only the ticked values: the areas as parcels (area "from
//    the map"), the order, runoff to the dam, a new gauge in the order, the
//    rest of the catchment to a unit; everything unticked stays as typed;
//    one model revision;
//  - refused: a value changed since the proposal (409), an order into a new
//    gauge that isn't added, a loop, a point standing for the outflow or for
//    another node (400), an empty model (409), no DEM (422); a viewer can't
//    propose (403), a stranger gets 404; a start apply of a division (409).
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwner, node, signUp } from '../__tests__/helpers.js';
import { loopIn, roleOf } from './divide.js';
import { DAM_CELL, fixtureLonLat, OUTLET_CELL } from './fixture.js';

type User = Awaited<ReturnType<typeof signUp>>;
type ApiNode = { id: string; name: string; kind: string; downstreamNodeId: string | null; areaKm2: number; pctRunoffToDam: number };

let owner: User;
let viewer: User;
let stranger: User;
const FIXTURE = fileURLToPath(new URL('../../fixtures/dem/synthetic-dem.pmtiles', import.meta.url));
const before = process.env.DEM_URL;
const pos = (x: number, y: number) => fixtureLonLat(x + 0.5, y + 0.5);

beforeAll(async () => {
	[owner, viewer, stranger] = (await Promise.all(['Downer', 'Dviewer', 'Dstranger'].map((n) => signUp(n)))) as [User, User, User];
	process.env.DEM_URL = FIXTURE;
}, 60_000);

afterAll(() => {
	if (before === undefined) delete process.env.DEM_URL;
	else process.env.DEM_URL = before;
});

/**
 * A typed model of the valley: the outflow weir, the dam and the top pump both
 * draining straight into it (the order not set yet), and a hillside unit with
 * no point on the map. On the map: a gauge at the outlet, the dam linked to its
 * unit, the pump unlinked, and a gauge halfway down the river with no node.
 */
async function valley(name: string, order: 'flat' | 'reversed' = 'flat') {
	const id = (await owner.call('POST', '/projects', { name })).body.project.id as string;
	const at = (p: string) => `/projects/${id}${p}`;
	expect((await owner.call('POST', at('/members'), { email: viewer.email, role: 'viewer' })).status).toBe(201);
	const weir = node('Valley weir', null);
	const dam = node('Valley dam', weir.id, { areaKm2: 5, damCapacityM3: 100_000 });
	const pump = node('Top pump', weir.id, { areaKm2: 2, damCapacityM3: 0 });
	// Reversed: the dam typed as draining into the pump, the wrong way up the river.
	if (order === 'reversed') dam.downstreamNodeId = pump.id;
	const hill = node('Hillside', weir.id, { areaKm2: 3, damCapacityM3: 0 });
	const put = await owner.call('PUT', at('/model'), { nodes: [weir, dam, pump, hill], crops: [], cropAreas: [], transfers: [] });
	expect(put.status, JSON.stringify(put.body)).toBe(200);
	const feature = async (body: Record<string, unknown>) => {
		const r = await owner.call('POST', at('/map/features'), body);
		expect(r.status, JSON.stringify(r.body)).toBe(201);
		return r.body.feature.id as string;
	};
	const [olon, olat] = pos(OUTLET_CELL.x, OUTLET_CELL.y);
	const [dlon, dlat] = pos(DAM_CELL.x, DAM_CELL.y + 1);
	const [plon, plat] = pos(DAM_CELL.x, DAM_CELL.y - 100);
	const [glon, glat] = pos(DAM_CELL.x, DAM_CELL.y + 60);
	const f = {
		outlet: await feature({ kind: 'gauge', name: 'Weir', lon: olon, lat: olat }),
		dam: await feature({ kind: 'dam', name: 'Dam wall', lon: dlon, lat: dlat, nodeId: dam.id }),
		pump: await feature({ kind: 'other', name: 'Pump', lon: plon, lat: plat }),
		mid: await feature({ kind: 'gauge', name: 'Mid weir', lon: glon, lat: glat })
	};
	const body = {
		outletFeatureId: f.outlet,
		points: [
			{ featureId: f.dam, nodeId: dam.id },
			{ featureId: f.pump, nodeId: pump.id },
			{ featureId: f.mid, nodeId: null }
		]
	};
	return { id, at, nodes: { weir, dam, pump, hill }, f, body };
}

const ticks = (plan: { units: { key: string; nodeId: string | null }[] }, over: Record<string, Record<string, unknown>> = {}) =>
	plan.units.map((u) => ({ key: u.key, area: false, drainsInto: false, runoffToDam: false, add: false, ...over[u.key] }));

describe('the pure parts', () => {
	it('takes the role from the node and the point', () => {
		expect(roleOf({ kind: 'farm', damCapacityM3: 0 }, 'dam')).toBe('dam');
		expect(roleOf({ kind: 'farm', damCapacityM3: 10 }, 'other')).toBe('dam');
		expect(roleOf({ kind: 'farm', damCapacityM3: 0 }, 'other')).toBe('abstraction');
		expect(roleOf({ kind: 'user', damCapacityM3: 0 }, 'other')).toBe('user');
		expect(roleOf({ kind: 'gauge', damCapacityM3: 0 }, 'gauge')).toBe('gauge');
		expect(roleOf(null, 'gauge')).toBe('gauge');
	});

	it('finds a loop in the drains-into, by names, and none in a tree', () => {
		const n = (id: string, down: string | null) => ({ id, name: id.toUpperCase(), downstreamNodeId: down });
		expect(loopIn([n('o', null), n('a', 'o'), n('b', 'a')])).toBeNull();
		expect(loopIn([n('o', null), n('a', 'b'), n('b', 'a'), n('c', 'a')])).toEqual(['A', 'B', 'A']);
	});
});

describe('dividing the valley', () => {
	it('proposes each point’s own area and the point below it, beside the current values', async () => {
		const v = await valley('Divide, proposal');
		// A viewer reads but can't propose; a stranger can't reach it.
		expect((await viewer.call('POST', v.at('/map/divide'), v.body)).status).toBe(403);
		expect((await stranger.call('POST', v.at('/map/divide'), v.body)).status).toBe(404);
		const r = await owner.call('POST', v.at('/map/divide'), v.body);
		expect(r.status, JSON.stringify(r.body)).toBe(201);
		expect(r.body.proposal).toMatchObject({ mode: 'divide', status: 'proposed', fromDem: true, dataset: expect.stringMatching(/Synthetic DEM/), methodVersion: 'start-2' });
		const plan = r.body.proposal.plan;
		expect(plan.outlet).toMatchObject({ featureId: v.f.outlet, nodeId: v.nodes.weir.id, name: 'Valley weir', foundIn: 'gauge' });
		// Upstream first: the pump drains into the dam, the dam into the new gauge, the gauge into the outflow.
		expect(plan.units.map((u: { name: string; role: string; drainsInto: string | null }) => [u.name, u.role, u.drainsInto])).toEqual([
			['Top pump', 'abstraction', v.f.dam],
			['Valley dam', 'dam', v.f.mid],
			['Mid weir', 'gauge', null]
		]);
		const [pump, dam, mid] = plan.units;
		expect(pump.current).toEqual({ areaKm2: 2, areaSource: 'typed', downstreamNodeId: v.nodes.weir.id, downstreamName: 'Valley weir', pctRunoffToDam: 0.5 });
		expect(mid).toMatchObject({ nodeId: null, current: null, areaM2: null, geometry: null });
		expect(mid.totalAreaM2).toBeGreaterThan(pump.areaM2 + dam.areaM2);
		expect(Math.abs((pump.areaM2 + dam.areaM2 + plan.rest.areaM2) / plan.catchment.areaM2 - 1)).toBeLessThan(0.02);
		expect(plan.untouched).toEqual([{ nodeId: v.nodes.hill.id, name: 'Hillside' }]);
		// The GET lists it with its mode; the model isn't empty.
		const get = await viewer.call('GET', v.at('/map/start'));
		expect(get.body).toMatchObject({ elevation: true, modelEmpty: false, startedFromMap: false });
		expect(get.body.proposals[0]).toMatchObject({ id: r.body.proposal.id, mode: 'divide' });
		// Start's apply is not for a division.
		const wrong = await owner.call('POST', v.at(`/map/start/${r.body.proposal.id}/apply`), { outletName: 'X', units: [], rest: { include: false, name: 'R', area: false } });
		expect(wrong.status).toBe(409);
		// Discarding a division is audited as one.
		expect((await owner.call('POST', v.at(`/map/start/${r.body.proposal.id}/discard`))).status).toBe(200);
		const [ev] = await asOwner(`SELECT kind FROM audit_event WHERE project_id = $1 AND kind LIKE 'map.divide%' ORDER BY id DESC LIMIT 1`, [v.id]);
		expect(ev!.kind).toBe('map.divide_discarded');
	});

	it('applies only the ticked values, adds the gauge, gives the rest to a unit, as one revision', async () => {
		const v = await valley('Divide, apply');
		const r = await owner.call('POST', v.at('/map/divide'), v.body);
		const { id: spid, plan } = r.body.proposal;
		const [pump, dam, mid] = plan.units;
		const url = v.at(`/map/divide/${spid}/apply`);
		// The dam into a new gauge that isn't added: refused, saying so.
		const notAdded = await owner.call('POST', url, { units: ticks(plan, { [dam.key]: { drainsInto: true } }), rest: { to: 'none' } });
		expect(notAdded.status).toBe(400);
		expect(notAdded.body.error).toMatch(/new gauge Mid weir, which isn’t being added/);
		// An existing node isn't named or added; a new gauge's name can't clash; the rest can't go to one of the points.
		expect((await owner.call('POST', url, { units: ticks(plan, { [pump.key]: { add: true } }), rest: { to: 'none' } })).status).toBe(400);
		const clash = await owner.call('POST', url, { units: ticks(plan, { [mid.key]: { add: true, name: 'hillside' } }), rest: { to: 'none' } });
		expect(clash.body.error).toMatch(/Two nodes would be called/);
		expect((await owner.call('POST', url, { units: ticks(plan), rest: { to: 'node', nodeId: v.nodes.pump.id } })).status).toBe(400);

		const [{ rev }] = await asOwner('SELECT coalesce(max(id), 0) AS rev FROM model_revision WHERE project_id = $1', [v.id]);
		const ok = await owner.call('POST', url, {
			units: ticks(plan, {
				[pump.key]: { area: true, drainsInto: true },
				// The dam's order and runoff, not its area.
				[dam.key]: { drainsInto: true, runoffToDam: true },
				[mid.key]: { add: true, drainsInto: true, name: 'Mid weir' }
			}),
			rest: { to: 'node', nodeId: v.nodes.hill.id }
		});
		expect(ok.status, JSON.stringify(ok.body)).toBe(200);
		const by = Object.fromEntries((ok.body.model.nodes as ApiNode[]).map((n) => [n.name, n]));
		expect(by['Mid weir']).toMatchObject({ kind: 'gauge', downstreamNodeId: v.nodes.weir.id, areaKm2: 0 });
		expect(by['Top pump']).toMatchObject({ downstreamNodeId: v.nodes.dam.id, pctRunoffToDam: 0.5 });
		expect(by['Top pump']!.areaKm2).toBeCloseTo(pump.areaM2 / 1e6, 6);
		// Unticked: the dam's typed area stays.
		expect(by['Valley dam']).toMatchObject({ downstreamNodeId: by['Mid weir']!.id, areaKm2: 5, pctRunoffToDam: 1 });
		expect(by['Hillside']!.areaKm2).toBeCloseTo(plan.rest.areaM2 / 1e6, 6);
		const sources = await asOwner(
			`SELECT n.name, n.area_source, f.kind, f.node_id = n.id AS linked, f.properties ->> 'description' AS description
			 FROM node n LEFT JOIN map_feature f ON f.id = n.area_feature_id WHERE n.project_id = $1 ORDER BY n.name`,
			[v.id]
		);
		expect(sources.map((s) => [s.name, s.area_source, s.kind, s.linked])).toEqual([
			['Hillside', 'map', 'farm_parcel', true],
			['Mid weir', 'typed', null, null],
			['Top pump', 'map', 'farm_parcel', true],
			['Valley dam', 'typed', null, null],
			['Valley weir', 'typed', null, null]
		]);
		expect(sources[0]!.description).toMatch(/Sub-catchment delineated from Synthetic DEM.*start-2/);
		// The points stand for their nodes now: the pump, the new gauge and the outlet gauge.
		const links = await asOwner('SELECT id, node_id FROM map_feature WHERE id = ANY($1::uuid[])', [[v.f.pump, v.f.mid, v.f.outlet, v.f.dam]]);
		expect(new Map(links.map((l) => [l.id, l.node_id]))).toEqual(
			new Map([
				[v.f.pump, v.nodes.pump.id],
				[v.f.mid, by['Mid weir']!.id],
				[v.f.outlet, v.nodes.weir.id],
				[v.f.dam, v.nodes.dam.id]
			])
		);
		const revs = await asOwner(`SELECT reason FROM model_revision WHERE project_id = $1 AND id > $2 AND source <> 'baseline'`, [v.id, rev]);
		expect(revs).toHaveLength(1);
		expect(revs[0]!.reason).toMatch(/^Divided from the map: 2 areas, 3 drains-into, 1 runoff to the dam, 1 gauge added from Synthetic DEM/);
		expect(ok.body.proposal).toMatchObject({ status: 'applied', mode: 'divide' });
		expect(ok.body.proposal.decision.rest).toMatchObject({ to: 'node', nodeId: v.nodes.hill.id, parcelId: expect.any(String) });
		// Decided once.
		expect((await owner.call('POST', url, { units: ticks(plan), rest: { to: 'none' } })).status).toBe(409);
		// Dividing again redraws the pump's own sub-catchment in place: one parcel, not two.
		const [{ area_feature_id: firstParcel }] = await asOwner('SELECT area_feature_id FROM node WHERE id = $1', [v.nodes.pump.id]);
		// (The mid gauge stands for its gauge node now.)
		const body2 = { ...v.body, points: v.body.points.map((p) => (p.featureId === v.f.mid ? { ...p, nodeId: by['Mid weir']!.id } : p)) };
		const again = await owner.call('POST', v.at('/map/divide'), body2);
		expect(again.status, JSON.stringify(again.body)).toBe(201);
		const plan2 = again.body.proposal.plan;
		const pump2 = plan2.units.find((u: { key: string }) => u.key === pump.key);
		const re = await owner.call('POST', v.at(`/map/divide/${again.body.proposal.id}/apply`), { units: ticks(plan2, { [pump.key]: { area: true } }), rest: { to: 'none' } });
		expect(re.status, JSON.stringify(re.body)).toBe(200);
		expect(re.body.proposal.decision.units.find((u: { key: string }) => u.key === pump.key).parcelId).toBe(firstParcel);
		const parcels = await asOwner(`SELECT count(*)::int AS n FROM map_feature WHERE node_id = $1 AND kind = 'farm_parcel'`, [v.nodes.pump.id]);
		expect(parcels[0]!.n).toBe(1);
		expect(pump2.current).toMatchObject({ areaSource: 'map' });
	});

	it('refuses a value changed since the proposal, and leaves the model as it was', async () => {
		const v = await valley('Divide, stale');
		const r = await owner.call('POST', v.at('/map/divide'), v.body);
		const { id: spid, plan } = r.body.proposal;
		const pump = plan.units[0];
		// Someone types the pump's area after the proposal.
		const model = (await owner.call('GET', v.at('/model'))).body;
		model.nodes.find((n: ApiNode) => n.id === v.nodes.pump.id).areaKm2 = 7;
		expect((await owner.call('PUT', v.at('/model'), model)).status).toBe(200);
		const stale = await owner.call('POST', v.at(`/map/divide/${spid}/apply`), { units: ticks(plan, { [pump.key]: { area: true } }), rest: { to: 'none' } });
		expect(stale.status).toBe(409);
		expect(stale.body.error).toMatch(/Top pump’s area changed since the proposal/);
		const after = (await owner.call('GET', v.at('/model'))).body.nodes.find((n: ApiNode) => n.id === v.nodes.pump.id);
		expect(after.areaKm2).toBe(7);
		// A value nobody changed still applies (its order).
		const ok = await owner.call('POST', v.at(`/map/divide/${spid}/apply`), { units: ticks(plan, { [pump.key]: { drainsInto: true } }), rest: { to: 'none' } });
		expect(ok.status, JSON.stringify(ok.body)).toBe(200);
	});

	it('refuses an order that would make a loop with one left unticked', async () => {
		const v = await valley('Divide, loop', 'reversed');
		const r = await owner.call('POST', v.at('/map/divide'), v.body);
		expect(r.status, JSON.stringify(r.body)).toBe(201);
		const { id: spid, plan } = r.body.proposal;
		const pump = plan.units[0];
		// The dam drains into the pump today; taking the pump → dam alone loops.
		const loop = await owner.call('POST', v.at(`/map/divide/${spid}/apply`), { units: ticks(plan, { [pump.key]: { drainsInto: true } }), rest: { to: 'none' } });
		expect(loop.status).toBe(400);
		expect(loop.body.error).toMatch(/would make a loop \((Top pump|Valley dam) → .* → (Top pump|Valley dam)\)/);
	});

	it('refuses points that can’t stand for their node, an empty model and a server with no DEM', async () => {
		const v = await valley('Divide, refused');
		const outflow = await owner.call('POST', v.at('/map/divide'), { outletFeatureId: v.f.outlet, points: [{ featureId: v.f.pump, nodeId: v.nodes.weir.id }] });
		expect(outflow.status).toBe(400);
		expect(outflow.body.error).toMatch(/is the outflow/);
		const linked = await owner.call('POST', v.at('/map/divide'), { outletFeatureId: v.f.outlet, points: [{ featureId: v.f.dam, nodeId: v.nodes.pump.id }] });
		expect(linked.status).toBe(400);
		expect(linked.body.error).toMatch(/stands for Valley dam on the map/);
		const notGauge = await owner.call('POST', v.at('/map/divide'), { outletFeatureId: v.f.outlet, points: [{ featureId: v.f.pump, nodeId: null }] });
		expect(notGauge.status).toBe(400);
		expect(notGauge.body.error).toMatch(/not a gauge point/);
		const gaugeForUnit = await owner.call('POST', v.at('/map/divide'), { outletFeatureId: v.f.outlet, points: [{ featureId: v.f.mid, nodeId: v.nodes.hill.id }] });
		expect(gaugeForUnit.status).toBe(400);
		const empty = (await owner.call('POST', '/projects', { name: 'Divide, empty' })).body.project.id;
		expect((await owner.call('POST', `/projects/${empty}/map/divide`, { points: [{ featureId: v.f.pump, nodeId: null }] })).status).toBe(409);
		process.env.DEM_URL = '';
		try {
			const off = await owner.call('POST', v.at('/map/divide'), v.body);
			expect(off.status).toBe(422);
			expect(off.body.error).toMatch(/needs an elevation model/);
		} finally {
			process.env.DEM_URL = FIXTURE;
		}
	});

	it('keeps a division’s mode, as its plan (182)', async () => {
		const v = await valley('Divide, final');
		const spid = (await owner.call('POST', v.at('/map/divide'), v.body)).body.proposal.id;
		await expect(asOwner(`UPDATE start_proposal SET mode = 'start' WHERE id = $1`, [spid])).rejects.toThrow(/mode stays as proposed/);
		await expect(asOwner(`INSERT INTO start_proposal (project_id, mode, plan, from_dem, method, method_version) VALUES ($1, 'divide', '{}', false, 'm', 'start-2')`, [v.id])).rejects.toThrow(/start_proposal_divide_from_dem/);
	});
});
