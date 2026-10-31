// The WULA reference on a scenario (294_wula_reference; docs/scenarios.md
// § The WULA reference, docs/api.md § Scenarios, docs/data-model.md
// § Scenarios): the application's number and the works as applied for, and
// each op's `works` tag. Whoever may change the scenario writes it (an editor
// on a team scenario, only the applicant on an application), whoever reads the
// scenario reads it, it freezes on submission (scenario_wula_frozen) and comes
// back with the draft, and the check warns, never refuses, of a proposal tied
// to no listed works. Every "can't" has its positive control.
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
const dam = (works?: string) => ({ op: 'node.set', nodeId: farmId, field: 'damCapacityM3', value: 120_000, ...(works ? { works } : {}) });
const WORKS = [{ ref: 'W1', text: 'Raise the Rooikloof dam wall by 2 m' }];

beforeAll(async () => {
	[owner, editor, viewer, applicant, consultant, otherApplicant, farmer, stranger] = (await Promise.all(
		['Wuowner', 'Wueditor', 'Wuviewer', 'Wuapplicant', 'Wuconsultant', 'Wuother', 'Wufarmer', 'Wustranger'].map((n) => signUp(n))
	)) as [User, User, User, User, User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'WULA references' })).body.project.id;
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

describe('an application’s WULA reference', () => {
	let sid: string;

	beforeAll(async () => {
		const res = await applicant.call('POST', `${P()}/scenarios`, { name: 'Raise Rooikloof', baseRunId: published, ops: [dam()] });
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		sid = res.body.scenario.id;
		expect((await applicant.call('POST', `${S(sid)}/members`, { userId: consultant.id })).status).toBe(201);
	});

	it('starts empty, and the check warns (never refuses) of no number and no works', async () => {
		const res = await applicant.call('GET', S(sid));
		expect(res.body.scenario.wula).toEqual({ number: null, works: [] });
		expect(res.body.check.problems).toEqual([]);
		expect(res.body.check.wulaWarnings).toEqual([
			'No WULA application number is given: add it under Application details, as the authority gave it.',
			'The WULA reference lists no works: list the works as applied for, then tie each proposal to the works it models.'
		]);
	});

	it('is written by its applicant (trimmed) and logged by field; the proposal tied to no works is named', async () => {
		const res = await applicant.call('PATCH', S(sid), { wulaNumber: '  WU/2026/0042 ', wulaWorks: [{ ref: ' W1 ', text: ' Raise the Rooikloof dam wall by 2 m\r\n' }] });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.scenario.wula).toEqual({ number: 'WU/2026/0042', works: WORKS });
		expect(res.body.check.wulaWarnings).toEqual([
			'op 1 (node.set): a proposal tied to none of the works the WULA applies for: name the works it models.',
			'Works “W1” is applied for, but no change models it.'
		]);
		const [e] = await asOwner(`SELECT subject FROM audit_event WHERE project_id = $1 AND kind = 'scenario.changed' AND subject->>'scenarioId' = $2 ORDER BY id DESC LIMIT 1`, [
			projectId,
			sid
		]);
		expect(e.subject.fields).toEqual(['wulaNumber', 'wulaWorks']);
	});

	it('takes the op’s works tag with the ops (hashed with them), which clears the warning', async () => {
		const before = (await applicant.call('GET', S(sid))).body.scenario.opsSha256;
		const res = await applicant.call('PATCH', S(sid), { ops: [dam('W1')] });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.scenario.ops[0].works).toBe('W1');
		expect(res.body.scenario.opsSha256).not.toBe(before);
		expect(res.body.check.wulaWarnings).toEqual([]);
		// A tag the list lacks is a warning too, not a refusal.
		const odd = await applicant.call('PATCH', S(sid), { ops: [dam('W9')] });
		expect(odd.status).toBe(200);
		expect(odd.body.check.problems).toEqual([]);
		expect(odd.body.check.wulaWarnings).toEqual(['op 1 (node.set): names works “W9”, which the WULA reference doesn\'t list.', 'Works “W1” is applied for, but no change models it.']);
		expect((await applicant.call('PATCH', S(sid), { ops: [dam('W1')] })).status).toBe(200);
	});

	it('refuses a bad list: a repeated ref, a blank text, too many works, an unknown key; and in the table (CHECK)', async () => {
		for (const wulaWorks of [
			[...WORKS, { ref: 'W1', text: 'again' }],
			[{ ref: 'W2', text: '  ' }],
			Array.from({ length: 51 }, (_, i) => ({ ref: `W${i}`, text: 'x' })),
			[{ ref: 'W2', text: 'x', extra: 1 }]
		])
			expect((await applicant.call('PATCH', S(sid), { wulaWorks })).status, JSON.stringify(wulaWorks)).toBe(400);
		expect((await applicant.call('PATCH', S(sid), { wulaNumber: 'x'.repeat(101) })).status).toBe(400);
		for (const bad of [`'{}'`, `'[{"ref":"W1"}]'`, `'[{"ref":" W1","text":"x"}]'`, `'[1]'`, `'[{"ref":"W1","text":"x"},{"ref":"W1","text":"y"}]'`])
			await expect(withUser(applicant.id, (db) => db.query(`UPDATE scenario SET wula_works = ${bad}::jsonb WHERE id = $1`, [sid])), bad).rejects.toMatchObject({ code: '23514' });
		await expect(withUser(applicant.id, (db) => db.query(`UPDATE scenario SET wula_number = ' WU' WHERE id = $1`, [sid]))).rejects.toMatchObject({ code: '23514' });
		// Positive control: 50 works and a 100-character number are kept.
		const ok = await applicant.call('PATCH', S(sid), { wulaNumber: 'x'.repeat(100), wulaWorks: Array.from({ length: 50 }, (_, i) => ({ ref: `W${i + 1}`, text: 'x' })) });
		expect(ok.status, JSON.stringify(ok.body)).toBe(200);
		expect((await applicant.call('PATCH', S(sid), { wulaNumber: 'WU/2026/0042', wulaWorks: WORKS })).status).toBe(200);
	});

	it('is read by the consultant it is shared with, who can’t change it; another applicant can’t see it, nor the assessors while a draft', async () => {
		expect((await consultant.call('GET', S(sid))).body.scenario.wula).toEqual({ number: 'WU/2026/0042', works: WORKS });
		expect((await consultant.call('PATCH', S(sid), { wulaNumber: 'x' })).status).toBe(403);
		expect((await otherApplicant.call('GET', S(sid))).status).toBe(404);
		expect((await otherApplicant.call('PATCH', S(sid), { wulaNumber: 'x' })).status).toBe(404);
		expect((await editor.call('GET', S(sid))).status).toBe(404);
		expect((await farmer.call('GET', S(sid))).status).toBe(403);
		expect((await stranger.call('GET', S(sid))).status).toBe(404);
		// The table agrees: RLS keeps a non-member's and another applicant's write from the row (0 rows); the applicant's reaches it.
		for (const u of [otherApplicant, stranger])
			expect((await withUser(u.id, (db) => db.query(`UPDATE scenario SET wula_number = 'x' WHERE id = $1`, [sid]))).rowCount, u.email).toBe(0);
		for (const u of [otherApplicant, stranger])
			expect((await withUser(u.id, (db) => db.query(`SELECT wula_number FROM scenario WHERE id = $1`, [sid]))).rowCount, u.email).toBe(0);
		expect((await withUser(applicant.id, (db) => db.query(`SELECT wula_number FROM scenario WHERE id = $1`, [sid]))).rows).toEqual([{ wula_number: 'WU/2026/0042' }]);
	});

	it('freezes on submission, for the applicant too (API 409, table 23514); the assessors read it; withdrawn and reopened, it is the applicant’s again', async () => {
		expect((await applicant.call('POST', `${S(sid)}/submit`)).status).toBe(200);
		expect((await editor.call('GET', S(sid))).body.scenario.wula).toEqual({ number: 'WU/2026/0042', works: WORKS });
		expect((await applicant.call('PATCH', S(sid), { wulaNumber: 'WU/2026/0043' })).status).toBe(409);
		expect((await applicant.call('PATCH', S(sid), { wulaWorks: [] })).status).toBe(409);
		await expect(withUser(applicant.id, (db) => db.query(`UPDATE scenario SET wula_number = 'WU/2026/0043' WHERE id = $1`, [sid]))).rejects.toMatchObject({ code: '23514' });
		await expect(withUser(applicant.id, (db) => db.query(`UPDATE scenario SET wula_works = '[]' WHERE id = $1`, [sid]))).rejects.toMatchObject({ code: '23514' });
		// An assessor can't change it either (scenario_guard: only the applicant changes their application).
		expect((await editor.call('PATCH', S(sid), { wulaNumber: 'x' })).status).toBe(403);
		// The statement isn't frozen (129): a submitted application still takes it (positive control for the PATCH path).
		expect((await applicant.call('PATCH', S(sid), { mitigation: 'A release pipe.' })).status).toBe(200);
		expect((await applicant.call('POST', `${S(sid)}/withdraw`)).status).toBe(200);
		expect((await applicant.call('PATCH', S(sid), { wulaNumber: 'x' })).status).toBe(409);
		expect((await applicant.call('POST', `${S(sid)}/reopen`)).status).toBe(200);
		const res = await applicant.call('PATCH', S(sid), { wulaNumber: null });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.scenario.wula.number).toBeNull();
	});
});

describe('a team scenario’s WULA reference', () => {
	let sid: string;

	beforeAll(async () => {
		const res = await editor.call('POST', `${P()}/scenarios`, { name: 'Raise Rooikloof (team)', baseRunId: published, ops: [dam()], ownedNodeIds: [farmId] });
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		sid = res.body.scenario.id;
	});

	it('warns of nothing while it records none (a what-if), and holds it to one once it does', async () => {
		expect((await editor.call('GET', S(sid))).body.check.wulaWarnings).toEqual([]);
		const res = await editor.call('PATCH', S(sid), { wulaNumber: 'WU/2026/0050' });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.check.wulaWarnings).toEqual(['The WULA reference lists no works: list the works as applied for, then tie each proposal to the works it models.']);
	});

	it('is written by an editor and read by a viewer (positive control), who can’t write it; a farmer and a stranger get nothing', async () => {
		expect((await viewer.call('GET', S(sid))).body.scenario.wula.number).toBe('WU/2026/0050');
		expect((await viewer.call('PATCH', S(sid), { wulaNumber: 'x' })).status).toBe(403);
		expect((await farmer.call('PATCH', S(sid), { wulaNumber: 'x' })).status).toBe(403);
		expect((await stranger.call('PATCH', S(sid), { wulaNumber: 'x' })).status).toBe(404);
		expect((await withUser(stranger.id, (db) => db.query(`SELECT wula_number FROM scenario WHERE id = $1`, [sid]))).rowCount).toBe(0);
	});

	it('freezes once submitted', async () => {
		expect((await editor.call('PATCH', S(sid), { status: 'submitted' })).status).toBe(200);
		expect((await editor.call('PATCH', S(sid), { wulaNumber: 'WU/2026/0051' })).status).toBe(409);
		await expect(withUser(editor.id, (db) => db.query(`UPDATE scenario SET wula_number = 'WU/2026/0051' WHERE id = $1`, [sid]))).rejects.toMatchObject({ code: '23514' });
	});
});
