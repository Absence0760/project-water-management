// Two owners of a project (two admins of a team) giving it up at the same
// moment must not leave it with none (migration 149_last_owner_lock;
// docs/security.md § Authorization, "The last owner"; docs/data-model.md §
// Roles). Each change checks "is someone else still an owner?" before it
// goes; without a lock, both read the other as still there (their change
// isn't committed yet), both pass, and both commit.
//
// Two layers, each tested on its own race:
//  * the member routes lock the project's owner rows (the team's admin rows)
//    before their 409 check, so the second change waits for the first and
//    then sees it (assertNotLastOwner, assertNotLastAdmin);
//  * the deferred project_member_keep_owner and team_member_keep_admin
//    triggers take a per-project (per-team) advisory lock before counting, so the second
//    commit re-reads after the first: the backstop for every other path,
//    the operator deleting app_user rows among them.
//
// The interleaving is forced, not left to timing: a third connection holds
// the owner rows, both requests queue behind it (waited on through
// pg_stat_activity, a real signal), and only then is it released.
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';

type User = Awaited<ReturnType<typeof signUp>>;
const tag = crypto.randomUUID().slice(0, 8);
const ownerUrl = () => process.env.TEST_MIGRATION_DATABASE_URL;

const open: pg.Client[] = [];
async function ownerClient(): Promise<pg.Client> {
	const c = new pg.Client({ connectionString: ownerUrl() });
	await c.connect();
	open.push(c);
	return c;
}
afterEach(async () => {
	for (const c of open.splice(0)) await c.end().catch(() => undefined);
});

/** Wait until `n` sessions of this database are waiting on a lock (the requests are queued behind the blocker). */
async function waitForLockWaiters(monitor: pg.Client, n: number): Promise<void> {
	for (let i = 0; i < 1000; i++) {
		const { rows } = await monitor.query<{ n: number }>(
			`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`
		);
		if (rows[0]!.n >= n) return;
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error(`never saw ${n} sessions waiting on a lock`);
}

/**
 * Hold `sql`'s rows (FOR UPDATE, as the schema owner) while `run` starts two
 * changes, wait until both are queued behind the hold, release it, and return
 * what the two changes answered.
 */
async function race<T>(holdSql: string, params: unknown[], run: () => [Promise<T>, Promise<T>]): Promise<[T, T]> {
	const blocker = await ownerClient();
	const monitor = await ownerClient();
	await blocker.query('BEGIN');
	const held = await blocker.query(holdSql, params);
	expect(held.rowCount).toBe(2);
	const both = run();
	await waitForLockWaiters(monitor, 2);
	await blocker.query('ROLLBACK');
	return Promise.all(both);
}

const owners = async (pid: string) =>
	(await asOwner(`SELECT user_id FROM project_member WHERE project_id = $1 AND role = 'owner'`, [pid])).map((r) => r.user_id as string);
const admins = async (tid: string) =>
	(await asOwner(`SELECT user_id FROM team_member WHERE team_id = $1 AND role = 'admin'`, [tid])).map((r) => r.user_id as string);

async function coOwnedProject(name: string): Promise<{ a: User; b: User; pid: string }> {
	const [a, b] = (await Promise.all([`${name}A`, `${name}B`].map((n) => signUp(n)))) as [User, User];
	const pid = (await a.call('POST', '/projects', { name: `${name} ${tag}` })).body.project.id as string;
	expect((await a.call('POST', `/projects/${pid}/members`, { email: b.email, role: 'owner' })).status).toBe(201);
	expect((await owners(pid)).sort()).toEqual([a.id, b.id].sort());
	return { a, b, pid };
}

async function coAdminedTeam(name: string): Promise<{ a: User; b: User; tid: string }> {
	const [a, b] = (await Promise.all([`${name}A`, `${name}B`].map((n) => signUp(n)))) as [User, User];
	const tid = (await a.call('POST', '/teams', { name: `${name} ${tag}` })).body.team.id as string;
	expect((await a.call('POST', `/teams/${tid}/members`, { email: b.email, role: 'admin' })).status).toBe(201);
	expect((await admins(tid)).sort()).toEqual([a.id, b.id].sort());
	return { a, b, tid };
}

const HOLD_OWNERS = `SELECT 1 FROM project_member WHERE project_id = $1 AND role = 'owner' FOR UPDATE`;
const HOLD_ADMINS = `SELECT 1 FROM team_member WHERE team_id = $1 AND role = 'admin' FOR UPDATE`;

describe('the last owner of a project, two at once', () => {
	it('positive control: an owner leaves when another owner stays', async () => {
		const { a, b, pid } = await coOwnedProject('OwnLeave');
		expect((await a.call('DELETE', `/projects/${pid}/members/${a.id}`)).status).toBe(204);
		expect(await owners(pid)).toEqual([b.id]);
	});

	it('two owners leaving at the same moment: one goes, the other gets the 409, and an owner remains', async () => {
		const { a, b, pid } = await coOwnedProject('OwnTwin');
		const results = await race(HOLD_OWNERS, [pid], () => [
			a.call('DELETE', `/projects/${pid}/members/${a.id}`),
			b.call('DELETE', `/projects/${pid}/members/${b.id}`)
		]);
		expect(results.map((r) => r.status).sort()).toEqual([204, 409]);
		// The route's own refusal, not the deferred trigger's generic one at commit.
		expect(results.find((r) => r.status === 409)!.body.error).toBe('a project must keep at least one owner');
		expect(await owners(pid)).toHaveLength(1);
	});

	it('two owners demoting each other at the same moment: one change lands, and an owner remains', async () => {
		const { a, b, pid } = await coOwnedProject('OwnDemote');
		const results = await race(HOLD_OWNERS, [pid], () => [
			a.call('PATCH', `/projects/${pid}/members/${b.id}`, { role: 'editor' }),
			b.call('PATCH', `/projects/${pid}/members/${a.id}`, { role: 'editor' })
		]);
		// The second sees the first: either the last-owner 409, or (when it
		// was the first that demoted it) it is no longer an owner at all.
		expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
		expect(await owners(pid)).toHaveLength(1);
	});
});

describe('the last admin of a team, two at once', () => {
	it('positive control: an admin leaves when another admin stays', async () => {
		const { a, b, tid } = await coAdminedTeam('AdmLeave');
		expect((await a.call('DELETE', `/teams/${tid}/members/${a.id}`)).status).toBe(204);
		expect(await admins(tid)).toEqual([b.id]);
	});

	it('two admins leaving at the same moment: one goes, the other gets the 409, and an admin remains', async () => {
		const { a, b, tid } = await coAdminedTeam('AdmTwin');
		const results = await race(HOLD_ADMINS, [tid], () => [
			a.call('DELETE', `/teams/${tid}/members/${a.id}`),
			b.call('DELETE', `/teams/${tid}/members/${b.id}`)
		]);
		expect(results.map((r) => r.status).sort()).toEqual([204, 409]);
		expect(results.find((r) => r.status === 409)!.body.error).toBe('a team must keep at least one owner');
		expect(await admins(tid)).toHaveLength(1);
	});
});

describe('the keep-owner and keep-admin triggers, two deletions at once (the operator path)', () => {
	// Two transactions, each taking one co-owner's membership away: what two
	// operator sessions deleting their app_user rows do through the cascade,
	// or any path that skips the routes' check. (The membership rows
	// themselves, not the accounts: deleting an account also pseudonymises
	// the audit events naming it, and the co-owners' shared "added" event
	// would make the second deletion wait on that row, hiding the race.)
	// The deferred check runs at COMMIT, so the window is two commits whose
	// checks both run before either has committed; SET CONSTRAINTS ALL
	// IMMEDIATE (as DELETE /auth/me does) opens it wide and deterministically:
	// each check runs at its DELETE, both before either commits. The second
	// must wait for the first and re-read, and refuse.
	async function bothDeleted(table: 'project_member' | 'team_member', key: string, id: string, a: User, b: User): Promise<[unknown, unknown]> {
		const del = `DELETE FROM ${table} WHERE ${key} = $1 AND user_id = $2`;
		const [one, two] = [await ownerClient(), await ownerClient()];
		for (const c of [one, two]) {
			await c.query('BEGIN');
			await c.query('SET CONSTRAINTS ALL IMMEDIATE');
		}
		await one.query(del, [id, a.id]);
		// Not awaited yet: with the lock it waits for `one` to finish.
		const secondDelete = two.query(del, [id, b.id]);
		const outcome = (p: Promise<unknown>) =>
			p.then(
				() => 'committed',
				(e: { code?: string }) => e.code
			);
		const first = await outcome(one.query('COMMIT'));
		const second = await outcome(secondDelete.then(() => two.query('COMMIT')));
		return [first, second];
	}

	it('positive control: deleting one co-owner and co-admin commits, and the other keeps the project and team', async () => {
		const { a, b, pid } = await coOwnedProject('OpOne');
		const tid = (await a.call('POST', '/teams', { name: `OpOne team ${tag}` })).body.team.id as string;
		expect((await a.call('POST', `/teams/${tid}/members`, { email: b.email, role: 'admin' })).status).toBe(201);
		await asOwner('DELETE FROM app_user WHERE id = $1', [a.id]);
		expect(await owners(pid)).toEqual([b.id]);
		expect(await admins(tid)).toEqual([b.id]);
	});

	it('refuses the second commit of a project’s two owners', async () => {
		const { a, b, pid } = await coOwnedProject('OpOwn');
		expect(await bothDeleted('project_member', 'project_id', pid, a, b)).toEqual(['committed', '23514']);
		expect(await owners(pid)).toEqual([b.id]);
	});

	it('refuses the second commit of a team’s two admins', async () => {
		const { a, b, tid } = await coAdminedTeam('OpAdm');
		expect(await bothDeleted('team_member', 'team_id', tid, a, b)).toEqual(['committed', '23514']);
		expect(await admins(tid)).toEqual([b.id]);
	});
});
