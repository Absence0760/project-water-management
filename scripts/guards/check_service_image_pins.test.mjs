// serviceImageProblems (check_playwright_pins.mjs): no workflow starts a
// service container through a job's `services:`, which is always pulled from
// its registry (issues #492, #521); CI starts docker-compose.yml's services
// through scripts/ci/service-image.sh instead.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { serviceImageProblems } from './check_playwright_pins.mjs';

const A = 'sha256:' + 'a'.repeat(64);
const job = (services) =>
	[
		'jobs:',
		'  db:',
		'    runs-on: ubuntu-latest',
		...(services ? ['    services:', '      postgres:', '        # a comment inside the service', `        image: ${services}`, '        ports:', '          - 5434:5432'] : []),
		'    steps:',
		'      - run: docker run --rm alpine:3 true',
		'        with:',
		'          image: not-a-service:latest',
		'      - run: bash scripts/ci/service-image.sh save postgres "$RUNNER_TEMP/p.tar"'
	].join('\n');
const check = (wf) => serviceImageProblems([{ where: 'ci.yml', text: wf }]);

test('a job without services passes; an image: outside services is not a service (positive control)', () => {
	assert.deepEqual(check(job(null)), []);
});

test("a services: image fails on its line, even pinned at compose's digest: it is still pulled from its registry", () => {
	const [problem, ...rest] = check(job(`public.ecr.aws/docker/library/postgres:17-alpine@${A}`));
	assert.deepEqual(rest, []);
	assert.match(problem, /^ci\.yml:7: service container public\.ecr\.aws\/docker\/library\/postgres:17-alpine@sha256:a+ is pulled from its registry/);
	assert.match(problem, /scripts\/ci\/service-image\.sh/);
});

test('a tag-only or quoted services: image fails too', () => {
	assert.equal(check(job('postgres:17-alpine')).length, 1);
	const quoted = ['jobs:', '  t:', '    services:', '      db:', `        image: "postgres:17-alpine"`, '    steps: []'].join('\n');
	assert.equal(check(quoted).length, 1);
});

test("the repo's workflows start no service container through services:", () => {
	const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
	const dir = join(root, '.github', 'workflows');
	const workflows = readdirSync(dir)
		.filter((f) => /\.ya?ml$/.test(f))
		.map((f) => ({ where: f, text: readFileSync(join(dir, f), 'utf8') }));
	assert.deepEqual(serviceImageProblems(workflows), []);
	// And the jobs that need Postgres do start it (so the check above checked something).
	for (const f of ['ci.yml', 'coverage.yml']) {
		assert.match(readFileSync(join(dir, f), 'utf8'), /service-image\.sh load "?\$svc"?/, f);
	}
});
