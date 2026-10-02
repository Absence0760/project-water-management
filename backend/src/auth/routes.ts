import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { actAsUser, withoutUser, withUser, type Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { trySendMail } from '../mail/transport.js';
import { issueEmailToken, markVerified, verificationMail } from './email-routes.js';
import { answerAlike } from './accountMail.js';
import { accountDeletedMail, accountExistsMail, siteLink } from '../mail/templates.js';
import { lockOwnRoles, recordDeparture, soleHoldings, type Departure, type SoleHoldings } from './deleteAccount.js';
import { logEvent } from '../logging/logEvent.js';
import type { Mail } from '../mail/transport.js';
import { buildSubjectExport, ExportThrottled } from './export.js';
import { attachment } from '../export/csv.js';
import { DEFAULT_TIME_ZONE, localDate } from '../projects/timeZone.js';
import { requireUser, type AuthEnv } from './middleware.js';
import { DUMMY_HASH, hashPassword, verifyPassword } from './password.js';
import { clearSession, issueMfaChallenge, issueSession, revokeSession } from './session.js';
import { isEnrolled } from './mfa.js';
import { clearDevice, issueDevice, trustedDevice } from './device.js';
import { parseToken } from './tokens.js';
import { readJson } from '../http/body.js';
import { LOCALES, type Locale } from '../mail/i18n/index.js';
import { clientKey } from '../http/clientAddress.js';
import { countSignup } from './signupThrottle.js';
import { logLoginFailed, type LoginFailureRoute } from './loginFailed.js';
import { PREFERENCES_COL, PreferencesPatch, savePreferences, toPreferences } from './preferences.js';
import { FARMER_NOTICE_VERSION, LEGAL_VERSION } from '@water-management/engine/legal';

const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(8).max(200);
const displayName = z.string().trim().min(1).max(100);
/** app_user.locale (050, 080): the farmer-facing pages' and emails' language, any in the engine's language table; null = not chosen (follow the browser). */
const locale = z.enum(LOCALES).nullable();
/** app_user.volume_unit (050): how the farm view shows volumes. */
const volumeUnit = z.enum(['m3', 'ML']);

const RegisterBody = z.object({
	email,
	password,
	displayName,
	/** Token from an invite link (`/register?invite=…`). Signing up with it,
	 *  for the invited address, proves the inbox: the account starts verified
	 *  and joins the invited projects/teams straight away. */
	inviteToken: z.string().max(200).optional(),
	/** The language the sign-up page was in, when the person picked one there. */
	locale: z.enum(LOCALES).optional(),
	/** The version of the terms and privacy notice the form showed ("By signing
	 *  up, you accept …"): the engine's LEGAL_VERSION. Checked in the route,
	 *  so a missing or stale one gets its own code (terms_not_accepted). */
	acceptTerms: z.string().max(20).optional()
});
const LoginBody = z.object({ email, password: z.string().min(1).max(200) });
const MeBody = z
	.object({
		displayName: displayName.optional(),
		locale: locale.optional(),
		volumeUnit: volumeUnit.optional(),
		/** The person's own display preferences (083, auth/preferences.ts): the keys sent replace theirs. */
		preferences: PreferencesPatch.optional()
	})
	.refine((b) => b.displayName !== undefined || b.locale !== undefined || b.volumeUnit !== undefined || b.preferences !== undefined, {
		message: 'nothing to change: send displayName, locale, volumeUnit or preferences'
	});
/** "I understand" on the farm view's notice (093): the version the page showed. */
const FarmNoticeBody = z.object({ version: z.string().max(20) });

/** The re-acceptance step (docs/legal-status.md): the version the notice showed, the engine's LEGAL_VERSION. */
const AcceptTermsBody = z.object({ version: z.string().max(20) });
const ChangePasswordBody = z.object({ currentPassword: z.string().min(1).max(200), newPassword: password });
/** "Delete my account" (issue #112): the password, typed again. */
const DeleteMeBody = z.object({ password: z.string().min(1).max(200) });

/** 409 account_sole_holder: the projects and teams that would be left with no owner or admin, in `details`. */
const soleHolderError = (held: SoleHoldings) =>
	ApiError.coded(409, 'account_sole_holder', 'you are the only owner or admin of these projects and teams: hand them to someone else first', undefined, held);

/** A Postgres error raised by a check (23514): here, the deferred owner and admin checks at SET CONSTRAINTS. */
const isCheckViolation = (err: unknown) => (err as { code?: string } | null)?.code === '23514';

/**
 * The current password, checked through the sign-in lockout as
 * change-password does (a stolen session can't guess it any faster than the
 * sign-in form can). Returns the account's email, language and the hash
 * just checked (change-password writes only if it is still the one).
 */
async function checkPasswordAgain(c: Context<AuthEnv>, route: LoginFailureRoute, typed: string): Promise<{ email: string; locale: Locale | null; passwordHash: string }> {
	const userId = c.get('userId');
	// Counted in its own transaction before the bcrypt check, as in login.
	const { lockedSeconds, row } = await withUser(userId, async (db) => {
		const { rows } = await db.query<{ email: string; locale: Locale | null; password_hash: string; sessions_revoked_at: Date | null }>(
			'SELECT email, locale, password_hash, sessions_revoked_at FROM app_user WHERE id = $1',
			[userId]
		);
		const row = rows[0];
		if (!row) return { lockedSeconds: 0, row: undefined };
		return { lockedSeconds: await countAttempt(db, row.email, trustedDevice(c, row.email, row.sessions_revoked_at)), row };
	});
	if (!row) throw ApiError.coded(401, 'not_signed_in', 'not signed in');
	if (lockedSeconds > 0) {
		logLoginFailed(route, 'locked');
		c.header('Retry-After', String(lockedSeconds));
		throw ApiError.coded(429, 'signin_locked', lockedMessage(lockedSeconds), { seconds: lockedSeconds });
	}
	if (!(await verifyPassword(typed, row.password_hash))) {
		logLoginFailed(route, 'bad_password');
		throw ApiError.coded(403, 'wrong_current_password', 'your current password is wrong');
	}
	return { email: row.email, locale: row.locale, passwordHash: row.password_hash };
}

/**
 * Sign-in lockout per address: the 5th attempt in a row without a correct
 * password locks the address for 1 minute, and each attempt after a lock
 * doubles it, up to 15 minutes. A correct password or a password reset clears
 * it; a day without attempts forgets it.
 */
export const LOGIN_THROTTLE = { freeAttempts: 5, baseLock: '1 minute', maxLock: '15 minutes' } as const;

/**
 * Counts one attempt against the lockout; the seconds left on a lock, or 0 to
 * go ahead. On a trusted device (auth/device.ts) it is that device's own
 * record for the address (070), otherwise the address's shared one (005).
 */
export async function countAttempt(db: Db, address: string, device: string | null): Promise<number> {
	const { rows } = await db.query<{ locked: number }>(
		device
			? 'SELECT app_login_device_attempt($1, $5, $2, $3::interval, $4::interval) AS locked'
			: 'SELECT app_login_attempt($1, $2, $3::interval, $4::interval) AS locked',
		[address, LOGIN_THROTTLE.freeAttempts, LOGIN_THROTTLE.baseLock, LOGIN_THROTTLE.maxLock, ...(device ? [device] : [])]
	);
	return rows[0]?.locked ?? 0;
}

/** A correct password clears the record it was counted on: the device's own, or the address's (and its devices'). */
async function attemptSucceeded(db: Db, address: string, device: string | null): Promise<void> {
	if (device) await db.query('SELECT app_login_device_succeeded($1, $2)', [address, device]);
	else await db.query('SELECT app_login_succeeded($1)', [address]);
}

export function lockedMessage(seconds: number): string {
	const wait = seconds <= 60 ? 'a minute' : `${Math.ceil(seconds / 60)} minutes`;
	return `too many sign-in attempts for this address — try again in ${wait}, or reset your password`;
}

export type UserRow = {
	id: string;
	email: string;
	display_name: string;
	email_verified_at: Date | null;
	locale: Locale | null;
	volume_unit: 'm3' | 'ML';
	mail_suppressed_at: Date | null;
	mail_suppressed_reason: 'bounce' | 'complaint' | null;
	preferences: unknown;
	terms_version: string | null;
	farm_notice_version: string | null;
};
export const toUser = (r: UserRow) => ({
	id: r.id,
	email: r.email,
	displayName: r.display_name,
	emailVerified: r.email_verified_at !== null,
	locale: r.locale,
	volumeUnit: r.volume_unit,
	// SES reported a bounce or complaint for the address (057): alert emails are paused (the banner, POST /me/alerts/resume).
	mailSuppressed: r.mail_suppressed_at ? { reason: r.mail_suppressed_reason!, at: r.mail_suppressed_at.toISOString() } : null,
	// The person's own display preferences (083): the sections they hid from the workspace sidebar.
	preferences: toPreferences(r.preferences),
	// Accepted the terms and privacy notice now in force (087): false for an
	// account from before a new version, or made by a script (accepted none).
	termsCurrent: r.terms_version === LEGAL_VERSION,
	// The version accepted (null: none), so the re-acceptance step lists every change since it, not only the latest version's.
	termsVersion: r.terms_version,
	// Acknowledged the farm view's notice now in force (093): false until the
	// farmer presses "I understand", and again after a new version.
	farmNoticeCurrent: r.farm_notice_version === FARMER_NOTICE_VERSION
});
export const USER_COLS = `id, email, display_name, email_verified_at, locale, volume_unit, mail_suppressed_at, mail_suppressed_reason, terms_version, farm_notice_version, ${PREFERENCES_COL}`;

/**
 * The email for a sign-up with an address that already has an account: a
 * fresh confirmation link if the account was never confirmed, else "you
 * already have an account" with a password-reset link. Null when the
 * address's cooldown or daily cap holds it back (the sign-up answer is the
 * same either way).
 */
async function takenAddressMail(db: Db, address: string): Promise<Mail | null> {
	const { rows } = await db.query<{ id: string; email: string; locale: Locale | null }>('SELECT id, email, locale FROM app_auth_account($1)', [address]);
	const owner = rows[0];
	if (!owner) return null;
	await actAsUser(db, owner.id);
	const { rows: me } = await db.query<{ verified: boolean }>('SELECT email_verified_at IS NOT NULL AS verified FROM app_user WHERE id = $1', [owner.id]);
	if (!me[0]?.verified) {
		const sent = await verificationMail(db, owner.id, owner.email);
		return 'mail' in sent ? sent.mail : null;
	}
	const issued = await issueEmailToken(db, owner.id, 'reset');
	return 'token' in issued ? accountExistsMail(owner.email, siteLink('/reset-password', issued.token), owner.locale) : null;
}

export const authRoutes = new Hono<AuthEnv>()
	// Sign-up (issue #57, the flow threkir uses): an ordinary sign-up creates
	// the account and emails a confirmation link, and signs nobody in: the
	// person confirms, then signs in (POST /login refuses an unconfirmed
	// account, email_unconfirmed). The answer is the same 202 whether the
	// address was free or taken, so sign-up can't be used to find out who has
	// an account: a taken address gets an email instead (a fresh confirmation
	// link if it was never confirmed, else "you already have an account" with
	// a password-reset link), under the address's cooldown and daily cap.
	// Signing up through an invite for exactly this address proves the inbox:
	// that account starts confirmed, joins straight away and is signed in (201).
	.post('/register', async (c) => {
		const body = RegisterBody.parse(await readJson(c));
		// The form's "By signing up, you accept …" (087, docs/legal-status.md):
		// the version it showed must be the one in force. A page loaded before
		// the terms changed sends the old one: reload and read them again.
		if (body.acceptTerms !== LEGAL_VERSION) {
			throw ApiError.coded(400, 'terms_not_accepted', 'accept the current terms of use and privacy notice to sign up', { version: LEGAL_VERSION });
		}
		// Sign-up throttle (079_signup_throttle.sql, auth/signupThrottle.ts):
		// counted per client address and in all, in its own transaction before
		// the address is looked at, so a taken and a free address get the same
		// 429 once throttled.
		const wait = await withoutUser((db) => countSignup(db, clientKey(c)));
		if (wait > 0) {
			c.header('Retry-After', String(wait));
			throw ApiError.coded(429, 'signup_throttled', 'too many sign-ups from your network — try again later', { seconds: wait });
		}
		const hash = await hashPassword(body.password);
		const inviteHash = body.inviteToken ? parseToken(body.inviteToken) : null;
		type Outcome = { kind: 'joined'; row: UserRow } | { kind: 'confirm'; mail: Mail | null } | { kind: 'taken'; mail: Mail | null };
		const result = await withoutUser(async (db): Promise<Outcome> => {
			// app_user is under RLS (068): the insert goes through app_register,
			// and from then on this transaction is the new account's.
			const { rows: created } = await db.query<{ id: string | null }>('SELECT app_register($1, $2, $3, $4, $5) AS id', [
				body.email,
				body.displayName,
				hash,
				body.locale ?? null,
				LEGAL_VERSION
			]);
			const id = created[0]?.id;
			if (!id) return { kind: 'taken', mail: await takenAddressMail(db, body.email) };
			await actAsUser(db, id);
			const row = (await db.query<UserRow>(`SELECT ${USER_COLS} FROM app_user WHERE id = $1`, [id])).rows[0]!;
			// A live invite for exactly this address proves the inbox.
			if (inviteHash) {
				const { rows: inv } = await db.query<{ email: string }>('SELECT email FROM app_invite_for_token($1)', [
					inviteHash
				]);
				if (inv[0] && inv[0].email.toLowerCase() === row.email.toLowerCase()) {
					await markVerified(db, row.id);
					// Accepting may have set the locale from the invite (050).
					const { rows: fresh } = await db.query<UserRow>(`SELECT ${USER_COLS} FROM app_user WHERE id = $1`, [row.id]);
					return { kind: 'joined', row: fresh[0]! };
				}
			}
			const verify = await verificationMail(db, row.id, row.email);
			return { kind: 'confirm', mail: 'mail' in verify ? verify.mail : null };
		});
		// An invite link names its address, so saying it's taken there tells the holder nothing new.
		if (result.kind === 'taken' && inviteHash) throw ApiError.coded(409, 'account_exists', 'an account with that email already exists');
		if (result.kind !== 'joined') {
			if (result.mail) await trySendMail(result.mail);
			return c.json({ confirm: true as const, email: body.email }, 202);
		}
		await issueSession(c, result.row.id);
		// A new account has no watermark yet.
		issueDevice(c, result.row.email, null);
		return c.json({ user: toUser(result.row) }, 201);
	})
	// "Send the link again" on the sign-in page, signed out (issue #57). Always
	// the same 202 after the same time, whether or not the address has an account or still needs
	// confirming, so it can't be used to discover accounts; a link goes out
	// only to an unconfirmed account, under the cooldown and daily cap (078).
	.post('/resend-confirmation', async (c) => {
		const body = z.object({ email }).parse(await readJson(c));
		// The same time for every address too: the send isn't awaited (auth/accountMail.ts).
		await answerAlike(() =>
			withoutUser(async (db) => {
				const { rows } = await db.query<{ id: string; email: string }>('SELECT id, email FROM app_auth_account($1)', [body.email]);
				const user = rows[0];
				if (!user) return null;
				await actAsUser(db, user.id);
				const { rows: me } = await db.query<{ verified: boolean }>('SELECT email_verified_at IS NOT NULL AS verified FROM app_user WHERE id = $1', [user.id]);
				if (me[0]?.verified !== false) return null;
				const sent = await verificationMail(db, user.id, user.email);
				return 'mail' in sent ? sent.mail : null;
			})
		);
		return c.json({ ok: true }, 202);
	})
	.post('/login', async (c) => {
		const body = LoginBody.parse(await readJson(c));
		// Per-address lockout (005_login_throttle.sql). Counted in its own
		// transaction before the password check, so parallel guesses queue on
		// the row lock and can't all get past it. Keyed by the typed address,
		// so an unknown address is locked exactly like a real one; a device
		// that signed in to the address before counts on its own record
		// (070, auth/device.ts), so a stranger's lock doesn't shut it out.
		const { lockedSeconds, row, device } = await withoutUser(async (db) => {
			// app_user is under RLS (068) and nobody is signed in yet: the one-address lookups.
			const { rows } = await db.query<{ id: string; email: string; password_hash: string }>(
				'SELECT id, email, password_hash FROM app_auth_account($1)',
				[body.email]
			);
			const found = rows[0];
			const watermark = found
				? ((await db.query<{ sessions_revoked_at: Date | null }>('SELECT sessions_revoked_at FROM app_session_revoked_at($1)', [found.id]))
						.rows[0]?.sessions_revoked_at ?? null)
				: null;
			const device = found ? trustedDevice(c, found.email, watermark) : null;
			const lockedSeconds = await countAttempt(db, body.email, device);
			return { lockedSeconds, row: lockedSeconds > 0 || !found ? undefined : { ...found, sessions_revoked_at: watermark }, device };
		});
		if (lockedSeconds > 0) {
			logLoginFailed('/auth/login', 'locked');
			c.header('Retry-After', String(lockedSeconds));
			throw ApiError.coded(429, 'signin_locked', lockedMessage(lockedSeconds), { seconds: lockedSeconds });
		}
		const ok = await verifyPassword(body.password, row?.password_hash ?? DUMMY_HASH);
		if (!row || !ok) {
			// One line counted across all accounts (auth/loginFailed.ts): the
			// reason tells the operator an unknown address from a wrong
			// password; the answer below is the same for both.
			logLoginFailed('/auth/login', row ? 'bad_password' : 'unknown_account');
			throw ApiError.coded(401, 'wrong_credentials', 'wrong email or password');
		}
		// The password proved the account: read it as its owner.
		const found = await withUser(row.id, async (db) => {
			await attemptSucceeded(db, body.email, device);
			const user = (await db.query<UserRow>(`SELECT ${USER_COLS} FROM app_user WHERE id = $1`, [row.id])).rows[0];
			return user ? { user, twoStep: await isEnrolled(db, row.id) } : undefined;
		});
		if (!found) throw ApiError.coded(401, 'wrong_credentials', 'wrong email or password');
		const { user } = found;
		// The password is right, but the address was never confirmed (issue
		// #57): no session until it is. Said only after a correct password, so
		// it tells nothing to someone who doesn't know it. The sign-in page
		// offers the link again (POST /resend-confirmation).
		if (user.email_verified_at === null) throw ApiError.coded(403, 'email_unconfirmed', 'confirm your email address first: open the link we emailed you');
		// Two-step sign-in (issue #282, auth/mfa-routes.ts): with an
		// authenticator, the password buys a 5-minute challenge, not a
		// session; POST /auth/mfa/verify trades it and a code for one (and
		// sets the device cookie then). Nothing about the account is said
		// before the code.
		if (found.twoStep) {
			await issueMfaChallenge(c, row.id);
			return c.json({ mfaRequired: true as const });
		}
		await issueSession(c, row.id);
		issueDevice(c, row.email, row.sessions_revoked_at);
		return c.json({ user: toUser(user) });
	})
	// Signs this session out on the server too (its id is revoked, session.ts
	// revokeSession), so a copied cookie stops working with the one cleared here.
	.post('/logout', async (c) => {
		await revokeSession(c);
		clearSession(c);
		return c.body(null, 204);
	})
	// Sign out every device, this one included: move the session watermark to
	// now, so every session issued before it is rejected (session.ts).
	.post('/logout-everywhere', requireUser, async (c) => {
		// This server's clock, the one that stamps session iat_ms (see reset-password).
		await withUser(c.get('userId'), (db) =>
			db.query('UPDATE app_user SET sessions_revoked_at = $2 WHERE id = $1', [c.get('userId'), new Date()])
		);
		clearSession(c);
		// The watermark moved, so every device cookie is void anyway (device.ts); drop this one too.
		clearDevice(c);
		return c.body(null, 204);
	})
	.get('/me', requireUser, async (c) => {
		const row = await withUser(c.get('userId'), async (db) => {
			const { rows } = await db.query<UserRow>(`SELECT ${USER_COLS} FROM app_user WHERE id = $1`, [
				c.get('userId')
			]);
			return rows[0];
		});
		if (!row) throw ApiError.coded(401, 'not_signed_in', 'not signed in');
		// The report renderer's session (reports/scope.ts) says so: the page
		// renders the report route for it, never the terms re-acceptance step
		// (+layout.svelte termsGate), which only a person can pass. It can read
		// one report and nothing else, and can't accept anything.
		return c.json({ user: { ...toUser(row), ...(c.get('renderSession') ? { renderSession: true } : {}) } });
	})
	// "Download my data" (POPIA access; auth/export.ts): everything the app
	// keeps about the signed-in person, as a JSON file. One a minute per account.
	.get('/me/export', requireUser, async (c) => {
		let doc;
		try {
			doc = await buildSubjectExport(c.get('userId'));
		} catch (err) {
			if (!(err instanceof ExportThrottled)) throw err;
			c.header('Retry-After', String(err.retryAfter));
			throw ApiError.coded(429, 'export_throttled', 'you downloaded your data a moment ago — try again in a minute', { seconds: err.retryAfter });
		}
		return c.body(JSON.stringify(doc, null, 2), 200, {
			'Content-Type': 'application/json; charset=utf-8',
			'Content-Disposition': attachment(`my-data_${localDate(new Date(doc.exportedAt), DEFAULT_TIME_ZONE)}.json`),
			'Cache-Control': 'no-store'
		});
	})
	.patch('/me', requireUser, async (c) => {
		const body = MeBody.parse(await readJson(c));
		// Only the fields sent change; locale may be set back to null (follow the browser).
		const row = await withUser(c.get('userId'), async (db) => {
			// First, so the UPDATE's RETURNING (a later statement) reads the saved document.
			if (body.preferences) await savePreferences(db, c.get('userId'), body.preferences);
			const { rows } = await db.query<UserRow>(
				`UPDATE app_user SET
					display_name = coalesce($2, display_name),
					locale = CASE WHEN $3::boolean THEN $4 ELSE locale END,
					volume_unit = coalesce($5, volume_unit)
				 WHERE id = $1 RETURNING ${USER_COLS}`,
				[c.get('userId'), body.displayName ?? null, body.locale !== undefined, body.locale ?? null, body.volumeUnit ?? null]
			);
			return rows[0];
		});
		if (!row) throw ApiError.coded(401, 'not_signed_in', 'not signed in');
		return c.json({ user: toUser(row) });
	})
	// "I understand" on the farm view's "Before you look at your farm" notice
	// (093, docs/legal/disclaimer-review.md § 3): records the version the page
	// showed, which must be the one in force (a page loaded before the words
	// changed sends the old one: reload and read it again). The database
	// stamps the time.
	.post('/me/farm-notice', requireUser, async (c) => {
		const body = FarmNoticeBody.parse(await readJson(c));
		if (body.version !== FARMER_NOTICE_VERSION) {
			throw ApiError.coded(409, 'farm_notice_changed', 'the farm notice changed since the page opened — reload and read it again', { version: FARMER_NOTICE_VERSION });
		}
		const row = await withUser(c.get('userId'), async (db) => {
			const { rows } = await db.query<UserRow>(`UPDATE app_user SET farm_notice_version = $2 WHERE id = $1 RETURNING ${USER_COLS}`, [
				c.get('userId'),
				FARMER_NOTICE_VERSION
			]);
			return rows[0];
		});
		if (!row) throw ApiError.coded(401, 'not_signed_in', 'not signed in');
		return c.json({ user: toUser(row) });
	})
	// The re-acceptance step (docs/legal-status.md): a signed-in account whose
	// termsCurrent is false accepts the version in force. A stale version (a
	// page opened before the terms changed again) is refused like sign-up's;
	// app_user_terms_stamp (087) stamps the time.
	.post('/me/accept-terms', requireUser, async (c) => {
		const body = AcceptTermsBody.parse(await readJson(c));
		if (body.version !== LEGAL_VERSION) {
			throw ApiError.coded(400, 'terms_not_accepted', 'accept the current terms of use and privacy notice', { version: LEGAL_VERSION });
		}
		const row = await withUser(c.get('userId'), async (db) => {
			const { rows } = await db.query<UserRow>(`UPDATE app_user SET terms_version = $2 WHERE id = $1 RETURNING ${USER_COLS}`, [
				c.get('userId'),
				LEGAL_VERSION
			]);
			return rows[0];
		});
		if (!row) throw ApiError.coded(401, 'not_signed_in', 'not signed in');
		return c.json({ user: toUser(row) });
	})
	// "Delete my account" (issue #112; POPIA s24; 143_delete_my_account.sql,
	// auth/deleteAccount.ts). The password is typed again. The only owner of a
	// project or only admin of a team is refused with 409 account_sole_holder,
	// naming them, until they hand it over: read up front as the person, with
	// the owner and admin rows locked first (lockOwnRoles), so a co-owner
	// deleting or leaving at the same moment waits instead of both passing,
	// and the database's deferred checks fired again inside the request by
	// SET CONSTRAINTS. Otherwise, as the person under RLS: an audit event in every
	// project and team they belonged to, then app_delete_my_account(), the
	// same deletion the operator runs (keep the evidence, remove the name).
	// Then this browser's cookies go, and an email says what was done (s24(4)).
	.delete('/me', requireUser, async (c) => {
		const body = DeleteMeBody.parse(await readJson(c));
		const userId = c.get('userId');
		const account = await checkPasswordAgain(c, '/auth/me', body.password);
		type Outcome = { kind: 'held'; held: SoleHoldings } | { kind: 'deleted'; left: Departure };
		let outcome: Outcome;
		try {
			outcome = await withUser(userId, async (db): Promise<Outcome> => {
				await lockOwnRoles(db, userId);
				const held = await soleHoldings(db, userId);
				if (held.projects.length || held.teams.length) return { kind: 'held', held };
				const left = await recordDeparture(db, userId);
				const { rows } = await db.query<{ gone: boolean }>('SELECT app_delete_my_account() AS gone');
				if (!rows[0]?.gone) throw ApiError.coded(401, 'not_signed_in', 'not signed in');
				await db.query('SET CONSTRAINTS ALL IMMEDIATE');
				return { kind: 'deleted', left };
			});
		} catch (err) {
			// A co-owner or co-admin left between the check and the delete: say which, as above.
			if (!isCheckViolation(err)) throw err;
			const held = await withUser(userId, (db) => soleHoldings(db, userId));
			if (!held.projects.length && !held.teams.length) throw err;
			outcome = { kind: 'held', held };
		}
		if (outcome.kind === 'held') throw soleHolderError(outcome.held);
		clearSession(c);
		clearDevice(c);
		// The account's random id only, never an address or a name: if the database instance itself is lost, a restore
		// re-applies the erasures since LatestRestorableTime from these lines (deployment.md § Restoring the database,
		// step 6a); otherwise the erasure_log table on the old instance has them (159).
		logEvent('info', { event: 'account_deleted', via: 'self', accountId: userId });
		await trySendMail(accountDeletedMail(account.email, outcome.left, account.locale));
		return c.body(null, 204);
	})
	// Change the password while signed in. The current password is checked
	// through the sign-in lockout (a stolen session can't guess it any faster
	// than the login form can), then every session is revoked, and this device
	// gets a fresh cookie so it stays signed in.
	.post('/change-password', requireUser, async (c) => {
		const body = ChangePasswordBody.parse(await readJson(c));
		const userId = c.get('userId');
		const row = await checkPasswordAgain(c, '/auth/change-password', body.currentPassword);
		const newHash = await hashPassword(body.newPassword);
		const watermark = new Date();
		// As the user (withUser), so email_token's RLS lets the reset links be deleted.
		const user = await withUser(userId, async (db) => {
			// Only if the hash is still the one just checked: a concurrent change
			// or reset in between wins, and this one is refused below.
			const { rows } = await db.query<UserRow>(
				`UPDATE app_user SET password_hash = $3, sessions_revoked_at = $4
				 WHERE id = $1 AND password_hash = $2 RETURNING ${USER_COLS}`,
				// Watermark from this server's clock, the one that stamps session iat_ms.
				[userId, row.passwordHash, newHash, watermark]
			);
			const updated = rows[0];
			if (!updated) return undefined;
			// Outstanding reset links die with the old password, and the lockout count clears.
			await db.query("DELETE FROM email_token WHERE user_id = $1 AND purpose = 'reset'", [userId]);
			await db.query('SELECT app_login_succeeded($1)', [updated.email]);
			return updated;
		});
		if (!user) throw ApiError.coded(409, 'password_changed_elsewhere', 'your password was changed somewhere else a moment ago — sign in again');
		// Issued after the watermark, so this device stays signed in, and stays
		// trusted, signed in the way it was (a second factor isn't lost by changing the password).
		await issueSession(c, userId, undefined, c.get('amr'));
		issueDevice(c, user.email, watermark);
		return c.json({ user: toUser(user) });
	});
