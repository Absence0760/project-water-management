// A licence's granted terms and what followed its decision (231_licence_terms,
// 232_decision_events; issue #523 G3/G4; docs/scenarios.md § Applications).
// An issued licence counts in cumulative impact on its granted terms, never
// the ops applied for; an appeal lodged changes nothing until it is decided;
// set aside, it stops counting; varied, its new terms count. Only a member
// acting for the responsible authority records any of it, the decision never
// changes, and the events are read by whoever reads the scenario. Every
// "cannot see" has its positive control.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EvidenceReport } from '@water-management/engine';
import { actForAuthority, asOwner, DECISION, monthly, node, retirePendingJobs, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let assessor: User; // editor acting for the authority
let unmarked: User; // editor, not acting for it
let viewer: User;
let applicant: User; // contributor linked to Upper
let otherApplicant: User; // contributor, another party
let projectId: string;
let published: string;
let subjectRun: string; // the report's own (team) scenario run
let otherTeam: string; // a team scenario on another unit, to assess with

const outlet = node('Gauge', null);
const upper = node('Upper', outlet.id, { damCapacityM3: 100_000 });
const lower = node('Lower', outlet.id, { damCapacityM3: 50_000 });
const middle = node('Middle', outlet.id, { damCapacityM3: 80_000 });
const P = () => `/projects/${projectId}`;
const dam = (nodeId: string, value: number) => ({ op: 'node.set', nodeId, field: 'damCapacityM3', value });
const rowsAs = async <T = Record<string, unknown>>(u: User, sql: string, params: unknown[] = []) =>
	withUser(u.id, async (db) => (await db.query<T & Record<string, unknown>>(sql, params)).rows);
const refusedAs = (u: User, sql: string, params: unknown[] = []) => withUser(u.id, (db) => db.query(sql, params)).then(() => 'stored', (e: { code?: string }) => e.code);

const report = async (u: User) => {
	const res = await u.call('GET', `${P()}/runs/${subjectRun}/evidence-report`);
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return res.body.report as EvidenceReport;
};
/** The other applications § 4 reads, by name, with the run each was read from. */
const listed = async (u: User) => (await report(u)).cumulative.applications.map((a) => [a.scenarioName, a.runId]);
const combinedNames = async (u: User) => ((await report(u)).cumulative.combined?.applications ?? []).map((a) => a.scenarioName);

async function apply(name: string, ops: unknown[]) {
	const res = await applicant.call('POST', `${P()}/scenarios`, { name, baseRunId: published, ops });
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	const sid = res.body.scenario.id as string;
	expect((await applicant.call('POST', `${P()}/scenarios/${sid}/submit`, {})).status).toBe(200);
	return sid;
}
async function run(u: User, sid: string, terms?: 'licensed') {
	const res = await u.call('POST', `${P()}/scenarios/${sid}/runs`, terms ? { terms } : {});
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.run.id as string;
}
const scenarioAs = async (u: User, sid: string) => (await u.call('GET', `${P()}/scenarios/${sid}`)).body.scenario;
/** The ops' hash an assessment of these scenarios copies for `sid` (assessment_member_guard). */
async function assessedSha(sid: string, withSid: string) {
	const res = await assessor.call('POST', `${P()}/assessments`, { name: `Assess ${crypto.randomUUID()}`, scenarioIds: [sid, withSid] });
	expect(res.status, JSON.stringify(res.body)).toBe(202);
	// Its job is never run here: retired, so the per-user cap on queued assessments doesn't fill.
	await retirePendingJobs(projectId);
	return (res.body.assessment.members as { scenarioId: string; opsSha256: string }[]).find((m) => m.scenarioId === sid)!.opsSha256;
}

beforeAll(async () => {
	[owner, assessor, unmarked, viewer, applicant, otherApplicant] = (await Promise.all(
		['Lowner', 'Lassessor', 'Lunmarked', 'Lviewer', 'Lapplicant', 'Lother'].map((n) => signUp(n))
	)) as [User, User, User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Licences' })).body.project.id;
	expect((await owner.call('PUT', `${P()}/model`, { nodes: [outlet, upper, lower, middle], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
	expect((await owner.call('PATCH', P(), { settings: { apanMm: monthly(150) } })).status).toBe(200);
	const days = 60;
	const rain = Array.from({ length: days }, (_, i) => (i % 7 === 0 ? 20 : 0));
	expect((await owner.call('PUT', `${P()}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: rain })).status).toBe(200);
	expect((await owner.call('PUT', `${P()}/series`, { kind: 'flow_observed_m3s', unit: 'm3/s', startDate: '2020-01-01', values: new Array(days).fill(0.2) })).status).toBe(200);
	const base = await owner.call('POST', `${P()}/runs`, { label: 'Baseline' });
	expect(base.status, JSON.stringify(base.body)).toBe(201);
	published = base.body.run.id;
	expect((await owner.call('POST', `${P()}/publication`, { runId: published })).status).toBe(201);
	for (const [u, role] of [
		[assessor, 'editor'],
		[unmarked, 'editor'],
		[viewer, 'viewer'],
		[applicant, 'contributor'],
		[otherApplicant, 'contributor']
	] as const)
		expect((await owner.call('POST', `${P()}/members`, { email: u.email, role })).status, u.email).toBe(201);
	await actForAuthority(owner, projectId, assessor.id);
	expect((await owner.call('PUT', `${P()}/farmers/${applicant.id}`, { nodeIds: [upper.id] })).status).toBe(200);
	// The report's own scenario (a team one on Middle), and another on Lower to assess with; neither conflicts with Upper.
	const subject = await owner.call('POST', `${P()}/scenarios`, { name: 'Subject', baseRunId: published, ops: [dam(middle.id, 90_000)], ownedNodeIds: [middle.id] });
	expect(subject.status, JSON.stringify(subject.body)).toBe(201);
	subjectRun = await run(owner, subject.body.scenario.id);
	const other = await owner.call('POST', `${P()}/scenarios`, { name: 'Lower weir', baseRunId: published, ops: [dam(lower.id, 60_000)], ownedNodeIds: [lower.id] });
	expect(other.status, JSON.stringify(other.body)).toBe(201);
	otherTeam = other.body.scenario.id;
}, 300_000);

afterAll(async () => {
	await retirePendingJobs(projectId);
});

describe('granted terms (231)', () => {
	it('writes the applied ops out as the granted terms when a licence is issued as applied for, with its conditions', async () => {
		const sid = await apply('As applied', [dam(upper.id, 120_000)]);
		const res = await assessor.call('POST', `${P()}/scenarios/${sid}/decide`, { ...DECISION, outcome: 'licence_issued', granted: { conditions: 'Release 5 % of inflow in dry months.' } });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		const s = res.body.scenario;
		expect(s.grantedTerms).toMatchObject({ ops: s.ops, opsSha256: s.opsSha256, asApplied: true, conditions: 'Release 5 % of inflow in dry months.' });
		expect(s.licence).toEqual({ inForce: true, from: 'decision', eventId: null, appealPending: false });
		// Recorded, not implied: the row holds the ops.
		const [row] = await rowsAs<{ granted_ops: unknown; granted_ops_sha256: string; ops_sha256: string }>(assessor, 'SELECT granted_ops, granted_ops_sha256, ops_sha256 FROM scenario WHERE id = $1', [sid]);
		expect(row!.granted_ops).toEqual(s.ops);
		expect(row!.granted_ops_sha256).toBe(row!.ops_sha256);
	});

	it('refuses terms with any other outcome and terms that don’t apply; the applicant reads them without a hidden farm’s name', async () => {
		const sid = await apply('Checked', [dam(upper.id, 130_000)]);
		const at = `${P()}/scenarios/${sid}/decide`;
		expect((await assessor.call('POST', at, { ...DECISION, outcome: 'licence_refused', granted: { conditions: 'x' } })).status).toBe(400);
		const unknown = await assessor.call('POST', at, { ...DECISION, outcome: 'licence_issued', granted: { ops: [dam(crypto.randomUUID(), 1)] } });
		expect(unknown.status, JSON.stringify(unknown.body)).toBe(422);
		expect(unknown.body.details.problems.length).toBeGreaterThan(0);
		// Terms on the applicant's unit and a condition on a neighbour's (a baseline assumption, as the applicant's own op on it would be).
		const ok = await assessor.call('POST', at, { ...DECISION, outcome: 'licence_issued', granted: { ops: [dam(upper.id, 110_000), dam(lower.id, 40_000)] } });
		expect(ok.status, JSON.stringify(ok.body)).toBe(200);
		// The application stays as it was applied for.
		expect(ok.body.scenario.ops).toEqual([dam(upper.id, 130_000)]);
		expect(ok.body.scenario.grantedTerms).toMatchObject({ ops: [dam(upper.id, 110_000), dam(lower.id, 40_000)], asApplied: false, conditions: '' });
		// The applicant reads them on their own application, naming only their own unit (Lower is an anonymous farm to them).
		const theirs = (await scenarioAs(applicant, sid)).grantedTerms;
		expect(theirs.ops).toEqual([dam(upper.id, 110_000), dam(lower.id, 40_000)]);
		expect(theirs.opNames).toEqual([{ id: upper.id, name: 'Upper' }]);
		expect(JSON.stringify(theirs)).not.toContain('Lower');
	});

	it('never changes once recorded, and needs a member acting for the authority', async () => {
		const sid = await apply('Final terms', [dam(upper.id, 140_000)]);
		expect((await unmarked.call('POST', `${P()}/scenarios/${sid}/decide`, { ...DECISION, outcome: 'licence_issued' })).status).toBe(403);
		expect((await assessor.call('POST', `${P()}/scenarios/${sid}/decide`, { ...DECISION, outcome: 'licence_issued', granted: { ops: [dam(upper.id, 100_000)] } })).status).toBe(200);
		// Even past RLS (as the schema owner), the guard keeps the decision's terms.
		for (const sql of [
			"UPDATE scenario SET granted_conditions = 'changed' WHERE id = $1",
			'UPDATE scenario SET granted_ops = ops, granted_ops_sha256 = ops_sha256 WHERE id = $1',
			"UPDATE scenario SET granted_op_names = '[]' WHERE id = $1"
		])
			// As the applicant's (only they change their application, 42501) or the decision's (set once, 23514): either way refused.
			expect(['23514', '42501'], sql).toContain(await asOwner(sql, [sid]).then(() => 'stored', (e: { code?: string }) => e.code));
		// A team scenario has no applicant: the "set once" rule itself answers.
		const team = await owner.call('POST', `${P()}/scenarios`, { name: 'Team licence', baseRunId: published, ops: [dam(lower.id, 55_000)] });
		const tid = team.body.scenario.id as string;
		expect((await owner.call('POST', `${P()}/scenarios/${tid}/submit`, {})).status).toBe(200);
		expect((await assessor.call('POST', `${P()}/scenarios/${tid}/decide`, { ...DECISION, outcome: 'licence_issued' })).status).toBe(200);
		expect(await asOwner("UPDATE scenario SET granted_conditions = 'changed' WHERE id = $1", [tid]).then(() => 'stored', (e: { code?: string }) => e.code)).toBe('23514');
		const [row] = (await asOwner('SELECT granted_ops FROM scenario WHERE id = $1', [sid])) as { granted_ops: unknown }[];
		expect(row!.granted_ops).toEqual([dam(upper.id, 100_000)]);
	});

	it('counts an issued licence in cumulative impact on its granted terms, never the ops applied for', async () => {
		const sid = await apply('Upper dam', [dam(upper.id, 200_000)]);
		const appliedRun = await run(applicant, sid);
		// Submitted: it counts on its own ops (§ 4 reads its run of them; an assessment copies them).
		expect(await listed(owner)).toContainEqual(['Upper dam', appliedRun]);
		const before = await scenarioAs(assessor, sid);
		expect(await assessedSha(sid, otherTeam)).toBe(before.opsSha256);

		const decided = await assessor.call('POST', `${P()}/scenarios/${sid}/decide`, { ...DECISION, outcome: 'licence_issued', granted: { ops: [dam(upper.id, 150_000)], conditions: 'No more than 150 000 m³.' } });
		expect(decided.status, JSON.stringify(decided.body)).toBe(200);
		const granted = decided.body.scenario.grantedTerms.opsSha256 as string;
		expect(granted).not.toBe(before.opsSha256);
		// Issued: the run of the applied ops no longer stands for it, and an assessment copies the granted terms.
		expect((await listed(owner)).map(([n]) => n)).not.toContain('Upper dam');
		expect(await assessedSha(sid, otherTeam)).toBe(granted);
		// Page 1's combined row still names it (it needs no run of its own).
		expect(await combinedNames(owner)).toContain('Upper dam');
		// A run of the licensed terms is what § 4 reads, labelled so.
		const licensedRun = await run(assessor, sid, 'licensed');
		const [meta] = await rowsAs<{ label: string; recorded: unknown }>(owner, `SELECT label, inputs->'scenario' AS recorded FROM model_run WHERE id = $1`, [licensedRun]);
		expect(meta!.label).toBe('Upper dam (as licensed)');
		expect(meta!.recorded).toMatchObject({ opsSha256: granted, ops: [dam(upper.id, 150_000)] });
		expect(await listed(owner)).toContainEqual(['Upper dam', licensedRun]);
	});

	it('has no licensed terms to run while nothing is issued', async () => {
		const sid = await apply('Pending', [dam(upper.id, 125_000)]);
		const res = await assessor.call('POST', `${P()}/scenarios/${sid}/runs`, { terms: 'licensed' });
		expect(res.status).toBe(409);
		expect(res.body.error).toMatch(/no licence in force/);
	});
});

describe('appeal events (232)', () => {
	let sid: string;
	let grantedSha: string;
	const appeal = (u: User, body: Record<string, unknown>) => u.call('POST', `${P()}/scenarios/${sid}/appeals`, body);
	const lodged = { kind: 'lodged', forum: 'water_tribunal', eventDate: '2026-10-02', reference: 'WT 12/2026' };

	beforeAll(async () => {
		sid = await apply('Appealed dam', [dam(upper.id, 210_000)]);
		const res = await assessor.call('POST', `${P()}/scenarios/${sid}/decide`, { ...DECISION, outcome: 'licence_issued', granted: { ops: [dam(upper.id, 160_000)] } });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		grantedSha = res.body.scenario.grantedTerms.opsSha256;
		await run(assessor, sid, 'licensed');
	}, 120_000);

	it('follows only a recorded decision, and only from a member acting for the authority', async () => {
		const pending = await apply('Not decided', [dam(upper.id, 115_000)]);
		expect((await assessor.call('POST', `${P()}/scenarios/${pending}/appeals`, lodged)).status).toBe(409);
		expect((await unmarked.call('POST', `${P()}/scenarios/${sid}/appeals`, lodged)).status).toBe(403);
		expect((await applicant.call('POST', `${P()}/scenarios/${sid}/appeals`, lodged)).status).toBe(403);
		expect((await viewer.call('POST', `${P()}/scenarios/${sid}/appeals`, lodged)).status).toBe(403);
		// Past the route: the table's own policy and guard refuse an editor who doesn't act for the authority.
		expect(
			await refusedAs(unmarked, `INSERT INTO decision_event (project_id, scenario_id, position, kind, forum, event_date) VALUES ($1, $2, 1, 'lodged', 'court', '2026-10-02')`, [projectId, sid])
		).toBe('42501');
		expect((await rowsAs(assessor, 'SELECT 1 FROM decision_event WHERE scenario_id = $1', [sid])).length).toBe(0);
	});

	it('keeps the order: a resolution answers an open appeal in its forum, never one lodged twice, never dated before the decision', async () => {
		expect((await appeal(assessor, { ...lodged, kind: 'upheld' })).status).toBe(409);
		expect((await appeal(assessor, { ...lodged, eventDate: '2026-09-01' })).status).toBe(400);
		expect((await appeal(assessor, { ...lodged, kind: 'varied' })).status).toBe(400);
		const res = await appeal(assessor, lodged);
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		expect(res.body.scenario.decisionEvents).toMatchObject([{ position: 1, kind: 'lodged', forum: 'water_tribunal', eventDate: '2026-10-02', reference: 'WT 12/2026', terms: null }]);
		expect((await appeal(assessor, lodged)).status).toBe(409);
		expect((await appeal(assessor, { ...lodged, kind: 'set_aside', forum: 'court' })).status).toBe(409);
	});

	it('changes nothing while an appeal is lodged: the licence still counts on its granted terms', async () => {
		const s = await scenarioAs(assessor, sid);
		expect(s.licence).toEqual({ inForce: true, from: 'decision', eventId: null, appealPending: true });
		expect((await listed(owner)).map(([n]) => n)).toContain('Appealed dam');
		expect(await assessedSha(sid, otherTeam)).toBe(grantedSha);
	});

	it('stops counting once set aside, and the decision itself stays as recorded', async () => {
		const res = await appeal(assessor, { kind: 'set_aside', forum: 'water_tribunal', eventDate: '2026-10-05', note: 'Remitted to the authority.' });
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		const s = res.body.scenario;
		expect(s.licence).toMatchObject({ inForce: false, from: 'event', appealPending: false });
		expect(s.outcome).toBe('licence_issued');
		expect(s.grantedTerms.opsSha256).toBe(grantedSha);
		expect((await listed(owner)).map(([n]) => n)).not.toContain('Appealed dam');
		expect(await combinedNames(owner)).not.toContain('Appealed dam');
		// An assessment that names it anyway takes the ops applied for, as it would a refused application.
		expect(await assessedSha(sid, otherTeam)).toBe(s.opsSha256);
		expect((await assessor.call('POST', `${P()}/scenarios/${sid}/runs`, { terms: 'licensed' })).status).toBe(409);
	});

	it('counts the new terms once varied (here a court reinstating it on a smaller dam), on a run of those terms', async () => {
		expect((await appeal(assessor, { kind: 'lodged', forum: 'court', eventDate: '2026-10-06' })).status).toBe(201);
		const res = await appeal(assessor, { kind: 'varied', forum: 'court', eventDate: '2026-10-08', terms: { ops: [dam(upper.id, 140_000)], conditions: 'As the court ordered.' } });
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		const s = res.body.scenario;
		const varied = s.decisionEvents.at(-1);
		expect(varied).toMatchObject({ position: 4, kind: 'varied', terms: { ops: [dam(upper.id, 140_000)], conditions: 'As the court ordered.', asApplied: false } });
		expect(s.licence).toEqual({ inForce: true, from: 'event', eventId: varied.id, appealPending: false });
		expect(await assessedSha(sid, otherTeam)).toBe(varied.terms.opsSha256);
		// The run of the decision's terms no longer stands for it; a run of the varied terms does.
		expect((await listed(owner)).map(([n]) => n)).not.toContain('Appealed dam');
		const variedRun = await run(assessor, sid, 'licensed');
		expect(await listed(owner)).toContainEqual(['Appealed dam', variedRun]);
		expect(await combinedNames(owner)).toContain('Appealed dam');
	});

	it('is read by whoever reads the scenario: its applicant and a viewer, never another applicant', async () => {
		const mine = await scenarioAs(applicant, sid);
		expect(mine.decisionEvents.map((e: { kind: string }) => e.kind)).toEqual(['lodged', 'set_aside', 'lodged', 'varied']);
		expect((await rowsAs(applicant, 'SELECT kind FROM decision_event WHERE scenario_id = $1', [sid])).length).toBe(4);
		expect((await scenarioAs(viewer, sid)).decisionEvents).toHaveLength(4);
		expect((await otherApplicant.call('GET', `${P()}/scenarios/${sid}`)).status).toBe(404);
		expect((await rowsAs(otherApplicant, 'SELECT kind FROM decision_event WHERE scenario_id = $1', [sid])).length).toBe(0);
	});

	it('is append-only: nobody changes or removes an event, and the history records each', async () => {
		expect(await refusedAs(assessor, "UPDATE decision_event SET note = 'rewritten' WHERE scenario_id = $1", [sid])).toBe('42501');
		expect(await refusedAs(assessor, 'DELETE FROM decision_event WHERE scenario_id = $1', [sid])).toBe('42501');
		const history = await owner.call('GET', `${P()}/history`);
		expect(history.status).toBe(200);
		const kinds = JSON.stringify(history.body);
		expect(kinds).toContain('scenario.appeal_recorded');
	});
});
