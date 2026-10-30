// The assistant's read-only tools against Postgres (issue #610): they run in a
// READ ONLY transaction as the signed-in member, and they go through the run
// routes' withholding (runs/read.ts; #523 I, D3): a viewer kept from each
// registered volume gets no allocation series or volume through them, nor any
// series of a cap run; the owner reads them all (positive control). A gauge's
// fit is the engine's calibrationStats on its stored outflow and record.
// Synthetic data only.
import { calibrationStats } from '@water-management/engine';
import { beforeAll, describe, expect, it } from 'vitest';
import { asOwner, monthly, node, signUp } from '../../__tests__/helpers.js';
import { withUser } from '../../db/tx.js';
import { TOOL_NAMES, type ToolResult } from '../types.js';
import { READ_TOOLS } from './readTools.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let viewer: User;
let farmer: User;
let stranger: User;
let projectId: string;
let runId: string;
const outlet = node('Outlet', null);
const weir = { ...node('Middle weir', outlet.id), kind: 'gauge', damCapacityM3: 0 };
const upper = node('Upper', weir.id, { damCapacityM3: 40_000 });
const lower = node('Lower', outlet.id);
const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.9) };
// Four significant digits, as the tools round it.
const VOLUME = 987_600;

const tool = (name: string) => READ_TOOLS.find((t) => t.spec.name === name)!;
/** Run a tool as `u`, the way the orchestrator does: inside withUser(…, { readOnly: true }). */
const as = (u: User, name: string, args: unknown, rid: string | null = runId) =>
	withUser(u.id, (db) => tool(name).run({ db, userId: u.id, projectId, runId: rid }, args), { readOnly: true });
const data = (r: ToolResult) => {
	if (!r.ok) throw new Error(r.error);
	return r.data as Record<string, unknown>;
};
const markMode = (mode: string) =>
	asOwner(`UPDATE model_run SET summary = jsonb_set(summary, '{allocations}', $2::jsonb) WHERE id = $1`, [
		runId,
		JSON.stringify({ mode, tolerance: 0.1, used: 1, notMatched: 0, nodes: [{ nodeId: upper.id, registeredM3PerYear: VOLUME }] })
	]);

beforeAll(async () => {
	[owner, viewer, farmer, stranger] = (await Promise.all(['Owner', 'Viewer', 'Farmer', 'Stranger'].map((n) => signUp(`Tools${n}`)))) as [User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Assistant tools' })).body.project.id;
	const at = `/projects/${projectId}`;
	const model = { nodes: [outlet, weir, upper, lower], crops: [crop], cropAreas: [{ nodeId: upper.id, cropId: crop.id, areaM2: 50_000 }], transfers: [] };
	expect((await owner.call('PUT', `${at}/model`, model)).status).toBe(200);
	expect((await owner.call('PATCH', at, { settings: { apanMm: monthly(150), calibration: { rainThresholdMm: 2, catchmentAreaKm2: 40 } } })).status).toBe(200);
	const days = 400;
	const rain = Array.from({ length: days }, (_, i) => (i % 9 === 0 ? 25 : i % 4 === 0 ? 3 : 0));
	expect((await owner.call('PUT', `${at}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: rain })).status).toBe(200);
	const flow = (scale: number) => Array.from({ length: days }, (_, i) => (i % 5 === 2 ? null : scale * (0.2 + 0.1 * Math.sin(i / 15))));
	expect((await owner.call('PUT', `${at}/series`, { kind: 'flow_observed_m3s', name: 'Outlet record', unit: 'm3/s', startDate: '2021-10-01', values: flow(2) })).status).toBe(200);
	const rec = (await owner.call('PUT', `${at}/series`, { kind: 'flow_observed_m3s', name: 'Weir record', unit: 'm3/s', startDate: '2021-10-01', values: flow(1) })).body.id as string;
	expect((await owner.call('PATCH', `${at}/series/${rec}`, { siteNodeId: weir.id })).status).toBe(200);
	const run = await owner.call('POST', `${at}/runs`, { label: 'Tools' });
	expect(run.status, JSON.stringify(run.body)).toBe(201);
	runId = run.body.run.id;
	expect((await owner.call('POST', `${at}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
	expect((await owner.call('POST', `${at}/farmers`, { email: farmer.email, nodeIds: [upper.id] })).status).toBe(201);
	// A run that ran with a registered volume on Upper (the engine writes these only with allocations; planted here):
	// its copy of the volume in the model and summary, and an allocation series at Upper.
	await asOwner(`UPDATE model_run SET inputs = jsonb_set(inputs, '{model,allocations}', $2::jsonb) WHERE id = $1`, [
		runId,
		JSON.stringify([{ id: crypto.randomUUID(), nodeId: upper.id, waterSource: 'surface', volumeM3PerYear: VOLUME }])
	]);
	await markMode('none');
	await asOwner(
		`INSERT INTO run_series (run_id, project_id, node_id, key, meta, "values") VALUES ($1, $2, $3, 'allocation_room_surface', '{"label":"Allocation cap room","unit":"m³/day"}', $4)`,
		[runId, projectId, upper.id, Array.from({ length: days }, () => VOLUME / 365)]
	);
}, 120_000);

describe('the read-only tools', () => {
	it('run in a READ ONLY transaction, every one answering for a viewer', async () => {
		const results = await withUser(
			viewer.id,
			async (db) => {
				const { rows } = await db.query<{ ro: string }>("SELECT current_setting('transaction_read_only') AS ro");
				expect(rows[0]!.ro).toBe('on');
				const ctx = { db, userId: viewer.id, projectId, runId: null };
				const calls: [string, unknown][] = [
					[TOOL_NAMES.runSummary, {}],
					[TOOL_NAMES.settings, { keys: ['gr4j', 'calibrationStart'] }],
					[TOOL_NAMES.network, {}],
					[TOOL_NAMES.series, { node: 'Middle weir', key: 'outflow' }],
					[TOOL_NAMES.gaugeFit, { node: weir.id }],
					[TOOL_NAMES.searchHelp, { query: 'dam' }],
					[TOOL_NAMES.runReadiness, {}]
				];
				const out: ToolResult[] = [];
				for (const [name, args] of calls) out.push(await tool(name).run(ctx, args));
				return out;
			},
			{ readOnly: true }
		);
		for (const r of results) expect(r.ok, JSON.stringify(r)).toBe(true);
		// The latest run is used when the conversation names none.
		expect((data(results[0]!).run as { id: string }).id).toBe(runId);
		// Not the run's label (free text, 'Tools' here): only its id, dates and kind.
		expect(data(results[0]!).run).not.toHaveProperty('label');
	});


	it("answers a gauge's fit with calibrationStats on its stored outflow and record; the outlet's from the summary", async () => {
		const fit = data(await as(viewer, TOOL_NAMES.gaugeFit, { node: 'middle weir' }));
		const rows = await asOwner(`SELECT key, "values" FROM run_series WHERE run_id = $1 AND node_id = $2 AND key IN ('outflow', 'observed_flow_check')`, [runId, weir.id]);
		// No reading is NaN in the record (or null): never a number.
		const of = (k: string) => (rows.find((r) => r.key === k)!.values as (number | null)[]).map((v) => (v === null || !Number.isFinite(Number(v)) ? null : Number(v)));
		const [run] = await asOwner(`SELECT start_date::text AS start FROM model_run WHERE id = $1`, [runId]);
		const want = calibrationStats(
			of('outflow') as number[],
			of('observed_flow_check').map((v) => (v === null ? null : v / 86_400)),
			{ startDate: run.start, windowStart: null, windowEnd: null, exclusions: [] }
		);
		const stats = fit.stats as { days: number; nse: number; kge: number };
		expect(stats.days).toBe(want.days);
		expect(stats.days).toBeGreaterThan(100);
		expect(stats.nse).toBeCloseTo(want.nse!, 3);
		expect(stats.kge).toBeCloseTo(want.kge!, 3);
		const atOutlet = data(await as(viewer, TOOL_NAMES.gaugeFit, { node: 'Outlet' }));
		expect(atOutlet.source).toMatch(/calibration statistics/);
		expect(await as(viewer, TOOL_NAMES.gaugeFit, { node: 'Upper' })).toEqual({ ok: false, error: 'Upper is not a gauge' });
	});

	it('refuse a stranger and a farmer, a run of another project and a node that isn’t there, in words', async () => {
		expect(await as(stranger, TOOL_NAMES.runSummary, {})).toEqual({ ok: false, error: 'not found' });
		expect(await as(farmer, TOOL_NAMES.network, {})).toEqual({ ok: false, error: 'requires viewer role' });
		expect(await as(viewer, TOOL_NAMES.runSummary, {}, crypto.randomUUID())).toEqual({ ok: false, error: 'not found' });
		const r = await as(viewer, TOOL_NAMES.series, { node: 'Nowhere', key: 'outflow' });
		expect(r.ok === false && r.error).toMatch(/no node "Nowhere"/);
	});
});

describe('get_run_readiness (the 2026-10-30 production test)', () => {
	it('gives an empty project its blockers, and none to a runnable one, with who may start it', async () => {
		const empty = (await owner.call('POST', '/projects', { name: 'Assistant empty' })).body.project.id as string;
		const r = await withUser(owner.id, (db) => tool(TOOL_NAMES.runReadiness).run({ db, userId: owner.id, projectId: empty, runId: null }, {}), { readOnly: true });
		expect(data(r)).toMatchObject({ canStart: false, blockers: ['A run needs a network.', 'A run needs a rainfall series.'], hasRun: false });
		// Positive control: the tools' project runs (it has run), for the viewer and the owner alike; only the owner may start one.
		const viewed = data(await as(viewer, TOOL_NAMES.runReadiness, {}));
		expect(viewed).toMatchObject({ canStart: true, blockers: [], hasRun: true });
		expect(viewed.youCanStartIt).toMatch(/^no: /);
		expect(data(await as(owner, TOOL_NAMES.runReadiness, {})).youCanStartIt).toMatch(/^yes: /);
	});

	it('respects project access: a stranger and a farmer are refused, in words', async () => {
		expect(await as(stranger, TOOL_NAMES.runReadiness, {})).toEqual({ ok: false, error: 'not found' });
		expect(await as(farmer, TOOL_NAMES.runReadiness, {})).toEqual({ ok: false, error: 'requires viewer role' });
	});
});

describe('ids named in the output (the 2026-10-30 production test)', () => {
	/** Every string anywhere in `v` that is a bare id, except a field named `id` (a tool argument, beside its name). */
	const bareIds = (v: unknown, key = ''): string[] => {
		if (typeof v === 'string') return key !== 'id' && /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(v) ? [`${key}: ${v}`] : [];
		if (Array.isArray(v)) return v.flatMap((x) => bareIds(x, key));
		if (v && typeof v === 'object') return Object.entries(v).flatMap(([k, x]) => [...bareIds(k, 'a key'), ...bareIds(x, k)]);
		return [];
	};

	it('names the calibration site, the transfers and the nodes they reference, and says when a node is gone', async () => {
		const pid = (await owner.call('POST', '/projects', { name: 'Assistant names' })).body.project.id as string;
		const at = `/projects/${pid}`;
		const out = node('Outlet', null);
		const gauge = { ...node('Named weir', out.id), kind: 'gauge', damCapacityM3: 0 };
		const up = node('Top farm', gauge.id, { damCapacityM3: 20_000 });
		const transfer = { id: crypto.randomUUID(), fromNodeId: up.id, toNodeId: out.id, months: [1, 2, 3], maxRateM3s: 0.01, dailyCapM3: 0, minStoragePct: 0, enabled: true, priority: 0 };
		expect((await owner.call('PUT', `${at}/model`, { nodes: [out, gauge, up], crops: [], cropAreas: [], transfers: [transfer] })).status).toBe(200);
		const rec = (await owner.call('PUT', `${at}/series`, { kind: 'flow_observed_m3s', name: 'Named record', unit: 'm3/s', startDate: '2021-10-01', values: [1, 2, 3] })).body.id as string;
		expect((await owner.call('PATCH', `${at}/series/${rec}`, { siteNodeId: gauge.id })).status).toBe(200);
		const station = (await owner.call('PUT', `${at}/series`, { kind: 'rain_catchment_mm', name: 'Named station', unit: 'mm', startDate: '2021-10-01', values: [1, 0, 2] })).body.id as string;
		const patched = await owner.call('PATCH', at, { settings: { calibrationSiteNodeId: gauge.id, rainStations: { units: { [up.id]: { stationId: station } } } } });
		expect(patched.status, JSON.stringify(patched.body)).toBe(200);
		// A reference to a node since deleted, planted (the app's checks refuse one on a save).
		await asOwner(`UPDATE project SET settings = jsonb_set(settings, '{calibrationZones}', $2::jsonb) WHERE id = $1`, [pid, JSON.stringify([{ nodeId: crypto.randomUUID(), enabled: false }])]);
		const run = (name: string, args: unknown) => withUser(owner.id, (db) => tool(name).run({ db, userId: owner.id, projectId: pid, runId: null }, args), { readOnly: true });

		const settings = data(await run(TOOL_NAMES.settings, { source: 'project', keys: ['calibrationSiteNodeId', 'rainStations', 'calibrationZones'] }));
		expect(settings.settings).toMatchObject({
			calibrationSiteNodeId: "the gauge 'Named weir'",
			rainStations: { units: { "the hydrological unit 'Top farm'": { stationId: "the series 'Named station'" } } },
			calibrationZones: [{ nodeId: 'a node that no longer exists' }]
		});
		const network = data(await run(TOOL_NAMES.network, { source: 'project' }));
		expect(network.transfers).toEqual([expect.objectContaining({ id: transfer.id, from: 'Top farm', to: 'Outlet' })]);
		expect(network.nodes).toContainEqual(expect.objectContaining({ id: up.id, name: 'Top farm', drainsInto: "the gauge 'Named weir'" }));
		for (const [name, result] of [['settings', settings], ['network', network]] as const) expect(bareIds(result), name).toEqual([]);
	});
});

describe('the withholding (#523 I, D3)', () => {
	it('gives a viewer kept from the volumes no allocation series and no volume; the owner reads both (positive control)', async () => {
		const refused = await as(viewer, TOOL_NAMES.series, { node: 'Upper', key: 'allocation_room_surface' });
		expect(refused).toMatchObject({ ok: false, error: expect.stringMatching(/registered water volume/) });
		// Not listed among Upper's series either.
		const unknown = await as(viewer, TOOL_NAMES.series, { node: 'Upper', key: 'no_such_key' });
		expect(unknown.ok === false && unknown.error).toMatch(/it has: .*outflow/);
		expect(unknown.ok === false && unknown.error).not.toMatch(/allocation_room/);
		const summary = data(await as(viewer, TOOL_NAMES.runSummary, { sections: ['allocations', 'catchment'] }));
		expect((summary.allocations as { nodes: unknown[] }).nodes).toEqual([]);
		expect(summary.withheldSeries).toBe(1);
		const everything = await Promise.all(READ_TOOLS.filter((t) => t.spec.name !== TOOL_NAMES.searchHelp).map((t) => as(viewer, t.spec.name, {})));
		expect(JSON.stringify(everything)).not.toContain(String(VOLUME));

		const own = data(await as(owner, TOOL_NAMES.series, { node: 'Upper', key: 'allocation_room_surface', resolution: 'water_year' }));
		expect(own.mean).toBeCloseTo(VOLUME / 365, 0);
		const ownSummary = data(await as(owner, TOOL_NAMES.runSummary, { sections: ['allocations'] }));
		expect(JSON.stringify(ownSummary.allocations)).toContain(String(VOLUME));
	});

	it('gives that viewer no series at all of a cap run, nor a gauge fit; the owner reads them (positive control)', async () => {
		await markMode('cap');
		try {
			for (const [name, args] of [
				[TOOL_NAMES.series, { node: 'Middle weir', key: 'outflow' }],
				[TOOL_NAMES.gaugeFit, { node: 'Middle weir' }]
			] as const)
				expect(await as(viewer, name, args)).toMatchObject({ ok: false, error: expect.stringMatching(/registered water volume/) });
			expect(data(await as(owner, TOOL_NAMES.series, { node: 'Middle weir', key: 'outflow' })).points).not.toEqual([]);
			expect(data(await as(owner, TOOL_NAMES.gaugeFit, { node: 'Middle weir' })).stats).toMatchObject({ days: expect.any(Number) });
		} finally {
			await markMode('none');
		}
	});

	it('sends no member’s name or email', async () => {
		const all = await Promise.all(READ_TOOLS.filter((t) => t.spec.name !== TOOL_NAMES.searchHelp).map((t) => as(owner, t.spec.name, {})));
		const json = JSON.stringify(all);
		for (const who of [owner, viewer, farmer]) expect(json).not.toContain(who.email);
		expect(json).not.toMatch(/Tools(Owner|Viewer|Farmer)/);
	});
});

// Last: it signs the rules and adds a run, which the tests above don't expect.
describe('the sign-off', () => {
	it('sends whether the calibration rules are signed off and when, not the name typed to sign them, from the project and from a run', async () => {
		const at = `/projects/${projectId}`;
		const signer = `Synthetic Signer ${crypto.randomUUID().slice(0, 6)}`;
		const rules = (await owner.call('GET', at)).body.project.settings.calibrationRules;
		expect((await owner.call('PATCH', at, { settings: { calibrationRules: { ...rules, signedOff: { by: signer, on: '2026-09-29' } } } })).status).toBe(200);
		// The server stamps the day it was signed.
		const on = (await owner.call('GET', at)).body.project.settings.calibrationRules.signedOff.on as string;
		const signedRun = (await owner.call('POST', `${at}/runs`, { label: 'Signed' })).body.run.id as string;
		for (const [source, runId] of [
			['project', null],
			['run', signedRun]
		] as const) {
			const view = data(await as(viewer, TOOL_NAMES.settings, { source, keys: ['calibrationRules'] }, runId ?? undefined));
			expect(view.settings, source).toMatchObject({ calibrationRules: { signedOff: { signed: true, on } } });
			expect(JSON.stringify(view), source).not.toContain(signer);
		}
		// Positive control: the stored settings do hold the name.
		expect(JSON.stringify((await owner.call('GET', at)).body.project.settings.calibrationRules)).toContain(signer);
	});
});
