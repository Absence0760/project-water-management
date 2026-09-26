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
import { en } from './messages/en';
import { t, tn, type MessageKey } from './locale.svelte';

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v));

/** The message for a status the server gave no code for. */
function byStatus(status: number): MessageKey {
	if (status === 0) return 'error.status.network';
	if (status >= 500) return 'error.status.server';
	if (status === 400 || status === 422) return 'error.status.invalid';
	if (status === 401) return 'error.not_signed_in';
	if (status === 403) return 'error.status.forbidden';
	if (status === 404) return 'error.status.notFound';
	if (status === 409) return 'error.status.conflict';
	if (status === 413) return 'error.status.tooLarge';
	if (status === 429) return 'error.status.tooMany';
	return 'error.status.unknown';
}

/** A failed request: an ApiError ($lib/api/client) or a DownloadError ($lib/export/download), which both carry these. */
interface HttpFailure {
	status: number;
	code?: string | null;
	params?: Record<string, string | number>;
}
const isHttpFailure = (e: unknown): e is HttpFailure => e instanceof Error && typeof (e as { status?: unknown }).status === 'number';

/** Codes whose wording says how long to wait: `params.seconds`, as whole minutes. */
const WAITS = new Set(['signin_locked', 'export_throttled']);

/** What to tell the reader about a failed request (anything thrown: anything else reads as a generic failure). */
export function errorText(err: unknown): string {
	if (!isHttpFailure(err)) return t('error.status.unknown');
	const key = `error.${err.code}` as MessageKey;
	if (!err.code || !(key in en)) return t(byStatus(err.status));
	const params = err.params ?? {};
	if (WAITS.has(err.code)) {
		const seconds = n(params.seconds);
		const minutes = Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds / 60) : 1;
		return t(key, { wait: tn('error.minutes', minutes) });
	}
	return t(key, params);
}
