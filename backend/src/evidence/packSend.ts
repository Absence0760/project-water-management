// Send the full evidence pack to the responsible authority (licensing build
// item 13; provisional position, pre-counsel research, 2026-10-01;
// docs/evidence-pack.md § Sending it to the authority, docs/api.md § Evidence
// packs).
//
// An issued pack's PDF and reproduction bundle name every water user, so they
// go where NWA s41(2) says the evidence goes: to the authority that decides,
// never through the applicant (whose copy withholds the others' figures,
// 165_applicant_copy). An editor emails the members the project's owner
// marked as acting for the responsible authority (project_member
// .acts_for_authority and settings.responsibleAuthority, 163). The mail
// carries no file and no download link: it links the pack's page, where a
// signed-in editor gets a one-minute signed download, and the verify page.
// A forwarded mail opens nothing. `pack.sent` in the history names the
// recipients by id.
//
//  POST /projects/:id/packs/:packId/send   { userIds?, note? }   editor
import { packShortCode } from '@water-management/engine';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser } from '../db/tx.js';
import { recordAudit } from '../history/record.js';
import { readJson } from '../http/body.js';
import { ApiError, notFound } from '../http/errors.js';
import { packSentMail } from '../mail/templates.js';
import { trySendMail } from '../mail/transport.js';
import { requireRole, UUID } from '../projects/access.js';
import { projectAuthority } from '../projects/authoritySettings.js';

/** Most members one send reaches (a project has a handful acting for the authority). */
export const PACK_SEND_MAX = 20;

export const PackSendBody = z
	.object({
		/** Members acting for the authority; all of them (but the sender) when absent. */
		userIds: z.array(z.string().uuid()).min(1).max(PACK_SEND_MAX).optional(),
		note: z.string().trim().max(1000).optional()
	})
	.strict();

interface Recipient {
	userId: string;
	email: string;
	displayName: string;
}

export const packSendRoutes = new Hono<AuthEnv>().post('/:id/packs/:packId/send', async (c) => {
	const { id, packId } = c.req.param();
	const body = PackSendBody.parse((await readJson(c, { optional: true })) ?? {});
	const userId = c.get('userId');
	const out = await withUser(userId, async (db) => {
		await requireRole(db, id, 'editor');
		if (!UUID.test(packId)) throw notFound();
		const { rows: packs } = await db.query<{ title: string | null; version: number; status: string; manifestSha256: string; projectName: string }>(
			`SELECT p.manifest->'report'->'identity'->>'title' AS title, p.version, p.status, p.manifest_sha256 AS "manifestSha256", pr.name AS "projectName"
			 FROM evidence_pack p JOIN project pr ON pr.id = p.project_id WHERE p.project_id = $1 AND p.id = $2`,
			[id, packId]
		);
		const pack = packs[0];
		if (!pack) throw notFound();
		if (pack.status !== 'issued') throw new ApiError(409, `only an issued pack is sent to the authority; this one is ${pack.status}`);
		// The members acting for the authority: an editor or owner the project's owner marked (163). Never the sender.
		const { rows: acting } = await db.query<Recipient>(
			`SELECT m.user_id AS "userId", u.email, u.display_name AS "displayName"
			 FROM project_member m JOIN app_user u ON u.id = m.user_id
			 WHERE m.project_id = $1 AND m.acts_for_authority AND m.role IN ('editor', 'owner') AND m.user_id <> $2
			 ORDER BY u.display_name, m.user_id`,
			[id, userId]
		);
		if (!acting.length)
			throw new ApiError(409, 'no other member acts for the responsible authority: the project’s owner marks one in Members (actsForAuthority)');
		let recipients = acting;
		if (body.userIds) {
			const byId = new Map(acting.map((r) => [r.userId, r]));
			const unknown = body.userIds.filter((u) => !byId.has(u));
			// One answer for every id that isn't a member acting for the authority, whoever it belongs to.
			if (unknown.length) throw new ApiError(422, 'send it only to members acting for the responsible authority (members, actsForAuthority)');
			recipients = [...new Set(body.userIds)].map((u) => byId.get(u)!);
		}
		if (recipients.length > PACK_SEND_MAX) recipients = recipients.slice(0, PACK_SEND_MAX);
		const authority = await projectAuthority(db, id);
		const { rows: me } = await db.query<{ name: string }>('SELECT display_name AS name FROM app_user WHERE id = $1', [userId]);
		const shortCode = packShortCode(pack.manifestSha256);
		// Ids and counts only: the history is read by every viewer.
		await recordAudit(db, id, 'pack.sent', {
			packId,
			version: pack.version,
			shortCode,
			manifestSha256: pack.manifestSha256,
			recipients: recipients.map((r) => r.userId),
			authority: authority?.name ?? null,
			note: !!body.note
		});
		return { pack, shortCode, recipients, authority, sentBy: me[0]?.name ?? '' };
	});
	// After the commit, as invites are mailed: a mail outage never undoes the record, and says how many went.
	let sent = 0;
	for (const r of out.recipients) {
		const ok = await trySendMail(
			packSentMail(r.email, {
				projectId: id,
				packId,
				projectName: out.pack.projectName,
				title: out.pack.title ?? '',
				version: out.pack.version,
				shortCode: out.shortCode,
				sentBy: out.sentBy,
				authority: out.authority?.name ?? null,
				note: body.note || null
			})
		);
		if (ok) sent++;
	}
	return c.json({ recipients: out.recipients.map((r) => ({ userId: r.userId, displayName: r.displayName })), sent, failed: out.recipients.length - sent });
});
