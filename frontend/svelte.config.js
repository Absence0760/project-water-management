import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: [vitePreprocess()],

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
		csp: { mode: 'hash', directives: { 'script-src': ['self'] } },
	},
};

export default config;
