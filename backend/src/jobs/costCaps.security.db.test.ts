// Server-side cost caps hold against a client that ignores the UI
// (docs/security.md § Background jobs, § Server-side reports): a burst of
// concurrent requests, a body past a list cap, or a direct write past the
// API, each against the cap's own positive control.
//
//   - The per-user queued-job caps (sweeps, outlooks, yield, assessments), the hourly
//     on-demand PDF cap and the per-project schedule cap are checked and
//     written one request at a time (an advisory lock per user or project),
//     so a burst can't pass the count together. The feed cap's burst test is
//     in feeds/feeds.db.test.ts.
//   - A report or schedule emails at most MAX_RECIPIENTS people.
//   - The database refuses a sweep member, assessment member or outlook level past the API's
//     cap, so a direct insert can't make a job run more engine runs.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { ALLOCATIONS_PER_PROJECT_MAX } from '../allocations/routes.js';
import { ASSESSMENT_JOBS_PER_USER, ASSESSMENT_SCENARIOS_MAX } from '../assessments/schema.js';
import { asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { OUTLOOK_JOBS_PER_USER, OUTLOOK_LEVELS_MAX } from '../outlooks/schema.js';
import { MAX_RECIPIENTS, MAX_SCHEDULES } from '../reports/routes.js';
import { REPORTS_PER_HOUR } from '../reports/store.js';
import { SWEEP_JOBS_PER_USER, SWEEP_MEMBERS_MAX } from '../sweeps/schema.js';
import { YIELD_JOBS_PER_USER } from '../yield/store.js';

type User = Awaited<ReturnType<typeof signUp>>;

/** Nothing here is meant to run: each project goes with its queued jobs, so no later file's tick picks them up. */
const cleanup: string[] = [];
afterEach(async () => {
	for (const pid of cleanup.splice(0)) await asOwner('DELETE FROM project WHERE id = $1', [pid]);
});

const START = '2000-10-01';
/** Two water years of invented rain, one saved run (the outlooks.db.test.ts shape, shorter). */
async function catchment(owner: User, name = 'Caps') {
	const projectId = (await owner.call('POST', '/projects', { name })).body.project.id as string;
	cleanup.push(projectId);
	const outlet = node('Outlet', null);
	const farm = node('Farm', outlet.id, { pctRunoffToDam: 1, damCapacityM3: 80_000, damInitialPct: 0.5, damMinPct: 0 });
	const crop = { id: randomUUID(), name: 'Lucerne', cropFactor: monthly(0.8) };
	const model = { nodes: [outlet, farm], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 150_000 }], transfers: [] };
	expect((await owner.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
	expect((await owner.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(150) } })).status).toBe(200);
	const rain = Array.from({ length: 730 }, (_, i) => (i % 3 === 0 ? 8 : 0));
	expect((await owner.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: START, values: rain })).status).toBe(200);
	const run = await owner.call('POST', `/projects/${projectId}/runs`, { label: 'base' });
	expect(run.status, JSON.stringify(run.body)).toBe(201);
	return { projectId, farm, runId: run.body.run.id as string };
}

async function member(owner: User, projectId: string, u: User, role: 'viewer' | 'editor' | 'owner') {
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: u.email, role })).status).toBe(201);
}

const scale = (factor: number) => [{ op: 'demand.scale', factor }];
const BURST = 8;

/** Fire `BURST` requests at once; `n` may pass (positive control), every other one is refused with `status`. */
async function burst(call: (i: number) => Promise<{ status: number; body: { error?: string } }>, n: number, ok: number, refused: number) {
	// Open a connection per request first, so the burst isn't staggered by connecting and really overlaps.
	await Promise.all(Array.from({ length: BURST }, () => withUser(randomUUID(), (db) => db.query('SELECT pg_sleep(0.05)'))));
	const res = await Promise.all(Array.from({ length: BURST }, (_, i) => call(i)));
	const statuses = res.map((r) => r.status);
	expect(statuses.filter((s) => s === ok), JSON.stringify(statuses)).toHaveLength(n);
	expect(statuses.filter((s) => s === refused), JSON.stringify(statuses)).toHaveLength(BURST - n);
	return res;
}

describe('per-user queued-job caps hold under a concurrent burst', () => {
	it(`at most ${SWEEP_JOBS_PER_USER} sweeps queued per user, however many arrive at once`, async () => {
		const owner = await signUp('CapSweep');
		const c = await catchment(owner);
		await burst((i) => owner.call('POST', `/projects/${c.projectId}/sweeps`, { name: `s${i}`, baseRunId: c.runId, members: [{ name: 'm', ops: scale(0.9) }] }), SWEEP_JOBS_PER_USER, 202, 429);
		expect((await asOwner(`SELECT count(*)::int AS n FROM job WHERE kind = 'sweep' AND acting_user_id = $1`, [owner.id]))[0].n).toBe(SWEEP_JOBS_PER_USER);
	});

	it(`at most ${ASSESSMENT_JOBS_PER_USER} assessments queued per user, however many arrive at once`, async () => {
		const owner = await signUp('CapAssessment');
		const c = await catchment(owner);
		const scenario = async (name: string, ops: unknown[]) => (await owner.call('POST', `/projects/${c.projectId}/scenarios`, { name, baseRunId: c.runId, ops })).body.scenario.id as string;
		const ids = [await scenario('Pump', [{ op: 'node.set', nodeId: c.farm.id, field: 'divertCapacityM3Day', value: 9000 }]), await scenario('Cut', scale(0.9))];
		await burst((i) => owner.call('POST', `/projects/${c.projectId}/assessments`, { name: `a${i}`, scenarioIds: ids }), ASSESSMENT_JOBS_PER_USER, 202, 429);
		expect((await asOwner(`SELECT count(*)::int AS n FROM job WHERE kind = 'assessment' AND acting_user_id = $1`, [owner.id]))[0].n).toBe(ASSESSMENT_JOBS_PER_USER);
	});

	it(`at most ${OUTLOOK_JOBS_PER_USER} outlooks queued per user, however many arrive at once`, async () => {
		const owner = await signUp('CapOutlook');
		const c = await catchment(owner);
		const body = (i: number) => ({ name: `o${i}`, baseRunId: c.runId, decisionDate: '2001-10-01', seasonEnd: '2002-04-30', levels: [{ label: 'L', ops: scale(1) }] });
		await burst((i) => owner.call('POST', `/projects/${c.projectId}/outlooks`, body(i)), OUTLOOK_JOBS_PER_USER, 202, 429);
		expect((await asOwner(`SELECT count(*)::int AS n FROM job WHERE kind = 'outlook' AND acting_user_id = $1`, [owner.id]))[0].n).toBe(OUTLOOK_JOBS_PER_USER);
	});

	it(`at most ${YIELD_JOBS_PER_USER} yield calculations queued per user, however many arrive at once`, async () => {
		const owner = await signUp('CapYield');
		const c = await catchment(owner);
		// Distinct requests (a different assurance each), so no two share a dedupe key.
		await burst(
			(i) => owner.call('POST', `/projects/${c.projectId}/yield`, { nodeId: c.farm.id, runId: c.runId, kind: 'firm', params: { assurance: 0.9 + i / 100 } }),
			YIELD_JOBS_PER_USER,
			202,
			429
		);
		expect((await asOwner(`SELECT count(*)::int AS n FROM job WHERE kind = 'yield' AND acting_user_id = $1`, [owner.id]))[0].n).toBe(YIELD_JOBS_PER_USER);
	});
});

describe('report caps hold under a concurrent burst', () => {
	it(`at most ${REPORTS_PER_HOUR} on-demand PDFs an hour per user and project`, async () => {
		const owner = await signUp('CapReports');
		const c = await catchment(owner);
		// Two slots left, then a burst.
		for (let i = 0; i < REPORTS_PER_HOUR - 2; i++) expect((await owner.call('POST', `/projects/${c.projectId}/reports`, {})).status).toBe(202);
		await burst(() => owner.call('POST', `/projects/${c.projectId}/reports`, {}), 2, 202, 429);
		expect((await asOwner('SELECT count(*)::int AS n FROM report WHERE project_id = $1', [c.projectId]))[0].n).toBe(REPORTS_PER_HOUR);
	});

	it(`at most ${MAX_SCHEDULES} report schedules per project`, async () => {
		const owner = await signUp('CapSchedules');
		const c = await catchment(owner);
		const weekly = (hour: number) => ({ frequency: 'weekly', weekday: 1, hour, timezone: 'UTC', recipients: [owner.id] });
		for (let i = 0; i < MAX_SCHEDULES - 2; i++) expect((await owner.call('POST', `/projects/${c.projectId}/report-schedules`, weekly(i))).status).toBe(201);
		const res = await burst((i) => owner.call('POST', `/projects/${c.projectId}/report-schedules`, weekly(10 + i)), 2, 201, 409);
		expect(res.filter((r) => r.status === 409).every((r) => r.body.error === `a project can have at most ${MAX_SCHEDULES} report schedules`)).toBe(true);
		expect((await asOwner('SELECT count(*)::int AS n FROM report_schedule WHERE project_id = $1', [c.projectId]))[0].n).toBe(MAX_SCHEDULES);
	});
});

describe('the allocations cap holds under a concurrent burst', () => {
	it(`at most ${ALLOCATIONS_PER_PROJECT_MAX} allocations per project, by hand or by import`, async () => {
		const owner = await signUp('CapAllocations');
		const c = await catchment(owner);
		// Two short of the cap, as one import (a header and one row per allocation).
		const rows = Array.from({ length: ALLOCATIONS_PER_PROJECT_MAX - 2 }, (_, i) => `CAP-${i},licence,groundwater,100`);
		const text = ['registration_no,authorisation,water_source,volume_m3_year', ...rows].join('\n');
		const imported = await owner.call('POST', `/projects/${c.projectId}/allocations/import/commit`, { kind: 'csv', fileName: 'cap.csv', text });
		expect(imported.status, JSON.stringify(imported.body)).toBe(201);
		const hand = (i: number) => ({ nodeId: null, registrationNo: `HAND-${i}`, authorisation: 'licence', waterSource: 'groundwater', volumeM3PerYear: 100 });
		const res = await burst((i) => owner.call('POST', `/projects/${c.projectId}/allocations`, hand(i)), 2, 201, 409);
		expect(res.filter((r) => r.status === 409).every((r) => r.body.error === `this project has reached the limit of ${ALLOCATIONS_PER_PROJECT_MAX} allocations`)).toBe(true);
		expect((await asOwner('SELECT count(*)::int AS n FROM allocation WHERE project_id = $1', [c.projectId]))[0].n).toBe(ALLOCATIONS_PER_PROJECT_MAX);
	});
});

describe(`a report or schedule emails at most ${MAX_RECIPIENTS} people`, () => {
	it(`refuses ${MAX_RECIPIENTS + 1} recipients on a PDF, a new schedule and a changed one, writing nothing (positive control: ${MAX_RECIPIENTS} pass)`, async () => {
		const owner = await signUp('CapRecipients');
		const c = await catchment(owner);
		// Real members: the count is the only thing wrong with the refused bodies.
		const others: string[] = [];
		for (let i = 0; i < MAX_RECIPIENTS; i++) {
			const u = await signUp(`CapRcpt${i}`);
			await member(owner, c.projectId, u, 'viewer');
			others.push(u.id);
		}
		const tooMany = [owner.id, ...others];
		const justRight = tooMany.slice(0, MAX_RECIPIENTS);
		const weekly = (recipients: string[]) => ({ frequency: 'weekly', weekday: 1, hour: 7, timezone: 'UTC', recipients });

		expect((await owner.call('POST', `/projects/${c.projectId}/reports`, { email: tooMany })).status).toBe(400);
		expect((await owner.call('POST', `/projects/${c.projectId}/report-schedules`, weekly(tooMany))).status).toBe(400);
		expect((await asOwner('SELECT count(*)::int AS n FROM report WHERE project_id = $1', [c.projectId]))[0].n).toBe(0);
		expect((await asOwner('SELECT count(*)::int AS n FROM report_schedule WHERE project_id = $1', [c.projectId]))[0].n).toBe(0);

		expect((await owner.call('POST', `/projects/${c.projectId}/reports`, { email: justRight })).status).toBe(202);
		const s = await owner.call('POST', `/projects/${c.projectId}/report-schedules`, weekly(justRight));
		expect(s.status).toBe(201);
		expect(s.body.schedule.recipients).toHaveLength(MAX_RECIPIENTS);
		expect((await owner.call('PATCH', `/projects/${c.projectId}/report-schedules/${s.body.schedule.id}`, { recipients: tooMany })).status).toBe(400);
		expect((await asOwner('SELECT count(*)::int AS n FROM report_schedule_recipient WHERE schedule_id = $1', [s.body.schedule.id]))[0].n).toBe(MAX_RECIPIENTS);
	});
});

describe('the database caps what a job will run, past the API', () => {
	it(`a sweep member at position ${SWEEP_MEMBERS_MAX} is refused; the last allowed position is accepted (positive control)`, async () => {
		const owner = await signUp('CapSweepRows');
		const c = await catchment(owner);
		const { sweep } = (await owner.call('POST', `/projects/${c.projectId}/sweeps`, { name: 's', baseRunId: c.runId, members: [{ name: 'm', ops: scale(0.9) }] })).body;
		const insert = (position: number) =>
			withUser(owner.id, (db) =>
				db.query(`INSERT INTO scenario_sweep_member (sweep_id, project_id, position, name, ops, ops_sha256) VALUES ($1, $2, $3, $4, '[]', $5)`, [
					sweep.id,
					c.projectId,
					position,
					`p${position}`,
					'a'.repeat(64)
				])
			);
		await expect(insert(SWEEP_MEMBERS_MAX)).rejects.toMatchObject({ code: '23514' });
		await expect(insert(SWEEP_MEMBERS_MAX - 1)).resolves.toMatchObject({ rowCount: 1 });
	});

	it(`an assessment member at position ${ASSESSMENT_SCENARIOS_MAX} is refused; the last allowed position is accepted (positive control)`, async () => {
		const owner = await signUp('CapAssessmentRows');
		const c = await catchment(owner);
		const scenario = async (name: string) => (await owner.call('POST', `/projects/${c.projectId}/scenarios`, { name, baseRunId: c.runId, ops: [] })).body.scenario.id as string;
		const ids = [await scenario('s0'), await scenario('s1'), await scenario('s2'), await scenario('s3')];
		const { assessment } = (await owner.call('POST', `/projects/${c.projectId}/assessments`, { name: 'a', scenarioIds: ids.slice(0, 2) })).body;
		const insert = (position: number, sid: string) =>
			withUser(owner.id, (db) =>
				db.query(`INSERT INTO assessment_member (assessment_id, project_id, scenario_id, position, name, origin, ops, ops_sha256) VALUES ($1, $2, $3, $4, 'x', 'team', '[]', $5)`, [
					assessment.id,
					c.projectId,
					sid,
					position,
					'a'.repeat(64)
				])
			);
		await expect(insert(ASSESSMENT_SCENARIOS_MAX, ids[2]!)).rejects.toMatchObject({ code: '23514' });
		await expect(insert(ASSESSMENT_SCENARIOS_MAX - 1, ids[3]!)).resolves.toMatchObject({ rowCount: 1 });
	});

	it(`an outlook with ${OUTLOOK_LEVELS_MAX + 1} demand levels is refused; ${OUTLOOK_LEVELS_MAX} are accepted (positive control)`, async () => {
		const owner = await signUp('CapOutlookRows');
		const c = await catchment(owner);
		const insert = (n: number) =>
			withUser(owner.id, (db) =>
				db.query(
					`INSERT INTO seasonal_outlook (project_id, base_run_id, name, decision_date, season_end, levels) VALUES ($1, $2, 'x', '2001-10-01', '2002-04-30', $3)`,
					[c.projectId, c.runId, JSON.stringify(Array.from({ length: n }, (_, i) => ({ label: `L${i}`, ops: scale(1) })))]
				)
			);
		await expect(insert(OUTLOOK_LEVELS_MAX + 1)).rejects.toMatchObject({ code: '23514' });
		await expect(insert(OUTLOOK_LEVELS_MAX)).resolves.toMatchObject({ rowCount: 1 });
	});
});
