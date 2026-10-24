// The Svelte options and the meta CSP's CAPTCHA origins the build uses.
// SvelteKit 3 reads its configuration from the sveltekit() plugin in
// vite.config.ts (svelte.config.js is no longer read); vite.config.ts passes
// these in, and the tests that must see the build's own chain import them
// from here: tsSyntax.test.ts (preprocess), cssHash.test.ts (cssHash) and
// wafCaptcha.test.ts (wafCaptchaOrigins).
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

export const preprocess = [vitePreprocess()];

/** @type {import('svelte/compiler').CompileOptions} */
export const compilerOptions = {
	// Component styles are scoped by a class on every element; Svelte's
	// default is `svelte-<hash>`. `s<hash>` (same hash) is ~2.6 KB gzip
	// lighter across the bundle (issue #9). src/lib/cssHash.test.ts checks
	// no class the app writes itself can equal one.
	cssHash: ({ css, filename, hash }) => `s${hash(filename === '(unknown)' ? css : (filename ?? css))}`,
};

/**
 * The sign-in CAPTCHA's script origins for the meta CSP (issue #126,
 * src/lib/auth/wafCaptcha.ts): the CAPTCHA SDK's (jsapi.js) and the challenge
 * script's it loads, the same id on sdk.awswaf.com. Infra's header CSP
 * allows the same two (infra/security_headers.tf). None when the URL is
 * empty (local dev, tests); a URL of any other shape fails the build rather
 * than widening the policy.
 * @param {string | undefined} scriptUrl
 * @returns {Array<`https://${string}.awswaf.com`>}
 */
export function wafCaptchaOrigins(scriptUrl) {
	if (!scriptUrl) return [];
	const m = /^(https:\/\/([a-z0-9]+)\.([a-z0-9-]+))\.captcha-sdk\.awswaf\.com\/[a-z0-9]+\/jsapi\.js$/.exec(scriptUrl);
	if (!m) throw new Error(`PUBLIC_WAF_CAPTCHA_SCRIPT_URL must be https://<id>.<edge|region>.captcha-sdk.awswaf.com/<id>/jsapi.js, got ${scriptUrl}`);
	const host = /** @type {`https://${string}`} */ (m[1]);
	return [`${host}.captcha-sdk.awswaf.com`, `${host}.sdk.awswaf.com`];
}
