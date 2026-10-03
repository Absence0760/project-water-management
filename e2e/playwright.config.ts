// End-to-end tests. Fully local: docker Postgres (`pnpm dev:db:up`), the
// backend and a production build of the frontend on their own ports, and an
// isolated e2e database rebuilt by support/global-setup.ts on every run. The
// ports and the database are per checkout (support/env.ts), so e2e runs in two
// worktrees at once don't collide. See e2e/README.md.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import { API_URL_STAMP, E2E_BUILD_DIR, E2E_CAPTCHA } from './support/build-site.ts';
import { DEM_FIXTURE } from './support/dem.ts';
import { WATER_FIXTURE } from './support/water.ts';
import { API_PORT, API_URL, APP_E2E_URL, WEB_PORT, WEB_URL } from './support/env.ts';

// The site under test is `vite build` output with the e2e API URL baked in
// (support/build-site.ts), served with the SPA fallback like CloudFront. Not
// the Vite dev server: a full page load there fetches hundreds of unbundled
// modules, and a few loads in a row exhaust Chromium's request resources
// (net::ERR_INSUFFICIENT_RESOURCES, "Failed to fetch dynamically imported
// module"). E2E_DEV_SERVER=1 runs against `vite dev` instead, for debugging
// with HMR. E2E_PREBUILT=1 serves an existing build (CI builds it once for
// every shard); it must have been built for this checkout's API URL.
const DEV_SERVER = process.env.E2E_DEV_SERVER === '1';
const PREBUILT = process.env.E2E_PREBUILT === '1';
if (PREBUILT && !DEV_SERVER) {
	const stamp = `../frontend/${E2E_BUILD_DIR}/${API_URL_STAMP}`;
	const builtFor = existsSync(stamp) ? readFileSync(stamp, 'utf8').trim() : null;
	if (builtFor !== API_URL) {
		throw new Error(`E2E_PREBUILT=1, but frontend/${E2E_BUILD_DIR} was built for ${builtFor ?? 'nothing (no build)'}, not ${API_URL}. Run \`pnpm -C e2e build:site\` or drop E2E_PREBUILT.`);
	}
}
// CI shards (E2E_BLOB=1) each write a blob report; the e2e-report job merges them.
const BLOB = process.env.E2E_BLOB === '1';
// The browser sees only the fonts in e2e/fonts (fonts.conf says why): the
// same DejaVu everywhere, so a layout check that passes here passes in CI.
export const E2E_FONTCONFIG = fileURLToPath(new URL('./fonts/fonts.conf', import.meta.url));

export default defineConfig({
	testDir: './tests',
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	// No retries: a flaky test is a bug to fix, not to re-roll.
	retries: 0,
	// Every worker shares one API process (single-threaded Node), and the heavy
	// requests (multi-year runs, 20-run setups, ensemble checks) block it for
	// everyone. Playwright's default, half the cores (10 on a 20-core laptop),
	// queued pages past their waits: 6 load-timeout failures in a full run on
	// a clean main, all passing at 6 workers, which also finished sooner
	// (167 s vs 192 s). CI runs 2 per shard, each shard with its own API.
	// E2E_WORKERS overrides it for a one-off run.
	workers: process.env.CI ? 2 : Number(process.env.E2E_WORKERS) || 6,
	reporter: BLOB ? [['list'], ['blob']] : process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
	globalSetup: './support/global-setup.ts',
	use: {
		baseURL: WEB_URL,
		timezoneId: 'UTC',
		locale: 'en-ZA',
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure'
	},
	projects: [
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'], launchOptions: { env: { ...process.env, FONTCONFIG_FILE: E2E_FONTCONFIG } } }
		}
	],
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
				MAIL_TRANSPORT: 'log',
				// Argon2id at its smallest parameters, as under vitest (backend/src/auth/password.ts).
				// Every test registers a user, and a production hash is ~110 ms of CPU on
				// this one shared server: with bcrypt at cost 12, hashing took over a
				// third of the server's time in a parallel run, and model saves and page
				// loads queued past their waits behind it (issue #41). e2e tests sign-up
				// and login, not the work factor; Lambda refuses the override.
				PASSWORD_HASH_FAST: '1',
				// TEST-ONLY: every e2e test signs up accounts, all from this one address,
				// far past the sign-up throttle's 10 an hour (backend/src/auth/signupThrottle.ts;
				// its own tests are in the backend). Lambda refuses the setting.
				SIGNUP_THROTTLE: 'off',
				// TEST-ONLY: the second-factor requirement for owners, team admins and
				// assessors off (backend/src/auth/stepUp.ts). Hundreds of specs make a
				// project owner who signs in with a password only; two-step sign-in
				// itself (enrolment, the sign-in step, recovery codes) works the same
				// either way and is tested in two-step-signin.spec.ts, and the
				// requirement in backend/src/auth/stepUp.db.test.ts. Lambda refuses it.
				MFA_REQUIRED: 'false',
				// The pack specs sign with invented registrations nobody checked against a register (167_signers).
				REGISTRATION_CHECK_REQUIRED: 'false',
				// Delineation on, against the committed synthetic DEM (invented terrain; map-delineate.spec.ts).
				DEM_URL: DEM_FIXTURE,
				// Tracing a dam on, against the committed synthetic water occurrence raster (invented water; map-assisted.spec.ts).
				WATER_URL: WATER_FIXTURE
			}
		},
		DEV_SERVER
			? {
					command: `pnpm -C ../frontend exec vite dev --port ${WEB_PORT} --strictPort`,
					url: WEB_URL,
					reuseExistingServer: false,
					timeout: 120_000,
					env: { PUBLIC_API_URL: API_URL, ...E2E_CAPTCHA }
				}
			: {
					command: [
						...(PREBUILT ? [] : ['node support/build-site.ts']),
						`node support/static-server.ts ../frontend/${E2E_BUILD_DIR} ${WEB_PORT}`
					].join(' && '),
					url: WEB_URL,
					reuseExistingServer: false,
					// The build is ~20 s on an idle laptop; the rest is headroom for a
					// loaded one. It starts in parallel with the backend.
					timeout: 180_000
				}
	]
});
