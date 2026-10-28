// Starting an empty model from the map (issue #326 C3; 178_start_proposal.sql,
// delineation/start.ts), end to end against Postgres and the committed
// synthetic DEM (backend/fixtures/dem/). The units are the user's own
// boundaries (start-16, #523 C1): a dam or an abstraction point is never a
// unit of its own, but part of the unit whose boundary holds it (its
// composite dam, its river pump), linked to it on apply with nothing filled.
//  - without a DEM each unit has its boundary's area, all draining into the
//    outflow gauge, and the rest of the catchment is the boundary less them;
//  - with one, a gauge at the outlet and two boundaries up the valley give
//    two units in order, each area its boundary's, checked against the DEM;
//    a boundary that came from Delineate lends its outlet;
//  - each point in the order on the terrain channel nearest it (start-15,
//    issue #472): a planted river reach or confluence changes nothing, the
//    larger channel named per point and taken with Use that channel, a body
//    naming a reach refused, a delineated outlet kept on its own cell;
//  - apply writes only the ticked values: a unit's ticked area is its
//    boundary, linked to it (area "from the map"), the ticked order;
//    unticked, the area stays 0 and the unit drains into the outflow gauge;
//    one model revision; the boundaries, dams and pumps linked to their nodes;
//  - refused: a model with nodes (409, to propose and to apply), a decided
//    proposal (409), a plan from before start-16 (409), ticks that don't
//    match the plan, two nodes of one name, an area ticked that wasn't
//    proposed, a share of runoff to a dam (400); a viewer can't propose (403)
//    and a stranger gets 404.
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwner, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { DAM_CELL, fixtureLonLat, OUTLET_CELL, valleyUnitRing } from './fixture.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let viewer: User;
let stranger: User;
const FIXTURE = fileURLToPath(new URL('../../fixtures/dem/synthetic-dem.pmtiles', import.meta.url));
const before = process.env.DEM_URL;
const pos = (x: number, y: number) => fixtureLonLat(x + 0.5, y + 0.5);
const SQUARE = [[[20.7, -33.5], [20.78, -33.5], [20.78, -33.42], [20.7, -33.42], [20.7, -33.5]]];
const box = (w: number, s: number, e: number, n: number) => ({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });
/** A unit's boundary in the valley: the stretch of the ridge between two rows (fixture.ts valleyUnitRing). */
const valleyUnit = (from: number, to: number) => ({ type: 'Polygon', coordinates: [valleyUnitRing(from, to)] });

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

/** The warning every proposal over the fixture's valley carries: its pan (start-11, pans.ts). */
const PAN_WARNING = /^[\d.]+ km² of the catchment above the outlet \(\d+ %\) drains into a pan \(a closed depression on the elevation model, at /;

describe('without an elevation model', () => {
	it('proposes each unit with its boundary’s area, all draining into the outflow gauge; its dams and pump are parts of it; the rest is the boundary less them', async () => {
		process.env.DEM_URL = '';
		const p = await newProject('Start, no DEM');
		const boundary = await feature(p.at, { kind: 'catchment_boundary', name: 'Drawn', geometry: { type: 'Polygon', coordinates: SQUARE } });
		const upper = await feature(p.at, { kind: 'other', name: 'Upper unit', geometry: box(20.7, -33.46, 20.78, -33.42) });
		const lower = await feature(p.at, { kind: 'other', name: 'Lower unit', geometry: box(20.7, -33.49, 20.78, -33.46) });
		const dam = await feature(p.at, { kind: 'dam', name: 'Upper dam', lon: 20.74, lat: -33.45 });
		const pump = await feature(p.at, { kind: 'other', name: '', lon: 20.75, lat: -33.47 });
		// A dam and a gauge outside the boundary aren't in the catchment: dropped, saying so.
		const farDam = await feature(p.at, { kind: 'dam', name: 'Far dam', lon: 20.9, lat: -33.45 });
		const away = await feature(p.at, { kind: 'gauge', name: 'Far weir', lon: 20.9, lat: -33.47 });
		const get = await viewer.call('GET', p.at('/map/start'));
		expect(get.body).toMatchObject({ elevation: false, dataset: null, modelEmpty: true, proposals: [] });
		// A dam or a point is never a unit's boundary (start-16), and a boundary is never a pump.
		const notArea = await owner.call('POST', p.at('/map/start'), { points: [{ featureId: dam, role: 'unit' }] });
		expect(notArea.status).toBe(400);
		expect(notArea.body.error).toMatch(/is not an area on the map, so it can’t be a unit’s boundary/);
		expect((await owner.call('POST', p.at('/map/start'), { points: [{ featureId: upper, role: 'abstraction' }] })).status).toBe(400);
		expect((await owner.call('POST', p.at('/map/start'), { points: [{ featureId: pump, role: 'dam' }] })).status).toBe(400);
		const r = await owner.call('POST', p.at('/map/start'), {
			points: [
				{ featureId: dam, role: 'dam' },
				{ featureId: upper, role: 'unit' },
				{ featureId: pump, role: 'abstraction' },
				{ featureId: lower, role: 'unit' },
				{ featureId: farDam, role: 'dam' },
				{ featureId: away, role: 'gauge' }
			]
		});
		expect(r.status, JSON.stringify(r.body)).toBe(201);
		const plan = r.body.proposal.plan;
		expect(plan.dropped).toEqual([
			{ featureId: away, name: 'Far weir', reason: 'is outside the catchment boundary' },
			{ featureId: farDam, name: 'Far dam', reason: 'is outside the catchment boundary' }
		]);
		expect(r.body.proposal).toMatchObject({ status: 'proposed', fromDem: false, dataset: null, methodVersion: 'start-17' });
		const areas = new Map((await asOwner('SELECT id, area_m2 FROM map_feature WHERE id = ANY($1::uuid[])', [[boundary, upper, lower]])).map((f) => [f.id, f.area_m2 as number]));
		expect(plan.units.map((u: { name: string; role: string; areaM2: number; drainsInto: null; drainsIntoProposed: boolean }) => [u.name, u.role, u.areaM2, u.drainsInto, u.drainsIntoProposed])).toEqual([
			['Upper unit', 'unit', areas.get(upper), null, false],
			['Lower unit', 'unit', areas.get(lower), null, false]
		]);
		// Neither the dam nor the pump is a unit: each is part of the unit whose boundary holds it.
		expect(plan.units.map((u: { members: unknown[] }) => u.members)).toEqual([[{ featureId: dam, name: 'Upper dam', role: 'dam' }], [{ featureId: pump, name: 'River pump 1', role: 'abstraction' }]]);
		expect(plan.units[0].geometry.type).toBe('Polygon');
		// The rest is the boundary less the units' boundaries, with no outline of its own.
		expect(plan.rest.areaM2).toBeCloseTo(areas.get(boundary)! - areas.get(upper)! - areas.get(lower)!, 3);
		expect(plan.rest.geometry).toBeNull();
		expect(plan.warnings[0]).toMatch(/no elevation model/);

		const ticks = (over: Record<string, boolean> = {}) =>
			plan.units.map((u: { key: string; name: string }) => ({ key: u.key, name: u.name, area: false, drainsInto: false, runoffToDam: false, ...over }));
		const url = p.at(`/map/start/${r.body.proposal.id}/apply`);
		// An order that wasn't proposed can't be ticked; and the composite dam's shares are the user's, never the map's.
		const bad = await owner.call('POST', url, { outletName: 'Weir', units: ticks({ drainsInto: true }), rest: { include: true, name: 'Rest', area: true } });
		expect(bad.status).toBe(400);
		expect(bad.body.error).toMatch(/no proposed order/);
		const share = await owner.call('POST', url, { outletName: 'Weir', units: ticks({ runoffToDam: true }), rest: { include: true, name: 'Rest', area: true } });
		expect(share.status).toBe(400);
		expect(share.body.error).toMatch(/composite dam takes the shares of runoff and of the upstream inflow you enter on the unit/);

		const ok = await owner.call('POST', url, { outletName: 'Weir', units: ticks({ area: true }), rest: { include: true, name: 'Rest', area: true } });
		expect(ok.status, JSON.stringify(ok.body)).toBe(200);
		const nodes = ok.body.model.nodes as { id: string; name: string; kind: string; downstreamNodeId: string | null; areaKm2: number; damCapacityM3: number; pctRunoffToDam: number }[];
		const weir = nodes.find((n) => n.name === 'Weir')!;
		expect(weir).toMatchObject({ kind: 'gauge', downstreamNodeId: null });
		expect(nodes.filter((n) => n.kind === 'farm').map((n) => [n.name, n.downstreamNodeId])).toEqual([
			['Upper unit', weir.id],
			['Lower unit', weir.id],
			['Rest', weir.id]
		]);
		const by = Object.fromEntries(nodes.map((n) => [n.name, n]));
		expect(by['Upper unit']!.areaKm2).toBeCloseTo(areas.get(upper)! / 1e6, 9);
		expect(by['Lower unit']!.areaKm2).toBeCloseTo(areas.get(lower)! / 1e6, 9);
		expect(by['Rest']!.areaKm2).toBeCloseTo(plan.rest.areaM2 / 1e6, 9);
		// Nothing about the composite dam is filled: its volume and the share of runoff reaching it are the user's to enter.
		expect([by['Upper unit']!.damCapacityM3, by['Upper unit']!.pctRunoffToDam]).toEqual([0, 0]);
		// Each unit's area is its own boundary, linked as Use this area links it: "from the map", no new parcel. The rest's is typed.
		const src = await asOwner(`SELECT n.name, n.area_source, n.area_basis, n.area_feature_id FROM node n WHERE n.project_id = $1 ORDER BY n.sort_order`, [p.id]);
		expect(src.map((x) => [x.name, x.area_source, x.area_basis, x.area_feature_id])).toEqual([
			['Weir', 'typed', null, null],
			['Upper unit', 'map', 'gross', upper],
			['Lower unit', 'map', 'gross', lower],
			['Rest', 'typed', null, null]
		]);
		const [{ parcels }] = await asOwner(`SELECT count(*)::int AS parcels FROM map_feature WHERE project_id = $1 AND kind = 'farm_parcel'`, [p.id]);
		expect(parcels).toBe(0);
		// The boundaries stand for their units, the dam and the pump for theirs; the far dam for nothing.
		const links = await asOwner(`SELECT f.id, n.name AS node FROM map_feature f LEFT JOIN node n ON n.id = f.node_id WHERE f.project_id = $1 AND f.kind IN ('dam', 'other')`, [p.id]);
		expect(new Map(links.map((l) => [l.id, l.node]))).toEqual(
			new Map([
				[upper, 'Upper unit'],
				[lower, 'Lower unit'],
				[dam, 'Upper unit'],
				[pump, 'Lower unit'],
				[farDam, null]
			])
		);
		expect(ok.body.proposal.decision.units.map((u: { name: string; boundaryId: string; parcelId: null }) => [u.name, u.boundaryId, u.parcelId])).toEqual([
			['Upper unit', upper, null],
			['Lower unit', lower, null]
		]);
	});

	it('refuses to apply a plan from before start-16, which made a unit at each dam and abstraction point', async () => {
		process.env.DEM_URL = '';
		const p = await newProject('Start, old plan');
		await feature(p.at, { kind: 'catchment_boundary', name: 'Drawn', geometry: { type: 'Polygon', coordinates: SQUARE } });
		const dam = await feature(p.at, { kind: 'dam', name: 'Upper dam', lon: 20.74, lat: -33.45 });
		// An open start-15 plan with a dam unit, as stored before the change (planted as the schema owner).
		const old = {
			fromDem: false,
			outlet: { featureId: null, name: 'Outflow gauge', point: null, snapDistanceM: null, foundIn: null, placement: null },
			catchment: { areaM2: null, boundaryAreaM2: null },
			units: [{ key: dam, featureName: 'Upper dam', role: 'dam', name: 'Upper dam', point: [20.74, -33.45], snapDistanceM: null, areaM2: null, totalAreaM2: null, geometry: null, drainsInto: null, drainsIntoProposed: false, placement: null }],
			rest: { name: 'Rest of the catchment', areaM2: null, geometry: null },
			dropped: [],
			warnings: []
		};
		const [{ id: spid }] = await asOwner(`INSERT INTO start_proposal (project_id, plan, from_dem, method, method_version) VALUES ($1, $2, false, 'planted', 'start-15') RETURNING id`, [p.id, JSON.stringify(old)]);
		const r = { body: { proposal: { id: spid as string } } };
		const apply = await owner.call('POST', p.at(`/map/start/${r.body.proposal.id}/apply`), {
			outletName: 'Weir',
			units: [{ key: dam, name: 'Upper dam', area: false, drainsInto: false, runoffToDam: false }],
			rest: { include: true, name: 'Rest', area: true }
		});
		expect(apply.status).toBe(409);
		expect(apply.body.error).toMatch(/makes a unit at each dam and abstraction point, as before units followed your boundaries \(start-16\): propose again/);
		expect((await owner.call('GET', p.at('/model'))).body.nodes).toEqual([]);
	});
});

describe('names over several lines (issue #385)', () => {
	// A map feature's name is one line since 192 (map_feature_name_one_line refuses one with a break), so the name proposed is
	// that line; a unit name typed at apply with a break is refused.
	it('proposes a boundary’s one-line name, and refuses a unit name with a line break at apply', async () => {
		process.env.DEM_URL = '';
		const p = await newProject('Start, one line');
		await feature(p.at, { kind: 'catchment_boundary', name: 'Drawn', geometry: { type: 'Polygon', coordinates: SQUARE } });
		const upper = await feature(p.at, { kind: 'other', name: 'Upper unit', geometry: box(20.7, -33.46, 20.78, -33.42) });
		const r = await owner.call('POST', p.at('/map/start'), { points: [{ featureId: upper, role: 'unit' }] });
		expect(r.status, JSON.stringify(r.body)).toBe(201);
		const [unit] = r.body.proposal.plan.units as { key: string; name: string }[];
		expect(unit!.name).toBe('Upper unit');
		const apply = (name: string) =>
			owner.call('POST', p.at(`/map/start/${r.body.proposal.id}/apply`), { outletName: 'Weir', units: [{ key: unit!.key, name, area: false, drainsInto: false, runoffToDam: false }], rest: { include: false, name: 'Rest', area: false } });
		const bad = await apply('Upper\nunit');
		expect(bad.status).toBe(400);
		expect(JSON.stringify(bad.body)).toMatch(/cannot contain line breaks or control characters/);
		const ok = await apply(unit!.name);
		expect(ok.status, JSON.stringify(ok.body)).toBe(200);
		expect((ok.body.model.nodes as { name: string }[]).map((n) => n.name)).toContain('Upper unit');
	});
});

describe('with the synthetic DEM', () => {
	let p: Awaited<ReturnType<typeof newProject>>;
	let gauge: string;
	let upper: string;
	let lower: string;
	let dam: string;
	let pump: string;
	let lowDam: string;

	beforeAll(async () => {
		process.env.DEM_URL = FIXTURE;
		p = await newProject('Start, DEM');
		gauge = await feature(p.at, { kind: 'gauge', name: 'Valley weir', lon: pos(OUTLET_CELL.x, OUTLET_CELL.y)[0], lat: pos(OUTLET_CELL.x, OUTLET_CELL.y)[1] });
		// Two units drawn as their boundaries: the valley above the dam's wall, and below it to the outlet.
		upper = await feature(p.at, { kind: 'other', name: 'Upper unit', geometry: valleyUnit(0, DAM_CELL.y + 1) });
		lower = await feature(p.at, { kind: 'other', name: 'Lower unit', geometry: valleyUnit(DAM_CELL.y + 1, 400) });
		dam = await feature(p.at, { kind: 'dam', name: 'Valley dam', lon: pos(DAM_CELL.x, DAM_CELL.y - 10)[0], lat: pos(DAM_CELL.x, DAM_CELL.y - 10)[1] });
		pump = await feature(p.at, { kind: 'other', name: 'Top pump', lon: pos(DAM_CELL.x, DAM_CELL.y - 100)[0], lat: pos(DAM_CELL.x, DAM_CELL.y - 100)[1] });
		lowDam = await feature(p.at, { kind: 'dam', name: 'Low dam', lon: pos(DAM_CELL.x + 10, DAM_CELL.y + 50)[0], lat: pos(DAM_CELL.x + 10, DAM_CELL.y + 50)[1] });
	});
	const body = () => ({
		outletFeatureId: gauge,
		points: [
			{ featureId: dam, role: 'dam' },
			{ featureId: pump, role: 'abstraction' },
			{ featureId: lower, role: 'unit' },
			{ featureId: upper, role: 'unit' },
			{ featureId: lowDam, role: 'dam' }
		]
	});

	it('proposes two units in order, upstream first, each with its boundary’s area checked against the elevation model, its dams and pump parts of it', async () => {
		const get = await viewer.call('GET', p.at('/map/start'));
		expect(get.body).toMatchObject({ elevation: true, modelEmpty: true });
		// A viewer reads but can't propose; a stranger can't see it at all.
		expect((await viewer.call('POST', p.at('/map/start'), body())).status).toBe(403);
		expect((await stranger.call('POST', p.at('/map/start'), body())).status).toBe(404);
		expect((await stranger.call('GET', p.at('/map/start'))).status).toBe(404);

		const r = await owner.call('POST', p.at('/map/start'), body());
		expect(r.status, JSON.stringify(r.body)).toBe(201);
		const { plan } = r.body.proposal;
		expect(r.body.proposal).toMatchObject({ fromDem: true, methodVersion: 'start-17', dataset: expect.stringMatching(/Synthetic DEM/), datasetFingerprint: expect.stringMatching(/^[0-9a-f]{16}$/) });
		expect(r.body.proposal.method).toMatch(/2 points at a unit boundary’s outflow/);
		expect(plan.outlet).toMatchObject({ featureId: gauge, name: 'Valley weir', foundIn: 'gauge' });
		// Only the boundaries are units; the dams and the pump are not.
		expect(plan.units.map((u: { name: string; role: string }) => [u.name, u.role])).toEqual([
			['Upper unit', 'unit'],
			['Lower unit', 'unit']
		]);
		const [top, low] = plan.units;
		expect(top.drainsInto).toBe(lower);
		expect(low.drainsInto).toBeNull();
		// Each area is its boundary's own; the elevation model's figure only checks it (within a tenth here, so no warning).
		const areas = new Map((await asOwner('SELECT id, area_m2 FROM map_feature WHERE id = ANY($1::uuid[])', [[upper, lower]])).map((f) => [f.id, f.area_m2 as number]));
		expect(top.areaM2).toBe(areas.get(upper));
		expect(low.areaM2).toBe(areas.get(lower));
		expect(Math.abs(top.demAreaM2 / top.areaM2 - 1)).toBeLessThan(0.1);
		expect(Math.abs(low.demAreaM2 / low.areaM2 - 1)).toBeLessThan(0.1);
		const [{ geometry }] = await asOwner('SELECT geometry FROM map_feature WHERE id = $1', [upper]);
		expect(top.geometry).toEqual(geometry);
		expect(plan.warnings.some((w: string) => /’s boundary is .* on the elevation model/.test(w))).toBe(false);
		// The boundaries were drawn a little past the ridge: nothing is left for the rest, and no unit claims an effective area.
		expect(plan.rest).toMatchObject({ areaM2: 0, geometry: null, members: [] });
		expect(top).not.toHaveProperty('nonContributingM2');
		expect(top.members).toEqual([
			{ featureId: dam, name: 'Valley dam', role: 'dam' },
			{ featureId: pump, name: 'Top pump', role: 'abstraction' }
		]);
		expect(low.members).toEqual([{ featureId: lowDam, name: 'Low dam', role: 'dam' }]);
		// The valley's pan lies in the upper unit: said once, with how to leave it out of a boundary's area (start-11, start-16).
		expect(plan.pans).toMatchObject({ count: 1, method: expect.stringMatching(/^Non-contributing \(pans\)/) });
		expect(plan.warnings.filter((w: string) => /drains into a pan \(a closed depression on the elevation model, at /.test(w))).toEqual([
			expect.stringMatching(/in Upper unit’s own area\. Each unit keeps its boundary’s area \(start-16\): type a smaller one if you model them as non-contributing\.$/)
		]);
		// A second proposal supersedes the first.
		const again = await owner.call('POST', p.at('/map/start'), body());
		expect(again.status).toBe(201);
		const [first] = await asOwner('SELECT status FROM start_proposal WHERE id = $1', [r.body.proposal.id]);
		expect(first!.status).toBe('superseded');
	});

	it('applies only the ticked values, as one revision, and refuses a second apply', async () => {
		const open = (await viewer.call('GET', p.at('/map/start'))).body.proposals[0];
		expect(open.status).toBe('proposed');
		const [top, low] = open.plan.units;
		const url = p.at(`/map/start/${open.id}/apply`);
		const units = [
			// The upper unit: its area ticked, its order not (so it drains into the outflow gauge).
			{ key: top.key, name: 'Upper unit', area: true, drainsInto: false, runoffToDam: false },
			// The lower unit: its order ticked, its area not.
			{ key: low.key, name: 'Lower unit', area: false, drainsInto: true, runoffToDam: false }
		];
		// Ticks that don't match the plan, and two nodes of one name, are refused.
		expect((await owner.call('POST', url, { outletName: 'Valley weir', units: units.slice(0, 1), rest: { include: false, name: 'Rest', area: false } })).status).toBe(400);
		const dup = await owner.call('POST', url, { outletName: 'Lower unit', units, rest: { include: false, name: 'Rest', area: false } });
		expect(dup.status).toBe(400);
		expect(dup.body.error).toMatch(/Two hydrological units would be called/);
		// The rest has nothing to take an effective area from.
		expect((await owner.call('POST', url, { outletName: 'Valley weir', units, rest: { include: true, name: 'Rest', area: true, areaBasis: 'effective' } })).status).toBe(400);

		const [{ rev }] = await asOwner('SELECT coalesce(max(id), 0) AS rev FROM model_revision WHERE project_id = $1', [p.id]);
		const ok = await owner.call('POST', url, { outletName: 'Valley weir', units, rest: { include: true, name: 'Rest of the valley', area: true } });
		expect(ok.status, JSON.stringify(ok.body)).toBe(200);
		const nodes = ok.body.model.nodes as { id: string; name: string; kind: string; downstreamNodeId: string | null; areaKm2: number; pctRunoffToDam: number }[];
		const by = Object.fromEntries(nodes.map((n) => [n.name, n]));
		expect(by['Valley weir']).toMatchObject({ kind: 'gauge', downstreamNodeId: null });
		expect(by['Upper unit']).toMatchObject({ kind: 'farm', downstreamNodeId: by['Valley weir']!.id, pctRunoffToDam: 0 });
		expect(by['Upper unit']!.areaKm2).toBeCloseTo(top.areaM2 / 1e6, 9);
		expect(by['Lower unit']).toMatchObject({ kind: 'farm', downstreamNodeId: by['Valley weir']!.id, areaKm2: 0, pctRunoffToDam: 0 });
		expect(by['Rest of the valley']!.areaKm2).toBe(0);
		const sources = await asOwner(`SELECT n.name, n.area_source, n.area_basis, n.area_feature_id FROM node n WHERE n.project_id = $1 ORDER BY n.sort_order`, [p.id]);
		expect(sources.map((x) => [x.name, x.area_source, x.area_basis, x.area_feature_id])).toEqual([
			['Valley weir', 'typed', null, null],
			['Upper unit', 'map', 'gross', upper],
			['Lower unit', 'typed', null, null],
			['Rest of the valley', 'typed', null, null]
		]);
		// The gauge stands for the outflow gauge; each boundary, dam and pump for its unit, the area ticked or not.
		const links = await asOwner('SELECT f.id, f.node_id FROM map_feature f WHERE f.id = ANY($1::uuid[])', [[gauge, upper, lower, dam, pump, lowDam]]);
		expect(new Map(links.map((l) => [l.id, l.node_id]))).toEqual(
			new Map([
				[gauge, by['Valley weir']!.id],
				[upper, by['Upper unit']!.id],
				[lower, by['Lower unit']!.id],
				[dam, by['Upper unit']!.id],
				[pump, by['Upper unit']!.id],
				[lowDam, by['Lower unit']!.id]
			])
		);
		// One revision; the proposal is applied with the ticks and the nodes made.
		// (The project's first change also records the baseline before it.)
		const revs = await asOwner(`SELECT reason FROM model_revision WHERE project_id = $1 AND id > $2 AND source <> 'baseline'`, [p.id, rev]);
		expect(revs).toHaveLength(1);
		expect(revs[0]!.reason).toMatch(/^Started from the map: 4 hydrological units; 2 areas \(gross\) and 1 drains-into from Synthetic DEM/);
		expect(ok.body.proposal).toMatchObject({ status: 'applied', decidedBy: expect.any(String) });
		expect(ok.body.proposal.decision.units.map((u: { name: string; area: boolean; drainsInto: boolean }) => [u.name, u.area, u.drainsInto])).toEqual([
			['Upper unit', true, false],
			['Lower unit', false, true]
		]);
		expect(ok.body.proposal.decision.revisionId).toEqual(expect.any(String));

		// Decided once; and a model with nodes is never started again.
		expect((await owner.call('POST', url, { outletName: 'X', units, rest: { include: false, name: 'R', area: false } })).status).toBe(409);
		const again = await owner.call('POST', p.at('/map/start'), { points: [] });
		expect(again.status).toBe(409);
		expect(again.body.error).toMatch(/hydrological units already/);
		expect((await viewer.call('GET', p.at('/map/start'))).body.modelEmpty).toBe(false);
	});

	it('refuses a boundary changed since the proposal, and warns of one far off the elevation model’s figure', async () => {
		const q = await newProject('Start, boundary changed');
		const g = await feature(q.at, { kind: 'gauge', name: 'Valley weir', lon: pos(OUTLET_CELL.x, OUTLET_CELL.y)[0], lat: pos(OUTLET_CELL.x, OUTLET_CELL.y)[1] });
		// Drawn short of the ridge on one side: its area is well under what drains to its outflow.
		const narrow = await feature(q.at, { kind: 'other', name: 'Narrow unit', geometry: box(...(() => {
			const [w, n] = pos(DAM_CELL.x - 20, DAM_CELL.y - 100);
			const [e, s] = pos(DAM_CELL.x + 20, DAM_CELL.y);
			return [w, s, e, n] as [number, number, number, number];
		})()) });
		const r = await owner.call('POST', q.at('/map/start'), { outletFeatureId: g, points: [{ featureId: narrow, role: 'unit' }] });
		expect(r.status, JSON.stringify(r.body)).toBe(201);
		const [u] = r.body.proposal.plan.units;
		expect(u.demAreaM2).toBeGreaterThan(1.1 * u.areaM2);
		expect(r.body.proposal.plan.warnings).toContain(
			`Narrow unit’s boundary is ${(u.areaM2 / 1e6).toFixed(2)} km², but what drains to its outflow and to no unit above it is ${(u.demAreaM2 / 1e6).toFixed(2)} km² on the elevation model. The area follows your boundary; check it, and the units around it, against the map.`
		);
		// Redrawn since: its area ticked is refused, never taken unseen.
		const [w, n] = pos(DAM_CELL.x - 30, DAM_CELL.y - 100);
		const [e, s] = pos(DAM_CELL.x + 30, DAM_CELL.y);
		expect((await owner.call('PATCH', q.at(`/map/features/${narrow}`), { geometry: box(w, s, e, n) })).status).toBe(200);
		const apply = await owner.call('POST', q.at(`/map/start/${r.body.proposal.id}/apply`), {
			outletName: 'Valley weir',
			units: [{ key: narrow, name: 'Narrow unit', area: true, drainsInto: true, runoffToDam: false }],
			rest: { include: true, name: 'Rest', area: true }
		});
		expect(apply.status).toBe(409);
		expect(apply.body.error).toMatch(/Narrow unit’s boundary changed since the proposal; propose again/);
		expect((await owner.call('GET', q.at('/model'))).body.nodes).toEqual([]);
	});

	it('takes the rest of the catchment’s effective area when no unit has a boundary (195)', async () => {
		const q = await newProject('Start, effective area');
		const g = await feature(q.at, { kind: 'gauge', name: 'Valley weir', lon: pos(OUTLET_CELL.x, OUTLET_CELL.y)[0], lat: pos(OUTLET_CELL.x, OUTLET_CELL.y)[1] });
		const r = await owner.call('POST', q.at('/map/start'), { outletFeatureId: g, points: [] });
		expect(r.status, JSON.stringify(r.body)).toBe(201);
		const { id: spid, plan } = r.body.proposal;
		// The whole catchment is the outlet's piece, the valley's pan in it; the effective choice is offered.
		expect(plan.rest.nonContributingM2).toBeGreaterThan(0);
		expect(plan.warnings.some((w: string) => /Choose the effective area beside an area’s tick/.test(w))).toBe(true);
		const url = q.at(`/map/start/${spid}/apply`);
		// The effective area needs the area ticked.
		const unticked = await owner.call('POST', url, { outletName: 'Valley weir', units: [], rest: { include: true, name: 'Rest of the valley', area: false, areaBasis: 'effective' } });
		expect(unticked.status).toBe(400);
		expect(unticked.body.error).toMatch(/Tick the rest of the catchment’s area to take its effective area/);
		const ok = await owner.call('POST', url, { outletName: 'Valley weir', units: [], rest: { include: true, name: 'Rest of the valley', area: true, areaBasis: 'effective' } });
		expect(ok.status, JSON.stringify(ok.body)).toBe(200);
		const by = Object.fromEntries((ok.body.model.nodes as { name: string; areaKm2: number }[]).map((n) => [n.name, n]));
		expect(by['Rest of the valley']!.areaKm2).toBeCloseTo((plan.rest.areaM2 - plan.rest.nonContributingM2) / 1e6, 9);
		// The parcel keeps the gross outline and area, and what of it drains into pans; the node says which it took.
		const [row] = await asOwner(
			`SELECT n.area_source, n.area_basis, f.area_m2, f.non_contributing_m2 FROM node n JOIN map_feature f ON f.id = n.area_feature_id WHERE n.project_id = $1 AND n.name = 'Rest of the valley'`,
			[q.id]
		);
		expect(row).toMatchObject({ area_source: 'map', area_basis: 'effective' });
		expect(row!.area_m2).toBeCloseTo(plan.rest.areaM2, 3);
		expect(row!.non_contributing_m2).toBeCloseTo(plan.rest.nonContributingM2, 3);
		expect(ok.body.proposal.decision.rest.areaBasis).toBe('effective');
		const [rev] = await asOwner(`SELECT reason FROM model_revision WHERE project_id = $1 AND source <> 'baseline' ORDER BY id DESC LIMIT 1`, [q.id]);
		expect(rev!.reason).toMatch(/^Started from the map: 2 hydrological units; 1 area \(effective, without what drains into pans\) and 0 drains-into/);
		// Typing over the area clears the basis with the source (store.ts).
		const model = (await owner.call('GET', q.at('/model'))).body;
		const typed = await owner.call('PUT', q.at('/model'), { ...model, nodes: model.nodes.map((n: { name: string; areaKm2: number }) => (n.name === 'Rest of the valley' ? { ...n, areaKm2: 1.5 } : n)) });
		expect(typed.status, JSON.stringify(typed.body)).toBe(200);
		const [after] = await asOwner(`SELECT area_source, area_basis FROM node WHERE project_id = $1 AND name = 'Rest of the valley'`, [q.id]);
		expect(after).toEqual({ area_source: 'typed', area_basis: null });
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
		expect(apply.body.error).toMatch(/hydrological units already/);
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
		// Only the valley's pan is worth a word (start-11).
		expect(r.body.proposal.plan.warnings).toEqual([expect.stringMatching(PAN_WARNING)]);
		expect(Math.abs(r.body.proposal.plan.rest.areaM2 / d.body.proposal.areaM2 - 1)).toBeLessThan(0.02);
	});

	it('puts a gauge inside the catchment in the order as a gauge node, the unit above it draining into it, and the unit holding the outlet below it', async () => {
		const q = await newProject('Start, gauge');
		const weir = await feature(q.at, { kind: 'gauge', name: 'Weir', lon: pos(OUTLET_CELL.x, OUTLET_CELL.y)[0], lat: pos(OUTLET_CELL.x, OUTLET_CELL.y)[1] });
		const up = await feature(q.at, { kind: 'other', name: 'Upper unit', geometry: valleyUnit(0, DAM_CELL.y + 1) });
		const low = await feature(q.at, { kind: 'other', name: 'Lower unit', geometry: valleyUnit(DAM_CELL.y + 1, 400) });
		const mid = await feature(q.at, { kind: 'gauge', name: 'Mid weir', lon: pos(DAM_CELL.x, DAM_CELL.y + 60)[0], lat: pos(DAM_CELL.x, DAM_CELL.y + 60)[1] });
		// Only a gauge point is a gauge node.
		const notGauge = await owner.call('POST', q.at('/map/start'), { outletFeatureId: weir, points: [{ featureId: up, role: 'gauge' }] });
		expect(notGauge.status).toBe(400);
		expect(notGauge.body.error).toMatch(/not a gauge point/);
		const r = await owner.call('POST', q.at('/map/start'), { outletFeatureId: weir, points: [{ featureId: mid, role: 'gauge' }, { featureId: up, role: 'unit' }, { featureId: low, role: 'unit' }] });
		expect(r.status, JSON.stringify(r.body)).toBe(201);
		const plan = r.body.proposal.plan;
		expect(plan.units.map((u: { name: string; role: string; drainsInto: string | null; areaM2: number | null }) => [u.name, u.role, u.drainsInto, u.areaM2 === null])).toEqual([
			['Upper unit', 'unit', mid, false],
			['Mid weir', 'gauge', low, true],
			['Lower unit', 'unit', null, false]
		]);
		// What the gauge measures is shown; it owns no land.
		expect(plan.units[1].totalAreaM2).toBeGreaterThan(plan.units[0].demAreaM2);
		const units = plan.units.map((u: { key: string; name: string }) => ({ key: u.key, name: u.name, area: false, drainsInto: true, runoffToDam: false }));
		const ok = await owner.call('POST', q.at(`/map/start/${r.body.proposal.id}/apply`), { outletName: 'Weir', units, rest: { include: false, name: 'Rest', area: false } });
		expect(ok.status, JSON.stringify(ok.body)).toBe(200);
		const by = Object.fromEntries((ok.body.model.nodes as { id: string; name: string; kind: string; downstreamNodeId: string | null }[]).map((n) => [n.name, n]));
		expect(by['Lower unit']).toMatchObject({ kind: 'farm', downstreamNodeId: by['Weir']!.id });
		expect(by['Mid weir']).toMatchObject({ kind: 'gauge', downstreamNodeId: by['Lower unit']!.id });
		expect(by['Upper unit']).toMatchObject({ kind: 'farm', downstreamNodeId: by['Mid weir']!.id });
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

describe('each point on the terrain channel nearest it (start-15, issue #472)', () => {
	// A planted river line three cells (about 380 m) east of the valley's river, as a HydroRIVERS line sits off the DEM's
	// channel; the outlet gauge and a dam on it, each on one of the valley side's small terrain channels beside the river. The
	// dam is in the order as a water user (a dam is never a unit since start-16, but a user at one is placed as a point is).
	const DATASET = 'start-snap-test';
	const LINE = [pos(DAM_CELL.x + 3, DAM_CELL.y + 10), pos(DAM_CELL.x + 3, DAM_CELL.y + 100)];
	let q: Awaited<ReturnType<typeof newProject>>;
	let gauge: string;
	let dam: string;
	let riverKm2: number;
	const plant = async (reachId: number, km2: number, line: [number, number][]) => {
		const lons = line.map((c) => c[0]);
		const lats = line.map((c) => c[1]);
		await asOwner(
			`INSERT INTO river_reference (dataset, reach_id, strahler, upstream_km2, geometry, min_lon, min_lat, max_lon, max_lat, source)
			 VALUES ($1, $2, 3, $3, $4, $5, $6, $7, $8, 'test reach, planted off the synthetic river')`,
			[DATASET, reachId, km2, JSON.stringify({ type: 'LineString', coordinates: line }), Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)]
		);
	};
	const clear = () => asOwner('DELETE FROM river_reference WHERE dataset = $1', [DATASET]);
	type Placement = { placedBy: string; larger: { distanceM: number } | null };

	beforeAll(async () => {
		process.env.DEM_URL = FIXTURE;
		q = await newProject('Start, placed as Delineate');
		const g = pos(DAM_CELL.x + 3, DAM_CELL.y + 60);
		const d = pos(DAM_CELL.x + 3, DAM_CELL.y + 25);
		gauge = await feature(q.at, { kind: 'gauge', name: 'Weir on the line', lon: g[0], lat: g[1] });
		dam = await feature(q.at, { kind: 'dam', name: 'Dam on the line', lon: d[0], lat: d[1] });
		const r = await owner.call('POST', q.at('/map/delineation'), { lon: pos(DAM_CELL.x, DAM_CELL.y + 60)[0], lat: pos(DAM_CELL.x, DAM_CELL.y + 60)[1], from: 'outlet' });
		expect(r.status, JSON.stringify(r.body)).toBe(201);
		riverKm2 = r.body.proposal.areaM2 / 1e6;
		await clear();
	}, 60_000);
	afterAll(clear);

	it('proposes the same plan with a river reach, or a confluence, planted on the points as without: the network never places them', async () => {
		const body = { outletFeatureId: gauge, points: [{ featureId: dam, role: 'user' }] };
		const where = (r: { body: { proposal: { plan: { outlet: { point: number[] }; catchment: { areaM2: number }; units: { key: string; point: number[] }[]; dropped: { featureId: string }[] } } } }) => {
			const p = r.body.proposal.plan;
			return { outlet: p.outlet.point, areaM2: p.catchment.areaM2, units: p.units.map((u) => [u.key, u.point]), dropped: p.dropped.map((d) => d.featureId) };
		};
		await clear();
		const plain = await owner.call('POST', q.at('/map/start'), body);
		expect(plain.status, JSON.stringify(plain.body)).toBe(201);
		expect(plain.body.proposal.methodVersion).toBe('start-17');
		expect(plain.body.proposal.method).toMatch(/the nearest terrain channel: the nearest cell within 150 m with at least 1 km² draining through it, the mapped river network not used/);
		await plant(99100001, riverKm2, LINE);
		await plant(99100002, 0.85 * riverKm2, [pos(DAM_CELL.x + 3, DAM_CELL.y - 30), LINE[0]!]);
		const reach = await owner.call('POST', q.at('/map/start'), body);
		expect(reach.status, JSON.stringify(reach.body)).toBe(201);
		expect(where(reach)).toEqual(where(plain));
		// Two rivers of clearly different areas ending at the gauge: no question asked.
		await clear();
		const g = pos(DAM_CELL.x + 3, DAM_CELL.y + 60);
		await plant(99100002, riverKm2, [pos(DAM_CELL.x + 3, DAM_CELL.y + 10), g]);
		await plant(99100003, riverKm2 / 4, [pos(DAM_CELL.x + 20, DAM_CELL.y + 50), g]);
		const junction = await owner.call('POST', q.at('/map/start'), body);
		expect(junction.status, JSON.stringify(junction.body)).toBe(201);
		expect(where(junction)).toEqual(where(plain));
		// A body naming a reach for the outlet is refused (the confluence pick is gone).
		expect((await owner.call('POST', q.at('/map/start'), { ...body, outletReach: { dataset: DATASET, reachId: 99100002 } })).status).toBe(400);
	});

	it('a gauge and a dam on the valley side’s small channels: the larger channel named per point as a warning; Use that channel puts each on the river', async () => {
		await clear();
		const r = await owner.call('POST', q.at('/map/start'), { outletFeatureId: gauge, points: [{ featureId: dam, role: 'user' }] });
		expect(r.status, JSON.stringify(r.body)).toBe(201);
		const plan = r.body.proposal.plan;
		const outlet = plan.outlet.placement as Placement;
		expect(outlet).toMatchObject({ placedBy: 'snapped' });
		expect(outlet.larger!.distanceM).toBeGreaterThan(200);
		expect(plan.catchment.areaM2 / 1e6).toBeLessThan(0.05 * riverKm2);
		expect(plan.warnings[0]).toMatch(/^A much larger terrain channel runs \d+ m west of the outlet \(Weir on the line\): at least [\d ,.]+ km² drains through it, against [\d.]+ km² where the point was put\..*use that channel/i);
		expect(r.body.proposal.method).toMatch(/the outlet on the nearest terrain channel, .*the nearest terrain channel: the nearest cell within 150 m/);
		// The dam, on its own small channel, doesn't drain to the outlet's: dropped, but with the river beside it named, to move it there.
		expect(plan.dropped).toMatchObject([{ featureId: dam, reason: expect.stringMatching(/isn’t upstream of the outlet/), placement: { placedBy: 'snapped', larger: { distanceM: expect.any(Number) } } }]);
		expect(plan.warnings.some((w: string) => /^A much larger terrain channel runs \d+ m west of Dam on the line:/.test(w))).toBe(true);

		const used = await owner.call('POST', q.at('/map/start'), { outletFeatureId: gauge, outletUseLarger: true, points: [{ featureId: dam, role: 'user', useLarger: true }] });
		expect(used.status, JSON.stringify(used.body)).toBe(201);
		const p2 = used.body.proposal.plan;
		expect(p2.outlet.placement).toMatchObject({ placedBy: 'larger', larger: null });
		expect(Math.abs(p2.catchment.areaM2 / 1e6 / riverKm2 - 1)).toBeLessThan(0.05);
		expect(p2.units.map((u: { key: string; placement: Placement }) => [u.key, u.placement.placedBy])).toEqual([[dam, 'larger']]);
		expect(p2.warnings).toEqual([expect.stringMatching(PAN_WARNING)]);
		expect(used.body.proposal.method).toMatch(/the outlet on the larger channel chosen/);
	});

	it('places a water user at a dam polygon that only clips the river at its own outflow, offers the river, and Use that channel puts it there (finding 9)', async () => {
		await clear();
		// An off-channel dam: a 4 × 4-cell block east of the river whose outline takes in one river cell at its corner.
		const c = (x: number, y: number) => fixtureLonLat(x, y);
		const [X, Y] = [DAM_CELL.x, DAM_CELL.y + 40];
		const ring = [c(X + 1, Y), c(X + 5, Y), c(X + 5, Y + 4), c(X, Y + 4), c(X, Y + 3), c(X + 1, Y + 3), c(X + 1, Y)];
		const offDam = await feature(q.at, { kind: 'dam', name: 'Off-channel dam', geometry: { type: 'Polygon', coordinates: [ring] } });
		const r = await owner.call('POST', q.at('/map/start'), { outletFeatureId: gauge, outletUseLarger: true, points: [{ featureId: offDam, role: 'user' }] });
		expect(r.status, JSON.stringify(r.body)).toBe(201);
		const plan = r.body.proposal.plan;
		const unit = plan.units.find((u: { key: string }) => u.key === offDam);
		expect(unit.placement).toMatchObject({ placedBy: 'polygon', larger: { outline: true } });
		expect(unit.placement.larger.pointKm2).toBeLessThan(0.02 * riverKm2);
		expect(plan.warnings.some((w: string) => /^Off-channel dam’s outline also covers a much larger channel .* If the dam is on that river, use that channel; otherwise keep it\.$/.test(w))).toBe(true);
		expect(r.body.proposal.method).toMatch(/1 point at a dam polygon’s outflow .*outflow: its own if a river only clips it/);

		const used = await owner.call('POST', q.at('/map/start'), { outletFeatureId: gauge, outletUseLarger: true, points: [{ featureId: offDam, role: 'user', useLarger: true }] });
		expect(used.status, JSON.stringify(used.body)).toBe(201);
		const onRiver = used.body.proposal.plan.units.find((u: { key: string }) => u.key === offDam);
		expect(onRiver.placement).toMatchObject({ placedBy: 'larger', larger: null });
		expect(onRiver.point).toEqual(unit.placement.larger.at);
		await owner.call('DELETE', q.at(`/map/features/${offDam}`));
	});

	it('a dam marked off-channel is part of its unit’s composite dam: never placed, no shares proposed or taken; a water user at it is placed by its siting (194, start-16)', async () => {
		await clear();
		const w = await newProject('Start, a dam’s siting');
		const c = (x: number, y: number) => fixtureLonLat(x, y);
		const [X, Y] = [DAM_CELL.x, DAM_CELL.y + 20];
		const g = pos(DAM_CELL.x, DAM_CELL.y + 60);
		const weir = await feature(w.at, { kind: 'gauge', name: 'Weir', lon: g[0], lat: g[1] });
		const unit = await feature(w.at, { kind: 'other', name: 'Valley unit', geometry: valleyUnit(0, DAM_CELL.y + 45) });
		// Three cells wide and 20 long, the river its west column all the way, marked off-channel.
		const ring = [c(X, Y), c(X + 3, Y), c(X + 3, Y + 20), c(X, Y + 20), c(X, Y)];
		const longDam = await feature(w.at, { kind: 'dam', name: 'Long dam', geometry: { type: 'Polygon', coordinates: [ring] } });
		expect((await owner.call('PATCH', w.at(`/map/features/${longDam}`), { damPosition: 'off_channel' })).status).toBe(200);
		const member = await owner.call('POST', w.at('/map/start'), { outletFeatureId: weir, points: [{ featureId: unit, role: 'unit' }, { featureId: longDam, role: 'dam' }] });
		expect(member.status, JSON.stringify(member.body)).toBe(201);
		const [u] = member.body.proposal.plan.units;
		expect(member.body.proposal.plan.units).toHaveLength(1);
		expect(u).toMatchObject({ key: unit, members: [{ featureId: longDam, name: 'Long dam', role: 'dam' }] });
		expect(u).not.toHaveProperty('damShares');
		expect(member.body.proposal.method).not.toMatch(/marked off-channel/);
		const refused = await owner.call('POST', w.at(`/map/start/${member.body.proposal.id}/apply`), {
			outletName: 'Weir',
			units: [{ key: unit, name: 'Valley unit', area: true, drainsInto: true, runoffToDam: false, upstreamToDam: true }],
			rest: { include: false, name: 'Rest', area: false }
		});
		expect(refused.status).toBe(400);
		expect(refused.body.error).toMatch(/the map proposes neither/);
		// A water user at the same dam is in the order as a point: placed by its siting, its marked position named.
		const user = await owner.call('POST', w.at('/map/start'), { outletFeatureId: weir, points: [{ featureId: longDam, role: 'user' }] });
		expect(user.status, JSON.stringify(user.body)).toBe(201);
		expect(user.body.proposal.plan.units[0].placement).toMatchObject({ placedBy: 'polygon', damPosition: 'off_channel' });
		expect(user.body.proposal.method).toMatch(/1 point at a dam polygon’s outflow \(1 marked off-channel\)/);
	});

	it('takes a delineated outlet’s own cell, not the most-drained one 150 m further down', async () => {
		await clear();
		const r = await owner.call('POST', q.at('/map/delineation'), { lon: pos(DAM_CELL.x, DAM_CELL.y + 60)[0], lat: pos(DAM_CELL.x, DAM_CELL.y + 60)[1], from: 'outlet' });
		expect(r.status).toBe(201);
		const acc = await owner.call('POST', q.at(`/map/delineation/${r.body.proposal.id}/accept`), { as: 'catchment_boundary', replaceBoundary: true });
		expect(acc.status, JSON.stringify(acc.body)).toBe(200);
		const s = await owner.call('POST', q.at('/map/start'), { points: [] });
		expect(s.status, JSON.stringify(s.body)).toBe(201);
		const plan = s.body.proposal.plan;
		expect(plan.outlet).toMatchObject({ foundIn: 'delineation', point: r.body.proposal.outlet, placement: { placedBy: 'exact' } });
		expect(Math.abs(plan.catchment.areaM2 / r.body.proposal.areaM2 - 1)).toBeLessThan(0.01);
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
