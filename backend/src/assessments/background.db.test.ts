// A cumulative assessment's background at full allocation (295, WP-3.10;
// assessments/background.ts): two submitted applications on a baseline whose
// units hold registered volumes, assessed on the hydrologist's baseline and,
// opted into, on an editor's full-allocation run of that baseline. The
// background is its own labelled row set beside the baseline's, never in its
// place; wrong-project, wrong-baseline, other-mode and other-change runs are
// refused (API and database); a reader kept from the volumes reads its
// verdicts only, and a viewer none (positive controls: the assessor).
// Synthetic catchment: invented names and values.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { buildEvidenceReport } from '../evidence/report.js';
import { runTick } from '../jobs/runner.js';
import { BACKGROUND_LABEL } from './background.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let assessor: User;
let viewer: User;
let applicantA: User;
let applicantB: User;
let projectId: string;
let published: string;
let appA: string;
let appB: string;
let fullRun: string;

const outlet = node('Outlet', null);
const sandvlei = node('Sandvlei', outlet.id, { damCapacityM3: 100_000, pctRunoffToDam: 1 });
const doringbos = node('Doringbos', outlet.id);
const kliprug = node('Kliprug', outlet.id);
const lucerne = { id: randomUUID(), name: 'Lucerne', cropFactor: monthly(0.9) };

const P = () => `/projects/${projectId}`;
const tick = () => runTick({ feeds: false, reports: false, alerts: false });
const rowsAs = async (u: User, sql: string, params: unknown[] = []) => withUser(u.id, async (db) => (await db.query(sql, params)).rows);

interface Row {
	metric: string;
	isOutlet: boolean;
	baseline: number | null;
	singles: (number | null)[];
	combined: number | null;
}
interface Report {
	scenarios: { id: string; name: string }[];
	rows: Row[];
	warnings: string[];
	background?: { label: string; run: { id: string; label: string }; report: { scenarios: { id: string }[]; rows: Row[] }; verdictsOnly?: true };
}

async function application(u: User, name: string, ops: unknown[]) {
	const res = await u.call('POST', `${P()}/scenarios`, { name, baseRunId: published, ops });
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	const sid = res.body.scenario.id as string;
	expect((await u.call('POST', `${P()}/scenarios/${sid}/submit`)).status).toBe(200);
	return sid;
}

/** An editor's team scenario on `base` with `ops`, run: its run's id. */
async function scenarioRun(base: string, name: string, ops: unknown[], pid = projectId) {
	const sc = await assessor.call('POST', `/projects/${pid}/scenarios`, { name, baseRunId: base, ops });
	expect(sc.status, JSON.stringify(sc.body)).toBe(201);
	const ran = await assessor.call('POST', `/projects/${pid}/scenarios/${sc.body.scenario.id}/runs`, {});
	expect(ran.status, JSON.stringify(ran.body)).toBe(201);
	return ran.body.run.id as string;
}

const FULL = [{ op: 'settings.set', path: 'allocationMode', value: 'fullAllocation' }];

/** A project of the catchment above; `fresh` gives it its own node and crop ids (ids are unique across projects). */
async function catchmentProject(name: string, fresh = false) {
	const pid = (await owner.call('POST', '/projects', { name })).body.project.id as string;
	const out = fresh ? { ...outlet, id: randomUUID() } : outlet;
	const units = [sandvlei, doringbos, kliprug].map((n) => (fresh ? { ...n, id: randomUUID(), downstreamNodeId: out.id } : n));
	const crop = fresh ? { ...lucerne, id: randomUUID() } : lucerne;
	const model = {
		nodes: [out, ...units],
		crops: [crop],
		cropAreas: units.map((n, i) => ({ nodeId: n.id, cropId: crop.id, areaM2: [80_000, 60_000, 40_000][i]! })),
		transfers: []
	};
	expect((await owner.call('PUT', `/projects/${pid}/model`, model)).status).toBe(200);
	expect((await owner.call('PATCH', `/projects/${pid}`, { settings: { apanMm: monthly(150), ewrPragmaticM3PerDay: monthly(2000) } })).status).toBe(200);
	const rain = Array.from({ length: 730 }, (_, i) => (i % 9 === 0 ? 25 : i % 4 === 0 ? 3 : 0));
	expect((await owner.call('PUT', `/projects/${pid}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2018-10-01', values: rain })).status).toBe(200);
	return { pid, units };
}

beforeAll(async () => {
	[owner, assessor, viewer, applicantA, applicantB] = (await Promise.all(['Bowner', 'Bassessor', 'Bviewer', 'Bapplicanta', 'Bapplicantb'].map((n) => signUp(n)))) as [User, User, User, User, User];
	projectId = (await catchmentProject('Background')).pid;
	for (const [u, role] of [
		[assessor, 'editor'],
		[viewer, 'viewer'],
		[applicantA, 'contributor'],
		[applicantB, 'contributor']
	] as const)
		expect((await owner.call('POST', `${P()}/members`, { email: u.email, role })).status, u.email).toBe(201);
	// Registered volumes well above what the units use: at full allocation they take far more.
	for (const [n, v] of [
		[sandvlei, 300_000],
		[doringbos, 250_000],
		[kliprug, 200_000]
	] as const) {
		const res = await assessor.call('POST', `${P()}/allocations`, { nodeId: n.id, holder: `Holder ${n.name}`, authorisation: 'licence', waterSource: 'surface', volumeM3PerYear: v });
		expect(res.status, JSON.stringify(res.body)).toBe(201);
	}
	const run = await owner.call('POST', `${P()}/runs`, { label: 'Baseline' });
	expect(run.status, JSON.stringify(run.body)).toBe(201);
	published = run.body.run.id;
	expect((await owner.call('POST', `${P()}/publication`, { runId: published })).status).toBe(201);
	expect((await owner.call('PUT', `${P()}/farmers/${applicantA.id}`, { nodeIds: [sandvlei.id] })).status).toBe(200);
	expect((await owner.call('PUT', `${P()}/farmers/${applicantB.id}`, { nodeIds: [doringbos.id] })).status).toBe(200);
	appA = await application(applicantA, 'Raise Sandvlei', [{ op: 'node.set', nodeId: sandvlei.id, field: 'damCapacityM3', value: 200_000 }]);
	appB = await application(applicantB, 'More lucerne on Doringbos', [{ op: 'cropArea.set', nodeId: doringbos.id, cropId: lucerne.id, areaM2: 180_000 }]);
	fullRun = await scenarioRun(published, 'Existing authorised use', FULL);
}, 180_000);

describe('an assessment against existing authorised use', () => {
	let plainReport: Report;
	let withBackground: string;

	it('lists the runs that can be the background: full-allocation scenario runs on this baseline only', async () => {
		const cap = await scenarioRun(published, 'Capped', [{ op: 'settings.set', path: 'allocationMode', value: 'cap' }]);
		const mixed = await scenarioRun(published, 'Full and a pump', [...FULL, { op: 'node.set', nodeId: kliprug.id, field: 'divertCapacityM3Day', value: 900 }]);
		const res = await assessor.call('GET', `${P()}/assessments/backgrounds?baseRunId=${published}`);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		const ids = res.body.runs.map((r: { id: string }) => r.id);
		expect(ids).toContain(fullRun);
		expect(ids).not.toContain(cap);
		expect(ids).not.toContain(mixed);
		expect(ids).not.toContain(published);
		expect(res.body.runs.find((r: { id: string }) => r.id === fullRun)).toMatchObject({ scenarioName: 'Existing authorised use', createdAt: expect.any(String) });
		expect((await assessor.call('GET', `${P()}/assessments/backgrounds?baseRunId=nope`)).status).toBe(400);
		expect((await viewer.call('GET', `${P()}/assessments/backgrounds?baseRunId=${published}`)).status).toBe(403);
	});

	it('assesses on the baseline as before, and on the background as its own labelled row set beside it', async () => {
		const plain = await assessor.call('POST', `${P()}/assessments`, { name: 'Baseline only', scenarioIds: [appA, appB] });
		expect(plain.status, JSON.stringify(plain.body)).toBe(202);
		expect(plain.body.assessment).toMatchObject({ backgroundRunId: null, backgroundRun: null });
		const res = await assessor.call('POST', `${P()}/assessments`, { name: 'Against authorised use', scenarioIds: [appA, appB], backgroundRunId: fullRun });
		expect(res.status, JSON.stringify(res.body)).toBe(202);
		withBackground = res.body.assessment.id;
		expect(res.body.assessment).toMatchObject({ backgroundRunId: fullRun, backgroundRun: { id: fullRun }, baseRunId: published });
		await tick();
		const job = (await asOwner('SELECT status, progress FROM job WHERE id = $1', [res.body.jobId]))[0];
		expect(job).toMatchObject({ status: 'done', progress: 100 });

		plainReport = (await assessor.call('GET', `${P()}/assessments/${plain.body.assessment.id}`)).body.assessment.report;
		expect(plainReport.background).toBeUndefined();
		const got = (await assessor.call('GET', `${P()}/assessments/${withBackground}`)).body.assessment;
		expect(got.status).toBe('complete');
		const report = got.report as Report;
		// The baseline's table is the hydrologist's run, exactly as without a background.
		const { background, ...baselineTable } = report;
		expect(baselineTable).toEqual(plainReport);
		const flowAt = (r: { rows: Row[] }) => r.rows.find((x) => x.metric === 'outlet_flow')!;
		const [{ summary: base }] = (await asOwner('SELECT summary FROM model_run WHERE id = $1', [published])) as [{ summary: { catchment: { meanSimulatedOutflowM3Day: number } } }];
		expect(flowAt(report).baseline).toBe(base.catchment.meanSimulatedOutflowM3Day);

		// The background: labelled, the full-allocation run in its baseline column, each application alone and together on it.
		expect(background).toMatchObject({ label: BACKGROUND_LABEL, run: { id: fullRun, scenarioName: 'Existing authorised use' } });
		expect(background!.report.scenarios.map((s) => s.id)).toEqual([appA, appB]);
		const [{ summary: full }] = (await asOwner('SELECT summary FROM model_run WHERE id = $1', [fullRun])) as [{ summary: { catchment: { meanSimulatedOutflowM3Day: number } } }];
		expect(flowAt(background!.report).baseline).toBe(full.catchment.meanSimulatedOutflowM3Day);
		// Every volume taken in full leaves less at the outlet than the hydrologist's use.
		expect(flowAt(background!.report).baseline!).toBeLessThan(flowAt(report).baseline!);
		expect(flowAt(background!.report).combined!).toBeLessThan(flowAt(report).combined!);
		expect(background!.report.rows.map((r) => r.metric)).toContain('existing_supplied');
	});

	it('refuses a run that isn’t this baseline at full allocation, and writes nothing', async () => {
		const before = await asOwner('SELECT count(*)::int AS n FROM assessment WHERE project_id = $1', [projectId]);
		const ask = (backgroundRunId: string) => assessor.call('POST', `${P()}/assessments`, { name: 'x', scenarioIds: [appA, appB], backgroundRunId });
		// Another project's full-allocation run (the assessor edits that project too): 404, as if it didn't exist here.
		const { pid: otherPid, units } = await catchmentProject('Elsewhere', true);
		expect((await owner.call('POST', `/projects/${otherPid}/members`, { email: assessor.email, role: 'editor' })).status).toBe(201);
		expect((await assessor.call('POST', `/projects/${otherPid}/allocations`, { nodeId: units[0]!.id, holder: 'Holder elsewhere', authorisation: 'licence', waterSource: 'surface', volumeM3PerYear: 50_000 })).status).toBe(201);
		const otherBase = (await owner.call('POST', `/projects/${otherPid}/runs`, { label: 'Other baseline' })).body.run.id as string;
		const otherFull = await scenarioRun(otherBase, 'Full elsewhere', FULL, otherPid);
		expect((await ask(otherFull)).status).toBe(404);
		expect((await ask(randomUUID())).status).toBe(404);
		// The baseline itself: a run of the model, not a background.
		const self = await ask(published);
		expect(self.status).toBe(422);
		expect(self.body.error).toMatch(/scenario run on the same baseline run/);
		// A scenario run on this baseline at another mode, or with other changes.
		const plainRun = await scenarioRun(published, 'Not full', [{ op: 'node.set', nodeId: kliprug.id, field: 'divertCapacityM3Day', value: 800 }]);
		expect((await ask(plainRun)).body.error).toMatch(/didn’t run at full allocation/);
		const mixed = await scenarioRun(published, 'Full and more', [...FULL, { op: 'node.set', nodeId: kliprug.id, field: 'divertCapacityM3Day', value: 700 }]);
		const m = await ask(mixed);
		expect(m.status).toBe(422);
		expect(m.body.error).toMatch(/changes more than the allocation mode and registered volumes \(node\.set\)/);
		// A full-allocation run on another baseline of this project.
		const second = (await owner.call('POST', `${P()}/runs`, { label: 'Second baseline' })).body.run.id as string;
		const onSecond = await scenarioRun(second, 'Full on the second', FULL);
		expect((await ask(onSecond)).status).toBe(422);
		// A dry run checks it too.
		expect((await assessor.call('POST', `${P()}/assessments`, { name: 'x', scenarioIds: [appA, appB], backgroundRunId: plainRun, dryRun: true })).status).toBe(422);
		expect(await asOwner('SELECT count(*)::int AS n FROM assessment WHERE project_id = $1', [projectId])).toEqual(before);

		// The rule holds in the database too (295's guard), past the API.
		const insert = (bg: string) =>
			rowsAs(assessor, `INSERT INTO assessment (project_id, base_run_id, name, background_run_id) VALUES ($1, $2, 'direct', $3) RETURNING id`, [projectId, published, bg]);
		await expect(insert(otherFull)).rejects.toThrow(/different project/);
		await expect(insert(published)).rejects.toThrow(/scenario run on its own baseline/);
		await expect(insert(onSecond)).rejects.toThrow(/scenario run on its own baseline/);
		await expect(insert(plainRun)).rejects.toThrow(/run at full allocation/);
		// Positive control: the full-allocation run on this baseline goes in (rolled back below by deleting it).
		const [{ id }] = (await insert(fullRun)) as [{ id: string }];
		await rowsAs(assessor, 'DELETE FROM assessment WHERE id = $1', [id]);
		// Fixed at insert: no one changes it afterwards.
		await expect(rowsAs(assessor, 'UPDATE assessment SET background_run_id = NULL WHERE id = $1', [withBackground])).rejects.toThrow(/permission denied/);
	});

	it('a viewer reads no background; a reader kept from the volumes reads its verdicts only (positive control: the assessor reads it all)', async () => {
		// The viewer: no assessment at all, no background candidate, and no combined row in the baseline's evidence.
		expect((await viewer.call('GET', `${P()}/assessments/${withBackground}`)).status).toBe(403);
		expect(await rowsAs(viewer, 'SELECT id FROM assessment WHERE id = $1', [withBackground])).toEqual([]);
		const asViewer = await viewer.call('GET', `${P()}/runs/${published}/evidence-report`);
		expect(asViewer.status, JSON.stringify(asViewer.body)).toBe(200);
		expect(asViewer.body.report.cumulative.combined?.background ?? null).toBeNull();
		expect(JSON.stringify(asViewer.body.report)).not.toContain(BACKGROUND_LABEL);

		// The assessor's evidence for the baseline reads the newest assessment of exactly these two: the background's.
		const asAssessor = await assessor.call('GET', `${P()}/runs/${published}/evidence-report`);
		expect(asAssessor.status).toBe(200);
		expect(asAssessor.body.report.version).toBe('evidence-26');
		const combined = asAssessor.body.report.cumulative.combined;
		expect(combined.assessment).toMatchObject({ id: withBackground });
		expect(combined.background).toMatchObject({ label: BACKGROUND_LABEL, runLabel: expect.any(String), ewrDays: { baseline: expect.any(Number) } });

		// Built for a reader kept from each volume (a render queued without volumes, 218): the background's days and months only.
		const redacted = await withUser(assessor.id, (db) => buildEvidenceReport(db, projectId, published, { othersVolumesHidden: true }));
		const bg = redacted.cumulative.combined!.background!;
		expect(Object.keys(bg).sort()).toEqual(['ewrDays', 'label', 'reserveMonths', 'runLabel']);
		expect(bg).toEqual(combined.background);
		for (const m of [bg.ewrDays, bg.reserveMonths]) for (const v of Object.values(m ?? {})) if (v !== null) expect(Number.isInteger(v)).toBe(true);
	});
});
