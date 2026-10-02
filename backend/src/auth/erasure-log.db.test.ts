// The erasure log (159_erasure_log.sql): every deleted account, project and
// team leaves its internal id, so a database restore can re-apply erasures
// made after its restore point (docs/deployment.md § Restoring the database,
// step 6a). Both account-deletion paths write it (the operator's SQL and
// DELETE /auth/me), water_app can neither read nor write it, and the tick
// keeps an entry 40 days, longer than any backup (35).
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { app, asOwner, signUp } from '../__tests__/helpers.js';
import { withoutUser, withUser } from '../db/tx.js';
import { ERASURE_LOG_RETENTION_DAYS, runTick } from '../jobs/runner.js';

type User = Awaited<ReturnType<typeof signUp>>;

const logged = async (kind: string, id: string) => (await asOwner('SELECT erased_at FROM erasure_log WHERE kind = $1 AND subject_id = $2', [kind, id])).length;
const purge = (days: number) => withoutUser(async (db) => (await db.query<{ n: number }>('SELECT app_purge_erasure_log(make_interval(days => $1)) AS n', [days])).rows[0]!.n);

let owner: User;
beforeAll(async () => {
	owner = await signUp('ElOwner');
});
afterEach(() => vi.restoreAllMocks());

describe('erasure_log (159)', () => {
	it('records an account deleted by the operator, as the schema owner', async () => {
		const gone = await signUp('ElOperatorPath');
		expect(await logged('account', gone.id)).toBe(0);
		await asOwner('DELETE FROM app_user WHERE id = $1', [gone.id]);
		expect(await logged('account', gone.id)).toBe(1);
	});

	it('records an account deleted by its holder (DELETE /auth/me), whose log line carries the id only', async () => {
		const gone = await signUp('ElSelfPath');
		const info = vi.spyOn(console, 'info').mockImplementation(() => {});
		const res = await app.request('/auth/me', {
			method: 'DELETE',
			headers: { cookie: gone.cookie, origin: 'http://localhost:7777', 'content-type': 'application/json' },
			body: JSON.stringify({ password: 'correct horse' })
		});
		expect(res.status).toBe(204);
		expect(await logged('account', gone.id)).toBe(1);
		const line = info.mock.calls.map((c) => String(c[0])).find((l) => l.includes('"account_deleted"'));
		expect(JSON.parse(line!)).toEqual({ event: 'account_deleted', via: 'self', accountId: gone.id });
		expect(line).not.toContain(gone.email);
		expect(line).not.toContain('ElSelfPath');
	});

	it('records a deleted project and team, and nothing for one that stays (positive control)', async () => {
		const kept = (await owner.call('POST', '/projects', { name: 'Erasure kept' })).body.project.id;
		const project = (await owner.call('POST', '/projects', { name: 'Erasure gone' })).body.project.id;
		const team = (await owner.call('POST', '/teams', { name: 'Erasure team' })).body.team.id;
		expect((await owner.call('DELETE', `/projects/${project}`)).status).toBe(204);
		expect((await owner.call('DELETE', `/teams/${team}`)).status).toBe(204);
		expect(await logged('project', project)).toBe(1);
		expect(await logged('team', team)).toBe(1);
		expect(await logged('project', kept)).toBe(0);
		expect(await logged('account', owner.id)).toBe(0);
	});

	it('is closed to water_app: no read, no write, only the definer purge', async () => {
		for (const sql of ['SELECT * FROM erasure_log', `INSERT INTO erasure_log (kind, subject_id) VALUES ('account', gen_random_uuid())`, 'DELETE FROM erasure_log']) {
			await expect(withUser(owner.id, (db) => db.query(sql)), sql).rejects.toMatchObject({ code: '42501' });
			await expect(withoutUser((db) => db.query(sql)), sql).rejects.toMatchObject({ code: '42501' });
		}
		await expect(withUser(owner.id, (db) => db.query("SELECT app_purge_erasure_log(interval '40 days')"))).rejects.toMatchObject({ code: '42501' });
	});

	it('keeps an entry 40 days, longer than any backup, then the tick deletes it', async () => {
		expect(ERASURE_LOG_RETENTION_DAYS).toBeGreaterThan(35);
		await expect(purge(35)).rejects.toMatchObject({ code: '22023' });
		const [old, young] = [crypto.randomUUID(), crypto.randomUUID()];
		await asOwner(
			`INSERT INTO erasure_log (kind, subject_id, erased_at) VALUES ('account', $1, now() - interval '41 days'), ('account', $2, now() - interval '39 days')`,
			[old, young]
		);
		const tick = await runTick({ feeds: false, reports: false, alerts: false, maxJobs: 0 });
		expect(tick.erasuresPurged).toBeGreaterThanOrEqual(1);
		expect(await logged('account', old)).toBe(0);
		expect(await logged('account', young)).toBe(1);
	});
});
