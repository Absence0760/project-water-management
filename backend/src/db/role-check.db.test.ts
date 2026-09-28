// The role check every RLS policy makes (app_has_role → app_project_role),
// in a session with no user: an API key's (withApiKey) or the job queue's
// (withoutUser). Such a session holds no role, and app_project_role answers
// NULL before its role query (094_role_check_no_user.sql). Its cost, the
// reason for that early return, is guarded in role-check.db.perf.test.ts.
import { beforeAll, describe, expect, it } from 'vitest';
import { signUp } from '../__tests__/helpers.js';
import { type Db, withApiKey, withoutUser, withUser } from './tx.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let projectId: string;

async function check(db: Db) {
	const { rows } = await db.query(`SELECT app_project_role($1)::text AS role, app_has_role($1, 'viewer') AS viewer`, [projectId]);
	return rows[0] as { role: string | null; viewer: boolean };
}

beforeAll(async () => {
	owner = await signUp('Rolecheck');
	projectId = (await owner.call('POST', '/projects', { name: 'Role check catchment' })).body.project.id;
});

describe('the role check in a session with no user', () => {
	it('finds no role (positive control: the owner’s session finds owner)', async () => {
		expect(await withUser(owner.id, check)).toEqual({ role: 'owner', viewer: true });
		expect(await withoutUser(check)).toEqual({ role: null, viewer: false });
	});

	it('an empty user id counts as no user', async () => {
		const empty = await withoutUser(async (db) => {
			await db.query("SELECT set_config('app.current_user_id', '', true)");
			return check(db);
		});
		expect(empty).toEqual({ role: null, viewer: false });
	});

	it('nor does an API key of the project hold a role in it', async () => {
		const r = await owner.call('POST', `/projects/${projectId}/api-keys`, { name: 'Role check key' });
		expect(r.status).toBe(201);
		expect(await withApiKey(r.body.key.id, check)).toEqual({ role: null, viewer: false });
	});
});
