// Only follow same-app relative `?next=` targets (no open redirects).
//
// The prefix checks catch `//host` and `/\host`; the URL parse catches what a
// browser strips before it reads the URL (tabs and newlines, so `/\t/host` is
// `//host` to it), since a path the parser resolves to another origin is not
// an app path whatever it looks like.
const PROBE = 'https://app.invalid';

export function safeNext(next: string | null, fallback: string): string {
	if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return fallback;
	let origin: string;
	try {
		origin = new URL(next, PROBE).origin;
	} catch {
		return fallback;
	}
	return origin === PROBE ? next : fallback;
}

/**
 * sessionStorage key: the address a sign-up just emailed its confirmation link
 * to, so the sign-in page can name it and fill it in (issue #57). Kept out of
 * the URL, where it would sit in the history and the server logs.
 */
export const CONFIRM_EMAIL_KEY = 'wm:confirm-email';
