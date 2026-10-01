// The tick's licence-record notices (159_licence_record.sql; docs/evidence-pack.md
// § Retention). Provisional position (pre-counsel research, 2026-10-01): a
// licence record is kept until three years after the licence expires, or
// three years after the application is refused or withdrawn, and reviewed
// every five years while no outcome is recorded. The app never deletes it;
// it makes sure the question is asked and the date is held.
//
//   - review: no outcome recorded and project.record_review_due_on passed.
//     The owners and the operator are asked to record the outcome or confirm
//     the record is still needed: on the due date, then a month apart, three
//     times in all; then nothing until an owner acts.
//   - closes: project.record_closes_on passed. The owners and the operator
//     are told the record can now be deleted, once per recorded outcome.
//
// app_licence_record_due marks the notice sent as it hands it out (at most
// once): a mail that fails is logged as mail_send_failed (the alarm counts
// it), and a review is asked again a month later. Each owner's mail is built
// as that owner (withUser): still an owner now, a confirmed address that SES
// hasn't suppressed, the project's name as they read it. The operator's copy
// goes to OPERATOR_EMAIL (the worker's environment, infra/jobs.tf), skipped
// when it isn't set.
import { type Db, withoutUser, withUser } from '../db/tx.js';
import { logEvent } from '../logging/logEvent.js';
import { safeError } from '../logging/safeError.js';
import { licenceRecordMail, type LicenceRecordFacts } from '../mail/templates.js';
import { sendMail, type Mail } from '../mail/transport.js';

export interface DueRecord {
	project_id: string;
	project_name: string;
	event: 'review' | 'closes';
	due_on: string;
	owner_ids: string[];
}

export interface LicenceRecordResult {
	/** Projects with a notice due this tick. */
	due: number;
	sent: number;
	skipped: number;
	failed: number;
}

type Prepared = { mail: Mail } | { skip: string };

/** One owner's mail, built as that owner (the transaction's user), or why not. */
export async function prepareLicenceRecordMail(db: Db, d: DueRecord): Promise<Prepared> {
	const { rows } = await db.query<{ email: string; verified: boolean; suppressed: boolean; role: string | null; project: string | null }>(
		`SELECT u.email, u.email_verified_at IS NOT NULL AS verified, u.mail_suppressed_at IS NOT NULL AS suppressed,
			app_project_role($1)::text AS role, (SELECT p.name FROM project p WHERE p.id = $1) AS project
		 FROM app_user u WHERE u.id = app_current_user_id()`,
		[d.project_id]
	);
	const me = rows[0];
	if (!me?.verified || !me.project) return { skip: 'no longer a member, or no confirmed address' };
	if (me.suppressed) return { skip: 'the address is suppressed (a bounce or complaint)' };
	if (me.role !== 'owner') return { skip: 'no longer an owner of the project' };
	return { mail: licenceRecordMail(me.email, facts(d, me.project)) };
}

const facts = (d: DueRecord, projectName: string, operator = false): LicenceRecordFacts => ({
	projectId: d.project_id,
	projectName,
	event: d.event,
	dueOn: d.due_on,
	operator
});

async function send(mail: Mail, r: LicenceRecordResult): Promise<void> {
	try {
		await sendMail(mail);
		r.sent++;
	} catch (err) {
		// The line the mail-send-failed alarm counts (infra/alarms.tf): kind and error code only.
		logEvent('error', { event: 'mail_send_failed', kind: 'licence_record', ...safeError(err) });
		r.failed++;
	}
}

/** Hand out and send the due notices (see the header). Every transport's tick ends here. */
export async function sendLicenceRecordNotices({ limit = 50, operatorEmail = process.env.OPERATOR_EMAIL }: { limit?: number; operatorEmail?: string } = {}): Promise<LicenceRecordResult> {
	const r: LicenceRecordResult = { due: 0, sent: 0, skipped: 0, failed: 0 };
	const { rows } = await withoutUser((db) =>
		db.query<DueRecord>(`SELECT project_id, project_name, event, to_char(due_on, 'YYYY-MM-DD') AS due_on, owner_ids FROM app_licence_record_due($1)`, [limit])
	);
	for (const d of rows) {
		r.due++;
		// The operator's trail even when no mail can go: the project and the event, never a name.
		logEvent('info', { event: 'licence_record_due', projectId: d.project_id, due: d.event, dueOn: d.due_on });
		for (const userId of d.owner_ids) {
			let p: Prepared;
			try {
				p = await withUser(userId, (db) => prepareLicenceRecordMail(db, d), { readOnly: true });
			} catch (err) {
				logEvent('error', { event: 'licence_record_prepare_failed', projectId: d.project_id, ...safeError(err) });
				r.failed++;
				continue;
			}
			if ('skip' in p) {
				r.skipped++;
				continue;
			}
			await send(p.mail, r);
		}
		const to = operatorEmail?.trim();
		if (to) await send(licenceRecordMail(to, facts(d, d.project_name, true)), r);
	}
	return r;
}
