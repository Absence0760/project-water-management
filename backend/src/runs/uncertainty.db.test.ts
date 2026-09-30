// Uncertainty bands per run (014_run_uncertainty.sql, …/uncertainty routes).
// Checked at three levels: the routes (roles, validation, the server's check
// of a posted ensemble), RLS (who reads and writes, each with a positive
// control) and the privileges that make the history un-cherry-pickable (the
// database draws the seed; no delete; a row completes once).
import {
	pairedMembers,
	runEnsemble,
	runPairedEnsemble,
	type MemberResult,
	type ModelInput,
	type ResolvedEnsembleOptions
} from '@water-management/engine';
import { beforeAll, describe, expect, it } from 'vitest';
import { asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let editor: User;
let viewer: User;
let stranger: User;
let projectId: string;
let runA: string;
let runB: string;

const DAYS = 3 * 365;
/** Loose, so the small synthetic catchment keeps every member and the bands show. */
const LOOSE = { members: 30, thresholds: { minSkill: -10, maxLowFlowBiasPct: null, wr2012MaxLevel: 'unusable' as const } };

const base = (runId: string) => `/projects/${projectId}/runs/${runId}`;
const sql = (u: User, text: string, params: unknown[] = []) => withUser(u.id, (db) => db.query(text, params));

async function newRun(u: User, label: string) {
	const res = await u.call('POST', `/projects/${projectId}/runs`, { label });
	expect(res.status).toBe(201);
	return res.body.run.id as string;
}

async function inputOf(u: User, runId: string): Promise<ModelInput> {
	const res = await u.call('GET', `${base(runId)}/model-input`);
	expect(res.status).toBe(200);
	return res.body.input;
}

async function start(u: User, runId: string, body: unknown = { request: LOOSE }) {
	return u.call('POST', `${base(runId)}/uncertainty`, body);
}

beforeAll(async () => {
	[owner, editor, viewer, stranger] = await Promise.all([signUp('UnOwner'), signUp('UnEditor'), signUp('UnViewer'), signUp('UnStranger')]);
	projectId = (await owner.call('POST', '/projects', { name: 'Uncertainty' })).body.project.id as string;
	for (const [u, role] of [
		[editor, 'editor'],
		[viewer, 'viewer']
	] as const) {
		expect((await owner.call('POST', `/projects/${projectId}/members`, { email: u.email, role })).status).toBe(201);
	}
	const outlet = node('Outlet', null);
	const farm = node('Upper', outlet.id, { areaKm2: 30, pctRunoffToDam: 0, damCapacityM3: 0, damInitialPct: 0 });
	expect((await owner.call('PUT', `/projects/${projectId}/model`, { nodes: [outlet, farm], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
	expect(
		(await owner.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(150), ewrPragmaticM3PerDay: monthly(5000), runoffModel: 'gr4j' } })).status
	).toBe(200);
	// Synthetic rain: a wet day every few days, heavier in winter.
	const rain = Array.from({ length: DAYS }, (_, i) => (i % 4 === 0 ? (Math.floor(i / 30) % 12 < 6 ? 18 : 6) : 0));
	expect((await owner.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2018-10-01', values: rain })).status).toBe(200);
	// An "observed" record: the model's own outflow, scaled a little. Synthetic.
	const first = await newRun(owner, 'seed');
	const flow = (await owner.call('GET', `${base(first)}/series?key=simulated_outflow`)).body.values as number[];
	const observed = flow.map((q, i) => (q / 86_400) * (1 + 0.1 * Math.sin(i / 17)));
	expect((await owner.call('PUT', `/projects/${projectId}/series`, { kind: 'flow_observed_m3s', unit: 'm3/s', startDate: '2018-10-01', values: observed })).status).toBe(200);
	runA = await newRun(owner, 'Baseline');
});

describe('GET …/runs/:runId/model-input', () => {
	it('gives a viewer the run’s own input (positive control) and hides it from a stranger', async () => {
		const input = await inputOf(viewer, runA);
		expect(Object.keys(input.series).sort()).toEqual(['flow_observed_m3s', 'rain_catchment_mm']);
		expect(input.settings.runoffModel).toBe('gr4j');
		expect((await stranger.call('GET', `${base(runA)}/model-input`)).status).toBe(404);
		expect((await viewer.call('GET', `${base('00000000-0000-4000-8000-000000000000')}/model-input`)).status).toBe(404);
	});
});

describe('starting an ensemble', () => {
	it('refuses a viewer (403) and hides the run from a stranger (404)', async () => {
		expect((await start(viewer, runA)).status).toBe(403);
		expect((await start(stranger, runA)).status).toBe(404);
		expect((await viewer.call('GET', `${base(runA)}/uncertainty`)).body.ensembles).toEqual([]);
	});

	it('refuses options the run cannot use, with the engine’s reason and no database text', async () => {
		const few = await start(editor, runA, { request: { members: 5 } });
		expect(few.status).toBe(400);
		expect(few.body.error).toMatch(/members must be a whole number from 30 to 1000/);
		const chirps = await start(editor, runA, { request: { rainSources: ['chirps'] } });
		expect(chirps.status).toBe(400);
		expect(chirps.body.error).toMatch(/CHIRPS-only rain source is not available/);
		// The legacy model was removed in engine 1.0.0: GR4J is the only one an ensemble can vary.
		expect((await start(editor, runA, { request: { model: 'legacy' } })).status).toBe(400);
		expect((await start(editor, runA, { request: {}, extra: 1 })).status).toBe(400);
	});

	it('lets an editor start one: the database draws the seed and the options are the run’s', async () => {
		const res = await start(editor, runA);
		expect(res.status).toBe(201);
		const e = res.body.ensemble;
		expect(e).toMatchObject({ runId: runA, status: 'started', runoffModel: 'gr4j', method: 'lhs', members: 30, accepted: null, summary: null, createdBy: 'UnEditor' });
		expect(e.seed).toBeGreaterThanOrEqual(0);
		expect(e.options.seed).toBe(e.seed);
		expect(e.options.thresholds).toEqual({ objective: 'kgePrime', minSkill: -10, maxLowFlowBiasPct: null, wr2012MaxLevel: 'unusable' });
		expect(res.body.notes.join(' ')).toMatch(/rain source is not varied/);
	});
});

describe('storing the result', () => {
	let uid: string;
	let options: ResolvedEnsembleOptions;
	let members: MemberResult[];
	let coverage: unknown;

	beforeAll(async () => {
		const res = await start(owner, runA);
		uid = res.body.ensemble.id;
		options = res.body.ensemble.options;
		const r = runEnsemble(await inputOf(owner, runA), options);
		members = r.members;
		coverage = r.coverage;
	});

	it('refuses members that are not the drawn sample (another seed)', async () => {
		const other = runEnsemble(await inputOf(owner, runA), { ...options, seed: (options.seed + 1) % 2 ** 31 });
		const res = await owner.call('POST', `${base(runA)}/uncertainty/${uid}/result`, { members: other.members, coverage: other.coverage });
		expect(res.status).toBe(422);
		expect(res.body.error).toBe('the posted ensemble does not reproduce');
		expect(res.body.details[0]).toMatch(/^member 1\.params/);
	});

	it('refuses forged outputs: the server re-runs member 0 and members it picks', async () => {
		const forged = members.map((m) => (m.metrics ? { ...m, metrics: { ...m.metrics, ewrDaysNotMet: m.metrics.ewrDaysNotMet + 7 } } : m));
		const res = await owner.call('POST', `${base(runA)}/uncertainty/${uid}/result`, { members: forged, coverage });
		expect(res.status).toBe(422);
		expect(res.body.details.join(' ')).toMatch(/ewrDaysNotMet/);
	});

	it('refuses a kept member without the evidence measures (engine ≥ 1.33.0): a missing one would thin its band unseen', async () => {
		const k = members.findIndex((m) => m.accepted && m.index > 0);
		const { noFlowDays: _drop, ...thin } = members[k]!.metrics!;
		const res = await owner.call('POST', `${base(runA)}/uncertainty/${uid}/result`, { members: members.map((m, i) => (i === k ? { ...m, metrics: thin } : m)), coverage });
		expect(res.status).toBe(400);
	});

	it('refuses a viewer, and an editor who did not start it', async () => {
		expect((await viewer.call('POST', `${base(runA)}/uncertainty/${uid}/result`, { members, coverage })).status).toBe(403);
		const other = await editor.call('POST', `${base(runA)}/uncertainty/${uid}/result`, { members, coverage });
		expect(other.status).toBe(403);
		expect(other.body.error).toBe('only whoever started an ensemble can store its result');
	});

	it('stores an honest result once, with the bands the server summarised', async () => {
		const res = await owner.call('POST', `${base(runA)}/uncertainty/${uid}/result`, { members, coverage });
		expect(res.status).toBe(200);
		const e = res.body.ensemble;
		expect(e.status).toBe('complete');
		const kept = members.filter((m) => m.accepted).length;
		expect(kept).toBeGreaterThanOrEqual(30);
		expect(e.accepted).toBe(kept);
		expect(e.summary.accepted).toBe(kept);
		expect(e.summary.bands.ewrDaysNotMet.p50).not.toBeNull();
		// The evidence measures (engine ≥ 1.33.0), banded over every kept member.
		expect(e.summary.bands.noFlowDays.n).toBe(kept);
		expect(e.summary.bands.ewrSites.map((x: { key: string }) => x.key)).toEqual(['outlet']);
		expect(e.summary.bands.supply.every((x: { band: { n: number } }) => x.band.n === kept)).toBe(true);
		expect(e.summary.decisionRule).toMatch(/^A parameter set is kept when it has KGE′ ≥ -10/);
		expect(e.completedAt).not.toBeNull();
		const again = await owner.call('POST', `${base(runA)}/uncertainty/${uid}/result`, { members, coverage });
		expect(again.status).toBe(409);
	});

	it('lists every ensemble of the run, abandoned starts included; one reads with its members', async () => {
		const list = (await viewer.call('GET', `${base(runA)}/uncertainty`)).body.ensembles as { id: string; status: string; result?: unknown }[];
		expect(list.map((x) => x.status).sort()).toEqual(['complete', 'started']);
		expect(list.every((x) => x.result === undefined)).toBe(true);
		const one = await viewer.call('GET', `${base(runA)}/uncertainty/${uid}`);
		expect(one.status).toBe(200);
		expect(one.body.ensemble.result.members).toHaveLength(31);
		expect((await stranger.call('GET', `${base(runA)}/uncertainty/${uid}`)).status).toBe(404);
	});

	it('can’t be rewritten, deleted or given a chosen seed, even by SQL as the app role', async () => {
		await expect(sql(owner, 'DELETE FROM run_uncertainty WHERE id = $1', [uid])).rejects.toMatchObject({ code: '42501' });
		await expect(sql(owner, `UPDATE run_uncertainty SET options = '{}' WHERE id = $1`, [uid])).rejects.toMatchObject({ code: '42501' });
		// A complete row is outside the update policy: nothing changes.
		const upd = await sql(owner, `UPDATE run_uncertainty SET summary = '{}' WHERE id = $1`, [uid]);
		expect(upd.rowCount).toBe(0);
		const ins = await sql(
			owner,
			`INSERT INTO run_uncertainty (project_id, run_id, runoff_model, engine_version, method, seed, members, options, created_by)
			 VALUES ($1, $2, 'gr4j', 'x', 'lhs', 123, 30, '{"seed": 123}', $3) RETURNING seed::int AS seed, options->>'seed' AS s, status`,
			[projectId, runA, editor.id]
		);
		expect(ins.rows[0].status).toBe('started');
		expect(ins.rows[0].s).toBe(String(ins.rows[0].seed));
		// Stamped from the session, not the column: owner made it.
		const [made] = await asOwner('SELECT created_by FROM run_uncertainty WHERE seed = $1 AND run_id = $2', [ins.rows[0].seed, runA]);
		expect(made.created_by).toBe(owner.id);
	});

	it('RLS: a viewer reads the rows (positive control) but can’t add one; a stranger sees none', async () => {
		expect((await sql(viewer, 'SELECT id FROM run_uncertainty WHERE run_id = $1', [runA])).rowCount).toBeGreaterThan(0);
		expect((await sql(stranger, 'SELECT id FROM run_uncertainty WHERE run_id = $1', [runA])).rowCount).toBe(0);
		await expect(
			sql(viewer, `INSERT INTO run_uncertainty (project_id, run_id, runoff_model, engine_version, method, seed, members, options, created_by) VALUES ($1, $2, 'gr4j', 'x', 'lhs', 0, 30, '{}', $3)`, [
				projectId,
				runA,
				viewer.id
			])
		).rejects.toMatchObject({ code: '42501' });
	});

	describe('paired bands', () => {
		it('run the baseline’s kept members on another run and band the difference', async () => {
			// The application: a dam on the farm. Series unchanged, so both runs' inputs are still current.
			const model = (await owner.call('GET', `/projects/${projectId}/model`)).body;
			const farm = model.nodes.find((n: { name: string }) => n.name === 'Upper');
			Object.assign(farm, { pctRunoffToDam: 1, damCapacityM3: 500_000, damInitialPct: 0, damAreaFullM2: 50_000 });
			expect((await owner.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
			runB = await newRun(owner, 'With dam');

			expect((await start(editor, runB, { baselineId: uid })).status).toBe(201);
			const res = await start(owner, runB, { baselineId: uid });
			expect(res.status).toBe(201);
			const pairedRow = res.body.ensemble;
			expect(pairedRow).toMatchObject({ baselineId: uid, baselineRunId: runA, seed: options.seed, options });

			const baseline = (await owner.call('GET', `${base(runA)}/uncertainty/${uid}`)).body.ensemble;
			const paired = runPairedEnsemble(await inputOf(owner, runB), { options, header: baseline.result.header, members: baseline.result.members });
			const forged = paired.members.map((p) => ({ ...p, metrics: { ...p.metrics, marOutflowMm3: 0 } }));
			expect((await owner.call('POST', `${base(runB)}/uncertainty/${pairedRow.id}/result`, { members: forged })).status).toBe(422);
			const done = await owner.call('POST', `${base(runB)}/uncertainty/${pairedRow.id}/result`, { members: paired.members });
			expect(done.status).toBe(200);
			expect(done.body.ensemble.accepted).toBe(pairedMembers(baseline.result).length);
			expect(done.body.ensemble.summary.marOutflowMm3.max).toBeLessThan(0);
			expect(done.body.ensemble.summary.decisionRule).toMatch(/other − baseline/);
			// The paired evidence measures; the applicant's own group is the evidence report's to band (it knows the scenario).
			expect(done.body.ensemble.summary.noFlowDays.n).toBe(pairedMembers(baseline.result).length);
			expect(done.body.ensemble.summary.supply.map((x: { name: string }) => x.name)).toContain('Upper');
			expect(done.body.ensemble.summary.ownSupply).toBeUndefined();
		});

		it('refuse a baseline of the same run, one not complete, and one from another project', async () => {
			const same = await start(owner, runA, { baselineId: uid });
			expect(same.status).toBe(400);
			const started = (await start(owner, runA)).body.ensemble.id as string;
			expect((await start(owner, runB, { baselineId: started })).status).toBe(400);
			const elsewhere = (await stranger.call('POST', '/projects', { name: 'Elsewhere' })).body.project.id as string;
			expect((await stranger.call('POST', `/projects/${elsewhere}/runs/${runB}/uncertainty`, { baselineId: uid })).status).toBe(404);
		});
	});
});

describe('a run whose data changed', () => {
	it('still gets its own input: a run stores its input series (021_series_blob)', async () => {
		const run = await newRun(owner, 'Stored inputs, then the data changed');
		const input = await inputOf(owner, run);
		const rain = (input.series.rain_catchment_mm!.values as number[]).map((v) => v * 1.1);
		expect((await owner.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2018-10-01', values: rain })).status).toBe(200);
		const res = await owner.call('GET', `${base(run)}/model-input`);
		expect(res.status).toBe(200);
		expect(res.body.input).toEqual(input);
		expect((await start(owner, run)).status).toBe(201);
		// Put the data back for the tests below.
		expect((await owner.call('PUT', `/projects/${projectId}/series`, { ...input.series.rain_catchment_mm, kind: 'rain_catchment_mm', unit: 'mm' })).status).toBe(200);
	});

	it('gets no ensemble when it is from before stored inputs: its input can no longer be rebuilt (409)', async () => {
		const stored = await newRun(owner, 'Before the data changed');
		// A run saved as executeRun did before 020: the same snapshot, no stored series.
		const run = await withUser(owner.id, async (db) => {
			const { rows } = await db.query<{ id: string }>(
				`INSERT INTO model_run (project_id, created_by, label, engine_version, start_date, end_date, inputs, summary)
				 SELECT project_id, created_by, 'legacy', engine_version, start_date, end_date, inputs, summary FROM model_run WHERE id = $1 RETURNING id`,
				[stored]
			);
			return rows[0]!.id;
		});
		// Positive control: while the data still hashes to the snapshot, the legacy run gets its input.
		const input = await inputOf(owner, run);
		const rain = (input.series.rain_catchment_mm!.values as number[]).map((v) => v * 1.1);
		expect((await owner.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2018-10-01', values: rain })).status).toBe(200);
		const res = await owner.call('GET', `${base(run)}/model-input`);
		expect(res.status).toBe(409);
		expect(res.body.error).toMatch(/data changed since this run \(rain_catchment_mm\)/);
		expect((await start(owner, run)).status).toBe(409);
	});

	it('deleting a run takes its ensembles and the paired bands built on them', async () => {
		const before = await asOwner('SELECT count(*)::int AS n FROM run_uncertainty WHERE run_id = ANY($1)', [[runA, runB]]);
		expect(before[0].n).toBeGreaterThan(0);
		expect((await owner.call('DELETE', `${base(runA)}`)).status).toBe(204);
		const after = await asOwner('SELECT run_id, baseline_id FROM run_uncertainty WHERE run_id = $1 OR baseline_id IS NOT NULL AND run_id = $2', [runA, runB]);
		expect(after).toEqual([]);
	});
});
