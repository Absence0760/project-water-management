import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

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

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: [vitePreprocess()],
	compilerOptions: {
		// Component styles are scoped by a class on every element; Svelte's
		// default is `svelte-<hash>`. `s<hash>` (same hash) is ~2.6 KB gzip
		// lighter across the bundle (issue #9). src/lib/cssHash.test.ts checks
		// no class the app writes itself can equal one.
		cssHash: ({ css, filename, hash }) => `s${hash(filename === '(unknown)' ? css : (filename ?? css))}`,
	},

	kit: {
		// SPA mode: routes like /projects/[id] can't be prerendered, so every
		// unknown path is served index.html and the client router takes over.
		// CloudFront serves /index.html for unknown paths (infra/s3_cloudfront.tf).
		// The e2e build (e2e/playwright.config.ts) bakes in the e2e API URL, so
		// it writes elsewhere (BUILD_DIR, SVELTE_KIT_DIR) and never touches the
		// production output in build/ or the .svelte-kit/ a running dev server uses.
		adapter: adapter({ pages: process.env.BUILD_DIR || 'build', fallback: 'index.html' }),
		outDir: process.env.SVELTE_KIT_DIR || '.svelte-kit',
		paths: {
			// Kit rejects a base without a leading '/' at startup; the cast only
			// tells the type checker (this file is type-checked, since
			// tsSyntax.test.ts imports it).
			base: /** @type {'' | `/${string}`} */ (process.env.BASE_PATH || ''),
		},
		// Emit a <meta> CSP pinning scripts to 'self' plus the hash of the one
		// inline bootstrap script. It narrows CloudFront's header policy
		// (infra/security_headers.tf); the deploy refuses a build without it
		// (infra/scripts/check-csp.mjs).
		// The sign-in CAPTCHA's two script origins join it when the deploy
		// sets PUBLIC_WAF_CAPTCHA_SCRIPT_URL (wafCaptchaOrigins below).
		csp: { mode: 'hash', directives: { 'script-src': ['self', ...wafCaptchaOrigins(process.env.PUBLIC_WAF_CAPTCHA_SCRIPT_URL)] } },
		// The one prerendered page, the landing page at /welcome (issue #57),
		// writes absolute URLs into its link-preview tags (og:url, og:image,
		// the canonical link) from the site's origin: the deploy's
		// PUBLIC_SITE_URL (deploy-frontend.yml), else the local dev site.
		prerender: { origin: process.env.SITE_ORIGIN || 'http://localhost:7777' },
	},
};

export default config;
