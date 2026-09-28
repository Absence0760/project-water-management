// Wall-clock budget for the team portfolio (WP-2.14, docs/api.md § Portfolio):
// one query over every catchment of a team. The acceptance criterion is 500 ms
// for 10 catchments of 60 farms; it measured a median 51 ms when it was built,
// so this guard trips on a regression of the query's shape (a new join or a
// per-row subquery over a run's series), not on a slow laptop.
//
// Its own vitest project (`perf-db`, vitest.config.ts): a timing budget,
// so out of `pnpm test` and CI, and against Postgres, so with the db
// project's global setup. Run it alone: `pnpm test:backend:perf:db`.
import { beforeAll, describe, expect, it } from 'vitest';
import { app, monthly, node, signUp } from '../__tests__/helpers.js';

type User = Awaited<ReturnType<typeof signUp>>;

const CATCHMENTS = 10;
const FARMS = 60;
const DAYS = 3652; // ten years of daily rain
const BUDGET_MS = 500;

let admin: User;
let teamId: string;

/** A published catchment: the outlet, FARMS farms under it, ten years of rain, one run. */
async function publishedCatchment(): Promise<string> {
	const id = (await admin.call('POST', '/projects', { name: 'Perf catchment 1', teamId })).body.project.id as string;
	const outlet = node('Outlet weir', null);
	const farms = Array.from({ length: FARMS }, (_, i) => node(`Farm ${i + 1}`, outlet.id, { sortOrder: i + 1, damCapacityM3: 20_000 + 1_000 * i }));
	const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.9) };
	const model = { nodes: [outlet, ...farms], crops: [crop], cropAreas: farms.map((f, i) => ({ nodeId: f.id, cropId: crop.id, areaM2: 50_000 + 1_000 * i })), transfers: [] };
	expect((await admin.call('PUT', `/projects/${id}/model`, model)).status).toBe(200);
	expect((await admin.call('PATCH', `/projects/${id}`, { settings: { apanMm: monthly(200), ewrPragmaticM3PerDay: monthly(5000) } })).status).toBe(200);
	const rain = Array.from({ length: DAYS }, (_, i) => (i % 9 === 0 ? 20 : i % 4 === 0 ? 3 : 0));
	expect((await admin.call('PUT', `/projects/${id}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2014-10-01', values: rain })).status).toBe(200);
	return id;
}

async function runAndPublish(projectId: string) {
	const run = await admin.call('POST', `/projects/${projectId}/runs`, { label: 'perf' });
	expect(run.status).toBe(201);
	expect((await admin.call('POST', `/projects/${projectId}/publication`, { runId: run.body.run.id })).status).toBe(201);
}

beforeAll(async () => {
	admin = await signUp('PerfAdmin');
	teamId = (await admin.call('POST', '/teams', { name: 'Perf WUA' })).body.team.id;
	const first = await publishedCatchment();
	// The rest are copies (same model and series, fresh ids), each with its own run and publication.
	const ids = [first];
	for (let i = 2; i <= CATCHMENTS; i++) {
		const copy = await admin.call('POST', `/projects/${first}/copy`, { name: `Perf catchment ${i}` });
		expect(copy.status).toBe(201);
		ids.push(copy.body.project.id);
	}
	for (const id of ids) await runAndPublish(id);
}, 600_000);

describe('portfolio query performance', () => {
	it(`answers ${CATCHMENTS} published catchments of ${FARMS} farms in under ${BUDGET_MS} ms (median of 7)`, async () => {
		const call = async () => {
			const t = performance.now();
			const res = await app.request(`/teams/${teamId}/portfolio`, { headers: { cookie: admin.cookie, origin: 'http://localhost:7777' } });
			const body = (await res.json()) as { projects: { source: string; farmCount: number }[] };
			const ms = performance.now() - t;
			expect(res.status).toBe(200);
			return { ms, body };
		};
		// The fixture is what the budget is about: every catchment published, with all its farms.
		const { body } = await call(); // warm-up
		expect(body.projects).toHaveLength(CATCHMENTS);
		for (const p of body.projects) expect(p).toMatchObject({ source: 'published', farmCount: FARMS });

		const ms: number[] = [];
		for (let i = 0; i < 7; i++) ms.push((await call()).ms);
		ms.sort((a, b) => a - b);
		console.info(`portfolio: median ${ms[3]!.toFixed(1)} ms, min ${ms[0]!.toFixed(1)}, max ${ms[6]!.toFixed(1)} (${CATCHMENTS} × ${FARMS} farms)`);
		expect(ms[3]).toBeLessThan(BUDGET_MS);
	});
});
