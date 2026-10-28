// The regional GR4J prior for a project (issue #622 step 5, calibration/prior.ts):
//  - a viewer reads the catchment's prior from the synthetic donors and soil
//    grid: the target at the boundary's centroid, the soil grid's PAWC over
//    it, the rain's MAP, the kept donors and the provenance (the positive
//    control for the refusals below);
//  - with no boundary, the answer says to draw one and holds no prior;
//  - an editor's "Start from the prior" writes the p50s into GR4J's
//    parameters with a start record and one history revision; the GET then
//    shows it started; a viewer can't start it, a non-member sees nothing,
//    and a settings save can't write a start record;
//  - under calibration zones, a zone's prior is built for its own land units
//    at its gauge on the map, and its start writes the zone's row.
// Synthetic values only.
import { calibrate, fitRecordFromReport, type CalibrationPrior } from '@water-management/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadSyntheticDonors } from '../../scripts/import-gr4j-donors.js';
import { loadSyntheticSoils } from '../../scripts/import-soils.js';
import { monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { loadModelInput } from '../runs/execute.js';

type User = Awaited<ReturnType<typeof signUp>>;
const URL_ = () => process.env.TEST_MIGRATION_DATABASE_URL!;
const START = '2015-10-01';
const DAYS = 3 * 365;
const rain = Array.from({ length: DAYS }, (_, i) => (i % 4 === 0 ? 8 : 0));
// Inside the synthetic soil grid's four 120 mm cells (soilGrid.db.test.ts), near the synthetic donors.
const BOUNDARY = [
	[
		[21.26, -33.74],
		[21.44, -33.74],
		[21.44, -33.56],
		[21.26, -33.56],
		[21.26, -33.74]
	]
];

let owner: User;
let viewer: User;
let stranger: User;

beforeAll(async () => {
	await loadSyntheticDonors(URL_());
	await loadSyntheticSoils(URL_());
	[owner, viewer, stranger] = (await Promise.all(['PriorOwner', 'PriorViewer', 'PriorStranger'].map((n) => signUp(n)))) as [User, User, User];
}, 60_000);

afterAll(async () => {
	// The synthetic sets stay loaded, as every reference test leaves them.
});

async function project(name: string, opts: { boundary?: boolean } = {}) {
	const id = (await owner.call('POST', '/projects', { name })).body.project.id as string;
	const outlet = node('Outlet', null);
	const farm = node('Farm', outlet.id, { areaKm2: 40 });
	expect((await owner.call('PUT', `/projects/${id}/model`, { nodes: [outlet, farm], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
	expect((await owner.call('PATCH', `/projects/${id}`, { settings: { apanMm: monthly(150) } })).status).toBe(200);
	expect((await owner.call('PUT', `/projects/${id}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: START, values: rain })).status).toBe(200);
	if (opts.boundary !== false) {
		const b = await owner.call('POST', `/projects/${id}/map/features`, { kind: 'catchment_boundary', name: 'Catchment', geometry: { type: 'Polygon', coordinates: BOUNDARY } });
		expect(b.status, JSON.stringify(b.body)).toBe(201);
	}
	expect((await owner.call('POST', `/projects/${id}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
	return id;
}

describe('the catchment’s prior', () => {
	it('a viewer reads it from the synthetic donors and soil grid; a non-member sees nothing', async () => {
		const id = await project('Prior');
		const r = await viewer.call('GET', `/projects/${id}/gr4j-prior`);
		expect(r.status, JSON.stringify(r.body)).toBe(200);
		const b = r.body;
		expect(b.problem).toBeNull();
		expect(b.dataset).toMatchObject({ dataset: 'synthetic', synthetic: true, donors: 14 });
		expect(b.target).toMatchObject({ zoneNodeId: null, units: null, positionFrom: 'boundary', pawcMm: 120, soilProblem: null });
		expect(b.target.lon).toBeCloseTo(21.35, 9);
		expect(b.target.lat).toBeCloseTo(-33.65, 9);
		// The rain's mean × 365.25 days; 40 km².
		expect(b.target.attributes).toMatchObject({ areaKm2: 40, slopeDeg: null, clayPct: null });
		expect(b.target.attributes.mapMm).toBeCloseTo((rain.reduce((x, y) => x + y, 0) / DAYS) * 365.25, 6);
		expect(b.target.attributes.aridity).toBeGreaterThan(0);
		expect(b.prior.ok).toBe(true);
		expect(b.donors).toHaveLength(7);
		expect(b.donors[0]).toHaveProperty('kgeFit');
		expect(b.provenance).toMatchObject({ dataset: 'synthetic', donorSetSha256: b.dataset.donorSetSha256, donorCount: 14, k: 7, target: { zoneNodeId: null, units: null }, referenceLoad: null });
		expect(b.provenance.donors.map((d: { id: string }) => d.id)).toEqual(b.donors.map((d: { id: string }) => d.id));
		// The synthetic donors' soil relation has skill and the target a PAWC: x1 is the soil's.
		expect(b.provenance.x1From).toBe('soil');
		expect(b.ranges.x1).toEqual(b.prior.soilX1);
		expect(b.started).toBeNull();
		expect((await stranger.call('GET', `/projects/${id}/gr4j-prior`)).status).toBe(404);
		expect((await viewer.call('GET', `/projects/${id}/gr4j-prior?dataset=nope`)).status).toBe(400);
	});

	it('with no boundary, says to draw one and holds no prior', async () => {
		const id = await project('Prior, no boundary', { boundary: false });
		const r = await viewer.call('GET', `/projects/${id}/gr4j-prior`);
		expect(r.status).toBe(200);
		expect(r.body.prior).toBeNull();
		expect(r.body.problem).toMatch(/no catchment boundary on the map/);
		expect(r.body.target.soilProblem).toBe('there is no catchment boundary on the map');
		expect((await owner.call('POST', `/projects/${id}/gr4j-prior/start`, {})).status).toBe(400);
	});

	it('an editor starts GR4J from it: the p50s, a start record and one revision; a viewer can’t; a save can’t forge a record', async () => {
		const id = await project('Prior start');
		const prior = (await owner.call('GET', `/projects/${id}/gr4j-prior`)).body;
		expect((await viewer.call('POST', `/projects/${id}/gr4j-prior/start`, {})).status).toBe(403);
		expect((await stranger.call('POST', `/projects/${id}/gr4j-prior/start`, {})).status).toBe(404);
		const s = await owner.call('POST', `/projects/${id}/gr4j-prior/start`, {});
		expect(s.status, JSON.stringify(s.body)).toBe(200);
		expect(s.body.params.x1).toBeCloseTo(prior.ranges.x1.p50, 9);
		expect(s.body.revisionId).toEqual(expect.any(String));
		const settings = (await viewer.call('GET', `/projects/${id}`)).body.project.settings;
		expect(settings.gr4j).toMatchObject({ x1: s.body.params.x1, x3: s.body.params.x3, x4: s.body.params.x4 });
		expect(settings.gr4jPrior).toHaveLength(1);
		expect(settings.gr4jPrior[0].provenance).toMatchObject({ dataset: 'synthetic', donorSetSha256: prior.dataset.donorSetSha256 });
		const again = (await viewer.call('GET', `/projects/${id}/gr4j-prior`)).body;
		expect(again.started.appliedAt).toBe(s.body.record.appliedAt);
		const history = (await viewer.call('GET', `/projects/${id}/history`)).body;
		expect(JSON.stringify(history)).toContain('started from the regional prior');
		// A save carrying its own start record is stripped of it: only the route writes one.
		const forged = await owner.call('PATCH', `/projects/${id}`, { settings: { gr4jPrior: [] } });
		expect([200, 400]).toContain(forged.status);
		expect((await viewer.call('GET', `/projects/${id}`)).body.project.settings.gr4jPrior).toHaveLength(1);
		// Editing x1 by hand: the GET no longer says it is started.
		expect((await owner.call('PATCH', `/projects/${id}`, { settings: { gr4j: { x1: s.body.params.x1 + 50 } } })).status).toBe(200);
		expect((await viewer.call('GET', `/projects/${id}/gr4j-prior`)).body.started).toBeNull();
	});
});

describe('a fit with the prior', () => {
	it('is saved with its prior in the fit record, and a malformed prior is refused', async () => {
		const id = await project('Prior fit');
		const outletFlow = rain.map((r, i) => 0.5 + (i % 30 === 0 ? 3 : 0) + r * 0.01);
		expect((await owner.call('PUT', `/projects/${id}/series`, { kind: 'flow_observed_m3s', unit: 'm3/s', startDate: START, values: outletFlow })).status).toBe(200);
		const p = (await owner.call('GET', `/projects/${id}/gr4j-prior`)).body;
		const prior: CalibrationPrior = { ranges: p.ranges, weight: 0.1, provenance: p.provenance };
		const input = await withUser(owner.id, (db) => loadModelInput(db, id));
		const report = calibrate(input, { budget: 40, validate: false, bounds: 'prior', prior });
		const record = fitRecordFromReport(report, {
			settings: input.settings as never,
			validate: false,
			validationRecord: null,
			engineVersion: '1.106.0',
			fittedAt: new Date().toISOString()
		});
		const gr4j = { x1: report.params.x1, x3: report.params.x3, x4: report.params.x4 };
		const saved = await owner.call('PATCH', `/projects/${id}`, { settings: { gr4j, fitRecord: record } });
		expect(saved.status, JSON.stringify(saved.body)).toBe(200);
		expect(saved.body.project.settings.fitRecord).toMatchObject({ bounds: 'prior', prior: { weight: 0.1, bounded: true, provenance: { donorSetSha256: p.dataset.donorSetSha256 } } });
		const bad = { ...record, prior: { ...record.prior!, ranges: { ...record.prior!.ranges, x3: { p10: 9, p50: 5, p90: 10 } } } };
		const refused = await owner.call('PATCH', `/projects/${id}`, { settings: { fitRecord: bad } });
		expect(refused.status).toBe(400);
		expect(JSON.stringify(refused.body)).toContain('regional prior');
	});
});

describe('a calibration zone’s prior', () => {
	it('is built for its own units at its gauge, and its start writes the zone’s row', async () => {
		const id = (await owner.call('POST', '/projects', { name: 'Prior zones' })).body.project.id as string;
		const outlet = node('Outlet', null);
		const weir = node('Weir', outlet.id, { kind: 'gauge', areaKm2: 0 });
		const a = node('Farm A', weir.id, { areaKm2: 40 });
		const b = node('Farm B', outlet.id, { areaKm2: 60 });
		expect((await owner.call('PUT', `/projects/${id}/model`, { nodes: [outlet, weir, a, b], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
		const put = (body: Record<string, unknown>) => owner.call('PUT', `/projects/${id}/series`, { unit: 'm3/s', startDate: START, ...body });
		expect((await put({ kind: 'rain_catchment_mm', unit: 'mm', values: rain })).status).toBe(200);
		expect((await put({ kind: 'flow_observed_m3s', name: '', values: rain.map(() => 2) })).status).toBe(200);
		const record = (await put({ kind: 'flow_observed_m3s', name: 'Weir', values: rain.map(() => 1) })).body.id as string;
		expect((await owner.call('PATCH', `/projects/${id}/series/${record}`, { siteNodeId: weir.id })).status).toBe(200);
		const zone = { nodeId: weir.id, enabled: true, calibrationStart: null, calibrationEnd: null, calibrationFlowKind: null, calibrationExclusions: [], qualityFlags: null, gr4j: null, fitRecord: null };
		const set = await owner.call('PATCH', `/projects/${id}`, { settings: { apanMm: monthly(150), unitRain: { mode: 'perUnit' }, calibrationZones: [zone] } });
		expect(set.status, JSON.stringify(set.body)).toBe(200);
		expect((await owner.call('POST', `/projects/${id}/map/features`, { kind: 'catchment_boundary', name: 'Catchment', geometry: { type: 'Polygon', coordinates: BOUNDARY } })).status).toBe(201);
		expect((await owner.call('POST', `/projects/${id}/map/features`, { kind: 'gauge', name: 'Weir', lon: 21.3, lat: -33.6, nodeId: weir.id })).status).toBe(201);

		const z = (await owner.call('GET', `/projects/${id}/gr4j-prior?zone=${weir.id}`)).body;
		expect(z.target).toMatchObject({ zoneNodeId: weir.id, units: [a.id], positionFrom: 'gauge', lon: 21.3, lat: -33.6 });
		expect(z.target.attributes.areaKm2).toBe(40);
		expect(z.provenance.target).toEqual({ zoneNodeId: weir.id, units: [a.id] });
		// The site's own zone: the rest, at the boundary's centroid.
		const rest = (await owner.call('GET', `/projects/${id}/gr4j-prior`)).body;
		expect(rest.target).toMatchObject({ zoneNodeId: null, units: [b.id], positionFrom: 'boundary' });
		expect(rest.target.attributes.areaKm2).toBe(60);
		// A gauge that isn't a zone is refused.
		expect((await owner.call('GET', `/projects/${id}/gr4j-prior?zone=${outlet.id}`)).status).toBe(400);

		const s = await owner.call('POST', `/projects/${id}/gr4j-prior/start`, { zone: weir.id });
		expect(s.status, JSON.stringify(s.body)).toBe(200);
		const settings = (await owner.call('GET', `/projects/${id}`)).body.project.settings;
		expect(settings.calibrationZones[0].gr4j).toEqual(s.body.params);
		expect(settings.gr4jPrior.map((r: { provenance: { target: unknown } }) => r.provenance.target)).toEqual([{ zoneNodeId: weir.id, units: [a.id] }]);
		expect((await owner.call('GET', `/projects/${id}/gr4j-prior?zone=${weir.id}`)).body.started).not.toBeNull();
		expect((await owner.call('GET', `/projects/${id}/gr4j-prior`)).body.started).toBeNull();
	});
});
