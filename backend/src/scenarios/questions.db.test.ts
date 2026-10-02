// Masked-rule wording and "Ask the assessors why" (164_applicant_visibility,
// build item 6; docs/scenarios.md § Applications). A rule an application
// breaks because of farms its applicant can't see gives them the catchment's
// aggregate only past FARMER_K hidden holders (else MASKED_RULE); the
// assessors read the real words (`assessorProblems`), never the applicant;
// and the applicant's question reaches the assessors through
// application_question, whose real words they never read back. Every "cannot
// see" has its positive control.
import { FARMER_K, MASKED_RULE } from '@water-management/engine';
import { beforeAll, describe, expect, it } from 'vitest';
import { asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User; // the assessing authority's modeller
let assessor: User; // editor
let viewer: User;
let applicant: User; // contributor, linked to Rooikloof
let consultant: User; // contributor, same party
let other: User; // contributor, another applicant
let holder: User; // farmer: two hidden farms under one holder
let projectId: string;
let published: string;

// Gauge ← Rooikloof (the applicant's) and five hidden farms with manual flow shares (0.18 each: 90 %).
const outlet = node('Gauge', null);
const rooikloof = node('Rooikloof', outlet.id, { flowShareManual: 0.05 });
const HIDDEN = ['Kalkoenkrans', 'Bergvliet', 'Doornhoek', 'Waterval', 'Sonskyn'];
const hidden = HIDDEN.map((n) => node(n, outlet.id, { flowShareManual: 0.18 }));

const P = () => `/projects/${projectId}`;
/** Rooikloof's share to 30 %: the catchment's shares then total 120 %, and only the hidden farms' 90 % makes it so. */
const tooMuch = { op: 'node.set', nodeId: rooikloof.id, field: 'flowShareManual', value: 0.3 };
/** An op on a node that doesn't exist: a problem in plain words, no hidden rule. */
const missing = { op: 'node.set', nodeId: crypto.randomUUID(), field: 'damCapacityM3', value: 1 };
const rowsAs = async <T = Record<string, unknown>>(u: User, sql: string, params: unknown[] = []) =>
	withUser(u.id, async (db) => (await db.query<T & Record<string, unknown>>(sql, params)).rows);
const leaksNoHiddenFarm = (body: unknown) => {
	const text = JSON.stringify(body);
	for (const n of HIDDEN) expect(text, n).not.toContain(n);
	for (const n of hidden) expect(text, n.id).not.toContain(n.id);
};

beforeAll(async () => {
	[owner, assessor, viewer, applicant, consultant, other, holder] = (await Promise.all(
		['Qowner', 'Qassessor', 'Qviewer', 'Qapplicant', 'Qconsultant', 'Qother', 'Qholder'].map((n) => signUp(n))
	)) as [User, User, User, User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Questions' })).body.project.id;
	const model = { nodes: [outlet, rooikloof, ...hidden], crops: [{ id: crypto.randomUUID(), name: 'Citrus', cropFactor: monthly(0.7) }], cropAreas: [], transfers: [] };
	expect((await owner.call('PUT', `${P()}/model`, model)).status).toBe(200);
	expect((await owner.call('PATCH', P(), { settings: { apanMm: monthly(150), flowShareMethod: 'manual' } })).status).toBe(200);
	const days = 60;
	const rain = Array.from({ length: days }, (_, i) => (i % 7 === 0 ? 20 : 0));
	expect((await owner.call('PUT', `${P()}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: rain })).status).toBe(200);
	const run = await owner.call('POST', `${P()}/runs`, { label: 'Baseline' });
	expect(run.status, JSON.stringify(run.body)).toBe(201);
	published = run.body.run.id;
	expect((await owner.call('POST', `${P()}/publication`, { runId: published })).status).toBe(201);
	for (const [u, role] of [
		[assessor, 'editor'],
		[viewer, 'viewer'],
		[applicant, 'contributor'],
		[consultant, 'contributor'],
		[other, 'contributor']
	] as const)
		expect((await owner.call('POST', `${P()}/members`, { email: u.email, role })).status, u.email).toBe(201);
	expect((await owner.call('PUT', `${P()}/farmers/${applicant.id}`, { nodeIds: [rooikloof.id] })).status).toBe(200);
	for (const u of [applicant, consultant]) expect((await owner.call('PATCH', `${P()}/members/${u.id}`, { party: 'Rooikloof Trust' })).status).toBe(200);
});

describe('a rule broken by hidden farms', () => {
	let sid: string;

	it(`gives the applicant the catchment's aggregate at ${FARMER_K} hidden holders, and the rule's line, ops and kind, never the real words`, async () => {
		const res = await applicant.call('POST', `${P()}/scenarios`, { name: 'Rooikloof shares', baseRunId: published, ops: [tooMuch] });
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		sid = res.body.scenario.id;
		expect(res.body.check.problems).toEqual([
			"op 1 (node.set): flow shares would total 120.0 %, more than 100 %; the units you can't see hold 90.0 % of them between them"
		]);
		expect(res.body.check.maskedRules).toEqual([{ problem: 0, ops: [0], rules: ['shares'] }]);
		// Never the assessors' fields.
		expect(res.body.check).not.toHaveProperty('assessorProblems');
		expect(res.body.check).not.toHaveProperty('renamed');
		leaksNoHiddenFarm(res.body);
		// Submitting it is refused with the same refs.
		const submit = await applicant.call('POST', `${P()}/scenarios/${sid}/submit`);
		expect(submit.status).toBe(422);
		expect(submit.body.details).toEqual({ problems: res.body.check.problems, maskedRules: res.body.check.maskedRules });
	});

	it(`keeps the generic words below ${FARMER_K} holders: the aggregate would be someone's own figure (control: ${FARMER_K} above)`, async () => {
		// Two hidden farms under one holder: four holders.
		expect((await owner.call('POST', `${P()}/farmers`, { email: holder.email, nodeIds: [hidden[0]!.id, hidden[1]!.id] })).status).toBe(201);
		const res = await applicant.call('GET', `${P()}/scenarios/${sid}`);
		expect(res.status).toBe(200);
		expect(res.body.check.problems).toEqual([`op 1 (node.set): ${MASKED_RULE}`]);
		expect(res.body.check.maskedRules).toEqual([{ problem: 0, ops: [0], rules: ['shares'] }]);
		// Back to five.
		expect((await owner.call('PUT', `${P()}/farmers/${holder.id}`, { nodeIds: [hidden[0]!.id] })).status).toBe(200);
		expect((await applicant.call('GET', `${P()}/scenarios/${sid}`)).body.check.problems[0]).toContain('90.0 %');
	});

	it('counts the hidden holders for the server only, and for nobody who can’t read the application (control: its applicant)', async () => {
		const rows = await rowsAs<{ n: number }>(applicant, 'SELECT app_application_hidden_holders($1) AS n', [sid]);
		expect(rows[0]!.n).toBe(5);
		// Another contributor reads nothing of it: 0, not the count.
		expect((await rowsAs<{ n: number }>(other, 'SELECT app_application_hidden_holders($1) AS n', [sid]))[0]!.n).toBe(0);
	});
});

describe('Ask the assessors why', () => {
	let sid: string;
	let line: string;
	let questionId: string;

	beforeAll(async () => {
		const res = await applicant.call('POST', `${P()}/scenarios`, { name: 'Rooikloof asks', baseRunId: published, ops: [tooMuch, missing] });
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		sid = res.body.scenario.id;
		expect(res.body.check.problems).toHaveLength(2);
		expect(res.body.check.maskedRules).toEqual([{ problem: 0, ops: [0], rules: ['shares'] }]);
		line = res.body.check.problems[0];
	});

	it('sends a party\'s question to the assessors, and gives back the party\'s view only', async () => {
		const res = await applicant.call('POST', `${P()}/scenarios/${sid}/questions`, { problem: 0, line });
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		questionId = res.body.question.id;
		expect(res.body.question).toEqual({ id: questionId, askedAt: expect.any(String), problem: line, opIndexes: [0], rules: ['shares'], answer: null, answeredAt: null });
		leaksNoHiddenFarm(res.body);
	});

	it('refuses a line no hidden rule broke, a line the check no longer shows, and a team scenario', async () => {
		const unmasked = await applicant.call('GET', `${P()}/scenarios/${sid}`);
		const plain = await applicant.call('POST', `${P()}/scenarios/${sid}/questions`, { problem: 1, line: unmasked.body.check.problems[1] });
		expect(plain.status).toBe(422);
		const stale = await applicant.call('POST', `${P()}/scenarios/${sid}/questions`, { problem: 0, line: `${line} (read before)` });
		expect(stale.status).toBe(409);
		const team = await owner.call('POST', `${P()}/scenarios`, { name: 'Team', baseRunId: published, ops: [] });
		expect((await owner.call('POST', `${P()}/scenarios/${team.body.scenario.id}/questions`, { problem: 0, line: 'x' })).status).toBe(409);
	});

	it("lets the application's parties read it, and nobody else (control: the applicant and their shared consultant do)", async () => {
		expect((await applicant.call('GET', `${P()}/scenarios/${sid}/questions`)).body.questions).toHaveLength(1);
		// Not shared yet: the consultant doesn't read the application at all.
		expect((await consultant.call('GET', `${P()}/scenarios/${sid}/questions`)).status).toBe(404);
		expect((await applicant.call('POST', `${P()}/scenarios/${sid}/members`, { userId: consultant.id })).status).toBe(201);
		const shared = await consultant.call('GET', `${P()}/scenarios/${sid}/questions`);
		expect(shared.status).toBe(200);
		expect(shared.body.questions.map((q: { id: string }) => q.id)).toEqual([questionId]);
		expect(shared.body.questions[0]).not.toHaveProperty('assessorText');
		expect(shared.body.questions[0]).not.toHaveProperty('ops');
		// Another applicant, a viewer (a draft is no viewer's), a stranger to the project.
		expect((await other.call('GET', `${P()}/scenarios/${sid}/questions`)).status).toBe(404);
		expect((await viewer.call('GET', `${P()}/scenarios/${sid}/questions`)).status).toBe(404);
		expect((await other.call('POST', `${P()}/scenarios/${sid}/questions`, { problem: 0, line })).status).toBe(404);
		// The table itself: no party reads a row (its real words), the assessors do.
		expect(await rowsAs(applicant, 'SELECT * FROM application_question')).toEqual([]);
		expect(await rowsAs(assessor, 'SELECT id FROM application_question WHERE scenario_id = $1', [sid])).toHaveLength(1);
	});

	it("gives the assessors the real words, the ops and the application's name, without opening the draft to them", async () => {
		const list = await assessor.call('GET', `${P()}/application-questions`);
		expect(list.status).toBe(200);
		const q = list.body.questions.find((x: { id: string }) => x.id === questionId);
		expect(q).toMatchObject({ scenarioId: sid, scenarioName: 'Rooikloof asks', problem: line, opIndexes: [0], ops: [tooMuch], rules: ['shares'], answer: null });
		// The rule in its own words, not the applicant's.
		expect(q.assessorText).not.toBe(line);
		expect(q.assessorText).toMatch(/^op 1 \(node\.set\): /);
		expect(q.assessorText).not.toContain("units you can't see");
		// The draft stays the applicant's.
		expect((await assessor.call('GET', `${P()}/scenarios/${sid}`)).status).toBe(404);
		// The per-application list, for the assessors, is the same row.
		expect((await assessor.call('GET', `${P()}/scenarios/${sid}/questions`)).body.questions[0].assessorText).toBe(q.assessorText);
		// A viewer has no queue.
		expect((await viewer.call('GET', `${P()}/application-questions`)).status).toBe(403);
	});

	it('is answered once, by an editor; the parties read the answer', async () => {
		expect((await applicant.call('POST', `${P()}/application-questions/${questionId}/answer`, { answer: 'self-answered' })).status).toBe(403);
		expect((await viewer.call('POST', `${P()}/application-questions/${questionId}/answer`, { answer: 'x' })).status).toBe(403);
		const res = await assessor.call('POST', `${P()}/application-questions/${questionId}/answer`, { answer: 'The other units hold 90 % between them; reduce your share to 10 %.' });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.question).toMatchObject({ id: questionId, answer: 'The other units hold 90 % between them; reduce your share to 10 %.', answeredAt: expect.any(String) });
		expect((await assessor.call('POST', `${P()}/application-questions/${questionId}/answer`, { answer: 'again' })).status).toBe(409);
		const mine = await applicant.call('GET', `${P()}/scenarios/${sid}/questions`);
		expect(mine.body.questions[0]).toMatchObject({ answer: 'The other units hold 90 % between them; reduce your share to 10 %.', answeredAt: expect.any(String) });
	});

	it('is written only through its functions: no one updates or inserts a row', async () => {
		await expect(rowsAs(assessor, `UPDATE application_question SET problem = 'x' WHERE id = $1`, [questionId])).rejects.toThrow(/permission denied/);
		expect((await rowsAs<{ r: string }>(assessor, `SELECT app_answer_assessors_question($1, $2, 'changed') AS r`, [projectId, questionId]))[0]!.r).toBe('already');
		await expect(asOwner(`UPDATE application_question SET answer = 'changed' WHERE id = $1`, [questionId])).rejects.toThrow(/answered once/);
		// A party gets nothing from the answer function (control: the editor's answer above went in).
		expect((await rowsAs<{ r: string }>(applicant, `SELECT app_answer_assessors_question($1, $2, 'x') AS r`, [projectId, questionId]))[0]!.r).toBe('none');
		// Nor through the table, nor insert one at all: they ask through the function.
		await expect(rowsAs(applicant, `UPDATE application_question SET answer = 'x' WHERE id = $1`, [questionId])).rejects.toThrow(/permission denied/);
		await expect(
			rowsAs(applicant, `INSERT INTO application_question (project_id, scenario_id, scenario_name, problem, op_indexes, ops, rules, assessor_text) VALUES ($1, $2, 'n', 'p', '{0}', '[]', '{shares}', 't')`, [projectId, sid])
		).rejects.toThrow(/permission denied/);
		// Not on another applicant's application (control: their own goes in, under its own project and name).
		const ask = `SELECT app_ask_assessors($1, 'p', '{0}', '[]', '{shares}', 't') AS id`;
		await expect(rowsAs(other, ask, [sid])).rejects.toThrow(/only a party/);
		const [own] = await rowsAs<{ id: string }>(applicant, ask, [sid]);
		const [row] = await rowsAs<{ project_id: string; scenario_name: string }>(assessor, 'SELECT project_id, scenario_name FROM application_question WHERE id = $1', [own!.id]);
		expect(row).toEqual({ project_id: projectId, scenario_name: 'Rooikloof asks' });
		// The guard holds for the owner's own writes too: no question is born answered.
		await expect(
			asOwner(`INSERT INTO application_question (project_id, scenario_id, scenario_name, problem, op_indexes, ops, rules, assessor_text, answer) VALUES ($1, $2, 'n', 'p', '{0}', '[]', '{shares}', 't', 'x')`, [projectId, sid])
		).rejects.toThrow(/asked without an answer/);
	});

	it('records both in the history, with ids and kinds, never the words', async () => {
		const rows = await rowsAs<{ kind: string; subject: Record<string, unknown> }>(
			owner,
			`SELECT kind, subject FROM audit_event WHERE project_id = $1 AND kind LIKE 'application.question_%' ORDER BY id`,
			[projectId]
		);
		expect(rows.map((r) => r.kind)).toEqual(['application.question_asked', 'application.question_answered']);
		expect(rows[0]!.subject).toEqual({ scenarioId: sid, questionId, application: true, ops: [0], rules: ['shares'] });
		expect(JSON.stringify(rows)).not.toMatch(/90(\.0)? %|Rooikloof asks|between them/);
	});

	it('goes with the application', async () => {
		expect((await applicant.call('DELETE', `${P()}/scenarios/${sid}`)).status).toBe(204);
		expect(await rowsAs(assessor, 'SELECT id FROM application_question WHERE scenario_id = $1', [sid])).toEqual([]);
	});
});

describe("the assessors' words on a submitted application", () => {
	it('come to editors only: the applicant reads the masked lines and their refs, never `assessorProblems`', async () => {
		const res = await applicant.call('POST', `${P()}/scenarios`, { name: 'Rooikloof fine', baseRunId: published, ops: [{ ...tooMuch, value: 0.08 }] });
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		const sid = res.body.scenario.id;
		expect((await applicant.call('POST', `${P()}/scenarios/${sid}/submit`)).status).toBe(200);
		const mine = await applicant.call('GET', `${P()}/scenarios/${sid}`);
		expect(mine.body.check).toEqual({ applied: expect.any(Array), problems: [], classified: expect.any(Array), maskedRules: [] });
		const theirs = await assessor.call('GET', `${P()}/scenarios/${sid}`);
		expect(theirs.body.check).toMatchObject({ problems: [], maskedRules: [], assessorProblems: [], renamed: [], reIds: [] });
	});
});
