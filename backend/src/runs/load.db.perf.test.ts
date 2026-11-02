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
// And the V1 demo's budget (docs/plan.md Phase 1 acceptance): a catchment the
// size of the client's runs in under 2 s including storage. The client data
// can't be committed (the repo is public), so the catchment here is invented
// at about the same shape, never its exact figures: an outlet gauge and a
// dozen units with dams on two tributaries, several crops on a couple of dozen
// planted areas, one transfer, and four daily records (rain, CHIRPS rain,
// gauge and logger flow) of 16 000 days, about four and a half decades.
// Measured through the same API call a user makes, which runs the
// engine and stores the run and its series before it answers.
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

describe('60-farm load checks (WP-2.16)', () => {
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

// A round span about as long as a client record (16 000 days from 1981-01-01
// end in October 2024), not the record's exact length.
const V1_DAYS = 16_000;
const V1_START = '1981-01-01';
const V1_BUDGET_MS = 2_000;
const V1_RUNS = 5;

describe('V1 demo budget (plan.md Phase 1 acceptance)', () => {
	let owner: User;
	let v1: string;

	beforeAll(async () => {
		owner = await signUp('V1Owner');
		v1 = (await owner.call('POST', '/projects', { name: 'V1-size catchment' })).body.project.id as string;
		// Two tributaries of six units each, joining at the outlet gauge.
		const outlet = node('Outlet gauge', null);
		const units: ReturnType<typeof node>[] = [];
		for (const arm of ['North', 'South']) {
			let below = outlet.id;
			for (let k = 6; k >= 1; k--) {
				const n = node(`${arm} ${k}`, below, { sortOrder: units.length + 1, areaKm2: 4 + k, damCapacityM3: 40_000 + 15_000 * k });
				units.push(n);
				below = n.id;
			}
		}
		const crops = Array.from({ length: 9 }, (_, c) => ({
			id: crypto.randomUUID(),
			name: `Crop ${c + 1}`,
			cropFactor: Array.from({ length: 12 }, (_, m) => 0.3 + 0.05 * c + 0.4 * Math.abs(Math.sin((m + c) / 3)))
		}));
		// 23 planted areas: every unit grows one crop, eleven a second.
		const cropAreas = units.flatMap((u, i) => {
			const first = { nodeId: u.id, cropId: crops[i % 9]!.id, areaM2: 80_000 + 7_000 * i };
			return i < 11 ? [first, { nodeId: u.id, cropId: crops[(i + 4) % 9]!.id, areaM2: 30_000 + 5_000 * i }] : [first];
		});
		const transfers = [
			{ id: crypto.randomUUID(), fromNodeId: units[0]!.id, toNodeId: units[6]!.id, months: [5, 6, 7, 8, 9, 10], maxRateM3s: 0.2, dailyCapM3: null, minStoragePct: 0.3, enabled: true, priority: 0 }
		];
		expect((await owner.call('PUT', `/projects/${v1}/model`, { nodes: [outlet, ...units], crops, cropAreas, transfers })).status).toBe(200);
		expect((await owner.call('PATCH', `/projects/${v1}`, { settings: { apanMm: monthly(180), ewrPragmaticM3PerDay: monthly(3000) } })).status).toBe(200);
		// Invented records: a seasonal rain pattern, CHIRPS a little off it, and
		// a flow that follows the rain with a recession.
		const rain = Array.from({ length: V1_DAYS }, (_, i) => (i % 7 === 0 ? 12 + (i % 23) : i % 5 === 0 ? 2 : 0) * (1 + 0.6 * Math.sin((2 * Math.PI * i) / 365.25)));
		const chirps = rain.map((r, i) => Math.max(0, r * 0.9 + (i % 11 === 0 ? 1.5 : 0)));
		let q = 0.4;
		const flow = rain.map((r) => (q = 0.93 * q + 0.02 * r));
		const logger = flow.map((f, i) => (i % 29 === 0 ? null : f * 1.05));
		for (const [kind, unit, values] of [
			['rain_catchment_mm', 'mm', rain],
			['rain_chirps_mm', 'mm', chirps],
			['flow_observed_m3s', 'm3/s', flow],
			['flow_logger_m3s', 'm3/s', logger]
		] as const) {
			expect((await owner.call('PUT', `/projects/${v1}/series`, { kind, unit, startDate: V1_START, values })).status).toBe(200);
		}
	}, 600_000);

	it(`a run of a client-sized catchment (a dozen units, ${V1_DAYS} days) finishes, stored, in under ${V1_BUDGET_MS / 1000} s (median of ${V1_RUNS})`, async () => {
		const ms: number[] = [];
		const cpu: number[] = [];
		for (let i = 0; i < V1_RUNS; i++) {
			const t = performance.now();
			const c = process.cpuUsage();
			const res = await owner.call('POST', `/projects/${v1}/runs`, { label: `v1 ${i + 1}` });
			ms.push(performance.now() - t);
			cpu.push(cpuMs(process.cpuUsage(c)));
			expect(res.status).toBe(201);
		}
		// Every run answered only once it was stored: its series are in the table.
		const [row] = (await asOwner(
			`SELECT count(DISTINCT r.id)::int AS runs, count(s.*)::int AS series, coalesce(sum(pg_column_size(s.*)), 0)::bigint AS bytes
			   FROM model_run r JOIN run_series s ON s.run_id = r.id WHERE r.project_id = $1`,
			[v1]
		)) as { runs: number; series: number; bytes: string }[];
		expect(row!.runs).toBe(V1_RUNS);
		console.info(
			`V1-size run: median ${median(ms).toFixed(0)} ms (${ms.map((m) => m.toFixed(0)).join(', ')}), Node CPU median ${median(cpu).toFixed(0)} ms, ` +
				`on a ${LAMBDA_VCPU.toFixed(2)} vCPU Lambda ≈ ${onLambda(median(ms), median(cpu)).toFixed(0)} ms (reported, not the criterion); ` +
				`${row!.series / V1_RUNS} series and ${mb(Number(row!.bytes) / V1_RUNS)} per run`
		);
		// The criterion is the local demo's (pnpm dev on a laptop), so the budget
		// is the measured wall clock here.
		expect(median(ms)).toBeLessThan(V1_BUDGET_MS);
	}, 120_000);
});
