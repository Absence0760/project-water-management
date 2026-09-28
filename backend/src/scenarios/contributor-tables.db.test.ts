// The contributor role (044_contributor_role, WP-3.3) against every table
// added while WP-3.3 was in flight: sign-offs (036), notes (037), allocations
// (038), API keys (039), yield results and job progress (040), dam survey
// columns on node (041) and boreholes (043). A contributor ranks below viewer,
// so each viewer policy refuses them; the farm-scoped policies
// (app_farm_nodes) give them what a farmer with the same links reads, their
// own farm's rows and nothing else. And 045 keeps a viewer out of what these
// tables say about an application hidden from them (a note on its run, a
// sign-off of it, a yield of it). Every "cannot see" has a positive control.
import { beforeAll, describe, expect, it } from 'vitest';
import { asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let editor: User;
let viewer: User;
let applicant: User; // contributor, linked to Rooikloof
let farmer: User; // farmer, linked to Kalkoenkrans
let projectId: string;
let published: string;
const outlet = node('Gauge', null);
const rooikloof = node('Rooikloof', outlet.id, {
	damCapacityM3: 100_000,
	damCurve: [
		{ levelM: 0, areaM2: 0, volumeM3: 0 },
		{ levelM: 4, areaM2: 40_000, volumeM3: 100_000 }
	]
});
const kalkoenkrans = node('Kalkoenkrans', outlet.id, { damCapacityM3: 50_000 });
const others = ['Bergvliet', 'Doornhoek', 'Waterval'].map((n) => node(n, outlet.id));
const crop = { id: crypto.randomUUID(), name: 'Citrus', cropFactor: monthly(0.7) };
const P = () => `/projects/${projectId}`;

const rowsAs = async <T = Record<string, unknown>>(u: User, sql: string, params: unknown[] = []) =>
	withUser(u.id, async (db) => (await db.query<T & Record<string, unknown>>(sql, params)).rows);
const idsAs = async (u: User, table: string) => (await rowsAs<{ id: string }>(u, `SELECT id FROM ${table} WHERE project_id = $1 ORDER BY id`, [projectId])).map((r) => r.id);

const sha = 'a'.repeat(64);
const insertSignoff = async (runId: string) =>
	(
		await asOwner(
			`INSERT INTO signoff (project_id, run_id, user_id, full_name, registration_body, registration_no, scope, statement_version, statement_sha256, disclaimer_version)
			 VALUES ($1, $2, $3, 'A. Hydrologist', 'SACNASP', '400123/15', 'the hydrology', 'signoff-1', $4, 'd-1') RETURNING id`,
			[projectId, runId, owner.id, sha]
		)
	)[0].id as string;
const insertNote = async (body: string, target: { nodeId?: string; runId?: string }, visibility: 'team' | 'farm' = 'team') =>
	(
		await asOwner(`INSERT INTO note (project_id, author_id, body, node_id, run_id, visibility) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`, [
			projectId,
			owner.id,
			body,
			target.nodeId ?? null,
			target.runId ?? null,
			visibility
		])
	)[0].id as string;
const insertYield = async (target: { runId?: string; scenarioId?: string }) =>
	(
		await asOwner(
			`INSERT INTO yield_result (project_id, run_id, scenario_id, node_id, kind, params, points, engine_version)
			 VALUES ($1, $2, $3, $4, 'firm', '{}', '{}', '0.36.0') RETURNING id`,
			[projectId, target.runId ?? null, target.scenarioId ?? null, rooikloof.id]
		)
	)[0].id as string;

beforeAll(async () => {
	[owner, editor, viewer, applicant, farmer] = (await Promise.all(['Ctowner', 'Cteditor', 'Ctviewer', 'Ctapplicant', 'Ctfarmer'].map((n) => signUp(n)))) as [
		User,
		User,
		User,
		User,
		User
	];
	projectId = (await owner.call('POST', '/projects', { name: 'Contributor tables' })).body.project.id;
	const model = {
		nodes: [outlet, rooikloof, kalkoenkrans, ...others],
		crops: [crop],
		cropAreas: [rooikloof, kalkoenkrans].map((f) => ({ nodeId: f.id, cropId: crop.id, areaM2: 40_000 })),
		transfers: [],
		boreholes: [
			{ id: crypto.randomUUID(), nodeId: rooikloof.id, name: 'BH-R', capacityM3Day: 200, annualCapM3: 40_000 },
			{ id: crypto.randomUUID(), nodeId: kalkoenkrans.id, name: 'BH-K', capacityM3Day: 100, annualCapM3: null }
		]
	};
	const put = await owner.call('PUT', `${P()}/model`, model);
	expect(put.status, JSON.stringify(put.body)).toBe(200);
	expect((await owner.call('PATCH', P(), { settings: { apanMm: monthly(150) } })).status).toBe(200);
	const rain = Array.from({ length: 60 }, (_, i) => (i % 7 === 0 ? 20 : 0));
	expect((await owner.call('PUT', `${P()}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: rain })).status).toBe(200);
	const run = await owner.call('POST', `${P()}/runs`, { label: 'Baseline' });
	expect(run.status, JSON.stringify(run.body)).toBe(201);
	published = run.body.run.id;
	expect((await owner.call('POST', `${P()}/publication`, { runId: published })).status).toBe(201);
	for (const [u, role] of [
		[editor, 'editor'],
		[viewer, 'viewer'],
		[applicant, 'contributor']
	] as const)
		expect((await owner.call('POST', `${P()}/members`, { email: u.email, role })).status).toBe(201);
	expect((await owner.call('POST', `${P()}/farmers`, { email: farmer.email, nodeIds: [kalkoenkrans.id] })).status).toBe(201);
	expect((await owner.call('PUT', `${P()}/farmers/${applicant.id}`, { nodeIds: [rooikloof.id] })).status).toBe(200);
	for (const [n, holder] of [
		[rooikloof, 'R. Holder'],
		[kalkoenkrans, 'K. Holder']
	] as const) {
		const a = await owner.call('POST', `${P()}/allocations`, { nodeId: n.id, authorisation: 'licence', waterSource: 'surface', volumeM3PerYear: 1000, holder });
		expect(a.status, JSON.stringify(a.body)).toBe(201);
	}
	const text = 'registration_no,farm,authorisation,water_source,volume_m3_year\nCT-1,Rooikloof,licence,surface,500\n';
	expect((await owner.call('POST', `${P()}/allocations/import/commit`, { kind: 'csv', fileName: 'ct.csv', text })).status).toBe(201);
}, 60_000);

describe('a contributor and the tables added alongside WP-3.3', () => {
	it('reads no sign-off (a viewer does)', async () => {
		const id = await insertSignoff(published);
		expect(await idsAs(applicant, 'signoff')).toEqual([]);
		expect(await idsAs(viewer, 'signoff')).toContain(id);
	});

	it('reads only the farm-visible notes on their own farm, as a farmer does on theirs', async () => {
		const team = await insertNote('about the project', {});
		const own = await insertNote('about Rooikloof, to its farmers', { nodeId: rooikloof.id }, 'farm');
		const theirs = await insertNote('about Kalkoenkrans, to its farmers', { nodeId: kalkoenkrans.id }, 'farm');
		const onRun = await insertNote('about the baseline', { runId: published });
		expect(await idsAs(applicant, 'note')).toEqual([own]);
		expect(await idsAs(farmer, 'note')).toEqual([theirs]);
		expect((await idsAs(viewer, 'note')).sort()).toEqual([team, own, theirs, onRun].sort());
	});

	it('may add a note only to their own farm, shown to the farm (the route treats them as a farmer)', async () => {
		const team = await applicant.call('POST', `${P()}/notes`, { body: 'a team note' });
		expect(team.status).toBe(403);
		const other = await applicant.call('POST', `${P()}/notes`, { body: 'on a neighbour', nodeId: kalkoenkrans.id });
		expect(other.status).toBe(404);
		const own = await applicant.call('POST', `${P()}/notes`, { body: 'on my farm', nodeId: rooikloof.id });
		expect(own.status, JSON.stringify(own.body)).toBe(201);
		expect(own.body.note).toMatchObject({ visibility: 'farm', nodeId: rooikloof.id, mine: true });
	});

	it('reads their own farm’s allocations and holder name, no other farm’s, and no import record', async () => {
		const mine = await rowsAs<{ node_id: string }>(applicant, 'SELECT node_id FROM allocation WHERE project_id = $1', [projectId]);
		expect(mine.length).toBe(2);
		expect(new Set(mine.map((r) => r.node_id))).toEqual(new Set([rooikloof.id]));
		const names = await rowsAs<{ user_display: string }>(applicant, 'SELECT user_display FROM allocation_holder WHERE project_id = $1', [projectId]);
		expect(names.map((r) => r.user_display)).toEqual(['R. Holder']);
		expect(await idsAs(applicant, 'allocation_source')).toEqual([]);
		// Positive controls: a viewer reads every volume and the import, an editor every name.
		expect((await idsAs(viewer, 'allocation')).length).toBe(3);
		expect((await idsAs(viewer, 'allocation_source')).length).toBe(1);
		expect((await rowsAs(editor, 'SELECT 1 FROM allocation_holder WHERE project_id = $1', [projectId])).length).toBe(2);
		// The API refuses them the Allocations tab's routes, as it does a farmer.
		expect((await applicant.call('GET', `${P()}/allocations`)).status).toBe(403);
	});

	it('reads no yield result and no job (a viewer does)', async () => {
		const y = await insertYield({ runId: published });
		const job = await withUser(owner.id, async (db) => (await db.query<{ id: string }>(`INSERT INTO job (project_id, kind) VALUES ($1, 'rerun') RETURNING id`, [projectId])).rows[0]!.id);
		expect(await idsAs(applicant, 'yield_result')).toEqual([]);
		expect(await idsAs(applicant, 'job')).toEqual([]);
		expect(await idsAs(viewer, 'yield_result')).toContain(y);
		expect(await idsAs(viewer, 'job')).toContain(job);
		expect((await applicant.call('GET', `${P()}/yield?runId=${published}`)).status).toBe(403);
	});

	it('reads no API key (the owner does)', async () => {
		const key = (await asOwner(`INSERT INTO api_key (project_id, name, key_hash, created_by) VALUES ($1, 'Logger', $2, $3) RETURNING id`, [projectId, Buffer.alloc(32, 7), owner.id]))[0]
			.id as string;
		expect(await idsAs(applicant, 'api_key')).toEqual([]);
		expect(await idsAs(viewer, 'api_key')).toEqual([]);
		expect(await idsAs(owner, 'api_key')).toContain(key);
	});

	it('reads their own farm’s boreholes and survey curve, and nothing of a neighbour’s', async () => {
		const bh = await rowsAs<{ name: string }>(applicant, 'SELECT name FROM borehole WHERE project_id = $1', [projectId]);
		expect(bh.map((r) => r.name)).toEqual(['BH-R']);
		expect((await rowsAs<{ name: string }>(farmer, 'SELECT name FROM borehole WHERE project_id = $1', [projectId])).map((r) => r.name)).toEqual(['BH-K']);
		expect((await rowsAs(viewer, 'SELECT 1 FROM borehole WHERE project_id = $1', [projectId])).length).toBe(2);
		const nodes = await rowsAs<{ id: string; dam_curve: unknown }>(applicant, `SELECT id, dam_curve FROM node WHERE project_id = $1 AND kind = 'farm'`, [projectId]);
		expect(nodes.map((n) => n.id)).toEqual([rooikloof.id]);
		expect(nodes[0]!.dam_curve).toHaveLength(2);
		// A contributor never writes one.
		await expect(withUser(applicant.id, (db) => db.query(`INSERT INTO borehole (project_id, node_id, name, capacity_m3_day) VALUES ($1, $2, 'mine', 10)`, [projectId, rooikloof.id]))).rejects.toThrow(
			/row-level security/
		);
	});
});

describe('what these tables say about an application hidden from a viewer (045)', () => {
	let sid: string;
	let appRun: string;
	let note: string;
	let signoff: string;
	let yieldOnScenario: string;
	let yieldOnRun: string;

	beforeAll(async () => {
		const s = await applicant.call('POST', `${P()}/scenarios`, {
			name: 'Raise Rooikloof',
			baseRunId: published,
			ops: [{ op: 'node.set', nodeId: rooikloof.id, field: 'damCapacityM3', value: 120_000 }]
		});
		expect(s.status, JSON.stringify(s.body)).toBe(201);
		sid = s.body.scenario.id;
		const r = await applicant.call('POST', `${P()}/scenarios/${sid}/runs`, { label: 'draft run' });
		expect(r.status, JSON.stringify(r.body)).toBe(201);
		appRun = r.body.run.id;
		note = await insertNote('about the application run', { runId: appRun });
		signoff = await insertSignoff(appRun);
		yieldOnScenario = await insertYield({ scenarioId: sid });
		yieldOnRun = await insertYield({ runId: appRun });
	});

	it('a draft: neither a viewer nor an editor reads its run’s note, sign-off or yields', async () => {
		for (const u of [viewer, editor]) {
			expect(await idsAs(u, 'note')).not.toContain(note);
			expect(await idsAs(u, 'signoff')).not.toContain(signoff);
			const ys = await idsAs(u, 'yield_result');
			expect(ys).not.toContain(yieldOnScenario);
			expect(ys).not.toContain(yieldOnRun);
		}
	});

	it('submitted: the editor (an assessor) reads them, a viewer still doesn’t until it is decided', async () => {
		expect((await applicant.call('POST', `${P()}/scenarios/${sid}/submit`)).status).toBe(200);
		expect(await idsAs(editor, 'note')).toContain(note);
		expect(await idsAs(editor, 'signoff')).toContain(signoff);
		expect(await idsAs(editor, 'yield_result')).toEqual(expect.arrayContaining([yieldOnScenario, yieldOnRun]));
		expect(await idsAs(viewer, 'note')).not.toContain(note);
		expect(await idsAs(viewer, 'signoff')).not.toContain(signoff);
		expect(await idsAs(viewer, 'yield_result')).not.toContain(yieldOnScenario);
		expect((await editor.call('POST', `${P()}/scenarios/${sid}/decide`, { outcome: 'approved' })).status).toBe(200);
		expect(await idsAs(viewer, 'note')).toContain(note);
		expect(await idsAs(viewer, 'signoff')).toContain(signoff);
		expect(await idsAs(viewer, 'yield_result')).toEqual(expect.arrayContaining([yieldOnScenario, yieldOnRun]));
	});
});

describe('a published forecast run (WP-2.12) as an application’s base', () => {
	it('is refused, as a team scenario’s is; an ordinary published run is the control', async () => {
		expect((await owner.call('PUT', `${P()}/series`, { kind: 'rain_forecast_mm', unit: 'mm', startDate: '2020-03-01', values: new Array(10).fill(4) })).status).toBe(200);
		const f = await owner.call('POST', `${P()}/runs`, { label: 'forecast', forecast: true });
		expect(f.status, JSON.stringify(f.body)).toBe(201);
		expect((await owner.call('POST', `${P()}/publication`, { runId: f.body.run.id })).status).toBe(201);
		const refused = await applicant.call('POST', `${P()}/scenarios`, { name: 'On the forecast', baseRunId: f.body.run.id });
		expect(refused.status, JSON.stringify(refused.body)).toBe(409);
		expect(refused.body.error).toMatch(/forecast run/);
		const team = await editor.call('POST', `${P()}/scenarios`, { name: 'Team on the forecast', baseRunId: f.body.run.id });
		expect(team.status).toBe(409);
		const ok = await applicant.call('POST', `${P()}/scenarios`, { name: 'On the baseline', baseRunId: published });
		expect(ok.status, JSON.stringify(ok.body)).toBe(201);
	});
});
