// "Pack issued" / "pack withdrawn" emails (issue #71; docs/evidence-pack.md §
// Notices, 130_pack_notices.sql). The pattern is the alert mails'
// (alerts/send.ts):
//
//   1. Queued in the transaction that issues or withdraws the pack, as the
//      editor who did it (app_pack_notice_queue): one pack_notice row per
//      recipient, the project's editors and owners and the application's
//      scenario owner, never the actor. Both commit, or neither.
//   2. Sent by the worker's tick after the jobs (jobs/runner.ts), each built
//      in a transaction *as its recipient* (withUser), under RLS: their role
//      is checked again now (a member removed or demoted since gets nothing),
//      so is their address (confirmed, and not suppressed by SES since:
//      mail/suppression.ts), and the project's and the application's names
//      are read as they may read them. The mail goes out after that
//      transaction; the outcome is recorded in the worker's own context
//      (app_pack_notice_finish). A transport error is retried on the next
//      tick (3 attempts in all); a worker that dies mid-send leaves the
//      notice failed, never sent twice.
//
// The pack's public facts (version, hash, the version it replaced, the
// withdrawal reason) come from the claim: an applicant reads no pack under
// RLS, and all of them are what GET /verify/:code already answers anyone.
import { packShortCode } from '@water-management/engine';
import { type Db, withoutUser, withUser } from '../db/tx.js';
import { logEvent } from '../logging/logEvent.js';
import { safeError } from '../logging/safeError.js';
import { packNoticeMail } from '../mail/templates.js';
import { sendMail, type Mail } from '../mail/transport.js';

export const PACK_NOTICE_EVENTS = ['issued', 'withdrawn'] as const;
export type PackNoticeEvent = (typeof PACK_NOTICE_EVENTS)[number];

/** Settled notices are kept this long, then the tick deletes them (app_purge_pack_notices). */
export const PACK_NOTICE_RETENTION_DAYS = 30;

const LEASE = '10 minutes';

/**
 * Queue a pack's notices in this transaction, as its editor. Returns how many
 * were queued: 0 for a draft that was withdrawn (never public) or when
 * everyone who would get one is the actor.
 */
export async function queuePackNotices(db: Db, packId: string, event: PackNoticeEvent): Promise<number> {
	const { rows } = await db.query<{ n: number }>('SELECT app_pack_notice_queue($1, $2) AS n', [packId, event]);
	return rows[0]?.n ?? 0;
}

export interface ClaimedNotice {
	pack_id: string;
	user_id: string;
	event: PackNoticeEvent;
	project_id: string;
	scenario_id: string | null;
	version: number;
	manifest_sha256: string;
	supersedes_version: number | null;
	status_reason: string | null;
}

export interface NoticeResult {
	sent: number;
	skipped: number;
	failed: number;
}

type Prepared = { mail: Mail } | { skip: string };

/** Why a notice goes unsent when SES has suppressed its address (057). */
export const NOTICE_SUPPRESSED = 'the address is suppressed (a bounce or complaint)';

/** One notice's mail, built as its recipient (the transaction's user), or why not. */
export async function prepareNotice(db: Db, c: ClaimedNotice): Promise<Prepared> {
	const { rows } = await db.query<{ email: string; locale: string | null; verified: boolean; suppressed: boolean; role: string | null; project: string | null }>(
		`SELECT u.email, u.locale, u.email_verified_at IS NOT NULL AS verified, u.mail_suppressed_at IS NOT NULL AS suppressed,
			app_project_role($1)::text AS role, (SELECT p.name FROM project p WHERE p.id = $1) AS project
		 FROM app_user u WHERE u.id = app_current_user_id()`,
		[c.project_id]
	);
	const me = rows[0];
	if (!me?.verified || !me.role || !me.project) return { skip: 'no longer a member, or no confirmed address' };
	if (me.suppressed) return { skip: NOTICE_SUPPRESSED };
	const editor = me.role === 'editor' || me.role === 'owner';
	let scenarioName: string | null = null;
	let mine = false;
	if (c.scenario_id) {
		// Under RLS: an editor reads the project's applications, an applicant their own.
		const { rows: s } = await db.query<{ name: string; mine: boolean }>(
			'SELECT name, owner_user_id = app_current_user_id() AS mine FROM scenario WHERE id = $1 AND project_id = $2',
			[c.scenario_id, c.project_id]
		);
		if (!s[0]) return { skip: 'cannot see the application' };
		scenarioName = s[0].name;
		mine = s[0].mine;
	}
	// The audience again, now: an editor or owner, or the application's owner still holding a role above farmer.
	if (!editor && !(mine && me.role !== 'farmer')) return { skip: 'no longer gets pack notices for this project' };
	return {
		mail: packNoticeMail(
			me.email,
			{
				event: c.event,
				projectId: c.project_id,
				packId: c.pack_id,
				projectName: me.project,
				scenarioName,
				version: c.version,
				supersedesVersion: c.event === 'issued' ? c.supersedes_version : null,
				shortCode: packShortCode(c.manifest_sha256),
				reason: c.event === 'withdrawn' ? c.status_reason : null,
				as: editor ? 'editor' : 'applicant'
			},
			me.locale
		)
	};
}

const finish = (c: ClaimedNotice, status: 'sent' | 'skipped' | 'retry', reason: string | null = null) =>
	withoutUser((db) => db.query('SELECT app_pack_notice_finish($1, $2, $3, $4, $5)', [c.pack_id, c.user_id, c.event, status, reason]));

/** Never the raw error text (SES writes the address into it): its name and code only. */
const failureReason = (err: unknown) => `send failed (${safeError(err).error})`;

async function deliver(c: ClaimedNotice, r: NoticeResult): Promise<void> {
	let p: Prepared;
	try {
		p = await withUser(c.user_id, (db) => prepareNotice(db, c), { readOnly: true });
	} catch (err) {
		logEvent('error', { event: 'pack_notice_prepare_failed', packId: c.pack_id, ...safeError(err) });
		await finish(c, 'retry', failureReason(err));
		r.failed++;
		return;
	}
	if ('skip' in p) {
		await finish(c, 'skipped', p.skip);
		r.skipped++;
		return;
	}
	try {
		await sendMail(p.mail);
	} catch (err) {
		// The line the mail-send-failed alarm counts (infra/alarms.tf), as trySendMail's: kind and error code only.
		logEvent('error', { event: 'mail_send_failed', kind: 'pack_notice', ...safeError(err) });
		await finish(c, 'retry', failureReason(err));
		r.failed++;
		return;
	}
	await finish(c, 'sent');
	r.sent++;
}

/** Send the pending notices (see the header). Every transport's tick ends here, after the alerts. */
export async function sendPackNotices({ limit = 100 }: { limit?: number } = {}): Promise<NoticeResult> {
	const r: NoticeResult = { sent: 0, skipped: 0, failed: 0 };
	const { rows } = await withoutUser((db) =>
		db.query<ClaimedNotice>(
			`SELECT pack_id, user_id, event, project_id, scenario_id, version, manifest_sha256, supersedes_version, status_reason
			 FROM app_pack_notice_claim($1, $2::interval)`,
			[limit, LEASE]
		)
	);
	for (const c of rows) await deliver(c, r);
	return r;
}

/** Delete settled notices older than the retention (the tick). */
export async function purgePackNotices(days = PACK_NOTICE_RETENTION_DAYS): Promise<number> {
	const { rows } = await withoutUser((db) => db.query<{ n: number }>('SELECT app_purge_pack_notices(make_interval(days => $1)) AS n', [days]));
	return rows[0]?.n ?? 0;
}
