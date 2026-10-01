// Self-service account deletion (issue #112; DELETE /auth/me in
// auth/routes.ts; 143_delete_my_account.sql; docs/security.md § Personal
// information (POPIA), "Deletion").
//
// Everything a deletion does to the data is the database's, the same for the
// operator's path and this one: the foreign keys, app_user_pseudonymise
// (048, latest 138) and the deferred checks that keep every project an owner
// and every team an admin. This module is the request's side of it, run as
// the person under RLS (withUser): what refuses it up front, and the audit
// events it leaves while the person is still a member.
import type { Db } from '../db/tx.js';
import { farmLinks, recordAudit, recordLinkChanges, recordTeamAudit } from '../history/record.js';
import { memberSubject } from '../teams/routes.js';

export type Holding = { id: string; name: string };
/** The projects and teams that would be left with no owner or admin. */
export type SoleHoldings = { projects: Holding[]; teams: Holding[] };

/**
 * The projects the person is the only owner of, and the teams they are the
 * only admin of: exactly what the deferred project_member_keep_owner and
 * team_member_keep_admin triggers (001, 002) would refuse at commit. Read as
 * the person, under RLS: an owner sees every member of their project, an
 * admin every member of their team.
 */
export async function soleHoldings(db: Db, userId: string): Promise<SoleHoldings> {
	const { rows: projects } = await db.query<Holding>(
		`SELECT p.id, p.name FROM project_member m JOIN project p ON p.id = m.project_id
		 WHERE m.user_id = $1 AND m.role = 'owner'
		   AND NOT EXISTS (SELECT 1 FROM project_member o WHERE o.project_id = m.project_id AND o.role = 'owner' AND o.user_id <> $1)
		 ORDER BY lower(p.name), p.id`,
		[userId]
	);
	const { rows: teams } = await db.query<Holding>(
		`SELECT t.id, t.name FROM team_member m JOIN team t ON t.id = m.team_id
		 WHERE m.user_id = $1 AND m.role = 'admin'
		   AND NOT EXISTS (SELECT 1 FROM team_member o WHERE o.team_id = m.team_id AND o.role = 'admin' AND o.user_id <> $1)
		 ORDER BY lower(t.name), t.id`,
		[userId]
	);
	return { projects, teams };
}

/**
 * Lock the owner rows of every project the person owns, and the admin rows
 * of every team they administer, before soleHoldings reads them. The
 * deferred owner and admin checks take no lock, so without this two
 * co-owners deleting their accounts at the same moment would each still see
 * the other (whose delete isn't committed yet), both pass, and leave the
 * project with no owner. Holding the rows makes any other change to them
 * (another deletion, leaving, a role change, the operator's delete) wait for
 * this transaction, and this one wait for theirs; the check that follows
 * then reads what they committed. Locked in id order, so two of these never
 * deadlock. As the person under RLS: an owner (admin) may update those rows.
 */
export async function lockOwnRoles(db: Db, userId: string): Promise<void> {
	await db.query(
		`SELECT 1 FROM project_member o
		 WHERE o.role = 'owner' AND o.project_id IN (SELECT m.project_id FROM project_member m WHERE m.user_id = $1 AND m.role = 'owner')
		 ORDER BY o.project_id, o.user_id FOR UPDATE`,
		[userId]
	);
	await db.query(
		`SELECT 1 FROM team_member o
		 WHERE o.role = 'admin' AND o.team_id IN (SELECT m.team_id FROM team_member m WHERE m.user_id = $1 AND m.role = 'admin')
		 ORDER BY o.team_id, o.user_id FOR UPDATE`,
		[userId]
	);
}

/** The catchments and teams the person left by deleting the account, by name (the confirmation email lists them). */
export type Departure = { projects: string[]; teams: string[] };

/**
 * Before the account goes: one audit event per project and team it belonged
 * to, as leaving does (`member.removed` and `team_member.removed` with
 * `self: true`), marked `accountDeleted: true`, and the farm links that go
 * with a farmer's membership (`farmer.unlinked`, cause member_removed). The
 * row's deletion then pseudonymises them like every other event naming the
 * person (048): the History reads "Deleted user deleted their account".
 * Written now because afterwards the person can no longer write to a
 * project's log (audit_event_insert needs a member).
 */
export async function recordDeparture(db: Db, userId: string): Promise<Departure> {
	const { rows: memberships } = await db.query<{ projectId: string; name: string; role: string; displayName: string }>(
		`SELECT m.project_id AS "projectId", p.name, m.role, u.display_name AS "displayName"
		 FROM project_member m JOIN project p ON p.id = m.project_id JOIN app_user u ON u.id = m.user_id
		 WHERE m.user_id = $1 ORDER BY lower(p.name), p.id`,
		[userId]
	);
	for (const m of memberships) {
		const links = (await farmLinks(db, m.projectId)).filter((l) => l.userId === userId);
		await recordLinkChanges(db, m.projectId, links, [], 'member_removed');
		await recordAudit(db, m.projectId, 'member.removed', { userId, displayName: m.displayName, role: m.role, self: true, accountDeleted: true });
	}
	const { rows: teams } = await db.query<{ teamId: string; name: string }>(
		`SELECT m.team_id AS "teamId", t.name FROM team_member m JOIN team t ON t.id = m.team_id
		 WHERE m.user_id = $1 ORDER BY lower(t.name), t.id`,
		[userId]
	);
	for (const t of teams) {
		const subject = await memberSubject(db, t.teamId, userId);
		if (subject) await recordTeamAudit(db, t.teamId, 'team_member.removed', { ...subject, self: true, accountDeleted: true });
	}
	return { projects: memberships.map((m) => m.name), teams: teams.map((t) => t.name) };
}
