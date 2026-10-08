// Server errors on the translated pages: worded from the code (or the
// status), never the server's English; and every code the API can send has
// its message (the contract in backend/src/http/errors.ts ERROR_CODES).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ApiError } from '$lib/api/client';
import { DownloadError } from '$lib/export/download';
import { errorText } from './apiError';

const backendCodes = () => {
	const src = readFileSync(new URL('../../../../backend/src/http/errors.ts', import.meta.url), 'utf8');
	const list = /export const ERROR_CODES = \[([^\]]*)\]/.exec(src)?.[1] ?? '';
	return [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
};

describe('errorText', () => {
	// Every code's words (a wait shows as 1 minute), so the lookup can't lose one.
	const WORDS: Record<string, string> = {
		not_signed_in: 'You’re not signed in. Sign in and try again.',
		account_exists: 'An account with that email address already exists. Sign in, or reset your password.',
		wrong_credentials: 'Wrong email or password.',
		email_unconfirmed: 'Confirm your email address before you sign in: open the link we emailed you.',
		signin_locked: 'Too many sign-in attempts for this address. Try again in 1 minute, or reset your password.',
		signup_throttled: 'Too many accounts were made from your network. Try again in 1 minute.',
		signup_closed: 'Sign-up is by invitation only for now. Ask the person who manages your catchment to invite you, then use the link in the invitation email.',
		terms_not_accepted: 'The Terms of use or Privacy notice changed since this page opened. Reload the page and read them again.',
		farm_notice_changed: 'This notice changed since the page opened. Reload the page and read it again.',
		wrong_current_password: 'Your current password is wrong.',
		password_changed_elsewhere: 'Your password was changed somewhere else a moment ago. Sign in again.',
		link_invalid: 'This link is invalid or has expired. Ask for a new one.',
		already_verified: 'Your email address is already confirmed.',
		verification_sent_recently: 'A confirmation email was sent a moment ago. Check your inbox, or try again in a minute.',
		verification_limit: 'Too many confirmation emails were sent to this address today. Check your inbox, or try again tomorrow.',
		invite_invalid: 'This invitation is invalid or has expired.',
		note_farmer_own_farm: 'You can add notes only to your own hydrological unit.',
		note_farm_visibility: 'Only a note on a hydrological unit can be shown to its farmers.',
		note_author_only: 'Only the person who wrote a note can change it.',
		note_delete_denied: 'Only the person who wrote a note, or the WUA, can delete it.',
		unsubscribe_link_gone: 'This link doesn’t work any more.',
		feedback_link_gone: 'This link doesn’t work any more.',
		export_throttled: 'You downloaded your data a moment ago. Try again in 1 minute.',
		alerts_resume_throttled:
			'You turned alert emails back on less than a day ago, and your email address was refused again. Check the address, then try again tomorrow.',
		body_refused: 'Something in what you sent can’t be saved (a hidden control character, or a number far too large). Check what you entered and try again.',
		run_unverified: 'This run wasn’t stored by the model run itself, so it can’t be signed off or decided on. Delete it and run it again.',
		account_sole_holder: 'You are the only owner of a project or the only admin of a team. Hand it to someone else first.',
		note_comment_closed: 'This application isn’t open for comment right now.',
		note_audience_denied: 'You can’t post a comment here.',
		mfa_code_wrong: 'That code isn’t right. Enter the newest code from your authenticator app or your email, or one of your recovery codes.',
		mfa_locked: 'Too many wrong codes. Try again in 1 minute.',
		mfa_challenge_expired: 'Your sign-in timed out. Enter your email and password again.',
		mfa_already_enrolled: 'This is already on. Turn it off first to set it up again.',
		mfa_not_started: 'Start setting up two-step sign-in again.',
		mfa_not_enrolled: 'Two-step sign-in is off.',
		mfa_required: 'This needs two-step sign-in. Set it up on your Account page first.',
		mfa_step_up: 'This needs two-step sign-in. Sign out, then sign in again with a code.',
		mfa_email_wait: 'We just emailed you a code. You can ask for another in 1 minute.',
		mfa_email_failed: 'We couldn’t send the email. Try again in a minute.',
		comment_throttled: 'You have posted 10 comments in the last hour. Wait a while, then try again.'
	};

	it('has its own words for every code the API sends', () => {
		const codes = backendCodes();
		expect(codes.length).toBeGreaterThan(10);
		expect(codes.filter((c) => !(c in WORDS))).toEqual([]);
		// A 418 has no status wording of its own, so only a code's own message can come back.
		for (const code of codes) expect(errorText(new ApiError(418, 'x', undefined, code)), code).toBe(WORDS[code]);
	});

	it('words the WAF’s CAPTCHA answer (a client-side code) without the puzzle', () => {
		expect(errorText(new ApiError(405, 'solve the puzzle to continue', undefined, 'captcha_required'))).toBe(
			'Too many sign-in attempts from your network. Wait a few minutes, then try again.'
		);
	});

	it('words a coded error from the catalogue, not the server’s English', () => {
		expect(errorText(new ApiError(400, 'this link is invalid or has expired — request a new one', undefined, 'link_invalid'))).toBe(
			'This link is invalid or has expired. Ask for a new one.'
		);
		expect(errorText(new ApiError(403, 'x', undefined, 'note_farmer_own_farm'))).toBe('You can add notes only to your own hydrological unit.');
	});

	it('says how long a sign-in lock lasts, in whole minutes', () => {
		const locked = (seconds: unknown) => errorText(new ApiError(429, 'x', undefined, 'signin_locked', { seconds: seconds as number }));
		expect(locked(45)).toBe('Too many sign-in attempts for this address. Try again in 1 minute, or reset your password.');
		expect(locked(61)).toBe('Too many sign-in attempts for this address. Try again in 2 minutes, or reset your password.');
		expect(locked(undefined)).toMatch(/Try again in 1 minute,/);
	});

	it('says how long the sign-up throttle lasts, in whole minutes (up to its hour window)', () => {
		const throttled = (seconds: number) => errorText(new ApiError(429, 'x', undefined, 'signup_throttled', { seconds }));
		expect(throttled(3599)).toBe('Too many accounts were made from your network. Try again in 60 minutes.');
		expect(throttled(90)).toBe('Too many accounts were made from your network. Try again in 2 minutes.');
	});

	it('says how long until another emailed code may be sent: seconds under a minute, then minutes', () => {
		const wait = (seconds: unknown) => errorText(new ApiError(429, 'x', undefined, 'mfa_email_wait', { seconds: seconds as number }));
		expect(wait(1)).toBe('We just emailed you a code. You can ask for another in 1 second.');
		expect(wait(42.2)).toBe('We just emailed you a code. You can ask for another in 43 seconds.');
		expect(wait(600)).toBe('We just emailed you a code. You can ask for another in 10 minutes.');
		expect(wait(undefined)).toBe('We just emailed you a code. You can ask for another in 1 minute.');
	});

	it('words a failed download (the account page’s “Download my data”) the same way', () => {
		expect(errorText(new DownloadError(429, 'you downloaded your data a moment ago — try again in a minute', 'export_throttled', { seconds: 42 }))).toBe(
			'You downloaded your data a moment ago. Try again in 1 minute.'
		);
		expect(errorText(new DownloadError(401, 'not signed in', 'not_signed_in'))).toBe('You’re not signed in. Sign in and try again.');
		expect(errorText(new DownloadError(0, 'Could not reach the server'))).toBe('Couldn’t reach the server. Check your connection and try again.');
	});

	it('falls back to the status for an unknown or missing code, and never shows the server’s text', () => {
		expect(errorText(new ApiError(404, 'no such thing', undefined, 'something_new'))).toBe('That isn’t there any more.');
		expect(errorText(new ApiError(0, 'Could not reach the server'))).toBe('Couldn’t reach the server. Check your connection and try again.');
		expect(errorText(new ApiError(502, 'Bad gateway'))).toBe('Something went wrong on our side. Try again in a moment.');
		expect(errorText(new ApiError(400, 'invalid request (email: Invalid email)'))).toBe('That wasn’t accepted. Check what you entered and try again.');
		expect(errorText(new ApiError(401, 'not signed in'))).toBe('You’re not signed in. Sign in and try again.');
		expect(errorText(new ApiError(418, 'teapot'))).toBe('Something went wrong. Try again.');
		expect(errorText(new Error('boom'))).toBe('Something went wrong. Try again.');
	});
});
