// Invitations (migrations/004_email.sql, 109_invite_accept.sql).
//
// Every add by email — POST /projects/:id/members, /farmers, /farmers/bulk
// and POST /teams/:id/members — is an invite (issue #136): a pending invite
// is stored (token hash only), the route answers the same `{ invited: true,
// invite }` whether or not the address has an account, and an email goes out:
//   - no account: a sign-up link (`/register?invite=…`);
//   - an unverified account: a confirm-your-email link (someone may have
//     registered a colleague's address to be added in their place);
//   - a verified account: a link to the invitations page (/account/invitations).
// The first two join once the address is verified — by the verify-email link,
// a password-reset link, or signing up through the invite link itself
// (app_accept_invites, from markVerified, only when that call is the one that
// verifies the address). A verified account joins only when its holder
// accepts on the invitations page (myInviteRoutes below, app_accept_invite),
// so adding someone never tells the adder whether the address has an account,
// nor shows them its name, and never makes a stranger a member unasked.
// Owners (projects) / admins (teams) list and revoke pending invites; RLS
// enforces the same.
import { Hono, type Context } from 'hono';
import type { AuthEnv } from '../auth/middleware.js';
import { issueEmailToken } from '../auth/email-routes.js';
import { newToken, RESEND_COOLDOWN, TOKEN_TTL } from '../auth/tokens.js';
import type { Db } from '../db/tx.js';
import { withUser } from '../db/tx.js';
import { maskEmail, recordAudit } from '../history/record.js';
import { ApiError } from '../http/errors.js';
import { farmerInviteMail, inviteMail, siteLink, sitePage, type InviteMode, type Locale } from '../mail/templates.js';
import { trySendMail } from '../mail/transport.js';
import { requireRole, UUID } from '../projects/access.js';
import { requireTeamRole } from '../teams/access.js';

export type InviteKind = 'project' | 'team';

/**
 * An invite that lapsed unaccepted is kept this long past its expiry (owners
 * see it as expired and can send it again), then the job tick deletes it with
 * its farms (048_account_deletion.sql app_purge_invites): it holds the address
 * of someone who never signed up (docs/security.md § Personal information).
 */
export const INVITE_RETENTION_DAYS = 90;

/**
 * How many addresses one person may add by email in a day, and one project
 * or team may be added to (101_invite_throttle.sql, issue #51). Every
 * address an add names counts, before it is looked up, whether it is then
 * added or invited: a full bulk add (200 rows) and more fits, while probing
 * which addresses have accounts, or mailing strangers the project's name,
 * stops at a few hundred a day.
 */
export const INVITE_CAP = { perUser: 300, perTarget: 300, window: '24 hours' } as const;

/**
 * Count `n` addresses the signed-in user is adding to a project (as its
 * owner) or a team (as its admin), before any is looked up: 429 with
 * Retry-After when the day's cap is used up (nothing counted then). The
 * caller has checked the role already.
 */
export async function countInvites(c: Context, db: Db, kind: InviteKind, targetId: string, n: number): Promise<void> {
	if (n < 1) return;
	const { rows } = await db.query<{ wait: number }>('SELECT app_invite_attempt($1, $2, $3, $4, $5, $6::interval) AS wait', [
		kind,
		targetId,
		n,
		INVITE_CAP.perUser,
		INVITE_CAP.perTarget,
		INVITE_CAP.window
	]);
	const wait = rows[0]?.wait ?? 0;
	if (wait > 0) {
		c.header('Retry-After', String(wait));
		throw new ApiError(429, `too many people added by email today: try again in ${Math.ceil(wait / 3600)} h`);
	}
}

/** Delete invites expired more than `days` ago (the job tick, as no user). Returns how many went. */
export async function purgeInvites(db: Db, days = INVITE_RETENTION_DAYS): Promise<number> {
	const { rows } = await db.query<{ n: number }>('SELECT app_purge_invites(make_interval(days => $1)) AS n', [days]);
	return rows[0]?.n ?? 0;
}

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

/** The account that already has the invited address, if any (app_user_by_email). */
export type ExistingAccount = { id: string; verified: boolean } | undefined;

/**
 * Create or refresh the pending invite for `email` on a project/team, inside
 * the caller's transaction (which has already checked owner/admin). Re-inviting
 * the same address updates the role and, outside the re-send cooldown, issues
 * a fresh link (the old one stops working) and returns the email to send.
 *
 * `account`: the account that already has the address, if any. An
 * unverified one can't sign up again, so the email carries a verify-email
 * link for that account instead of a sign-up link; verifying accepts the
 * invite. No email when a verification link went out within its own cooldown
 * (the link already in their inbox accepts the invite too). A verified one
 * gets a link to the invitations page, where its holder accepts or declines
 * (issue #136). What the caller answers never depends on which it was.
 *
 * `farmer`: a farmer invite (WP-2.2, 034_farmer_invites). Its farms' names go
 * into the farmer variant of the email, in `locale`; the caller writes the
 * invite's invite_node rows. A contributor invite keeps them too (an
 * applicant invited with their farms, 097_contributor_invite_farms; a resend
 * from the members list doesn't drop them). Any other role clears them, so
 * an address re-invited as a viewer doesn't keep a farmer invite's farms.
 */
export async function inviteByEmail(
	db: Db,
	kind: InviteKind,
	targetId: string,
	email: string,
	role: string,
	account: ExistingAccount,
	farmer?: { farms: string[]; locale: Locale }
): Promise<{ invite: ReturnType<typeof toInvite>; mail: PendingMail }> {
	const { target, role: roleCol } = COLS[kind];
	const locale = farmer?.locale ?? 'en';
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
		await db.query(`UPDATE invite SET ${roleCol} = $2, invited_by = app_current_user_id(), locale = $3 WHERE id = $1`, [id, role, locale]);
	} else if (existing[0]) {
		id = existing[0].id;
		send = true;
		await db.query(
			`UPDATE invite SET ${roleCol} = $2, invited_by = app_current_user_id(), token_hash = $3,
				expires_at = now() + $4::interval, last_sent_at = now(), locale = $5
			 WHERE id = $1`,
			[id, role, hash, TOKEN_TTL.invite, locale]
		);
	} else {
		id = crypto.randomUUID();
		send = true;
		await db.query(
			`INSERT INTO invite (id, email, ${target}, ${roleCol}, invited_by, token_hash, expires_at, locale)
			 VALUES ($1, $2, $3, $4, app_current_user_id(), $5, now() + $6::interval, $7)`,
			[id, email, targetId, role, hash, TOKEN_TTL.invite, locale]
		);
	}
	if (kind === 'project' && role !== 'farmer' && role !== 'contributor') await db.query('DELETE FROM invite_node WHERE invite_id = $1', [id]);
	const { rows } = await db.query<InviteRow>(`${selectInvites(kind)} WHERE i.id = $1`, [id]);
	const row = rows[0]!;
	if (!send) return { invite: toInvite(row), mail: null };
	let link = siteLink('/register', token, 'invite');
	let mode: InviteMode = 'sign-up';
	if (account?.verified) {
		// Signed in as the address, its holder accepts or declines there (app_my_invites).
		link = sitePage('/account/invitations');
		mode = 'accept';
	} else if (account) {
		// On the address's shared count (078): the inviter's browser is no device of theirs.
		const verify = await issueEmailToken(db, account.id, 'verify');
		if (!('token' in verify)) return { invite: toInvite(row), mail: null };
		link = siteLink('/verify-email', verify.token);
		mode = 'confirm';
	}
	const { rows: named } = await db.query<{ name: string }>(COLS[kind].nameSql, [targetId]);
	if (farmer) {
		const mail = farmerInviteMail(email, link, row.invited_by_name, { catchment: named[0]?.name ?? '', farms: farmer.farms }, mode, locale);
		return { invite: toInvite(row), mail };
	}
	const mail = inviteMail(
		email,
		link,
		row.invited_by_name,
		{ kind, name: named[0]?.name ?? '', role },
		mode
	);
	return { invite: toInvite(row), mail };
}

/**
 * The account that has `email`, whoever it is: RLS (068) shows only people
 * you work with, so the by-address lookup. Its name never leaves the route
 * (issue #136); only whether it exists and is verified, for the invite email.
 */
export async function accountByEmail(db: Db, email: string): Promise<ExistingAccount> {
	const { rows } = await db.query<{ id: string; verified: boolean }>('SELECT id, verified FROM app_user_by_email(ARRAY[$1::citext])', [email]);
	return rows[0];
}

type MyInviteRow = {
	id: string;
	project_id: string | null;
	team_id: string | null;
	target_name: string;
	role: string;
	invited_by_name: string;
	created_at: Date;
	expires_at: Date;
	farms: string[];
};

/**
 * Your own pending invitations (109_invite_accept.sql), for an account whose
 * address is verified: GET /me/invites lists the live ones, POST
 * /me/invites/:inviteId/accept joins (the membership, a farm invite's links,
 * the history events), DELETE /me/invites/:inviteId declines. Someone else's
 * invite, an expired one or none at all is the same 404.
 */
export const myInviteRoutes = new Hono<AuthEnv>()
	.get('/invites', async (c) =>
		withUser(c.get('userId'), async (db) => {
			const { rows } = await db.query<MyInviteRow>('SELECT * FROM app_my_invites()');
			return c.json({
				invites: rows.map((r) => ({
					id: r.id,
					kind: r.project_id ? 'project' : 'team',
					targetId: r.project_id ?? r.team_id,
					name: r.target_name,
					role: r.role,
					invitedBy: r.invited_by_name,
					farms: r.farms,
					createdAt: r.created_at.toISOString(),
					expiresAt: r.expires_at.toISOString()
				}))
			});
		})
	)
	.post('/invites/:inviteId/accept', async (c) =>
		withUser(c.get('userId'), async (db) => {
			const inviteId = c.req.param('inviteId');
			if (!UUID.test(inviteId)) throw new ApiError(404, 'not found');
			const { rows } = await db.query<{ joined_project: string | null; joined_team: string | null }>(
				'SELECT joined_project, joined_team FROM app_accept_invite($1)',
				[inviteId]
			);
			const r = rows[0];
			if (!r) throw new ApiError(404, 'not found');
			return c.json({ joined: r.joined_project ? { kind: 'project', id: r.joined_project } : { kind: 'team', id: r.joined_team } });
		})
	)
	.delete('/invites/:inviteId', async (c) =>
		withUser(c.get('userId'), async (db) => {
			const inviteId = c.req.param('inviteId');
			if (!UUID.test(inviteId)) throw new ApiError(404, 'not found');
			const { rows } = await db.query<{ ok: boolean }>('SELECT app_decline_invite($1) AS ok', [inviteId]);
			if (!rows[0]?.ok) throw new ApiError(404, 'not found');
			return c.body(null, 204);
		})
	);

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
				const { rows } = await db.query<{ email: string; role: string }>(
					`DELETE FROM invite WHERE id = $1 AND ${COLS[kind].target} = $2 RETURNING email, ${COLS[kind].role}::text AS role`,
					[inviteId, id]
				);
				if (!rows[0]) throw new ApiError(404, 'not found');
				// A project's history (030_history.sql); teams have none.
				if (kind === 'project') await recordAudit(db, id, 'invite.revoked', { inviteId, email: maskEmail(rows[0].email), role: rows[0].role });
				return c.body(null, 204);
			})
		);
}

/** GET/DELETE /projects/:id/invites[/:inviteId] — project owners. */
export const projectInviteRoutes = inviteRoutes('project', (db, id) => requireRole(db, id, 'owner'));
/** GET/DELETE /teams/:id/invites[/:inviteId] — team admins. */
export const teamInviteRoutes = inviteRoutes('team', (db, id) => requireTeamRole(db, id, 'admin'));
