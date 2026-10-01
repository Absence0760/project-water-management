// The registration check (167_signers; docs/security.md § Professional
// sign-off → Registration check; provisional position, pre-counsel research,
// 2026-10-01). A signer types their SACNASP or ECSA registration in; the host
// checks it against the public register and the operator records that check
// (`pnpm import:registration-check`, scripts/registration-check.ts) in the
// insert-only registration_check table. Issuing a pack binds each sign-off
// to its signer's current check (app_pack_bind_registration_checks), and,
// while the requirement is on, refuses a pack whose specialist signer has
// none. Verify and the sign-off lists say "checked against the register"
// only from such a record; anything else is "self-declared".
import { ApiError } from '../http/errors.js';

/**
 * Whether issue requires every specialist signer's registration to be
 * checked: always in production (config/production.ts and this function
 * refuse `false` on Lambda), and locally unless REGISTRATION_CHECK_REQUIRED=false
 * (the DB tests and the e2e server, whose fixtures sign with invented
 * registrations; the tests of the requirement turn it back on). Read on every
 * call, so a test can switch it.
 */
export function registrationCheckRequired(env: Record<string, string | undefined> = process.env): boolean {
	const raw = env.REGISTRATION_CHECK_REQUIRED;
	if (raw === undefined || raw === '' || raw === 'true') return true;
	if (raw !== 'false') throw new Error('REGISTRATION_CHECK_REQUIRED must be true or false');
	if (env.AWS_LAMBDA_FUNCTION_NAME) throw new Error('REGISTRATION_CHECK_REQUIRED=false is for local tests only; Lambda always requires the registration check');
	return false;
}

/** The 409 for a pack whose specialist signers' registrations aren't checked yet. */
export const registrationNotChecked = (names: readonly string[]) =>
	ApiError.coded(
		409,
		'registration_not_checked',
		`the registration of ${names.join(', ')} hasn’t been checked against the professional register yet: the host checks it and the operator records the check, then issue the pack`,
		undefined,
		{ signers: [...names] }
	);
