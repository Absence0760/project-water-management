// The landing page's app screens (issue #57), captured by `pnpm gen:landing-art`
// (bin/gen-landing-art.sh) from the app itself on the invented example
// catchments: the e2e setup (its own database, backend and production build of
// the site, ../playwright.config.ts) with this folder as the test directory.
// Not part of the e2e suite: it writes pictures, it asserts nothing about the app.
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import base from '../playwright.config.ts';

// The e2e config's paths and server commands are relative to e2e/.
const e2e = fileURLToPath(new URL('..', import.meta.url));
const servers = Array.isArray(base.webServer) ? base.webServer : base.webServer ? [base.webServer] : [];

export default defineConfig({
	...base,
	testDir: '.',
	globalSetup: `${e2e}support/global-setup.ts`,
	webServer: servers.map((s) => ({ ...s, cwd: e2e })),
	workers: 1,
	reporter: 'list',
	use: { ...base.use, deviceScaleFactor: 1 }
});
