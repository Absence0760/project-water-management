// The client address the sign-up throttle keys on (http/clientAddress.ts):
// the edge's header only on an edge-verified request, IPv6 by its /64.
// Every "ignored" case has its positive control.
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AuthEnv } from '../auth/middleware.js';
import { addressKey, clientKey, LOCAL_KEY, UNKNOWN_EDGE_KEY, VIEWER_ADDRESS_HEADER } from './clientAddress.js';
import { clientBucket, signupThrottleOn } from '../auth/signupThrottle.js';

describe('addressKey', () => {
	it('keys IPv4 as it is, IPv6 by its /64, and an IPv4-mapped address as its IPv4', () => {
		expect(addressKey('192.0.2.7')).toBe('v4:192.0.2.7');
		expect(addressKey('2001:db8:1:2:aaaa::1')).toBe('v6:2001:0db8:0001:0002::/64');
		// Another address in the same /64 is the same client.
		expect(addressKey('2001:DB8:1:2:ffff:ffff:ffff:ffff')).toBe('v6:2001:0db8:0001:0002::/64');
		// The next /64 is not.
		expect(addressKey('2001:db8:1:3::1')).toBe('v6:2001:0db8:0001:0003::/64');
		expect(addressKey('::ffff:192.0.2.7')).toBe('v4:192.0.2.7');
		expect(addressKey('::1')).toBe('v6:0000:0000:0000:0000::/64');
		expect(addressKey('fe80::1%en0')).toBe('v6:fe80:0000:0000:0000::/64');
	});

	it('refuses anything that is not an address', () => {
		for (const bad of [undefined, null, '', 'unknown', '192.0.2.7:443', '999.1.1.1', '192.0.2.7, 198.51.100.1', '2001:db8::1::2']) {
			expect(addressKey(bad), String(bad)).toBeNull();
		}
	});
});

describe('clientKey', () => {
	/** An app that answers with the request's key; `verified` stands in for app.ts's shared-secret check. */
	const appWith = (verified: boolean) =>
		new Hono<AuthEnv>()
			.use('*', async (c, next) => {
				if (verified) c.set('edgeVerified', true);
				await next();
			})
			.get('/', (c) => c.text(clientKey(c)));
	const keyOf = async (app: Hono<AuthEnv>, headers: Record<string, string>, env?: unknown) =>
		(await app.request('/', { headers }, env)).text();

	it('reads the viewer address header on an edge-verified request (positive control)', async () => {
		expect(await keyOf(appWith(true), { [VIEWER_ADDRESS_HEADER]: '203.0.113.9' })).toBe('v4:203.0.113.9');
	});

	it('fails closed to one shared key when an edge-verified request has no usable address', async () => {
		expect(await keyOf(appWith(true), {})).toBe(UNKNOWN_EDGE_KEY);
		expect(await keyOf(appWith(true), { [VIEWER_ADDRESS_HEADER]: 'not-an-ip' })).toBe(UNKNOWN_EDGE_KEY);
	});

	it('ignores the viewer address and X-Forwarded-For on a request that did not pass the edge check', async () => {
		const spoof = { [VIEWER_ADDRESS_HEADER]: '203.0.113.9', 'x-forwarded-for': '198.51.100.4', 'cloudfront-viewer-address': '198.51.100.5:443' };
		expect(await keyOf(appWith(false), spoof)).toBe(LOCAL_KEY);
		// The local Node server's socket peer is used instead.
		expect(await keyOf(appWith(false), spoof, { incoming: { socket: { remoteAddress: '::ffff:127.0.0.1' } } })).toBe('v4:127.0.0.1');
	});
});

describe('the test-only switch', () => {
	it('is on unless SIGNUP_THROTTLE=off, and always on in Lambda', () => {
		expect(signupThrottleOn({})).toBe(true);
		expect(signupThrottleOn({ SIGNUP_THROTTLE: 'false' })).toBe(true);
		expect(signupThrottleOn({ SIGNUP_THROTTLE: 'off' })).toBe(false);
		expect(signupThrottleOn({ SIGNUP_THROTTLE: 'off', AWS_LAMBDA_FUNCTION_NAME: 'water-management-api' })).toBe(true);
	});

	it('stores a hash of the client key, never the address', () => {
		const bucket = clientBucket('v4:203.0.113.9');
		expect(bucket).toMatch(/^client:[0-9a-f]{64}$/);
		expect(bucket).not.toContain('203.0.113.9');
		expect(clientBucket('v4:203.0.113.10')).not.toBe(bucket);
	});
});
