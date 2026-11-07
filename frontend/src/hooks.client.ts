// A page that crashes (an exception while it loads or renders) gets an error
// id: the error page (routes/+error.svelte) shows it, and the same id goes to
// the API in a report (POST /client-errors) that the API logs as one
// `client_error` line, so a user who quotes it leads the operator to what
// threw (docs/ui.md § Error page, docs/security.md § Client error reports).
// The report is fire-and-forget: it never delays the error page, and nothing
// it does can throw out of this hook (Kit requires that).
import type { HandleClientError } from '@sveltejs/kit/hooks';
import { version } from '$app/env';
import { PUBLIC_API_URL } from '$app/env/public';
import { buildReport, errorId, MAX_REPORTS, pageError, shouldReport, type ClientErrorReport } from './clientErrors';

let sent = 0;

function send(report: ClientErrorReport): void {
	if (sent >= MAX_REPORTS) return;
	sent++;
	try {
		// The API client's conventions (lib/api/client.ts): the session cookie, a JSON body. keepalive lets the report
		// finish if the user reloads straight away. Signed out, the API answers 401 and nothing is logged.
		void fetch(`${PUBLIC_API_URL.replace(/\/+$/, '')}/client-errors`, {
			method: 'POST',
			credentials: 'include',
			keepalive: true,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(report)
		}).catch(() => {});
	} catch {
		// fetch itself threw (a body past keepalive's limit, say): the error page still shows.
	}
}

export const handleError: HandleClientError = (input) => {
	let id = '';
	try {
		id = errorId(crypto.randomUUID());
	} catch {
		id = Math.random().toString(16).slice(2, 10).padEnd(8, '0');
	}
	try {
		if (shouldReport(input)) {
			const status = input.kind === 'unknown' ? 500 : input.error.status;
			send(buildReport({ id, status, thrown: input.error, path: location.pathname + location.search, version }));
		}
		return pageError(input, id);
	} catch {
		return { status: 500, message: 'Internal Error', id };
	}
};
