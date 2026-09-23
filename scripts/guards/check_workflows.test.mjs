import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkWorkflow, isProductionGated, jobsOf, needsOf, topLevelPermissions } from './check_workflows.mjs';

const SHA = 'de0fac2e4500dabe0009e67214ff5f5447ce83dd';

const good = `name: x
on: push
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${SHA} # v6.0.2
      - uses: ./.github/actions/local
  deploy:
    needs: build
    environment: production
    permissions:
      id-token: write
    steps:
      - uses: aws-actions/configure-aws-credentials@${SHA} # v6.1.1
`;

const rules = (text, file = '.github/workflows/x.yml') => checkWorkflow(file, text).map((f) => f.rule);

test('a SHA-pinned, OIDC-in-production workflow passes (positive control)', () => {
	assert.deepEqual(checkWorkflow('.github/workflows/x.yml', good), []);
});

test('tags, branches and short SHAs are not pins', () => {
	for (const ref of ['actions/checkout@v6', 'actions/checkout@main', 'actions/checkout@de0fac2']) {
		assert.deepEqual(rules(good.replace(`actions/checkout@${SHA}`, ref)), ['pin'], ref);
	}
});

test('a SHA pin needs its version comment', () => {
	assert.deepEqual(rules(good.replace(' # v6.0.2', '')), ['pin']);
	assert.deepEqual(rules(good.replace(' # v6.0.2', ' # latest')), ['pin']);
});

test('reusable-workflow calls are held to the same pin rule; local ones are exempt', () => {
	const call = `permissions: {}\njobs:\n  a:\n    uses: someone/repo/.github/workflows/x.yml@v1\n  b:\n    uses: ./.github/workflows/gitleaks.yml\n`;
	assert.deepEqual(rules(call), ['pin']);
});

test('static AWS keys fail anywhere but a comment', () => {
	assert.deepEqual(rules(good + '        with:\n          aws-access-key-id: ${{ secrets.K }}\n'), ['no-keys']);
	assert.deepEqual(rules(good + '# never use AWS_SECRET_ACCESS_KEY\n'), []);
});

test('top-level permissions are required and may not grant id-token', () => {
	assert.deepEqual(rules(good.replace('permissions:\n  contents: read\n', '')), ['perms']);
	assert.deepEqual(rules(good.replace('  contents: read\n', '  contents: read\n  id-token: write\n')), ['perms']);
	assert.equal(topLevelPermissions('permissions: read-all\njobs:\n'), 'permissions: read-all');
});

test('assuming an AWS role outside environment: production fails', () => {
	assert.deepEqual(rules(good.replace('    environment: production\n', '')), ['oidc-env']);
	assert.ok(isProductionGated(['    environment:', '      name: production', '      url: https://x']));
	assert.ok(!isProductionGated(['    environment: preview']));
});

test('jobsOf and needsOf read every needs shape', () => {
	const text = `jobs:\n  a:\n    runs-on: x\n  b:\n    needs: a\n  c:\n    needs: [a, b]\n  d:\n    needs:\n      - a\n      - c\n    runs-on: x\non: push\n`;
	const jobs = jobsOf(text);
	assert.deepEqual(jobs.map((j) => j.id), ['a', 'b', 'c', 'd']);
	assert.deepEqual(jobs.map((j) => needsOf(j.lines)), [[], ['a'], ['a', 'b'], ['a', 'c']]);
});

test('ci.yml: every job must fan into ci-gate', () => {
	const ci = `permissions:\n  contents: read\njobs:\n  test:\n    runs-on: x\n  lint:\n    runs-on: x\n  ci-gate:\n    needs: [test]\n`;
	const f = checkWorkflow('.github/workflows/ci.yml', ci);
	assert.deepEqual(f.map((x) => [x.rule, x.message.split(' ')[1]]), [['gate', 'lint']]);
	assert.deepEqual(checkWorkflow('.github/workflows/ci.yml', ci.replace('[test]', '[test, lint]')), []);
	assert.deepEqual(rules(ci.replace(/  ci-gate:[\s\S]*/, ''), '.github/workflows/ci.yml'), ['gate']);
});
