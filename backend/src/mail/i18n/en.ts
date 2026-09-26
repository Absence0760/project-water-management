// English wording of every email a farmer can receive (WP-2.5): the frame
// every email shares, confirming an address, resetting a password, and the
// farmer invite. `{name}` is filled in by mailT (./index.ts); the value is
// HTML-escaped later, by the template, never here.
//
// Afrikaans lives in ./af.ts. A key that has no Afrikaans yet is sent in
// English and must be on docs/i18n/af-translation-sheet.md (guarded by
// ./catalogue.test.ts; regenerate the sheet with `pnpm gen:i18n:sheet`).
// No imports: scripts/guards/i18n_sheet.mjs loads this file directly.

export const en = {
	// The frame of every email (templates.ts render).
	'mail.buttonFallback': "If the button doesn't work, copy this address into your browser:",

	// Confirm your email address.
	'mail.verify.subject': 'Confirm your email address — {product}',
	'mail.verify.heading': 'Confirm your email address',
	'mail.verify.body': 'Please confirm that {email} is your email address for {product}.',
	'mail.verify.action': 'Confirm email address',
	'mail.verify.expires': 'This link expires in 48 hours.',
	'mail.verify.ignore': "If you didn't create an account, you can ignore this email.",

	// Reset your password.
	'mail.reset.subject': 'Reset your password — {product}',
	'mail.reset.heading': 'Reset your password',
	'mail.reset.body': 'Someone asked to reset the password for the {product} account {email}.',
	'mail.reset.signsOut': 'Choosing a new password signs you out on every device.',
	'mail.reset.action': 'Choose a new password',
	'mail.reset.expires': 'This link expires in 1 hour and works once.',
	'mail.reset.ignore': "If you didn't ask for this, you can ignore this email — your password stays the same.",

	// The farmer invite (WP-2.2).
	'mail.farmer.subject': '{inviter} has given you access to {farms} in {catchment}',
	'mail.farmer.heading': 'Your farm on {product}',
	'mail.farmer.body': '{inviter} has given you access to {farms} in {catchment}.',
	'mail.farmer.privacy': "You will see your own farm's water, dam and any restriction notice, and nothing about your neighbours' farms.",
	'mail.farmer.yourFarm': 'your farm',
	'mail.farmer.and': 'and',

	// Accepting an invite: shared by every invite email.
	'mail.invite.signUp': 'Create your {product} account with this email address ({email}) to accept.',
	'mail.invite.signUpAction': 'Create account and accept',
	'mail.invite.signUpExpires': 'This invitation expires in 7 days.',
	'mail.invite.signUpIgnore': "If you weren't expecting this, you can ignore this email.",
	'mail.invite.confirm': 'There is already a {product} account for {email}. Confirm that this is your email address to accept.',
	'mail.invite.confirmAction': 'Confirm email and accept',
	'mail.invite.confirmExpires': 'This link expires in 48 hours.',
	'mail.invite.confirmTakeOver':
		"If you never created a {product} account, someone else registered your address: don't confirm it — use “Forgot password” on the sign-in page to take the account over instead."
} as const;

export type MailKey = keyof typeof en;

/**
 * Where each group of keys appears, for the translator: the longest matching
 * key prefix names a key's section on the translation sheet. Every key must
 * fall in one (catalogue.test.ts).
 */
export const sections: Record<string, string> = {
	'mail.buttonFallback': 'Every email: the line under the button, followed by the link itself.',
	'mail.verify': 'Email: confirm your address. Sent after signing up, and again from “Resend email”.',
	'mail.reset': 'Email: reset your password. Sent from “Forgot password?” on the sign-in page.',
	'mail.farmer':
		'Email: the farmer invite. The WUA gives a farmer access to their farm(s) in a catchment. {farms} is one or more farm names joined with “and” (or “your farm”).',
	'mail.invite':
		'Email: the farmer invite, how to accept. “signUp” lines go to an address with no account yet; “confirm” lines to an address whose account is not confirmed yet.'
};

/** Notes for single keys, where the section doesn't say enough. */
export const notes: Partial<Record<MailKey, string>> = {
	'mail.farmer.yourFarm': 'Stands in for {farms} when the invite names no farm.',
	'mail.farmer.and': 'Joins the last two farm names: “Vaalbank and Rietvlei”.'
};
