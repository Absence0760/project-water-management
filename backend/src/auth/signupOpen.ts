// Whether anyone may sign up, or only the holder of a live invite for the
// address they sign up with (docs/security.md § Sign-up by invitation,
// docs/legal-status.md Gates A and C). POST /auth/register reads it.
//
// SIGNUP_OPEN=true opens sign-up, SIGNUP_OPEN=false limits it to invites.
// Unset, it is open locally (dev, the tests, the e2e server) and closed on
// Lambda, so production never opens by accident: Terraform sets it from
// var.signup_open, and a backend released before that apply is still closed.
// Read on every call, so a test can switch it.

export function signupOpen(env: Record<string, string | undefined> = process.env): boolean {
	const raw = env.SIGNUP_OPEN;
	if (raw === 'true') return true;
	if (raw === 'false') return false;
	if (raw === undefined || raw === '') return !env.AWS_LAMBDA_FUNCTION_NAME;
	throw new Error('SIGNUP_OPEN must be true or false');
}
