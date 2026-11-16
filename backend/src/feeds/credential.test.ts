import { describe, expect, it } from 'vitest';
import { credentialBinding, credentialHint, FeedCredential, FeedCredentialError, generateFeedCredentialKeys, openFeedCredential, sealFeedCredential } from './credential.js';

const keys = generateFeedCredentialKeys();
const env = { FEED_CREDENTIAL_PUBLIC_KEY: keys.publicKey, FEED_CREDENTIAL_PRIVATE_KEY: keys.privateKey };
const FEED = '6f1c6a4e-2b7d-4c55-9a1e-0d3f5b8c9e10';
const OTHER = '6f1c6a4e-2b7d-4c55-9a1e-0d3f5b8c9e11';

describe('feed credential sealing', () => {
	it('round-trips a secret and a user', () => {
		const sealed = sealFeedCredential({ secret: 'tok-12345', user: 'station' }, FEED, env);
		expect(openFeedCredential(sealed, FEED, env)).toEqual({ secret: 'tok-12345', user: 'station' });
	});

	it('seals with the public key alone, and never twice the same', () => {
		const pubOnly = { FEED_CREDENTIAL_PUBLIC_KEY: keys.publicKey };
		const a = sealFeedCredential({ secret: 'secret-1' }, FEED, pubOnly);
		const b = sealFeedCredential({ secret: 'secret-1' }, FEED, pubOnly);
		expect(a).not.toBe(b);
		expect(a).not.toContain('s"');
		expect(() => openFeedCredential(a, FEED, pubOnly)).toThrow(/FEED_CREDENTIAL_PRIVATE_KEY/);
	});

	it('refuses another feed’s credential (the feed id is bound in)', () => {
		const sealed = sealFeedCredential({ secret: 'token-12' }, FEED, env);
		expect(() => openFeedCredential(sealed, OTHER, env)).toThrow(FeedCredentialError);
	});

	it('refuses another key pair, a flipped byte and garbage, without echoing the bytes', () => {
		const sealed = sealFeedCredential({ secret: 'token-12' }, FEED, env);
		const other = generateFeedCredentialKeys();
		expect(() => openFeedCredential(sealed, FEED, { ...env, FEED_CREDENTIAL_PRIVATE_KEY: other.privateKey })).toThrow(FeedCredentialError);
		const buf = Buffer.from(sealed, 'base64');
		buf[buf.length - 1] = buf[buf.length - 1]! ^ 1;
		expect(() => openFeedCredential(buf.toString('base64'), FEED, env)).toThrow(FeedCredentialError);
		try {
			openFeedCredential('bm90IHNlYWxlZA==', FEED, env);
		} catch (e) {
			expect((e as Error).message).not.toContain('bm90');
		}
	});

	it('refuses a key that is not 32 bytes', () => {
		expect(() => sealFeedCredential({ secret: 'secret-1' }, FEED, { FEED_CREDENTIAL_PUBLIC_KEY: 'short' })).toThrow(/32 bytes/);
	});

	it('hints only the last four of a long secret', () => {
		expect(credentialHint({ secret: 'abcdefghijklmnop' })).toBe('mnop');
		expect(credentialHint({ secret: 'short-secret' })).toBeNull();
	});
});

describe('the key’s binding', () => {
	const target = { url: 'https://api.example.com/v1/{station}/rain?from={start}', auth: { kind: 'header', name: 'X-Api-Key' } };
	const bound = credentialBinding(FEED, target);

	it('opens where it was sealed, whatever the path, query or placeholders', () => {
		const sealed = sealFeedCredential({ secret: 'token-12' }, bound, env);
		const samePlace = credentialBinding(FEED, { ...target, url: 'https://api.example.com/v2/other?station={station}' });
		expect(openFeedCredential(sealed, samePlace, env)).toEqual({ secret: 'token-12' });
		// Header names are case-insensitive.
		expect(credentialBinding(FEED, { ...target, auth: { kind: 'header', name: 'x-api-key' } })).toBe(bound);
	});

	it('won’t open once the feed is re-pointed at another site or sends the key another way', () => {
		const sealed = sealFeedCredential({ secret: 'token-12' }, bound, env);
		for (const moved of [
			{ ...target, url: 'https://attacker.example.net/collect' },
			{ ...target, url: 'https://evil.api.example.com/v1' },
			{ ...target, auth: { kind: 'query', name: 'X-Api-Key' } },
			{ ...target, auth: { kind: 'header', name: 'X-Other' } },
			{ ...target, auth: { kind: 'bearer' } }
		]) {
			expect(() => openFeedCredential(sealed, credentialBinding(FEED, moved), env)).toThrow(FeedCredentialError);
		}
	});
});

describe('FeedCredential', () => {
	it('takes a key of at least 8 characters, so a piece of it is always long enough to scrub (sources/station.ts scrubKey)', () => {
		expect(FeedCredential.safeParse({ secret: '1234567' }).success).toBe(false);
		expect(FeedCredential.safeParse({ secret: '12345678' }).success).toBe(true);
		expect(() => sealFeedCredential({ secret: 'abc' }, FEED, env)).toThrow();
	});
});
