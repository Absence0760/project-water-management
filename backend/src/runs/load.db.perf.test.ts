// The Step 2 load checks (roadmap WP-2.16 and WP-2.11's acceptance criterion,
// issue #51): a 60-farm synthetic catchment with ten years of daily rain.
//
// 1. A manual run through the API (`POST /projects/:id/runs`, synchronous on
//    the API Lambda, 30 s budget there): the roadmap's risk row routes manual
//    runs through the job queue if this passes 10 s, here or scaled to the
//    Lambda's share of a vCPU (`onLambda`).
// 2. An automatic re-run through the worker (a `rerun` job in a tick, the
//    worker Lambda's budget is 300 s).
// 3. 30 simulated days of a daily feed (one new day merged, one tick, per
//    day) keep the project's stored runs flat: the manual runs, the published
//    run and one auto run, never an auto run per day.
//
// Its own vitest project (`perf-db`, vitest.config.ts): wall-clock budgets
// against Postgres, so out of `pnpm test` and CI. Run it alone:
// `pnpm test:backend:perf:db`. The measured figures are in
// docs/roadmap/step-2-shared-catchment.md § WP-2.16.
import { beforeAll, describe, expect, it } from 'vitest';
import { asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { runTick } from '../jobs/runner.js';

type User = Awaited<ReturnType<typeof signUp>>;

const FARMS = 60;
const DAYS = 3652; // ten years of daily rain
const START = '2014-10-01';
const SIM_DAYS = 30;
const MANUAL_BUDGET_MS = 10_000;
const AUTO_BUDGET_MS = 10_000;

let admin: User;
let pid: string;

const rainOn = (i: number) => (i % 9 === 0 ? 20 : i % 4 === 0 ? 3 : 0);

/** The project's stored runs: how many of each trigger, and their run_series bytes. */
async function storage() {
	const [row] = (await asOwner(
		`SELECT
			(SELECT count(*) FILTER (WHERE trigger = 'manual')::int FROM model_run WHERE project_id = $1) AS manual,
			(SELECT count(*) FILTER (WHERE trigger = 'auto')::int FROM model_run WHERE project_id = $1) AS auto,
			(SELECT count(*)::int FROM run_series WHERE project_id = $1) AS series,
			(SELECT coalesce(sum(pg_column_size(s.*)), 0)::bigint FROM run_series s WHERE project_id = $1) AS bytes`,
		[pid]
	)) as { manual: number; auto: number; series: number; bytes: string }[];
	return { ...row!, bytes: Number(row!.bytes) };
}

// The API and worker Lambdas run at 1024 MB (infra/variables.tf
// lambda_memory_mb, worker_memory_mb), and Lambda gives one full vCPU at
// 1769 MB, so they get ~0.58 of one. The calls here run in-process, so the
// Node CPU time they use (the engine, serialising the series) is the part that
// slows down there; the rest is Postgres, a separate machine (RDS) there too.
const LAMBDA_VCPU = 1024 / 1769;
const cpuMs = (u: NodeJS.CpuUsage) => (u.user + u.system) / 1000;
const onLambda = (wallMs: number, cpuUsedMs: number) => wallMs - cpuUsedMs + cpuUsedMs / LAMBDA_VCPU;

const mb = (b: number) => `${(b / 1024 / 1024).toFixed(1)} MB`;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

beforeAll(async () => {
	admin = await signUp('LoadAdmin');
	pid = (await admin.call('POST', '/projects', { name: 'Load catchment' })).body.project.id as string;
	const outlet = node('Outlet weir', null);
	const farms = Array.from({ length: FARMS }, (_, i) => node(`Farm ${i + 1}`, outlet.id, { sortOrder: i + 1, damCapacityM3: 20_000 + 1_000 * i }));
	const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.9) };
	const model = { nodes: [outlet, ...farms], crops: [crop], cropAreas: farms.map((f, i) => ({ nodeId: f.id, cropId: crop.id, areaM2: 50_000 + 1_000 * i })), transfers: [] };
	expect((await admin.call('PUT', `/projects/${pid}/model`, model)).status).toBe(200);
	expect((await admin.call('PATCH', `/projects/${pid}`, { settings: { apanMm: monthly(200), ewrPragmaticM3PerDay: monthly(5000) } })).status).toBe(200);
	const rain = Array.from({ length: DAYS }, (_, i) => rainOn(i));
	expect((await admin.call('PUT', `/projects/${pid}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: START, values: rain })).status).toBe(200);
}, 600_000);

describe('60-farm load checks (WP-2.16)', () => {
	it(`a manual run of ${FARMS} farms over ten years answers in under ${MANUAL_BUDGET_MS / 1000} s (median of 3)`, async () => {
		const ms: number[] = [];
		const cpu: number[] = [];
		let runId = '';
		for (let i = 0; i < 3; i++) {
			const t = performance.now();
			const c = process.cpuUsage();
			const res = await admin.call('POST', `/projects/${pid}/runs`, { label: `manual ${i + 1}` });
			ms.push(performance.now() - t);
			cpu.push(cpuMs(process.cpuUsage(c)));
			expect(res.status).toBe(201);
			runId = res.body.run.id;
		}
		const s = await storage();
		console.info(
			`manual run: median ${median(ms).toFixed(0)} ms (${ms.map((m) => m.toFixed(0)).join(', ')}), Node CPU median ${median(cpu).toFixed(0)} ms, ` +
				`on a ${LAMBDA_VCPU.toFixed(2)} vCPU Lambda ≈ ${onLambda(median(ms), median(cpu)).toFixed(0)} ms; ${s.series / 3} series and ${mb(s.bytes / 3)} per run`
		);
		expect(median(ms)).toBeLessThan(MANUAL_BUDGET_MS);
		expect(onLambda(median(ms), median(cpu))).toBeLessThan(MANUAL_BUDGET_MS);
		// The last one is the published baseline for the soak below.
		expect((await admin.call('POST', `/projects/${pid}/publication`, { runId })).status).toBe(201);
	}, 120_000);

	it(`${SIM_DAYS} simulated days of a daily feed: each auto run in the worker under ${AUTO_BUDGET_MS / 1000} s, storage flat`, async () => {
		expect((await admin.call('PATCH', `/projects/${pid}`, { settings: { autoRun: { enabled: true, debounceMinutes: 0 } } })).status).toBe(200);
		const tickMs: number[] = [];
		const tickCpu: number[] = [];
		const sizes: number[] = [];
		for (let d = 0; d < SIM_DAYS; d++) {
			const day = DAYS + d;
			const date = new Date(Date.UTC(2014, 9, 1) + day * 86_400_000).toISOString().slice(0, 10);
			const merged = await admin.call('POST', `/projects/${pid}/series/merge`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: date, values: [rainOn(day) || 1] });
			expect(merged.status).toBe(200);
			expect(merged.body.rerunQueuedFor).not.toBeNull();
			const t = performance.now();
			const c = process.cpuUsage();
			const tick = await runTick({ feeds: false, reports: false });
			tickMs.push(performance.now() - t);
			tickCpu.push(cpuMs(process.cpuUsage(c)));
			expect(tick.done).toBeGreaterThanOrEqual(1);
			expect(tick.failed + tick.dead).toBe(0);
			const s = await storage();
			sizes.push(s.bytes);
			// Three manual runs (one of them published) and one auto run, every day.
			expect({ manual: s.manual, auto: s.auto }).toEqual({ manual: 3, auto: 1 });
		}
		const db = ((await asOwner('SELECT pg_database_size(current_database())::bigint AS db')) as { db: string }[])[0]!.db;
		console.info(
			`auto run (tick): median ${median(tickMs).toFixed(0)} ms, max ${Math.max(...tickMs).toFixed(0)} ms, Node CPU median ${median(tickCpu).toFixed(0)} ms, ` +
				`on a ${LAMBDA_VCPU.toFixed(2)} vCPU Lambda ≈ ${onLambda(median(tickMs), median(tickCpu)).toFixed(0)} ms; ` +
				`project run_series day 1 ${mb(sizes[0]!)}, day ${SIM_DAYS} ${mb(sizes.at(-1)!)}; database ${mb(Number(db))}`
		);
		expect(median(tickMs)).toBeLessThan(AUTO_BUDGET_MS);
		expect(onLambda(median(tickMs), median(tickCpu))).toBeLessThan(AUTO_BUDGET_MS);
		// Flat: 30 more days on a ten-year record grow each run by < 1 %; an auto run per day would be 30×.
		expect(sizes.at(-1)!).toBeLessThan(sizes[0]! * 1.05);
	}, 600_000);
});
