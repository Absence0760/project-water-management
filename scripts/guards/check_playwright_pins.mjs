#!/usr/bin/env node
// The Playwright pins move as one (docs/followups.md § Server-side reports).
//
// The Chromium build is tied to the Playwright version, and the version is
// pinned in five places:
//
//   1. backend/package.json                     playwright-core (the worker's inline renderer, the DB tests)
//   2. e2e/package.json                         @playwright/test (e2e, and the Chromium CI installs for both)
//   3. backend/renderer-deps/package.json       playwright-core (the renderer image's driver)
//   4. backend/renderer-deps/package-lock.json  what `npm ci` installs in the image
//   5. backend/renderer.Dockerfile              the mcr.microsoft.com/playwright:v<version>-… tag, both FROM lines
//
// Dependabot groups 1 and 2 into one PR (.github/dependabot.yml, the
// `playwright` group) and leaves 3–5 alone (another ecosystem, and the image
// digest has to be looked up), so its PR fails here until 3–5 are moved by
// hand as renderer.Dockerfile's header says. Every pin must be exact: a range
// would let the lockfile drift from the image.
//
// The image's digest can't be checked offline; a digest left on the old
// version keeps the old browser under a new tag, and the renderer image smoke
// (infra/scripts/smoke-renderer-image.sh, step 1) fails because the image's
// playwright-core can't find its Chromium build.
//
// Run:   pnpm check:pins
// CI:    ci.yml, job `workflow-lint` (Playwright pins step).
// Tests: node --test scripts/guards/check_playwright_pins.test.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXACT = /^\d+\.\d+\.\d+$/;
const IMAGE = /^FROM\s+mcr\.microsoft\.com\/playwright:v([^\s@-]+)(?:-[^\s@]*)?(?:@\S+)?/gm;

/**
 * The pins in the repo at `root`: [{ where, version }] (version null when the
 * pin is missing), read through `read(relativePath) → text`.
 */
export function readPins(read) {
	const json = (path) => JSON.parse(read(path));
	const pins = [];
	const add = (where, version) => pins.push({ where, version: version ?? null });

	add('backend/package.json playwright-core', json('backend/package.json').dependencies?.['playwright-core']);
	add('e2e/package.json @playwright/test', json('e2e/package.json').devDependencies?.['@playwright/test']);
	add('backend/renderer-deps/package.json playwright-core', json('backend/renderer-deps/package.json').dependencies?.['playwright-core']);
	add(
		'backend/renderer-deps/package-lock.json node_modules/playwright-core',
		json('backend/renderer-deps/package-lock.json').packages?.['node_modules/playwright-core']?.version
	);
	const dockerfile = read('backend/renderer.Dockerfile');
	const tags = [...dockerfile.matchAll(IMAGE)].map((m) => m[1]);
	if (!tags.length) add('backend/renderer.Dockerfile FROM mcr.microsoft.com/playwright', null);
	tags.forEach((tag, i) => add(`backend/renderer.Dockerfile FROM #${i + 1} (mcr.microsoft.com/playwright:v…)`, tag));
	return pins;
}

/** What is wrong with the pins: one line each, empty when they agree. */
export function pinProblems(pins) {
	const problems = [];
	for (const p of pins) {
		if (p.version === null) problems.push(`${p.where}: no pin found`);
		else if (!EXACT.test(p.version)) problems.push(`${p.where}: "${p.version}" is not an exact version`);
	}
	const versions = new Set(pins.filter((p) => p.version !== null).map((p) => p.version));
	if (versions.size > 1) {
		problems.push(`the Playwright pins disagree (move them together; backend/renderer.Dockerfile's header says how):`);
		for (const p of pins) problems.push(`  ${p.where}: ${p.version ?? '(none)'}`);
	}
	return problems;
}

function main() {
	const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
	const pins = readPins((path) => readFileSync(join(root, path), 'utf8'));
	const problems = pinProblems(pins);
	if (problems.length) {
		console.error(`::error::Playwright pins:\n${problems.join('\n')}`);
		process.exit(1);
	}
	console.log(`Playwright pins agree: ${pins[0].version} in ${pins.length} places.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
