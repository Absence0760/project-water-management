// The registration check (167_signers; docs/security.md § Professional
// sign-off → Registration check; licensing positions item 9, provisional
// position, pre-counsel research, 2026-10-01). A signer types their SACNASP
// or ECSA registration in; the project's host checks it against the public
// register and an owner records that check in the app
// (POST /projects/:id/members/:userId/registration-checks,
// app_record_registration_check), never the operator. Issuing a pack binds
// each sign-off to its signer's current check in the project
// (app_pack_bind_registration_checks) and, while the project requires it
// (project.require_registration_check, on by default), refuses a pack whose
// specialist signer has none. Verify and the sign-off lists say "checked
// against the register" only from such a record; anything else is
// "self-declared".
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { REGISTRATION_BODIES, type RegistrationBodyCode } from '@water-management/engine';
import { withUser, type Db } from '../db/tx.js';
import { recordAudit } from '../history/record.js';
import { readJson } from '../http/body.js';
import { ApiError, notFound } from '../http/errors.js';
import { requireRole, UUID } from '../projects/access.js';

/**
 * Whether the deployment lets a project require the check: always in
 * production (config/production.ts and this function refuse `false` on
 * Lambda), and locally unless REGISTRATION_CHECK_REQUIRED=false (the DB tests
 * and the e2e server, whose fixtures sign with invented registrations; the
 * tests of the requirement turn it back on). Read on every call, so a test can
 * switch it. The project's own setting decides within it.
 */
export function registrationCheckRequired(env: Record<string, string | undefined> = process.env): boolean {
	const raw = env.REGISTRATION_CHECK_REQUIRED;
	if (raw === undefined || raw === '' || raw === 'true') return true;
	if (raw !== 'false') throw new Error('REGISTRATION_CHECK_REQUIRED must be true or false');
	if (env.AWS_LAMBDA_FUNCTION_NAME) throw new Error('REGISTRATION_CHECK_REQUIRED=false is for local tests only; Lambda always lets a project require the registration check');
	return false;
}

/** Whether issuing this project's packs waits for the check: the owner's setting, within the deployment's switch. */
export async function projectRequiresRegistrationCheck(db: Db, projectId: string): Promise<boolean> {
	if (!registrationCheckRequired()) return false;
	const { rows } = await db.query<{ r: boolean }>('SELECT require_registration_check AS r FROM project WHERE id = $1', [projectId]);
	return rows[0]?.r ?? true;
}

/** The 409 for a pack whose specialist signers' registrations aren't checked yet. */
export const registrationNotChecked = (names: readonly string[]) =>
	ApiError.coded(
		409,
		'registration_not_checked',
		`the registration of ${names.join(', ')} hasn’t been checked against the professional register yet: an owner of the project checks it and records the check on the Members page, then issue the pack`,
		undefined,
		{ signers: [...names] }
	);

const BODIES = REGISTRATION_BODIES.map((b) => b.code) as [RegistrationBodyCode, ...RegistrationBodyCode[]];
const line = (max: number) =>
	z
		.string()
		.transform((s) => s.trim())
		.pipe(z.string().min(1).max(max).refine((s) => !/[\u0000-\u001f]/.test(s), 'must be one line of text'));

export const RegistrationCheckBody = z
	.object({
		registrationBody: z.enum(BODIES),
		registrationCategory: z.string().regex(/^[a-z_]{1,40}$/, 'must be a registration code'),
		registrationNo: line(50),
		/** The name as the register shows it. */
		registerName: line(200),
		outcome: z.enum(['registered', 'not_registered']),
		/** The organisation that checked: the host, as it would sign a letter. */
		checkedByOrg: line(200),
		/** When the register was consulted (ISO date or date-time); not in the future. */
		checkedAt: z.string().datetime({ offset: true }).or(z.string().date()),
		note: z.string().max(1000).default('')
	})
	.strict();

export interface RegistrationCheckRow {
	id: string;
	userId: string | null;
	registrationBody: string;
	registrationCategory: string;
	registrationNo: string;
	registerName: string;
	outcome: 'registered' | 'not_registered';
	checkedByOrg: string;
	checkedAt: string;
	note: string;
	recordedBy: string | null;
	recordedAt: string;
}

const SELECT = `SELECT c.id::text AS id, c.user_id AS "userId", c.registration_body AS "registrationBody", c.registration_category AS "registrationCategory",
	c.registration_no AS "registrationNo", c.register_name AS "registerName", c.outcome, c.checked_by_org AS "checkedByOrg", c.checked_at AS "checkedAt",
	c.note, u.display_name AS "recordedBy", c.recorded_at AS "recordedAt"
	FROM registration_check c LEFT JOIN app_user u ON u.id = c.recorded_by`;

/**
 * GET  /projects/:id/registration-checks: the project's checks, newest first (editor).
 * POST /projects/:id/members/:userId/registration-checks: record the host's check of a member's registration (owner).
 * PUT  /projects/:id/registration-check-required { required }: whether issue waits for it (owner).
 */
export const registrationCheckRoutes = new Hono<AuthEnv>()
	.get('/:id/registration-checks', async (c) =>
		withUser(
			c.get('userId'),
			async (db) => {
				const id = c.req.param('id');
				await requireRole(db, id, 'editor');
				const { rows } = await db.query<RegistrationCheckRow>(`${SELECT} WHERE c.project_id = $1 ORDER BY c.checked_at DESC, c.id DESC`, [id]);
				const { rows: p } = await db.query<{ r: boolean }>('SELECT require_registration_check AS r FROM project WHERE id = $1', [id]);
				return c.json({ checks: rows, required: (p[0]?.r ?? true) && registrationCheckRequired() });
			},
			{ readOnly: true }
		)
	)
	.post('/:id/members/:userId/registration-checks', async (c) => {
		const body = RegistrationCheckBody.parse(await readJson(c));
		const { id, userId } = c.req.param();
		const checkedAt = new Date(body.checkedAt);
		if (Number.isNaN(checkedAt.getTime()) || checkedAt.getTime() > Date.now() + 60_000) throw new ApiError(400, 'checkedAt must be a date that has passed');
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'owner');
			if (!UUID.test(userId)) throw notFound();
			const { rows: member } = await db.query<{ displayName: string }>(
				`SELECT u.display_name AS "displayName" FROM project_member m JOIN app_user u ON u.id = m.user_id WHERE m.project_id = $1 AND m.user_id = $2`,
				[id, userId]
			);
			if (!member[0]) throw notFound();
			const { rows } = await db.query<{ id: string }>(
				'SELECT app_record_registration_check($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)::text AS id',
				[id, userId, body.registrationBody, body.registrationCategory, body.registrationNo, body.registerName, body.outcome, body.checkedByOrg, checkedAt, body.note]
			);
			await recordAudit(db, id, 'registration.checked', {
				userId,
				displayName: member[0].displayName,
				registrationBody: body.registrationBody,
				registrationNo: body.registrationNo,
				outcome: body.outcome,
				checkedByOrg: body.checkedByOrg
			});
			const { rows: out } = await db.query<RegistrationCheckRow>(`${SELECT} WHERE c.id = $1::bigint`, [rows[0]!.id]);
			return c.json({ check: out[0] }, 201);
		});
	})
	.put('/:id/registration-check-required', async (c) => {
		const body = z.object({ required: z.boolean() }).strict().parse(await readJson(c));
		const id = c.req.param('id');
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'owner');
			const { rows } = await db.query<{ was: boolean }>(
				'UPDATE project p SET require_registration_check = $2 FROM project o WHERE p.id = $1 AND o.id = p.id RETURNING o.require_registration_check AS was',
				[id, body.required]
			);
			if (!rows[0]) throw notFound();
			if (rows[0].was !== body.required) await recordAudit(db, id, 'registration.requirement', { required: body.required });
			return c.json({ required: body.required && registrationCheckRequired() });
		});
	});
