// Automated calibration run by the server, end to end (issue #153,
// 108_auto_calibration.sql): POST …/auto-calibrations plans the saved rules,
// one `auto_calibration` job per case (the memory transport: the test runs the
// tick itself), the kept fit applied by the server with its record, the run
// and the server's ensemble around it; a client can't write an automated fit
// or a sign-off of its own; new data queues the rules when they ask for it,
// and applies the fit only while they are signed off; RLS with a positive
// control; a run whose input changed fails, saying so.
import { defaultCalibrationRules, runModel, type CalibrationRules, type ModelInput } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { runTick } from '../jobs/runner.js';
import { AUTO_CALIBRATION_JOBS_PER_USER } from './schema.js';

type User = Awaited<ReturnType<typeof signUp>>;

const tick = () => runTick({ feeds: false, reports: false, alerts: false });
/** Run due jobs one at a time until the calibration has fitted `n` cases (another file's leftover job may come first). */
async function stepTo(owner: User, projectId: string, id: string, n: number) {
	for (let i = 0; i < 10; i++) {
		const got = (await owner.call('GET', `/projects/${projectId}/auto-calibrations/${id}`)).body.calibration;
		if (got.cases.length >= n) return got;
		await runTick({ feeds: false, reports: false, alerts: false, maxJobs: 1 });
	}
	throw new Error(`calibration ${id} never reached ${n} cases`);
}
/** Run every due job, as often as the chain of case jobs needs. */
async function drain(n = 12) {
	for (let i = 0; i < n; i++) await tick();
}

const TRUTH = { x1: 420, x2: 0, x3: 70, x4: 2.1, warmupDays: 365 };
/** A small, quick search: the rules' own (after.ensemble off unless a test turns it on). */
const quickRules = (over: Partial<CalibrationRules> = {}): CalibrationRules => ({
	...defaultCalibrationRules(),
	run: { seed: 3, starts: 1, budget: 60 },
	cases: { bounds: ['typical'], objectives: ['kgePrime'] },
	selection: { test: 'split', score: 'kgePrime' },
	after: { onNewData: 'off', ensemble: false },
	...over
});

/** A farm draining to a gauge; the gauge record is GR4J with known parameters, the fit starts from the defaults. Invented values. */
async function calibratable(owner: User, rules: CalibrationRules = quickRules(), name = 'Autocal') {
	const projectId = (await owner.call('POST', '/projects', { name })).body.project.id as string;
	const gauge = node('Gauge', null);
	const farm = node('Farm', gauge.id, { areaKm2: 40, pctRunoffToDam: 0 });
	expect((await owner.call('PUT', `/projects/${projectId}/model`, { nodes: [gauge, farm], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
	expect((await owner.call('PATCH', `/projects/${projectId}`, { settings: { runoffModel: 'gr4j', apanMm: monthly(150), gr4j: TRUTH } })).status).toBe(200);
	const days = 4 * 365;
	const rain = Array.from({ length: days }, (_, t) => (t % 5 === 0 ? 12 + (t % 37) : t % 11 === 0 ? 3 : 0));
	expect((await owner.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2010-10-01', values: rain })).status).toBe(200);
	const input = (await owner.call('GET', `/projects/${projectId}/model-input`)).body.input as ModelInput;
	const flow = runModel(input).series.find((s) => s.key === 'natural_flow' && s.nodeId === null)!.values;
	const observed = flow.map((q) => Math.round(((q ?? 0) / 86_400) * 1e6) / 1e6);
	expect((await owner.call('PUT', `/projects/${projectId}/series`, { kind: 'flow_observed_m3s', unit: 'm3/s', startDate: '2010-10-01', values: observed })).status).toBe(200);
	const current = (await owner.call('GET', `/projects/${projectId}`)).body.project.settings;
	const patched = await owner.call('PATCH', `/projects/${projectId}`, { settings: { gr4j: { ...TRUTH, x1: 350, x3: 90, x4: 1.7 }, calibrationRules: { ...rules, revision: current.calibrationRules.revision } } });
	expect(patched.status, JSON.stringify(patched.body)).toBe(200);
	return { projectId, gauge, farm };
}

async function member(owner: User, projectId: string, u: User, role: 'viewer' | 'editor') {
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: u.email, role })).status).toBe(201);
}

describe('POST /projects/:id/auto-calibrations', () => {
	it('fits every case on the server, keeps one by its held-out score, and applies it with a record the server builds', async () => {
		const owner = await signUp('AutocalOwner');
		const c = await calibratable(owner, quickRules({ cases: { bounds: ['wide', 'typical'], objectives: ['kgePrime'] } }));
		const res = await owner.call('POST', `/projects/${c.projectId}/auto-calibrations`, {});
		expect(res.status, JSON.stringify(res.body)).toBe(202);
		expect(res.body.calibration).toMatchObject({ trigger: 'manual', status: 'running', rulesRevision: 2, cases: [], createdBy: 'AutocalOwner' });
		expect(res.body.calibration.plan.cases).toHaveLength(2);

		// One case per job: after its first job, one case, and the next job queued.
		const half = await stepTo(owner, c.projectId, res.body.calibration.id, 1);
		expect(half.status).toBe('running');
		expect(half.cases).toHaveLength(1);
		await drain();
		const done = (await owner.call('GET', `/projects/${c.projectId}/auto-calibrations/${res.body.calibration.id}`)).body.calibration;
		expect(done.status).toBe('complete');
		expect(done.cases).toHaveLength(2);
		expect(done.chosen).not.toBeNull();
		const kept = done.cases[done.chosen];
		expect(kept.eligible).toBe(true);
		for (const k of done.cases.filter((x: { eligible: boolean }) => x.eligible)) expect(k.score).toBeLessThanOrEqual(kept.score);
		expect(done.report.notes).toContainEqual(expect.stringContaining('draft rules'));

		const applied = await owner.call('POST', `/projects/${c.projectId}/auto-calibrations/${done.id}/apply`, {});
		expect(applied.status, JSON.stringify(applied.body)).toBe(200);
		expect(applied.body).toMatchObject({ runId: expect.any(String), uncertaintyId: null, runError: null });
		expect(applied.body.calibration).toMatchObject({ appliedBy: 'AutocalOwner', appliedRunId: applied.body.runId });
		const settings = (await owner.call('GET', `/projects/${c.projectId}`)).body.project.settings;
		expect(settings.gr4j).toMatchObject(kept.params);
		expect(settings.fitRecord).toMatchObject({ seed: 3, budget: 60, editedParams: [], auto: { chosen: done.chosen, rules: { revision: 2 } } });
		expect(settings.fitRecord.auto.cases).toHaveLength(2);
		// The run it made is labelled by the rules, and the history says what was applied.
		const run = (await owner.call('GET', `/projects/${c.projectId}/runs/${applied.body.runId}`)).body.run;
		expect(run.label).toBe('Automated calibration · rules revision 2');
		const [rev] = await asOwner(`SELECT reason FROM model_revision WHERE project_id = $1 AND source = 'settings_patch' ORDER BY id DESC LIMIT 1`, [c.projectId]);
		expect(rev!.reason).toMatch(/^Applied the automated calibration of \d{4}-\d{2}-\d{2} \(calibration rules revision 2\): /);

		// Once only, and the settings still carry the record back unchanged on a later save.
		expect((await owner.call('POST', `/projects/${c.projectId}/auto-calibrations/${done.id}/apply`, {})).status).toBe(409);
		expect((await owner.call('PATCH', `/projects/${c.projectId}`, { settings })).status).toBe(200);
	});

	it('with after.ensemble, the apply also queues the ensemble around the fit, and the server computes and stores it', async () => {
		const owner = await signUp('AutocalEnsemble');
		const c = await calibratable(owner, quickRules({ after: { onNewData: 'off', ensemble: true } }));
		const res = await owner.call('POST', `/projects/${c.projectId}/auto-calibrations`, {});
		await drain();
		const applied = await owner.call('POST', `/projects/${c.projectId}/auto-calibrations/${res.body.calibration.id}/apply`, {});
		expect(applied.status, JSON.stringify(applied.body)).toBe(200);
		const uid = applied.body.uncertaintyId as string;
		expect(uid).toEqual(expect.any(String));
		const started = (await owner.call('GET', `/projects/${c.projectId}/runs/${applied.body.runId}/uncertainty/${uid}`)).body.ensemble;
		expect(started.status).toBe('started');
		await drain(2);
		const stored = (await owner.call('GET', `/projects/${c.projectId}/runs/${applied.body.runId}/uncertainty/${uid}`)).body.ensemble;
		expect(stored.status).toBe('complete');
		expect(stored.summary).toBeTruthy();
		// Centred on the fit it follows: the fit record's bounds.
		expect(stored.options.bounds).toBe('typical');
	});

	it('refuses a fit written by a client, and dates and audits a sign-off with the signed-in account', async () => {
		const owner = await signUp('AutocalForger');
		const c = await calibratable(owner);
		const settings = (await owner.call('GET', `/projects/${c.projectId}`)).body.project.settings;
		const period = { start: '2011-01-01', end: '2011-01-30', waterYears: [2010], scores: { days: 30, kgePrime: 0.99 } };
		const forged = {
			fittedAt: '2026-09-29T10:00:00.000Z', engineVersion: '1.25.0', model: 'gr4j', objective: 'kgePrime', bounds: 'typical', seed: 3, budget: 60, evaluations: 180,
			cancelled: false, free: ['x1', 'x3', 'x4'], params: { x1: 420, x2: 0, x3: 70, x4: 2.1 }, startParams: { x1: 350, x2: 0, x3: 90, x4: 1.7 },
			flowKind: 'flow_observed_m3s', simulatedKey: 'simulated_outflow', calibrationStart: null, calibrationEnd: null, exclusions: [], validate: true,
			validationRecord: null, fit: period, before: period, splitSample: null, differential: null, independentRecord: null, notes: [], editedParams: [],
			auto: { rules: settings.calibrationRules, ruleExclusions: [], chosen: 0, cases: [{ label: 'x', pan: 'project', bounds: 'typical', objective: 'kgePrime', score: 0.99, eligible: true, reasons: [], params: { x1: 420, x2: 0, x3: 70, x4: 2.1 } }] }
		};
		const res = await owner.call('PATCH', `/projects/${c.projectId}`, { settings: { fitRecord: forged } });
		expect(res.status).toBe(409);
		expect(res.body.error).toContain('applied by the server');
		expect((await owner.call('GET', `/projects/${c.projectId}`)).body.project.settings.fitRecord).toBeNull();

		const signed = await owner.call('PATCH', `/projects/${c.projectId}`, {
			settings: { calibrationRules: { ...settings.calibrationRules, signedOff: { by: 'Dr A. Hydrologist', on: '2000-01-01' } } }
		});
		expect(signed.status).toBe(200);
		// The typed name is the signature; the date is the server's; the account is the audit event's actor.
		expect(signed.body.project.settings.calibrationRules.signedOff).toEqual({ by: 'Dr A. Hydrologist', on: new Date().toISOString().slice(0, 10) });
		const [ev] = await asOwner(`SELECT actor_user_id, subject FROM audit_event WHERE project_id = $1 AND kind = 'calibration_rules.signed_off'`, [c.projectId]);
		expect(ev).toMatchObject({ actor_user_id: owner.id, subject: { revision: 2, fullName: 'Dr A. Hydrologist' } });
		// Sending the stored sign-off back keeps it, with no new event; a sign-off alone is no rule change.
		const again = await owner.call('PATCH', `/projects/${c.projectId}`, { settings: { calibrationRules: signed.body.project.settings.calibrationRules } });
		expect(again.body.project.settings.calibrationRules).toEqual(signed.body.project.settings.calibrationRules);
		expect(await asOwner(`SELECT id FROM audit_event WHERE project_id = $1 AND kind = 'calibration_rules.signed_off'`, [c.projectId])).toHaveLength(1);
		// Withdrawn: audited too.
		const withdrawn = await owner.call('PATCH', `/projects/${c.projectId}`, { settings: { calibrationRules: { ...signed.body.project.settings.calibrationRules, signedOff: null } } });
		expect(withdrawn.body.project.settings.calibrationRules).toMatchObject({ revision: 2, signedOff: null });
		expect(await asOwner(`SELECT actor_user_id FROM audit_event WHERE project_id = $1 AND kind = 'calibration_rules.sign_off_withdrawn'`, [c.projectId])).toEqual([{ actor_user_id: owner.id }]);
	});

	it('fails a run whose input changed between its cases, saying so', async () => {
		const owner = await signUp('AutocalMoved');
		const c = await calibratable(owner, quickRules({ cases: { bounds: ['wide', 'typical'], objectives: ['kgePrime'] } }));
		const res = await owner.call('POST', `/projects/${c.projectId}/auto-calibrations`, {});
		await stepTo(owner, c.projectId, res.body.calibration.id, 1);
		expect((await owner.call('PATCH', `/projects/${c.projectId}`, { settings: { apanMm: monthly(160) } })).status).toBe(200);
		await drain();
		const failed = (await owner.call('GET', `/projects/${c.projectId}/auto-calibrations/${res.body.calibration.id}`)).body.calibration;
		expect(failed).toMatchObject({ status: 'failed', error: expect.stringContaining('changed while the rules ran') });
		expect(failed.cases).toHaveLength(1);
	});

	it('refuses rules the project can’t run, before anything is queued, and caps queued runs per user', async () => {
		const owner = await signUp('AutocalRefused');
		const c = await calibratable(owner, quickRules({ selection: { test: 'independent', score: 'kgePrime' } }));
		const res = await owner.call('POST', `/projects/${c.projectId}/auto-calibrations`, {});
		expect(res.status).toBe(400);
		expect(res.body.error).toContain('has only one record');
		const ok = await calibratable(owner, quickRules(), 'Autocal cap');
		expect((await owner.call('POST', `/projects/${ok.projectId}/auto-calibrations`, {})).status).toBe(202);
		expect(AUTO_CALIBRATION_JOBS_PER_USER).toBe(1);
		expect((await owner.call('POST', `/projects/${ok.projectId}/auto-calibrations`, {})).status).toBe(429);
		await drain();
	});

	it('lets the job purge and run trimming clear its links, and nothing else', async () => {
		const owner = await signUp('AutocalLinks');
		const c = await calibratable(owner);
		const res = await owner.call('POST', `/projects/${c.projectId}/auto-calibrations`, {});
		await drain();
		const applied = await owner.call('POST', `/projects/${c.projectId}/auto-calibrations/${res.body.calibration.id}/apply`, {});
		expect(applied.status, JSON.stringify(applied.body)).toBe(200);
		// The purge deletes its (finished) job, and a run it made goes: the foreign keys clear the links.
		await asOwner('DELETE FROM job WHERE project_id = $1', [c.projectId]);
		await asOwner('DELETE FROM model_run WHERE id = $1', [applied.body.runId]);
		const [row] = await asOwner('SELECT job_id, applied_run_id, applied_at, chosen FROM auto_calibration WHERE id = $1', [res.body.calibration.id]);
		expect(row).toMatchObject({ job_id: null, applied_run_id: null, chosen: expect.any(Number) });
		expect(row!.applied_at).not.toBeNull();
		// A body with anything in it is refused: the saved rules decide everything.
		expect((await owner.call('POST', `/projects/${c.projectId}/auto-calibrations`, { seed: 9 })).status).toBe(400);
	});

	it('lets a viewer read the runs but not start or apply one; hides them from anyone else', async () => {
		const owner = await signUp('AutocalRls');
		const viewer = await signUp('AutocalViewer');
		const stranger = await signUp('AutocalStranger');
		const c = await calibratable(owner);
		await member(owner, c.projectId, viewer, 'viewer');
		const res = await owner.call('POST', `/projects/${c.projectId}/auto-calibrations`, {});
		await drain();
		// Positive control: the viewer sees it.
		const seen = await viewer.call('GET', `/projects/${c.projectId}/auto-calibrations`);
		expect(seen.status).toBe(200);
		expect(seen.body.calibrations.map((x: { id: string }) => x.id)).toEqual([res.body.calibration.id]);
		expect((await viewer.call('POST', `/projects/${c.projectId}/auto-calibrations`, {})).status).toBe(403);
		expect((await viewer.call('POST', `/projects/${c.projectId}/auto-calibrations/${res.body.calibration.id}/apply`, {})).status).toBe(403);
		expect((await stranger.call('GET', `/projects/${c.projectId}/auto-calibrations/${res.body.calibration.id}`)).status).toBe(404);
		// Nor can an editor rewrite a complete run's outcome directly.
		await expect(asOwner(`UPDATE auto_calibration SET chosen = NULL WHERE id = $1`, [res.body.calibration.id])).rejects.toThrow(/never changed, only applied/);
	});
});

describe('new data queues the calibration rules (after.onNewData)', () => {
	const merge = (owner: User, projectId: string) =>
		owner.call('POST', `/projects/${projectId}/series/merge`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2014-09-29', values: [4, 0, 9] });
	const due = async (projectId: string) => {
		await asOwner(`UPDATE job SET run_after = now() WHERE project_id = $1 AND status = 'queued'`, [projectId]);
	};

	it('does nothing while off (the default)', async () => {
		const owner = await signUp('AutocalOff');
		const c = await calibratable(owner);
		expect((await merge(owner, c.projectId)).status).toBe(200);
		expect(await asOwner(`SELECT id FROM job WHERE project_id = $1 AND kind = 'auto_calibration'`, [c.projectId])).toEqual([]);
	});

	it('report: runs the rules and keeps the report, applying nothing; one pending job however many merges', async () => {
		const owner = await signUp('AutocalReport');
		const c = await calibratable(owner, quickRules({ after: { onNewData: 'report', ensemble: false } }));
		expect((await merge(owner, c.projectId)).status).toBe(200);
		expect((await owner.call('POST', `/projects/${c.projectId}/series/merge`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2014-10-02', values: [1] })).status).toBe(200);
		expect(await asOwner(`SELECT id FROM job WHERE project_id = $1 AND kind = 'auto_calibration' AND status = 'queued'`, [c.projectId])).toHaveLength(1);
		await due(c.projectId);
		await drain();
		const [row] = (await owner.call('GET', `/projects/${c.projectId}/auto-calibrations`)).body.calibrations;
		expect(row).toMatchObject({ trigger: 'new_data', status: 'complete', appliedAt: null });
		expect((await owner.call('GET', `/projects/${c.projectId}`)).body.project.settings.fitRecord).toBeNull();
	});

	it('apply: applies the kept fit and runs the model only while the rules are signed off', async () => {
		const owner = await signUp('AutocalApply');
		const c = await calibratable(owner, quickRules({ after: { onNewData: 'apply', ensemble: false } }));
		// Draft rules: reported, not applied.
		expect((await merge(owner, c.projectId)).status).toBe(200);
		await due(c.projectId);
		await drain();
		expect((await owner.call('GET', `/projects/${c.projectId}/auto-calibrations`)).body.calibrations[0]).toMatchObject({ trigger: 'new_data', appliedAt: null });
		// Signed off: the next new data applies the fit, with a run.
		const settings = (await owner.call('GET', `/projects/${c.projectId}`)).body.project.settings;
		expect((await owner.call('PATCH', `/projects/${c.projectId}`, { settings: { calibrationRules: { ...settings.calibrationRules, signedOff: { by: 'x', on: '2026-09-29' } } } })).status).toBe(200);
		expect((await owner.call('POST', `/projects/${c.projectId}/series/merge`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2014-10-05', values: [7] })).status).toBe(200);
		await due(c.projectId);
		await drain();
		const [row] = (await owner.call('GET', `/projects/${c.projectId}/auto-calibrations`)).body.calibrations;
		expect(row).toMatchObject({ trigger: 'new_data', status: 'complete', appliedBy: 'AutocalApply', appliedRunId: expect.any(String) });
		const after = (await owner.call('GET', `/projects/${c.projectId}`)).body.project.settings;
		expect(after.fitRecord.auto.rules.signedOff).toEqual({ by: 'x', on: new Date().toISOString().slice(0, 10) });
		const run = (await owner.call('GET', `/projects/${c.projectId}/runs/${row.appliedRunId}`)).body.run;
		expect(run.trigger).toBe('auto');
	});
});
