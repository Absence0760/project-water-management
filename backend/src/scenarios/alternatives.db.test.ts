// The mitigation alternatives a scenario cites (298_scenario_alternatives;
// docs/scenarios.md § Mitigation alternatives, docs/api.md § Scenarios,
// docs/data-model.md § Scenarios): an application cites up to three runs of
// its applicant's own other scenarios on the same base run, labelled; the
// route and scenario_alternative_guard refuse another applicant's run, the
// application's own, one on another base run or another project, and any
// change once submitted; the assessors read the cited runs (and the evidence
// report sets them beside the application) once it is submitted, never
// before; a frozen citation keeps its run and its scenario; a rebase drops
// those on the old base. Every "can't" has its positive control.
import type { EvidenceReport } from '@water-management/engine';
import { beforeAll, describe, expect, it } from 'vitest';
import { asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { NOT_A_CANDIDATE } from './alternatives.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let editor: User;
let viewer: User;
let applicant: User;
let consultant: User;
let otherApplicant: User;
let projectId: string;
let published: string;
let farmId: string;
let otherFarmId: string;

const P = () => `/projects/${projectId}`;
const S = (sid: string) => `${P()}/scenarios/${sid}`;
const dam = (nodeId: string, value: number) => ({ op: 'node.set', nodeId, field: 'damCapacityM3', value });

/** A scenario made by `u` on `base`, and one run of it. */
async function scenarioWithRun(u: User, name: string, ops: unknown[], base = published) {
	const res = await u.call('POST', `${P()}/scenarios`, { name, baseRunId: base, ops });
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	const sid = res.body.scenario.id as string;
	const run = await u.call('POST', `${S(sid)}/runs`, { label: name });
	expect(run.status, JSON.stringify(run.body)).toBe(201);
	return { sid, runId: run.body.run.id as string };
}

beforeAll(async () => {
	[owner, editor, viewer, applicant, consultant, otherApplicant] = (await Promise.all(
		['Altowner', 'Alteditor', 'Altviewer', 'Altapplicant', 'Altconsultant', 'Altother'].map((n) => signUp(n))
	)) as [User, User, User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Mitigation alternatives' })).body.project.id;
	const outlet = node('Gauge', null);
	const farm = node('Rooikloof', outlet.id, { damCapacityM3: 100_000 });
	const other = node('Kleinvlei', outlet.id, { damCapacityM3: 50_000 });
	farmId = farm.id;
	otherFarmId = other.id;
	expect((await owner.call('PUT', `${P()}/model`, { nodes: [outlet, farm, other], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
	expect((await owner.call('PATCH', P(), { settings: { apanMm: monthly(150) } })).status).toBe(200);
	const rain = Array.from({ length: 60 }, (_, i) => (i % 7 === 0 ? 20 : 0));
	expect((await owner.call('PUT', `${P()}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: rain })).status).toBe(200);
	published = (await owner.call('POST', `${P()}/runs`, { label: 'Baseline' })).body.run.id;
	expect((await owner.call('POST', `${P()}/publication`, { runId: published })).status).toBe(201);
	for (const [u, role] of [
		[editor, 'editor'],
		[viewer, 'viewer'],
		[applicant, 'contributor'],
		[consultant, 'contributor'],
		[otherApplicant, 'contributor']
	] as const)
		expect((await owner.call('POST', `${P()}/members`, { email: u.email, role })).status, u.email).toBe(201);
	expect((await owner.call('PUT', `${P()}/farmers/${applicant.id}`, { nodeIds: [farmId] })).status).toBe(200);
	expect((await owner.call('PUT', `${P()}/farmers/${otherApplicant.id}`, { nodeIds: [otherFarmId] })).status).toBe(200);
	for (const u of [applicant, consultant]) expect((await owner.call('PATCH', `${P()}/members/${u.id}`, { party: 'Rooikloof Trust' })).status).toBe(200);
}, 120_000);

describe('an application’s mitigation alternatives', () => {
	let app: { sid: string; runId: string };
	let smaller: { sid: string; runId: string };
	let winter: { sid: string; runId: string };
	let others: { sid: string; runId: string };

	beforeAll(async () => {
		app = await scenarioWithRun(applicant, 'Raise Rooikloof', [dam(farmId, 300_000)]);
		smaller = await scenarioWithRun(applicant, 'Raise Rooikloof, smaller', [dam(farmId, 150_000)]);
		winter = await scenarioWithRun(applicant, 'Raise Rooikloof, winter only', [dam(farmId, 200_000)]);
		others = await scenarioWithRun(otherApplicant, 'Raise Kleinvlei', [dam(otherFarmId, 90_000)]);
		expect((await applicant.call('POST', `${S(app.sid)}/members`, { userId: consultant.id })).status).toBe(201);
	}, 120_000);

	it('offers the applicant their own other scenarios’ runs on the base, never another applicant’s nor the application’s own', async () => {
		const res = await applicant.call('GET', `${S(app.sid)}/alternatives`);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.alternatives).toEqual([]);
		const offered = res.body.candidates.map((c: { runId: string }) => c.runId);
		expect(offered).toEqual(expect.arrayContaining([smaller.runId, winter.runId]));
		expect(offered).not.toContain(others.runId);
		expect(offered).not.toContain(app.runId);
		// The consultant it is shared with reads the list but may cite nothing (only the applicant changes it).
		const shared = await consultant.call('GET', `${S(app.sid)}/alternatives`);
		expect(shared.status).toBe(200);
		expect(shared.body.candidates).toEqual([]);
	});

	it('cites them labelled, in order, and logs the change; the scenario carries them', async () => {
		const res = await applicant.call('PUT', `${S(app.sid)}/alternatives`, {
			alternatives: [
				{ runId: smaller.runId, label: '  Smaller dam ' },
				{ runId: winter.runId, label: 'Winter abstraction only' }
			]
		});
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.alternatives.map((a: { position: number; label: string; runId: string; scenarioId: string; scenarioName: string }) => [a.position, a.label, a.runId, a.scenarioId, a.scenarioName])).toEqual([
			[0, 'Smaller dam', smaller.runId, smaller.sid, 'Raise Rooikloof, smaller'],
			[1, 'Winter abstraction only', winter.runId, winter.sid, 'Raise Rooikloof, winter only']
		]);
		expect((await applicant.call('GET', S(app.sid))).body.alternatives).toHaveLength(2);
		// The consultant reads them with the application.
		expect((await consultant.call('GET', S(app.sid))).body.alternatives.map((a: { label: string }) => a.label)).toEqual(['Smaller dam', 'Winter abstraction only']);
		const [e] = await asOwner(`SELECT subject FROM audit_event WHERE project_id = $1 AND kind = 'scenario.changed' AND subject->>'scenarioId' = $2 ORDER BY id DESC LIMIT 1`, [projectId, app.sid]);
		expect(e.subject).toMatchObject({ application: true, fields: ['alternatives'], alternatives: 2 });
		expect(e.subject.name).toBeUndefined();
	});

	it('refuses another applicant’s run, its own run, an unknown run and another project’s with one answer, and keeps the list', async () => {
		const otherProject = (await owner.call('POST', '/projects', { name: 'Elsewhere' })).body.project.id as string;
		const [{ id: elsewhereRun }] = await asOwner(
			`INSERT INTO model_run (project_id, created_by, engine_version, start_date, end_date, inputs) VALUES ($1, $2, 'x', '2020-01-01', '2020-01-02', '{}') RETURNING id::text`,
			[otherProject, owner.id]
		);
		for (const runId of [others.runId, app.runId, crypto.randomUUID(), elsewhereRun]) {
			const res = await applicant.call('PUT', `${S(app.sid)}/alternatives`, { alternatives: [{ runId, label: 'Not mine' }] });
			expect(res.status, runId).toBe(422);
			expect(res.body.error).toBe(NOT_A_CANDIDATE);
		}
		expect((await applicant.call('GET', S(app.sid))).body.alternatives).toHaveLength(2);
	});

	it('refuses a bad list: more than three, the same run twice, a blank label, an unknown key', async () => {
		const third = await scenarioWithRun(applicant, 'Raise Rooikloof, third', [dam(farmId, 250_000)]);
		const fourth = await scenarioWithRun(applicant, 'Raise Rooikloof, fourth', [dam(farmId, 260_000)]);
		const four = [smaller, winter, third, fourth].map((x, i) => ({ runId: x.runId, label: `Option ${i + 1}` }));
		expect((await applicant.call('PUT', `${S(app.sid)}/alternatives`, { alternatives: four })).status).toBe(400);
		// Positive control: three are taken.
		expect((await applicant.call('PUT', `${S(app.sid)}/alternatives`, { alternatives: four.slice(0, 3) })).status).toBe(200);
		for (const alternatives of [
			[four[0], four[0]],
			[{ runId: smaller.runId, label: '  ' }],
			[{ runId: smaller.runId, label: 'x'.repeat(81) }],
			[{ runId: smaller.runId, label: 'x', extra: 1 }]
		])
			expect((await applicant.call('PUT', `${S(app.sid)}/alternatives`, { alternatives })).status, JSON.stringify(alternatives)).toBe(400);
		expect((await applicant.call('PUT', `${S(app.sid)}/alternatives`, { alternatives: four.slice(0, 2).map((x, i) => ({ ...x, label: ['Smaller dam', 'Winter abstraction only'][i] })) })).status).toBe(200);
	});

	it('lets only the applicant change them: not the consultant, another applicant, nor an editor of a draft', async () => {
		const body = { alternatives: [] };
		expect((await consultant.call('PUT', `${S(app.sid)}/alternatives`, body)).status).toBe(403);
		for (const u of [otherApplicant, editor]) expect((await u.call('PUT', `${S(app.sid)}/alternatives`, body)).status, u.email).toBe(404);
		// In the table too: RLS lets no one but the applicant cite or drop (the editor's DELETE matches nothing).
		const del = await withUser(editor.id, (db) => db.query('DELETE FROM scenario_alternative WHERE scenario_id = $1', [app.sid]));
		expect(del.rowCount).toBe(0);
		expect((await applicant.call('GET', S(app.sid))).body.alternatives).toHaveLength(2);
	});

	it('refuses in the table what the route refuses: another applicant’s run (the guard), an UPDATE', async () => {
		await expect(
			withUser(applicant.id, (db) =>
				db.query('INSERT INTO scenario_alternative (project_id, scenario_id, alternative_scenario_id, run_id, position, label) VALUES ($1, $2, $3, $4, 2, $5)', [
					projectId,
					app.sid,
					others.sid,
					others.runId,
					'Theirs'
				])
			)
		).rejects.toMatchObject({ code: '23514', message: 'an alternative is a run of another of your own scenarios' });
		await expect(withUser(applicant.id, (db) => db.query(`UPDATE scenario_alternative SET label = 'Changed' WHERE scenario_id = $1`, [app.sid]))).rejects.toMatchObject({
			code: '42501'
		});
	});

	it('keeps the cited runs from the assessors while it is a draft (the application’s parties only)', async () => {
		expect((await editor.call('GET', `${P()}/runs/${smaller.runId}`)).status).toBe(404);
		const [{ n }] = await asOwner('SELECT count(*)::int AS n FROM model_run WHERE id = $1', [smaller.runId]);
		expect(n).toBe(1);
	});

	describe('once submitted', () => {
		beforeAll(async () => {
			const res = await applicant.call('POST', `${S(app.sid)}/submit`);
			expect(res.status, JSON.stringify(res.body)).toBe(200);
		});

		it('is frozen: the route, the table (a DELETE) and the cited scenario’s deletion all refuse', async () => {
			const put = await applicant.call('PUT', `${S(app.sid)}/alternatives`, { alternatives: [] });
			expect(put.status).toBe(409);
			expect(put.body.error).toMatch(/frozen/);
			await expect(withUser(applicant.id, (db) => db.query('DELETE FROM scenario_alternative WHERE scenario_id = $1', [app.sid]))).rejects.toMatchObject({ code: '23001' });
			const del = await applicant.call('DELETE', S(smaller.sid));
			expect(del.status).toBe(409);
			expect(del.body.error).toMatch(/mitigation alternative/);
			// Positive control: an uncited draft of theirs is deleted as ever.
			const loose = await scenarioWithRun(applicant, 'Loose end', [dam(farmId, 110_000)]);
			expect((await applicant.call('DELETE', S(loose.sid))).status).toBe(204);
		});

		it('keeps the cited runs (no trim or delete), and only those', async () => {
			const kept = await asOwner('SELECT id::text, app_run_kept(id) AS kept FROM model_run WHERE id = ANY($1::uuid[])', [[smaller.runId, winter.runId, others.runId]]);
			expect(Object.fromEntries(kept.map((r) => [r.id, r.kept]))).toEqual({ [smaller.runId]: true, [winter.runId]: true, [others.runId]: false });
		});

		it('shows the assessors the cited runs, and nothing else of the applicant’s drafts', async () => {
			const res = await editor.call('GET', `${P()}/runs/${smaller.runId}`);
			expect(res.status, JSON.stringify(res.body)).toBe(200);
			expect(res.body.run.citedBy).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'alternative', id: app.sid, name: 'Raise Rooikloof' })]));
			// Not another draft of the applicant's, nor another applicant's run (no citation makes them readable).
			const third = await applicant.call('GET', `${S(app.sid)}/alternatives`);
			const uncited = third.body.candidates.map((c: { runId: string }) => c.runId).filter((id: string) => id !== smaller.runId && id !== winter.runId);
			expect(uncited.length).toBeGreaterThan(0);
			for (const id of [...uncited, others.runId]) expect((await editor.call('GET', `${P()}/runs/${id}`)).status, id).toBe(404);
			// A viewer reads no submitted application, so no run it cites either.
			expect((await viewer.call('GET', `${P()}/runs/${smaller.runId}`)).status).toBe(404);
			// The editors read the list with the application.
			expect((await editor.call('GET', S(app.sid))).body.alternatives.map((a: { label: string }) => a.label)).toEqual(['Smaller dam', 'Winter abstraction only']);
		});

		it('sets them beside the application on the evidence report’s page 1 (evidence-26)', async () => {
			const res = await editor.call('GET', `${P()}/runs/${app.runId}/evidence-report`);
			expect(res.status, JSON.stringify(res.body)).toBe(200);
			const r = res.body.report as EvidenceReport;
			expect(r.alternatives!.map((a) => [a.label, a.runId, a.scenarioName, a.notAssessed])).toEqual([
				['Smaller dam', smaller.runId, 'Raise Rooikloof, smaller', null],
				['Winter abstraction only', winter.runId, 'Raise Rooikloof, winter only', null]
			]);
			expect(r.alternatives![0]!.ops).toEqual([{ index: 0, class: 'proposal', op: dam(farmId, 150_000) }]);
			for (const row of r.rows) expect(row.alternatives, row.id).toHaveLength(2);
			const days = r.rows.find((x) => x.id === 'ewrDays')!;
			const [{ s }] = await asOwner('SELECT summary AS s FROM model_run WHERE id = $1', [smaller.runId]);
			expect(days.alternatives![0]!.value).toBe(s.catchment.ewrDaysNotMet);
		});

		it('comes back with the draft: withdrawn it stays frozen, reopened it takes changes again', async () => {
			expect((await applicant.call('POST', `${S(app.sid)}/withdraw`)).status).toBe(200);
			expect((await applicant.call('PUT', `${S(app.sid)}/alternatives`, { alternatives: [] })).status).toBe(409);
			expect((await applicant.call('POST', `${S(app.sid)}/reopen`)).status).toBe(200);
			const res = await applicant.call('PUT', `${S(app.sid)}/alternatives`, { alternatives: [{ runId: smaller.runId, label: 'Smaller dam' }] });
			expect(res.status, JSON.stringify(res.body)).toBe(200);
			expect(res.body.alternatives).toHaveLength(1);
			// A draft's citation keeps nothing: winter's run may be trimmed again, and the editors no longer read smaller's.
			const kept = await asOwner('SELECT id::text, app_run_kept(id) AS kept FROM model_run WHERE id = ANY($1::uuid[])', [[smaller.runId, winter.runId]]);
			expect(kept.every((r) => r.kept === false)).toBe(true);
			expect((await editor.call('GET', `${P()}/runs/${smaller.runId}`)).status).toBe(404);
		});
	});

	it('refuses a run on another base run, and a rebase drops those on the old base', async () => {
		// A second published baseline, and a scenario of the applicant's on it.
		const second = (await owner.call('POST', `${P()}/runs`, { label: 'Baseline 2' })).body.run.id as string;
		expect((await owner.call('POST', `${P()}/publication`, { runId: second })).status).toBe(201);
		const onSecond = await scenarioWithRun(applicant, 'On the second baseline', [dam(farmId, 140_000)], second);
		const res = await applicant.call('PUT', `${S(app.sid)}/alternatives`, { alternatives: [{ runId: onSecond.runId, label: 'Elsewhere' }] });
		expect(res.status).toBe(422);
		expect(res.body.error).toBe(NOT_A_CANDIDATE);
		// In the table, the guard says why (it is the applicant's own run).
		await expect(
			withUser(applicant.id, (db) =>
				db.query('INSERT INTO scenario_alternative (project_id, scenario_id, alternative_scenario_id, run_id, position, label) VALUES ($1, $2, $3, $4, 2, $5)', [
					projectId,
					app.sid,
					onSecond.sid,
					onSecond.runId,
					'Elsewhere'
				])
			)
		).rejects.toMatchObject({ code: '23514', message: 'an alternative is a run on the same base run as the scenario it is cited by' });
		expect((await applicant.call('GET', S(app.sid))).body.alternatives).toHaveLength(1);
		const rebased = await applicant.call('POST', `${S(app.sid)}/rebase`, { baseRunId: second });
		expect(rebased.status, JSON.stringify(rebased.body)).toBe(200);
		expect((await applicant.call('GET', S(app.sid))).body.alternatives).toEqual([]);
		// Positive control: on the new base, the run on it is the one offered and taken.
		const ok = await applicant.call('PUT', `${S(app.sid)}/alternatives`, { alternatives: [{ runId: onSecond.runId, label: 'Smaller dam' }] });
		expect(ok.status, JSON.stringify(ok.body)).toBe(200);
	});
});

describe('a team scenario’s alternatives', () => {
	it('are the team’s other scenarios’ runs on its base: an editor cites one, never an application’s', async () => {
		const [{ base }] = await asOwner(`SELECT run_id::text AS base FROM run_publication WHERE project_id = $1 AND superseded_at IS NULL`, [projectId]);
		const team = await scenarioWithRun(editor, 'Team option A', [dam(farmId, 120_000)], base);
		const alt = await scenarioWithRun(editor, 'Team option B', [dam(farmId, 130_000)], base);
		const applicants = await applicant.call('GET', `${P()}/scenarios`);
		const appSid = applicants.body.scenarios.find((s: { name: string }) => s.name === 'On the second baseline').id;
		const [{ id: appRun }] = await asOwner('SELECT id::text FROM model_run WHERE scenario_id = $1 LIMIT 1', [appSid]);
		expect((await editor.call('PUT', `${S(team.sid)}/alternatives`, { alternatives: [{ runId: appRun, label: 'Theirs' }] })).status).toBe(422);
		const res = await editor.call('PUT', `${S(team.sid)}/alternatives`, { alternatives: [{ runId: alt.runId, label: 'Option B' }] });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		// A viewer reads a team scenario, and so its alternatives; may change none.
		expect((await viewer.call('GET', S(team.sid))).body.alternatives.map((a: { label: string }) => a.label)).toEqual(['Option B']);
		expect((await viewer.call('PUT', `${S(team.sid)}/alternatives`, { alternatives: [] })).status).toBe(403);
	});
});
