// The licensed terms' background run (293_scenario_run_job; docs/followups.md
// "The licensed-terms run isn't made for the assessor"; docs/scenarios.md
// § Applications). A licence issued on other terms than those applied for, or
// varied on appeal, queues a `scenario_run` job that stores the run of those
// terms as the member who recorded the decision, so the evidence report's § 4
// counts it without anyone pressing **Run the licensed terms**. Terms as
// applied for queue nothing (the applicant's runs serve); a job that finds the
// run already made makes no second one; a full per-user cap queues nothing
// but still records the decision.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { EvidenceReport } from '@water-management/engine';
import { actForAuthority, asOwner, DECISION, monthly, node, retirePendingJobs, signUp } from '../__tests__/helpers.js';
import { randomUUID } from 'node:crypto';
import { withUser } from '../db/tx.js';
import { enqueueJob } from '../jobs/queue.js';
import { runTick } from '../jobs/runner.js';
import { SCENARIO_RUN_JOBS_PER_USER, scenarioRunDedupeKey } from './licensedRun.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let assessor: User; // editor acting for the authority
let applicant: User; // contributor linked to Upper
let projectId: string;
let published: string;
let subjectRun: string;

const outlet = node('Gauge', null);
const upper = node('Upper', outlet.id, { damCapacityM3: 100_000 });
const middle = node('Middle', outlet.id, { damCapacityM3: 80_000 });
const P = () => `/projects/${projectId}`;
const dam = (nodeId: string, value: number) => ({ op: 'node.set', nodeId, field: 'damCapacityM3', value });
const tick = () => runTick({ feeds: false, reports: false, alerts: false, projectIds: [projectId] });

interface JobRow {
	id: string;
	status: string;
	acting_user_id: string;
	payload: { scenarioId: string };
	last_error: string | null;
}
const jobsOf = (sid: string) =>
	asOwner(`SELECT id, status, acting_user_id, payload, last_error FROM job WHERE kind = 'scenario_run' AND project_id = $1 AND dedupe_key = $2 ORDER BY created_at`, [
		projectId,
		scenarioRunDedupeKey(sid)
	]) as Promise<JobRow[]>;
/** The scenario's stored runs, oldest first, with the terms each recorded. */
const runsOf = (sid: string) =>
	asOwner(`SELECT id, label, created_by, inputs->'scenario'->>'opsSha256' AS sha FROM model_run WHERE scenario_id = $1 ORDER BY created_at`, [sid]) as Promise<
		{ id: string; label: string; created_by: string; sha: string }[]
	>;
const cumulative = async () => {
	const res = await owner.call('GET', `${P()}/runs/${subjectRun}/evidence-report`);
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return (res.body.report as EvidenceReport).cumulative;
};

async function apply(name: string, ops: unknown[]) {
	const res = await applicant.call('POST', `${P()}/scenarios`, { name, baseRunId: published, ops });
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	const sid = res.body.scenario.id as string;
	expect((await applicant.call('POST', `${P()}/scenarios/${sid}/submit`, {})).status).toBe(200);
	return sid;
}
async function decide(sid: string, body: Record<string, unknown>) {
	const res = await assessor.call('POST', `${P()}/scenarios/${sid}/decide`, { ...DECISION, ...body });
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return res.body.scenario;
}

beforeAll(async () => {
	[owner, assessor, applicant] = (await Promise.all(['SRowner', 'SRassessor', 'SRapplicant'].map((n) => signUp(n)))) as [User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Licensed runs' })).body.project.id;
	expect((await owner.call('PUT', `${P()}/model`, { nodes: [outlet, upper, middle], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
	expect((await owner.call('PATCH', P(), { settings: { apanMm: monthly(150) } })).status).toBe(200);
	const days = 60;
	const rain = Array.from({ length: days }, (_, i) => (i % 7 === 0 ? 20 : 0));
	expect((await owner.call('PUT', `${P()}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: rain })).status).toBe(200);
	const base = await owner.call('POST', `${P()}/runs`, { label: 'Baseline' });
	expect(base.status, JSON.stringify(base.body)).toBe(201);
	published = base.body.run.id;
	expect((await owner.call('POST', `${P()}/publication`, { runId: published })).status).toBe(201);
	expect((await owner.call('POST', `${P()}/members`, { email: assessor.email, role: 'editor' })).status).toBe(201);
	expect((await owner.call('POST', `${P()}/members`, { email: applicant.email, role: 'contributor' })).status).toBe(201);
	await actForAuthority(owner, projectId, assessor.id);
	expect((await owner.call('PUT', `${P()}/farmers/${applicant.id}`, { nodeIds: [upper.id] })).status).toBe(200);
	// The report's own scenario, a team one on Middle.
	const subject = await owner.call('POST', `${P()}/scenarios`, { name: 'Subject', baseRunId: published, ops: [dam(middle.id, 90_000)], ownedNodeIds: [middle.id] });
	expect(subject.status, JSON.stringify(subject.body)).toBe(201);
	const ran = await owner.call('POST', `${P()}/scenarios/${subject.body.scenario.id}/runs`, {});
	expect(ran.status, JSON.stringify(ran.body)).toBe(201);
	subjectRun = ran.body.run.id;
}, 300_000);

// Each test runs or retires its own jobs; nothing pending outlives one.
afterEach(async () => {
	await retirePendingJobs(projectId);
});
afterAll(async () => {
	await retirePendingJobs(projectId);
});

describe('a licence issued on other terms queues the run of them (293)', () => {
	it('queues it as the deciding member, and the job stores the run § 4 reads, as the button would', async () => {
		const sid = await apply('Changed terms', [dam(upper.id, 200_000)]);
		const decided = await decide(sid, { outcome: 'licence_issued', granted: { ops: [dam(upper.id, 150_000)] } });
		const granted = decided.grantedTerms.opsSha256 as string;
		// Queued with the decision, by the member who recorded it, and shown where the button is.
		const [job] = await jobsOf(sid);
		expect(job).toMatchObject({ status: 'queued', acting_user_id: assessor.id, payload: { scenarioId: sid } });
		expect(decided.licensedRunJob).toMatchObject({ id: job!.id, kind: 'scenario_run', status: 'queued', createdBy: 'SRassessor' });
		// Until it runs, § 4 names the licence as not run (evidence-20).
		expect((await cumulative()).notRun?.map((a) => a.scenarioName)).toContain('Changed terms');

		await tick();
		expect((await jobsOf(sid))[0]).toMatchObject({ status: 'done', last_error: null });
		const runs = await runsOf(sid);
		expect(runs).toHaveLength(1);
		expect(runs[0]).toMatchObject({ label: 'Changed terms (as licensed)', created_by: assessor.id, sha: granted });
		// § 4 reads it, on its licensed terms, and no longer names it as missing.
		const c = await cumulative();
		expect(c.applications.find((a) => a.scenarioName === 'Changed terms')).toMatchObject({ runId: runs[0]!.id, status: 'decided', terms: 'licensed' });
		expect((c.notRun ?? []).map((a) => a.scenarioName)).not.toContain('Changed terms');
		// The panel reads the job as done.
		expect((await assessor.call('GET', `${P()}/scenarios/${sid}`)).body.scenario.licensedRunJob).toMatchObject({ status: 'done' });
		// An applicant reads no job of the project (016/096 RLS): null, never another's job (positive control: the assessor above).
		expect((await applicant.call('GET', `${P()}/scenarios/${sid}`)).body.scenario.licensedRunJob).toBeNull();
	});

	it('queues nothing for terms as applied for, a refusal, or terms given again as the ops applied for', async () => {
		const asApplied = await apply('As applied', [dam(upper.id, 120_000)]);
		expect((await decide(asApplied, { outcome: 'licence_issued' })).licensedRunJob).toBeNull();
		const sameOps = await apply('Same ops', [dam(upper.id, 125_000)]);
		expect((await decide(sameOps, { outcome: 'licence_issued', granted: { ops: [dam(upper.id, 125_000)] } })).grantedTerms.asApplied).toBe(true);
		const refused = await apply('Refused', [dam(upper.id, 130_000)]);
		await decide(refused, { outcome: 'licence_refused' });
		for (const sid of [asApplied, sameOps, refused]) expect(await jobsOf(sid), sid).toEqual([]);
	});

	it('makes no second run when the button already ran the terms', async () => {
		const sid = await apply('Pressed first', [dam(upper.id, 210_000)]);
		await decide(sid, { outcome: 'licence_issued', granted: { ops: [dam(upper.id, 170_000)] } });
		const pressed = await assessor.call('POST', `${P()}/scenarios/${sid}/runs`, { terms: 'licensed' });
		expect(pressed.status, JSON.stringify(pressed.body)).toBe(201);
		await tick();
		expect((await jobsOf(sid))[0]!.status).toBe('done');
		expect((await runsOf(sid)).map((r) => r.id)).toEqual([pressed.body.run.id]);
	});

	it('queues the varied terms on appeal, and the job runs the terms in force when it runs', async () => {
		const sid = await apply('Varied', [dam(upper.id, 220_000)]);
		await decide(sid, { outcome: 'licence_issued', granted: { ops: [dam(upper.id, 180_000)] } });
		await tick();
		expect(await runsOf(sid)).toHaveLength(1);
		const appeal = (body: Record<string, unknown>) => assessor.call('POST', `${P()}/scenarios/${sid}/appeals`, body);
		// Lodged: nothing changes, and the decision's terms have their run: nothing queued.
		const lodged = await appeal({ kind: 'lodged', forum: 'water_tribunal', eventDate: '2026-10-02' });
		expect(lodged.status, JSON.stringify(lodged.body)).toBe(201);
		expect((await jobsOf(sid)).map((j) => j.status)).toEqual(['done']);
		const varied = await appeal({ kind: 'varied', forum: 'water_tribunal', eventDate: '2026-10-05', terms: { ops: [dam(upper.id, 140_000)] } });
		expect(varied.status, JSON.stringify(varied.body)).toBe(201);
		const variedSha = varied.body.scenario.decisionEvents.at(-1).terms.opsSha256 as string;
		expect(varied.body.scenario.licensedRunJob).toMatchObject({ status: 'queued' });
		expect((await jobsOf(sid)).map((j) => [j.status, j.acting_user_id])).toEqual([
			['done', assessor.id],
			['queued', assessor.id]
		]);
		await tick();
		const runs = await runsOf(sid);
		expect(runs.map((r) => r.sha)).toEqual([runs[0]!.sha, variedSha]);
		expect((await cumulative()).applications.find((a) => a.scenarioName === 'Varied')).toMatchObject({ runId: runs[1]!.id, terms: 'licensed' });
	});

	it('does nothing once the licence is set aside before it runs', async () => {
		const sid = await apply('Set aside', [dam(upper.id, 230_000)]);
		await decide(sid, { outcome: 'licence_issued', granted: { ops: [dam(upper.id, 190_000)] } });
		expect((await assessor.call('POST', `${P()}/scenarios/${sid}/appeals`, { kind: 'lodged', forum: 'court', eventDate: '2026-10-02' })).status).toBe(201);
		expect((await assessor.call('POST', `${P()}/scenarios/${sid}/appeals`, { kind: 'set_aside', forum: 'court', eventDate: '2026-10-04' })).status).toBe(201);
		await tick();
		expect((await jobsOf(sid)).map((j) => j.status)).toEqual(['done']);
		expect(await runsOf(sid)).toEqual([]);
	});

	it(`queues at most ${SCENARIO_RUN_JOBS_PER_USER} per user; past the cap the decision is still recorded and the button still runs it`, async () => {
		// Fill the assessor's cap with pending jobs of other (invented) scenarios, past the API.
		for (let i = 0; i < SCENARIO_RUN_JOBS_PER_USER; i++) {
			const other = randomUUID();
			await withUser(assessor.id, (db) => enqueueJob(db, { projectId, kind: 'scenario_run', payload: { scenarioId: other }, dedupeKey: scenarioRunDedupeKey(other) }));
		}
		const sid = await apply('Past the cap', [dam(upper.id, 240_000)]);
		const decided = await decide(sid, { outcome: 'licence_issued', granted: { ops: [dam(upper.id, 200_000)] } });
		expect(decided.status).toBe('decided');
		expect(decided.licensedRunJob).toBeNull();
		expect(await jobsOf(sid)).toEqual([]);
		// Positive control: one slot free, and the next decision queues its run.
		await retirePendingJobs(projectId);
		const next = await apply('Under the cap', [dam(upper.id, 250_000)]);
		expect((await decide(next, { outcome: 'licence_issued', granted: { ops: [dam(upper.id, 210_000)] } })).licensedRunJob).toMatchObject({ status: 'queued' });
		// The button still runs the first.
		expect((await assessor.call('POST', `${P()}/scenarios/${sid}/runs`, { terms: 'licensed' })).status).toBe(201);
	});
});
