// Calibration locations (engine 1.110.0, issue #659, projects/calibrationSite.ts):
// every gauge inside the network with a record of its own (a row of
// settings.calibrationZones) and the outlet (calibrateAtOutlet) is a
// location; settings.calibrationSiteNodeId is the optional headline pointer;
// settings.unitParamsFrom gives a land unit another location's parameters.
// An editor sets them; a viewer reads them but cannot change them; a row on a
// farm, the outlet, a gauge with no record or another project's node is
// refused, as is a headline that isn't a ticked location and a parameter
// source naming anything but a land unit and a location of this project,
// storing nothing. A borrowing cycle is stored (the fit refuses it). They
// reach the model input a calibration fits, and a copy moves them to the
// copied nodes. Synthetic values only.
import { calibrationSeriesKey, locationFitPlan, prepareCalibration } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { loadModelInput } from '../runs/execute.js';

type User = Awaited<ReturnType<typeof signUp>>;

const DAYS = 60;

/**
 * Outlet ← gauge H "Upper weir" (with a record attached) ← farm, farm 3; a
 * gauge K "Bare gauge" with none (or, `bareRecord`, one too) ← farm 2,
 * farm 4; an outlet record too.
 */
async function gauged(u: User, name: string, bareRecord = false) {
	const id = (await u.call('POST', '/projects', { name })).body.project.id as string;
	const outlet = node('Outlet', null);
	const upper = node('Upper weir', outlet.id, { kind: 'gauge', areaKm2: 0 });
	const bare = node('Bare gauge', outlet.id, { kind: 'gauge', areaKm2: 0 });
	const farm = node('Farm', upper.id);
	const farm2 = node('Farm 2', bare.id);
	const farm3 = node('Farm 3', upper.id);
	const farm4 = node('Farm 4', bare.id);
	const model = { nodes: [outlet, upper, bare, farm, farm2, farm3, farm4], crops: [], cropAreas: [], transfers: [] };
	expect((await u.call('PUT', `/projects/${id}/model`, model)).status).toBe(200);
	expect((await u.call('PATCH', `/projects/${id}`, { settings: { apanMm: monthly(150) } })).status).toBe(200);
	const put = (body: Record<string, unknown>) => u.call('PUT', `/projects/${id}/series`, { unit: 'm3/s', startDate: '2020-01-01', ...body });
	expect((await put({ kind: 'rain_catchment_mm', unit: 'mm', values: Array.from({ length: DAYS }, (_, i) => (i % 5 === 0 ? 10 : 0)) })).status).toBe(200);
	expect((await put({ kind: 'flow_observed_m3s', name: '', values: Array.from({ length: DAYS }, () => 2) })).status).toBe(200);
	const attach = async (at: { id: string; name: string }) => {
		const record = (await put({ kind: 'flow_observed_m3s', name: at.name, values: Array.from({ length: DAYS }, (_, i) => 1 + (i % 3)) })).body.id as string;
		expect((await u.call('PATCH', `/projects/${id}/series/${record}`, { siteNodeId: at.id })).status).toBe(200);
	};
	await attach(upper);
	if (bareRecord) await attach(bare);
	return { id, outlet, upper, bare, farm, farm2, farm3, farm4 };
}
const settings = (s: Record<string, unknown>) => ({ settings: s });
const site = (calibrationSiteNodeId: string | null) => settings({ calibrationSiteNodeId });
const zoneRow = (nodeId: string, over: Record<string, unknown> = {}) => ({
	nodeId,
	enabled: true,
	calibrationStart: null,
	calibrationEnd: null,
	calibrationFlowKind: null,
	calibrationExclusions: [],
	qualityFlags: null,
	gr4j: { x1: 900, x2: 0, x3: 220, x4: 3.1 },
	fitRecord: null,
	...over
});
const zones = (calibrationZones: unknown[], extra: Record<string, unknown> = {}) => settings({ calibrationZones, ...extra });

describe('a new project’s calibration locations', () => {
	it('ticks the outlet and gives the units outside every location the nearest one upstream, stated, never left to the read-time conversion', async () => {
		const u = await signUp('CalLocNew');
		const created = await u.call('POST', '/projects', { name: 'New locations' });
		expect(created.status).toBe(201);
		expect(created.body.project.settings).toMatchObject({ calibrateAtOutlet: true, calibrationRest: 'nearest', calibrationSiteNodeId: null });
	});
});

describe('settings.calibrationSiteNodeId (the headline location)', () => {
	it('an editor makes a ticked gauge the headline; a viewer reads it but cannot change it; a non-member sees nothing', async () => {
		const owner = await signUp('CalSiteOwner');
		const editor = await signUp('CalSiteEditor');
		const viewer = await signUp('CalSiteViewer');
		const stranger = await signUp('CalSiteStranger');
		const p = await gauged(owner, 'Calibration site');
		for (const [u, role] of [
			[editor, 'editor'],
			[viewer, 'viewer']
		] as const) {
			expect((await owner.call('POST', `/projects/${p.id}/members`, { email: u.email, role })).status).toBe(201);
		}
		// The default is auto.
		expect((await viewer.call('GET', `/projects/${p.id}`)).body.project.settings.calibrationSiteNodeId).toBeNull();
		const set = await editor.call('PATCH', `/projects/${p.id}`, zones([zoneRow(p.upper.id)], { calibrationSiteNodeId: p.upper.id }));
		expect(set.status, JSON.stringify(set.body)).toBe(200);
		expect(set.body.project.settings.calibrationSiteNodeId).toBe(p.upper.id);
		// Positive control: the viewer reads the editor's choice.
		expect((await viewer.call('GET', `/projects/${p.id}`)).body.project.settings.calibrationSiteNodeId).toBe(p.upper.id);
		expect((await viewer.call('PATCH', `/projects/${p.id}`, site(null))).status).toBe(403);
		expect((await stranger.call('PATCH', `/projects/${p.id}`, site(null))).status).toBe(404);

		// What a calibration of the headline fits: the gauge's record, keyed by its node.
		const input = await withUser(owner.id, (db) => loadModelInput(db, p.id));
		expect(input.settings.calibrationSiteNodeId).toBe(p.upper.id);
		expect(input.series[calibrationSeriesKey('flow_observed_m3s', p.upper.id)]).toBeDefined();
		const pb = prepareCalibration(input);
		expect(pb.siteNodeId).toBe(p.upper.id);
		expect(pb.observed[1]).toBeCloseTo(2 * 86_400, 6);

		// The outlet's node is a headline while the outlet is ticked; back to auto.
		expect((await editor.call('PATCH', `/projects/${p.id}`, site(p.outlet.id))).status).toBe(200);
		expect((await editor.call('PATCH', `/projects/${p.id}`, site(null))).body.project.settings.calibrationSiteNodeId).toBeNull();
	});

	it('refuses a farm, a gauge that isn’t a ticked location, the unticked outlet and a node of another project, and stores nothing', async () => {
		const u = await signUp('CalSiteBad');
		const p = await gauged(u, 'Bad sites');
		const other = await gauged(u, 'Other project');
		expect((await u.call('PATCH', `/projects/${p.id}`, zones([zoneRow(p.upper.id, { enabled: false })], { calibrateAtOutlet: false }))).status).toBe(200);
		const notTicked = (name: string) => `calibrationSiteNodeId: headline location: "${name}" is not a ticked calibration location: tick Calibrate here there, or leave the headline on auto`;
		for (const [id, why] of [
			[p.farm.id, 'calibrationSiteNodeId: headline location: "Farm" is not a gauge'],
			[p.upper.id, notTicked('Upper weir')],
			[p.bare.id, notTicked('Bare gauge')],
			[p.outlet.id, 'calibrationSiteNodeId: headline location: "Outlet" is the outlet, whose location is the catchment\'s own settings (Calibrate here at the outlet)'],
			[other.upper.id, 'calibrationSiteNodeId: headline location: its gauge is no longer in the model'],
			[crypto.randomUUID(), 'calibrationSiteNodeId: headline location: its gauge is no longer in the model']
		] as const) {
			const res = await u.call('PATCH', `/projects/${p.id}`, site(id));
			expect(res.status, why).toBe(400);
			expect(res.body.error).toBe(why);
		}
		expect((await u.call('GET', `/projects/${p.id}`)).body.project.settings.calibrationSiteNodeId).toBeNull();
		// Not a node id at all: the schema refuses it.
		expect((await u.call('PATCH', `/projects/${p.id}`, site('H'))).status).toBe(400);
		// Unticking the headline's row in the same save as keeping it the headline is refused too.
		expect((await u.call('PATCH', `/projects/${p.id}`, zones([zoneRow(p.upper.id)], { calibrationSiteNodeId: p.upper.id }))).status).toBe(200);
		expect((await u.call('PATCH', `/projects/${p.id}`, zones([zoneRow(p.upper.id, { enabled: false })]))).status).toBe(400);
	});

	it('a copy moves the headline, each row and each unit’s Parameters from to the copied nodes', async () => {
		const u = await signUp('CalSiteCopy');
		const p = await gauged(u, 'To copy');
		const set = await u.call('PATCH', `/projects/${p.id}`, zones([zoneRow(p.upper.id)], { calibrationSiteNodeId: p.upper.id, unitParamsFrom: { [p.farm2.id]: p.upper.id } }));
		expect(set.status, JSON.stringify(set.body)).toBe(200);
		const copy = await u.call('POST', `/projects/${p.id}/copy`, { name: 'Copied' });
		expect(copy.status, JSON.stringify(copy.body)).toBe(201);
		const cid = copy.body.project.id as string;
		const nodes = (await u.call('GET', `/projects/${cid}/model`)).body.nodes as { id: string; name: string }[];
		const weir = nodes.find((n) => n.name === 'Upper weir')!;
		const farm2 = nodes.find((n) => n.name === 'Farm 2')!;
		expect(weir.id).not.toBe(p.upper.id);
		const s = (await u.call('GET', `/projects/${cid}`)).body.project.settings;
		expect(s.calibrationSiteNodeId).toBe(weir.id);
		expect(s.calibrationZones[0].nodeId).toBe(weir.id);
		expect(s.unitParamsFrom).toEqual({ [farm2.id]: weir.id });
	});
});

describe('settings.calibrationZones (the gauges’ locations)', () => {
	it('an editor ticks a gauge with a record; a viewer reads it but cannot change it; it reaches the model input', async () => {
		const owner = await signUp('CalZoneOwner');
		const viewer = await signUp('CalZoneViewer');
		const p = await gauged(owner, 'Calibration zones');
		expect((await owner.call('POST', `/projects/${p.id}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
		const set = await owner.call('PATCH', `/projects/${p.id}`, zones([zoneRow(p.upper.id)]));
		expect(set.status, JSON.stringify(set.body)).toBe(200);
		expect(set.body.project.settings.calibrationZones).toEqual([zoneRow(p.upper.id)]);
		// Positive control: the viewer reads it.
		expect((await viewer.call('GET', `/projects/${p.id}`)).body.project.settings.calibrationZones).toEqual([zoneRow(p.upper.id)]);
		expect((await viewer.call('PATCH', `/projects/${p.id}`, zones([]))).status).toBe(403);
		const input = await withUser(owner.id, (db) => loadModelInput(db, p.id));
		expect((input.settings.calibrationZones as { nodeId: string }[])[0]!.nodeId).toBe(p.upper.id);
		// Unticked, the row and its settings stay; [] clears it.
		const off = await owner.call('PATCH', `/projects/${p.id}`, zones([zoneRow(p.upper.id, { enabled: false })]));
		expect(off.body.project.settings.calibrationZones[0].enabled).toBe(false);
		expect((await owner.call('PATCH', `/projects/${p.id}`, zones([]))).body.project.settings.calibrationZones).toEqual([]);
	});

	it('refuses a farm, the outlet, a gauge with no record, another project’s node and a repeat, storing nothing', async () => {
		const u = await signUp('CalZoneBad');
		const p = await gauged(u, 'Bad zones');
		const other = await gauged(u, 'Other zones');
		const above = 'calibrationZones: a calibration location’s row is a gauge above the outlet (the outlet’s location is calibrateAtOutlet)';
		for (const [body, why] of [
			[zones([zoneRow(p.farm.id)]), above],
			[zones([zoneRow(p.outlet.id)]), above],
			[zones([zoneRow(p.bare.id)]), 'calibrationZones: that gauge has no observed flow record attached'],
			[zones([zoneRow(other.upper.id)]), 'calibrationZones: no such hydrological unit in this project']
		] as const) {
			const res = await u.call('PATCH', `/projects/${p.id}`, body);
			expect(res.status, why).toBe(400);
			expect(res.body.error).toBe(why);
		}
		expect((await u.call('PATCH', `/projects/${p.id}`, zones([zoneRow(p.upper.id), zoneRow(p.upper.id, { enabled: false })]))).status).toBe(400);
		const s = (await u.call('GET', `/projects/${p.id}`)).body.project.settings;
		expect(s.calibrationZones ?? []).toEqual([]);
		// Positive control: a row may now lie at the headline's own gauge (the "at or below the site" refusal of #555 is gone).
		expect((await u.call('PATCH', `/projects/${p.id}`, zones([zoneRow(p.upper.id)], { calibrationSiteNodeId: p.upper.id }))).status).toBe(200);
	});

	it('stores no location ticked at all, the outlet unticked and the rest on the catchment parameters', async () => {
		const u = await signUp('CalZoneNone');
		const p = await gauged(u, 'None ticked');
		const res = await u.call('PATCH', `/projects/${p.id}`, zones([zoneRow(p.upper.id, { enabled: false })], { calibrateAtOutlet: false, calibrationRest: 'default' }));
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		const input = await withUser(u.id, (db) => loadModelInput(db, p.id));
		expect(input.settings).toMatchObject({ calibrateAtOutlet: false, calibrationRest: 'default' });
		expect(() => locationFitPlan(input)).toThrow('no calibration location is ticked');
	});
});

describe('settings.unitParamsFrom (a unit given another location’s parameters)', () => {
	it('an editor gives a unit a gauge’s or the outlet’s parameters, and it reaches the model input', async () => {
		const u = await signUp('CalBorrow');
		const p = await gauged(u, 'Borrowing');
		const res = await u.call('PATCH', `/projects/${p.id}`, zones([zoneRow(p.upper.id)], { unitParamsFrom: { [p.farm2.id]: p.upper.id } }));
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		const input = await withUser(u.id, (db) => loadModelInput(db, p.id));
		expect(input.settings.unitParamsFrom).toEqual({ [p.farm2.id]: p.upper.id });
		// The borrowed unit moves with the gauge's group in the fit plan.
		const plan = locationFitPlan(input);
		expect(plan.find((s) => s.zoneNodeId === p.upper.id)!.borrowed).toEqual([p.farm2.id]);
		expect(plan.find((s) => s.zoneNodeId === null)!.units).toEqual([p.farm4.id]);
		expect((await u.call('PATCH', `/projects/${p.id}`, settings({ unitParamsFrom: { [p.farm.id]: p.outlet.id } }))).status).toBe(200);
		expect((await u.call('PATCH', `/projects/${p.id}`, settings({ unitParamsFrom: null }))).body.project.settings.unitParamsFrom).toBeNull();
	});

	it('refuses a key that isn’t a land unit of the project, and a value that isn’t one of its locations, storing nothing', async () => {
		const u = await signUp('CalBorrowBad');
		const p = await gauged(u, 'Bad borrowing');
		const other = await gauged(u, 'Other borrowing');
		expect((await u.call('PATCH', `/projects/${p.id}`, zones([zoneRow(p.upper.id)]))).status).toBe(200);
		const notLocation = (name: string) => `unitParamsFrom: parameters from: "Farm 2" takes its parameters from ${name}, which is not a calibration location`;
		for (const [m, why] of [
			[{ [p.bare.id]: p.upper.id }, 'unitParamsFrom: parameters from: "Bare gauge" is not a land unit (a farm with an area)'],
			[{ [other.farm.id]: p.upper.id }, `unitParamsFrom: parameters from: the node ${other.farm.id} is not a land unit (a farm with an area)`],
			[{ [p.farm2.id]: p.bare.id }, notLocation('"Bare gauge"')],
			[{ [p.farm2.id]: p.farm.id }, notLocation('"Farm"')],
			[{ [p.farm2.id]: other.upper.id }, notLocation(`the node ${other.upper.id}`)]
		] as const) {
			const res = await u.call('PATCH', `/projects/${p.id}`, settings({ unitParamsFrom: m }));
			expect(res.status, why).toBe(400);
			expect(res.body.error).toBe(why);
		}
		expect((await u.call('GET', `/projects/${p.id}`)).body.project.settings.unitParamsFrom).toBeUndefined();
	});

	it('stores a borrowing cycle (a run doesn’t care), which the fit plan refuses', async () => {
		const u = await signUp('CalBorrowCycle');
		const p = await gauged(u, 'Cycle', true);
		const res = await u.call(
			'PATCH',
			`/projects/${p.id}`,
			zones([zoneRow(p.upper.id), zoneRow(p.bare.id)], { calibrateAtOutlet: false, unitParamsFrom: { [p.farm.id]: p.bare.id, [p.farm2.id]: p.upper.id } })
		);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		const input = await withUser(u.id, (db) => loadModelInput(db, p.id));
		expect(() => locationFitPlan(input)).toThrow(/neither can be fitted first/);
	});
});
