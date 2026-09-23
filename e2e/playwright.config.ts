// End-to-end tests. Fully local: docker Postgres (`pnpm dev:db:up`), the
// backend and the frontend dev servers on their own ports, and an isolated
// `water_e2e` database rebuilt by support/global-setup.ts on every run.
// See e2e/README.md.
import { defineConfig, devices } from '@playwright/test';
import { API_PORT, API_URL, APP_E2E_URL, WEB_PORT, WEB_URL } from './support/env.ts';

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
				SITE_URL: WEB_URL
			}
		},
		{
			command: `pnpm -C ../frontend exec vite dev --port ${WEB_PORT} --strictPort`,
			url: WEB_URL,
			reuseExistingServer: false,
			timeout: 120_000,
			env: { PUBLIC_API_URL: API_URL, PUBLIC_SITE_URL: WEB_URL }
		}
	]
});
