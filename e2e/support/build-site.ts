// Builds the site under test: `vite build` output with this checkout's e2e API
// URL baked in (PUBLIC_API_URL is `$env/static/public`), into its own
// directories so frontend/build and frontend/.svelte-kit are left alone.
//
//   node support/build-site.ts        (from e2e/; Node 24 runs the .ts as is)
//
// playwright.config.ts runs it before serving the site, unless E2E_PREBUILT=1
// says the build is already there (CI builds it once and hands it to every
// shard). `pnpm -C e2e build:site` runs it on its own.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { API_URL, buildDirsFor, E2E_SLOT } from './env.ts';

/** Per slot (env.ts buildDirsFor): `build-e2e` in the main checkout and CI, `build-e2e-<slot>` elsewhere. */
export const E2E_BUILD_DIR = buildDirsFor(E2E_SLOT).build;
export const E2E_KIT_DIR = buildDirsFor(E2E_SLOT).kit;

const frontend = fileURLToPath(new URL('../../frontend/', import.meta.url));

function run(args: string[], env: NodeJS.ProcessEnv = {}) {
	const r = spawnSync('pnpm', ['-C', frontend, 'exec', ...args], { stdio: 'inherit', env: { ...process.env, ...env } });
	if (r.status !== 0) process.exit(r.status ?? 1);
}

/**
 * The sign-in CAPTCHA's build config for the e2e site (frontend
 * lib/auth/wafCaptcha.ts): a script URL of the SDK's shape, which
 * captcha.spec.ts answers with a stub through page.route (nothing reaches
 * AWS), and a dummy key. The puzzle stays dormant until a sign-in gets the
 * WAF's 405, which only that spec fakes.
 */
export const E2E_CAPTCHA = {
	PUBLIC_WAF_CAPTCHA_SCRIPT_URL: 'https://e2e0000.edge.captcha-sdk.awswaf.com/e2e0000/jsapi.js',
	PUBLIC_WAF_CAPTCHA_API_KEY: 'e2e-not-a-key'
} as const;

/** Written into the build: the API URL it was built for, so a prebuilt site for another slot is refused. */
export const API_URL_STAMP = 'e2e-api-url.txt';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	// `svelte-kit sync` first: frontend/tsconfig.json extends the default
	// .svelte-kit/tsconfig.json, which a fresh clone doesn't have yet.
	run(['svelte-kit', 'sync']);
	run(['vite', 'build'], { BUILD_DIR: E2E_BUILD_DIR, SVELTE_KIT_DIR: E2E_KIT_DIR, PUBLIC_API_URL: API_URL, ...E2E_CAPTCHA });
	writeFileSync(`${frontend}${E2E_BUILD_DIR}/${API_URL_STAMP}`, API_URL);
	console.log(`e2e site built for ${API_URL} → frontend/${E2E_BUILD_DIR}`);
}
