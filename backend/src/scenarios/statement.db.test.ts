// Appendix C's fixed prompts on a scenario (129_scenario_statement; docs/api.md
// § Scenarios, docs/data-model.md § Scenarios, docs/design/evidence-report.md
// § 4.3): the answers to purpose and need, mitigation and monitoring. Who
// writes them follows the scenario's existing rules (an editor on a team
// scenario, only the applicant on an application), who reads them follows its
// RLS, a submission doesn't freeze them (as the description), a decision can't
// change them, and each is at most 4 000 characters. Every "can't" has its
// positive control.
import { beforeAll, describe, expect, it } from 'vitest';
import { asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let editor: User;
let viewer: User;
let applicant: User;
let consultant: User;
let otherApplicant: User;
let farmer: User;
let stranger: User;
let projectId: string;
let published: string;
let farmId: string;

const P = () => `/projects/${projectId}`;
const S = (sid: string) => `${P()}/scenarios/${sid}`;
const answers = (b: { scenario: Record<string, unknown> }) => ({
	purposeAndNeed: b.scenario.purposeAndNeed,
	mitigation: b.scenario.mitigation,
	monitoring: b.scenario.monitoring
});
const dam = () => ({ op: 'node.set', nodeId: farmId, field: 'damCapacityM3', value: 120_000 });

beforeAll(async () => {
	[owner, editor, viewer, applicant, consultant, otherApplicant, farmer, stranger] = (await Promise.all(
		['Stowner', 'Steditor', 'Stviewer', 'Stapplicant', 'Stconsultant', 'Stother', 'Stfarmer', 'Ststranger'].map((n) => signUp(n))
	)) as [User, User, User, User, User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Statements' })).body.project.id;
	const outlet = node('Gauge', null);
	const farm = node('Rooikloof', outlet.id, { damCapacityM3: 100_000 });
	farmId = farm.id;
	expect((await owner.call('PUT', `${P()}/model`, { nodes: [outlet, farm], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
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
	expect((await owner.call('POST', `${P()}/farmers`, { email: farmer.email, nodeIds: [farmId] })).status).toBe(201);
	expect((await owner.call('PUT', `${P()}/farmers/${applicant.id}`, { nodeIds: [farmId] })).status).toBe(200);
	for (const u of [applicant, consultant]) expect((await owner.call('PATCH', `${P()}/members/${u.id}`, { party: 'Rooikloof Trust' })).status).toBe(200);
}, 120_000);

describe('a team scenario’s statement', () => {
	let sid: string;

	it('starts unanswered, and an editor answers it (trimmed; whitespace alone is not given)', async () => {
		const made = await editor.call('POST', `${P()}/scenarios`, { name: 'Raise Rooikloof', baseRunId: published, ops: [dam()], purposeAndNeed: 'Winter storage.' });
		expect(made.status, JSON.stringify(made.body)).toBe(201);
		sid = made.body.scenario.id;
		expect(answers(made.body)).toEqual({ purposeAndNeed: 'Winter storage.', mitigation: '', monitoring: '' });
		const res = await editor.call('PATCH', S(sid), { mitigation: '  Releases in the dry months.\n', monitoring: '   ' });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(answers(res.body)).toEqual({ purposeAndNeed: 'Winter storage.', mitigation: 'Releases in the dry months.', monitoring: '' });
		// Logged by field, like any other change.
		const [e] = await asOwner(`SELECT subject FROM audit_event WHERE project_id = $1 AND kind = 'scenario.changed' AND subject->>'scenarioId' = $2 ORDER BY id DESC LIMIT 1`, [
			projectId,
			sid
		]);
		expect(e.subject.fields).toEqual(['mitigation']);
	});

	it('is read by a viewer (positive control) but written only by an editor; a farmer and a stranger get nothing', async () => {
		expect(answers((await viewer.call('GET', S(sid))).body).mitigation).toBe('Releases in the dry months.');
		expect((await viewer.call('PATCH', S(sid), { mitigation: 'x' })).status).toBe(403);
		expect((await farmer.call('GET', S(sid))).status).toBe(403);
		expect((await farmer.call('PATCH', S(sid), { mitigation: 'x' })).status).toBe(403);
		expect((await stranger.call('PATCH', S(sid), { mitigation: 'x' })).status).toBe(404);
		// Nothing moved.
		expect(answers((await editor.call('GET', S(sid))).body).mitigation).toBe('Releases in the dry months.');
	});

	it('holds each answer to 4 000 characters, in the API (400) and the table (CHECK); 4 000 itself is kept', async () => {
		expect((await editor.call('PATCH', S(sid), { monitoring: 'x'.repeat(4001) })).status).toBe(400);
		await expect(withUser(editor.id, (db) => db.query(`UPDATE scenario SET monitoring = repeat('x', 4001) WHERE id = $1`, [sid]))).rejects.toMatchObject({ code: '23514' });
		const res = await editor.call('PATCH', S(sid), { monitoring: 'x'.repeat(4000) });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect((res.body.scenario.monitoring as string).length).toBe(4000);
		expect((await editor.call('PATCH', S(sid), { monitoring: 'nul\u0000' })).status).toBe(400);
	});
});

describe('an application’s statement', () => {
	let sid: string;

	beforeAll(async () => {
		const res = await applicant.call('POST', `${P()}/scenarios`, { name: 'Raise Rooikloof', baseRunId: published, ops: [dam()] });
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		sid = res.body.scenario.id;
		expect((await applicant.call('POST', `${S(sid)}/members`, { userId: consultant.id })).status).toBe(201);
	});

	it('is answered by its applicant; the consultant it is shared with reads it but can’t change it; another applicant can’t see it', async () => {
		const res = await applicant.call('PATCH', S(sid), { purposeAndNeed: 'Storage for 60 ha of citrus.', monitoring: 'A weir below the dam.' });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(answers((await consultant.call('GET', S(sid))).body)).toEqual({ purposeAndNeed: 'Storage for 60 ha of citrus.', mitigation: '', monitoring: 'A weir below the dam.' });
		expect((await consultant.call('PATCH', S(sid), { mitigation: 'x' })).status).toBe(403);
		expect((await otherApplicant.call('GET', S(sid))).status).toBe(404);
		expect((await otherApplicant.call('PATCH', S(sid), { mitigation: 'x' })).status).toBe(404);
		// A draft is the applicant's alone: the assessors don't read it yet.
		expect((await editor.call('GET', S(sid))).status).toBe(404);
		// The table agrees: RLS keeps another applicant's write from reaching the row (0 rows), the applicant's reaches it.
		expect((await withUser(otherApplicant.id, (db) => db.query(`UPDATE scenario SET mitigation = 'x' WHERE id = $1`, [sid]))).rowCount).toBe(0);
		expect((await withUser(applicant.id, (db) => db.query(`UPDATE scenario SET mitigation = mitigation WHERE id = $1`, [sid]))).rowCount).toBe(1);
	});

	it('stays the applicant’s to correct once submitted (not frozen, as the description); the assessors read it but can’t change it', async () => {
		expect((await applicant.call('POST', `${S(sid)}/submit`)).status).toBe(200);
		const res = await applicant.call('PATCH', S(sid), { mitigation: 'A low-flow release pipe.' });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(answers((await editor.call('GET', S(sid))).body).mitigation).toBe('A low-flow release pipe.');
		expect((await editor.call('PATCH', S(sid), { mitigation: 'Changed by the assessor' })).status).toBe(403);
		await expect(withUser(editor.id, (db) => db.query(`UPDATE scenario SET mitigation = 'Changed by the assessor' WHERE id = $1`, [sid]))).rejects.toMatchObject({
			code: '42501'
		});
	});

	it('can’t be changed by the decision (scenario_guard), which otherwise goes through (positive control)', async () => {
		await expect(
			withUser(editor.id, (db) => db.query(`UPDATE scenario SET status = 'decided', outcome = 'approved', monitoring = 'Nothing' WHERE id = $1`, [sid]))
		).rejects.toMatchObject({ code: '23514', message: 'a decision changes nothing else in the application' });
		const res = await editor.call('POST', `${S(sid)}/decide`, { outcome: 'approved' });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(answers(res.body)).toEqual({ purposeAndNeed: 'Storage for 60 ha of citrus.', mitigation: 'A low-flow release pipe.', monitoring: 'A weir below the dam.' });
	});
});
