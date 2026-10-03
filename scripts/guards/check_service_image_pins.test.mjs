// serviceImageProblems (check_playwright_pins.mjs): CI's service containers run
// docker-compose.yml's image by its digest.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { serviceImageProblems } from './check_playwright_pins.mjs';

const A = 'sha256:' + 'a'.repeat(64);
const B = 'sha256:' + 'b'.repeat(64);
const compose = (postgres = `postgres:17-alpine@${A}`) =>
	['services:', '  postgres:', `    image: ${postgres}`, '  mailpit:', `    image: axllent/mailpit:v1.31.2@${B}`].join('\n');
const workflow = (...images) =>
	[
		'jobs:',
		...images.flatMap((image, i) => [
			`  job${i}:`,
			'    runs-on: ubuntu-latest',
			'    services:',
			'      postgres:',
			'        # a comment inside the service',
			`        image: ${image}`,
			'        ports:',
			'          - 5434:5432',
			'    steps:',
			'      - run: docker run --rm alpine:3 true',
			'        with:',
			'          image: not-a-service:latest'
		])
	].join('\n');
const check = (wf, c = compose()) => serviceImageProblems([{ where: 'ci.yml', text: wf }], c);

test("service images at compose's digest pass; an image: outside services is not a service", () => {
	assert.deepEqual(check(workflow(`postgres:17-alpine@${A}`, `postgres:17-alpine@${A}`)), []);
});

test('a service image by tag only fails, on its line', () => {
	const problems = check(workflow(`postgres:17-alpine@${A}`, 'postgres:17-alpine'));
	assert.equal(problems.length, 1);
	assert.match(problems[0], /^ci\.yml:19: service image "postgres:17-alpine" is not pinned by digest/);
});

test("a digest other than compose's fails, naming both", () => {
	const [problem, ...rest] = check(workflow(`postgres:17-alpine@${B}`));
	assert.deepEqual(rest, []);
	assert.match(problem, new RegExp(`at ${B}, docker-compose.yml at ${A}`));
});

test('compose without a digest for the image, or without the image at all, fails', () => {
	assert.match(check(workflow(`postgres:17-alpine@${A}`), compose('postgres:17-alpine')).join(), /names postgres:17-alpine without a digest/);
	assert.match(check(workflow(`postgres:16-alpine@${A}`)).join(), /postgres:16-alpine is not one docker-compose.yml runs/);
});

test('a quoted service image is read too', () => {
	const wf = ['jobs:', '  t:', '    services:', '      db:', `        image: "postgres:17-alpine"`, '    steps: []'].join('\n');
	assert.equal(check(wf).length, 1);
});

test("the repo's workflows run compose's digests", () => {
	const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
	const dir = join(root, '.github', 'workflows');
	const workflows = readdirSync(dir)
		.filter((f) => /\.ya?ml$/.test(f))
		.map((f) => ({ where: f, text: readFileSync(join(dir, f), 'utf8') }));
	assert.ok(workflows.some((w) => /^\s+services:/m.test(w.text)), 'ci.yml has services to check');
	assert.deepEqual(serviceImageProblems(workflows, readFileSync(join(root, 'docker-compose.yml'), 'utf8')), []);
});
