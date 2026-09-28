// Refuses request paths whose percent-encoding could make the app route a
// request somewhere the edge didn't see it going (docs/security.md §
// Infrastructure, issue #126).
//
// The WAF matches rules on the raw path (the `/api/auth/` rate limit URL-decodes
// and normalises first, infra/waf.tf), and Hono routes on a decoded one:
// `getPath` runs decodeURI over the path, so `/%61uth/login` is `/auth/login`
// to the router. Any gap between the two views is a way past a path rule, so
// the app refuses the encodings that can change where a request routes. It
// does not refuse every encoding: a path segment may carry a space (%20) or a
// non-ASCII character (%C3%A9) and those must keep working, because routes that
// take a name rather than a UUID would need them.
//
// Refused, with 400:
//   - an escape of an unreserved character (RFC 3986 § 2.3: A–Z a–z 0–9 - . _ ~),
//     which no client needs to encode and which is how `%61uth` or `%2e%2e` hides;
//   - an escape of `/`, `\` or `%` (a path separator, or double encoding);
//   - an escape of a control character (%00–%1F, %7F);
//   - a malformed escape (`%` not followed by two hex digits);
//   - a raw `.` or `..` segment, or a raw `\`, in the path the server received.
//
// The raw path is read from what the runtime received before a Request was
// built: the Lambda event's `rawPath` (hono/aws-lambda puts the event in
// c.env), or the Node server's `incoming.url` (@hono/node-server). Building a
// Request resolves dot segments, `%2e%2e` included, so `c.req.url` alone can
// no longer show them; it is checked as well, for the other escapes.
import type { Context, MiddlewareHandler } from 'hono';

/** Hex pairs that are refused wherever they appear in a path (upper-case). */
function refusedEscape(hex: string): boolean {
	const code = parseInt(hex, 16);
	if (code <= 0x1f || code === 0x7f) return true; // control characters
	const ch = String.fromCharCode(code);
	if (/[A-Za-z0-9\-._~]/.test(ch)) return true; // unreserved: never needs encoding
	return ch === '/' || ch === '\\' || ch === '%';
}

/** Why a raw path (no query string) is refused, or null when it is fine. */
export function pathRefusal(raw: string): string | null {
	for (let i = raw.indexOf('%'); i !== -1; i = raw.indexOf('%', i + 1)) {
		const hex = raw.slice(i + 1, i + 3);
		if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return 'malformed percent-encoding';
		if (refusedEscape(hex)) return `percent-encoded %${hex.toUpperCase()}`;
	}
	if (raw.includes('\\')) return 'backslash in path';
	if (raw.split('/').some((s) => s === '.' || s === '..')) return 'dot segment in path';
	return null;
}

/** The path part of a request target or absolute URL, as sent: no decoding, no normalising. */
export function rawPathOf(target: string): string {
	let path = target;
	if (!target.startsWith('/')) {
		// An absolute URL (c.req.url, or an absolute-form request target): the path starts after the authority.
		const scheme = target.indexOf('://');
		const slash = scheme === -1 ? -1 : target.indexOf('/', scheme + 3);
		path = slash === -1 ? '/' : target.slice(slash);
	}
	const end = path.search(/[?#]/);
	return end === -1 ? path : path.slice(0, end);
}

/** Every raw form of this request's path the runtime can show us. */
function rawPaths(c: Context): string[] {
	const env = (c.env ?? {}) as { event?: { rawPath?: unknown }; incoming?: { url?: unknown } };
	const out = [rawPathOf(c.req.url)];
	// A Function URL event (payload 2.0): rawPath is the path as CloudFront forwarded it.
	if (typeof env.event?.rawPath === 'string') out.push(env.event.rawPath);
	if (typeof env.incoming?.url === 'string') out.push(rawPathOf(env.incoming.url));
	return out;
}

/** 400 for a path pathRefusal refuses, before anything reads c.req.path. */
export const refuseAmbiguousPaths: MiddlewareHandler = async (c, next) => {
	for (const raw of rawPaths(c)) {
		if (pathRefusal(raw)) return c.json({ error: 'bad request path' }, 400);
	}
	await next();
};
