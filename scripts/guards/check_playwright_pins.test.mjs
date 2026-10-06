import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { composeImageProblems, imageProblems, lockfileTarballProblems, pinProblems, readPins, scriptImageProblems } from './check_playwright_pins.mjs';

const DIGEST = '@sha256:' + 'a'.repeat(64);

/** A repo whose five pins are `v` unless overridden. */
function repo({ backend = '1.63.0', e2e = '1.63.0', deps = '1.63.0', lock = '1.63.0', from = ['1.63.0', '1.63.0'] } = {}) {
	const files = {
		'backend/package.json': JSON.stringify({ dependencies: { 'playwright-core': backend } }),
		'e2e/package.json': JSON.stringify({ devDependencies: { '@playwright/test': e2e } }),
		'backend/renderer-deps/package.json': JSON.stringify({ dependencies: { 'playwright-core': deps } }),
		'backend/renderer-deps/package-lock.json': JSON.stringify({ packages: { 'node_modules/playwright-core': { version: lock } } }),
		'backend/renderer.Dockerfile': [
			'# FROM mcr.microsoft.com/playwright:v9.9.9-noble in a comment is not a pin',
			...from.map((v, i) => `FROM mcr.microsoft.com/playwright:v${v}-noble${DIGEST}${i === 0 ? ' AS deps' : ''}\nRUN true`)
		].join('\n')
	};
	return (path) => {
		if (!(path in files)) throw new Error(`no ${path}`);
		return files[path];
	};
}

test('five agreeing exact pins pass', () => {
	const pins = readPins(repo());
	assert.equal(pins.length, 6); // two FROM lines
	assert.ok(pins.every((p) => p.version === '1.63.0'));
	assert.deepEqual(pinProblems(pins), []);
});

test('a Dependabot bump of backend + e2e alone fails until the image side moves', () => {
	const problems = pinProblems(readPins(repo({ backend: '1.64.0', e2e: '1.64.0' })));
	assert.match(problems[0], /disagree/);
	assert.ok(problems.some((p) => p.includes('backend/renderer.Dockerfile FROM #1') && p.endsWith('1.63.0')));
	assert.ok(problems.some((p) => p.includes('backend/package.json') && p.endsWith('1.64.0')));
});

test('each place is checked on its own', () => {
	for (const key of ['backend', 'e2e', 'deps', 'lock']) {
		assert.match(pinProblems(readPins(repo({ [key]: '1.62.0' })))[0], /disagree/, key);
	}
	assert.match(pinProblems(readPins(repo({ from: ['1.63.0', '1.62.0'] })))[0], /disagree/, 'second FROM');
});

test('a range is refused even when the numbers agree', () => {
	const problems = pinProblems(readPins(repo({ backend: '^1.63.0' })));
	assert.ok(problems.some((p) => /backend\/package\.json playwright-core: "\^1\.63\.0" is not an exact version/.test(p)));
});

test('a missing pin is a problem, not a silent pass', () => {
	assert.ok(pinProblems(readPins(repo({ from: [] }))).some((p) => /Dockerfile.*no pin found/.test(p)));
	const noBackend = repo();
	const read = (path) => (path === 'backend/package.json' ? JSON.stringify({ dependencies: {} }) : noBackend(path));
	assert.ok(pinProblems(readPins(read)).some((p) => /backend\/package\.json playwright-core: no pin found/.test(p)));
});

test('the repo itself passes', () => {
	const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
	const pins = readPins((path) => readFileSync(join(root, path), 'utf8'));
	assert.equal(pins.length, 6);
	assert.deepEqual(pinProblems(pins), []);
});

const PINNED_IMAGE = `FROM mcr.microsoft.com/playwright:v1.63.0-noble${DIGEST} AS deps
# apt-get install -y unpinned-in-a-comment
ARG APT_SNAPSHOT=20260928T000000Z
RUN apt-get update --snapshot "$APT_SNAPSHOT" \\
	&& apt-get install --snapshot "$APT_SNAPSHOT" -y --no-install-recommends \\
		g++=4:13.2.0-7ubuntu1 \\
		xz-utils=5.6.1+really5.4.5-1ubuntu0.3 \\
	&& rm -rf /var/lib/apt/lists/*
FROM mcr.microsoft.com/playwright:v1.63.0-noble${DIGEST}
USER pwuser
`;

test('a digest-pinned base and snapshot-pinned apt packages pass (positive control)', () => {
	assert.deepEqual(imageProblems(PINNED_IMAGE), []);
});

test('a literal snapshot id passes as well as the build arg', () => {
	assert.deepEqual(imageProblems(PINNED_IMAGE.replaceAll('"$APT_SNAPSHOT"', '20260928T000000Z')), []);
	assert.deepEqual(imageProblems(PINNED_IMAGE.replaceAll('"$APT_SNAPSHOT"', '${APT_SNAPSHOT}')), []);
});

test('a FROM without a digest is refused', () => {
	const problems = imageProblems(PINNED_IMAGE.replace(`noble${DIGEST}\nUSER`, 'noble\nUSER'));
	assert.deepEqual(problems, ['backend/renderer.Dockerfile:9: FROM without an @sha256 digest (keep the tag beside it: image:tag@sha256:…)']);
});

test('an unpinned apt package is refused, each one named', () => {
	const problems = imageProblems(
		PINNED_IMAGE.replace('g++=4:13.2.0-7ubuntu1', 'g++').replace('xz-utils=5.6.1+really5.4.5-1ubuntu0.3', 'xz-utils')
	);
	assert.deepEqual(problems, [
		'backend/renderer.Dockerfile:4: apt package g++ is not pinned to an exact version (pkg=version)',
		'backend/renderer.Dockerfile:4: apt package xz-utils is not pinned to an exact version (pkg=version)'
	]);
});

test('apt-get update or install from the live archive is refused', () => {
	const refused = (text, verb) => assert.match(imageProblems(text).join('\n'), new RegExp(`apt-get ${verb} without --snapshot`));
	refused(PINNED_IMAGE.replace('apt-get update --snapshot "$APT_SNAPSHOT"', 'apt-get update'), 'update');
	refused(PINNED_IMAGE.replace('apt-get install --snapshot "$APT_SNAPSHOT"', 'apt-get install'), 'install');
	refused(PINNED_IMAGE.replace('ARG APT_SNAPSHOT=20260928T000000Z', 'ARG APT_SNAPSHOT=latest'), 'update');
	refused(PINNED_IMAGE.replace('ARG APT_SNAPSHOT=20260928T000000Z\n', ''), 'install');
});

test('the renderer Dockerfile in the repo passes', () => {
	const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
	assert.deepEqual(imageProblems(readFileSync(join(root, 'backend/renderer.Dockerfile'), 'utf8')), []);
});

const GDAL = 'ghcr.io/osgeo/gdal:ubuntu-small-3.11.3';

test('an operator script image default pinned by digest passes (positive control)', () => {
	assert.deepEqual(scriptImageProblems(`GDAL_IMAGE="\${GDAL_IMAGE:-${GDAL}${DIGEST}}"\n`, 'bin/x.sh'), []);
	assert.deepEqual(scriptImageProblems('echo "no image here"\n', 'bin/x.sh'), []);
});

test('an operator script image default by tag alone, or with a short digest, is refused', () => {
	for (const image of [GDAL, `${GDAL}@sha256:abc`, `ghcr.io/osgeo/gdal@sha256:${'a'.repeat(63)}`]) {
		const problems = scriptImageProblems(`\tGDAL_IMAGE="\${GDAL_IMAGE:-${image}}"\n`, 'bin/x.sh');
		assert.equal(problems.length, 1, image);
		assert.match(problems[0], /^bin\/x\.sh: GDAL_IMAGE default ".*" is not pinned by digest/);
	}
});

test("the repo's operator scripts pass, and tiles-dev.sh's GDAL image is among them", () => {
	const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
	const tiles = readFileSync(join(root, 'bin/tiles-dev.sh'), 'utf8');
	assert.match(tiles, /^GDAL_IMAGE="\$\{GDAL_IMAGE:-ghcr\.io\/osgeo\/gdal:[^@}]+@sha256:[0-9a-f]{64}\}"/m);
	assert.deepEqual(scriptImageProblems(tiles, 'bin/tiles-dev.sh'), []);
});

test('docker-compose images pinned by tag and digest pass (positive control)', () => {
	const compose = `services:\n  db:\n    image: postgres:17-alpine${DIGEST}\n  mail:\n    image: "axllent/mailpit:v1.31.2${DIGEST}" # quoted\n`;
	assert.deepEqual(composeImageProblems(compose, 'docker-compose.yml'), []);
});

test('a docker-compose image by tag alone, by digest alone or with a short digest is refused, one line each', () => {
	for (const image of ['postgres:17-alpine', `postgres${DIGEST}`, 'postgres:17-alpine@sha256:abc']) {
		const problems = composeImageProblems(`services:\n  db:\n    image: ${image}\n  ok:\n    image: minio:x${DIGEST}\n`, 'docker-compose.yml');
		assert.deepEqual(problems.length, 1, image);
		assert.match(problems[0], new RegExp(`^docker-compose\\.yml: image "${image.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" is not pinned by digest`));
	}
});

test('a docker-compose file with no image line is a problem, not a pass', () => {
	assert.deepEqual(composeImageProblems('services: {}\n', 'docker-compose.yml'), ['docker-compose.yml: no image: line found']);
});

test("the repo's docker-compose.yml pins Postgres, Mailpit and MinIO by digest", () => {
	const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
	const compose = readFileSync(join(root, 'docker-compose.yml'), 'utf8');
	for (const name of ['postgres', 'axllent/mailpit', 'pgsty/minio']) assert.match(compose, new RegExp(`^\\s*image: ${name}:[^@\\s]+@sha256:[0-9a-f]{64}$`, 'm'), name);
	assert.deepEqual(composeImageProblems(compose, 'docker-compose.yml'), []);
});

test('a URL tarball in pnpm-lock.yaml must keep its integrity hash', () => {
	const url = 'https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz';
	const pinned = `packages:\n  xlsx@${url}:\n    resolution: {integrity: sha512-oLDq3jw7AcLq==, tarball: ${url}}\n    version: 0.20.3\n`;
	const stripped = `packages:\n  xlsx@${url}:\n    resolution: {tarball: ${url}}\n    version: 0.20.3\n`;
	// Positive control: the pinned form passes, and so does a registry package (no tarball).
	assert.deepEqual(lockfileTarballProblems(pinned, 'pnpm-lock.yaml'), []);
	assert.deepEqual(lockfileTarballProblems('  nodemailer@10.0.11:\n    resolution: {integrity: sha512-abc==}\n', 'pnpm-lock.yaml'), []);
	assert.deepEqual(lockfileTarballProblems(stripped, 'pnpm-lock.yaml'), [`pnpm-lock.yaml: ${url} has no integrity hash; restore it (pnpm install from a lockfile that has it) rather than trust the URL`]);
});

test("the repo's pnpm-lock.yaml keeps every URL tarball's integrity (real positive control)", () => {
	const lock = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'pnpm-lock.yaml'), 'utf8');
	assert.match(lock, /tarball: https:/, 'the lockfile has a URL tarball for this guard to check');
	assert.deepEqual(lockfileTarballProblems(lock, 'pnpm-lock.yaml'), []);
});
