// The evidence report's combined row (evidence-11, finding C26, WP-3.11):
// page 1's "This and the other applications on this baseline, together"
// reads a completed cumulative assessment of exactly this application and
// every other submitted or approved one on the baseline, with their current
// ops; without one it says why (not assessed yet, under way); a conflict
// makes it not assessed with the conflict named, never a silent merge. Only
// an assessment on the baseline run's engine is read (operator decision,
// 2026-10-01), so the row's baseline figure is the report's own. From
// evidence-25 § 4 also carries each dam the applications touch: its firm
// yield and assurance of supply from the assessment's dam rows.
// Synthetic catchment: invented names and values.
import { randomUUID } from 'node:crypto';
import { COMBINED_CONFLICT, COMBINED_NOT_RUN, COMBINED_PENDING, type CumulativeReport, ENGINE_VERSION, type EvidenceReport } from '@water-management/engine';
import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { monthly, node, signUp } from '../__tests__/helpers.js';
import { runTick } from '../jobs/runner.js';
import { withUser } from '../db/tx.js';
import { buildEvidenceReport, staleAssessment } from './report.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let assessor: User;
let applicantA: User;
let applicantB: User;
let projectId: string;
let published: string;
let appA: string;
let appB: string;
let runA: string;

const outlet = node('Outlet', null);
const rooikloof = node('Rooikloof', outlet.id, { damCapacityM3: 100_000, pctRunoffToDam: 1 });
const kalkoenkrans = node('Kalkoenkrans', outlet.id);
const bergvliet = node('Bergvliet', outlet.id);
const lucerne = { id: randomUUID(), name: 'Lucerne', cropFactor: monthly(0.9) };

const P = () => `/projects/${projectId}`;
const tick = () => runTick({ feeds: false, reports: false, alerts: false });
const reportOf = async (u: User, runId: string) => {
	const res = await u.call('GET', `${P()}/runs/${runId}/evidence-report`);
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return res.body.report as EvidenceReport;
};
const rowOf = (r: EvidenceReport) => r.rows.find((x) => x.id === 'otherApplications')!;

async function application(u: User, name: string, ops: unknown[]) {
	const res = await u.call('POST', `${P()}/scenarios`, { name, baseRunId: published, ops });
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	const sid = res.body.scenario.id as string;
	expect((await u.call('POST', `${P()}/scenarios/${sid}/submit`)).status).toBe(200);
	return sid;
}

beforeAll(async () => {
	[owner, assessor, applicantA, applicantB] = (await Promise.all(['Rcowner', 'Rcassessor', 'Rcapplicanta', 'Rcapplicantb'].map((n) => signUp(n)))) as [User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Combined row' })).body.project.id;
	const model = {
		nodes: [outlet, rooikloof, kalkoenkrans, bergvliet],
		crops: [lucerne],
		cropAreas: [
			{ nodeId: rooikloof.id, cropId: lucerne.id, areaM2: 80_000 },
			{ nodeId: kalkoenkrans.id, cropId: lucerne.id, areaM2: 60_000 }
		],
		transfers: []
	};
	expect((await owner.call('PUT', `${P()}/model`, model)).status).toBe(200);
	expect((await owner.call('PATCH', P(), { settings: { apanMm: monthly(150), ewrPragmaticM3PerDay: monthly(2000) } })).status).toBe(200);
	const rain = Array.from({ length: 120 }, (_, i) => (i % 9 === 0 ? 25 : 0));
	expect((await owner.call('PUT', `${P()}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: rain })).status).toBe(200);
	const run = await owner.call('POST', `${P()}/runs`, { label: 'Baseline' });
	expect(run.status, JSON.stringify(run.body)).toBe(201);
	published = run.body.run.id;
	expect((await owner.call('POST', `${P()}/publication`, { runId: published })).status).toBe(201);
	for (const [u, role] of [
		[assessor, 'editor'],
		[applicantA, 'contributor'],
		[applicantB, 'contributor']
	] as const) {
		expect((await owner.call('POST', `${P()}/members`, { email: u.email, role })).status, u.email).toBe(201);
	}
	expect((await owner.call('PUT', `${P()}/farmers/${applicantA.id}`, { nodeIds: [rooikloof.id] })).status).toBe(200);
	expect((await owner.call('PUT', `${P()}/farmers/${applicantB.id}`, { nodeIds: [kalkoenkrans.id] })).status).toBe(200);
	// A doubles Rooikloof's dam; B triples Kalkoenkrans's lucerne. Disjoint: they combine.
	appA = await application(applicantA, 'Raise Rooikloof', [{ op: 'node.set', nodeId: rooikloof.id, field: 'damCapacityM3', value: 200_000 }]);
	appB = await application(applicantB, 'More lucerne on Kalkoenkrans', [{ op: 'cropArea.set', nodeId: kalkoenkrans.id, cropId: lucerne.id, areaM2: 180_000 }]);
	const ran = await assessor.call('POST', `${P()}/scenarios/${appA}/runs`, {});
	expect(ran.status, JSON.stringify(ran.body)).toBe(201);
	runA = ran.body.run.id;
}, 120_000);

describe('the evidence report’s combined row (evidence-11, C26)', () => {
	it('says the applications have not been assessed together until an assessment of exactly them exists', async () => {
		const r = await reportOf(assessor, runA);
		expect(r.version).toBe('evidence-25');
		const c = r.cumulative.combined!;
		expect(c.applications.map((x) => [x.scenarioName, x.isThis])).toEqual([
			['Raise Rooikloof', true],
			['More lucerne on Kalkoenkrans', false]
		]);
		expect(c.conflicts).toEqual([]);
		expect(c.notAssessed).toBe(COMBINED_NOT_RUN(2));
		expect(rowOf(r)).toMatchObject({ notAssessed: COMBINED_NOT_RUN(2), change: null });
	});

	it('says one is under way while it is queued, then reads the assessment’s combined change and interaction once it completes', async () => {
		const res = await assessor.call('POST', `${P()}/assessments`, { name: 'Both', scenarioIds: [appB, appA] });
		expect(res.status, JSON.stringify(res.body)).toBe(202);
		expect(rowOf(await reportOf(assessor, runA)).notAssessed).toBe(COMBINED_PENDING);
		await tick();
		const got = (await assessor.call('GET', `${P()}/assessments/${res.body.assessment.id}`)).body.assessment;
		expect(got.status).toBe('complete');
		const outlet = (got.report as CumulativeReport).rows.find((x) => x.metric === 'ewr_days_not_met' && x.isOutlet)!;

		const r = await reportOf(assessor, runA);
		const c = r.cumulative.combined!;
		expect(c.notAssessed).toBeNull();
		expect(c.assessment).toMatchObject({ id: res.body.assessment.id, name: 'Both', createdBy: 'Rcassessor', engineVersion: got.engineVersion });
		expect(c.ewrDays).toEqual({ baseline: outlet.baseline, combined: outlet.combined, change: outlet.combinedChange, sumOfSingles: outlet.sumOfSingles, interaction: outlet.interaction });
		// Each application's own change alone, matched by id whatever order the assessment took them in.
		expect(c.applications.map((x) => x.ewrDays)).toEqual([outlet.singleChanges[1], outlet.singleChanges[0]]);
		expect(rowOf(r)).toMatchObject({ notAssessed: null, baseline: outlet.baseline, application: outlet.combined, change: { run: outlet.combinedChange, band: null } });
		expect(rowOf(r).note).toMatch(/^2 applications together: “Raise Rooikloof” \(this one\), “More lucerne on Kalkoenkrans”\./);
	});

	it('reads no assessment of another set: a third application on the baseline needs a new one', async () => {
		const appC = await application(owner, 'Team pump on Bergvliet', [{ op: 'node.set', nodeId: bergvliet.id, field: 'divertCapacityM3Day', value: 9000 }]);
		try {
			const r = await reportOf(assessor, runA);
			expect(r.cumulative.combined!.applications).toHaveLength(3);
			expect(rowOf(r)).toMatchObject({ notAssessed: COMBINED_NOT_RUN(3), change: null });
		} finally {
			expect((await owner.call('POST', `${P()}/scenarios/${appC}/withdraw`, {})).status).toBeLessThan(300);
		}
		// Positive control: withdrawn, it leaves the set, and the assessment of the two is read again.
		expect(rowOf(await reportOf(assessor, runA)).notAssessed).toBeNull();
	});

	it('reads only an assessment on the baseline run’s engine: one on another engine is named with why, until they are assessed again', async () => {
		// The assessment above, as if made on an older engine. An assessment is fixed once complete (145's
		// assessment_complete trigger), so the schema owner moves its engine with the triggers off.
		const client = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
		await client.connect();
		try {
			await client.query('BEGIN');
			await client.query('SET LOCAL session_replication_role = replica');
			await client.query(`UPDATE assessment SET engine_version = '0.0.1-older' WHERE project_id = $1 AND status = 'complete'`, [projectId]);
			await client.query('COMMIT');
		} finally {
			await client.end();
		}
		const r = await reportOf(assessor, runA);
		const why = `Not assessed: they were assessed together on engine 0.0.1-older, but the baseline ran on engine ${ENGINE_VERSION}, so its baseline figure isn’t this report’s: assess them together again.`;
		expect(r.cumulative.combined!).toMatchObject({ notAssessed: why, assessment: null, ewrDays: null });
		expect(rowOf(r)).toMatchObject({ notAssessed: why, change: null, baseline: null, application: null });

		// Positive control: assessed again, on the baseline's engine, the row reads the new one.
		const res = await assessor.call('POST', `${P()}/assessments`, { name: 'Both, again', scenarioIds: [appA, appB] });
		expect(res.status, JSON.stringify(res.body)).toBe(202);
		expect(rowOf(await reportOf(assessor, runA)).notAssessed).toBe(COMBINED_PENDING);
		await tick();
		const again = (await reportOf(assessor, runA)).cumulative.combined!;
		expect(again.notAssessed).toBeNull();
		expect(again.assessment).toMatchObject({ id: res.body.assessment.id, name: 'Both, again', engineVersion: ENGINE_VERSION });
	});

	it('says why no assessment can match while the server runs another engine than the baseline’s', () => {
		expect(staleAssessment(null, '1.0.0', '1.0.0')).toBeNull();
		expect(staleAssessment('0.9.0', '1.0.0', '1.0.0')).toMatch(/assessed together on engine 0\.9\.0, but the baseline ran on engine 1\.0\.0, .*assess them together again\.$/);
		expect(staleAssessment(null, '1.0.0', '1.1.0')).toBe(
			'the baseline ran on engine 1.0.0, and an assessment now runs on engine 1.1.0, so none made now would match the report’s baseline: run the baseline again on engine 1.1.0 and assess the applications on that run.'
		);
		expect(staleAssessment('1.0.0', '0.9.0', '1.1.0')).toMatch(/^they were assessed together on engine 1\.0\.0, but the baseline ran on engine 0\.9\.0, and an assessment now runs on engine 1\.1\.0/);
	});

	it('is not assessed when an application on the baseline conflicts with this one, naming the conflict', async () => {
		const clash = await application(owner, 'Smaller Rooikloof', [{ op: 'node.set', nodeId: rooikloof.id, field: 'damCapacityM3', value: 60_000 }]);
		try {
			const r = await reportOf(assessor, runA);
			const c = r.cumulative.combined!;
			const message = '"Raise Rooikloof" op 1 (node.set) and "Smaller Rooikloof" op 1 (node.set) both change hydrological unit "Rooikloof": damCapacityM3';
			expect(c.conflicts).toEqual([message]);
			expect(c.ewrDays).toBeNull();
			expect(c.assessment).toBeNull();
			expect(rowOf(r)).toMatchObject({ notAssessed: COMBINED_CONFLICT([message]), change: null, baseline: null, application: null });
		} finally {
			expect((await owner.call('POST', `${P()}/scenarios/${clash}/withdraw`, {})).status).toBeLessThan(300);
		}
	});
});

describe('yield and reliability per dam, together (evidence-25; followups § Cumulative impact)', () => {
	const assessmentOf = async (name: string) => {
		const list = (await assessor.call('GET', `${P()}/assessments`)).body.assessments as { id: string; name: string; status: string }[];
		const a = list.find((x) => x.name === name && x.status === 'complete')!;
		return (await assessor.call('GET', `${P()}/assessments/${a.id}`)).body.assessment as { report: CumulativeReport };
	};
	const firmYieldOf = async (target: { runId?: string; scenarioId?: string }, nodeId: string) => {
		const res = await assessor.call('POST', `${P()}/yield`, { nodeId, kind: 'firm', ...target });
		expect(res.status, JSON.stringify(res.body)).toBe(202);
		await tick();
		const q = new URLSearchParams({ nodeId, ...(target as Record<string, string>) });
		const got = (await assessor.call('GET', `${P()}/yield?${q}`)).body.results as { points: { point: { yieldM3Year: number } } }[];
		return got[0]!.points.point.yieldM3Year;
	};

	it('the job adds rows for each dam the applications touch, none for an untouched dam, and the firm yields are the Yield job’s', async () => {
		const res = await assessor.call('POST', `${P()}/assessments`, { name: 'Yields', scenarioIds: [appA, appB] });
		expect(res.status, JSON.stringify(res.body)).toBe(202);
		await tick();
		const { report } = await assessmentOf('Yields');
		// A raises Rooikloof's dam, B plants on Kalkoenkrans (a unit with a dam too); Bergvliet's dam is no one's business.
		expect(report.dams).toEqual({ nodeIds: [kalkoenkrans.id, rooikloof.id], onVolumes: false });
		const damRows = report.rows.filter((r) => r.metric === 'dam_firm_yield' || r.metric === 'dam_reliability');
		expect(damRows.map((r) => [r.metric, r.site, r.siteNodeId, r.unit])).toEqual([
			['dam_firm_yield', 'Kalkoenkrans', kalkoenkrans.id, 'm³/year'],
			['dam_reliability', 'Kalkoenkrans', kalkoenkrans.id, 'fraction'],
			['dam_firm_yield', 'Rooikloof', rooikloof.id, 'm³/year'],
			['dam_reliability', 'Rooikloof', rooikloof.id, 'fraction']
		]);
		expect(report.rows.some((r) => r.siteNodeId === bergvliet.id)).toBe(false);
		for (const r of damRows.filter((x) => x.metric === 'dam_firm_yield')) {
			expect(r.baseline).not.toBeNull();
			expect(r.combined).not.toBeNull();
			expect(r.interaction).toBeCloseTo(r.combinedChange! - r.sumOfSingles!, 6);
		}
		// The assurance of supply counts whole water years, and this record (120 days) has none: not assessed, never 0.
		for (const r of damRows.filter((x) => x.metric === 'dam_reliability')) expect([r.baseline, r.combined, r.interaction]).toEqual([null, null, null]);
		// Cross-checks against the Yield job: the baseline column on the published run, A's column on A's scenario.
		const rooi = damRows[2]!;
		expect(rooi.baseline).toBe(await firmYieldOf({ runId: published }, rooikloof.id));
		const order = report.scenarios.map((s) => s.id);
		expect(rooi.singles[order.indexOf(appA)]).toBe(await firmYieldOf({ scenarioId: appA }, rooikloof.id));
		// Raising Rooikloof's dam yields no less there.
		expect(rooi.singles[order.indexOf(appA)]!).toBeGreaterThanOrEqual(rooi.baseline!);

		// The report's § 4 reads the newest complete assessment of exactly these: these dams, figures and directions.
		const c = (await reportOf(assessor, runA)).cumulative.combined!;
		expect(c.assessment?.name).toBe('Yields');
		expect(c.dams!.map((d) => [d.name, d.onVolumes, d.withheld])).toEqual([
			['Kalkoenkrans', false, undefined],
			['Rooikloof', false, undefined]
		]);
		const d = c.dams![1]!;
		expect(d.firmYield).toEqual({ baseline: rooi.baseline, combined: rooi.combined, change: rooi.combinedChange, sumOfSingles: rooi.sumOfSingles, interaction: rooi.interaction });
		const tol = 0.001 * Math.max(rooi.baseline!, rooi.combined!);
		expect(d.verdict.firmYield).toBe(Math.abs(rooi.combinedChange!) <= tol ? 'unchanged' : rooi.combinedChange! > 0 ? 'higher' : 'lower');
	});

	it('a reader kept from the registered volumes reads a dam whose yields rest on them as its direction only; the assessor reads the figures (positive control)', async () => {
		const asHidden = () => withUser(assessor.id, (db) => buildEvidenceReport(db, projectId, runA, { othersVolumesHidden: true }));
		// On compare-only runs nothing rests on the volumes: that reader reads the figures too.
		const plain = (await asHidden()).cumulative.combined!.dams!;
		expect(plain.map((d) => [d.name, d.withheld, d.firmYield === null])).toEqual([
			['Kalkoenkrans', undefined, false],
			['Rooikloof', undefined, false]
		]);
		// As if a run of the assessment had capped use at the volumes (an application's allocation mode): the schema owner marks it.
		const client = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
		await client.connect();
		try {
			await client.query('BEGIN');
			await client.query('SET LOCAL session_replication_role = replica');
			await client.query(`UPDATE assessment SET report = jsonb_set(report, '{dams,onVolumes}', 'true') WHERE project_id = $1 AND name = 'Yields'`, [projectId]);
			await client.query('COMMIT');
		} finally {
			await client.end();
		}
		const hidden = (await asHidden()).cumulative.combined!.dams!;
		expect(hidden.map((d) => [d.name, d.withheld, d.firmYield, d.reliability, d.onVolumes])).toEqual([
			['Kalkoenkrans', true, null, null, true],
			['Rooikloof', true, null, null, true]
		]);
		for (const d of hidden) expect(['lower', 'unchanged', 'higher']).toContain(d.verdict.firmYield);
		const full = (await reportOf(assessor, runA)).cumulative.combined!.dams!;
		expect(full.map((d) => [d.withheld, d.firmYield === null, d.onVolumes])).toEqual([
			[undefined, false, true],
			[undefined, false, true]
		]);
		expect(full.map((d) => d.verdict)).toEqual(hidden.map((d) => d.verdict));
	});

	it('an assessment made before them reads with no dams (an older report has none)', async () => {
		const client = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
		await client.connect();
		const { report } = await assessmentOf('Yields');
		const { dams: _dams, ...older } = report;
		try {
			await client.query('BEGIN');
			await client.query('SET LOCAL session_replication_role = replica');
			await client.query(`UPDATE assessment SET report = $2 WHERE project_id = $1 AND name = 'Yields'`, [projectId, JSON.stringify({ ...older, rows: older.rows.filter((r) => !r.metric.startsWith('dam_')) })]);
			await client.query('COMMIT');
		} finally {
			await client.end();
		}
		const c = (await reportOf(assessor, runA)).cumulative.combined!;
		expect(c.notAssessed).toBeNull();
		expect(c.dams).toEqual([]);
	});
});
