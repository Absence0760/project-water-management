import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: [vitePreprocess()],

	kit: {
		// SPA mode: routes like /projects/[id] can't be prerendered, so every
		// unknown path is served index.html and the client router takes over.
		// CloudFront serves /index.html for unknown paths (infra/s3_cloudfront.tf).
		adapter: adapter({ fallback: 'index.html' }),
		paths: {
			base: process.env.BASE_PATH || '',
		},
		// Emit a <meta> CSP pinning scripts to 'self' plus the hash of the one
		// inline bootstrap script. It narrows CloudFront's header policy
		// (infra/security_headers.tf); the deploy refuses a build without it
		// (infra/scripts/check-csp.mjs).
		csp: { mode: 'hash', directives: { 'script-src': ['self'] } },
	},
};

export default config;
