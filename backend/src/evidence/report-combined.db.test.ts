// The evidence report's combined row (evidence-11, finding C26, WP-3.11):
// page 1's "This and the other applications on this baseline, together"
// reads a completed cumulative assessment of exactly this application and
// every other submitted or approved one on the baseline, with their current
// ops; without one it says why (not assessed yet, under way); a conflict
// makes it not assessed with the conflict named, never a silent merge.
// Synthetic catchment: invented names and values.
import { randomUUID } from 'node:crypto';
import { COMBINED_CONFLICT, COMBINED_NOT_RUN, COMBINED_PENDING, type CumulativeReport, type EvidenceReport } from '@water-management/engine';
import { beforeAll, describe, expect, it } from 'vitest';
import { monthly, node, signUp } from '../__tests__/helpers.js';
import { runTick } from '../jobs/runner.js';

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
		expect(r.version).toBe('evidence-11');
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

	it('is not assessed when an application on the baseline conflicts with this one, naming the conflict', async () => {
		const clash = await application(owner, 'Smaller Rooikloof', [{ op: 'node.set', nodeId: rooikloof.id, field: 'damCapacityM3', value: 60_000 }]);
		try {
			const r = await reportOf(assessor, runA);
			const c = r.cumulative.combined!;
			const message = '"Raise Rooikloof" op 1 (node.set) and "Smaller Rooikloof" op 1 (node.set) both change node "Rooikloof": damCapacityM3';
			expect(c.conflicts).toEqual([message]);
			expect(c.ewrDays).toBeNull();
			expect(c.assessment).toBeNull();
			expect(rowOf(r)).toMatchObject({ notAssessed: COMBINED_CONFLICT([message]), change: null, baseline: null, application: null });
		} finally {
			expect((await owner.call('POST', `${P()}/scenarios/${clash}/withdraw`, {})).status).toBeLessThan(300);
		}
	});
});
