// The client address a per-client limit can key on (docs/security.md §
// Password reset, email verification and invites: the sign-up throttle).
//
// Behind CloudFront the socket peer is a CloudFront edge, never the viewer,
// and anything the viewer sends in a header (X-Forwarded-For included) is
// theirs to make up. So the address is read from one header only,
// VIEWER_ADDRESS_HEADER, which the /api/* viewer-request CloudFront Function
// (api_strip_prefix, infra/s3_cloudfront.tf) sets from `event.viewer.ip`,
// overwriting whatever the viewer sent, and only when the request passed the
// CloudFront shared-secret check in app.ts (`edgeVerified`). A direct call to
// the Function URL can't set it: without the secret it gets 403 first.
//
// Without the shared secret configured (local dev, tests) the header is never
// trusted: the key is the socket peer (the Node server) or, with no socket
// (app.request in tests), one fixed key for everyone.
import { isIPv4, isIPv6 } from 'node:net';
import type { Context } from 'hono';

/** Set by the api_strip_prefix CloudFront Function; read only on an edge-verified request. */
export const VIEWER_ADDRESS_HEADER = 'x-viewer-address';

/** An edge-verified request without a usable viewer address (a misconfigured edge): one shared key, so it fails closed. */
export const UNKNOWN_EDGE_KEY = 'edge:unknown';
/** No trusted address and no socket (app.request in tests): one shared key. */
export const LOCAL_KEY = 'local';

/** The eight 16-bit groups of an IPv6 address, as 4-digit lower-case hex, or null. */
function ipv6Groups(address: string): string[] | null {
	let s = address.split('%')[0]!;
	if (!isIPv6(s)) return null;
	// An embedded IPv4 tail (::ffff:192.0.2.1) as its two groups.
	const tail = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
	if (tail) {
		const [a, b, c, d] = tail.slice(1).map(Number) as [number, number, number, number];
		s = `${s.slice(0, -tail[0].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
	}
	const [head, rest] = s.split('::') as [string, string | undefined];
	const h = head ? head.split(':') : [];
	const t = rest === undefined ? [] : rest ? rest.split(':') : [];
	const groups = rest === undefined ? h : [...h, ...new Array(8 - h.length - t.length).fill('0'), ...t];
	return groups.length === 8 ? groups.map((g) => g.toLowerCase().padStart(4, '0')) : null;
}

/**
 * The limit key for an address: an IPv4 address as it is; an IPv6 address by
 * its /64 (one subscriber's usual allocation, so rotating within it gains
 * nothing), with an IPv4-mapped one as its IPv4. Null for anything else.
 */
export function addressKey(address: string | undefined | null): string | null {
	const a = (address ?? '').trim();
	if (isIPv4(a)) return `v4:${a}`;
	const g = ipv6Groups(a);
	if (!g) return null;
	if (g.slice(0, 5).every((x) => x === '0000') && g[5] === 'ffff') {
		const v4 = [g[6]!, g[7]!].flatMap((x) => [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2), 16)]).join('.');
		return `v4:${v4}`;
	}
	return `v6:${g.slice(0, 4).join(':')}::/64`;
}

type NodeEnv = { incoming?: { socket?: { remoteAddress?: string } } } | undefined;

/** The key to throttle this request's client on (see the top of this file). */
export function clientKey(c: Context): string {
	if (c.get('edgeVerified') === true) return addressKey(c.req.header(VIEWER_ADDRESS_HEADER)) ?? UNKNOWN_EDGE_KEY;
	return addressKey((c.env as NodeEnv)?.incoming?.socket?.remoteAddress) ?? LOCAL_KEY;
}
