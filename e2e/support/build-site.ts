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
import { API_URL } from './env.ts';

export const E2E_BUILD_DIR = 'build-e2e';
export const E2E_KIT_DIR = '.svelte-kit-e2e';

const frontend = fileURLToPath(new URL('../../frontend/', import.meta.url));

function run(args: string[], env: NodeJS.ProcessEnv = {}) {
	const r = spawnSync('pnpm', ['-C', frontend, 'exec', ...args], { stdio: 'inherit', env: { ...process.env, ...env } });
	if (r.status !== 0) process.exit(r.status ?? 1);
}

/** Written into the build: the API URL it was built for, so a prebuilt site for another slot is refused. */
export const API_URL_STAMP = 'e2e-api-url.txt';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	// `svelte-kit sync` first: frontend/tsconfig.json extends the default
	// .svelte-kit/tsconfig.json, which a fresh clone doesn't have yet.
	run(['svelte-kit', 'sync']);
	run(['vite', 'build'], { BUILD_DIR: E2E_BUILD_DIR, SVELTE_KIT_DIR: E2E_KIT_DIR, PUBLIC_API_URL: API_URL });
	writeFileSync(`${frontend}${E2E_BUILD_DIR}/${API_URL_STAMP}`, API_URL);
	console.log(`e2e site built for ${API_URL} → frontend/${E2E_BUILD_DIR}`);
}
