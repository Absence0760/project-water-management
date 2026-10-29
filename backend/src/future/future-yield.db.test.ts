// § 8 Future yield end to end (issue #621 slice 4, 280_future_yield): the
// switch (FUTURE_YIELD), the request's checks, the `future_yield` job reading
// the committed synthetic NEX-GDDP-CMIP6 copy (invented models SYN-A..C,
// backend/fixtures/mirror/cmip6/) over the catchment's 0.25° cells, the stored
// result under RLS (a viewer reads it, positive control; a stranger and
// another contributor don't), and the evidence report freezing it, held from
// issue while NASA's caveat is a placeholder and the windows are partial.
import { futureCaveatPending, type EvidenceReport, type FutureYieldResult } from '@water-management/engine';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { runTick } from '../jobs/runner.js';

// The engine as is, with runFutureYieldAsync watched: a job cancelled before its runs never starts them,
// and `beforeReport` runs before the handler's report after each case (a cancel there, deterministically, no sleeps).
const runs = vi.hoisted(() => ({ calls: 0, dones: [] as number[], beforeReport: null as null | ((done: number) => Promise<void>) }));
vi.mock('@water-management/engine', async (orig) => {
	const real = await orig<typeof import('@water-management/engine')>();
	return {
		...real,
		runFutureYieldAsync: (args: Parameters<typeof real.runFutureYieldAsync>[0]) => (
			runs.calls++,
			real.runFutureYieldAsync({
				...args,
				onCase: async (done, total) => {
					runs.dones.push(done);
					await runs.beforeReport?.(done);
					return args.onCase(done, total);
				}
			})
		)
	};
});

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let viewer: User;
let stranger: User;
let contributor: User;
let projectId: string;
let farmId: string;
let baseRun: string;
let appRun: string;

const tick = () => runTick({ feeds: false, reports: false });
const job = async (id: string) => (await asOwner('SELECT status, last_error FROM job WHERE id = $1', [id]))[0] as { status: string; last_error: string | null };
const post = (u: User, runId: string, body: Record<string, unknown> = {}) => u.call('POST', `/projects/${projectId}/runs/${runId}/future-yield`, body);
const get = (u: User, runId: string) => u.call('GET', `/projects/${projectId}/runs/${runId}/future-yield`);
const cancel = (u: User, runId: string, jobId: string, project = projectId) => u.call('POST', `/projects/${project}/runs/${runId}/future-yield/${jobId}/cancel`, {});
const sq = (lon: number, lat: number, d: number) => [[lon, lat], [lon + d, lat], [lon + d, lat + d], [lon, lat + d], [lon, lat]];

afterEach(() => {
	vi.unstubAllEnvs();
	runs.beforeReport = null;
});

beforeAll(async () => {
	[owner, viewer, stranger, contributor] = await Promise.all([signUp('FyOwner'), signUp('FyViewer'), signUp('FyStranger'), signUp('FyContributor')]);
	projectId = (await owner.call('POST', '/projects', { name: 'Future yield' })).body.project.id as string;
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: contributor.email, role: 'contributor' })).status).toBe(201);
	const outlet = node('Outlet', null);
	const farm = node('Upper', outlet.id, { areaKm2: 30, pctRunoffToDam: 0, damCapacityM3: 0, damInitialPct: 0 });
	farmId = farm.id;
	const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.8) };
	expect((await owner.call('PUT', `/projects/${projectId}/model`, { nodes: [outlet, farm], crops: [crop], cropAreas: [{ nodeId: farmId, cropId: crop.id, areaM2: 100_000 }], transfers: [] })).status).toBe(200);
	expect((await owner.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(150), ewrPragmaticM3PerDay: monthly(5000), runoffModel: 'gr4j' } })).status).toBe(200);
	const rain = Array.from({ length: 2 * 365 }, (_, i) => (i % 4 === 0 ? (Math.floor(i / 30) % 12 < 6 ? 18 : 6) : 0));
	expect((await owner.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2018-10-01', values: rain })).status).toBe(200);
	const run = await owner.call('POST', `/projects/${projectId}/runs`, { label: 'Baseline' });
	expect(run.status, JSON.stringify(run.body)).toBe(201);
	baseRun = run.body.run.id;
	// The application: a 200 000 m³ dam on Upper, full at the start, catching half its runoff.
	const created = await owner.call('POST', `/projects/${projectId}/scenarios`, {
		name: 'Upper dam',
		baseRunId: baseRun,
		ops: [
			{ op: 'node.set', nodeId: farmId, field: 'damCapacityM3', value: 200_000 },
			{ op: 'node.set', nodeId: farmId, field: 'pctRunoffToDam', value: 0.5 },
			{ op: 'node.set', nodeId: farmId, field: 'damInitialPct', value: 1 }
		],
		ownedNodeIds: [farmId]
	});
	expect(created.status, JSON.stringify(created.body)).toBe(201);
	const ran = await owner.call('POST', `/projects/${projectId}/scenarios/${created.body.scenario.id}/runs`, {});
	expect(ran.status, JSON.stringify(ran.body)).toBe(201);
	appRun = ran.body.run.id;
}, 300_000);

describe('§ 8 future yield', () => {
	it('is off by default: the request is refused, and the report has no § 8', async () => {
		vi.stubEnv('FUTURE_YIELD', '');
		const res = await post(owner, appRun);
		expect(res.status).toBe(409);
		expect(res.body.details.code).toBe('future_yield_off');
		expect((await get(viewer, appRun)).body).toEqual({ enabled: false, result: null, job: null });
		const r = (await owner.call('GET', `/projects/${projectId}/runs/${appRun}/evidence-report`)).body.report as EvidenceReport;
		expect(r.version).toBe('evidence-24');
		expect(r.futureYield).toBeNull();
	});

	it('refuses what it can’t run: a viewer, a run that isn’t an application, no boundary yet', async () => {
		vi.stubEnv('FUTURE_YIELD', 'on');
		expect((await post(viewer, appRun)).status).toBe(403);
		expect((await post(stranger, appRun)).status).toBe(404);
		expect((await post(owner, baseRun)).body.details.code).toBe('not_application');
		expect((await post(owner, appRun)).body.details.code).toBe('no_boundary');
		expect((await post(owner, appRun, { nodeId: crypto.randomUUID() })).status).toBe(400);
		// With it on and none run, the application report says Not assessed.
		const r = (await owner.call('GET', `/projects/${projectId}/runs/${appRun}/evidence-report`)).body.report as EvidenceReport;
		expect(r.futureYield).toMatchObject({ status: 'notRun' });
	});

	it('runs every pair over the synthetic copy, stores it under RLS, and the report freezes it, held from issue', async () => {
		vi.stubEnv('FUTURE_YIELD', 'on');
		const b = await owner.call('POST', `/projects/${projectId}/map/features`, { kind: 'catchment_boundary', name: 'Synthetic catchment', geometry: { type: 'Polygon', coordinates: [sq(21.3, -33.7, 0.1)] } });
		expect(b.status, JSON.stringify(b.body)).toBe(201);
		const res = await post(owner, appRun);
		expect(res.status, JSON.stringify(res.body)).toBe(202);
		// The same request while it waits is that job, and the GET names it (§ 8's Run button follows it after a reload).
		expect((await post(owner, appRun)).body.jobId).toBe(res.body.jobId);
		expect((await get(viewer, appRun)).body.job).toMatchObject({ id: res.body.jobId, kind: 'future_yield', status: 'queued' });
		await tick();
		expect(await job(res.body.jobId)).toEqual({ status: 'done', last_error: null });

		const got = await get(viewer, appRun);
		expect(got.status).toBe(200);
		expect(got.body.enabled).toBe(true);
		expect(got.body.job).toMatchObject({ id: res.body.jobId, status: 'done' });
		const row = got.body.result;
		expect(row).toMatchObject({ baselineRunId: baseRun, applicationRunId: appRun, nodeId: farmId, jobId: res.body.jobId, createdBy: expect.any(String) });
		const r = row.result as FutureYieldResult;
		expect(r).toMatchObject({ version: 'future-1', method: 'delta-1', models: ['SYN-A', 'SYN-B', 'SYN-C'], fewModels: true, nodeName: 'Upper', ownedNodeIds: [farmId] });
		expect(r.cases).toHaveLength(12);
		expect(r.groups).toHaveLength(4);
		// The synthetic copy holds 2 baseline years and 1 of each future window: counted, not hidden.
		expect(r.factors.cases.every((c) => c.years.baseline === 2 && c.years.future === 1)).toBe(true);
		// Warmer under each SSP (the fixture's invented pattern): every evaporation factor above 1; every factor in the op's range.
		expect(r.factors.cases.every((c) => c.evapFactorByMonth.every((f) => f > 1))).toBe(true);
		expect(r.factors.cases.every((c) => [...c.rainFactorByMonth, ...c.evapFactorByMonth].every((f) => f >= 0.5 && f <= 1.5))).toBe(true);
		expect(r.factors.sources.map((s) => s.product)).toEqual(['SYN-A', 'SYN-B', 'SYN-C'].flatMap((m) => ['historical', 'ssp245', 'ssp585'].map((s) => `cmip6/${m}/${s}`)));
		expect(r.factors.sources.every((s) => /^[0-9a-f]{64}$/.test(s.filesSha256) && s.files > 0)).toBe(true);
		// Each file's own licence attribute, verbatim: SYN-C's historical files still say CC BY-SA 4.0.
		expect(r.factors.sources.find((s) => s.product === 'cmip6/SYN-C/historical')!.licenses).toEqual(['CC BY-SA 4.0 (synthetic fixture: invented values)']);
		expect(r.historical.firmYieldM3Year).toBeGreaterThan(0);

		// RLS: a stranger reads nothing; a contributor who doesn't own the application reads no row (the viewer above is the positive control).
		expect((await get(stranger, appRun)).status).toBe(404);
		expect((await get(contributor, appRun)).body).toMatchObject({ result: null, job: null });
		expect(await asOwner('SELECT count(*)::int AS n FROM future_yield WHERE application_run_id = $1', [appRun])).toEqual([{ n: 1 }]);

		const report = (await viewer.call('GET', `/projects/${projectId}/runs/${appRun}/evidence-report`)).body.report as EvidenceReport;
		const s = report.futureYield!;
		expect(s).toMatchObject({ status: 'ok', complete: false, models: ['SYN-A', 'SYN-B', 'SYN-C'] });
		if (s.status === 'ok') expect(s.cases).toEqual(r.cases);
		const check = report.checks.find((c) => c.id === 'futureYield')!;
		expect(check).toMatchObject({ passed: false, blocksIssue: true });
		expect(check.detail).toContain('part of their 30-year windows');
		if (futureCaveatPending()) expect(check.detail).toContain('NASA’s own caveat');
		expect(report.issuable).toBe(false);
	});

	it('cancels a job: an editor may, a viewer, a stranger and another project may not', async () => {
		vi.stubEnv('FUTURE_YIELD', 'on');
		// The boundary the test above drew is still there.
		const res = await post(owner, appRun);
		expect(res.status, JSON.stringify(res.body)).toBe(202);
		const jobId = res.body.jobId as string;
		expect((await cancel(viewer, appRun, jobId)).status).toBe(403);
		expect((await cancel(contributor, appRun, jobId)).status).toBe(403);
		expect((await cancel(stranger, appRun, jobId)).status).toBe(404);
		// The stranger's own project, as its owner (an editor there): the job isn't of that project.
		const other = (await stranger.call('POST', '/projects', { name: 'Not that one' })).body.project.id as string;
		expect((await cancel(stranger, appRun, jobId, other)).status).toBe(404);
		// Under another run's path: not that run's job.
		expect((await cancel(owner, baseRun, jobId)).status).toBe(404);
		expect((await cancel(owner, appRun, 'not-a-uuid')).status).toBe(404);
		expect(await job(jobId)).toEqual({ status: 'queued', last_error: null });
		// Positive control: the editor cancels it, and a waiting job is dead at once.
		const ok = await cancel(owner, appRun, jobId);
		expect(ok.status, JSON.stringify(ok.body)).toBe(200);
		expect(ok.body).toEqual({ status: 'dead', cancelled: true });
		expect(await job(jobId)).toEqual({ status: 'dead', last_error: 'cancelled' });
		// Again: already dead, so this call changed nothing (285_cancel_job_outcome).
		expect((await cancel(owner, appRun, jobId)).body).toEqual({ status: 'dead', cancelled: false });
		expect((await get(viewer, appRun)).body.job).toMatchObject({ id: jobId, status: 'dead', error: 'cancelled' });
		// The next request is a new job.
		const again = await post(owner, appRun);
		expect(again.status).toBe(202);
		expect(again.body.jobId).not.toBe(jobId);

		// One cancelled while it reads the copy (flagged as app_cancel_job flags a running job) stops before its runs and writes nothing.
		await asOwner('UPDATE job SET cancel_requested_at = now() WHERE id = $1', [again.body.jobId]);
		const before = runs.calls;
		const { n } = ((await asOwner('SELECT count(*)::int AS n FROM future_yield WHERE application_run_id = $1', [appRun])) as { n: number }[])[0]!;
		await tick();
		expect(await job(again.body.jobId)).toEqual({ status: 'dead', last_error: 'cancelled' });
		expect(runs.calls).toBe(before);
		expect(await asOwner('SELECT count(*)::int AS n FROM future_yield WHERE application_run_id = $1', [appRun])).toEqual([{ n }]);
	});

	it('flags a running job for its handler rather than killing it', async () => {
		vi.stubEnv('FUTURE_YIELD', 'on');
		const res = await post(owner, appRun);
		expect(res.status, JSON.stringify(res.body)).toBe(202);
		await asOwner(
			`UPDATE job SET status = 'running', attempts = 1, locked_until = now() + interval '1 minute', lease_token = gen_random_uuid(), started_at = now() WHERE id = $1`,
			[res.body.jobId]
		);
		expect((await cancel(owner, appRun, res.body.jobId)).body).toEqual({ status: 'running', cancelled: true });
		expect(await asOwner('SELECT status, cancel_requested_at IS NOT NULL AS flagged FROM job WHERE id = $1', [res.body.jobId])).toEqual([{ status: 'running', flagged: true }]);
		// Again: already flagged, so this call changed nothing.
		expect((await cancel(owner, appRun, res.body.jobId)).body).toEqual({ status: 'running', cancelled: false });
		// Leave nothing running for the next test's tick.
		await asOwner(`UPDATE job SET status = 'dead', finished_at = now(), last_error = 'cancelled', locked_until = NULL, lease_token = NULL WHERE id = $1`, [res.body.jobId]);
	});

	it('stops between cases when cancelled mid-run: no further case runs, nothing is stored, and its progress was real', async () => {
		vi.stubEnv('FUTURE_YIELD', 'on');
		const res = await post(owner, appRun);
		expect(res.status, JSON.stringify(res.body)).toBe(202);
		const jobId = res.body.jobId as string;
		const { n } = ((await asOwner('SELECT count(*)::int AS n FROM future_yield WHERE application_run_id = $1', [appRun])) as { n: number }[])[0]!;
		const seen: { done: number; progress: number }[] = [];
		runs.dones = [];
		runs.beforeReport = async (done) => {
			// The progress the previous case reported, as the board reads it.
			seen.push({ done, progress: ((await asOwner('SELECT progress FROM job WHERE id = $1', [jobId])) as { progress: number }[])[0]!.progress });
			// After the second case (done 3 of 13), cancel as an editor would, through the route.
			if (done === 3) expect((await cancel(owner, appRun, jobId)).body).toEqual({ status: 'running', cancelled: true });
		};
		await tick();
		expect(await job(jobId)).toEqual({ status: 'dead', last_error: 'cancelled' });
		// The historical pair and two cases ran; the third never started.
		expect(runs.dones).toEqual([1, 2, 3]);
		// Real progress: after the copy's read (10 %), then 10 % + 90 % × done / 13 after each.
		expect(seen.map((x) => x.progress)).toEqual([10, Math.round(10 + (90 * 1) / 13), Math.round(10 + (90 * 2) / 13)]);
		expect(await asOwner('SELECT count(*)::int AS n FROM future_yield WHERE application_run_id = $1', [appRun])).toEqual([{ n }]);
		expect(await asOwner('SELECT count(*)::int AS n FROM future_yield WHERE job_id = $1', [jobId])).toEqual([{ n: 0 }]);
	});

	it('dies, saying why, when the data copy holds no projections yet', async () => {
		vi.stubEnv('FUTURE_YIELD', 'on');
		const empty = await mkdtemp(join(tmpdir(), 'wm-no-cmip6-'));
		vi.stubEnv('MIRROR_URL', pathToFileURL(empty).href);
		const res = await post(owner, appRun);
		expect(res.status, JSON.stringify(res.body)).toBe(202);
		await tick();
		const j = await job(res.body.jobId);
		expect(j.status).toBe('dead');
		expect(j.last_error).toContain('the data copy holds no NEX-GDDP-CMIP6 model yet: the operator loads it');
	});

	it('refuses an application that already assumes a climate of its own', async () => {
		vi.stubEnv('FUTURE_YIELD', 'on');
		const created = await owner.call('POST', `/projects/${projectId}/scenarios`, {
			name: 'Upper dam, drier',
			baseRunId: baseRun,
			ops: [
				{ op: 'node.set', nodeId: farmId, field: 'damCapacityM3', value: 200_000 },
				{ op: 'climate.delta', rainFactorByMonth: monthly(0.9), evapFactorByMonth: monthly(1.05), label: 'Invented', source: 'Invented factors' }
			],
			ownedNodeIds: [farmId]
		});
		expect(created.status, JSON.stringify(created.body)).toBe(201);
		const ran = await owner.call('POST', `/projects/${projectId}/scenarios/${created.body.scenario.id}/runs`, {});
		expect(ran.status, JSON.stringify(ran.body)).toBe(201);
		const res = await post(owner, ran.body.run.id);
		expect(res.status).toBe(409);
		expect(res.body.error).toMatch(/already assumes a future climate/);
	});
});
