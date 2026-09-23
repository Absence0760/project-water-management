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
	},
};

export default config;
