import { describe, expect, it } from 'vitest';
import { credentialHint, FeedCredentialError, generateFeedCredentialKeys, openFeedCredential, sealFeedCredential } from './credential.js';

const keys = generateFeedCredentialKeys();
const env = { FEED_CREDENTIAL_PUBLIC_KEY: keys.publicKey, FEED_CREDENTIAL_PRIVATE_KEY: keys.privateKey };
const FEED = '6f1c6a4e-2b7d-4c55-9a1e-0d3f5b8c9e10';
const OTHER = '6f1c6a4e-2b7d-4c55-9a1e-0d3f5b8c9e11';

describe('feed credential sealing', () => {
	it('round-trips a secret and a user', () => {
		const sealed = sealFeedCredential({ secret: 'tok-123', user: 'station' }, FEED, env);
		expect(openFeedCredential(sealed, FEED, env)).toEqual({ secret: 'tok-123', user: 'station' });
	});

	it('seals with the public key alone, and never twice the same', () => {
		const pubOnly = { FEED_CREDENTIAL_PUBLIC_KEY: keys.publicKey };
		const a = sealFeedCredential({ secret: 's' }, FEED, pubOnly);
		const b = sealFeedCredential({ secret: 's' }, FEED, pubOnly);
		expect(a).not.toBe(b);
		expect(a).not.toContain('s"');
		expect(() => openFeedCredential(a, FEED, pubOnly)).toThrow(/FEED_CREDENTIAL_PRIVATE_KEY/);
	});

	it('refuses another feed’s credential (the feed id is bound in)', () => {
		const sealed = sealFeedCredential({ secret: 'tok' }, FEED, env);
		expect(() => openFeedCredential(sealed, OTHER, env)).toThrow(FeedCredentialError);
	});

	it('refuses another key pair, a flipped byte and garbage, without echoing the bytes', () => {
		const sealed = sealFeedCredential({ secret: 'tok' }, FEED, env);
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
		expect(() => sealFeedCredential({ secret: 's' }, FEED, { FEED_CREDENTIAL_PUBLIC_KEY: 'short' })).toThrow(/32 bytes/);
	});

	it('hints only the last four of a long secret', () => {
		expect(credentialHint({ secret: 'abcdefghijklmnop' })).toBe('mnop');
		expect(credentialHint({ secret: 'short-secret' })).toBeNull();
	});
});
