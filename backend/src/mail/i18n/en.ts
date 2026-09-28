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

	// Someone signed up with an address that already has an account (auth/routes.ts /register).
	'mail.exists.subject': 'You already have an account — {product}',
	'mail.exists.heading': 'You already have an account',
	'mail.exists.body': 'Someone tried to create a {product} account for {email}, but this address already has one.',
	'mail.exists.signIn': 'If it was you, sign in with your password. If you’ve forgotten it, choose a new one:',
	'mail.exists.action': 'Choose a new password',
	'mail.exists.ignore': "If it wasn't you, you can ignore this email — nothing has changed on your account.",

	// The farmer invite (WP-2.2).
	'mail.farmer.subject': '{inviter} has given you access to {farms} in {catchment}',
	'mail.farmer.heading': 'Your farm on {product}',
	'mail.farmer.body': '{inviter} has given you access to {farms} in {catchment}.',
	'mail.farmer.privacy': "You will see your own farm's water, dam and any restriction notice, and nothing about your neighbours' farms.",
	'mail.farmer.estimate':
		'The figures you will see are worked out by a computer model of the catchment. They are estimates, not measurements or instructions, and they can be wrong. Only a notice from your WUA or from the Department of Water and Sanitation (DWS) is a restriction.',
	'mail.farmer.yourFarm': 'your farm',
	'mail.farmer.and': 'and',

	// Accepting an invite: shared by every invite email.
	'mail.invite.signUp': 'Create your {product} account with this email address ({email}) to accept.',
	'mail.invite.signUpAction': 'Create account and accept',
	'mail.invite.signUpExpires': 'This invitation expires in 7 days.',
	'mail.invite.signUpIgnore': "If you weren't expecting this, you can ignore this email.",
	'mail.invite.privacy': 'How we handle your information: {url}',
	'mail.invite.confirm': 'There is already a {product} account for {email}. Confirm that this is your email address to accept.',
	'mail.invite.confirmAction': 'Confirm email and accept',
	'mail.invite.confirmExpires': 'This link expires in 48 hours.',
	'mail.invite.confirmTakeOver':
		"If you never created a {product} account, someone else registered your address: don't confirm it — use “Forgot password” on the sign-in page to take the account over instead.",

	// Alert emails (WP-2.13): the frame shared by every alert and the digest.
	'mail.alert.subject': '{what} — {project}',
	'mail.alert.openFarm': 'Open your farm',
	'mail.alert.openProject': 'Open the catchment',
	'mail.alert.model':
		'This is the catchment model’s estimate, worked out from the figures your WUA published. It is not a measurement of your dam and not an instruction. Check your dam yourself, and ask your WUA if you are unsure. Only a notice from your WUA or from DWS is a restriction.',
	'mail.alert.model.dam.staff':
		'This is the catchment model’s estimate, worked out from the figures the WUA published. It is not a measurement of the dam and not an instruction. Only a notice from the WUA or from DWS is a restriction.',
	'mail.alert.model.staff':
		'This comes from the newest forecast run of the catchment model, which may not be published yet. It is an estimate, not a measurement, and not a restriction.',
	'mail.alert.why': 'You get this email because you get {kind} alerts for {project}.',
	'mail.alert.unsubscribe': 'Stop these emails',
	'mail.alert.manage': 'Manage your alerts',
	'mail.alert.digest.subject': 'Your alerts for {project} — {product}',
	'mail.alert.digest.heading': 'Your alerts for {project}',
	'mail.alert.digest.intro': 'Since the last summary:',
	'mail.alert.digest.more': '…and {more} more alerts. Open the catchment to see them all.',
	'mail.alert.digest.why': 'You get this daily summary because you chose daily alerts for {project}, or had more than {cap} alert emails in a day.',
	'mail.alert.digest.unsubscribe': 'Stop all alert emails for this catchment',

	// The kind names, in "you get {kind} alerts".
	'mail.alert.kind.dam_below': 'dam level',
	'mail.alert.kind.ewr_forecast_fail': 'river flow forecast',
	'mail.alert.kind.data_stale': 'missing data',
	'mail.alert.kind.restriction_published': 'restriction notice',
	'mail.alert.kind.job_dead': 'failed background job',
	'mail.alert.kind.feed_failing': 'failing data feed',

	// One alert each: the subject's {what}, the heading, the sentence.
	'mail.alert.dam.what': 'Dam low on {farm}',
	'mail.alert.dam.latest': 'The model puts the dam on {farm} at about {pct} of capacity on {date}, below the alert level of {threshold}.',
	'mail.alert.dam.forecast':
		'On the rain forecast of {madeOn}, the model expects the dam on {farm} to fall to about {pct} of capacity around {date}, below the alert level of {threshold}. Forecasts change.',
	'mail.alert.ewr.what': 'River flow at risk in the forecast',
	'mail.alert.ewr.body':
		'On the rain forecast of {madeOn}, the model expects the river’s ecological reserve (EWR) at the outlet to be missed on {days} of the {of} forecast days ({from} to {to}). The alert is set at {threshold} days. Forecasts change.',
	'mail.alert.stale.what': 'Data feed behind',
	'mail.alert.stale.body': 'These data feeds are more than {threshold} days later than usual:',
	'mail.alert.stale.line': '{feed}: newest day {newest}, {overdue} days late',
	'mail.alert.failing.what': 'Data feed failing',
	'mail.alert.failing.body': 'These data feeds have failed {threshold} or more times in a row:',
	'mail.alert.failing.line': '{feed}: {failures} failures in a row',
	'mail.alert.jobs.what': 'Background jobs failed',
	'mail.alert.jobs.body': '{count} background jobs failed for good in the last 24 hours. See the jobs list in the catchment.',
	'mail.alert.restriction.what': 'New restriction notice',
	'mail.alert.restriction.liftedWhat': 'Restriction lifted',
	'mail.alert.restriction.body': 'The WUA published a notice for {project} on {date}: {level}.',
	'mail.alert.restriction.bodyPct': 'The WUA published a notice for {project} on {date}: {level}, {pct} less water.',
	'mail.alert.restriction.lifted': 'The WUA lifted the restriction for {project} on {date}.',
	'mail.alert.restriction.notice': 'The WUA’s notice: “{notice}”',
	'mail.alert.restriction.level.none': 'no restriction',
	'mail.alert.restriction.level.advisory': 'please use less water (advisory)',
	'mail.alert.restriction.level.restricted': 'restricted',
	'mail.alert.restriction.wua':
		'This notice is the WUA’s own. It is shown here as the WUA published it. Questions about it go to your WUA.'
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
	'mail.exists': 'Email: sent when someone signs up with an address that already has a confirmed account. It says so, and offers a new password in case the owner forgot theirs. The sign-up page itself says the same thing either way (“check your email”), so it can’t be used to find out who has an account.',
	'mail.farmer':
		'Email: the farmer invite. The WUA gives a farmer access to their farm(s) in a catchment. {farms} is one or more farm names joined with “and” (or “your farm”).',
	'mail.invite':
		'Email: the farmer invite, how to accept. “signUp” lines go to an address with no account yet; “confirm” lines to an address whose account is not confirmed yet.',
	'mail.alert':
		'Alert emails (WP-2.13): sent when a figure crosses a line the WUA set (a farm dam running low, the WUA’s restriction notice). Worded as what the model estimates, never as a promise or an order. {what} is one of the “what” lines; {date} and {madeOn} are dates like “3 Oct 2026”; {pct} and {threshold} are percentages like “28 %”.',
	'mail.alert.digest': 'Alert emails: the daily summary (06:00), listing several alerts in one email.',
	'mail.alert.kind': 'Alert emails: the name of a kind of alert, inside “You get this email because you get {kind} alerts for {project}”.'
};

/** Notes for single keys, where the section doesn't say enough. */
export const notes: Partial<Record<MailKey, string>> = {
	'mail.farmer.yourFarm': 'Stands in for {farms} when the invite names no farm.',
	'mail.farmer.and': 'Joins the last two farm names: “Vaalbank and Rustenvrede”.',
	'mail.alert.subject': 'The alert email’s subject line: {what} is the alert (“Dam low on Vaalbank”), {project} the catchment.',
	'mail.alert.model.dam.staff': 'Under a dam alert sent to the WUA’s staff, not the farmer: the same as mail.alert.model, about a member’s dam.',
	'mail.alert.model.staff': 'Under the river-flow forecast alert, which only the WUA’s staff get.',
	'mail.alert.stale.line': 'One line per data feed; {overdue} is a number of days.',
	'mail.alert.restriction.body': '{level} is one of the level lines below.',
	'mail.alert.restriction.bodyPct': '{level} is one of the level lines below; {pct} is the WUA’s percentage, like “20 %”.'
};
