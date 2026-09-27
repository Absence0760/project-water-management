// app_user under row-level security (068_app_user_rls.sql; docs/security.md
// § Accounts under RLS). Until 068 every water_app transaction could read
// and update every account. Now:
//
//   1. no user in the transaction (pre-sign-in, the job tick) and an API key
//      see no account and change none;
//   2. a signed-in person sees their own row and the people they work with
//      (a co-member, a team-mate, a removed member whose run is still
//      listed), not a stranger, and updates only their own row;
//   3. nobody inserts or deletes an account directly: sign-up is
//      app_register, deletion is the operator's;
//   4. the narrow SECURITY DEFINER lookups answer one account, and the
//      by-address one only to a signed-in caller;
//   5. every inner join to app_user in the backend's SQL is on a list, so a
//      new one (which would drop rows whose maker RLS hides) needs a decision.
//
// Every "cannot" has a positive control beside it.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { app, anon, asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { type Db, withApiKey, withoutUser, withUser } from '../db/tx.js';

type User = Awaited<ReturnType<typeof signUp>>;
const ORIGIN = 'http://localhost:7777';

let owner: User; // owns the project
let viewer: User; // a member of it
let leaver: User; // an editor who made a run, then was removed
let mate: User; // in a team with the owner, no project in common
let stranger: User; // shares nothing with anyone here
let projectId: string;
let keyId: string;

/** Run one statement in a savepoint and roll it back: rows it touched, or the refusal's code. */
async function attempt(db: Db, sql: string, params: unknown[] = []): Promise<number | string> {
	await db.query('SAVEPOINT attempt');
	try {
		return (await db.query(sql, params)).rowCount ?? 0;
	} catch (e) {
		return (e as { code?: string }).code ?? 'error';
	} finally {
		await db.query('ROLLBACK TO SAVEPOINT attempt');
	}
}

const visibleIds = (db: Db) => db.query<{ id: string }>('SELECT id FROM app_user').then((r) => new Set(r.rows.map((x) => x.id)));

beforeAll(async () => {
	owner = await signUp('Rlsowner');
	viewer = await signUp('Rlsviewer');
	leaver = await signUp('Rlsleaver');
	mate = await signUp('Rlsmate');
	stranger = await signUp('Rlsstranger');
	projectId = (await owner.call('POST', '/projects', { name: 'app_user RLS catchment' })).body.project.id;
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: leaver.email, role: 'editor' })).status).toBe(201);
	// A model the leaver can run.
	const outlet = node('Outlet', null);
	const farm = node('Farm', outlet.id);
	const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.8) };
	expect(
		(await owner.call('PUT', `/projects/${projectId}/model`, { nodes: [outlet, farm], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 10_000 }], transfers: [] })).status
	).toBe(200);
	expect((await owner.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(150) } })).status).toBe(200);
	const days = Array.from({ length: 30 }, (_, i) => (i % 5 === 0 ? 10 : 0));
	expect((await owner.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: days })).status).toBe(200);
	expect((await leaver.call('POST', `/projects/${projectId}/runs`, { label: 'Leaver run' })).status).toBe(201);
	expect((await owner.call('DELETE', `/projects/${projectId}/members/${leaver.id}`)).status).toBeLessThan(300);
	// A team the owner and the mate share, with no project.
	const teamId = (await owner.call('POST', '/teams', { name: 'RLS team' })).body.team.id;
	expect((await owner.call('POST', `/teams/${teamId}/members`, { email: mate.email, role: 'member' })).status).toBe(201);
	// The stranger has a project of their own, alone.
	expect((await stranger.call('POST', '/projects', { name: 'Stranger catchment' })).status).toBe(201);
	const key = await owner.call('POST', `/projects/${projectId}/api-keys`, { name: 'RLS key' });
	expect(key.status).toBe(201);
	keyId = key.body.key.id;
}, 60_000);

describe('without a signed-in person', () => {
	it('shows no account and changes none, with no user (positive control: the owner role sees them all)', async () => {
		const [{ n }] = await asOwner('SELECT count(*)::int AS n FROM app_user WHERE id = ANY($1::uuid[])', [[owner.id, viewer.id, stranger.id]]);
		expect(n).toBe(3);
		await withoutUser(async (db) => {
			expect((await visibleIds(db)).size).toBe(0);
			expect(await attempt(db, "UPDATE app_user SET display_name = 'x'")).toBe(0);
		});
	});

	it('shows no account and changes none, as an API key (positive control: the key context is live, on its project)', async () => {
		await withApiKey(keyId, async (db) => {
			expect((await visibleIds(db)).size).toBe(0);
			expect(await attempt(db, "UPDATE app_user SET display_name = 'x'")).toBe(0);
			const { rows } = await db.query("SELECT app_current_api_key_id() AS k, app_api_key_project('series:write') AS p");
			expect(rows[0]).toEqual({ k: keyId, p: projectId });
		});
	});
});

describe('signed in', () => {
	it('sees their own row and the people they work with, never a stranger', async () => {
		const seen = await withUser(owner.id, visibleIds);
		expect([owner.id, viewer.id, leaver.id, mate.id].filter((id) => !seen.has(id))).toEqual([]);
		expect(seen.has(stranger.id)).toBe(false);
		// And the other way: the stranger sees only themself.
		expect([...(await withUser(stranger.id, visibleIds))]).toEqual([stranger.id]);
		// A viewer sees the project's people, not the owner's team-mate.
		const viewerSees = await withUser(viewer.id, visibleIds);
		expect(viewerSees.has(owner.id)).toBe(true);
		expect(viewerSees.has(mate.id)).toBe(false);
	});

	it('keeps a removed member’s run in the list, with their name (the inner join to its maker)', async () => {
		const runs = (await owner.call('GET', `/projects/${projectId}/runs`)).body.runs as { label: string; createdBy: string }[];
		expect(runs.map((r) => [r.label, r.createdBy])).toEqual([['Leaver run', 'Rlsleaver']]);
	});

	it('updates only their own row', async () => {
		await withUser(owner.id, async (db) => {
			expect(await attempt(db, 'UPDATE app_user SET display_name = display_name WHERE id = $1', [owner.id])).toBe(1);
			// A co-member they can see is still not theirs to change.
			expect(await attempt(db, 'UPDATE app_user SET display_name = display_name WHERE id = $1', [viewer.id])).toBe(0);
			expect(await attempt(db, "UPDATE app_user SET password_hash = 'x' WHERE id <> $1", [owner.id])).toBe(0);
		});
	});

	it('can neither insert nor delete an account directly (positive control: app_register can sign up)', async () => {
		await withUser(owner.id, async (db) => {
			expect(await attempt(db, "INSERT INTO app_user (email, display_name, password_hash) VALUES ('direct@example.com', 'D', 'x')")).toBe('42501');
			expect(await attempt(db, 'DELETE FROM app_user WHERE id = $1', [owner.id])).toBe('42501');
		});
		await withoutUser(async (db) => {
			expect(await attempt(db, "INSERT INTO app_user (email, display_name, password_hash) VALUES ('direct@example.com', 'D', 'x')")).toBe('42501');
			const { rows } = await db.query<{ id: string | null }>("SELECT app_register($1, 'Registered', 'x', NULL) AS id", [`reg-${crypto.randomUUID()}@example.com`]);
			expect(rows[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
			// A taken address: no second account, no error to tell apart.
			const { rows: again } = await db.query<{ id: string | null }>("SELECT app_register($1, 'Again', 'x', NULL) AS id", [owner.email]);
			expect(again[0]!.id).toBeNull();
		});
	});
});

describe('the SECURITY DEFINER lookups', () => {
	it('answer one account by address or id, whoever asks', async () => {
		await withoutUser(async (db) => {
			const { rows } = await db.query('SELECT id, email FROM app_auth_account($1)', [stranger.email]);
			expect(rows).toEqual([{ id: stranger.id, email: stranger.email }]);
			expect((await db.query('SELECT 1 FROM app_auth_account($1)', ['nobody@example.com'])).rows).toEqual([]);
			expect((await db.query('SELECT 1 FROM app_session_revoked_at($1)', [stranger.id])).rows).toHaveLength(1);
		});
	});

	it('find accounts by address only for a signed-in caller', async () => {
		const sql = 'SELECT id FROM app_user_by_email($1::citext[])';
		expect(await withoutUser(async (db) => (await db.query(sql, [[stranger.email]])).rows)).toEqual([]);
		expect(await withApiKey(keyId, async (db) => (await db.query(sql, [[stranger.email]])).rows)).toEqual([]);
		// Positive control: the owner adding someone they don't know yet finds them.
		expect(await withUser(owner.id, async (db) => (await db.query(sql, [[stranger.email]])).rows)).toEqual([{ id: stranger.id }]);
	});

	it('still let every auth flow through (sign-in, forgot, the session check, adding a stranger)', async () => {
		const login = await anon('POST', '/auth/login', { email: stranger.email, password: 'correct horse' });
		expect(login.status).toBe(200);
		expect(login.body.user.id).toBe(stranger.id);
		expect((await anon('POST', '/auth/forgot-password', { email: stranger.email })).status).toBe(202);
		const me = await app.request('/auth/me', { headers: { cookie: stranger.cookie, origin: ORIGIN } });
		expect(me.status).toBe(200);
		const added = await owner.call('POST', `/projects/${projectId}/members`, { email: stranger.email, role: 'viewer' });
		expect(added.status).toBe(201);
		expect((await withUser(owner.id, visibleIds)).has(stranger.id)).toBe(true);
	});
});

// The backend's SQL that inner-joins app_user, each with why its account is
// always visible to whoever runs it (app_user_visible, 068). An inner join to
// an account RLS hides drops the whole row, so a new one needs a decision
// here: a LEFT JOIN, or a case app_user_visible covers.
const INNER_JOINS = new Map<string, string>([
	['projects/routes.ts JOIN app_user u ON u.id = m.user_id', 'current project members'],
	['projects/importReport.ts JOIN app_user u ON u.id = i.imported_by', 'project_import.imported_by is in app_user_visible'],
	['farms/routes.ts JOIN app_user u ON u.id = m.user_id', 'current project members'],
	['farms/routes.ts JOIN app_user u ON u.id = i.invited_by', 'invite.invited_by is in app_user_visible'],
	['history/record.ts JOIN app_user u ON u.id = fl.user_id', 'a linked farmer is a current member'],
	['history/record.ts JOIN app_user u ON u.id = m.user_id', 'current project members'],
	['compare/routes.ts JOIN app_user u ON u.id = r.created_by', 'model_run.created_by is in app_user_visible'],
	['teams/routes.ts JOIN app_user u ON u.id = m.user_id', 'current team members'],
	['scenarios/execute.ts JOIN app_user mu ON mu.id = m.user_id', 'scenario_member.user_id is in app_user_visible'],
	['scenarios/execute.ts JOIN app_user u ON u.id = s.owner_user_id', 'scenario.owner_user_id is in app_user_visible'],
	['runs/routes.ts JOIN app_user u ON u.id = r.created_by', 'model_run.created_by is in app_user_visible'],
	['runs/uncertainty.ts JOIN app_user au ON au.id = u.created_by', 'run_uncertainty.created_by is in app_user_visible'],
	['reports/routes.ts JOIN app_user ru ON ru.id = r.user_id', 'a schedule recipient is a current member'],
	['reports/store.ts JOIN app_user u ON u.id = m.user_id', 'current project members'],
	['reports/store.ts JOIN app_user u ON u.id = $3', 'the requester, whose job transaction this is'],
	['jobs/queue.ts JOIN app_user u ON u.id = j.acting_user_id', 'job.acting_user_id is in app_user_visible'],
	['invites/invites.ts JOIN app_user u ON u.id = i.invited_by', 'invite.invited_by is in app_user_visible']
]);

describe('inner joins to app_user', () => {
	it('are each on the list, and the list has nothing stale', () => {
		const src = fileURLToPath(new URL('..', import.meta.url));
		const files: string[] = [];
		const walk = (dir: string) => {
			for (const f of readdirSync(dir)) {
				const p = join(dir, f);
				if (statSync(p).isDirectory()) walk(p);
				else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) files.push(p);
			}
		};
		walk(src);
		const found = new Set<string>();
		for (const f of files) {
			for (const m of readFileSync(f, 'utf8').matchAll(/(?<!LEFT\s+)\bJOIN\s+app_user\s+(\w+)\s+ON\s+([\w.$]+\s*=\s*[\w.$]+)/g)) {
				found.add(`${relative(src, f)} JOIN app_user ${m[1]} ON ${m[2]!.replace(/\s+/g, ' ')}`);
			}
		}
		// Not vacuous: the scan finds the run list's join.
		expect(found.has('runs/routes.ts JOIN app_user u ON u.id = r.created_by')).toBe(true);
		expect([...found].filter((j) => !INNER_JOINS.has(j))).toEqual([]);
		expect([...INNER_JOINS.keys()].filter((j) => !found.has(j))).toEqual([]);
	});
});
