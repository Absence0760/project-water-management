// The data-subject export, "download my data" (GET /auth/me/export; plan.md
// Phase 7; docs/security.md § Personal information (POPIA); docs/api.md §
// Auth). One JSON document with what the app keeps about the signed-in
// person: their account, memberships, farm links with the figures and
// registered volumes of those farms, and the rows keyed to them that RLS hides
// (the audit log, invites to their address, notes, sign-offs, alert and report
// choices) through app_subject_export (054_subject_export.sql), which reads
// only the caller's own rows. Never a secret: no password hash, token hash,
// unsubscribe nonce or API key material.
import type { FarmProjection, NoticeText } from '@water-management/engine';
import type { Db } from '../db/tx.js';
import { withUser } from '../db/tx.js';
import { currentFor, farmerProjection } from '../farms/view.js';
import { ApiError } from '../http/errors.js';

/** The document's shape version; bump it when a section changes shape. */
export const SUBJECT_EXPORT_VERSION = 1;
/** One export a minute per account (app_user.data_exported_at, across Lambda instances). */
export const EXPORT_COOLDOWN_SECONDS = 60;

/**
 * Every app_user column, exported or deliberately left out. The completeness
 * guard (export.db.test.ts) fails when a new column is in neither list.
 */
export const APP_USER_EXPORTED = [
	'id',
	'email',
	'display_name',
	'created_at',
	'email_verified_at',
	'sessions_revoked_at',
	'locale',
	'volume_unit',
	'data_exported_at',
	// SES reported a bounce or complaint for the address (057): alert emails paused.
	'mail_suppressed_at',
	'mail_suppressed_reason',
	'mail_resumed_at',
	// The terms and privacy notice this account accepted, and when (087).
	'terms_version',
	'terms_accepted_at',
	// The farm view notice this account acknowledged, and when (093).
	'farm_notice_version',
	'farm_notice_accepted_at'
] as const;
export const APP_USER_EXCLUDED: Record<string, string> = {
	password_hash: 'a secret (bcrypt hash of the password)'
};

/**
 * Every foreign key to app_user, and where its rows are in the export or why
 * they are not. The completeness guard (export.db.test.ts) fails when a new
 * one isn't listed, so a new table that points at a person can't ship without
 * a decision, the same way catalogue.db.test.ts's APP_USER_ON_DELETE
 * classifies what deletion does. "Made by" columns on the project's own
 * records are left out: the row is the project's, the person is named only as
 * its maker, and the act itself is in auditEvents.
 */
export const USER_FK_COVERAGE: Record<string, { section: string } | { excluded: string }> = {
	'account_mail_quota.user_id': { excluded: 'a count of reset / verification emails for the daily cap, a day at most' },
	'alert_delivery.user_id': { section: 'alertDeliveries' },
	'alert_rule.created_by': { excluded: 'the project’s alert rule; its maker only' },
	'alert_subscription.user_id': { section: 'alertSubscriptions' },
	'allocation_source.imported_by': { excluded: 'the project’s import record; the import is audited' },
	'api_key.created_by': { excluded: 'the project’s key; api_key.created is in auditEvents; never key material' },
	'api_key.revoked_by': { excluded: 'the project’s key; api_key.revoked is in auditEvents' },
	'audit_event.actor_user_id': { section: 'auditEvents' },
	'data_feed.acting_user_id': { excluded: 'the project’s feed configuration; feed.configured is in auditEvents' },
	'data_feed.created_by': { excluded: 'the project’s feed configuration; feed.configured is in auditEvents' },
	// An evidence pack (112_evidence_pack): who drafted and issued it is in the audit events (pack.drafted, pack.issued), exported with them.
	'evidence_pack.created_by': { excluded: 'the project’s evidence pack; its maker only, and the drafting is an exported audit event' },
	'evidence_pack.issued_by': { excluded: 'the project’s evidence pack; its issuer only, and the issue is an exported audit event' },
	'email_token.user_id': { excluded: 'secrets (verify / reset token hashes), a week at most' },
	'farm_link.added_by': { excluded: 'links the person made for others; farmer.linked is in auditEvents' },
	'invite.invited_by': { excluded: 'invites the person sent (another person’s address); invite.sent is in auditEvents' },
	'job.acting_user_id': { excluded: 'operational queue rows, 30 days; what they change is audited' },
	'model_revision.created_by': { excluded: 'the project’s model history; its maker only' },
	'model_run.created_by': { excluded: 'the project’s run (evidence); run.created is in auditEvents' },
	'model_run.notes_updated_by': { excluded: 'the project’s run note; its last editor only' },
	'note.author_id': { section: 'notes' },
	'note.deleted_by': { excluded: 'notes the person hid; note.deleted is in auditEvents' },
	'project.created_by': { excluded: 'the project itself; the membership is in projectMemberships' },
	'outlook_publication.ended_by': { excluded: 'the project’s outlook publication to farmers; outlook.unpublished is in auditEvents' },
	'outlook_publication.published_by': { excluded: 'the project’s outlook publication to farmers; outlook.published is in auditEvents' },
	'project_import.imported_by': { excluded: 'the project’s import report; its maker only' },
	'project_member.user_id': { section: 'projectMemberships' },
	'render_token.user_id': { excluded: 'secrets (single-use render tokens), 5 minutes' },
	'report.requested_by': { excluded: 'operational report rows, 8 days' },
	'report_schedule.acting_user_id': { excluded: 'the project’s schedule; report_schedule.configured is in auditEvents' },
	'report_schedule.created_by': { excluded: 'the project’s schedule; report_schedule.configured is in auditEvents' },
	'report_schedule_recipient.user_id': { section: 'reportSubscriptions' },
	'revoked_session.user_id': { excluded: 'ids of sessions the person signed out, no other data; kept until the token would have expired, 7 days at most' },
	'run_nomination.nominated_by': { excluded: 'the project’s evidence nomination; its maker only' },
	'run_publication.published_by': { excluded: 'the project’s publication; publication.published is in auditEvents' },
	'run_publication.updated_by': { excluded: 'the project’s publication; its last editor only' },
	'run_uncertainty.created_by': { excluded: 'the project’s ensemble; its maker only' },
	'scenario.decided_by': { excluded: 'the project’s application decision; its assessor only' },
	'scenario.owner_user_id': { excluded: 'the project’s scenario; scenario.created is in auditEvents' },
	'scenario_member.added_by': { excluded: 'people the person added to a scenario; its maker only' },
	'scenario_sweep.created_by': { excluded: 'the project’s scenario sweep; its maker only' },
	'auto_calibration.created_by': { excluded: 'the project’s run of its calibration rules; who asked only' },
	'auto_calibration.applied_by': { excluded: 'the project’s run of its calibration rules; who applied its fit only' },
	'seasonal_outlook.created_by': { excluded: 'the project’s seasonal outlook; its maker only' },
	'series_revision.created_by': { excluded: 'the project’s series history; its maker only' },
	'share_link.created_by': { excluded: 'the project’s share link; share_link.created is in auditEvents; never the token' },
	'share_link.revoked_by': { excluded: 'the project’s share link; share_link.revoked is in auditEvents' },
	'signoff.user_id': { section: 'signoffs' },
	'team.created_by': { excluded: 'the team itself; the membership is in teamMemberships' },
	'team_member.user_id': { section: 'teamMemberships' },
	// The person's own display preferences (083): the workspace sections they hid.
	'user_preferences.user_id': { section: 'preferences' },
	'yield_result.created_by': { excluded: 'the project’s yield result; its maker only' }
};

/** The RLS-hidden sections, as app_subject_export returns them (054_subject_export.sql). */
interface DefinerSections {
	auditEvents: unknown[];
	auditEventsTruncated: boolean;
	invites: unknown[];
	notes: unknown[];
	signoffs: unknown[];
	alertSubscriptions: unknown[];
	reportSubscriptions: unknown[];
}

interface FarmLinkRow {
	projectId: string;
	projectName: string | null;
	nodeId: string;
	farmName: string | null;
	linkedAt: Date;
	linkedBy: string | null;
}

/** A linked farm: the link, its registered volumes, and its current published figures as the farm page shows them. */
async function farmSection(db: Db, link: FarmLinkRow) {
	const { rows: allocations } = await db.query(
		`SELECT a.id, h.user_display AS "holderName", a.registration_no AS "registrationNo", a.property_ref AS "propertyRef",
			a.authorisation, a.purpose, a.water_source AS "waterSource", a.volume_m3_year AS "volumeM3Year",
			a.storage_m3 AS "storageM3", a.valid_from::text AS "validFrom", a.valid_to::text AS "validTo", a.reference,
			a.months::int[] AS months, a.max_rate_m3s AS "maxRateM3s", a.conditions,
			a.created_at AS "createdAt", a.updated_at AS "updatedAt"
		 FROM allocation a LEFT JOIN allocation_holder h ON h.allocation_id = a.id
		 WHERE a.project_id = $1 AND a.node_id = $2
		 ORDER BY a.registration_no, a.id`,
		[link.projectId, link.nodeId]
	);
	const cur = await currentFor(db, link.projectId, link.nodeId);
	let publication: {
		publishedAt: string;
		restriction: { level: string; pct: number | null; notice: NoticeText };
		nextExpectedOn: string | null;
		figures: FarmProjection;
	} | null = null;
	if (cur?.view) {
		publication = {
			publishedAt: cur.published_at.toISOString(),
			restriction: {
				level: cur.restriction_level,
				pct: cur.restriction_pct === null ? null : Number(cur.restriction_pct),
				notice: cur.notice
			},
			nextExpectedOn: cur.next_expected_on,
			figures: await farmerProjection(db, link.projectId, link.nodeId, cur.view)
		};
	}
	return { ...link, allocations, publication };
}

/** Seconds until this account may export again, or 0 after stamping this export. Row-locked, so parallel requests queue. */
async function takeExport(db: Db, userId: string): Promise<number> {
	const { rows } = await db.query<{ wait: number }>(
		`SELECT coalesce(greatest(0, ceil(extract(epoch FROM data_exported_at + make_interval(secs => $2) - now()))), 0)::int AS wait
		 FROM app_user WHERE id = $1 FOR UPDATE`,
		[userId, EXPORT_COOLDOWN_SECONDS]
	);
	const wait = rows[0]?.wait ?? 0;
	if (wait === 0) await db.query('UPDATE app_user SET data_exported_at = now() WHERE id = $1', [userId]);
	return wait;
}

export class ExportThrottled extends Error {
	constructor(readonly retryAfter: number) {
		super('throttled');
	}
}

/** The whole document for `userId`, read as that user (RLS) plus app_subject_export for the rows RLS hides. */
export async function buildSubjectExport(userId: string, now = new Date()) {
	return withUser(userId, async (db) => {
		const wait = await takeExport(db, userId);
		if (wait > 0) throw new ExportThrottled(wait);
		const { rows: acct } = await db.query(
			`SELECT id, email, display_name AS "displayName", created_at AS "createdAt", email_verified_at AS "emailVerifiedAt",
				sessions_revoked_at AS "sessionsRevokedAt", locale, volume_unit AS "volumeUnit", data_exported_at AS "dataExportedAt",
				mail_suppressed_at AS "mailSuppressedAt", mail_suppressed_reason AS "mailSuppressedReason", mail_resumed_at AS "mailResumedAt",
				terms_version AS "termsVersion", terms_accepted_at AS "termsAcceptedAt",
				farm_notice_version AS "farmNoticeVersion", farm_notice_accepted_at AS "farmNoticeAcceptedAt"
			 FROM app_user WHERE id = $1`,
			[userId]
		);
		if (!acct[0]) throw ApiError.coded(401, 'not_signed_in', 'not signed in');
		const { rows: projectMemberships } = await db.query(
			`SELECT m.project_id AS "projectId", p.name AS "projectName", m.role, m.added_at AS "addedAt"
			 FROM project_member m LEFT JOIN project p ON p.id = m.project_id
			 WHERE m.user_id = $1 ORDER BY m.added_at, m.project_id`,
			[userId]
		);
		const { rows: teamMemberships } = await db.query(
			`SELECT tm.team_id AS "teamId", t.name AS "teamName", tm.role, tm.added_at AS "addedAt"
			 FROM team_member tm LEFT JOIN team t ON t.id = tm.team_id
			 WHERE tm.user_id = $1 ORDER BY tm.added_at, tm.team_id`,
			[userId]
		);
		const { rows: links } = await db.query<FarmLinkRow>(
			`SELECT fl.project_id AS "projectId", p.name AS "projectName", fl.node_id AS "nodeId", n.name AS "farmName",
				fl.added_at AS "linkedAt", a.display_name AS "linkedBy"
			 FROM farm_link fl
			 LEFT JOIN project p ON p.id = fl.project_id
			 LEFT JOIN node n ON n.id = fl.node_id
			 LEFT JOIN app_user a ON a.id = fl.added_by
			 WHERE fl.user_id = $1 ORDER BY p.name, n.name, fl.node_id`,
			[userId]
		);
		const farms = [];
		for (const link of links) farms.push(await farmSection(db, link));
		const { rows: alertDeliveries } = await db.query(
			`SELECT d.project_id AS "projectId", e.kind, d.mode, d.status, d.via, d.created_at AS "createdAt", d.sent_at AS "sentAt"
			 FROM alert_delivery d LEFT JOIN alert_event e ON e.id = d.event_id
			 WHERE d.user_id = $1 ORDER BY d.created_at DESC`,
			[userId]
		);
		// Own row only under RLS (083): one row, or none when they never saved any.
		const { rows: prefs } = await db.query(
			`SELECT preferences, updated_at AS "updatedAt" FROM user_preferences WHERE user_id = $1`,
			[userId]
		);
		const { rows: hidden } = await db.query<{ doc: DefinerSections | null }>('SELECT app_subject_export() AS doc');
		const rest = hidden[0]?.doc;
		if (!rest) throw ApiError.coded(401, 'not_signed_in', 'not signed in');
		return {
			format: 'water-management.subject-export',
			version: SUBJECT_EXPORT_VERSION,
			exportedAt: now.toISOString(),
			account: acct[0],
			projectMemberships,
			teamMemberships,
			farms,
			notes: rest.notes,
			signoffs: rest.signoffs,
			invites: rest.invites,
			alertSubscriptions: rest.alertSubscriptions,
			alertDeliveries,
			preferences: prefs,
			reportSubscriptions: rest.reportSubscriptions,
			auditEvents: rest.auditEvents,
			auditEventsTruncated: rest.auditEventsTruncated
		};
	});
}
