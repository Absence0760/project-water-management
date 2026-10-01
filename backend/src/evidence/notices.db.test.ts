// "Pack issued" / "pack withdrawn" notices (issue #71; 133_pack_notices.sql,
// evidence/notices.ts, docs/evidence-pack.md § Notices), at the SQL and
// worker level, on packs planted past their guards (the routes' end-to-end
// path is in packs.db.test.ts): who is queued (editors and owners, direct or
// through the team, and the application's owner; never the actor, a viewer, a
// farmer, another applicant or a stranger), who may queue and for which
// state, that water_app writes no notice itself, the worker-only claim, the
// email each recipient gets (built as them: the verify link and no figure),
// the re-checks at send (a demoted member, a suppressed address), the data
// export, and the purge. Each "can't" has its positive control.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { withoutUser, withUser } from '../db/tx.js';
import { outbox } from '../mail/transport.js';
import { purgePackNotices, queuePackNotices, sendPackNotices } from './notices.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let editor: User;
let teamEditor: User;
let viewer: User;
let applicant: User;
let otherApplicant: User;
let farmer: User;
let stranger: User;
let projectId: string;
let baselinePack: string;
let successorPack: string;
let applicationPack: string;
let applicationScenario: string;
let draftWithdrawn: string;
let draftPack: string;
const HASH = 'ab12cd34ef56'.padEnd(64, '0');

/** Test state past the guards, as the schema owner with triggers off (the cross-project test's `arrange`). */
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

const recipients = async (packId: string, event = 'issued') =>
	(await asOwner('SELECT user_id::text AS id FROM pack_notice WHERE pack_id = $1 AND event = $2 ORDER BY user_id', [packId, event])).map((r) => r.id as string).sort();
const ids = (...us: User[]) => us.map((u) => u.id).sort();
const mailsTo = (u: User) => outbox.filter((m) => m.to === u.email && m.kind === 'pack_notice');

beforeAll(async () => {
	[owner, editor, teamEditor, viewer, applicant, otherApplicant, farmer, stranger] = (await Promise.all(
		['NtOwner', 'NtEditor', 'NtTeamEditor', 'NtViewer', 'NtApplicant', 'NtOtherApplicant', 'NtFarmer', 'NtStranger'].map((n) => signUp(n))
	)) as User[] as [User, User, User, User, User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Notice catchment' })).body.project.id as string;
	for (const [u, role] of [
		[editor, 'editor'],
		[viewer, 'viewer'],
		[applicant, 'contributor'],
		[otherApplicant, 'contributor']
	] as const)
		expect((await owner.call('POST', `/projects/${projectId}/members`, { email: u.email, role })).status).toBe(201);
	const planted = await arrange(async (q) => {
		const one = async (sql: string, params: unknown[]) => (await q(`${sql} RETURNING id::text`, params))[0]!.id as string;
		await q(`INSERT INTO project_member (project_id, user_id, role) VALUES ($1, $2, 'farmer')`, [projectId, farmer.id]);
		// An editor through the project's team (a team `member` is an editor on every team project).
		const team = await one(`INSERT INTO team (name, created_by) VALUES ('Notice team', $1)`, [owner.id]);
		await q(`INSERT INTO team_member (team_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member')`, [team, owner.id, teamEditor.id]);
		await q('UPDATE project SET team_id = $2 WHERE id = $1', [projectId, team]);
		const run = await one(
			`INSERT INTO model_run (project_id, created_by, engine_version, start_date, end_date, inputs) VALUES ($1, $2, 'x', '2020-01-01', '2020-01-02', '{}')`,
			[projectId, owner.id]
		);
		const scenario = await one(
			`INSERT INTO scenario (project_id, name, base_run_id, ops_sha256, owner_user_id, origin, status, submitted_at)
			 VALUES ($1, 'Upper dam <b>raise</b>', $2, repeat('a', 64), $3, 'applicant', 'submitted', now())`,
			[projectId, run, applicant.id]
		);
		const scenarioRun = await one(
			`INSERT INTO model_run (project_id, created_by, engine_version, start_date, end_date, inputs, scenario_id) VALUES ($1, $2, 'x', '2020-01-01', '2020-01-02', '{}', $3)`,
			[projectId, owner.id, scenario]
		);
		const pack = (status: string, version: number, supersedes: string | null, app: boolean, issued: boolean, sha = `md5(random()::text) || md5(random()::text)`, id = randomUUID(), by: string | null = null) =>
			one(
				`INSERT INTO evidence_pack (id, project_id, baseline_run_id, version, supersedes_pack_id, scenario_id, scenario_run_id, status, status_reason, manifest,
					manifest_sha256, report_version, engine_version, created_by, issued_at, issued_by, superseded_by_pack_id)
				 VALUES ($10, $1, $2, $3, $4, $5, $6, $7, CASE WHEN $7 = 'withdrawn' THEN 'the application lapsed' END, '{}',
					${sha}, 'evidence-1', 'x', $8, CASE WHEN $9 THEN now() END, CASE WHEN $9 THEN $8::uuid END, $11)`,
				[projectId, run, version, supersedes, app ? scenario : null, app ? scenarioRun : null, status, owner.id, issued, id, by]
			);
		// Version 1 of the baseline evidence, superseded by version 2 (issued).
		const [baseId, successorId] = [randomUUID(), randomUUID()];
		const base = await pack('superseded', 1, null, false, true, undefined, baseId, successorId);
		return {
			scenario,
			base,
			successor: await pack('issued', 2, base, false, true, undefined, successorId),
			application: await pack('issued', 1, null, true, true, `'${HASH}'`),
			draftWithdrawn: await pack('withdrawn', 1, null, true, false),
			draft: await pack('draft', 1, null, false, false)
		};
	});
	({ scenario: applicationScenario, base: baselinePack, successor: successorPack, application: applicationPack, draftWithdrawn, draft: draftPack } = planted as Record<string, string> as {
		scenario: string;
		base: string;
		successor: string;
		application: string;
		draftWithdrawn: string;
		draft: string;
	});
	// Notices another file's route left pending (the claim is global): settled, so the counts below are this file's.
	await asOwner(`UPDATE pack_notice SET status = 'skipped', reason = 'test state' WHERE status IN ('pending', 'sending')`);
}, 60_000);

afterAll(async () => {
	// Nothing left for another file's tick to send.
	await asOwner(`DELETE FROM pack_notice WHERE project_id = $1`, [projectId]);
});

describe('queueing a pack’s notices', () => {
	it('queues the editors and owners (direct and through the team) and the application’s owner, never the actor', async () => {
		expect(await withUser(editor.id, (db) => queuePackNotices(db, applicationPack, 'issued'))).toBe(3);
		expect(await recipients(applicationPack)).toEqual(ids(owner, teamEditor, applicant));
		// Not the viewer, the farmer, the other applicant or a stranger; the positive control is the list above.
		for (const u of [editor, viewer, farmer, otherApplicant, stranger]) expect(await recipients(applicationPack)).not.toContain(u.id);
		// Once per pack, person and event: queueing again adds nothing.
		expect(await withUser(editor.id, (db) => queuePackNotices(db, applicationPack, 'issued'))).toBe(0);
	});

	it('queues a baseline pack’s notices to the editors and owners only (no application)', async () => {
		expect(await withUser(owner.id, (db) => queuePackNotices(db, successorPack, 'issued'))).toBe(2);
		expect(await recipients(successorPack)).toEqual(ids(editor, teamEditor));
	});

	it('lets only an editor of the pack’s project queue, and only for a pack in that state', async () => {
		for (const u of [viewer, applicant, farmer, stranger])
			await expect(withUser(u.id, (db) => queuePackNotices(db, successorPack, 'withdrawn'))).rejects.toMatchObject({ code: '42501' });
		await expect(withoutUser((db) => queuePackNotices(db, successorPack, 'issued'))).rejects.toMatchObject({ code: '42501' });
		// A draft isn't issued, and an issued pack isn't withdrawn.
		await expect(withUser(editor.id, (db) => queuePackNotices(db, draftPack, 'issued'))).rejects.toMatchObject({ code: '23514' });
		await expect(withUser(editor.id, (db) => queuePackNotices(db, successorPack, 'withdrawn'))).rejects.toMatchObject({ code: '23514' });
		await expect(withUser(editor.id, (db) => db.query(`SELECT app_pack_notice_queue($1, 'superseded')`, [successorPack]))).rejects.toMatchObject({ code: '22023' });
		// A draft that was withdrawn was never public: nobody is told (and nothing fails).
		expect(await withUser(editor.id, (db) => queuePackNotices(db, draftWithdrawn, 'withdrawn'))).toBe(0);
		expect(await recipients(draftWithdrawn, 'withdrawn')).toEqual([]);
	});

	it('leaves out an unconfirmed or suppressed address at queue time (positive control: the others)', async () => {
		await asOwner(`UPDATE app_user SET mail_suppressed_at = now(), mail_suppressed_reason = 'bounce' WHERE id = $1`, [teamEditor.id]);
		try {
			await asOwner(`UPDATE evidence_pack SET status = 'withdrawn', status_reason = 'the application lapsed' WHERE id = $1`, [baselinePack]);
			expect(await withUser(editor.id, (db) => queuePackNotices(db, baselinePack, 'withdrawn'))).toBe(1);
			expect(await recipients(baselinePack, 'withdrawn')).toEqual(ids(owner));
		} finally {
			await asOwner(`UPDATE app_user SET mail_suppressed_at = NULL, mail_suppressed_reason = NULL WHERE id = $1`, [teamEditor.id]);
		}
	});

	it('gives water_app no way to write a notice itself (SELECT only): RLS reads only one’s own rows', async () => {
		await expect(
			withUser(editor.id, (db) => db.query(`INSERT INTO pack_notice (pack_id, user_id, event, project_id) VALUES ($1, $2, 'issued', $3)`, [draftPack, stranger.id, projectId]))
		).rejects.toMatchObject({ code: '42501' });
		// water_app holds SELECT only (133): an UPDATE or DELETE is refused outright, not just filtered to no rows.
		await expect(withUser(owner.id, (db) => db.query(`UPDATE pack_notice SET status = 'sent' WHERE pack_id = $1`, [applicationPack]))).rejects.toMatchObject({ code: '42501' });
		await expect(withUser(owner.id, (db) => db.query(`DELETE FROM pack_notice WHERE pack_id = $1`, [applicationPack]))).rejects.toMatchObject({ code: '42501' });
		// Positive control: the applicant reads their own row, and only it.
		const own = await withUser(applicant.id, (db) => db.query<{ user_id: string }>('SELECT user_id FROM pack_notice'));
		expect(own.rows.map((r) => r.user_id)).toEqual([applicant.id]);
	});

	it('claims and purges only in the worker’s own context', async () => {
		await expect(withUser(owner.id, (db) => db.query(`SELECT * FROM app_pack_notice_claim(10, interval '1 minute')`))).rejects.toMatchObject({ code: '42501' });
		await expect(withUser(owner.id, (db) => db.query(`SELECT app_pack_notice_finish($1, $2, 'issued', 'sent')`, [applicationPack, owner.id]))).rejects.toMatchObject({
			code: '42501'
		});
		await expect(withUser(owner.id, (db) => db.query(`SELECT app_purge_pack_notices(interval '30 days')`))).rejects.toMatchObject({ code: '42501' });
		await expect(withoutUser((db) => db.query(`SELECT app_purge_pack_notices(interval '1 day')`))).rejects.toMatchObject({ code: '22023' });
	});
});

describe('sending them', () => {
	it('skips a member demoted since the notice was queued, and sends the rest, each built as its recipient', async () => {
		await asOwner(`UPDATE team_member SET role = 'viewer' WHERE user_id = $1`, [teamEditor.id]);
		try {
			outbox.length = 0;
			const r = await sendPackNotices();
			// application: owner, applicant (teamEditor skipped); successor: editor (teamEditor skipped); baseline withdrawn: owner.
			expect(r).toEqual({ sent: 4, skipped: 2, failed: 0 });
		} finally {
			await asOwner(`UPDATE team_member SET role = 'member' WHERE user_id = $1`, [teamEditor.id]);
		}
		const status = await asOwner(`SELECT user_id::text AS id, status, reason FROM pack_notice WHERE pack_id = $1 AND user_id = $2`, [applicationPack, teamEditor.id]);
		// As a viewer now, RLS hides the submitted application itself (045), so the mail is never built.
		expect(status).toEqual([{ id: teamEditor.id, status: 'skipped', reason: 'cannot see the application' }]);
		const baseline = await asOwner(`SELECT status, reason FROM pack_notice WHERE pack_id = $1 AND user_id = $2`, [successorPack, teamEditor.id]);
		expect(baseline).toEqual([{ status: 'skipped', reason: 'no longer gets pack notices for this project' }]);
		expect(mailsTo(teamEditor)).toEqual([]);
		// Nothing is sent twice.
		expect(await sendPackNotices()).toEqual({ sent: 0, skipped: 0, failed: 0 });
	});

	it('tells the applicant their application’s pack was issued, with the public verify link and their own copy (131), never the editors’ pack page', async () => {
		const [m] = mailsTo(applicant);
		expect(m).toMatchObject({ kind: 'pack_notice', subject: 'Evidence pack issued: Upper dam <b>raise</b> — Notice catchment' });
		expect(m!.text).toContain('Version 1 of the evidence pack for the application “Upper dam <b>raise</b>” in Notice catchment has been issued.');
		expect(m!.text).toContain('Its short code is ab12-cd34-ef56.');
		expect(m!.text).toContain('Check the pack: http://localhost:7777/verify/ab12-cd34-ef56');
		expect(m!.text).toContain('the application “Upper dam <b>raise</b>” is yours');
		expect(m!.text).toContain(
			`Open the pack in the catchment: http://localhost:7777/projects/${projectId}/scenarios/${applicationScenario}/packs/${applicationPack}`
		);
		expect(m!.text).not.toContain(`/projects/${projectId}/packs/${applicationPack}`);
		expect(m!.html).toContain('Upper dam &lt;b&gt;raise&lt;/b&gt;');
	});

	it('gives an editor the pack’s own page as well, and names the version a new one replaces', async () => {
		const [m] = mailsTo(owner).filter((x) => x.subject.startsWith('Evidence pack issued'));
		expect(m!.text).toContain(`Open the pack in the catchment: http://localhost:7777/projects/${projectId}/packs/${applicationPack}`);
		expect(m!.text).toContain('You get this email because you can issue and withdraw evidence packs in Notice catchment.');
		const [e] = mailsTo(editor);
		expect(e!.subject).toBe('Evidence pack issued: Baseline evidence — Notice catchment');
		expect(e!.text).toContain('Version 2 of the evidence pack for the baseline evidence in Notice catchment has been issued.');
		expect(e!.text).toContain('It replaces version 1, which is now marked as superseded.');
	});

	it('says a withdrawal and its public reason', async () => {
		const [m] = mailsTo(owner).filter((x) => x.subject.startsWith('Evidence pack withdrawn'));
		expect(m!.text).toContain('Version 1 of the evidence pack for the baseline evidence in Notice catchment has been withdrawn.');
		expect(m!.text).toContain('The reason given: “the application lapsed”');
	});

	it('skips an address SES suppressed after the notice was queued (positive control: a fresh one sends)', async () => {
		await asOwner(`UPDATE evidence_pack SET status = 'withdrawn', status_reason = 'the application lapsed' WHERE id = $1`, [applicationPack]);
		expect(await withUser(editor.id, (db) => queuePackNotices(db, applicationPack, 'withdrawn'))).toBe(3);
		await asOwner(`UPDATE app_user SET mail_suppressed_at = now(), mail_suppressed_reason = 'bounce' WHERE id = $1`, [applicant.id]);
		try {
			outbox.length = 0;
			expect(await sendPackNotices()).toEqual({ sent: 2, skipped: 1, failed: 0 });
			expect(mailsTo(applicant)).toEqual([]);
			expect(mailsTo(owner)).toHaveLength(1);
		} finally {
			await asOwner(`UPDATE app_user SET mail_suppressed_at = NULL, mail_suppressed_reason = NULL WHERE id = $1`, [applicant.id]);
		}
	});

	it('emails the application’s owner whatever their role above farmer: an owner ranked viewer still gets it (positive control for the contributor case above)', async () => {
		// Another issued version of the application, planted as the schema owner (the issue route isn't under test here).
		const pack = await arrange(async (q) =>
			(
				await q(
					`INSERT INTO evidence_pack (id, project_id, baseline_run_id, version, supersedes_pack_id, scenario_id, scenario_run_id, status, manifest, manifest_sha256,
						report_version, engine_version, created_by, issued_at, issued_by)
					 SELECT gen_random_uuid(), project_id, baseline_run_id, 2, id, scenario_id, scenario_run_id, 'issued', '{}', md5(random()::text) || md5(random()::text),
						report_version, engine_version, created_by, now(), issued_by
					 FROM evidence_pack WHERE id = $1 RETURNING id::text`,
					[applicationPack]
				)
			)[0]!.id as string
		);
		await asOwner(`UPDATE project_member SET role = 'viewer' WHERE project_id = $1 AND user_id = $2`, [projectId, applicant.id]);
		try {
			await withUser(editor.id, (db) => queuePackNotices(db, pack, 'issued'));
			expect(await recipients(pack)).toContain(applicant.id);
			outbox.length = 0;
			await sendPackNotices();
			expect(mailsTo(applicant)).toHaveLength(1);
			expect(mailsTo(applicant)[0]!.text).toContain('the application “Upper dam <b>raise</b>” is yours');
		} finally {
			await asOwner(`UPDATE project_member SET role = 'contributor' WHERE project_id = $1 AND user_id = $2`, [projectId, applicant.id]);
			await arrange((q) => q('DELETE FROM evidence_pack WHERE id = $1', [pack]));
		}
	});

	it('lists the notices sent to a person in their data export', async () => {
		const res = await owner.call('GET', '/auth/me/export');
		expect(res.status).toBe(200);
		expect(res.body.packNotices).toEqual(
			expect.arrayContaining([expect.objectContaining({ projectId, packId: applicationPack, event: 'issued', status: 'sent' })])
		);
		expect(res.body.packNotices.every((n: { projectId: string }) => n.projectId === projectId)).toBe(true);
	});

	it('purges settled notices past the retention and keeps the rest (positive control)', async () => {
		await asOwner(`UPDATE pack_notice SET settled_at = now() - interval '31 days' WHERE pack_id = $1 AND event = 'issued'`, [applicationPack]);
		// Settled 29 days ago though queued long before: kept (the retention counts from settling).
		await asOwner(`UPDATE pack_notice SET created_at = now() - interval '90 days', settled_at = now() - interval '29 days' WHERE pack_id = $1 AND event = 'withdrawn'`, [applicationPack]);
		await asOwner(`UPDATE pack_notice SET settled_at = now() - interval '31 days', status = 'pending' WHERE pack_id = $1 AND user_id = $2 AND event = 'issued'`, [successorPack, editor.id]);
		try {
			expect(await purgePackNotices()).toBe(3);
			expect(await recipients(applicationPack)).toEqual([]);
			expect(await recipients(applicationPack, 'withdrawn')).toHaveLength(3);
			// A pending one stays, however old.
			expect(await recipients(successorPack)).toContain(editor.id);
		} finally {
			await asOwner(`UPDATE pack_notice SET status = 'sent' WHERE pack_id = $1 AND user_id = $2`, [successorPack, editor.id]);
		}
	});

	it('skips an applicant who left the project since (positive control: the owner’s sends)', async () => {
		// A fresh event on the application pack: its withdrawal notices went out above, so re-queue them as pending.
		await asOwner(`UPDATE pack_notice SET status = 'pending', settled_at = NULL, sent_at = NULL, attempts = 0 WHERE pack_id = $1 AND event = 'withdrawn' AND user_id = ANY($2::uuid[])`, [
			applicationPack,
			[applicant.id, owner.id]
		]);
		await asOwner(`DELETE FROM project_member WHERE project_id = $1 AND user_id = $2`, [projectId, applicant.id]);
		try {
			outbox.length = 0;
			expect(await sendPackNotices()).toEqual({ sent: 1, skipped: 1, failed: 0 });
			const [row] = await asOwner(`SELECT status, reason FROM pack_notice WHERE pack_id = $1 AND user_id = $2 AND event = 'withdrawn'`, [applicationPack, applicant.id]);
			expect(row).toEqual({ status: 'skipped', reason: 'no longer a member, or no confirmed address' });
			expect(mailsTo(applicant)).toEqual([]);
			expect(mailsTo(owner)).toHaveLength(1);
		} finally {
			await asOwner(`INSERT INTO project_member (project_id, user_id, role) VALUES ($1, $2, 'contributor')`, [projectId, applicant.id]);
		}
	});
});

describe('the claim’s lease and retries', () => {
	const row = async (u: User) =>
		(await asOwner(`SELECT status, attempts, reason, settled_at IS NOT NULL AS settled FROM pack_notice WHERE pack_id = $1 AND user_id = $2 AND event = 'issued'`, [successorPack, u.id]))[0];
	const reset = (u: User) =>
		asOwner(`UPDATE pack_notice SET status = 'pending', attempts = 0, settled_at = NULL, sent_at = NULL, reason = NULL, locked_until = NULL WHERE pack_id = $1 AND user_id = $2 AND event = 'issued'`, [
			successorPack,
			u.id
		]);

	it('fails a notice left sending past its lease, never re-sending it; one within its lease is left alone (positive control)', async () => {
		await asOwner(`UPDATE pack_notice SET status = 'sending', settled_at = NULL, locked_until = now() - interval '1 minute' WHERE pack_id = $1 AND user_id = $2 AND event = 'issued'`, [successorPack, editor.id]);
		await asOwner(`UPDATE pack_notice SET status = 'sending', settled_at = NULL, locked_until = now() + interval '5 minutes' WHERE pack_id = $1 AND user_id = $2 AND event = 'issued'`, [successorPack, teamEditor.id]);
		const claimed = await withoutUser((db) => db.query(`SELECT * FROM app_pack_notice_claim(10, interval '1 minute')`));
		expect(claimed.rows).toEqual([]);
		expect(await row(editor)).toMatchObject({ status: 'failed', reason: 'the worker stopped while sending', settled: true });
		expect(await row(teamEditor)).toMatchObject({ status: 'sending', settled: false });
	});

	it('retries a failed send twice, then gives up; the log line names no address; finish needs a claimed notice', async () => {
		await reset(editor);
		await asOwner(`UPDATE pack_notice SET status = 'skipped', locked_until = NULL WHERE pack_id = $1 AND user_id = $2`, [successorPack, teamEditor.id]);
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
				expect(await sendPackNotices()).toEqual({ sent: 0, skipped: 0, failed: 1 });
				expect(await row(editor)).toMatchObject({ status, attempts, settled: status === 'failed' });
			}
			expect(await sendPackNotices()).toEqual({ sent: 0, skipped: 0, failed: 0 });
		} finally {
			vi.unstubAllEnvs();
			errSpy.mockRestore();
		}
		const line = logs.find((l) => l.includes('mail_send_failed'));
		expect(line).toContain('pack_notice');
		expect(line).not.toContain(editor.email);
		// A notice that isn't being sent can't be finished.
		const done = await withoutUser((db) => db.query<{ ok: boolean }>(`SELECT app_pack_notice_finish($1, $2, 'issued', 'sent') AS ok`, [successorPack, editor.id]));
		expect(done.rows[0]!.ok).toBe(false);
		expect(await row(editor)).toMatchObject({ status: 'failed' });
	});
});
