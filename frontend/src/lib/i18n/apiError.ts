// A failed request in the reader's language, on the translated pages (the
// sign-in, account, alert and farm pages; WP-2.5, docs/ui.md § Language).
//
// The API sends a stable `code` (and `params`) with each error a farmer can
// meet (docs/api.md § Errors), and the English `error` text for developers.
// These pages word an error from its code, else from its status, and never
// show the server's English: the decision is stable codes, translated here,
// rather than the server localising its messages (the catalogue, the sheet
// and the translator's review then cover every word a farmer reads, and the
// API's text stays one language for integrators and logs).
//
// The workspace doesn't use this: it shows the server's message as it is.
import { msg, plural, t, tn, type Msg } from './locale.svelte';

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v));

/** Each code's words (backend/src/http/errors.ts ERROR_CODES; apiError.test.ts checks every code has them). */
const CODES: Record<string, Msg> = {
	// i18n-section: error
	not_signed_in: msg('You’re not signed in. Sign in and try again.'),
	account_exists: msg('An account with that email address already exists. Sign in, or reset your password.'),
	wrong_credentials: msg('Wrong email or password.'),
	email_unconfirmed: msg('Confirm your email address before you sign in: open the link we emailed you.'),
	signin_locked: msg('Too many sign-in attempts for this address. Try again in {wait}, or reset your password.'),
	signup_throttled: msg('Too many accounts were made from your network. Try again in {wait}.'),
	terms_not_accepted: msg('The Terms of use or Privacy notice changed since this page opened. Reload the page and read them again.'),
	wrong_current_password: msg('Your current password is wrong.'),
	password_changed_elsewhere: msg('Your password was changed somewhere else a moment ago. Sign in again.'),
	link_invalid: msg('This link is invalid or has expired. Ask for a new one.'),
	already_verified: msg('Your email address is already confirmed.'),
	verification_sent_recently: msg('A confirmation email was sent a moment ago. Check your inbox, or try again in a minute.'),
	verification_limit: msg('Too many confirmation emails were sent to this address today. Check your inbox, or try again tomorrow.'),
	invite_invalid: msg('This invitation is invalid or has expired.'),
	note_farmer_own_farm: msg('You can add notes only to your own farm.'),
	note_farm_visibility: msg('Only a note on a farm can be shown to its farmers.'),
	note_author_only: msg('Only the person who wrote a note can change it.'),
	note_delete_denied: msg('Only the person who wrote a note, or the WUA, can delete it.'),
	unsubscribe_link_gone: msg('This link doesn’t work any more.'),
	export_throttled: msg('You downloaded your data a moment ago. Try again in {wait}.'),
	alerts_resume_throttled: msg('You turned alert emails back on less than a day ago, and your email address was refused again. Check the address, then try again tomorrow.'),
	body_refused: msg('Something in what you sent can’t be saved (a hidden control character, or a number far too large). Check what you entered and try again.'),
	run_unverified: msg('This run wasn’t stored by the model run itself, so it can’t be signed off or decided on. Delete it and run it again.')
};

// i18n-section: error.minutes
const MINUTES = plural({ one: '{n} minute', other: '{n} minutes' });

/** The message for a status the server gave no code for. */
function byStatus(status: number): string {
	// i18n-section: error.status
	if (status === 0) return t('Couldn’t reach the server. Check your connection and try again.');
	if (status >= 500) return t('Something went wrong on our side. Try again in a moment.');
	if (status === 400 || status === 422) return t('That wasn’t accepted. Check what you entered and try again.');
	if (status === 401) return t('You’re not signed in. Sign in and try again.');
	if (status === 403) return t('You don’t have access to that.');
	if (status === 404) return t('That isn’t there any more.');
	if (status === 409) return t('That clashes with a change made a moment ago. Reload the page and try again.');
	if (status === 413) return t('That is too large to send.');
	if (status === 429) return t('Too many tries. Wait a minute and try again.');
	return t('Something went wrong. Try again.');
}

/** A failed request: an ApiError ($lib/api/client) or a DownloadError ($lib/export/download), which both carry these. */
interface HttpFailure {
	status: number;
	code?: string | null;
	params?: Record<string, string | number>;
}
const isHttpFailure = (e: unknown): e is HttpFailure => e instanceof Error && typeof (e as { status?: unknown }).status === 'number';

/** Codes whose wording says how long to wait: `params.seconds`, as whole minutes. */
const WAITS = new Set(['signin_locked', 'signup_throttled', 'export_throttled']);

/** What to tell the reader about a failed request (anything thrown: anything else reads as a generic failure). */
export function errorText(err: unknown): string {
	if (!isHttpFailure(err)) return t('Something went wrong. Try again.');
	const words = err.code && Object.hasOwn(CODES, err.code) ? CODES[err.code]! : null;
	if (!words) return byStatus(err.status);
	const params = err.params ?? {};
	if (WAITS.has(err.code!)) {
		const seconds = n(params.seconds);
		const minutes = Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds / 60) : 1;
		return t(words, { wait: tn(MINUTES, minutes) });
	}
	return t(words, params);
}
