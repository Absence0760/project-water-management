// Farmers on a project (roadmap WP-2.1, issue #24; invites WP-2.2, issue
// #27): members with the `farmer` role, each linked to the farm nodes they
// may read (020_farm_scope.sql). The WUA side manages them here; the farmer's
// own view is farms/view.ts.
//
// Every address is invited (invites/invites.ts), whether or not it has an
// account (issue #136), with the farms the invite will link (invite_node,
// 034_farmer_invites.sql); the invite becomes a membership and its links when
// its holder accepts it (a verified account, on the invitations page) or once
// the address is verified (app_accept_invites). POST /farmers/bulk does the
// same for up to 200 CSV rows at once, matching farms by name; a row for
// someone already a farmer here adds the farm to their links straight away.
//
// POST /farmers also invites a licence applicant (`role:
// 'contributor'`, WP-3.3) with the farms they hold (097_contributor_invite_farms):
// an irrigator applying to raise their own dam joins with their farm linked.
//
// A farmer leaves (or an owner removes one) through DELETE /members/:userId:
// their links go with the membership (farm_link's foreign key cascades). A
// pending invite is revoked through DELETE /invites/:inviteId, and its farms
// go with it.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import type { Db } from '../db/tx.js';
import { withUser } from '../db/tx.js';
import { farmLinks, maskEmail, recordAudit, recordLinkChanges } from '../history/record.js';
import { readJson } from '../http/body.js';
import { ApiError } from '../http/errors.js';
import { accountByEmail, countInvites, inviteByEmail, type ExistingAccount, type PendingMail } from '../invites/invites.js';
import { DEFAULT_LOCALE, LANGUAGES, LOCALES, type Locale } from '@water-management/engine/languages';
import { trySendMail } from '../mail/transport.js';
import { requireRole, UUID } from '../projects/access.js';

/** A farmer can hold several farms; 50 per request is far above any real catchment. */
export const MAX_FARMS_PER_FARMER = 50;
const NodeIds = z.array(z.string().uuid()).min(1).max(MAX_FARMS_PER_FARMER);
const Email = z.string().trim().toLowerCase().email().max(254);
/** The farm-holding roles: a farmer, or a licence applicant with their farms (a contributor, WP-3.3). */
const FarmRole = z.enum(['farmer', 'contributor']);
type FarmRole = z.infer<typeof FarmRole>;
const AddBody = z.object({ email: Email, nodeIds: NodeIds, locale: z.enum(LOCALES).default('en'), role: FarmRole.default('farmer') });
const LinksBody = z.object({ nodeIds: NodeIds });

/** Rows per bulk request: a WUA has 20–60 farmers, and 60 rows answer in well under 5 s locally. */
export const BULK_MAX_ROWS = 200;
const BulkBody = z.object({
	rows: z
		.array(z.object({ email: z.string().max(320), farm: z.string().max(200), locale: z.string().max(40).optional() }))
		.min(1)
		.max(BULK_MAX_ROWS),
	/** Work out every row's outcome, then roll it all back: nothing is written and no email goes out. */
	dryRun: z.boolean().default(false)
});

/** A farmer member. */
export interface ActiveFarmer {
	status: 'active';
	userId: string;
	email: string;
	displayName: string;
	/** A contributor (a licence applicant, WP-3.3) keeps farm links too: an irrigator applying to raise their own dam. */
	role: 'farmer' | 'contributor';
	nodeIds: string[];
}

/** A pending farmer invite, or an applicant's with farms (097); `expired` once past its expiry (it can be re-sent). */
export interface InvitedFarmer {
	status: 'invited' | 'expired';
	inviteId: string;
	email: string;
	/** What they join as. */
	role: FarmRole;
	nodeIds: string[];
	invitedBy: string;
	expiresAt: string;
	locale: Locale;
}

export type FarmerEntry = ActiveFarmer | InvitedFarmer;

async function activeFarmers(db: Db, projectId: string): Promise<ActiveFarmer[]> {
	const { rows } = await db.query<Omit<ActiveFarmer, 'status'>>(
		`SELECT m.user_id AS "userId", u.email, u.display_name AS "displayName", m.role::text AS role,
			coalesce(array_agg(fl.node_id ORDER BY fl.node_id) FILTER (WHERE fl.node_id IS NOT NULL), '{}') AS "nodeIds"
		 FROM project_member m
		 JOIN app_user u ON u.id = m.user_id
		 LEFT JOIN farm_link fl ON fl.project_id = m.project_id AND fl.user_id = m.user_id
		 WHERE m.project_id = $1 AND m.role IN ('farmer', 'contributor')
		 GROUP BY m.user_id, u.email, u.display_name, m.role
		 ORDER BY u.display_name, u.email`,
		[projectId]
	);
	return rows.map((r) => ({ status: 'active', ...r }));
}

/**
 * Pending farmer invites, and applicant invites that carry farms (an
 * applicant's without farms is only on the members list). RLS on invite and
 * invite_node shows them to owners only; anyone else gets none.
 */
async function invitedFarmers(db: Db, projectId: string, inviteId?: string): Promise<InvitedFarmer[]> {
	const { rows } = await db.query<{ inviteId: string; email: string; role: FarmRole; nodeIds: string[]; invitedBy: string; expires_at: Date; locale: Locale }>(
		`SELECT i.id AS "inviteId", i.email, i.project_role::text AS role, u.display_name AS "invitedBy", i.expires_at, i.locale,
			coalesce(array_agg(n.node_id ORDER BY n.node_id) FILTER (WHERE n.node_id IS NOT NULL), '{}') AS "nodeIds"
		 FROM invite i
		 JOIN app_user u ON u.id = i.invited_by
		 LEFT JOIN invite_node n ON n.invite_id = i.id
		 WHERE i.project_id = $1 AND i.project_role IN ('farmer', 'contributor') AND ($2::uuid IS NULL OR i.id = $2)
		 GROUP BY i.id, u.display_name
		 HAVING i.project_role = 'farmer' OR count(n.node_id) > 0
		 ORDER BY i.created_at, i.email`,
		[projectId, inviteId ?? null]
	);
	return rows.map(({ expires_at, ...r }) => ({
		...r,
		status: expires_at.getTime() <= Date.now() ? 'expired' : 'invited',
		expiresAt: expires_at.toISOString()
	}));
}

async function listFarmers(db: Db, projectId: string): Promise<FarmerEntry[]> {
	return [...(await activeFarmers(db, projectId)), ...(await invitedFarmers(db, projectId))];
}

/** Every id must be a farm of this project; a clear 400 before the trigger would refuse it. */
async function assertFarms(db: Db, projectId: string, nodeIds: string[]) {
	const unique = [...new Set(nodeIds)];
	const { rows } = await db.query<{ n: number }>(
		`SELECT count(*)::int AS n FROM node WHERE project_id = $1 AND kind = 'farm' AND id = ANY($2::uuid[])`,
		[projectId, unique]
	);
	if (rows[0]!.n !== unique.length) throw new ApiError(400, 'every node must be a farm in this project');
	return unique;
}

/** Link exactly `nodeIds` (`replace`) or add them to the links the farmer has. */
async function setLinks(db: Db, projectId: string, userId: string, nodeIds: string[], addedBy: string, replace = true) {
	if (replace) {
		await db.query('DELETE FROM farm_link WHERE project_id = $1 AND user_id = $2 AND NOT (node_id = ANY($3::uuid[]))', [projectId, userId, nodeIds]);
	}
	await db.query(
		`INSERT INTO farm_link (project_id, node_id, user_id, added_by)
		 SELECT $1, n, $2, $4 FROM unnest($3::uuid[]) n
		 ON CONFLICT DO NOTHING`,
		[projectId, userId, nodeIds, addedBy]
	);
}

/**
 * Invite `email` as a farmer (or an applicant, `role`) of `nodeIds`: the invite (and its email) from
 * inviteByEmail, then its invite_node rows. `replace` sets the invite's farms
 * to exactly these (a re-invite from the single form); otherwise they are
 * added to the farms it already names (bulk rows, one farm each). The email
 * names every farm the invite will link; an applicant's is the ordinary
 * invite email for their role (the farmer email speaks to a farmer).
 */
async function inviteFarmer(
	db: Db,
	projectId: string,
	email: string,
	nodeIds: string[],
	locale: Locale,
	account: ExistingAccount,
	replace: boolean,
	role: FarmRole = 'farmer'
): Promise<{ invite: InvitedFarmer; mail: PendingMail }> {
	let farms = nodeIds;
	if (!replace) {
		const { rows } = await db.query<{ node_id: string }>(
			`SELECT n.node_id FROM invite_node n JOIN invite i ON i.id = n.invite_id
			 WHERE i.project_id = $1 AND i.email = $2 AND i.project_role = 'farmer'`,
			[projectId, email]
		);
		farms = [...new Set([...rows.map((r) => r.node_id), ...nodeIds])];
	}
	const { rows: named } = await db.query<{ name: string }>('SELECT name FROM node WHERE id = ANY($1::uuid[]) ORDER BY name', [farms]);
	const farmer = role === 'farmer' ? { farms: named.map((r) => r.name), locale } : undefined;
	const { invite, mail } = await inviteByEmail(db, 'project', projectId, email, role, account, farmer);
	await db.query('DELETE FROM invite_node WHERE invite_id = $1 AND NOT (node_id = ANY($2::uuid[]))', [invite.id, farms]);
	await db.query(
		`INSERT INTO invite_node (invite_id, project_id, node_id)
		 SELECT $1, $2, n FROM unnest($3::uuid[]) n
		 ON CONFLICT DO NOTHING`,
		[invite.id, projectId, farms]
	);
	// No `mailed` flag (see POST /members): it would tell the owner whether the address has an account.
	await recordAudit(db, projectId, 'invite.sent', { inviteId: invite.id, email: maskEmail(email), role, farms: farms.length });
	return { invite: (await invitedFarmers(db, projectId, invite.id))[0]!, mail };
}

type UserRow = { id: string; email: string; verified: boolean };
/** The accounts with these addresses, whoever they are: RLS (068) shows only people you work with, so the by-address lookup. */
const USER_SQL = 'SELECT id, email, verified FROM app_user_by_email($1::citext[])';

/** What a CSV may write in its `language` column, lower-cased: each language's code or own name, from the language table. */
const LANGUAGE_NAMES: ReadonlyMap<string, Locale> = new Map(LANGUAGES.flatMap((l) => [[l.code, l.code] as const, [l.name.toLowerCase(), l.code] as const]));
/** "en, af": the codes, for the error message. */
const CODE_LIST = LOCALES.join(', ');

export type BulkStatus = 'added' | 'invited' | 'error';
export interface BulkResult {
	/** Index into the request's `rows`. */
	row: number;
	email: string;
	farm: string;
	status: BulkStatus;
	error?: string;
}

export const farmerRoutes = new Hono<AuthEnv>()
	// Viewer and above: the WUA's staff see who is linked to which farm, as
	// they see the member list. Pending invites are listed for owners only.
	.get('/:id/farmers', async (c) =>
		withUser(c.get('userId'), async (db) => {
			const id = c.req.param('id');
			await requireRole(db, id, 'viewer');
			return c.json({ farmers: await listFarmers(db, id) });
		})
	)
	// Every add by email is an invite (issue #136): the same `{ invited: true,
	// invite }` whether or not the address has an account; an existing account
	// joins, with these farms, only when its holder accepts.
	.post('/:id/farmers', async (c) => {
		const body = AddBody.parse(await readJson(c));
		const id = c.req.param('id');
		const invited = await withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'owner');
			const nodeIds = await assertFarms(db, id, body.nodeIds);
			// The daily cap on adding by email (101_invite_throttle), counted before the address is looked up.
			await countInvites(c, db, 'project', id, 1);
			const account = await accountByEmail(db, body.email);
			// Already on the members list the owner can read: saying so tells them nothing new.
			if (account?.verified) {
				const { rows: member } = await db.query('SELECT 1 FROM project_member WHERE project_id = $1 AND user_id = $2', [id, account.id]);
				if (member[0]) throw new ApiError(409, 'already a member');
			}
			return inviteFarmer(db, id, body.email, nodeIds, body.locale, account, true, body.role);
		});
		// Mail goes out after the transaction commits, and never fails the request.
		if (invited.mail) await trySendMail(invited.mail);
		return c.json({ invited: true, invite: invited.invite }, 201);
	})
	// Many farmers at once, one farm per row (a CSV of email,farm,language).
	// Every row gets an outcome; a bad row never stops the others.
	.post('/:id/farmers/bulk', async (c) => {
		const body = BulkBody.parse(await readJson(c));
		const id = c.req.param('id');
		const actor = c.get('userId');
		const { results, mails } = await withUser(actor, async (db) => {
			await requireRole(db, id, 'owner');
			const results: BulkResult[] = body.rows.map((r, row) => ({ row, email: r.email.trim(), farm: r.farm.trim(), status: 'error' }));

			// 1. Each row on its own: the address, the farm by exact
			// (case-insensitive) name, the language. No guessing at a near name.
			const { rows: farmRows } = await db.query<{ id: string; name: string }>(`SELECT id, name FROM node WHERE project_id = $1 AND kind = 'farm'`, [id]);
			const byName = new Map<string, string[]>();
			for (const f of farmRows) byName.set(f.name.trim().toLowerCase(), [...(byName.get(f.name.trim().toLowerCase()) ?? []), f.id]);
			type Valid = { row: number; email: string; nodeId: string; locale: Locale };
			const valid: Valid[] = [];
			for (const [row, r] of body.rows.entries()) {
				const res = results[row]!;
				const email = Email.safeParse(r.email);
				if (!email.success) {
					res.error = 'not a valid email address';
					continue;
				}
				res.email = email.data;
				const matches = byName.get(res.farm.toLowerCase()) ?? [];
				if (!res.farm) res.error = 'no farm given';
				else if (matches.length === 0) res.error = `no farm named “${res.farm}” in this catchment`;
				else if (matches.length > 1) res.error = `${matches.length} farms are named “${res.farm}”: rename one on the Network tab`;
				const lang = (r.locale ?? '').trim().toLowerCase();
				const locale = lang ? LANGUAGE_NAMES.get(lang) : DEFAULT_LOCALE;
				if (!locale) res.error = [res.error, `unknown language “${r.locale!.trim()}” (use ${CODE_LIST}, or the language’s name)`].filter(Boolean).join('; ');
				if (res.error) continue;
				valid.push({ row, email: email.data, nodeId: matches[0]!, locale: locale! });
			}

			// 2. One outcome per address, whatever number of rows name it: at most
			// one email each. Its first row's language wins.
			const byEmail = new Map<string, Valid[]>();
			for (const v of valid) byEmail.set(v.email, [...(byEmail.get(v.email) ?? []), v]);
			const emails = [...byEmail.keys()];
			// Every address counts against the daily cap (101_invite_throttle) before any is looked up, a dry run's too:
			// its preview says which would be added and which invited.
			await countInvites(c, db, 'project', id, emails.length);
			const { rows: users } = await db.query<UserRow>(USER_SQL, [emails]);
			const userOf = new Map(users.map((u) => [u.email.toLowerCase(), u]));
			const { rows: members } = await db.query<{ user_id: string; role: string }>(
				'SELECT user_id, role::text AS role FROM project_member WHERE project_id = $1 AND user_id = ANY($2::uuid[])',
				[id, users.map((u) => u.id)]
			);
			const roleOf = new Map(members.map((m) => [m.user_id, m.role]));

			if (body.dryRun) await db.query('SAVEPOINT bulk_preview');
			const mails: NonNullable<PendingMail>[] = [];
			for (const [email, rows] of byEmail) {
				const nodeIds = [...new Set(rows.map((r) => r.nodeId))];
				const user = userOf.get(email);
				const mark = (status: BulkStatus, error?: string) => {
					for (const r of rows) Object.assign(results[r.row]!, { status, ...(error ? { error } : {}) });
				};
				// The same per-request cap as adding one farmer.
				if (nodeIds.length > MAX_FARMS_PER_FARMER) {
					mark('error', `${nodeIds.length} farms for one address: at most ${MAX_FARMS_PER_FARMER} at a time`);
					continue;
				}
				// A member already (only a verified account can be one) is on the list the owner reads.
				const role = user?.verified ? roleOf.get(user.id) : undefined;
				if (role && role !== 'farmer' && role !== 'contributor') {
					mark('error', `already a member of this project (${role})`);
					continue;
				}
				if (role) {
					// Already a farmer (or a contributor, WP-3.3): the rows add farms, they never take one away.
					const before = (await farmLinks(db, id)).filter((l) => l.userId === user!.id);
					await setLinks(db, id, user!.id, nodeIds, actor, false);
					await recordLinkChanges(db, id, before, (await farmLinks(db, id)).filter((l) => l.userId === user!.id), 'farmers_set');
					mark('added');
				} else {
					// Anyone else is invited, account or not (issue #136): 'invited' either way.
					const { mail } = await inviteFarmer(db, id, email, nodeIds, rows[0]!.locale, user, false);
					if (mail) mails.push(mail);
					mark('invited');
				}
			}
			if (body.dryRun) {
				await db.query('ROLLBACK TO SAVEPOINT bulk_preview');
				return { results, mails: [] };
			}
			return { results, mails };
		});
		for (const m of mails) await trySendMail(m);
		return c.json({ results, dryRun: body.dryRun });
	})
	// Replace a farmer's farms.
	.put('/:id/farmers/:userId', async (c) => {
		const body = LinksBody.parse(await readJson(c));
		const { id, userId } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'owner');
			if (!UUID.test(userId)) throw new ApiError(404, 'not found');
			const nodeIds = await assertFarms(db, id, body.nodeIds);
			// A farmer's, or a contributor's (045_contributor_scope: an applicant keeps their farm links).
			const { rows } = await db.query(`SELECT 1 FROM project_member WHERE project_id = $1 AND user_id = $2 AND role IN ('farmer', 'contributor')`, [id, userId]);
			if (!rows[0]) throw new ApiError(404, 'not found');
			const before = (await farmLinks(db, id)).filter((l) => l.userId === userId);
			await setLinks(db, id, userId, nodeIds, c.get('userId'));
			await recordLinkChanges(db, id, before, (await farmLinks(db, id)).filter((l) => l.userId === userId), 'farmers_set');
			const farmer = (await activeFarmers(db, id)).find((f) => f.userId === userId)!;
			return c.json({ farmer });
		});
	});
