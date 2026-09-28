// What of an error may go to a log line (CloudWatch keeps them 30 days). An
// error's message is never logged by these: SES puts the recipient's address
// in MessageRejected / AccessDenied text, a pg error's detail carries row
// values, and an SMTP reply can echo the envelope. Only the error's class
// name, its machine code and the HTTP status survive, each checked to be a
// short token so a thrown string or a hand-built error can't smuggle text in.

/** A short identifier: letters, digits, `_`, `.` and `-` only. */
const TOKEN = /^[A-Za-z0-9_.-]{1,64}$/;

export type SafeError = {
	/** The error's name: for an AWS SDK error, the service's error code (MessageRejected, AccessDeniedException, Throttling). */
	error: string;
	/** A machine code when the error has one: a Postgres SQLSTATE, a Node/nodemailer code (ECONNREFUSED, EAUTH). */
	code?: string;
	/** The HTTP status an AWS SDK error came back with. */
	status?: number;
};

/** The loggable part of `err`: its name, code and status, never its message. */
export function safeError(err: unknown): SafeError {
	const e = (typeof err === 'object' && err !== null ? err : {}) as { name?: unknown; code?: unknown; $metadata?: { httpStatusCode?: unknown } };
	const out: SafeError = { error: typeof e.name === 'string' && TOKEN.test(e.name) ? e.name : 'Error' };
	if (typeof e.code === 'string' && TOKEN.test(e.code)) out.code = e.code;
	const status = e.$metadata?.httpStatusCode;
	if (typeof status === 'number' && Number.isInteger(status)) out.status = status;
	return out;
}

/**
 * Where `err` was thrown: the stack's frames (`at fn (file:line:col)`), at
 * most `max` of them, without the "Name: message" head, which may run over
 * several lines. For an unexpected failure, where the name alone says little.
 */
export function stackFrames(err: unknown, max = 8): string[] {
	const stack = (err as { stack?: unknown } | null)?.stack;
	if (typeof stack !== 'string') return [];
	return stack
		.split('\n')
		.filter((l) => /^\s+at\s.*:\d+:\d+\)?$/.test(l))
		.slice(0, max)
		.map((l) => l.trim());
}
