// The Scenarios tab's future climate end to end (issue #621 slice 5,
// 282_climate_factors): the switch (FUTURE_YIELD), the request's checks, the
// `climate_factors` job reading the committed synthetic NEX-GDDP-CMIP6 copy
// (invented models SYN-A..C, backend/fixtures/mirror/cmip6/) over the
// catchment's 0.25° cells, the stored table under RLS (a viewer reads it,
// positive control; a contributor and a stranger don't), the boundary
// changing after, and a scenario taking one case as a climate.delta op.
import { futureCaseOp, type FutureFactorTable } from '@water-management/engine';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { runTick } from '../jobs/runner.js';

// The copy's read as is, with each model's report watched: `beforeReport` runs before the handler's report after
// each model (a cancel there, deterministically, no sleeps).
const reads = vi.hoisted(() => ({ dones: [] as number[], beforeReport: null as null | ((done: number) => Promise<void>) }));
vi.mock('./copy.js', async (orig) => {
	const real = await orig<typeof import('./copy.js')>();
	return {
		...real,
		readFactorTable: (store: Parameters<typeof real.readFactorTable>[0], cells: Parameters<typeof real.readFactorTable>[1], onModel?: Parameters<typeof real.readFactorTable>[2]) =>
			real.readFactorTable(store, cells, async (done, total) => {
				reads.dones.push(done);
				await reads.beforeReport?.(done);
				await onModel?.(done, total);
			})
	};
});

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let viewer: User;
let stranger: User;
let contributor: User;
let projectId: string;
let baseRun: string;

const tick = () => runTick({ feeds: false, reports: false });
const job = async (id: string) => (await asOwner('SELECT status, last_error FROM job WHERE id = $1', [id]))[0] as { status: string; last_error: string | null };
const post = (u: User) => u.call('POST', `/projects/${projectId}/climate-factors`, {});
const get = (u: User) => u.call('GET', `/projects/${projectId}/climate-factors`);
const cancel = (u: User, jobId: string, project = projectId) => u.call('POST', `/projects/${project}/climate-factors/${jobId}/cancel`, {});
const sq = (lon: number, lat: number, d: number) => [[lon, lat], [lon + d, lat], [lon + d, lat + d], [lon, lat + d], [lon, lat]];

afterEach(() => {
	vi.unstubAllEnvs();
	reads.beforeReport = null;
});

beforeAll(async () => {
	[owner, viewer, stranger, contributor] = await Promise.all([signUp('CfOwner'), signUp('CfViewer'), signUp('CfStranger'), signUp('CfContributor')]);
	projectId = (await owner.call('POST', '/projects', { name: 'Future climate' })).body.project.id as string;
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: contributor.email, role: 'contributor' })).status).toBe(201);
	const outlet = node('Outlet', null);
	const farm = node('Upper', outlet.id, { areaKm2: 30 });
	expect((await owner.call('PUT', `/projects/${projectId}/model`, { nodes: [outlet, farm], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
	expect((await owner.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(150), runoffModel: 'gr4j' } })).status).toBe(200);
	const rain = Array.from({ length: 365 }, (_, i) => (i % 4 === 0 ? 12 : 0));
	expect((await owner.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2018-10-01', values: rain })).status).toBe(200);
	const run = await owner.call('POST', `/projects/${projectId}/runs`, { label: 'Baseline' });
	expect(run.status, JSON.stringify(run.body)).toBe(201);
	baseRun = run.body.run.id;
}, 300_000);

describe('future climate factors', () => {
	it('is off by default: the request is refused and the GET says so', async () => {
		vi.stubEnv('FUTURE_YIELD', '');
		const res = await post(owner);
		expect(res.status).toBe(409);
		expect(res.body.details.code).toBe('future_yield_off');
		expect((await get(viewer)).body).toEqual({ enabled: false, factors: null, boundary: 'none', job: null });
	});

	it('refuses what it can’t read: a viewer, a stranger, no boundary yet', async () => {
		vi.stubEnv('FUTURE_YIELD', 'on');
		expect((await post(viewer)).status).toBe(403);
		expect((await post(stranger)).status).toBe(404);
		const res = await post(owner);
		expect(res.status).toBe(409);
		expect(res.body.details.code).toBe('no_boundary');
		expect((await get(viewer)).body).toEqual({ enabled: true, factors: null, boundary: 'none', job: null });
	});

	it('works the table out over the synthetic copy, stores it under RLS, and says when the boundary changes', async () => {
		vi.stubEnv('FUTURE_YIELD', 'on');
		const b = await owner.call('POST', `/projects/${projectId}/map/features`, { kind: 'catchment_boundary', name: 'Synthetic catchment', geometry: { type: 'Polygon', coordinates: [sq(21.3, -33.7, 0.1)] } });
		expect(b.status, JSON.stringify(b.body)).toBe(201);
		const res = await post(owner);
		expect(res.status, JSON.stringify(res.body)).toBe(202);
		// The same request while it waits is that job, and the GET names it.
		expect((await post(owner)).body.jobId).toBe(res.body.jobId);
		expect((await get(viewer)).body).toMatchObject({ enabled: true, factors: null, job: { id: res.body.jobId, kind: 'climate_factors', status: 'queued' } });
		await tick();
		expect(await job(res.body.jobId)).toEqual({ status: 'done', last_error: null });

		const got = await get(viewer);
		expect(got.status).toBe(200);
		expect(got.body).toMatchObject({ enabled: true, boundary: 'same', job: { id: res.body.jobId, status: 'done' } });
		expect(got.body.factors).toMatchObject({ jobId: res.body.jobId, warnings: [], createdBy: expect.any(String), boundarySha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
		const t = got.body.factors.factors as FutureFactorTable;
		expect(t.method).toBe('delta-1');
		expect(t.cases).toHaveLength(12);
		expect([...new Set(t.cases.map((c) => c.model))]).toEqual(['SYN-A', 'SYN-B', 'SYN-C']);
		expect(t.cases.every((c) => [...c.rainFactorByMonth, ...c.evapFactorByMonth].every((f) => f >= 0.5 && f <= 1.5))).toBe(true);

		// RLS: a stranger reads nothing, a contributor no table (the viewer above is the positive control).
		expect((await get(stranger)).status).toBe(404);
		expect((await get(contributor)).status).toBe(403);
		expect(await asOwner('SELECT count(*)::int AS n FROM climate_factors WHERE project_id = $1', [projectId])).toEqual([{ n: 1 }]);

		// A scenario takes one case as its climate.delta op, and runs.
		const op = futureCaseOp(t.cases.find((c) => c.model === 'SYN-B' && c.ssp === 'ssp585' && c.horizon === 'late')!, t);
		expect(op.label).toBe('SYN-B SSP5-8.5 2066–2095');
		const sc = await owner.call('POST', `/projects/${projectId}/scenarios`, { name: 'Drier', baseRunId: baseRun, ops: [op] });
		expect(sc.status, JSON.stringify(sc.body)).toBe(201);
		const ran = await owner.call('POST', `/projects/${projectId}/scenarios/${sc.body.scenario.id}/runs`, {});
		expect(ran.status, JSON.stringify(ran.body)).toBe(201);

		// The boundary drawn again: the stored table was read over the old one.
		const features = (await owner.call('GET', `/projects/${projectId}/map/features`)).body.features as { id: string; kind: string }[];
		const boundary = features.find((f) => f.kind === 'catchment_boundary')!;
		const moved = await owner.call('PATCH', `/projects/${projectId}/map/features/${boundary.id}`, { geometry: { type: 'Polygon', coordinates: [sq(21.35, -33.7, 0.1)] } });
		expect(moved.status, JSON.stringify(moved.body)).toBe(200);
		expect((await get(viewer)).body.boundary).toBe('changed');
	});

	it('cancels a job: an editor may, a viewer, a stranger and another project may not', async () => {
		vi.stubEnv('FUTURE_YIELD', 'on');
		const res = await post(owner);
		expect(res.status, JSON.stringify(res.body)).toBe(202);
		const jobId = res.body.jobId as string;
		expect((await cancel(viewer, jobId)).status).toBe(403);
		expect((await cancel(contributor, jobId)).status).toBe(403);
		expect((await cancel(stranger, jobId)).status).toBe(404);
		const other = (await stranger.call('POST', '/projects', { name: 'Not that one' })).body.project.id as string;
		expect((await cancel(stranger, jobId, other)).status).toBe(404);
		expect(await job(jobId)).toEqual({ status: 'queued', last_error: null });
		// Positive control: the editor cancels it; it stops waiting, and the GET says so.
		const ok = await cancel(owner, jobId);
		expect(ok.status, JSON.stringify(ok.body)).toBe(200);
		expect(ok.body).toEqual({ status: 'dead', cancelled: true });
		expect(await job(jobId)).toEqual({ status: 'dead', last_error: 'cancelled' });
		// Again: already dead, so this call changed nothing (285_cancel_job_outcome).
		expect((await cancel(owner, jobId)).body).toEqual({ status: 'dead', cancelled: false });
		expect((await get(viewer)).body.job).toMatchObject({ id: jobId, status: 'dead', error: 'cancelled' });
		// Cancelled while it read the copy: it stores nothing.
		const again = await post(owner);
		expect(again.status).toBe(202);
		await asOwner('UPDATE job SET cancel_requested_at = now() WHERE id = $1', [again.body.jobId]);
		await tick();
		expect(await job(again.body.jobId)).toEqual({ status: 'dead', last_error: 'cancelled' });
		expect(await asOwner('SELECT count(*)::int AS n FROM climate_factors WHERE job_id = $1', [again.body.jobId])).toEqual([{ n: 0 }]);
	});

	it('stops between models when cancelled mid-read: the next model is never read, nothing is stored', async () => {
		vi.stubEnv('FUTURE_YIELD', 'on');
		const res = await post(owner);
		expect(res.status, JSON.stringify(res.body)).toBe(202);
		const jobId = res.body.jobId as string;
		reads.dones = [];
		// After the first of the copy's three models, cancel as an editor would, through the route; a second cancel changes nothing.
		reads.beforeReport = async (done) => {
			if (done !== 1) return;
			expect((await cancel(owner, jobId)).body).toEqual({ status: 'running', cancelled: true });
			expect((await cancel(owner, jobId)).body).toEqual({ status: 'running', cancelled: false });
		};
		await tick();
		expect(await job(jobId)).toEqual({ status: 'dead', last_error: 'cancelled' });
		expect(reads.dones).toEqual([1]);
		expect(await asOwner('SELECT count(*)::int AS n FROM climate_factors WHERE job_id = $1', [jobId])).toEqual([{ n: 0 }]);
		// Positive control: uncancelled, it reads all three and stores the table.
		reads.beforeReport = null;
		reads.dones = [];
		const ok = await post(owner);
		expect(ok.status, JSON.stringify(ok.body)).toBe(202);
		await tick();
		expect(await job(ok.body.jobId)).toEqual({ status: 'done', last_error: null });
		expect(reads.dones).toEqual([1, 2, 3]);
		expect(await asOwner('SELECT count(*)::int AS n FROM climate_factors WHERE job_id = $1', [ok.body.jobId])).toEqual([{ n: 1 }]);
	});

	it('dies, saying why, when the boundary is gone by the time it runs', async () => {
		vi.stubEnv('FUTURE_YIELD', 'on');
		const res = await post(owner);
		expect(res.status, JSON.stringify(res.body)).toBe(202);
		await asOwner(`DELETE FROM map_feature WHERE project_id = $1 AND kind = 'catchment_boundary'`, [projectId]);
		await tick();
		const j = await job(res.body.jobId);
		expect(j.status).toBe('dead');
		expect(j.last_error).toContain('no catchment boundary');
		expect((await get(viewer)).body.boundary).toBe('none');
	});
});
