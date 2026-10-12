// Wall-clock budget for reading a project's allocations at the cap
// (ALLOCATIONS_PER_PROJECT_MAX, 5,000 rows), as each reader the one rule
// admits (231's app_user_reads_allocation_units; docs/allocations.md § Who
// sees what): an editor, a viewer while the owners let viewers read each
// volume, and a member acting for the responsible authority (#523 G6).
//
// 231's policies called the rule once per row (a SQL definer around a
// plpgsql invoker, none inlinable): 557 ms for an editor's 5,000 rows on the
// round 6 reviewer's machine, against 397 ms for 162's policy. 235 asks once
// per query (`project_id IN (SELECT p.id FROM project p WHERE …)`): 93 ms
// there. The budget sits between the two, so it trips on a policy that is
// per-row again, not on a slow laptop. The holder names (allocation_holder,
// the editor's and the authority's) under the same budget.
//
// Its own vitest project (`perf-db`, vitest.config.ts): a timing budget, so
// out of `pnpm test` and CI. Run it alone: `pnpm test:backend:perf:db`.
import { beforeAll, describe, expect, it } from 'vitest';
import { actForAuthority, asOwner, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { ALLOCATIONS_PER_PROJECT_MAX } from './routes.js';

type User = Awaited<ReturnType<typeof signUp>>;

const SAMPLES = 7;
const BUDGET_MS = 250;

let owner: User;
let editor: User;
let viewer: User;
let assessor: User;
let projectId: string;

/** Median wall time of reading every allocation (or holder) row of the project as `u`, and the row count. */
async function median(u: User, table: 'allocation' | 'allocation_holder'): Promise<{ ms: number; n: number }> {
	return withUser(u.id, async (db) => {
		const sql = `SELECT * FROM ${table} WHERE project_id = $1`;
		await db.query(sql, [projectId]); // warm the plan and the cache
		const ms: number[] = [];
		let n = 0;
		for (let i = 0; i < SAMPLES; i++) {
			const t = performance.now();
			n = (await db.query(sql, [projectId])).rowCount ?? 0;
			ms.push(performance.now() - t);
		}
		ms.sort((a, b) => a - b);
		return { ms: ms[SAMPLES >> 1]!, n };
	});
}

beforeAll(async () => {
	[owner, editor, viewer, assessor] = (await Promise.all(['APowner', 'APeditor', 'APviewer', 'APassessor'].map((n) => signUp(n)))) as [User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Allocations perf' })).body.project.id;
	for (const [u, role] of [
		[editor, 'editor'],
		[viewer, 'viewer'],
		[assessor, 'editor']
	] as const)
		expect((await owner.call('POST', `/projects/${projectId}/members`, { email: u.email, role })).status).toBe(201);
	await actForAuthority(owner, projectId, assessor.id);
	// The cap, at once: the route would take 5,000 requests.
	await asOwner(
		`WITH a AS (
			INSERT INTO allocation (project_id, registration_no, authorisation, water_source, volume_m3_year)
			SELECT $1, 'P-' || i, 'registration', 'surface', 1000 + i FROM generate_series(1, $2) i
			RETURNING id, project_id, registration_no
		)
		INSERT INTO allocation_holder (allocation_id, project_id, user_display) SELECT id, project_id, 'Holder ' || registration_no FROM a`,
		[projectId, ALLOCATIONS_PER_PROJECT_MAX]
	);
	await asOwner('ANALYZE allocation, allocation_holder');
	expect((await owner.call('PUT', `/projects/${projectId}/allocations/viewer-units`, { on: true })).status).toBe(200);
}, 120_000);

describe(`reading ${ALLOCATIONS_PER_PROJECT_MAX} allocations (median of ${SAMPLES}, budget ${BUDGET_MS} ms)`, () => {
	it('as an editor, a viewer with the switch on and the authority’s member: every row, within the budget', async () => {
		for (const [who, u] of [
			['editor', editor],
			['viewer, switch on', viewer],
			['authority member', assessor]
		] as const) {
			const { ms, n } = await median(u, 'allocation');
			console.info(`allocation × ${n}, ${who}: ${ms.toFixed(1)} ms`);
			expect(n, who).toBe(ALLOCATIONS_PER_PROJECT_MAX);
			expect(ms, who).toBeLessThan(BUDGET_MS);
		}
	});

	it('the holders’ names as an editor and the authority’s member, within the budget (a viewer reads none)', async () => {
		for (const [who, u] of [
			['editor', editor],
			['authority member', assessor]
		] as const) {
			const { ms, n } = await median(u, 'allocation_holder');
			console.info(`allocation_holder × ${n}, ${who}: ${ms.toFixed(1)} ms`);
			expect(n, who).toBe(ALLOCATIONS_PER_PROJECT_MAX);
			expect(ms, who).toBeLessThan(BUDGET_MS);
		}
		expect((await median(viewer, 'allocation_holder')).n).toBe(0);
	});
});
