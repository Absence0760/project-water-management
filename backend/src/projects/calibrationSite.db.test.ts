// The calibration site (settings.calibrationSiteNodeId, engine ≥ 1.41.0,
// projects/calibrationSite.ts): an editor picks a gauge inside the network
// with a flow record attached; a viewer reads it but cannot change it; a
// farm, the outlet node, a gauge with no record and another project's node
// are refused, storing nothing. The site reaches the model input a
// calibration fits, and a copy moves it to the copied gauge. Synthetic values only.
import { calibrationSeriesKey, prepareCalibration } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { loadModelInput } from '../runs/execute.js';

type User = Awaited<ReturnType<typeof signUp>>;

const DAYS = 60;

/** Outlet ← gauge H (with a record attached) ← farm; a bare gauge K with none; an outlet record too. */
async function gauged(u: User, name: string) {
	const id = (await u.call('POST', '/projects', { name })).body.project.id as string;
	const outlet = node('Outlet', null);
	const upper = node('Upper weir', outlet.id, { kind: 'gauge', areaKm2: 0 });
	const bare = node('Bare gauge', outlet.id, { kind: 'gauge', areaKm2: 0 });
	const farm = node('Farm', upper.id);
	const model = { nodes: [outlet, upper, bare, farm], crops: [], cropAreas: [], transfers: [] };
	expect((await u.call('PUT', `/projects/${id}/model`, model)).status).toBe(200);
	expect((await u.call('PATCH', `/projects/${id}`, { settings: { apanMm: monthly(150) } })).status).toBe(200);
	const put = (body: Record<string, unknown>) => u.call('PUT', `/projects/${id}/series`, { unit: 'm3/s', startDate: '2020-01-01', ...body });
	expect((await put({ kind: 'rain_catchment_mm', unit: 'mm', values: Array.from({ length: DAYS }, (_, i) => (i % 5 === 0 ? 10 : 0)) })).status).toBe(200);
	expect((await put({ kind: 'flow_observed_m3s', name: '', values: Array.from({ length: DAYS }, () => 2) })).status).toBe(200);
	const record = (await put({ kind: 'flow_observed_m3s', name: 'Upper weir', values: Array.from({ length: DAYS }, (_, i) => 1 + (i % 3)) })).body.id as string;
	expect((await u.call('PATCH', `/projects/${id}/series/${record}`, { siteNodeId: upper.id })).status).toBe(200);
	return { id, outlet, upper, bare, farm };
}
const site = (calibrationSiteNodeId: string | null) => ({ settings: { calibrationSiteNodeId } });

describe('settings.calibrationSiteNodeId', () => {
	it('an editor picks a gauge with a record; a viewer reads it but cannot change it; a non-member sees nothing', async () => {
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
		// The default is the outlet.
		expect((await viewer.call('GET', `/projects/${p.id}`)).body.project.settings.calibrationSiteNodeId).toBeNull();
		const set = await editor.call('PATCH', `/projects/${p.id}`, site(p.upper.id));
		expect(set.status, JSON.stringify(set.body)).toBe(200);
		expect(set.body.project.settings.calibrationSiteNodeId).toBe(p.upper.id);
		// Positive control: the viewer reads the editor's choice.
		expect((await viewer.call('GET', `/projects/${p.id}`)).body.project.settings.calibrationSiteNodeId).toBe(p.upper.id);
		expect((await viewer.call('PATCH', `/projects/${p.id}`, site(null))).status).toBe(403);
		expect((await stranger.call('PATCH', `/projects/${p.id}`, site(null))).status).toBe(404);

		// What a calibration fits: the gauge's record, keyed by its node.
		const input = await withUser(owner.id, (db) => loadModelInput(db, p.id));
		expect(input.settings.calibrationSiteNodeId).toBe(p.upper.id);
		expect(input.series[calibrationSeriesKey('flow_observed_m3s', p.upper.id)]).toBeDefined();
		const pb = prepareCalibration(input);
		expect(pb.siteNodeId).toBe(p.upper.id);
		expect(pb.observed[1]).toBeCloseTo(2 * 86_400, 6);

		// Back to the outlet.
		expect((await editor.call('PATCH', `/projects/${p.id}`, site(null))).body.project.settings.calibrationSiteNodeId).toBeNull();
	});

	it('refuses a farm, the outlet node, a gauge with no record and a node of another project, and stores nothing', async () => {
		const u = await signUp('CalSiteBad');
		const p = await gauged(u, 'Bad sites');
		const other = await gauged(u, 'Other project');
		for (const [id, why] of [
			[p.farm.id, 'the site is the outlet (null) or a gauge above it'],
			[p.outlet.id, 'the site is the outlet (null) or a gauge above it'],
			[p.bare.id, 'that gauge has no observed flow record attached'],
			[other.upper.id, 'no such hydrological unit in this project'],
			[crypto.randomUUID(), 'no such hydrological unit in this project']
		] as const) {
			const res = await u.call('PATCH', `/projects/${p.id}`, site(id));
			expect(res.status, why).toBe(400);
			expect(res.body.error).toBe(`calibrationSiteNodeId: ${why}`);
		}
		expect((await u.call('GET', `/projects/${p.id}`)).body.project.settings.calibrationSiteNodeId).toBeNull();
		// Not a node id at all: the schema refuses it.
		expect((await u.call('PATCH', `/projects/${p.id}`, site('H'))).status).toBe(400);
	});

	it('a copy moves the site to the copied gauge', async () => {
		const u = await signUp('CalSiteCopy');
		const p = await gauged(u, 'To copy');
		expect((await u.call('PATCH', `/projects/${p.id}`, site(p.upper.id))).status).toBe(200);
		const copy = await u.call('POST', `/projects/${p.id}/copy`, { name: 'Copied' });
		expect(copy.status, JSON.stringify(copy.body)).toBe(201);
		const cid = copy.body.project.id as string;
		const model = (await u.call('GET', `/projects/${cid}/model`)).body;
		const weir = (model.nodes as { id: string; name: string }[]).find((n) => n.name === 'Upper weir')!;
		expect(weir.id).not.toBe(p.upper.id);
		expect((await u.call('GET', `/projects/${cid}`)).body.project.settings.calibrationSiteNodeId).toBe(weir.id);
	});
});

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
const zones = (calibrationZones: unknown[], extra: Record<string, unknown> = {}) => ({ settings: { calibrationZones, ...extra } });

describe('settings.calibrationZones (engine 1.106.0, issue #555)', () => {
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

	it('refuses a farm, the outlet, a gauge with no record, another project’s node, the site itself and a repeat, storing nothing', async () => {
		const u = await signUp('CalZoneBad');
		const p = await gauged(u, 'Bad zones');
		const other = await gauged(u, 'Other zones');
		for (const [body, why] of [
			[zones([zoneRow(p.farm.id)]), 'calibrationZones: the site is the outlet (null) or a gauge above it'],
			[zones([zoneRow(p.outlet.id)]), 'calibrationZones: the site is the outlet (null) or a gauge above it'],
			[zones([zoneRow(p.bare.id)]), 'calibrationZones: that gauge has no observed flow record attached'],
			[zones([zoneRow(other.upper.id)]), 'calibrationZones: no such hydrological unit in this project'],
			[zones([zoneRow(p.upper.id)], { calibrationSiteNodeId: p.upper.id }), 'calibrationZones: calibration zone: "Upper weir" is the calibration site (Scored at), whose zone is the rest of the catchment']
		] as const) {
			const res = await u.call('PATCH', `/projects/${p.id}`, body);
			expect(res.status, why).toBe(400);
			expect(res.body.error).toBe(why);
		}
		expect((await u.call('PATCH', `/projects/${p.id}`, zones([zoneRow(p.upper.id), zoneRow(p.upper.id, { enabled: false })]))).status).toBe(400);
		const s = (await u.call('GET', `/projects/${p.id}`)).body.project.settings;
		expect(s.calibrationZones ?? []).toEqual([]);
		expect(s.calibrationSiteNodeId).toBeNull();
		// A stored zone then blocks moving the site onto its gauge.
		expect((await u.call('PATCH', `/projects/${p.id}`, zones([zoneRow(p.upper.id)]))).status).toBe(200);
		expect((await u.call('PATCH', `/projects/${p.id}`, site(p.upper.id))).status).toBe(400);
	});

	it('a copy moves each row to the copied gauge', async () => {
		const u = await signUp('CalZoneCopy');
		const p = await gauged(u, 'Zones to copy');
		expect((await u.call('PATCH', `/projects/${p.id}`, zones([zoneRow(p.upper.id)]))).status).toBe(200);
		const copy = await u.call('POST', `/projects/${p.id}/copy`, { name: 'Copied zones' });
		expect(copy.status, JSON.stringify(copy.body)).toBe(201);
		const cid = copy.body.project.id as string;
		const weir = ((await u.call('GET', `/projects/${cid}/model`)).body.nodes as { id: string; name: string }[]).find((n) => n.name === 'Upper weir')!;
		expect((await u.call('GET', `/projects/${cid}`)).body.project.settings.calibrationZones[0].nodeId).toBe(weir.id);
	});
});
