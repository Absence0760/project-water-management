// The pure half of the client handleError hook (hooks.client.ts): what a page
// crash is reported as (POST /client-errors, docs/api.md § Client error
// reports) and what the error page (routes/+error.svelte) is given. No Kit or
// browser imports, so it is unit-tested on its own (clientErrors.test.ts).

/** The longest each reported field may be; the API refuses anything longer (backend logging/clientErrors.ts). */
export const LIMITS = { name: 200, message: 500, stack: 4000, path: 500, version: 100 } as const;

/** At most this many reports per page load: a crash that repeats (a render loop) sends a few, never a flood. */
export const MAX_REPORTS = 5;

/** The body of POST /client-errors. */
export interface ClientErrorReport {
	id: string;
	status: number;
	name: string;
	message: string;
	stack: string;
	path: string;
	version: string;
}

/** `s` cut to `max` characters, the last one an ellipsis when cut. */
export function truncate(s: string, max: number): string {
	return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** A short id the user can read out and the operator can search the log for: 8 hex digits of a random UUID. */
export function errorId(uuid: string): string {
	return uuid.replace(/-/g, '').slice(0, 8).toLowerCase();
}

/** A thrown value's name, message and stack, whatever was thrown (an Error, a string, anything). Never throws. */
export function describeThrown(thrown: unknown): { name: string; message: string; stack: string } {
	try {
		if (thrown instanceof Error) {
			return { name: String(thrown.name || 'Error'), message: String(thrown.message ?? ''), stack: String(thrown.stack ?? '') };
		}
		// Kit's error() body ({ status, message }), or another object with a message.
		if (thrown && typeof thrown === 'object' && typeof (thrown as { message?: unknown }).message === 'string') {
			const name = (thrown as { name?: unknown }).name;
			return { name: typeof name === 'string' && name ? name : 'Error', message: (thrown as { message: string }).message, stack: '' };
		}
		return { name: typeof thrown, message: String(thrown), stack: '' };
	} catch {
		// An object whose toString throws, or a revoked proxy.
		return { name: 'unknown', message: 'An error that could not be described', stack: '' };
	}
}

/** What a crash is reported as: every field cut to the API's limits. */
export function buildReport(input: { id: string; status: number; thrown: unknown; path: string; version: string }): ClientErrorReport {
	const d = describeThrown(input.thrown);
	return {
		id: input.id,
		status: Number.isInteger(input.status) && input.status >= 100 && input.status <= 599 ? input.status : 500,
		name: truncate(d.name, LIMITS.name),
		message: truncate(d.message, LIMITS.message),
		stack: truncate(d.stack, LIMITS.stack),
		path: truncate(input.path, LIMITS.path),
		version: truncate(input.version, LIMITS.version)
	};
}

/** What Kit's client handleError hook was given, reduced to what this decides on. */
export type Caught = { kind: 'app'; error: { status: number; message: string } } | { kind: 'framework'; error: { status: number; message: string } } | { kind: 'unknown'; error: unknown };

/**
 * Whether a caught error is a crash worth reporting: anything thrown by code
 * (kind `unknown`) and any 5xx. A 404 or another 4xx is a wrong address or a
 * refused request, which the page already explains; reporting those would
 * bury the crashes.
 */
export function shouldReport(caught: Caught): boolean {
	return caught.kind === 'unknown' || caught.error.status >= 500;
}

/**
 * What the error page shows (App.Error): for a crash, the thrown error's own
 * message (cut to the reported length), so the user can quote it with the
 * id; otherwise Kit's own status and message ("Not Found"). Only a reported
 * error carries the id: one the log never saw would lead nowhere.
 */
export function pageError(caught: Caught, id: string): { status: number; message: string; id?: string } {
	const reported = shouldReport(caught) ? { id } : {};
	if (caught.kind !== 'unknown') return { status: caught.error.status, message: caught.error.message, ...reported };
	const message = describeThrown(caught.error).message.trim();
	return { status: 500, message: truncate(message || 'Internal Error', LIMITS.message), ...reported };
}
