// Cost of the role check every RLS policy makes once per row it filters
// (app_has_role → app_project_role) in a session with no user, an API key's
// or the job queue's (092_role_check_no_user.sql).
//
// PL/pgSQL runs app_project_role's role query through the plan cache: a
// custom plan for each of the first five calls, and after that the generic
// plan only if it costs no more than the custom plans did on average. With
// uid NULL each custom plan folds `user_id = NULL` to false and costs next to
// nothing, so the generic plan never wins and the query is planned again on
// every call. Before 092 that cost ~150 us a call, where the cached generic
// plan costs a few; a key's statement over a 6,500-row table spent a second
// on role checks, and the ingest key sweep (ingest.security.db.test.ts) timed
// out in CI. Returning before the query when there is no user leaves only
// the function calls.
//
// The guard compares two timings taken on the same connection in the same
// run, so a slow laptop moves both sides: before 092 the no-user check cost
// ~300 times a bare app_current_user_id() call.
//
// Its own vitest project (`perf-db`, vitest.config.ts), with the portfolio's:
// a timing claim, so out of `pnpm test` and CI. Run it alone:
// `pnpm test:backend:perf:db`.
import pg from 'pg';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { signUp } from '../__tests__/helpers.js';
import { type Db, withoutUser, withUser } from './tx.js';

const CALLS = 5_000;
const SAMPLES = 7;

let ownerId: string;
let projectId: string;
const open: pg.Client[] = [];

/** A new connection as water_app (the pool's role) with no user, so its plan cache starts empty. */
async function session(): Promise<pg.Client> {
	const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
	await c.connect();
	open.push(c);
	return c;
}

/** Median wall time of CALLS evaluations of `expr` (with $1 = the project) in one statement. */
async function median(c: pg.Client, expr: string): Promise<number> {
	const sql = `SELECT count(*) FILTER (WHERE ${expr}) FROM generate_series(1, $2)`;
	const ms: number[] = [];
	for (let i = 0; i < SAMPLES; i++) {
		const t = performance.now();
		await c.query(sql, [projectId, CALLS]);
		ms.push(performance.now() - t);
	}
	ms.sort((a, b) => a - b);
	return ms[SAMPLES >> 1]!;
}

const HAS_ROLE = `app_has_role($1, 'viewer')`;

beforeAll(async () => {
	const owner = await signUp('Roleperf');
	ownerId = owner.id;
	projectId = (await owner.call('POST', '/projects', { name: 'Role perf catchment' })).body.project.id;
});

afterEach(async () => {
	await Promise.all(open.splice(0).map((c) => c.end()));
});

describe('role check cost', () => {
	it(`with no user costs a few plain function calls, not a plan each (${CALLS} calls, median of ${SAMPLES})`, async () => {
		// Positive control (on the pool, not the timed connection): the owner has the role, no user hasn't.
		const hasRole = (db: Db) => db.query(`SELECT ${HAS_ROLE} AS ok`, [projectId]).then((r) => r.rows[0].ok as boolean);
		expect(await withUser(ownerId, hasRole)).toBe(true);
		expect(await withoutUser(hasRole)).toBe(false);
		const c = await session();
		const check = await median(c, HAS_ROLE);
		const bare = await median(c, `$1::uuid IS NOT NULL AND app_current_user_id() IS NULL`);
		console.info(`role check × ${CALLS}, no user: ${check.toFixed(1)} ms; bare app_current_user_id(): ${bare.toFixed(1)} ms`);
		// app_has_role → app_project_role → app_current_user_id: three calls, and a margin.
		expect(check).toBeLessThan(20 * bare);
	});

});
