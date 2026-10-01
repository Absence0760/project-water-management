// Unsubscribe tokens (WP-2.13): stable per nonce, bound to the secret, stored as a hash.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hashToken, parseToken } from '../auth/tokens.js';
import { alertsTokenSecret, feedbackPageUrl, feedbackToken, newNonce, newSubscriptionSecret, oneClickUrl, unsubscribePageUrl, unsubscribeToken } from './tokens.js';

const SECRET = 'test-only-alerts-secret-000000000000000';

afterEach(() => vi.unstubAllEnvs());

describe('unsubscribe tokens', () => {
	it('are the same for a nonce every time (links in old mails keep working), in the emailed tokens’ format', () => {
		const { nonce, hash } = newSubscriptionSecret(SECRET);
		const t = unsubscribeToken(nonce, SECRET);
		expect(unsubscribeToken(nonce, SECRET)).toBe(t);
		expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(parseToken(t)!.equals(hash)).toBe(true);
	});

	it('differ per nonce and per secret: neither the nonce nor the secret alone makes one', () => {
		const a = newSubscriptionSecret(SECRET);
		const b = newSubscriptionSecret(SECRET);
		expect(unsubscribeToken(a.nonce, SECRET)).not.toBe(unsubscribeToken(b.nonce, SECRET));
		expect(hashToken(unsubscribeToken(a.nonce, 'another-secret-that-is-long-enough-000'))).not.toEqual(a.hash);
		// The token isn't the nonce in another encoding.
		expect(unsubscribeToken(a.nonce, SECRET)).not.toBe(a.nonce.toString('base64url'));
	});

	it('refuses a missing or short secret rather than sign with it', () => {
		vi.stubEnv('ALERTS_TOKEN_SECRET', 'short');
		expect(() => alertsTokenSecret()).toThrow(/ALERTS_TOKEN_SECRET/);
		vi.stubEnv('ALERTS_TOKEN_SECRET', '');
		expect(() => newSubscriptionSecret()).toThrow(/ALERTS_TOKEN_SECRET/);
	});

	it('puts the token in the landing page’s fragment, and in the one-click address’s query (RFC 8058 has no body for it)', () => {
		vi.stubEnv('SITE_URL', 'https://wm.example.org/');
		vi.stubEnv('API_PUBLIC_URL', '');
		expect(unsubscribePageUrl('abc')).toBe('https://wm.example.org/alerts/unsubscribe#t=abc');
		expect(oneClickUrl('abc')).toBe('https://wm.example.org/api/alerts/unsubscribe?token=abc');
		vi.stubEnv('API_PUBLIC_URL', 'http://localhost:3001');
		expect(oneClickUrl('abc')).toBe('http://localhost:3001/alerts/unsubscribe?token=abc');
	});
});

describe('feedback tokens (147_alert_feedback)', () => {
	it('are stable per nonce, in the emailed tokens’ format, and never the unsubscribe token of the same nonce', () => {
		const nonce = newNonce();
		const t = feedbackToken(nonce, SECRET);
		expect(feedbackToken(nonce, SECRET)).toBe(t);
		expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
		// Single-purpose: its own label, so a feedback token can't unsubscribe, nor the reverse.
		expect(t).not.toBe(unsubscribeToken(nonce, SECRET));
		expect(feedbackToken(nonce, 'another-secret-that-is-long-enough-000')).not.toBe(t);
	});

	it('puts the token and the chosen answer in the page’s fragment, never the query', () => {
		vi.stubEnv('SITE_URL', 'https://wm.example.org/');
		expect(feedbackPageUrl('abc', true)).toBe('https://wm.example.org/alerts/feedback#t=abc&a=yes');
		expect(feedbackPageUrl('abc', false)).toBe('https://wm.example.org/alerts/feedback#t=abc&a=no');
	});
});
