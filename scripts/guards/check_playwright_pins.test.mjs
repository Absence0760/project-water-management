import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { imageProblems, pinProblems, readPins } from './check_playwright_pins.mjs';

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
