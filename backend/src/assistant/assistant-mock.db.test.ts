// The whole assistant turn against Postgres (issue #610): the orchestrator,
// the scripted mock provider and the real tools (ASSISTANT_TOOLS), each tool
// in a read-only transaction as the member, the way routes.ts runs them. On a
// seeded project with a gauge and a dam above it:
//  - the gauge question reads the network, the runoff of the dam above the
//    gauge, the gauge's outflow and its fit, and answers in the mock's four
//    lines with the real names and the numbers the tools read (checked
//    against the tools called directly);
//  - the recommendation emits a `proposal` with at least one diff line;
//  - a viewer kept from the registered volumes gets none of a cap run's series
//    or fit through it, and no volume anywhere in what the model was sent;
//    the owner gets the numbers (positive control).
// Synthetic data only.
import { beforeAll, describe, expect, it } from 'vitest';
import { asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { assistantConfig } from './config.js';
import { runTurn } from './orchestrator.js';
import { mockProvider } from './providers/mock.js';
import { ASSISTANT_TOOLS } from './tools/index.js';
import { TOOL_NAMES, type AssistantProvider, type AssistantStreamEvent, type ProviderRequest, type ToolResult } from './types.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let viewer: User;
let projectId: string;
let runId: string;
const weir = { ...node('Middle weir', null, { damCapacityM3: 0 }), sortOrder: 0 };
const outlet = { ...node('Outlet', null, { damCapacityM3: 0 }), sortOrder: 1 };
const upper = node('Upper dam farm', weir.id, { damCapacityM3: 40_000, sortOrder: 2 });
const lower = node('Lower', outlet.id, { damCapacityM3: 0, sortOrder: 3 });
const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.9) };
const VOLUME = 987_600;
const GAUGE_Q = 'Why does the simulated flow at the gauge not respond to rainfall?';

/** The weir drains into the outlet; built here so both gauges keep their kind. */
weir.downstreamNodeId = outlet.id;

const markMode = (mode: string) =>
	asOwner(`UPDATE model_run SET summary = jsonb_set(summary, '{allocations}', $2::jsonb) WHERE id = $1`, [
		runId,
		JSON.stringify({ mode, tolerance: 0.1, used: 1, notMatched: 0, nodes: [{ nodeId: upper.id, registeredM3PerYear: VOLUME }] })
	]);

/** One turn as `u`, through the mock and the real tools; also what the model was sent. */
async function turn(u: User, question: string) {
	const mock = mockProvider();
	const sent: ProviderRequest[] = [];
	const provider: AssistantProvider = {
		name: 'mock',
		complete: (req) => {
			sent.push({ ...req, messages: [...req.messages] });
			return mock.complete(req);
		}
	};
	const events: AssistantStreamEvent[] = [];
	const out = await runTurn(
		{
			provider,
			tools: ASSISTANT_TOOLS,
			cfg: assistantConfig({}),
			emit: (e) => events.push(e),
			runTool: (tool, args) => withUser(u.id, (db) => tool.run({ db, userId: u.id, projectId, runId }, args), { readOnly: true })
		},
		[{ role: 'user', content: question }]
	);
	const text = events.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('');
	return { out, events, text, sent };
}

/** A tool called directly as `u`, as the turn calls it. */
const direct = (u: User, name: string, args: unknown) =>
	withUser(u.id, (db) => ASSISTANT_TOOLS.find((t) => t.spec.name === name)!.run({ db, userId: u.id, projectId, runId }, args), { readOnly: true });
const data = (r: ToolResult) => {
	if (!r.ok) throw new Error(r.error);
	return r.data as Record<string, unknown>;
};
const f2 = (n: unknown) => (typeof n === 'number' ? n.toFixed(2) : 'not available');

beforeAll(async () => {
	[owner, viewer] = (await Promise.all(['Owner', 'Viewer'].map((n) => signUp(`Mock${n}`)))) as [User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Assistant mock' })).body.project.id;
	const at = `/projects/${projectId}`;
	const model = { nodes: [weir, outlet, upper, lower], crops: [crop], cropAreas: [{ nodeId: upper.id, cropId: crop.id, areaM2: 50_000 }], transfers: [] };
	expect((await owner.call('PUT', `${at}/model`, model)).status).toBe(200);
	expect((await owner.call('PATCH', at, { settings: { apanMm: monthly(150), calibration: { rainThresholdMm: 2, catchmentAreaKm2: 40 } } })).status).toBe(200);
	const days = 400;
	const rain = Array.from({ length: days }, (_, i) => (i % 9 === 0 ? 25 : i % 4 === 0 ? 3 : 0));
	expect((await owner.call('PUT', `${at}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: rain })).status).toBe(200);
	const flow = (scale: number) => Array.from({ length: days }, (_, i) => (i % 5 === 2 ? null : scale * (0.2 + 0.1 * Math.sin(i / 15))));
	expect((await owner.call('PUT', `${at}/series`, { kind: 'flow_observed_m3s', name: 'Outlet record', unit: 'm3/s', startDate: '2021-10-01', values: flow(2) })).status).toBe(200);
	const rec = (await owner.call('PUT', `${at}/series`, { kind: 'flow_observed_m3s', name: 'Weir record', unit: 'm3/s', startDate: '2021-10-01', values: flow(1) })).body.id as string;
	expect((await owner.call('PATCH', `${at}/series/${rec}`, { siteNodeId: weir.id })).status).toBe(200);
	const run = await owner.call('POST', `${at}/runs`, { label: 'Mock' });
	expect(run.status, JSON.stringify(run.body)).toBe(201);
	runId = run.body.run.id;
	expect((await owner.call('POST', `${at}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
	// A registered volume on the dam farm, as a run with allocations stores it (planted; assistant-tools.db.test.ts does the same).
	await asOwner(`UPDATE model_run SET inputs = jsonb_set(inputs, '{model,allocations}', $2::jsonb) WHERE id = $1`, [
		runId,
		JSON.stringify([{ id: crypto.randomUUID(), nodeId: upper.id, waterSource: 'surface', volumeM3PerYear: VOLUME }])
	]);
	await markMode('none');
}, 120_000);

describe('a mock turn through the real tools', () => {
	it('answers the gauge question in its four lines, with the real names and the numbers the tools read', async () => {
		const { out, events, text } = await turn(viewer, GAUGE_Q);
		expect(out.end).toBe('answered');
		const tools = events.flatMap((e) => (e.type === 'tool' && e.status !== 'start' ? [[e.name, e.status]] : []));
		expect(tools).toEqual([
			[TOOL_NAMES.network, 'done'],
			[TOOL_NAMES.series, 'done'],
			[TOOL_NAMES.series, 'done'],
			[TOOL_NAMES.gaugeFit, 'done']
		]);
		const runoff = data(await direct(viewer, TOOL_NAMES.series, { node: upper.id, key: 'runoff' }));
		const outflow = data(await direct(viewer, TOOL_NAMES.series, { node: weir.id, key: 'outflow' }));
		const stats = data(await direct(viewer, TOOL_NAMES.gaugeFit, { node: weir.id })).stats as Record<string, number>;
		expect(typeof outflow.mean).toBe('number');
		expect(typeof stats.nse).toBe('number');
		expect(text.split('\n')).toEqual([
			'Gauge Middle weir has 1 dam(s) upstream: Upper dam farm.',
			`Runoff at Upper dam farm averages ${f2(runoff.mean)} and the gauge’s outflow ${f2(outflow.mean)} in the series read.`,
			`The fit at the gauge: NSE ${f2(stats.nse)}, KGE ${f2(stats.kge)}, PBIAS ${f2(stats.pbias)}.`,
			'The dams upstream fill before they spill, so rain above them reaches the gauge only once they are full: check their capacity and starting level before changing GR4J.'
		]);
		expect(text).not.toContain('not available');
	});

	it('emits a validated proposal with at least one diff line for the recommendation', async () => {
		const { events, text } = await turn(owner, 'What would you recommend to improve the fit?');
		const proposal = events.find((e) => e.type === 'proposal');
		if (proposal?.type !== 'proposal') throw new Error(`no proposal: ${text}`);
		expect(proposal.proposal.patch).toEqual({ gr4j: { x4: 2 } });
		expect(proposal.proposal.diff.length).toBeGreaterThanOrEqual(1);
		expect(proposal.proposal.diff.some((d) => d.after.includes('2'))).toBe(true);
		expect(text).toMatch(/^I have proposed one change: GR4J X4/);
	});

	it('gives a viewer kept from the volumes none of a cap run’s series or fit, and no volume in anything sent; the owner gets the numbers', async () => {
		await markMode('cap');
		try {
			const v = await turn(viewer, GAUGE_Q);
			expect(v.text.split('\n').slice(1, 3)).toEqual([
				'Runoff at Upper dam farm averages not available and the gauge’s outflow not available in the series read.',
				'The fit at the gauge: NSE not available, KGE not available, PBIAS not available.'
			]);
			const sentToModel = JSON.stringify(v.sent.map((r) => r.messages));
			expect(sentToModel).toMatch(/registered water volume/);
			expect(sentToModel).not.toContain(String(VOLUME));
			// Positive control: the owner reads them through the same turn.
			const o = await turn(owner, GAUGE_Q);
			expect(o.text).not.toContain('not available');
		} finally {
			await markMode('none');
		}
	});
});
