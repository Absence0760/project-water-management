// Dividing a model that already has nodes from the map (#326 C3's follow-up;
// 182_divide_proposal.sql, delineation/divide.ts), end to end against
// Postgres and the committed synthetic DEM (backend/fixtures/dem/). The units
// follow the user's own boundaries (start-16, #523 C1):
//  - each unit's boundary (an area on the map) stands for its node, a gauge
//    point for a gauge node or a new one; the proposal gives each unit its
//    boundary's area (checked against the elevation model) and the order,
//    beside the node's current values, and names the units it leaves alone;
//    a dam or an abstraction point never divides: the unlinked ones inside a
//    unit's boundary are its composite dam and its river pump;
//  - apply takes only the ticked values: a unit's area is its boundary,
//    linked to it (area "from the map"), the order, a new gauge in the order,
//    the rest of the catchment to a unit; the unlinked dams and pumps linked
//    to their unit; everything unticked stays as typed; one model revision;
//  - refused: a value changed since the proposal, a boundary redrawn since
//    (409), an order into a new gauge that isn't added, a loop, a feature
//    standing for the outflow or for another node, a dam or a point standing
//    for a unit, a share of runoff to a dam (400), an empty model (409), no
//    DEM (422); a viewer can't propose (403), a stranger gets 404; a start
//    apply of a division (409), a division from before start-16 (409).
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwner, node, signUp } from '../__tests__/helpers.js';
import { loopIn, roleOf } from './divide.js';
import { DAM_CELL, fixtureLonLat, OUTLET_CELL, valleyUnitRing } from './fixture.js';

type User = Awaited<ReturnType<typeof signUp>>;
type ApiNode = { id: string; name: string; kind: string; downstreamNodeId: string | null; areaKm2: number; pctRunoffToDam: number; pctUpstreamToDam: number; damCapacityM3: number };

let owner: User;
let viewer: User;
let stranger: User;
const FIXTURE = fileURLToPath(new URL('../../fixtures/dem/synthetic-dem.pmtiles', import.meta.url));
const before = process.env.DEM_URL;
const pos = (x: number, y: number) => fixtureLonLat(x + 0.5, y + 0.5);
/** A unit's boundary in the valley: the stretch of the ridge between two rows (fixture.ts valleyUnitRing). */
const valleyUnit = (from: number, to: number) => ({ type: 'Polygon', coordinates: [valleyUnitRing(from, to)] });
/** The lower unit stops short of the outlet, so some of the catchment is left to the rest. */
const LOWER_TO = OUTLET_CELL.y - 30;

beforeAll(async () => {
	[owner, viewer, stranger] = (await Promise.all(['Downer', 'Dviewer', 'Dstranger'].map((n) => signUp(n)))) as [User, User, User];
	process.env.DEM_URL = FIXTURE;
}, 60_000);

afterAll(() => {
	if (before === undefined) delete process.env.DEM_URL;
	else process.env.DEM_URL = before;
});

/**
 * A typed model of the valley: the outflow weir, the upper unit (with a dam) and the lower unit both draining straight into
 * it (the order not set yet), and a hillside unit with no boundary on the map. On the map: a gauge at the outlet, the upper
 * unit's boundary linked to it, the lower one's unlinked, a dam and a pump inside the upper boundary linked to nothing, a
 * dam there already linked to the upper unit, and a gauge in the lower unit with no node.
 */
async function valley(name: string, order: 'flat' | 'reversed' = 'flat') {
	const id = (await owner.call('POST', '/projects', { name })).body.project.id as string;
	const at = (p: string) => `/projects/${id}${p}`;
	expect((await owner.call('POST', at('/members'), { email: viewer.email, role: 'viewer' })).status).toBe(201);
	const weir = node('Valley weir', null);
	const upper = node('Upper unit', weir.id, { areaKm2: 5, damCapacityM3: 100_000 });
	const lower = node('Lower unit', weir.id, { areaKm2: 2, damCapacityM3: 0 });
	// Reversed: the lower unit typed as draining into the upper one, the wrong way up the river.
	if (order === 'reversed') lower.downstreamNodeId = upper.id;
	const hill = node('Hillside', weir.id, { areaKm2: 3, damCapacityM3: 0 });
	const put = await owner.call('PUT', at('/model'), { nodes: [weir, upper, lower, hill], crops: [], cropAreas: [], transfers: [] });
	expect(put.status, JSON.stringify(put.body)).toBe(200);
	const feature = async (body: Record<string, unknown>) => {
		const r = await owner.call('POST', at('/map/features'), body);
		expect(r.status, JSON.stringify(r.body)).toBe(201);
		return r.body.feature.id as string;
	};
	const p = (x: number, y: number) => {
		const [lon, lat] = pos(x, y);
		return { lon, lat };
	};
	const f = {
		outlet: await feature({ kind: 'gauge', name: 'Weir', ...p(OUTLET_CELL.x, OUTLET_CELL.y) }),
		upper: await feature({ kind: 'other', name: 'Upper boundary', geometry: valleyUnit(0, DAM_CELL.y + 1), nodeId: upper.id }),
		lower: await feature({ kind: 'other', name: 'Lower boundary', geometry: valleyUnit(DAM_CELL.y + 1, LOWER_TO) }),
		dam: await feature({ kind: 'dam', name: 'Dam wall', ...p(DAM_CELL.x, DAM_CELL.y - 10) }),
		pump: await feature({ kind: 'other', name: 'Pump', ...p(DAM_CELL.x, DAM_CELL.y - 100) }),
		linkedDam: await feature({ kind: 'dam', name: 'Side dam', ...p(DAM_CELL.x + 30, DAM_CELL.y - 40), nodeId: upper.id }),
		mid: await feature({ kind: 'gauge', name: 'Mid weir', ...p(DAM_CELL.x, DAM_CELL.y + 60) })
	};
	const body = {
		outletFeatureId: f.outlet,
		points: [
			{ featureId: f.mid, nodeId: null },
			{ featureId: f.upper, nodeId: upper.id },
			{ featureId: f.lower, nodeId: lower.id }
		]
	};
	return { id, at, nodes: { weir, upper, lower, hill }, f, body, feature };
}

const ticks = (plan: { units: { key: string; nodeId: string | null }[] }, over: Record<string, Record<string, unknown>> = {}) =>
	plan.units.map((u) => ({ key: u.key, area: false, drainsInto: false, runoffToDam: false, add: false, ...over[u.key] }));
const areaOf = async (id: string): Promise<number> => (await asOwner('SELECT area_m2 FROM map_feature WHERE id = $1', [id]))[0]!.area_m2 as number;

describe('the pure parts', () => {
	it('takes the role from the node: a unit (its boundary), a water user or a gauge', () => {
		expect(roleOf({ kind: 'farm' })).toBe('unit');
		expect(roleOf({ kind: 'user' })).toBe('user');
		expect(roleOf({ kind: 'gauge' })).toBe('gauge');
		expect(roleOf(null)).toBe('gauge');
	});

	it('finds a loop in the drains-into, by names, and none in a tree', () => {
		const n = (id: string, down: string | null) => ({ id, name: id.toUpperCase(), downstreamNodeId: down });
		expect(loopIn([n('o', null), n('a', 'o'), n('b', 'a')])).toBeNull();
		expect(loopIn([n('o', null), n('a', 'b'), n('b', 'a'), n('c', 'a')])).toEqual(['A', 'B', 'A']);
	});
});

describe('dividing the valley', () => {
	it('proposes each unit’s boundary’s area and the order, beside the current values; its unlinked dam and pump are parts of it', async () => {
		const v = await valley('Divide, proposal');
		// A viewer reads but can't propose; a stranger can't reach it.
		expect((await viewer.call('POST', v.at('/map/divide'), v.body)).status).toBe(403);
		expect((await stranger.call('POST', v.at('/map/divide'), v.body)).status).toBe(404);
		const r = await owner.call('POST', v.at('/map/divide'), v.body);
		expect(r.status, JSON.stringify(r.body)).toBe(201);
		expect(r.body.proposal).toMatchObject({ mode: 'divide', status: 'proposed', fromDem: true, dataset: expect.stringMatching(/Synthetic DEM/), methodVersion: 'start-17' });
		const plan = r.body.proposal.plan;
		expect(plan.outlet).toMatchObject({ featureId: v.f.outlet, nodeId: v.nodes.weir.id, name: 'Valley weir', foundIn: 'gauge' });
		// Upstream first: the upper unit drains into the new gauge, the gauge into the lower unit, the lower unit into the outflow.
		expect(plan.units.map((u: { name: string; role: string; drainsInto: string | null }) => [u.name, u.role, u.drainsInto])).toEqual([
			['Upper unit', 'unit', v.f.mid],
			['Mid weir', 'gauge', v.f.lower],
			['Lower unit', 'unit', null]
		]);
		const [up, mid, low] = plan.units;
		expect(up.current).toEqual({ areaKm2: 5, areaSource: 'typed', downstreamNodeId: v.nodes.weir.id, downstreamName: 'Valley weir', pctRunoffToDam: 0.5, pctUpstreamToDam: 0 });
		expect(mid).toMatchObject({ nodeId: null, current: null, areaM2: null, geometry: null });
		// Each unit's area is its boundary's own; the elevation model's figure checks it.
		expect(up.areaM2).toBe(await areaOf(v.f.upper));
		expect(low.areaM2).toBe(await areaOf(v.f.lower));
		expect(Math.abs(up.demAreaM2 / up.areaM2 - 1)).toBeLessThan(0.1);
		expect(up).not.toHaveProperty('nonContributingM2');
		expect(up).not.toHaveProperty('damShares');
		// The rest is the catchment less the boundaries, with no outline.
		expect(plan.rest.geometry).toBeNull();
		expect(plan.rest.areaM2).toBeCloseTo(plan.catchment.areaM2 - up.areaM2 - low.areaM2, 0);
		expect(plan.rest.areaM2).toBeGreaterThan(0);
		// The unlinked dam and pump inside the upper boundary are parts of it; the dam linked already isn't listed.
		expect(up.members).toEqual([
			{ featureId: v.f.dam, name: 'Dam wall', role: 'dam' },
			{ featureId: v.f.pump, name: 'Pump', role: 'abstraction' }
		]);
		expect(low.members).toEqual([]);
		// The valley's pan lies in the upper unit: said once, with how to leave it out of a boundary's area.
		expect(plan.pans).toMatchObject({ count: 1 });
		expect(plan.warnings.some((w: string) => /drains into a pan \(a closed depression .* in Upper unit’s own area\. Each unit keeps its boundary’s area/.test(w))).toBe(true);
		expect(plan.untouched).toEqual([{ nodeId: v.nodes.hill.id, name: 'Hillside', areaKm2: 3 }]);
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

	it('applies only the ticked values, adds the gauge, gives the rest to a unit, links the dam and pump, as one revision', async () => {
		const v = await valley('Divide, apply');
		const r = await owner.call('POST', v.at('/map/divide'), v.body);
		const { id: spid, plan } = r.body.proposal;
		const [up, mid, low] = plan.units;
		const url = v.at(`/map/divide/${spid}/apply`);
		// The upper unit into a new gauge that isn't added: refused, saying so.
		const notAdded = await owner.call('POST', url, { units: ticks(plan, { [up.key]: { drainsInto: true } }), rest: { to: 'none' } });
		expect(notAdded.status).toBe(400);
		expect(notAdded.body.error).toMatch(/new gauge Mid weir, which isn’t being added/);
		// An existing node isn't named or added; a new gauge's name can't clash; the rest can't go to one of the units divided.
		expect((await owner.call('POST', url, { units: ticks(plan, { [low.key]: { add: true } }), rest: { to: 'none' } })).status).toBe(400);
		const clash = await owner.call('POST', url, { units: ticks(plan, { [mid.key]: { add: true, name: 'hillside' } }), rest: { to: 'none' } });
		expect(clash.body.error).toMatch(/Two hydrological units would be called/);
		expect((await owner.call('POST', url, { units: ticks(plan), rest: { to: 'node', nodeId: v.nodes.lower.id } })).status).toBe(400);
		// The composite dam's shares are the user's to enter: never taken from the map.
		const share = await owner.call('POST', url, { units: ticks(plan, { [up.key]: { runoffToDam: true } }), rest: { to: 'none' } });
		expect(share.status).toBe(400);
		expect(share.body.error).toMatch(/the map proposes neither/);

		const [{ rev }] = await asOwner('SELECT coalesce(max(id), 0) AS rev FROM model_revision WHERE project_id = $1', [v.id]);
		const ok = await owner.call('POST', url, {
			units: ticks(plan, {
				[up.key]: { area: true, drainsInto: true },
				// The lower unit's order, not its area.
				[low.key]: { drainsInto: true },
				[mid.key]: { add: true, drainsInto: true, name: 'Mid weir' }
			}),
			rest: { to: 'node', nodeId: v.nodes.hill.id }
		});
		expect(ok.status, JSON.stringify(ok.body)).toBe(200);
		const by = Object.fromEntries((ok.body.model.nodes as ApiNode[]).map((n) => [n.name, n]));
		expect(by['Mid weir']).toMatchObject({ kind: 'gauge', downstreamNodeId: v.nodes.lower.id, areaKm2: 0 });
		// The composite dam is as typed: its volume and the share of runoff reaching it untouched.
		expect(by['Upper unit']).toMatchObject({ downstreamNodeId: by['Mid weir']!.id, pctRunoffToDam: 0.5, damCapacityM3: 100_000 });
		expect(by['Upper unit']!.areaKm2).toBeCloseTo(up.areaM2 / 1e6, 9);
		// Unticked: the lower unit's typed area stays.
		expect(by['Lower unit']).toMatchObject({ downstreamNodeId: v.nodes.weir.id, areaKm2: 2 });
		expect(by['Hillside']!.areaKm2).toBeCloseTo(plan.rest.areaM2 / 1e6, 9);
		// The upper unit's area is its boundary, linked; the rest's is typed (it has no outline); no parcel is made.
		const sources = await asOwner(`SELECT name, area_source, area_feature_id FROM node WHERE project_id = $1 ORDER BY name`, [v.id]);
		expect(sources.map((s) => [s.name, s.area_source, s.area_feature_id])).toEqual([
			['Hillside', 'typed', null],
			['Lower unit', 'typed', null],
			['Mid weir', 'typed', null],
			['Upper unit', 'map', v.f.upper],
			['Valley weir', 'typed', null]
		]);
		const [{ parcels }] = await asOwner(`SELECT count(*)::int AS parcels FROM map_feature WHERE project_id = $1 AND kind = 'farm_parcel'`, [v.id]);
		expect(parcels).toBe(0);
		// The features stand for their nodes now: the lower boundary, the new gauge, the outlet gauge; the dam and the pump for
		// the upper unit (its composite dam, its river pump); the side dam as it was.
		const links = await asOwner('SELECT id, node_id FROM map_feature WHERE project_id = $1 AND id <> $2', [v.id, v.f.upper]);
		expect(new Map(links.map((l) => [l.id, l.node_id]))).toEqual(
			new Map([
				[v.f.outlet, v.nodes.weir.id],
				[v.f.lower, v.nodes.lower.id],
				[v.f.dam, v.nodes.upper.id],
				[v.f.pump, v.nodes.upper.id],
				[v.f.linkedDam, v.nodes.upper.id],
				[v.f.mid, by['Mid weir']!.id]
			])
		);
		const revs = await asOwner(`SELECT reason FROM model_revision WHERE project_id = $1 AND id > $2 AND source <> 'baseline'`, [v.id, rev]);
		expect(revs).toHaveLength(1);
		expect(revs[0]!.reason).toMatch(/^Divided from the map: 2 areas \(gross\), 3 drains-into, 1 gauge added from Synthetic DEM/);
		expect(ok.body.proposal).toMatchObject({ status: 'applied', mode: 'divide' });
		expect(ok.body.proposal.decision.rest).toMatchObject({ to: 'node', nodeId: v.nodes.hill.id, parcelId: null });
		expect(ok.body.proposal.decision.units.find((u: { key: string }) => u.key === up.key)).toMatchObject({ boundaryId: v.f.upper, parcelId: null });
		// Decided once.
		expect((await owner.call('POST', url, { units: ticks(plan), rest: { to: 'none' } })).status).toBe(409);
		// Dividing again: the area is the same boundary, "the same", still linked; nothing is piled up.
		const body2 = { ...v.body, points: v.body.points.map((p) => (p.featureId === v.f.mid ? { ...p, nodeId: by['Mid weir']!.id } : p)) };
		const again = await owner.call('POST', v.at('/map/divide'), body2);
		expect(again.status, JSON.stringify(again.body)).toBe(201);
		const up2 = again.body.proposal.plan.units.find((u: { key: string }) => u.key === up.key);
		expect(up2.current).toMatchObject({ areaSource: 'map' });
		expect(up2.members).toEqual([]);
		const re = await owner.call('POST', v.at(`/map/divide/${again.body.proposal.id}/apply`), { units: ticks(again.body.proposal.plan, { [up.key]: { area: true } }), rest: { to: 'none' } });
		expect(re.status, JSON.stringify(re.body)).toBe(200);
		const [{ n }] = await asOwner(`SELECT count(*)::int AS n FROM map_feature WHERE project_id = $1 AND kind = 'farm_parcel'`, [v.id]);
		expect(n).toBe(0);
	});

	it('takes the rest’s effective area when no unit has a boundary (195), and redraws its parcel in place when divided again', async () => {
		const v = await valley('Divide, effective area');
		// Only the new gauge: the rest of the catchment is the outlet's whole piece, with the valley's pan in it.
		const body = { outletFeatureId: v.f.outlet, points: [{ featureId: v.f.mid, nodeId: null }] };
		const r = await owner.call('POST', v.at('/map/divide'), body);
		expect(r.status, JSON.stringify(r.body)).toBe(201);
		const { id: spid, plan } = r.body.proposal;
		expect(plan.rest.nonContributingM2).toBeGreaterThan(0);
		expect(plan.rest.geometry.type).toBe('Polygon');
		const ok = await owner.call('POST', v.at(`/map/divide/${spid}/apply`), { units: ticks(plan), rest: { to: 'new', name: 'Rest of the valley', areaBasis: 'effective' } });
		expect(ok.status, JSON.stringify(ok.body)).toBe(200);
		const restNode = (ok.body.model.nodes as ApiNode[]).find((n) => n.name === 'Rest of the valley')!;
		expect(restNode.areaKm2).toBeCloseTo((plan.rest.areaM2 - plan.rest.nonContributingM2) / 1e6, 9);
		const [row] = await asOwner(`SELECT n.area_basis, f.id, f.area_m2, f.non_contributing_m2 FROM node n JOIN map_feature f ON f.id = n.area_feature_id WHERE n.id = $1`, [restNode.id]);
		expect(row).toMatchObject({ area_basis: 'effective' });
		expect(row!.area_m2).toBeCloseTo(plan.rest.areaM2, 3);
		expect(row!.non_contributing_m2).toBeCloseTo(plan.rest.nonContributingM2, 3);
		const [rev] = await asOwner(`SELECT reason FROM model_revision WHERE project_id = $1 AND source <> 'baseline' ORDER BY id DESC LIMIT 1`, [v.id]);
		expect(rev!.reason).toMatch(/^Divided from the map: 1 area \(effective, without what drains into pans\), 0 drains-into, the rest of the catchment added/);
		// Divided again, the rest gross to the same unit: its parcel redrawn in place, the node saying gross now.
		const again = await owner.call('POST', v.at('/map/divide'), body);
		expect(again.status, JSON.stringify(again.body)).toBe(201);
		const re = await owner.call('POST', v.at(`/map/divide/${again.body.proposal.id}/apply`), { units: ticks(again.body.proposal.plan), rest: { to: 'node', nodeId: restNode.id } });
		expect(re.status, JSON.stringify(re.body)).toBe(200);
		const [after] = await asOwner(`SELECT n.area_basis, n.area_feature_id FROM node n WHERE n.id = $1`, [restNode.id]);
		expect(after).toEqual({ area_basis: 'gross', area_feature_id: row!.id });
		const [{ parcels }] = await asOwner(`SELECT count(*)::int AS parcels FROM map_feature WHERE project_id = $1 AND kind = 'farm_parcel'`, [v.id]);
		expect(parcels).toBe(1);
	});

	it('refuses a value changed since the proposal, or a boundary redrawn since, and leaves the model as it was', async () => {
		const v = await valley('Divide, stale');
		const r = await owner.call('POST', v.at('/map/divide'), v.body);
		const { id: spid, plan } = r.body.proposal;
		const low = plan.units.find((u: { key: string }) => u.key === v.f.lower);
		// Someone types the lower unit's area after the proposal.
		const model = (await owner.call('GET', v.at('/model'))).body;
		model.nodes.find((n: ApiNode) => n.id === v.nodes.lower.id).areaKm2 = 7;
		expect((await owner.call('PUT', v.at('/model'), model)).status).toBe(200);
		const stale = await owner.call('POST', v.at(`/map/divide/${spid}/apply`), { units: ticks(plan, { [low.key]: { area: true } }), rest: { to: 'none' } });
		expect(stale.status).toBe(409);
		expect(stale.body.error).toMatch(/Lower unit’s area changed since the proposal/);
		// The same for the unit the rest of the catchment would go to.
		model.nodes.find((n: ApiNode) => n.id === v.nodes.hill.id).areaKm2 = 9;
		expect((await owner.call('PUT', v.at('/model'), model)).status).toBe(200);
		const staleRest = await owner.call('POST', v.at(`/map/divide/${spid}/apply`), { units: ticks(plan), rest: { to: 'node', nodeId: v.nodes.hill.id } });
		expect(staleRest.status).toBe(409);
		expect(staleRest.body.error).toMatch(/Hillside’s area changed since the proposal/);
		// And the upper unit's boundary redrawn since: its area is never taken unseen.
		expect((await owner.call('PATCH', v.at(`/map/features/${v.f.upper}`), { geometry: valleyUnit(DAM_CELL.y - 80, DAM_CELL.y + 1) })).status).toBe(200);
		const redrawn = await owner.call('POST', v.at(`/map/divide/${spid}/apply`), { units: ticks(plan, { [v.f.upper]: { area: true } }), rest: { to: 'none' } });
		expect(redrawn.status).toBe(409);
		expect(redrawn.body.error).toMatch(/Upper unit’s boundary changed since the proposal/);
		const after = (await owner.call('GET', v.at('/model'))).body.nodes.find((n: ApiNode) => n.id === v.nodes.lower.id);
		expect(after.areaKm2).toBe(7);
		// A value nobody changed still applies (an order).
		const ok = await owner.call('POST', v.at(`/map/divide/${spid}/apply`), { units: ticks(plan, { [low.key]: { drainsInto: true } }), rest: { to: 'none' } });
		expect(ok.status, JSON.stringify(ok.body)).toBe(200);
	});

	it('refuses an order that would make a loop with one left unticked', async () => {
		const v = await valley('Divide, loop', 'reversed');
		const r = await owner.call('POST', v.at('/map/divide'), { outletFeatureId: v.f.outlet, points: v.body.points.filter((p) => p.featureId !== v.f.mid) });
		expect(r.status, JSON.stringify(r.body)).toBe(201);
		const { id: spid, plan } = r.body.proposal;
		const up = plan.units.find((u: { key: string }) => u.key === v.f.upper);
		expect(up.drainsInto).toBe(v.f.lower);
		// The lower unit drains into the upper one today; taking upper → lower alone loops.
		const loop = await owner.call('POST', v.at(`/map/divide/${spid}/apply`), { units: ticks(plan, { [up.key]: { drainsInto: true } }), rest: { to: 'none' } });
		expect(loop.status).toBe(400);
		expect(loop.body.error).toMatch(/would make a loop \((Upper unit|Lower unit) → .* → (Upper unit|Lower unit)\)/);
	});

	it('refuses features that can’t stand for their node (a dam or a point for a unit), an empty model and a server with no DEM', async () => {
		const v = await valley('Divide, refused');
		const outflow = await owner.call('POST', v.at('/map/divide'), { outletFeatureId: v.f.outlet, points: [{ featureId: v.f.lower, nodeId: v.nodes.weir.id }] });
		expect(outflow.status).toBe(400);
		expect(outflow.body.error).toMatch(/is the outflow/);
		const linked = await owner.call('POST', v.at('/map/divide'), { outletFeatureId: v.f.outlet, points: [{ featureId: v.f.upper, nodeId: v.nodes.lower.id }] });
		expect(linked.status).toBe(400);
		expect(linked.body.error).toMatch(/stands for Upper unit on the map/);
		const notGauge = await owner.call('POST', v.at('/map/divide'), { outletFeatureId: v.f.outlet, points: [{ featureId: v.f.pump, nodeId: null }] });
		expect(notGauge.status).toBe(400);
		expect(notGauge.body.error).toMatch(/not a gauge point/);
		const gaugeForUnit = await owner.call('POST', v.at('/map/divide'), { outletFeatureId: v.f.outlet, points: [{ featureId: v.f.mid, nodeId: v.nodes.hill.id }] });
		expect(gaugeForUnit.status).toBe(400);
		// A dam or an abstraction point is part of its unit, never where it ends (start-16).
		const damForUnit = await owner.call('POST', v.at('/map/divide'), { outletFeatureId: v.f.outlet, points: [{ featureId: v.f.dam, nodeId: v.nodes.hill.id }] });
		expect(damForUnit.status).toBe(400);
		expect(damForUnit.body.error).toMatch(/is a dam: a dam or an abstraction point is part of its unit \(its composite dam or its river pump\), not where the unit ends\. Pick Hillside’s boundary/);
		const pumpForUnit = await owner.call('POST', v.at('/map/divide'), { outletFeatureId: v.f.outlet, points: [{ featureId: v.f.pump, nodeId: v.nodes.hill.id }] });
		expect(pumpForUnit.status).toBe(400);
		expect(pumpForUnit.body.error).toMatch(/is a point: a dam or an abstraction point is part of its unit/);
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

	it('refuses to apply a division from before start-16, which divided at each dam and abstraction point', async () => {
		const v = await valley('Divide, old plan');
		const r = await owner.call('POST', v.at('/map/divide'), v.body);
		expect(r.status, JSON.stringify(r.body)).toBe(201);
		// A start-15 division with a dam unit, as stored before the change (planted as the schema owner, the open one discarded).
		expect((await owner.call('POST', v.at(`/map/start/${r.body.proposal.id}/discard`))).status).toBe(200);
		const old = { ...r.body.proposal.plan, units: [{ ...r.body.proposal.plan.units[0], role: 'dam' }] };
		const [{ id: spid }] = await asOwner(`INSERT INTO start_proposal (project_id, mode, plan, from_dem, dataset, dataset_fingerprint, method, method_version) VALUES ($1, 'divide', $2, true, 'Synthetic DEM', '0123456789abcdef', 'planted', 'start-15') RETURNING id`, [v.id, JSON.stringify(old)]);
		const apply = await owner.call('POST', v.at(`/map/divide/${spid}/apply`), { units: ticks(old), rest: { to: 'none' } });
		expect(apply.status).toBe(409);
		expect(apply.body.error).toMatch(/as before units followed your boundaries \(start-16\): propose again/);
	});

	it('keeps a division’s mode, as its plan (182)', async () => {
		const v = await valley('Divide, final');
		const spid = (await owner.call('POST', v.at('/map/divide'), v.body)).body.proposal.id;
		await expect(asOwner(`UPDATE start_proposal SET mode = 'start' WHERE id = $1`, [spid])).rejects.toThrow(/mode stays as proposed/);
		await expect(asOwner(`INSERT INTO start_proposal (project_id, mode, plan, from_dem, method, method_version) VALUES ($1, 'divide', '{}', false, 'm', 'start-2')`, [v.id])).rejects.toThrow(/start_proposal_divide_from_dem/);
	});
});

describe('each point on the terrain channel nearest it (start-15, issue #472)', () => {
	const DATASET = 'divide-snap-test';
	let v: Awaited<ReturnType<typeof valley>>;
	const plant = async (reachId: number, km2: number, line: [number, number][]) => {
		const lons = line.map((c) => c[0]);
		const lats = line.map((c) => c[1]);
		await asOwner(
			`INSERT INTO river_reference (dataset, reach_id, strahler, upstream_km2, geometry, min_lon, min_lat, max_lon, max_lat, source)
			 VALUES ($1, $2, 3, $3, $4, $5, $6, $7, $8, 'test reach, planted on the synthetic river')`,
			[DATASET, reachId, km2, JSON.stringify({ type: 'LineString', coordinates: line }), Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)]
		);
	};
	beforeAll(async () => {
		await asOwner('DELETE FROM river_reference WHERE dataset = $1', [DATASET]);
		v = await valley('Divide, placed on the terrain channels');
	}, 60_000);
	afterAll(() => asOwner('DELETE FROM river_reference WHERE dataset = $1', [DATASET]));

	it('records each placement: the gauges on the nearest terrain channel, each unit at its boundary’s outflow, no reach', async () => {
		const r = await owner.call('POST', v.at('/map/divide'), v.body);
		expect(r.status, JSON.stringify(r.body)).toBe(201);
		expect(r.body.proposal.plan.outlet.placement).toEqual({ placedBy: 'snapped', larger: null });
		expect(r.body.proposal.plan.units.map((u: { name: string; placement: { placedBy: string } }) => [u.name, u.placement.placedBy])).toEqual([
			['Upper unit', 'unit'],
			['Mid weir', 'snapped'],
			['Lower unit', 'unit']
		]);
		for (const u of r.body.proposal.plan.units) expect(u.placement).not.toHaveProperty('reach');
	});

	it('never asks for the river at a mapped confluence, and divides as with no river network', async () => {
		const plain = await owner.call('POST', v.at('/map/divide'), v.body);
		expect(plain.status, JSON.stringify(plain.body)).toBe(201);
		// Two rivers of clearly different areas ending at the mid weir: the main river above a junction and a tributary.
		const g = pos(DAM_CELL.x, DAM_CELL.y + 60);
		await plant(99200001, 400, [pos(DAM_CELL.x, DAM_CELL.y + 10), g]);
		await plant(99200002, 100, [pos(DAM_CELL.x + 20, DAM_CELL.y + 50), g]);
		const r = await owner.call('POST', v.at('/map/divide'), v.body);
		expect(r.status, JSON.stringify(r.body)).toBe(201);
		const where = (p: { plan: { units: { key: string; point: number[]; areaM2: number | null }[] } }) => p.plan.units.map((u) => [u.key, u.point, u.areaM2]);
		expect(where(r.body.proposal)).toEqual(where(plain.body.proposal));
		// A body naming a reach for a point is refused (the confluence pick is gone).
		const named = await owner.call('POST', v.at('/map/divide'), { ...v.body, points: v.body.points.map((p) => ({ ...p, reach: { dataset: DATASET, reachId: 99200001 } })) });
		expect(named.status).toBe(400);
	});
});

describe('a dam marked on or off the river (194) is part of its unit (start-16)', () => {
	it('is listed in its unit’s composite dam, never placed, and proposes no shares', async () => {
		const v = await valley('Divide, off-channel dam');
		const c = (x: number, y: number) => fixtureLonLat(x, y);
		const [X, Y] = [DAM_CELL.x, DAM_CELL.y - 60];
		const ring = [c(X, Y), c(X + 3, Y), c(X + 3, Y + 20), c(X, Y + 20), c(X, Y)];
		const longDam = await v.feature({ kind: 'dam', name: 'Long dam', geometry: { type: 'Polygon', coordinates: [ring] } });
		expect((await owner.call('PATCH', v.at(`/map/features/${longDam}`), { damPosition: 'off_channel' })).status).toBe(200);
		const r = await owner.call('POST', v.at('/map/divide'), v.body);
		expect(r.status, JSON.stringify(r.body)).toBe(201);
		const up = r.body.proposal.plan.units.find((u: { key: string }) => u.key === v.f.upper);
		expect(up.members).toContainEqual({ featureId: longDam, name: 'Long dam', role: 'dam' });
		expect(up).not.toHaveProperty('damShares');
		expect(r.body.proposal.method).not.toMatch(/marked off-channel/);
		const refused = await owner.call('POST', v.at(`/map/divide/${r.body.proposal.id}/apply`), { units: ticks(r.body.proposal.plan, { [v.f.upper]: { upstreamToDam: true } }), rest: { to: 'none' } });
		expect(refused.status).toBe(400);
		const ok = await owner.call('POST', v.at(`/map/divide/${r.body.proposal.id}/apply`), { units: ticks(r.body.proposal.plan), rest: { to: 'none' } });
		expect(ok.status, JSON.stringify(ok.body)).toBe(200);
		// Linked to its unit; the unit's shares as typed.
		const [link] = await asOwner('SELECT node_id FROM map_feature WHERE id = $1', [longDam]);
		expect(link!.node_id).toBe(v.nodes.upper.id);
		expect((ok.body.model.nodes as ApiNode[]).find((n) => n.id === v.nodes.upper.id)).toMatchObject({ pctUpstreamToDam: 0, pctRunoffToDam: 0.5 });
	});
});

describe('the rest of the catchment’s parcel name', () => {
	it('fits the map’s 100 characters for a unit whose name is already near them', async () => {
		const v = await valley('Divide, long name');
		const long = `Rest ${'x'.repeat(95)}`; // 100 characters, the most a node name takes
		const r = await owner.call('POST', v.at('/map/divide'), { outletFeatureId: v.f.outlet, points: [{ featureId: v.f.mid, nodeId: null }] });
		expect(r.status, JSON.stringify(r.body)).toBe(201);
		const ok = await owner.call('POST', v.at(`/map/divide/${r.body.proposal.id}/apply`), { units: ticks(r.body.proposal.plan), rest: { to: 'new', name: long } });
		expect(ok.status, JSON.stringify(ok.body)).toBe(200);
		const restNode = (ok.body.model.nodes as ApiNode[]).find((n) => n.name === long)!;
		const [parcel] = await asOwner(`SELECT name FROM map_feature WHERE node_id = $1 AND kind = 'farm_parcel'`, [restNode.id]);
		expect(parcel!.name).toBe(`${long}: own sub-catchment`.slice(0, 100));
	});
});
