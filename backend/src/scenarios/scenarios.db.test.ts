// Scenarios (roadmap WP-3.2, issue #18; 024_scenarios.sql, docs/scenarios.md):
// the API end to end, and RLS on the scenario table with positive controls.
//  - a dam-raise scenario runs as an ordinary model_run with scenario_id, and
//    its result is exactly runModel(applyScenario(loadRunInput(base)));
//  - editing the live model afterwards (even deleting a node) doesn't change
//    a re-run of the scenario, and a scenario can add a node the live model
//    never had;
//  - a demand.scale (issue #53 R1) is classified by who owns the farms it
//    names (none named: baseline), and its run's stored demand is the base's
//    × the factor on exactly the months it names;
//  - rebasing reports an op that no longer applies, and such a scenario
//    refuses to run (422);
//  - compare shows each side's scenario;
//  - a scenario can't cite another project's run; viewers can't write;
//    farmers can't read; a cited base is kept until its scenario goes;
//  - a submitted scenario is frozen.
import { applyScenario, canonicalJson, runModelChecked, type ScenarioOp } from '@water-management/engine';
import { beforeAll, describe, expect, it } from 'vitest';
import { asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { loadRunInput, PINNED_RUNS_PER_PROJECT_MAX, trimRuns } from '../runs/execute.js';

type User = Awaited<ReturnType<typeof signUp>>;

/** Normalise as JSON storage does (NaN → null, undefined dropped), then canonicalise. */
const canon = (v: unknown) => canonicalJson(JSON.parse(JSON.stringify(v)));

/** Gauge ← Rooikloof, Gauge ← Kalkoenkrans: two farms with dams, rain and observed flow (synthetic). */
async function catchment(owner: User, name = 'Scenario catchment') {
	const { body } = await owner.call('POST', '/projects', { name });
	const projectId = body.project.id as string;
	const outlet = node('Gauge', null);
	const farm = node('Rooikloof', outlet.id, { damCapacityM3: 100_000 });
	const other = node('Kalkoenkrans', outlet.id, { damCapacityM3: 50_000 });
	const crop = { id: crypto.randomUUID(), name: 'Citrus', cropFactor: monthly(0.7) };
	const model = {
		nodes: [outlet, farm, other],
		crops: [crop],
		cropAreas: [
			{ nodeId: farm.id, cropId: crop.id, areaM2: 50_000 },
			{ nodeId: other.id, cropId: crop.id, areaM2: 30_000 }
		],
		transfers: []
	};
	expect((await owner.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
	expect((await owner.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(150) } })).status).toBe(200);
	const days = 90;
	const rain = Array.from({ length: days }, (_, i) => (i % 7 === 0 ? 20 : 0));
	const put = (kind: string, unit: string, values: number[]) => owner.call('PUT', `/projects/${projectId}/series`, { kind, unit, startDate: '2020-01-01', values });
	expect((await put('rain_catchment_mm', 'mm', rain)).status).toBe(200);
	expect((await put('flow_observed_m3s', 'm3/s', new Array(days).fill(0.2))).status).toBe(200);
	return { projectId, model, outlet, farm, other, crop };
}

async function run(u: User, projectId: string, label: string) {
	const res = await u.call('POST', `/projects/${projectId}/runs`, { label });
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.run.id as string;
}

const damRaise = (nodeId: string, value: number): ScenarioOp => ({ op: 'node.set', nodeId, field: 'damCapacityM3', value });

async function create(u: User, projectId: string, body: Record<string, unknown>) {
	const res = await u.call('POST', `/projects/${projectId}/scenarios`, body);
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.scenario.id as string;
}

async function runScenario(u: User, projectId: string, sid: string, label?: string) {
	const res = await u.call('POST', `/projects/${projectId}/scenarios/${sid}/runs`, label ? { label } : {});
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body;
}

const rowsAs = async <T = Record<string, unknown>>(u: User, sql: string, params: unknown[] = []) =>
	withUser(u.id, async (db) => (await db.query<T & Record<string, unknown>>(sql, params)).rows);

describe('a dam-raise scenario', () => {
	let owner: User;
	let c: Awaited<ReturnType<typeof catchment>>;
	let base: string;
	let sid: string;
	let firstRun: { id: string; summary: unknown };

	beforeAll(async () => {
		owner = await signUp('Scenarist');
		c = await catchment(owner);
		base = await run(owner, c.projectId, 'Baseline');
		sid = await create(owner, c.projectId, { name: 'Raise Rooikloof 20 %', baseRunId: base, ops: [damRaise(c.farm.id, 120_000)] });
	});

	it('is created as a draft on its base run, and checked against it', async () => {
		const res = await owner.call('GET', `/projects/${c.projectId}/scenarios/${sid}`);
		expect(res.status).toBe(200);
		expect(res.body.scenario).toMatchObject({
			id: sid,
			name: 'Raise Rooikloof 20 %',
			baseRunId: base,
			baseRun: { id: base, label: 'Baseline' },
			ops: [damRaise(c.farm.id, 120_000)],
			opsSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
			ownedNodeIds: [],
			// The display names its ops need, from the base run's snapshot (047_scenario_op_names).
			opNames: [{ id: c.farm.id, name: 'Rooikloof' }],
			ownerUserId: owner.id,
			status: 'draft',
			runCount: 0,
			lastRun: null
		});
		expect(res.body.check).toEqual({ applied: [{ index: 0, op: damRaise(c.farm.id, 120_000), notes: [expect.stringMatching(/^dam area when full \d+ → \d+ m² along the dam's own area–volume relation/)] }], problems: [], classified: ['baseline'], renamed: [], reIds: [] });
		// The farm made the proposer's own: the same op is a proposal.
		const owned = await owner.call('PATCH', `/projects/${c.projectId}/scenarios/${sid}`, { ownedNodeIds: [c.farm.id] });
		expect(owned.status).toBe(200);
		expect(owned.body.check.classified).toEqual(['proposal']);
		expect((await owner.call('GET', `/projects/${c.projectId}/scenarios`)).body.scenarios.map((s: { id: string }) => s.id)).toEqual([sid]);
	});

	it('runs as an ordinary run with scenario_id, equal to runModel(applyScenario(loadRunInput(base)))', async () => {
		const body = await runScenario(owner, c.projectId, sid);
		expect(body.run).toMatchObject({ label: 'Raise Rooikloof 20 %', scenarioId: sid, scenarioName: 'Raise Rooikloof 20 %', citedBy: [] });
		expect(body.applied).toHaveLength(1);
		expect(body.classified).toEqual(['proposal']);
		firstRun = body.run;
		const stored = await rowsAs<{ scenario_id: string; inputs: { scenario: Record<string, unknown>; model: { nodes: { id: string; damCapacityM3: number }[] } } }>(
			owner,
			'SELECT scenario_id, inputs FROM model_run WHERE id = $1',
			[firstRun.id]
		);
		expect(stored[0]!.scenario_id).toBe(sid);
		expect(stored[0]!.inputs.scenario).toMatchObject({ id: sid, baseRunId: base, ops: [damRaise(c.farm.id, 120_000)], ownedNodeIds: [c.farm.id], classified: ['proposal'] });
		expect(stored[0]!.inputs.model.nodes.find((n) => n.id === c.farm.id)!.damCapacityM3).toBe(120_000);

		const expected = await withUser(owner.id, async (db) => runModelChecked(applyScenario(await loadRunInput(db, base), [damRaise(c.farm.id, 120_000)]).input));
		expect(canon(firstRun.summary)).toBe(canon(expected.summary));
		// And the dam change is real: the base's summary differs.
		const baseSummary = (await owner.call('GET', `/projects/${c.projectId}/runs/${base}`)).body.run.summary;
		expect(canon(baseSummary)).not.toBe(canon(expected.summary));
		// The base is now cited by the scenario.
		expect((await owner.call('GET', `/projects/${c.projectId}/runs`)).body.runs.find((r: { id: string }) => r.id === base).citedBy).toEqual([
			{ kind: 'scenario', id: sid, name: 'Raise Rooikloof 20 %' }
		]);
	});

	it("doesn't change when the live model is edited afterwards, even a node deleted", async () => {
		const edited = structuredClone(c.model);
		edited.nodes = edited.nodes.filter((n) => n.id !== c.other.id);
		edited.cropAreas = edited.cropAreas.filter((a) => a.nodeId !== c.other.id);
		edited.nodes.find((n) => n.id === c.farm.id)!.damCapacityM3 = 10;
		expect((await owner.call('PUT', `/projects/${c.projectId}/model`, edited)).status).toBe(200);
		expect((await owner.call('PATCH', `/projects/${c.projectId}`, { settings: { apanMm: monthly(90) } })).status).toBe(200);

		const again = await runScenario(owner, c.projectId, sid, 'again');
		expect(canon(again.run.summary)).toBe(canon(firstRun.summary));
		// The deleted node's series are still in both scenario runs and the base (run_series no longer cascades from the live node).
		for (const r of [base, firstRun.id, again.run.id]) {
			const n = await rowsAs<{ n: number }>(owner, 'SELECT count(*)::int AS n FROM run_series WHERE run_id = $1 AND node_id = $2', [r, c.other.id]);
			expect(n[0]!.n, r).toBeGreaterThan(0);
		}
		expect((await owner.call('GET', `/projects/${c.projectId}/scenarios/${sid}`)).body.scenario).toMatchObject({ runCount: 2, lastRun: { id: again.run.id } });
	});

	it('shows each side’s scenario in compare, with the dam change matched by id', async () => {
		const res = await owner.call('GET', `/compare/runs?a=${c.projectId}:${base}&b=${c.projectId}:${firstRun.id}`);
		expect(res.status).toBe(200);
		expect(res.body.a.scenario).toBeNull();
		expect(res.body.b.scenario).toEqual({
			id: sid,
			name: 'Raise Rooikloof 20 %',
			baseRunId: base,
			ops: [damRaise(c.farm.id, 120_000)],
			opsSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
			ownedNodeIds: [c.farm.id],
			classified: ['proposal']
		});
		expect(res.body.b.run.scenarioId).toBe(sid);
		// The raise resizes the dam's area along its own relation (engine 1.10.0): 33 333 × 1.2^0.7 m².
		expect(res.body.changes).toEqual([
			{ area: 'network', kind: 'changed', subject: 'Rooikloof', text: 'Rooikloof: dam capacity 100\u202f000 m³ → 120\u202f000 m³' },
			{ area: 'network', kind: 'changed', subject: 'Rooikloof', text: 'Rooikloof: dam area when full estimated (capacity ÷ 3 m) → 37\u202f871 m²' }
		]);
		const farm = res.body.comparison.farms.find((f: { name: string }) => f.name === 'Rooikloof');
		expect(farm.nodeIdA).toBe(farm.nodeIdB);
	});
});

describe('scenario ops', () => {
	it('adds a node the live model never had, and runs it', async () => {
		const u = await signUp('Adder');
		const c = await catchment(u);
		const base = await run(u, c.projectId, 'Baseline');
		// No land of its own (a pump dam), so it doesn't re-partition the catchment: a proposal.
		const added = node('New dam', c.farm.id, { damCapacityM3: 20_000, areaKm2: 0 });
		const sid = await create(u, c.projectId, { name: 'New dam', baseRunId: base, ops: [{ op: 'node.add', node: added }], ownedNodeIds: [added.id] });
		const body = await runScenario(u, c.projectId, sid);
		expect(body.classified).toEqual(['proposal']);
		expect(body.run.summary.farms.map((f: { name: string }) => f.name)).toContain('New dam');
		const n = await rowsAs<{ n: number }>(u, 'SELECT count(*)::int AS n FROM run_series WHERE run_id = $1 AND node_id = $2', [body.run.id, added.id]);
		expect(n[0]!.n).toBeGreaterThan(0);
	});

	it('scales one farm’s demand in one month (demand.scale): classified by who owns the named farm, stored and run on exactly those days', async () => {
		const u = await signUp('Scaler');
		const c = await catchment(u);
		const base = await run(u, c.projectId, 'Baseline');
		// Rooikloof at 50 % in January (the record runs 2020-01-01 to 2020-03-30).
		const halve: ScenarioOp = { op: 'demand.scale', factor: 0.5, nodeIds: [c.farm.id], months: [1] };
		const sid = await create(u, c.projectId, { name: 'Rooikloof takes half in January', baseRunId: base, ops: [halve] });

		// A named farm that isn't the author's is another party's: baseline, until it is theirs.
		const checked = await u.call('GET', `/projects/${c.projectId}/scenarios/${sid}`);
		expect(checked.body.check).toEqual({ applied: [{ index: 0, op: halve, notes: [] }], problems: [], classified: ['baseline'], renamed: [], reIds: [] });
		expect(checked.body.scenario.opNames).toEqual([{ id: c.farm.id, name: 'Rooikloof' }]);
		const owned = await u.call('PATCH', `/projects/${c.projectId}/scenarios/${sid}`, { ownedNodeIds: [c.farm.id] });
		expect(owned.status).toBe(200);
		expect(owned.body.check.classified).toEqual(['proposal']);

		const body = await runScenario(u, c.projectId, sid);
		expect(body.classified).toEqual(['proposal']);
		const runId = body.run.id as string;

		// Stored: the op, its class, and the model it ran on, with the farm's demand factor (Oct-first rows: January is index 3).
		const stored = await rowsAs<{ inputs: { scenario: Record<string, unknown>; model: { nodes: { id: string; demandFactor?: number[] }[] } } }>(u, 'SELECT inputs FROM model_run WHERE id = $1', [runId]);
		expect(stored[0]!.inputs.scenario).toMatchObject({ id: sid, baseRunId: base, ops: [halve], ownedNodeIds: [c.farm.id], classified: ['proposal'] });
		const ranNodes = stored[0]!.inputs.model.nodes;
		expect(ranNodes.find((n) => n.id === c.farm.id)!.demandFactor).toEqual([1, 1, 1, 0.5, 1, 1, 1, 1, 1, 1, 1, 1]);
		expect(ranNodes.find((n) => n.id === c.other.id)!.demandFactor).toBeUndefined();

		// The summary is the engine's on the scaled input.
		const expected = await withUser(u.id, async (db) => runModelChecked(applyScenario(await loadRunInput(db, base), [halve]).input));
		expect(canon(body.run.summary)).toBe(canon(expected.summary));

		// The stored daily demand: Rooikloof's is the base's × 0.5 on the 31 January days and the base's after; Kalkoenkrans's is the base's.
		const series = async (r: string, nodeId: string) => {
			const res = await u.call('GET', `/projects/${c.projectId}/runs/${r}/series?key=demand&nodeId=${nodeId}`);
			expect(res.status).toBe(200);
			expect(res.body.startDate).toBe('2020-01-01');
			return res.body.values as number[];
		};
		const [baseFarm, scFarm, baseOther, scOther] = await Promise.all([series(base, c.farm.id), series(runId, c.farm.id), series(base, c.other.id), series(runId, c.other.id)]);
		expect(scFarm).toHaveLength(90);
		expect(baseFarm.slice(0, 31).some((v) => v > 1)).toBe(true);
		baseFarm.forEach((v, i) => expect(scFarm[i], `day ${i}`).toBeCloseTo(i < 31 ? v * 0.5 : v, 9));
		expect(scOther).toEqual(baseOther);

		// And the summaries say so: Rooikloof's mean demand is its stored series' mean, lower than the base's; Kalkoenkrans's unchanged.
		const baseSummary = (await u.call('GET', `/projects/${c.projectId}/runs/${base}`)).body.run.summary;
		const avg = (s: { farms: { nodeId: string; avgDemandM3Day: number }[] }, id: string) => s.farms.find((f) => f.nodeId === id)!.avgDemandM3Day;
		const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
		expect(avg(body.run.summary, c.farm.id)).toBeCloseTo(mean(scFarm), 6);
		expect(avg(body.run.summary, c.farm.id)).toBeLessThan(avg(baseSummary, c.farm.id));
		expect(avg(body.run.summary, c.other.id)).toBe(avg(baseSummary, c.other.id));
	});

	it('classes a demand.scale with no nodeIds as baseline even when every farm is owned: it scales the whole catchment', async () => {
		const u = await signUp('ScalerAll');
		const c = await catchment(u);
		const base = await run(u, c.projectId, 'Baseline');
		const everyone: ScenarioOp = { op: 'demand.scale', factor: 0.85 };
		const sid = await create(u, c.projectId, { name: 'Everyone at 85 %', baseRunId: base, ops: [everyone], ownedNodeIds: [c.farm.id, c.other.id] });
		const res = await u.call('GET', `/projects/${c.projectId}/scenarios/${sid}`);
		expect(res.body.check).toEqual({ applied: [{ index: 0, op: everyone, notes: ['2 farm(s) scaled'] }], problems: [], classified: ['baseline'], renamed: [], reIds: [] });
		// Positive control: the same scale naming both owned farms is a proposal.
		const named: ScenarioOp = { op: 'demand.scale', factor: 0.85, nodeIds: [c.farm.id, c.other.id] };
		const sid2 = await create(u, c.projectId, { name: 'Both named at 85 %', baseRunId: base, ops: [named], ownedNodeIds: [c.farm.id, c.other.id] });
		expect((await u.call('GET', `/projects/${c.projectId}/scenarios/${sid2}`)).body.check.classified).toEqual(['proposal']);
		const body = await runScenario(u, c.projectId, sid);
		expect(body.classified).toEqual(['baseline']);
		const stored = await rowsAs<{ inputs: { model: { nodes: { id: string; demandFactor?: number[] }[] } } }>(u, 'SELECT inputs FROM model_run WHERE id = $1', [body.run.id]);
		for (const id of [c.farm.id, c.other.id]) expect(stored[0]!.inputs.model.nodes.find((n) => n.id === id)!.demandFactor).toEqual(new Array(12).fill(0.85));
	});

	it('checks consecutive node.set ops on one farm as one edit: skipped whole with one problem, counted per op in the 422; complete, it runs', async () => {
		const u = await signUp('Grouper');
		const c = await catchment(u);
		const base = await run(u, c.projectId, 'Baseline');
		const set = (field: string, value: unknown) => ({ op: 'node.set', nodeId: c.farm.id, field, value }) as ScenarioOp;
		// Run of river with a pump, but Rooikloof keeps its dam: the group breaks the save rule.
		const created = await u.call('POST', `/projects/${c.projectId}/scenarios`, { name: 'River pump', baseRunId: base, ops: [set('supplyRule', 'runOfRiver'), set('pumpCapacityM3Day', 900)] });
		expect(created.status, JSON.stringify(created.body)).toBe(201);
		const sid = created.body.scenario.id as string;
		expect(created.body.check.problems).toEqual([expect.stringMatching(/^ops 1–2 \(node\.set, "Rooikloof"\): "Rooikloof": run of river has no dam/)]);
		expect(created.body.check.applied).toEqual([]);
		const refused = await u.call('POST', `/projects/${c.projectId}/scenarios/${sid}/runs`, {});
		expect(refused.status).toBe(422);
		expect(refused.body.error).toBe("2 ops of this scenario don't apply to its base run");
		// The dam emptied in the same group (here in the middle) completes the edit: every op applies and it runs.
		const fixed = await u.call('PATCH', `/projects/${c.projectId}/scenarios/${sid}`, { ops: [set('supplyRule', 'runOfRiver'), set('damCapacityM3', 0), set('pumpCapacityM3Day', 900)] });
		expect(fixed.body.check.problems).toEqual([]);
		expect(fixed.body.check.applied.map((a: { index: number }) => a.index)).toEqual([0, 1, 2]);
		await runScenario(u, c.projectId, sid);
	});

	it("refuses a run series naming a node outside the run's own model", async () => {
		const u = await signUp('Planter');
		const c = await catchment(u);
		const r = await run(u, c.projectId, 'Baseline');
		await expect(
			withUser(u.id, (db) => db.query(`INSERT INTO run_series (run_id, project_id, node_id, key, "values") VALUES ($1, $2, $3, 'x', '{1}')`, [r, c.projectId, crypto.randomUUID()]))
		).rejects.toMatchObject({ code: '23503' });
		// Positive control: a node of the run's model is fine (a new key on it).
		await withUser(u.id, (db) => db.query(`INSERT INTO run_series (run_id, project_id, node_id, key, "values") VALUES ($1, $2, $3, 'x', '{1}')`, [r, c.projectId, c.farm.id]));
	});

	it('rejects malformed ops with every error by path, and ids that are not UUIDs', async () => {
		const u = await signUp('Malformed');
		const c = await catchment(u);
		const base = await run(u, c.projectId, 'Baseline');
		const bad = await u.call('POST', `/projects/${c.projectId}/scenarios`, {
			name: 'Bad',
			baseRunId: base,
			ops: [{ op: 'node.set', nodeId: c.farm.id, field: 'damInitialPct', value: 1.5 }, { op: 'node.remove', nodeId: 'farm-a' }, { op: 'nope' }]
		});
		expect(bad.status).toBe(400);
		expect(bad.body.details.map((d: { message: string }) => d.message)).toEqual(['ops[0].value: must be at most 1', 'ops[2].op: must be one of node.set, node.add, node.remove, cropArea.set, crop.add, transfer.add, transfer.set, transfer.remove, landCover.add, landCover.remove, borehole.add, borehole.remove, settings.set, series.scale, demand.scale, ewrRule.set']);
		const notUuid = await u.call('POST', `/projects/${c.projectId}/scenarios`, { name: 'Bad', baseRunId: base, ops: [{ op: 'node.remove', nodeId: 'farm-a' }] });
		expect(notUuid.status).toBe(400);
		expect(notUuid.body.details.map((d: { message: string }) => d.message)).toEqual(['ops[0].nodeId: must be a UUID']);
		// Same name twice (any case): a 409 that says so, no database text.
		await create(u, c.projectId, { name: 'Twice', baseRunId: base });
		const dupe = await u.call('POST', `/projects/${c.projectId}/scenarios`, { name: ' twice ', baseRunId: base });
		expect(dupe.status).toBe(409);
		expect(dupe.body.error).toBe('this project already has a scenario with that name');
	});
});

describe('rebase', () => {
	it('reports an op that no longer applies, and such a scenario refuses to run', async () => {
		const u = await signUp('Rebaser');
		const c = await catchment(u);
		const old = await run(u, c.projectId, 'Old baseline');
		const sid = await create(u, c.projectId, { name: 'Both dams', baseRunId: old, ops: [damRaise(c.farm.id, 120_000), damRaise(c.other.id, 60_000)] });
		// The live model drops Kalkoenkrans, and a newer base run is made.
		const edited = structuredClone(c.model);
		edited.nodes = edited.nodes.filter((n) => n.id !== c.other.id);
		edited.cropAreas = edited.cropAreas.filter((a) => a.nodeId !== c.other.id);
		expect((await u.call('PUT', `/projects/${c.projectId}/model`, edited)).status).toBe(200);
		const newer = await run(u, c.projectId, 'New baseline');

		const preview = await u.call('POST', `/projects/${c.projectId}/scenarios/${sid}/rebase`, { baseRunId: newer, dryRun: true });
		expect(preview.status).toBe(200);
		expect(preview.body.problems).toEqual([`op 2 (node.set): node ${c.other.id} not found`]);
		expect(preview.body.applied.map((a: { index: number }) => a.index)).toEqual([0]);
		expect(preview.body.scenario.baseRunId).toBe(old);

		const rebased = await u.call('POST', `/projects/${c.projectId}/scenarios/${sid}/rebase`, { baseRunId: newer });
		expect(rebased.status).toBe(200);
		expect(rebased.body.scenario.baseRunId).toBe(newer);
		expect(rebased.body.problems).toHaveLength(1);
		// Kalkoenkrans is gone from the new base, but the scenario keeps its name (047_scenario_op_names), on a fresh read too.
		const names = [
			{ id: c.farm.id, name: 'Rooikloof' },
			{ id: c.other.id, name: 'Kalkoenkrans' }
		].sort((x, y) => (x.id < y.id ? -1 : 1));
		expect(rebased.body.scenario.opNames).toEqual(names);
		expect((await u.call('GET', `/projects/${c.projectId}/scenarios/${sid}`)).body.scenario.opNames).toEqual(names);
		// A PATCH re-sending the ops against the new base still keeps it.
		const resent = await u.call('PATCH', `/projects/${c.projectId}/scenarios/${sid}`, { ops: [damRaise(c.farm.id, 125_000), damRaise(c.other.id, 60_000)] });
		expect(resent.body.scenario.opNames).toEqual(names);
		const refused = await u.call('POST', `/projects/${c.projectId}/scenarios/${sid}/runs`, {});
		expect(refused.status).toBe(422);
		expect(refused.body.error).toBe("an op of this scenario doesn't apply to its base run");
		expect(refused.body.details.problems).toEqual([`op 2 (node.set): node ${c.other.id} not found`]);
		// The old base is no longer cited, so it can be deleted (positive control: the new one can't).
		expect((await u.call('DELETE', `/projects/${c.projectId}/runs/${old}`)).status).toBe(204);
		expect((await u.call('DELETE', `/projects/${c.projectId}/runs/${newer}`)).status).toBe(409);
		// Removing the op that no longer applies makes it runnable again.
		const fixed = await u.call('PATCH', `/projects/${c.projectId}/scenarios/${sid}`, { ops: [damRaise(c.farm.id, 120_000)] });
		expect(fixed.body.check.problems).toEqual([]);
		await runScenario(u, c.projectId, sid);
	});

	it('refuses a base that is not reproducible, a scenario run, or another project’s run', async () => {
		const u = await signUp('Bases');
		const c = await catchment(u);
		const base = await run(u, c.projectId, 'Baseline');
		// A run saved the way runs were before stored inputs (021): snapshot hashes, no references.
		const legacy = await withUser(u.id, async (db) => {
			const { rows } = await db.query<{ id: string }>(
				`INSERT INTO model_run (project_id, created_by, label, engine_version, start_date, end_date, inputs, summary)
				 SELECT project_id, created_by, 'legacy', engine_version, start_date, end_date, inputs, summary FROM model_run WHERE id = $1 RETURNING id`,
				[base]
			);
			return rows[0]!.id;
		});
		const res = await u.call('POST', `/projects/${c.projectId}/scenarios`, { name: 'Legacy', baseRunId: legacy });
		expect(res.status).toBe(409);
		expect(res.body.error).toMatch(/^this run is not reproducible from stored inputs/);

		const sid = await create(u, c.projectId, { name: 'S', baseRunId: base });
		const sRun = (await runScenario(u, c.projectId, sid)).run.id;
		const onScenarioRun = await u.call('POST', `/projects/${c.projectId}/scenarios`, { name: 'On a scenario run', baseRunId: sRun });
		expect(onScenarioRun.status).toBe(409);
		expect(onScenarioRun.body.error).toBe('that run is a scenario run; base a scenario on a run of the model itself');
	});
});

describe('scenario RLS and access', () => {
	let owner: User;
	let viewer: User;
	let farmer: User;
	let stranger: User;
	let c: Awaited<ReturnType<typeof catchment>>;
	let base: string;
	let sid: string;

	beforeAll(async () => {
		[owner, viewer, farmer, stranger] = await Promise.all([signUp('Sowner'), signUp('Sviewer'), signUp('Sfarmer'), signUp('Sstranger')]);
		c = await catchment(owner, 'RLS catchment');
		base = await run(owner, c.projectId, 'Baseline');
		expect((await owner.call('POST', `/projects/${c.projectId}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
		expect((await owner.call('POST', `/projects/${c.projectId}/farmers`, { email: farmer.email, nodeIds: [c.farm.id] })).status).toBe(201);
		sid = await create(owner, c.projectId, { name: 'Visible', baseRunId: base, ops: [damRaise(c.farm.id, 110_000)] });
	});

	it("can't cite another project's run (positive control: the same project's run can)", async () => {
		// The stranger's own project, where they are owner (an editor of both sides would still be refused).
		const theirs = await catchment(stranger, 'Other catchment');
		const theirRun = await run(stranger, theirs.projectId, 'Theirs');
		expect((await owner.call('POST', `/projects/${theirs.projectId}/members`, { email: owner.email, role: 'editor' })).status).toBe(404);
		expect((await stranger.call('POST', `/projects/${theirs.projectId}/members`, { email: owner.email, role: 'editor' })).status).toBe(201);
		// Through the API: the run isn't in this project.
		const api = await owner.call('POST', `/projects/${c.projectId}/scenarios`, { name: 'Cross', baseRunId: theirRun });
		expect(api.status).toBe(404);
		expect(api.body.error).toBe('base run not found');
		// In the database, as an editor of both projects: the same-project trigger refuses it.
		const insert = (runId: string, name: string) =>
			withUser(owner.id, (db) =>
				db.query(`INSERT INTO scenario (project_id, name, base_run_id, ops_sha256) VALUES ($1, $2, $3, $4)`, [c.projectId, name, runId, '0'.repeat(64)])
			);
		await expect(insert(theirRun, 'Cross')).rejects.toMatchObject({ code: '23503' });
		await insert(base, 'Same project');
		// Rebasing onto it is refused the same way, and a run can't claim another project's scenario.
		await expect(withUser(owner.id, (db) => db.query('UPDATE scenario SET base_run_id = $2 WHERE id = $1', [sid, theirRun]))).rejects.toMatchObject({ code: '23503' });
		await expect(
			withUser(owner.id, (db) =>
				db.query(
					`INSERT INTO model_run (project_id, created_by, label, engine_version, start_date, end_date, inputs, scenario_id)
					 VALUES ($1, app_current_user_id(), 'x', 'x', '2020-01-01', '2020-01-02', '{}', $2)`,
					[theirs.projectId, sid]
				)
			)
		).rejects.toMatchObject({ code: '23503' });
	});

	it('lets a viewer read scenarios but not write them; an editor can', async () => {
		expect((await viewer.call('GET', `/projects/${c.projectId}/scenarios`)).body.scenarios.map((s: { id: string }) => s.id)).toContain(sid);
		expect((await viewer.call('GET', `/projects/${c.projectId}/scenarios/${sid}`)).status).toBe(200);
		expect((await viewer.call('POST', `/projects/${c.projectId}/scenarios`, { name: 'Viewer', baseRunId: base })).status).toBe(403);
		expect((await viewer.call('PATCH', `/projects/${c.projectId}/scenarios/${sid}`, { name: 'Renamed' })).status).toBe(403);
		expect((await viewer.call('POST', `/projects/${c.projectId}/scenarios/${sid}/runs`, {})).status).toBe(403);
		expect((await viewer.call('POST', `/projects/${c.projectId}/scenarios/${sid}/rebase`, { baseRunId: base })).status).toBe(403);
		expect((await viewer.call('DELETE', `/projects/${c.projectId}/scenarios/${sid}`)).status).toBe(403);
		// RLS underneath: the viewer's writes match nothing or are refused.
		await expect(
			withUser(viewer.id, (db) => db.query(`INSERT INTO scenario (project_id, name, base_run_id, ops_sha256) VALUES ($1, 'v', $2, $3)`, [c.projectId, base, '0'.repeat(64)]))
		).rejects.toMatchObject({ code: '42501' });
		expect((await withUser(viewer.id, (db) => db.query(`UPDATE scenario SET name = 'v' WHERE id = $1`, [sid]))).rowCount).toBe(0);
		expect((await withUser(viewer.id, (db) => db.query('DELETE FROM scenario WHERE id = $1', [sid]))).rowCount).toBe(0);
		// Positive control: the owner (an editor) renames it.
		expect((await owner.call('PATCH', `/projects/${c.projectId}/scenarios/${sid}`, { name: 'Renamed' })).body.scenario.name).toBe('Renamed');
	});

	it("shows a farmer no scenario (positive control: a viewer sees it), and a stranger nothing", async () => {
		expect((await farmer.call('GET', `/projects/${c.projectId}/scenarios`)).status).toBe(403);
		expect((await farmer.call('GET', `/projects/${c.projectId}/scenarios/${sid}`)).status).toBe(403);
		expect(await rowsAs(farmer, 'SELECT id FROM scenario WHERE project_id = $1', [c.projectId])).toEqual([]);
		expect((await rowsAs(viewer, 'SELECT id FROM scenario WHERE project_id = $1', [c.projectId])).length).toBeGreaterThan(0);
		expect((await stranger.call('GET', `/projects/${c.projectId}/scenarios/${sid}`)).status).toBe(404);
		expect(await rowsAs(stranger, 'SELECT id FROM scenario WHERE id = $1', [sid])).toEqual([]);
	});
});

describe('a cited base run', () => {
	it('is kept until its scenario is deleted: no delete, no trim, no unpin, and its pin is free', async () => {
		const u = await signUp('Citer');
		const c = await catchment(u);
		const base = await run(u, c.projectId, 'Baseline');
		const plain = await run(u, c.projectId, 'Plain');
		const sid = await create(u, c.projectId, { name: 'Keeps the base', baseRunId: base, ops: [damRaise(c.farm.id, 130_000)] });
		const sRun = (await runScenario(u, c.projectId, sid)).run.id;

		const del = await u.call('DELETE', `/projects/${c.projectId}/runs/${base}`);
		expect(del.status).toBe(409);
		expect(del.body.error).toBe('this run is cited by scenario "Keeps the base", so it is kept');
		// Trimmed to one: the cited base stays and doesn't count; the plain run (positive control) goes.
		const removed = await withUser(u.id, (db) => trimRuns(db, c.projectId, 1));
		expect(removed).toEqual([plain]);
		// Its stored inputs stayed with it: the scenario still runs on it.
		await runScenario(u, c.projectId, sid);

		// Pinning a cited run doesn't count against the ceiling, and unpinning it says why it stays.
		expect((await u.call('PATCH', `/projects/${c.projectId}/runs/${base}`, { pinned: true })).status).toBe(200);
		const unpin = await u.call('PATCH', `/projects/${c.projectId}/runs/${base}`, { pinned: false });
		expect(unpin.status).toBe(409);
		expect(unpin.body.error).toBe('this run is cited by scenario "Keeps the base", so it stays kept');
		const others: string[] = [];
		for (let i = 0; i < PINNED_RUNS_PER_PROJECT_MAX; i++) others.push(await run(u, c.projectId, `pin ${i}`));
		for (const r of others) expect((await u.call('PATCH', `/projects/${c.projectId}/runs/${r}`, { pinned: true })).status, r).toBe(200);
		// The 11th counted pin is refused, by the API and by the trigger.
		const extra = await run(u, c.projectId, 'one too many');
		expect((await u.call('PATCH', `/projects/${c.projectId}/runs/${extra}`, { pinned: true })).status).toBe(409);
		await expect(withUser(u.id, (db) => db.query('UPDATE model_run SET pinned = true WHERE id = $1', [extra]))).rejects.toMatchObject({ code: '23514' });

		// The scenario goes: its run stays, as an ordinary run that remembers its scenario's name, and the base can be deleted.
		expect((await u.call('DELETE', `/projects/${c.projectId}/scenarios/${sid}`)).status).toBe(204);
		const kept = (await u.call('GET', `/projects/${c.projectId}/runs`)).body.runs.find((r: { id: string }) => r.id === sRun);
		expect(kept).toMatchObject({ scenarioId: null, scenarioName: 'Keeps the base' });
		expect((await u.call('PATCH', `/projects/${c.projectId}/runs/${base}`, { pinned: false })).status).toBe(200);
		expect((await u.call('DELETE', `/projects/${c.projectId}/runs/${base}`)).status).toBe(204);
	});

	it('still lets the whole project be deleted (the base-run key is checked at the end of the statement)', async () => {
		const u = await signUp('ProjectGone');
		const c = await catchment(u);
		const base = await run(u, c.projectId, 'Baseline');
		const sid = await create(u, c.projectId, { name: 'S', baseRunId: base, ops: [damRaise(c.farm.id, 130_000)] });
		await runScenario(u, c.projectId, sid);
		expect((await u.call('DELETE', `/projects/${c.projectId}`)).status).toBe(204);
		expect(await asOwner('SELECT id FROM scenario WHERE project_id = $1', [c.projectId])).toEqual([]);
	});
});

describe('a published base (022_publication beside 024_scenarios)', () => {
	it("lists both citations, and the history cap keeps a scenario base's publication (positive control: an uncited one goes)", async () => {
		const u = await signUp('PubBase');
		const c = await catchment(u);
		const publish = async (runId: string) => expect((await u.call('POST', `/projects/${c.projectId}/publication`, { runId })).status).toBe(201);
		const base = await run(u, c.projectId, 'Published baseline');
		await publish(base);
		const sid = await create(u, c.projectId, { name: 'On the published base', baseRunId: base, ops: [damRaise(c.farm.id, 120_000)] });
		// Published at 22:30 UTC: the next day in South Africa, the day the citation names (the project's zone, 058).
		await asOwner(`UPDATE run_publication SET published_at = '2026-09-25T22:30:00Z' WHERE run_id = $1`, [base]);
		const citedBy = (await u.call('GET', `/projects/${c.projectId}/runs`)).body.runs.find((r: { id: string }) => r.id === base).citedBy;
		expect(citedBy.map((x: { kind: string; name: string }) => [x.kind, x.kind === 'scenario' ? x.name : 'date'])).toEqual([
			['publication', 'date'],
			['scenario', 'On the published base']
		]);
		expect(citedBy[0].name).toBe('2026-09-26');
		// The published message wins on delete, as before the scenario; unpinning names both.
		expect((await u.call('DELETE', `/projects/${c.projectId}/runs/${base}`)).body.error).toBe('run is published: it is, or was, the published baseline, so it is kept');
		expect((await u.call('PATCH', `/projects/${c.projectId}/runs/${base}`, { pinned: true })).status).toBe(200);
		expect((await u.call('PATCH', `/projects/${c.projectId}/runs/${base}`, { pinned: false })).body.error).toBe(
			`this run is cited by the publication of ${citedBy[0].name}, scenario "On the published base", so it stays kept`
		);

		// A second published run with no scenario, then twelve more publications.
		const uncited = await run(u, c.projectId, 'Published, uncited');
		await publish(uncited);
		for (let i = 0; i < 12; i++) await publish(await run(u, c.projectId, `p${i}`));
		const history = (await u.call('GET', `/projects/${c.projectId}/publication`)).body.history.map((h: { runId: string }) => h.runId);
		expect(history).toContain(base);
		expect(history).not.toContain(uncited);
		expect(history).toHaveLength(13);
		// The scenario still runs on it.
		await runScenario(u, c.projectId, sid);
	});
});

describe('status', () => {
	it('freezes a submitted scenario: no ops, owned nodes or rebase, no delete; withdrawn → draft thaws it', async () => {
		const u = await signUp('Submitter');
		const c = await catchment(u);
		const base = await run(u, c.projectId, 'Baseline');
		const sid = await create(u, c.projectId, { name: 'Application', baseRunId: base, ops: [damRaise(c.farm.id, 120_000)] });
		const patch = (body: unknown) => u.call('PATCH', `/projects/${c.projectId}/scenarios/${sid}`, body);
		// A draft can't jump to decided.
		expect((await patch({ status: 'decided' })).status).toBe(409);
		expect((await patch({ status: 'submitted' })).body.scenario.status).toBe('submitted');

		const ops = await patch({ ops: [] });
		expect(ops.status).toBe(409);
		expect(ops.body.error).toBe("this scenario is submitted, so its ops, owned nodes and base run can't change");
		expect((await patch({ ownedNodeIds: [c.farm.id] })).status).toBe(409);
		expect((await u.call('POST', `/projects/${c.projectId}/scenarios/${sid}/rebase`, { baseRunId: base })).status).toBe(409);
		expect((await u.call('DELETE', `/projects/${c.projectId}/scenarios/${sid}`)).status).toBe(409);
		// Its name may still change, and it still runs.
		expect((await patch({ name: 'Application (submitted)' })).status).toBe(200);
		await runScenario(u, c.projectId, sid);
		// The database holds the line too, whatever the API does.
		await expect(withUser(u.id, (db) => db.query(`UPDATE scenario SET ops = '[]' WHERE id = $1`, [sid]))).rejects.toMatchObject({ code: '23514' });
		await expect(withUser(u.id, (db) => db.query('DELETE FROM scenario WHERE id = $1', [sid]))).rejects.toMatchObject({ code: '23514' });
		await expect(withUser(u.id, (db) => db.query(`UPDATE scenario SET status = 'draft' WHERE id = $1`, [sid]))).rejects.toMatchObject({ code: '23514' });

		// Positive control: withdrawn, then back to draft, it can change again.
		expect((await patch({ status: 'withdrawn' })).status).toBe(200);
		expect((await patch({ status: 'draft' })).status).toBe(200);
		expect((await patch({ ops: [] })).body.scenario.ops).toEqual([]);
	});
});
