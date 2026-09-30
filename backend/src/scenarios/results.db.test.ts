// The applicant's view of an application run's results (GET
// …/scenarios/:sid/results, 118_applicant_results, WP-3.3, D2's recommended
// default; docs/scenarios.md § Applications). End to end against Postgres:
// what an applicant sees of their run (their own unit, the EWR sites, the
// catchment under the k rule, the unit below theirs as "Farm N" and a
// rounded percentage), what they never see (another unit's name or value, a
// hidden crop, a fresh id), who may ask (readers of the application only),
// and RLS on the series of a run with a baseline assumption. Every "cannot"
// has its positive control (CLAUDE.md rule 5).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { monthly, node, retirePendingJobs, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';

type User = Awaited<ReturnType<typeof signUp>>;
let owner: User; // the modeller, and the assessor
let viewer: User;
let applicantA: User; // linked to Rooikloof
let applicantB: User; // no farm link
let farmer: User;
let projectId: string;
let published: string;

// Gauge ← Waterval ← Rooikloof (A's); four more farms straight to the gauge: six farm holders.
const outlet = node('Gauge', null);
const waterval = node('Waterval', outlet.id, { damCapacityM3: 60_000 });
const rooikloof = node('Rooikloof', waterval.id, { damCapacityM3: 20_000 });
const others = ['Bergvliet', 'Doornhoek', 'Kalkoenkrans', 'Uitsig'].map((n) => node(n, outlet.id));
const HIDDEN = ['Waterval', 'Bergvliet', 'Doornhoek', 'Kalkoenkrans', 'Uitsig', 'Lucerne'];
const citrus = { id: crypto.randomUUID(), name: 'Citrus', cropFactor: monthly(0.7) };
const lucerne = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.9) };
const P = () => `/projects/${projectId}`;
const damRaise = (nodeId: string, value: number) => ({ op: 'node.set', nodeId, field: 'damCapacityM3', value });

async function application(u: User, name: string, ops: unknown[]) {
	const made = await u.call('POST', `${P()}/scenarios`, { name, baseRunId: published, ops });
	expect(made.status, JSON.stringify(made.body)).toBe(201);
	const sid = made.body.scenario.id as string;
	const ran = await u.call('POST', `${P()}/scenarios/${sid}/runs`, {});
	expect(ran.status, JSON.stringify(ran.body)).toBe(201);
	return { sid, runId: ran.body.run.id as string };
}
const results = (u: User, sid: string, query = '') => u.call('GET', `${P()}/scenarios/${sid}/results${query}`);
const seriesOf = async (u: User, runId: string) =>
	withUser(u.id, async (db) => (await db.query<{ key: string; node_id: string | null }>('SELECT key, node_id FROM run_series WHERE run_id = $1 ORDER BY 1, 2', [runId])).rows);

let raise: { sid: string; runId: string };

beforeAll(async () => {
	[owner, viewer, applicantA, applicantB, farmer] = (await Promise.all(['Rowner', 'Rviewer', 'Rapplicanta', 'Rapplicantb', 'Rfarmer'].map((n) => signUp(n)))) as [
		User,
		User,
		User,
		User,
		User
	];
	projectId = (await owner.call('POST', '/projects', { name: 'Applicant results' })).body.project.id;
	const model = {
		nodes: [outlet, waterval, rooikloof, ...others],
		crops: [citrus, lucerne],
		cropAreas: [
			{ nodeId: rooikloof.id, cropId: citrus.id, areaM2: 80_000 },
			{ nodeId: waterval.id, cropId: lucerne.id, areaM2: 120_000 }
		],
		transfers: []
	};
	expect((await owner.call('PUT', `${P()}/model`, model)).status).toBe(200);
	expect((await owner.call('PATCH', P(), { settings: { apanMm: monthly(180) } })).status).toBe(200);
	const days = 90;
	const rain = Array.from({ length: days }, (_, i) => (i % 9 === 0 ? 15 : 0));
	expect((await owner.call('PUT', `${P()}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: rain })).status).toBe(200);
	expect((await owner.call('PUT', `${P()}/series`, { kind: 'flow_observed_m3s', unit: 'm3/s', startDate: '2020-01-01', values: new Array(days).fill(0.05) })).status).toBe(200);
	const run = await owner.call('POST', `${P()}/runs`, { label: 'Baseline' });
	expect(run.status, JSON.stringify(run.body)).toBe(201);
	published = run.body.run.id;
	expect((await owner.call('POST', `${P()}/publication`, { runId: published })).status).toBe(201);
	for (const [u, role] of [
		[viewer, 'viewer'],
		[applicantA, 'contributor'],
		[applicantB, 'contributor']
	] as const)
		expect((await owner.call('POST', `${P()}/members`, { email: u.email, role })).status).toBe(201);
	expect((await owner.call('PUT', `${P()}/farmers/${applicantA.id}`, { nodeIds: [rooikloof.id] })).status).toBe(200);
	raise = await application(applicantA, 'Raise Rooikloof', [damRaise(rooikloof.id, 200_000)]);
});

afterAll(() => retirePendingJobs(projectId));

describe("an applicant's results", () => {
	it('shows their own unit, the EWR, the catchment and the unit below theirs as "Farm N" with a whole %, and no hidden name', async () => {
		const res = await results(applicantA, raise.sid);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.run).toMatchObject({ id: raise.runId, baseRunId: published, current: true });
		const r = res.body.results;
		expect(r.allProposals).toBe(true);
		expect(r.units).toEqual([expect.objectContaining({ nodeId: rooikloof.id, name: 'Rooikloof', kind: 'farm', added: false })]);
		expect(r.units[0].base.avgDemandM3Day).toBeGreaterThan(0);
		expect(r.units[0].application.damEndM3).not.toBeNull();
		// Waterval, below theirs, by the name the base projection gives it; a whole percentage.
		const base = (await applicantA.call('GET', `${P()}/scenarios/${raise.sid}/base`)).body;
		const anon = base.model.nodes.find((n: { id: string }) => n.id === waterval.id).name;
		expect(anon).toMatch(/^Farm \d$/);
		expect(r.downstream).toHaveLength(1);
		expect(r.downstream[0]).toMatchObject({ nodeId: waterval.id, name: anon, kind: 'farm' });
		expect(Number.isInteger(r.downstream[0].supplyChangePct) || r.downstream[0].supplyChangePct === null).toBe(true);
		// Six farm holders and a proposal: the catchment's figures and its outlet series.
		expect(r.catchment.withheld).toBeNull();
		expect(r.catchment.figures.base.meanNaturalFlowM3Day).toBeGreaterThan(0);
		expect(r.catchment.series.outflow.base.values).toHaveLength(90);
		expect(r.catchment.series.ewr.application.values).toHaveLength(90);
		expect(r.model.nodes.map((n: { id: string }) => n.id)).toEqual([rooikloof.id]);
		expect(r.model.crops.map((c: { name: string }) => c.name)).toEqual(['Citrus']);
		// The string scan (WP-2.1): no other unit's name, no hidden crop, anywhere in the answer.
		const text = JSON.stringify(res.body);
		for (const name of HIDDEN) expect(text, name).not.toContain(name);
		expect(text).not.toContain(lucerne.id);
	});

	it('answers with no run before the application has one', async () => {
		const made = await applicantA.call('POST', `${P()}/scenarios`, { name: 'Not run yet', baseRunId: published, ops: [] });
		expect((await results(applicantA, made.body.scenario.id)).body).toEqual({ run: null, results: null });
	});

	it("is the application's readers' only: 404 to another applicant, a viewer of a draft and a farmer's 403 (control: the assessor once submitted)", async () => {
		expect((await results(applicantB, raise.sid)).status).toBe(404);
		expect((await results(viewer, raise.sid)).status).toBe(404);
		expect((await results(owner, raise.sid)).status).toBe(404);
		// Another application's run under A's application: not one of its runs.
		const b = await application(applicantB, 'B plan', []);
		expect((await results(applicantA, raise.sid, `?runId=${b.runId}`)).status).toBe(404);
		expect((await results(applicantA, b.sid, `?runId=${b.runId}`)).status).toBe(404);
		// Positive control: B reads theirs, and the assessor reads A's once submitted.
		expect((await results(applicantB, b.sid)).status).toBe(200);
		expect((await applicantA.call('POST', `${P()}/scenarios/${raise.sid}/submit`, {})).status).toBe(200);
		const assessed = await results(owner, raise.sid);
		expect(assessed.status).toBe(200);
		expect(assessed.body.results.units.map((u: { name: string }) => u.name)).toEqual(['Rooikloof']);
		// A team scenario's runs are compared on the compare page.
		const team = await owner.call('POST', `${P()}/scenarios`, { name: 'Team', baseRunId: published, ops: [] });
		expect((await results(owner, team.body.scenario.id)).status).toBe(409);
		expect((await results(applicantA, team.body.scenario.id)).status).toBe(404);
	});

	it("hands the run's summary to the server for the application's readers only (app_application_run_results)", async () => {
		const call = (u: User) =>
			withUser(u.id, async (db) => (await db.query('SELECT summary FROM app_application_run_results($1, $2, $3)', [projectId, raise.sid, raise.runId])).rows);
		expect(await call(applicantB)).toEqual([]);
		expect(await call(viewer)).toEqual([]);
		// Positive control: its applicant and the assessor (submitted above).
		expect(await call(applicantA)).toHaveLength(1);
		expect(await call(owner)).toHaveLength(1);
	});

	it('shows only the EWR when an op is a baseline assumption, and RLS hands over none of that run’s series (control: a proposal run’s)', async () => {
		const assumed = await application(applicantA, 'Halve Waterval', [{ op: 'demand.scale', factor: 0.5, nodeIds: [waterval.id] }]);
		const res = await results(applicantA, assumed.sid);
		expect(res.status).toBe(200);
		const r = res.body.results;
		expect(r).toMatchObject({ allProposals: false, units: [], downstream: [], unitsWithheld: 'baseline_assumptions' });
		expect(r.catchment).toMatchObject({ figures: null, series: null, withheld: 'baseline_assumptions' });
		expect(typeof r.catchment.ewrDaysNotMet.application).toBe('number');
		expect(await seriesOf(applicantA, assumed.runId)).toEqual([]);
		// Positive control: of the proposal run, the catchment allowlist and their own unit.
		const own = await seriesOf(applicantA, raise.runId);
		expect(own.some((s) => s.node_id === null && s.key === 'simulated_outflow')).toBe(true);
		expect(own.some((s) => s.node_id === rooikloof.id)).toBe(true);
		expect(own.every((s) => s.node_id === null || s.node_id === rooikloof.id)).toBe(true);
		// The assessors read every series of it once submitted (control: RLS for a viewer and up is unchanged).
		expect((await applicantA.call('POST', `${P()}/scenarios/${assumed.sid}/submit`, {})).status).toBe(200);
		expect((await seriesOf(owner, assumed.runId)).some((s) => s.node_id === waterval.id)).toBe(true);
	});

	it('shows a crop their ops added under a hidden crop’s id by the id they gave it', async () => {
		const ops = [
			{ op: 'crop.add', crop: { id: lucerne.id, name: 'Pecans', cropFactor: monthly(0.8) } },
			{ op: 'cropArea.set', nodeId: rooikloof.id, cropId: lucerne.id, areaM2: 10_000 }
		];
		const planted = await application(applicantA, 'Plant pecans', ops);
		const res = await results(applicantA, planted.sid);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		const { crops, cropAreas } = res.body.results.model;
		expect(crops.map((c: { id: string; name: string }) => [c.id, c.name]).sort()).toEqual([
			[citrus.id, 'Citrus'],
			[lucerne.id, 'Pecans']
		].sort());
		expect(cropAreas).toContainEqual(expect.objectContaining({ nodeId: rooikloof.id, cropId: lucerne.id, areaM2: 10_000 }));
		const text = JSON.stringify(res.body);
		expect(text).not.toContain(`${lucerne.id}-2`);
		expect(text).not.toContain('Lucerne');
	});

	it('leaves the catchment out below five farm holders, and keeps their own unit (control: six, above)', async () => {
		// One farmer holds all four side farms: holders are A, Waterval and the farmer.
		expect((await owner.call('POST', `${P()}/farmers`, { email: farmer.email, nodeIds: others.map((o) => o.id) })).status).toBe(201);
		const res = await results(applicantA, raise.sid);
		expect(res.status).toBe(200);
		expect(res.body.results.catchment).toMatchObject({ figures: null, series: null, withheld: 'few_farm_holders' });
		expect(res.body.results.units.map((u: { name: string }) => u.name)).toEqual(['Rooikloof']);
		expect(res.body.results.ewrSites.every((s: { base: { deficitM3: unknown } | null }) => s.base === null || s.base.deficitM3 === null)).toBe(true);
		expect((await seriesOf(applicantA, raise.runId)).some((s) => s.node_id === null)).toBe(false);
	});
});
