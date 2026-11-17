// gen:feed-credential-key (scripts/feed-credential-key.ts): prints a pair the production check accepts and that
// seals and opens, in the shapes the tfvars and sops files take. Generated here; nothing is a real key.
import { describe, expect, it } from 'vitest';
import { productionEnvProblems } from '../src/config/production.js';
import { generateFeedCredentialKeys, openFeedCredential, sealFeedCredential } from '../src/feeds/credential.js';
import { feedCredentialKeyText } from './feed-credential-key.js';

describe('gen:feed-credential-key', () => {
	it('prints each half under the setting it goes into, and the halves pair', () => {
		const keys = generateFeedCredentialKeys();
		const text = feedCredentialKeyText(keys);
		const pub = /^feed_credential_public_key = "([A-Za-z0-9_-]{43})"$/m.exec(text)?.[1];
		const priv = /^feed_credential_private_key: "([A-Za-z0-9_-]{43})"$/m.exec(text)?.[1];
		expect(pub).toBe(keys.publicKey);
		expect(priv).toBe(keys.privateKey);
		const env = { FEED_CREDENTIAL_PUBLIC_KEY: pub, FEED_CREDENTIAL_PRIVATE_KEY: priv };
		const feed = '00000000-0000-4000-8000-000000000001';
		expect(openFeedCredential(sealFeedCredential({ secret: 'synthetic-token' }, feed, env), feed, env)).toEqual({ secret: 'synthetic-token' });
	});

	it('prints keys the production config takes (the API’s public half, the fetcher’s private half)', () => {
		const keys = generateFeedCredentialKeys();
		const apiProblems = productionEnvProblems('api', { STATION_API_FEEDS: 'on', FEED_CREDENTIAL_PUBLIC_KEY: keys.publicKey });
		expect(apiProblems.filter((p) => p.startsWith('FEED_CREDENTIAL'))).toEqual([]);
		const fetcherProblems = productionEnvProblems('fetcher', { STATION_API_FEEDS: 'on', FEED_CREDENTIAL_PUBLIC_KEY: keys.publicKey, FEED_CREDENTIAL_PRIVATE_KEY: keys.privateKey });
		expect(fetcherProblems.filter((p) => p.startsWith('FEED_CREDENTIAL'))).toEqual([]);
		// Positive control: the same check refuses a key that isn't one.
		expect(productionEnvProblems('api', { STATION_API_FEEDS: 'on', FEED_CREDENTIAL_PUBLIC_KEY: 'short' }).some((p) => p.startsWith('FEED_CREDENTIAL_PUBLIC_KEY'))).toBe(true);
	});

	it('a fresh pair every run', () => {
		expect(generateFeedCredentialKeys().privateKey).not.toBe(generateFeedCredentialKeys().privateKey);
	});
});
