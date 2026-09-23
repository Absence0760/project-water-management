// Invitations for addresses without a *verified* account (migrations/004_email.sql).
//
// POST /projects/:id/members and POST /teams/:id/members fall through to
// `inviteByEmail` unless a verified account has the address: a pending invite
// is stored (token hash only) and an email goes out — a sign-up link when no
// account exists, a confirm-your-email link when an unverified account does
// (someone may have registered a colleague's address to be added in their
// place). The invite turns into a membership once that address is verified —
// by the verify-email link, a password-reset link, or signing up through the
// invite link itself (app_accept_invites). Owners (projects) / admins (teams)
// list and revoke pending invites; RLS enforces the same.
import { Hono } from 'hono';
import type { AuthEnv } from '../auth/middleware.js';
import { issueEmailToken } from '../auth/email-routes.js';
import { newToken, RESEND_COOLDOWN, TOKEN_TTL } from '../auth/tokens.js';
import type { Db } from '../db/tx.js';
import { withUser } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { inviteMail, siteLink } from '../mail/templates.js';
import { trySendMail } from '../mail/transport.js';
import { requireRole, UUID } from '../projects/access.js';
import { requireTeamRole } from '../teams/access.js';

export type InviteKind = 'project' | 'team';

// Column names per kind — fixed strings, never user input.
const COLS = {
	project: { target: 'project_id', role: 'project_role', nameSql: 'SELECT name FROM project WHERE id = $1' },
	team: { target: 'team_id', role: 'team_role', nameSql: 'SELECT name FROM team WHERE id = $1' }
} as const;

type InviteRow = {
	id: string;
	email: string;
	role: string;
	invited_by_name: string;
	created_at: Date;
	expires_at: Date;
};

export const toInvite = (r: InviteRow) => ({
	id: r.id,
	email: r.email,
	role: r.role,
	invitedBy: r.invited_by_name,
	createdAt: r.created_at.toISOString(),
	expiresAt: r.expires_at.toISOString(),
	expired: r.expires_at.getTime() <= Date.now()
});

const selectInvites = (kind: InviteKind) => `
	SELECT i.id, i.email, i.${COLS[kind].role}::text AS role, u.display_name AS invited_by_name,
		i.created_at, i.expires_at
	FROM invite i JOIN app_user u ON u.id = i.invited_by`;

/** A prepared invite email; send it after the transaction has committed. */
export type PendingMail = Parameters<typeof trySendMail>[0] | null;

/**
 * Create or refresh the pending invite for `email` on a project/team, inside
 * the caller's transaction (which has already checked owner/admin). Re-inviting
 * the same address updates the role and, outside the re-send cooldown, issues
 * a fresh link (the old one stops working) and returns the email to send.
 *
 * `unverifiedUserId`: the address already has an account that hasn't been
 * verified. It can't sign up again, so the email carries a verify-email link
 * for that account instead of a sign-up link; verifying accepts the invite.
 * No email when a verification link went out within its own cooldown (the
 * link already in their inbox accepts the invite too).
 */
export async function inviteByEmail(
	db: Db,
	kind: InviteKind,
	targetId: string,
	email: string,
	role: string,
	unverifiedUserId?: string
): Promise<{ invite: ReturnType<typeof toInvite>; mail: PendingMail }> {
	const { target, role: roleCol } = COLS[kind];
	const { rows: existing } = await db.query<{ id: string; recent: boolean }>(
		`SELECT id, last_sent_at > now() - $3::interval AS recent FROM invite
		 WHERE ${target} = $1 AND email = $2 FOR UPDATE`,
		[targetId, email, RESEND_COOLDOWN.invite]
	);
	const { token, hash } = newToken();
	let id: string;
	let send: boolean;
	if (existing[0]?.recent) {
		// Mailed moments ago: keep the link that's in their inbox, just update the role.
		id = existing[0].id;
		send = false;
		await db.query(`UPDATE invite SET ${roleCol} = $2, invited_by = app_current_user_id() WHERE id = $1`, [id, role]);
	} else if (existing[0]) {
		id = existing[0].id;
		send = true;
		await db.query(
			`UPDATE invite SET ${roleCol} = $2, invited_by = app_current_user_id(), token_hash = $3,
				expires_at = now() + $4::interval, last_sent_at = now()
			 WHERE id = $1`,
			[id, role, hash, TOKEN_TTL.invite]
		);
	} else {
		id = crypto.randomUUID();
		send = true;
		await db.query(
			`INSERT INTO invite (id, email, ${target}, ${roleCol}, invited_by, token_hash, expires_at)
			 VALUES ($1, $2, $3, $4, app_current_user_id(), $5, now() + $6::interval)`,
			[id, email, targetId, role, hash, TOKEN_TTL.invite]
		);
	}
	const { rows } = await db.query<InviteRow>(`${selectInvites(kind)} WHERE i.id = $1`, [id]);
	const row = rows[0]!;
	if (!send) return { invite: toInvite(row), mail: null };
	let link = siteLink('/register', token, 'invite');
	if (unverifiedUserId) {
		const verifyToken = await issueEmailToken(db, unverifiedUserId, 'verify');
		if (!verifyToken) return { invite: toInvite(row), mail: null };
		link = siteLink('/verify-email', verifyToken);
	}
	const { rows: named } = await db.query<{ name: string }>(COLS[kind].nameSql, [targetId]);
	const mail = inviteMail(
		email,
		link,
		row.invited_by_name,
		{ kind, name: named[0]?.name ?? '', role },
		unverifiedUserId ? 'confirm' : 'sign-up'
	);
	return { invite: toInvite(row), mail };
}

/** A direct add supersedes any pending invite for the same address. */
export async function dropInvite(db: Db, kind: InviteKind, targetId: string, email: string) {
	await db.query(`DELETE FROM invite WHERE ${COLS[kind].target} = $1 AND email = $2`, [targetId, email]);
}

function inviteRoutes(kind: InviteKind, authorize: (db: Db, id: string) => Promise<unknown>) {
	return new Hono<AuthEnv>()
		.get('/:id/invites', async (c) =>
			withUser(c.get('userId'), async (db) => {
				const id = c.req.param('id');
				await authorize(db, id);
				const { rows } = await db.query<InviteRow>(
					`${selectInvites(kind)} WHERE i.${COLS[kind].target} = $1 ORDER BY i.created_at DESC`,
					[id]
				);
				return c.json({ invites: rows.map(toInvite) });
			})
		)
		.delete('/:id/invites/:inviteId', async (c) =>
			withUser(c.get('userId'), async (db) => {
				const { id, inviteId } = c.req.param();
				await authorize(db, id);
				if (!UUID.test(inviteId)) throw new ApiError(404, 'not found');
				const { rowCount } = await db.query(`DELETE FROM invite WHERE id = $1 AND ${COLS[kind].target} = $2`, [
					inviteId,
					id
				]);
				if (!rowCount) throw new ApiError(404, 'not found');
				return c.body(null, 204);
			})
		);
}

/** GET/DELETE /projects/:id/invites[/:inviteId] — project owners. */
export const projectInviteRoutes = inviteRoutes('project', (db, id) => requireRole(db, id, 'owner'));
/** GET/DELETE /teams/:id/invites[/:inviteId] — team admins. */
export const teamInviteRoutes = inviteRoutes('team', (db, id) => requireTeamRole(db, id, 'admin'));
