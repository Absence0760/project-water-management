import { defineEnvVars } from '@sveltejs/kit/env';

export const variables = defineEnvVars({
	PUBLIC_WAF_CAPTCHA_API_KEY: { public: true, static: true },
	PUBLIC_WAF_CAPTCHA_SCRIPT_URL: { public: true, static: true },
	PUBLIC_API_URL: { public: true, static: true },
	PUBLIC_TERRAIN_URL: { public: true, static: true },
	PUBLIC_TILES_GLYPHS_URL: { public: true, static: true },
	PUBLIC_TILES_URL: { public: true, static: true }
});
