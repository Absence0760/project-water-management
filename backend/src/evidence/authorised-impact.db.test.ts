// Both impact bases (licensing build item 8; evidence-14; docs/model.md
// §2.14a, docs/evidence-pack.md § Both impact bases): an editor runs an
// application run's full-allocation pair (POST …/runs/:runId/authorised-impact),
// and the evidence report carries the board against full authorised use as
// its headline, with the authorised volume's mix; without one, a fixed row
// says why. Synthetic catchment, invented volumes. Every "cannot" has its
// positive control.
import type { EvidenceAuthorisedImpact, EvidenceReport } from '@water-management/engine';
import { beforeAll, describe, expect, it } from 'vitest';
import { monthly, node, signUp } from '../__tests__/helpers.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let viewer: User;
let projectId: string;
let upper: string;
let lower: string;
let bareBase: string; // a baseline run before any registered volume
let bareApp: string;
let base: string;
let appRun: string;

const DAYS = 10 * 366;
const P = () => `/projects/${projectId}`;
const report = async (u: User, runId: string) => {
	const res = await u.call('GET', `${P()}/runs/${runId}/evidence-report`);
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return res.body.report as EvidenceReport;
};
const build = (u: User, runId: string) => u.call('POST', `${P()}/runs/${runId}/authorised-impact`, {});

async function newRun(label: string) {
	const res = await owner.call('POST', `${P()}/runs`, { label });
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.run.id as string;
}

/** A team scenario raising Upper's dam on `baseRunId`, run once: its run. */
async function application(baseRunId: string, name: string) {
	const created = await owner.call('POST', `${P()}/scenarios`, {
		name,
		baseRunId,
		ops: [{ op: 'node.set', nodeId: upper, field: 'damCapacityM3', value: 400_000 }],
		ownedNodeIds: [upper]
	});
	expect(created.status, JSON.stringify(created.body)).toBe(201);
	const ran = await owner.call('POST', `${P()}/scenarios/${created.body.scenario.id}/runs`, {});
	expect(ran.status, JSON.stringify(ran.body)).toBe(201);
	return ran.body.run.id as string;
}

beforeAll(async () => {
	[owner, viewer] = await Promise.all([signUp('AiOwner'), signUp('AiViewer')]);
	projectId = (await owner.call('POST', '/projects', { name: 'Authorised use' })).body.project.id as string;
	expect((await owner.call('POST', `${P()}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
	const outlet = node('Outlet', null);
	const u = node('Upper', outlet.id, { areaKm2: 30, damCapacityM3: 100_000 });
	const l = node('Lower', outlet.id, { areaKm2: 20, damCapacityM3: 50_000 });
	upper = u.id;
	lower = l.id;
	const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.9) };
	const model = {
		nodes: [outlet, u, l],
		crops: [crop],
		cropAreas: [
			{ nodeId: upper, cropId: crop.id, areaM2: 200_000 },
			{ nodeId: lower, cropId: crop.id, areaM2: 100_000 }
		],
		transfers: []
	};
	expect((await owner.call('PUT', `${P()}/model`, model)).status).toBe(200);
	expect((await owner.call('PATCH', P(), { settings: { apanMm: monthly(150), ewrPragmaticM3PerDay: monthly(4000) } })).status).toBe(200);
	const rain = Array.from({ length: DAYS }, (_, i) => (i % 4 === 0 ? (Math.floor(i / 30) % 12 < 6 ? 18 : 4) : 0));
	expect((await owner.call('PUT', `${P()}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2016-10-01', values: rain })).status).toBe(200);
	bareBase = await newRun('Before the volumes');
	bareApp = await application(bareBase, 'Upper dam, before the volumes');
	// Registered volumes: a licence on Upper, a WARMS registration (no entitlement) on Lower, larger than it uses.
	for (const [nodeId, authorisation, volumeM3PerYear] of [
		[upper, 'licence', 150_000],
		[lower, 'registration', 400_000]
	] as const)
		expect((await owner.call('POST', `${P()}/allocations`, { nodeId, authorisation, waterSource: 'surface', volumeM3PerYear })).status).toBe(201);
	base = await newRun('Baseline');
	appRun = await application(base, 'Upper dam');
}, 600_000);

describe('the board against full authorised use', () => {
	it('is a fixed row until an editor runs the pair, and none for baseline evidence', async () => {
		const r = await report(viewer, appRun);
		expect(r.version).toBe('evidence-14');
		expect(r.licenceImpactAuthorised).toEqual({ status: 'notBuilt', detail: null, board: null, mix: null, builtAt: null, engineVersion: null });
		expect(r.licenceImpact?.result.status).toBe('ok');
		expect((await report(viewer, base)).licenceImpactAuthorised).toBeNull();
	});

	it('says there is no authorised use when the baseline ran without registered volumes, and refuses to run the pair', async () => {
		expect((await report(viewer, bareApp)).licenceImpactAuthorised?.status).toBe('noAllocations');
		const res = await build(owner, bareApp);
		expect(res.status).toBe(409);
		expect(res.body.error).toMatch(/no registered or licensed volumes/);
	});

	it('is run by an editor only, and only for an application run (control: the owner below)', async () => {
		expect((await build(viewer, appRun)).status).toBe(403);
		expect((await build(owner, base)).status).toBe(409);
		expect((await build(owner, crypto.randomUUID())).status).toBe(404);
	});

	it('runs the pair with every holder at their registered volume and keeps its board and the volumes’ mix', async () => {
		const res = await build(owner, appRun);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		const a = res.body.authorised as EvidenceAuthorisedImpact;
		expect(a.status).toBe('ok');
		expect(a.board?.result.status).toBe('ok');
		expect(a.mix).toEqual({
			rows: [
				{ authorisation: 'licence', volumeM3PerYear: 150_000, entitlement: true },
				{ authorisation: 'registration', volumeM3PerYear: 400_000, entitlement: false }
			],
			entitlementM3PerYear: 150_000,
			totalM3PerYear: 550_000
		});
		// Existing use is authorised use now: not the use the baseline modelled.
		const modelled = (await report(viewer, appRun)).licenceImpact!;
		if (a.board?.result.status !== 'ok' || modelled.result.status !== 'ok') throw new Error('boards');
		const existing = (b: typeof a.board) => (b!.result.status === 'ok' ? b!.result.impact.classes.map((c) => c.waterfall?.existingUseM3 ?? null) : []);
		expect(existing(a.board)).not.toEqual(existing(modelled));
		// The report carries it as the headline; a viewer reads it.
		const r = await report(viewer, appRun);
		expect(r.licenceImpactAuthorised).toEqual(a);
	});

	it('keeps one board per run: running it again replaces it', async () => {
		const again = await build(owner, appRun);
		expect(again.status).toBe(200);
		const r = await report(viewer, appRun);
		expect(r.licenceImpactAuthorised?.builtAt).toBe(again.body.authorised.builtAt);
	});

	it('goes stale when the project’s outcome settings change, and says so', async () => {
		expect((await owner.call('PATCH', P(), { settings: { outcomes: { yearClassMethod: 'terciles' } } })).status).toBe(200);
		const r = await report(viewer, appRun);
		expect(r.licenceImpactAuthorised?.status).toBe('stale');
		expect(r.licenceImpactAuthorised?.detail).toMatch(/other outcome settings/);
		expect(r.licenceImpactAuthorised?.board).toBeNull();
		// Run again with them: current.
		expect((await build(owner, appRun)).status).toBe(200);
		expect((await report(viewer, appRun)).licenceImpactAuthorised?.status).toBe('ok');
	});
});
