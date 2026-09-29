// The sign-in CAPTCHA's client side (issue #126): telling the WAF's CAPTCHA
// answer from an ordinary 405, the retry carrying the solved token, the
// build config that keeps it off locally, the script loaded once and only on
// demand, and the meta-CSP origins svelte.config.js derives from the URL.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, CAPTCHA_REQUIRED, createApi, isWafCaptcha, WAF_TOKEN_HEADER } from '$lib/api/client';
import { captchaConfig, loadCaptchaSdk, resetCaptchaSdkForTests, type AwsWafCaptchaApi } from './wafCaptcha';
import { wafCaptchaOrigins } from '../../../svelte.config.js';

const SCRIPT = 'https://a1b2c3.edge.captcha-sdk.awswaf.com/a1b2c3/jsapi.js';

const res = (status: number, headers: Record<string, string> = {}, body = '') => new Response(status === 204 ? null : body, { status, headers });

describe('isWafCaptcha', () => {
	it('is the 405 with x-amzn-waf-action: captcha, and nothing else', () => {
		expect(isWafCaptcha(res(405, { 'x-amzn-waf-action': 'captcha' }))).toBe(true);
		expect(isWafCaptcha(res(405, { 'X-Amzn-Waf-Action': ' CAPTCHA ' }))).toBe(true);
		// An ordinary 405, a challenge (202) or a block isn't one.
		expect(isWafCaptcha(res(405))).toBe(false);
		expect(isWafCaptcha(res(202, { 'x-amzn-waf-action': 'challenge' }))).toBe(false);
		expect(isWafCaptcha(res(405, { 'x-amzn-waf-action': 'challenge' }))).toBe(false);
		expect(isWafCaptcha(res(403, { 'x-amzn-waf-action': 'captcha' }))).toBe(false);
	});
});

describe('sign-in through the CAPTCHA', () => {
	it('turns the WAF answer into CAPTCHA_REQUIRED, and a retry with the token signs in', async () => {
		const user = { id: '1', email: 'a@b.c', displayName: 'A' };
		const fetchFn = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(res(405, { 'x-amzn-waf-action': 'captcha' }, '<html>captcha</html>'))
			.mockResolvedValueOnce(res(200, { 'content-type': 'application/json' }, JSON.stringify({ user })));
		const api = createApi('/api', fetchFn);

		const first = await api.auth.login('a@b.c', 'pw').catch((e: unknown) => e);
		expect(first).toBeInstanceOf(ApiError);
		expect(first).toMatchObject({ status: 405, code: CAPTCHA_REQUIRED });
		const [, firstInit] = fetchFn.mock.calls[0]!;
		expect(new Headers(firstInit?.headers).has(WAF_TOKEN_HEADER)).toBe(false);

		await expect(api.auth.login('a@b.c', 'pw', 'solved-token')).resolves.toEqual(user);
		const [url, init] = fetchFn.mock.calls[1]!;
		expect(url).toBe('/api/auth/login');
		const headers = new Headers(init?.headers);
		expect(headers.get(WAF_TOKEN_HEADER)).toBe('solved-token');
		expect(headers.get('content-type')).toBe('application/json');
		expect(JSON.parse(init?.body as string)).toEqual({ email: 'a@b.c', password: 'pw' });
	});

	it('leaves the API’s own 405 an ordinary error', async () => {
		const api = createApi('', vi.fn<typeof fetch>().mockResolvedValue(res(405, { 'content-type': 'application/json' }, '{"error":"method not allowed"}')));
		await expect(api.auth.login('a@b.c', 'pw')).rejects.toMatchObject({ status: 405, code: null });
	});
});

describe('captchaConfig', () => {
	it('is off unless both the script URL and the key are set (local dev and tests set neither)', () => {
		expect(captchaConfig('', '')).toBeNull();
		expect(captchaConfig(undefined, undefined)).toBeNull();
		expect(captchaConfig(SCRIPT, '')).toBeNull();
		expect(captchaConfig('', 'key')).toBeNull();
		expect(captchaConfig(SCRIPT, ' key ')).toEqual({ scriptUrl: SCRIPT, apiKey: 'key' });
	});

	it('refuses a script from anywhere but the CAPTCHA SDK', () => {
		for (const url of [
			'http://a1b2c3.edge.captcha-sdk.awswaf.com/a1b2c3/jsapi.js',
			'https://evil.example/a1b2c3/jsapi.js',
			'https://a1b2c3.edge.captcha-sdk.awswaf.com.evil.example/a1b2c3/jsapi.js',
			'https://a1b2c3.edge.sdk.awswaf.com/a1b2c3/challenge.js'
		]) {
			expect(captchaConfig(url, 'key'), url).toBeNull();
		}
	});
});

/** Just enough of a document for the loader: a head that records scripts. */
function fakeDocument() {
	const scripts: Array<Record<string, unknown> & { dataset: Record<string, string>; remove: () => void }> = [];
	const win: { AwsWafCaptcha?: AwsWafCaptchaApi } = {};
	const doc = {
		defaultView: win,
		createElement: () => {
			const s = { dataset: {} as Record<string, string>, remove: () => scripts.splice(scripts.indexOf(s), 1) } as (typeof scripts)[number];
			return s;
		},
		head: { appendChild: (s: (typeof scripts)[number]) => scripts.push(s) },
		querySelectorAll: () => [...scripts]
	};
	return { doc: doc as unknown as Document, scripts, win };
}

describe('loadCaptchaSdk', () => {
	afterEach(() => resetCaptchaSdkForTests());

	it('adds the script only when asked, once, and resolves with AwsWafCaptcha', async () => {
		const { doc, scripts, win } = fakeDocument();
		expect(scripts).toHaveLength(0);
		const a = loadCaptchaSdk(SCRIPT, doc);
		const b = loadCaptchaSdk(SCRIPT, doc);
		expect(scripts).toHaveLength(1);
		expect(scripts[0]!.src).toBe(SCRIPT);
		const sdk = { renderCaptcha: vi.fn() };
		win.AwsWafCaptcha = sdk;
		(scripts[0]!.onload as () => void)();
		await expect(a).resolves.toBe(sdk);
		await expect(b).resolves.toBe(sdk);
		// Loaded: no second script.
		await expect(loadCaptchaSdk(SCRIPT, doc)).resolves.toBe(sdk);
		expect(scripts).toHaveLength(1);
	});

	it('loads no script from anywhere but the CAPTCHA SDK', async () => {
		const { doc, scripts } = fakeDocument();
		await expect(loadCaptchaSdk('https://evil.example/a1b2c3/jsapi.js', doc)).rejects.toThrow('not the CAPTCHA SDK');
		await expect(loadCaptchaSdk('javascript:alert(1)', doc)).rejects.toThrow('not the CAPTCHA SDK');
		expect(scripts).toHaveLength(0);
	});

	it('rejects a failed load and lets the next attempt try again', async () => {
		const { doc, scripts } = fakeDocument();
		const a = loadCaptchaSdk(SCRIPT, doc);
		(scripts[0]!.onerror as () => void)();
		await expect(a).rejects.toThrow('did not load');
		expect(scripts).toHaveLength(0);
		void loadCaptchaSdk(SCRIPT, doc).catch(() => {});
		expect(scripts).toHaveLength(1);
	});
});

describe('wafCaptchaOrigins (svelte.config.js, the meta CSP)', () => {
	it('allows exactly the SDK origin and its challenge script’s, or nothing', () => {
		expect(wafCaptchaOrigins(undefined)).toEqual([]);
		expect(wafCaptchaOrigins('')).toEqual([]);
		expect(wafCaptchaOrigins(SCRIPT)).toEqual(['https://a1b2c3.edge.captcha-sdk.awswaf.com', 'https://a1b2c3.edge.sdk.awswaf.com']);
		expect(wafCaptchaOrigins('https://a1b2c3.us-east-1.captcha-sdk.awswaf.com/a1b2c3/jsapi.js')).toEqual([
			'https://a1b2c3.us-east-1.captcha-sdk.awswaf.com',
			'https://a1b2c3.us-east-1.sdk.awswaf.com'
		]);
	});

	it('fails the build on any other URL rather than widening the policy', () => {
		expect(() => wafCaptchaOrigins('https://evil.example/jsapi.js')).toThrow();
		expect(() => wafCaptchaOrigins('https://*.captcha-sdk.awswaf.com/x/jsapi.js')).toThrow();
	});
});
