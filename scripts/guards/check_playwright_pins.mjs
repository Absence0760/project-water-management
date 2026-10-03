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
// The same guard holds the rest of the renderer image's pins, which have no
// version to agree on but must stay pinned (imageProblems): every FROM
// carries an @sha256 digest, and every apt-get update / install reads one
// Ubuntu archive snapshot (`--snapshot <YYYYMMDDTHHMMSSZ>` or an
// APT_SNAPSHOT build arg holding one) and names each package at an exact
// `pkg=version`. Dependabot's docker entry (.github/dependabot.yml) moves the
// tag and digest; the apt pins move by hand with the snapshot.
//
// And the operator scripts' docker images (scriptImageProblems): every
// `<NAME>_IMAGE="${<NAME>_IMAGE:-<image>}"` default in bin/*.sh names its image
// by @sha256 digest (bin/tiles-dev.sh's GDAL image, which `water` runs when
// gdalwarp isn't installed). An override in the environment is the operator's
// choice and isn't checked.
//
// And the local-dev services (composeImageProblems): every `image:` in
// docker-compose.yml (Postgres, Mailpit, MinIO; CI starts MinIO and Mailpit
// from it too) names its image as tag@sha256 digest, so a re-pushed tag can't
// change what runs. Dependabot's docker-compose entry moves both.
//
// The image's digest can't be checked offline; a digest left on the old
// version keeps the old browser under a new tag, and the renderer image smoke
// (infra/scripts/smoke-renderer-image.sh, step 1) fails because the image's
// playwright-core can't find its Chromium build.
//
// Run:   pnpm check:pins
// CI:    ci.yml, job `workflow-lint` (Playwright pins step).
// Tests: node --test scripts/guards/check_playwright_pins.test.mjs

import { readdirSync, readFileSync } from 'node:fs';
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

const SNAPSHOT_ID = /^\d{8}T\d{6}Z$/;

/**
 * The renderer Dockerfile's instructions, comments dropped and `\`
 * continuations joined: [{ line, text }] (line is the instruction's first).
 */
function instructions(dockerfile) {
	const out = [];
	let current = null;
	dockerfile.split('\n').forEach((raw, i) => {
		const l = raw.trim();
		if (!current && (l === '' || l.startsWith('#'))) return;
		if (current && l.startsWith('#')) return;
		const body = l.replace(/\\$/, '').trim();
		if (current) current.text += ' ' + body;
		else current = { line: i + 1, text: body };
		if (!l.endsWith('\\')) {
			out.push(current);
			current = null;
		}
	});
	if (current) out.push(current);
	return out;
}

/**
 * What in the renderer Dockerfile is not pinned by content: one line each,
 * empty when every base image has a digest and every apt package an exact
 * version from one snapshot.
 */
export function imageProblems(dockerfile) {
	const problems = [];
	const where = (ins) => `backend/renderer.Dockerfile:${ins.line}`;
	const args = new Map();
	for (const ins of instructions(dockerfile)) {
		const arg = ins.text.match(/^ARG\s+(\w+)=(\S+)$/i);
		if (arg) args.set(arg[1], arg[2]);
		if (/^FROM\s/i.test(ins.text) && !/@sha256:[0-9a-f]{64}(\s|$)/.test(ins.text)) {
			problems.push(`${where(ins)}: FROM without an @sha256 digest (keep the tag beside it: image:tag@sha256:…)`);
		}
		if (!/^RUN\s/i.test(ins.text)) continue;
		for (const cmd of ins.text.replace(/^RUN\s+/i, '').split(/&&|;|\|\|/)) {
			const m = cmd.trim().match(/^apt-get\s+(.*)$/);
			if (!m) continue;
			const words = m[1].split(/\s+/);
			const verb = words.find((w) => w === 'update' || w === 'install');
			if (!verb) continue;
			const at = words.findIndex((w) => w === '--snapshot' || w === '-S');
			const id = at >= 0 ? words[at + 1]?.replace(/^"(.*)"$/, '$1') : undefined;
			const resolved = id?.match(/^\$\{?(\w+)\}?$/) ? args.get(id.match(/^\$\{?(\w+)\}?$/)[1]) : id;
			if (!resolved || !SNAPSHOT_ID.test(resolved)) {
				problems.push(`${where(ins)}: apt-get ${verb} without --snapshot <YYYYMMDDTHHMMSSZ>; the live archive drops a pinned version once it is superseded`);
			}
			if (verb === 'install') {
				const pkgs = words.slice(words.indexOf('install') + 1).filter((w, i, all) => !w.startsWith('-') && all[i - 1] !== '--snapshot' && all[i - 1] !== '-S');
				for (const pkg of pkgs) {
					if (!/^[a-z0-9][a-z0-9+.-]*=[^=\s]+$/.test(pkg)) problems.push(`${where(ins)}: apt package ${pkg} is not pinned to an exact version (pkg=version)`);
				}
				if (!pkgs.length) problems.push(`${where(ins)}: apt-get install names no packages this guard can read`);
			}
		}
	}
	return problems;
}

const SCRIPT_IMAGE = /^\s*([A-Z][A-Z0-9_]*_IMAGE)="\$\{\1:-([^}]*)\}"/gm;

/**
 * The docker images an operator script runs by default and isn't pinned by
 * digest: one line each. `where` names the script. A script with no
 * `*_IMAGE` default has nothing to check.
 */
export function scriptImageProblems(script, where) {
	const problems = [];
	for (const m of script.matchAll(SCRIPT_IMAGE)) {
		if (!/^[^\s@]+:[^\s@]+@sha256:[0-9a-f]{64}$/.test(m[2])) {
			problems.push(`${where}: ${m[1]} default "${m[2]}" is not pinned by digest (image:tag@sha256:…; docker buildx imagetools inspect <image:tag> gives it)`);
		}
	}
	return problems;
}

const COMPOSE_IMAGE = /^\s*image:\s*["']?([^"'\s#]+)["']?/gm;

/**
 * The docker-compose file's images that aren't pinned by digest: one line
 * each. `where` names the file. A file with no `image:` at all is a problem
 * too: the guard would otherwise pass on a layout it can't read.
 */
export function composeImageProblems(compose, where) {
	const images = [...compose.matchAll(COMPOSE_IMAGE)].map((m) => m[1]);
	if (!images.length) return [`${where}: no image: line found`];
	return images
		.filter((image) => !/^[^\s@]+:[^\s@]+@sha256:[0-9a-f]{64}$/.test(image))
		.map((image) => `${where}: image "${image}" is not pinned by digest (image:tag@sha256:…; docker buildx imagetools inspect <image:tag> gives it)`);
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
	const image = imageProblems(readFileSync(join(root, 'backend/renderer.Dockerfile'), 'utf8'));
	if (problems.length) console.error(`::error::Playwright pins:\n${problems.join('\n')}`);
	if (image.length) console.error(`::error::Renderer image pins:\n${image.join('\n')}`);
	const scripts = readdirSync(join(root, 'bin'))
		.filter((f) => f.endsWith('.sh'))
		.flatMap((f) => scriptImageProblems(readFileSync(join(root, 'bin', f), 'utf8'), `bin/${f}`));
	if (scripts.length) console.error(`::error::Operator script images:\n${scripts.join('\n')}`);
	const compose = composeImageProblems(readFileSync(join(root, 'docker-compose.yml'), 'utf8'), 'docker-compose.yml');
	if (compose.length) console.error(`::error::Local-dev service images:\n${compose.join('\n')}`);
	if (problems.length || image.length || scripts.length || compose.length) process.exit(1);
	console.log(
		`Playwright pins agree: ${pins[0].version} in ${pins.length} places. Renderer image: base by digest, apt packages by version and snapshot. Operator script images and docker-compose.yml's: by digest.`
	);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
