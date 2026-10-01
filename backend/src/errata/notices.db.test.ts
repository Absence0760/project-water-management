// "A known engine bug may affect your results" notices (issue #103, the
// known-defect procedure; 153_erratum_notices.sql, errata/notices.ts,
// docs/legal/known-defect-procedure.md), at the SQL and worker level: which
// runs an erratum reaches (the run's engine, or the fit's for a `fit`
// erratum, in [first affected, fixed in)), who is queued (owners direct or
// through the team; never an editor, a viewer or an unconfirmed address),
// that a sweep runs once per range, that water_app writes nothing itself and
// only the worker sweeps, claims and purges, the email each owner gets (built
// as them), the re-checks at send, the data export and the purge. Each
// "can't" has its positive control.
//
// The errata here are invented (ER-9xxx, engine 90.x.y and up), so no other
// file's runs in the shared test database fall in their range.
import pg from 'pg';
import { ENGINE_ERRATA, errataFor, type Erratum } from '@water-management/engine';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { withApiKey, withoutUser, withUser } from '../db/tx.js';
import { runTick } from '../jobs/runner.js';
import { outbox } from '../mail/transport.js';
import { purgeErratumNotices, sendErratumNotices, sweepErrata } from './notices.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let teamAdmin: User;
let editor: User;
let viewer: User;
let unconfirmedOwner: User;
let otherOwner: User;
let affected: string;
let fitOnly: string;
let untouched: string;

const erratum = (id: string, over: Partial<Erratum> = {}): Erratum => ({
	id,
	keyedOn: 'run',
	firstAffected: '90.1.0',
	fixedIn: '90.3.0',
	severity: 'High',
	appliesWhen: 'A dam <b>spills</b> on a dry day',
	summary: 'The spill was counted twice',
	source: 'engine-audit.md Z1',
	...over
});

/** Test state past the guards, as the schema owner with triggers off. */
async function arrange<T>(fn: (q: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>) => Promise<T>): Promise<T> {
	const client = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
	await client.connect();
	try {
		await client.query('BEGIN');
		await client.query('SET LOCAL session_replication_role = replica');
		const result = await fn(async (sql, params = []) => (await client.query(sql, params)).rows);
		await client.query('COMMIT');
		return result;
	} catch (err) {
		await client.query('ROLLBACK');
		throw err;
	} finally {
		await client.end();
	}
}

const queued = async (erratumId: string) =>
	(await asOwner('SELECT project_id::text AS p, user_id::text AS u, run_count AS n FROM erratum_notice WHERE erratum_id = $1 ORDER BY 1, 2', [erratumId])).map(
		(r) => `${r.p}:${r.u}:${r.n}`
	);
const row = (project: string, u: User, runs: number) => `${project}:${u.id}:${runs}`;

beforeAll(async () => {
	[owner, teamAdmin, editor, viewer, otherOwner] = (await Promise.all(['ErOwner', 'ErTeamAdmin', 'ErEditor', 'ErViewer', 'ErOtherOwner'].map((n) => signUp(n)))) as [
		User,
		User,
		User,
		User,
		User
	];
	unconfirmedOwner = await signUp('ErUnconfirmed', { verified: false });
	affected = (await owner.call('POST', '/projects', { name: 'Erratum <i>catchment</i>' })).body.project.id as string;
	fitOnly = (await otherOwner.call('POST', '/projects', { name: 'Fit catchment' })).body.project.id as string;
	untouched = (await otherOwner.call('POST', '/projects', { name: 'Untouched catchment' })).body.project.id as string;
	for (const [u, role] of [
		[editor, 'editor'],
		[viewer, 'viewer']
	] as const)
		expect((await owner.call('POST', `/projects/${affected}/members`, { email: u.email, role })).status).toBe(201);
	await arrange(async (q) => {
		await q(`INSERT INTO project_member (project_id, user_id, role) VALUES ($1, $2, 'owner')`, [affected, unconfirmedOwner.id]);
		// An owner through the project's team: a team admin.
		const [team] = await q(`INSERT INTO team (name, created_by) VALUES ('Erratum team', $1) RETURNING id::text`, [owner.id]);
		await q(`INSERT INTO team_member (team_id, user_id, role) VALUES ($1, $2, 'admin')`, [team!.id, teamAdmin.id]);
		await q('UPDATE project SET team_id = $2 WHERE id = $1', [affected, team!.id]);
		const run = (project: string, version: string, fit: string | null = null) =>
			q(
				`INSERT INTO model_run (project_id, created_by, engine_version, start_date, end_date, inputs) VALUES ($1, $2, $3, '2020-01-01', '2020-01-02', $4)`,
				[project, owner.id, version, JSON.stringify(fit ? { settings: { fitRecord: { engineVersion: fit } } } : {})]
			);
		// In range: 90.1.0 (the first affected) and 90.2.10 (numerically below 90.3.0, though not as text).
		await run(affected, '90.1.0');
		await run(affected, '90.2.10', '90.0.5');
		// Out of range: below the first affected, at the fix, and not a version at all.
		await run(affected, '90.0.9');
		await run(affected, '90.3.0');
		await run(affected, 'x');
		// Made by a fixed engine, with parameters from an affected fit: only a `fit` erratum reaches it.
		await run(fitOnly, '91.0.0', '90.2.0');
		await run(untouched, '91.0.0');
	});
});

afterAll(async () => {
	await asOwner(`DELETE FROM erratum_notice WHERE erratum_id LIKE 'ER-9%'`);
	await asOwner(`DELETE FROM erratum_sweep WHERE erratum_id LIKE 'ER-9%'`);
});

describe('the sweep', () => {
	it('queues each owner (direct, or the team’s admin) of a project with a run in range, with the count; never an editor, a viewer or an unconfirmed address', async () => {
		expect(await sweepErrata([erratum('ER-9001')])).toBe(2);
		expect(await queued('ER-9001')).toEqual([row(affected, owner, 2), row(affected, teamAdmin, 2)].sort());
	});

	it('keys a `fit` erratum on the fit’s engine, not the run’s', async () => {
		await sweepErrata([erratum('ER-9002', { keyedOn: 'fit', firstAffected: '90.2.0', fixedIn: null })]);
		expect(await queued('ER-9002')).toEqual([row(fitOnly, otherOwner, 1)]);
	});

	it('an open erratum (no fix yet) reaches every later engine', async () => {
		await sweepErrata([erratum('ER-9003', { firstAffected: '90.3.0', fixedIn: null })]);
		expect(await queued('ER-9003')).toEqual(
			[row(affected, owner, 1), row(affected, teamAdmin, 1), row(fitOnly, otherOwner, 1), row(untouched, otherOwner, 1)].sort()
		);
	});

	it('sweeps a range once: the same list again queues nothing, even with the notices gone; a widened range sweeps again and adds only the new', async () => {
		await asOwner(`DELETE FROM erratum_notice WHERE erratum_id = 'ER-9001' AND user_id = $1`, [teamAdmin.id]);
		expect(await sweepErrata([erratum('ER-9001')])).toBe(0);
		expect(await queued('ER-9001')).toEqual([row(affected, owner, 2)]);
		// Widened to the fixed engines: the other owner's projects join; the owner already mailed isn't queued twice.
		expect(await sweepErrata([erratum('ER-9001', { fixedIn: null })])).toBe(3);
		expect(await queued('ER-9001')).toEqual(
			[row(affected, owner, 2), row(affected, teamAdmin, 3), row(fitOnly, otherOwner, 1), row(untouched, otherOwner, 1)].sort()
		);
	});

	it('refuses a malformed erratum (positive control: a well-formed one is accepted above)', async () => {
		await expect(sweepErrata([erratum('ER-9004', { firstAffected: '1.2' })])).rejects.toMatchObject({ code: '22023' });
		await expect(sweepErrata([erratum('nope')])).rejects.toMatchObject({ code: '22023' });
	});

	it('only the worker sweeps, claims and purges, and water_app writes no notice itself', async () => {
		await expect(withUser(owner.id, (db) => db.query(`SELECT app_erratum_sweep('[]'::jsonb)`))).rejects.toMatchObject({ code: '42501' });
		await expect(withUser(owner.id, (db) => db.query(`SELECT * FROM app_erratum_notice_claim(10, interval '1 minute')`))).rejects.toMatchObject({ code: '42501' });
		await expect(withUser(owner.id, (db) => db.query(`SELECT app_purge_erratum_notices(interval '30 days')`))).rejects.toMatchObject({ code: '42501' });
		await expect(
			withUser(owner.id, (db) =>
				db.query(`INSERT INTO erratum_notice (erratum_id, project_id, user_id, run_count) VALUES ('ER-9099', $1, $2, 1)`, [affected, owner.id])
			)
		).rejects.toMatchObject({ code: '42501' });
		await expect(withUser(owner.id, (db) => db.query(`INSERT INTO erratum_sweep (erratum_id, keyed_on, first_affected) VALUES ('ER-9099', 'run', '1.0.0')`))).rejects.toMatchObject({
			code: '42501'
		});
		// Positive control: the worker's own context.
		await expect(withoutUser((db) => db.query(`SELECT app_erratum_sweep('[]'::jsonb) AS n`))).resolves.toMatchObject({ rows: [{ n: 0 }] });
	});

	it('a signed-in person reads the sweep record, an API key never (it sees only its own series)', async () => {
		expect((await withUser(viewer.id, (db) => db.query(`SELECT 1 FROM erratum_sweep WHERE erratum_id = 'ER-9001'`))).rowCount).toBe(1);
		const [key] = await asOwner(
			`INSERT INTO api_key (project_id, name, key_hash, created_by) VALUES ($1, 'Erratum key', sha256(random()::text::bytea), $2) RETURNING id::text`,
			[affected, owner.id]
		);
		expect((await withApiKey(key!.id as string, (db) => db.query('SELECT 1 FROM erratum_sweep'))).rowCount).toBe(0);
	});

	it('a person reads their own notices only (positive control: the owner reads theirs)', async () => {
		const mine = await withUser(owner.id, (db) => db.query(`SELECT erratum_id FROM erratum_notice WHERE erratum_id = 'ER-9001'`));
		expect(mine.rowCount).toBe(1);
		const theirs = await withUser(editor.id, (db) => db.query(`SELECT erratum_id FROM erratum_notice WHERE erratum_id = 'ER-9001'`));
		expect(theirs.rowCount).toBe(0);
	});
});

describe('sending', () => {
	const errata = [erratum('ER-9001', { fixedIn: null }), erratum('ER-9002', { keyedOn: 'fit', firstAffected: '90.2.0', fixedIn: null }), erratum('ER-9003', { firstAffected: '90.3.0', fixedIn: null })];

	it('mails each owner once, built as them: the erratum, the conditions, the count and a link to the runs, the names escaped', async () => {
		// Demoted since the sweep: the team admin is now a team member (an editor), so gets nothing. (The owner joins as
		// a second admin first: a team keeps at least one, 149.)
		const team = (await asOwner('SELECT team_id::text AS t FROM project WHERE id = $1', [affected]))[0]!.t as string;
		await asOwner(`INSERT INTO team_member (team_id, user_id, role) VALUES ($1, $2, 'admin')`, [team, owner.id]);
		await asOwner(`UPDATE team_member SET role = 'member' WHERE user_id = $1`, [teamAdmin.id]);
		// Suppressed since the sweep (a bounce): nothing.
		await asOwner(`UPDATE app_user SET mail_suppressed_at = now(), mail_suppressed_reason = 'bounce' WHERE id = $1`, [otherOwner.id]);
		try {
			outbox.length = 0;
			const r = await sendErratumNotices({ errata, limit: 500 });
			expect(r.failed).toBe(0);
			const toOwner = outbox.filter((m) => m.to === owner.email && m.kind === 'erratum_notice');
			expect(toOwner.map((m) => m.subject).sort()).toEqual([
				'Known engine bug ER-9001 may affect Erratum <i>catchment</i> — Water Management',
				'Known engine bug ER-9003 may affect Erratum <i>catchment</i> — Water Management'
			]);
			const m = toOwner.find((x) => x.subject.includes('ER-9001'))!;
			expect(m.text).toContain('2 runs in Erratum <i>catchment</i> were made by engine 90.1.0 or later');
			expect(m.text).toContain('It changes results only when: A dam <b>spills</b> on a dry day.');
			expect(m.text).toContain(`/projects/${affected}?tab=runs`);
			expect(m.html).toContain('Erratum &lt;i&gt;catchment&lt;/i&gt;');
			expect(m.html).not.toContain('<b>spills</b>');
			expect(outbox.filter((x) => x.to === teamAdmin.email || x.to === otherOwner.email)).toEqual([]);
			const status = async (u: User, id: string) =>
				(await asOwner(`SELECT status, reason FROM erratum_notice WHERE erratum_id = $1 AND user_id = $2 ORDER BY project_id LIMIT 1`, [id, u.id]))[0];
			expect(await status(owner, 'ER-9001')).toMatchObject({ status: 'sent', reason: null });
			expect(await status(teamAdmin, 'ER-9001')).toMatchObject({ status: 'skipped', reason: 'no longer an owner of the project' });
			expect(await status(otherOwner, 'ER-9002')).toMatchObject({ status: 'skipped', reason: 'the address is suppressed (a bounce or complaint)' });
			// Settled: a second tick sends nothing.
			outbox.length = 0;
			expect(await sendErratumNotices({ errata })).toEqual({ sent: 0, skipped: 0, failed: 0 });
			expect(outbox).toEqual([]);
		} finally {
			await asOwner(`UPDATE team_member SET role = 'admin' WHERE user_id = $1`, [teamAdmin.id]);
			await asOwner('DELETE FROM team_member WHERE team_id = $1 AND user_id = $2', [team, owner.id]);
			await asOwner(`UPDATE app_user SET mail_suppressed_at = NULL, mail_suppressed_reason = NULL WHERE id = $1`, [otherOwner.id]);
		}
	});

	it('skips an erratum no longer listed (it never is: an erratum stays after its fix)', async () => {
		await asOwner(`INSERT INTO erratum_notice (erratum_id, project_id, user_id, run_count) VALUES ('ER-9098', $1, $2, 1)`, [affected, owner.id]);
		outbox.length = 0;
		expect(await sendErratumNotices({ errata })).toMatchObject({ sent: 0, skipped: 1 });
		expect((await asOwner(`SELECT reason FROM erratum_notice WHERE erratum_id = 'ER-9098'`))[0]).toEqual({ reason: 'the erratum is no longer listed' });
	});

	it('is in the owner’s data export', async () => {
		const res = await owner.call('GET', '/auth/me/export');
		expect(res.status).toBe(200);
		const ids = (res.body.erratumNotices as { erratumId: string; projectId: string }[]).map((n) => n.erratumId).sort();
		expect(ids).toEqual(expect.arrayContaining(['ER-9001', 'ER-9003']));
		expect((res.body.erratumNotices as { projectId: string }[]).every((n) => n.projectId === affected)).toBe(true);
	});

	it('purges settled notices after 30 days, never sooner, never an open one', async () => {
		await asOwner(`UPDATE erratum_notice SET settled_at = now() - interval '31 days' WHERE erratum_id = 'ER-9098'`);
		await asOwner(`UPDATE erratum_notice SET status = 'pending', settled_at = now() - interval '31 days' WHERE erratum_id = 'ER-9003' AND user_id = $1`, [owner.id]);
		await expect(withoutUser((db) => db.query(`SELECT app_purge_erratum_notices(interval '1 day')`))).rejects.toMatchObject({ code: '22023' });
		await purgeErratumNotices();
		expect(await asOwner(`SELECT 1 FROM erratum_notice WHERE erratum_id = 'ER-9098'`)).toEqual([]);
		expect((await asOwner(`SELECT status FROM erratum_notice WHERE erratum_id = 'ER-9003' AND user_id = $1`, [owner.id]))[0]).toEqual({ status: 'pending' });
		// Positive control: a recently settled one stays.
		expect((await asOwner(`SELECT status FROM erratum_notice WHERE erratum_id = 'ER-9001' AND user_id = $1`, [owner.id]))[0]).toEqual({ status: 'sent' });
	});
});

describe('the claim’s lease and retries', () => {
	const errata = [erratum('ER-9097')];
	const row = async () =>
		(await asOwner(`SELECT status, attempts, reason, settled_at IS NOT NULL AS settled FROM erratum_notice WHERE erratum_id = 'ER-9097' AND user_id = $1`, [owner.id]))[0];

	beforeAll(async () => {
		// Only this notice open, so each send below claims it alone.
		await asOwner(`UPDATE erratum_notice SET status = 'skipped', settled_at = now(), locked_until = NULL WHERE status IN ('pending', 'sending')`);
		await asOwner(`INSERT INTO erratum_notice (erratum_id, project_id, user_id, run_count) VALUES ('ER-9097', $1, $2, 1), ('ER-9097', $1, $3, 1)`, [
			affected,
			owner.id,
			teamAdmin.id
		]);
	});

	it('fails a notice left sending past its lease, never re-sending it; one within its lease is left alone (positive control)', async () => {
		await asOwner(`UPDATE erratum_notice SET status = 'sending', locked_until = now() - interval '1 minute' WHERE erratum_id = 'ER-9097' AND user_id = $1`, [teamAdmin.id]);
		await asOwner(`UPDATE erratum_notice SET status = 'sending', locked_until = now() + interval '5 minutes' WHERE erratum_id = 'ER-9097' AND user_id = $1`, [owner.id]);
		const claimed = await withoutUser((db) => db.query(`SELECT * FROM app_erratum_notice_claim(10, interval '1 minute')`));
		expect(claimed.rows).toEqual([]);
		expect((await asOwner(`SELECT status, reason FROM erratum_notice WHERE erratum_id = 'ER-9097' AND user_id = $1`, [teamAdmin.id]))[0]).toEqual({
			status: 'failed',
			reason: 'the worker stopped while sending'
		});
		expect(await row()).toMatchObject({ status: 'sending', settled: false });
	});

	it('retries a failed send twice, then gives up; the log line names no address; finish needs a claimed notice', async () => {
		await asOwner(`UPDATE erratum_notice SET status = 'pending', attempts = 0, locked_until = NULL WHERE erratum_id = 'ER-9097' AND user_id = $1`, [owner.id]);
		// A transport that fails: SMTP to a closed port.
		vi.stubEnv('MAIL_TRANSPORT', 'smtp');
		vi.stubEnv('SMTP_HOST', '127.0.0.1');
		vi.stubEnv('SMTP_PORT', '1');
		const logs: string[] = [];
		const errSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
		try {
			for (const [attempts, status] of [
				[1, 'pending'],
				[2, 'pending'],
				[3, 'failed']
			] as const) {
				expect(await sendErratumNotices({ errata })).toEqual({ sent: 0, skipped: 0, failed: 1 });
				expect(await row()).toMatchObject({ status, attempts, settled: status === 'failed' });
			}
			expect(await sendErratumNotices({ errata })).toEqual({ sent: 0, skipped: 0, failed: 0 });
		} finally {
			vi.unstubAllEnvs();
			errSpy.mockRestore();
		}
		const line = logs.find((l) => l.includes('mail_send_failed'));
		expect(line).toContain('erratum_notice');
		expect(line).not.toContain(owner.email);
		expect((await row())!.reason).toMatch(/^send failed \(/);
		expect((await row())!.reason).not.toContain(owner.email);
		// A notice that isn't being sent can't be finished.
		const done = await withoutUser((db) =>
			db.query<{ ok: boolean }>(`SELECT app_erratum_notice_finish('ER-9097', $1, $2, 'sent') AS ok`, [affected, owner.id])
		);
		expect(done.rows[0]!.ok).toBe(false);
	});
});

describe('the worker’s tick', () => {
	it('sweeps a new erratum and sends its notices in the same tick; the next tick queues nothing', async () => {
		// A real erratum (the engine's list, as the tick passes it), forgotten so this tick sweeps it again, and a run it reaches.
		const target = ENGINE_ERRATA.find((e) => e.keyedOn === 'run')!;
		const [planted] = await arrange((q) =>
			q(`INSERT INTO model_run (project_id, created_by, engine_version, start_date, end_date, inputs) VALUES ($1, $2, $3, '2020-01-01', '2020-01-02', '{}') RETURNING id::text`, [
				affected,
				owner.id,
				target.firstAffected
			])
		);
		await asOwner('DELETE FROM erratum_sweep WHERE erratum_id = $1', [target.id]);
		await asOwner('DELETE FROM erratum_notice WHERE erratum_id = $1 AND project_id = $2', [target.id, affected]);
		try {
			outbox.length = 0;
			const first = await runTick({ feeds: false, reports: false, alerts: false, projectIds: [affected] });
			expect(first.erratumNotices.queued).toBeGreaterThanOrEqual(2);
			expect(first.erratumNotices.sent).toBeGreaterThanOrEqual(2);
			expect(outbox.filter((m) => m.kind === 'erratum_notice' && m.subject.startsWith(`Known engine bug ${target.id} may affect Erratum`)).map((m) => m.to).sort()).toEqual(
				[owner.email, teamAdmin.email].sort()
			);
			const second = await runTick({ feeds: false, reports: false, alerts: false, projectIds: [affected] });
			expect(second.erratumNotices).toMatchObject({ queued: 0, sent: 0 });
		} finally {
			await asOwner('DELETE FROM model_run WHERE id = $1', [planted!.id]);
			await asOwner('DELETE FROM erratum_notice WHERE erratum_id = $1 AND project_id = $2', [target.id, affected]);
		}
	});
});

describe('the flag on runs (GET …/runs, GET …/runs/:runId)', () => {
	it('names the errata that may affect each run, from the engine’s list; a run on a fixed engine has none', async () => {
		// Engine 0.10.0 had ER-2, ER-4 and ER-5 among others (ER-1 was fixed in 0.7.0; docs/engine-errata.md); the 90.x runs come after every fix.
		const [old] = await arrange((q) =>
			q(`INSERT INTO model_run (project_id, created_by, engine_version, start_date, end_date, inputs) VALUES ($1, $2, '0.10.0', '2020-01-01', '2020-01-02', '{}') RETURNING id::text`, [
				affected,
				owner.id
			])
		);
		try {
			const list = await viewer.call('GET', `/projects/${affected}/runs`);
			expect(list.status).toBe(200);
			const byVersion = new Map((list.body.runs as { id: string; engineVersion: string; errata: string[] }[]).map((r) => [r.engineVersion, r.errata]));
			expect(byVersion.get('0.10.0')).toEqual(errataFor('0.10.0', ENGINE_ERRATA).map((e) => e.id));
			expect(byVersion.get('0.10.0')).toEqual(expect.arrayContaining(['ER-2', 'ER-4', 'ER-5']));
			expect(byVersion.get('90.1.0')).toEqual([]);
			const detail = await viewer.call('GET', `/projects/${affected}/runs/${old!.id}`);
			expect(detail.status).toBe(200);
			expect(detail.body.run.errata).toEqual(byVersion.get('0.10.0'));
		} finally {
			await asOwner('DELETE FROM model_run WHERE id = $1', [old!.id]);
		}
	});
});
