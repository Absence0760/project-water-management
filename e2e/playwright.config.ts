// End-to-end tests. Fully local: docker Postgres (`pnpm dev:db:up`), the
// backend and a production build of the frontend on their own ports, and an
// isolated `water_e2e` database rebuilt by support/global-setup.ts on every
// run. See e2e/README.md.
import { defineConfig, devices } from '@playwright/test';
import { API_PORT, API_URL, APP_E2E_URL, WEB_PORT, WEB_URL } from './support/env.ts';

// The site under test is `vite build` output with the e2e API URL baked in
// (PUBLIC_API_URL is `$env/static/public`), served with the SPA fallback like
// CloudFront. Not the Vite dev server: a full page load there fetches hundreds
// of unbundled modules, and a few loads in a row exhaust Chromium's request
// resources (net::ERR_INSUFFICIENT_RESOURCES, "Failed to fetch dynamically
// imported module"). The build goes to its own directories, so frontend/build
// (the production build) and frontend/.svelte-kit are left alone.
// E2E_DEV_SERVER=1 runs against `vite dev` instead, for debugging with HMR.
const DEV_SERVER = process.env.E2E_DEV_SERVER === '1';
const E2E_BUILD_DIR = 'build-e2e';
const E2E_KIT_DIR = '.svelte-kit-e2e';

export default defineConfig({
	testDir: './tests',
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	// No retries: a flaky test is a bug to fix, not to re-roll.
	retries: 0,
	workers: process.env.CI ? 2 : undefined,
	reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
	globalSetup: './support/global-setup.ts',
	use: {
		baseURL: WEB_URL,
		timezoneId: 'UTC',
		locale: 'en-ZA',
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure'
	},
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
	webServer: [
		{
			// Not `tsx watch`: a restart mid-run would drop requests.
			command: 'pnpm -C ../backend exec tsx src/server.ts',
			url: `${API_URL}/health`,
			reuseExistingServer: false,
			timeout: 60_000,
			stdout: 'pipe',
			env: {
				PORT: String(API_PORT),
				DATABASE_URL: APP_E2E_URL,
				ALLOWED_ORIGINS: WEB_URL,
				SITE_URL: WEB_URL,
				// Print emails to the server log; e2e doesn't need Mailpit running.
				MAIL_TRANSPORT: 'log'
			}
		},
		DEV_SERVER
			? {
					command: `pnpm -C ../frontend exec vite dev --port ${WEB_PORT} --strictPort`,
					url: WEB_URL,
					reuseExistingServer: false,
					timeout: 120_000,
					env: { PUBLIC_API_URL: API_URL, PUBLIC_SITE_URL: WEB_URL }
				}
			: {
					// `svelte-kit sync` first: frontend/tsconfig.json extends the default
					// .svelte-kit/tsconfig.json, which a fresh clone doesn't have yet.
					command: [
						'pnpm -C ../frontend exec svelte-kit sync',
						`BUILD_DIR=${E2E_BUILD_DIR} SVELTE_KIT_DIR=${E2E_KIT_DIR} pnpm -C ../frontend exec vite build`,
						`node support/static-server.mjs ../frontend/${E2E_BUILD_DIR} ${WEB_PORT}`
					].join(' && '),
					url: WEB_URL,
					reuseExistingServer: false,
					// The build is ~20 s on an idle laptop; the rest is headroom for a
					// loaded one. It starts in parallel with the backend.
					timeout: 180_000,
					env: { PUBLIC_API_URL: API_URL, PUBLIC_SITE_URL: WEB_URL }
				}
	]
});
