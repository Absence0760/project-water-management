import assert from 'node:assert/strict';
import { test } from 'node:test';
import { branchPolicyProblem, ciGateState, compareVersions, environmentProblem, missingConfig, notNewerThan, parseReleaseTag, tagRulesetProblem, trustedCiGateRuns } from './preflight.mjs';

test('release tags are <component>@semver', () => {
	assert.deepEqual(parseReleaseTag('web@1.2.3', 'web'), { ok: true, version: '1.2.3', prerelease: false });
	assert.deepEqual(parseReleaseTag('backend@0.1.0-rc.1', 'backend'), { ok: true, version: '0.1.0-rc.1', prerelease: true });
	for (const [tag, why] of [
		['', /no release tag/],
		['v1.2.3', /not a web release/],
		['backend@1.2.3', /not a web release/],
		['web@1.2', /not a semantic version/],
		['web@01.2.3', /not a semantic version/],
		['web@1.2.3 ', /not a semantic version/],
	]) {
		const r = parseReleaseTag(tag, 'web');
		assert.equal(r.ok, false, tag);
		assert.match(/** @type {{ error: string }} */ (r).error, why, tag);
	}
});

test('versions compare numerically, not lexically', () => {
	assert.ok(compareVersions('1.10.0', '1.9.0') > 0);
	assert.ok(compareVersions('0.2.0', '0.10.0') < 0);
	assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
});

test('a release must be newer than every published release of its component', () => {
	const releases = [
		{ tagName: 'web@0.2.0', isDraft: false, isPrerelease: false },
		{ tagName: 'web@0.3.0-rc.1', isDraft: false, isPrerelease: true },
		{ tagName: 'web@0.9.0', isDraft: true, isPrerelease: false },
		{ tagName: 'backend@5.0.0', isDraft: false, isPrerelease: false },
		{ tagName: 'web@0.3.0', isDraft: false, isPrerelease: false },
	];
	assert.deepEqual(notNewerThan('0.3.0', 'web', 'web@0.3.0', releases), [], 'itself, drafts, prereleases and other components are ignored');
	assert.deepEqual(notNewerThan('0.2.5', 'web', 'web@0.2.5', releases), ['0.3.0']);
	assert.deepEqual(notNewerThan('0.2.0', 'web', 'web@0.2.0-again', releases), ['0.2.0', '0.3.0'], 'an equal version is not newer');
});

test('the newest CI gate run decides', () => {
	assert.equal(ciGateState([]).state, 'fail');
	assert.equal(ciGateState([{ id: 1, status: 'completed', conclusion: 'success' }]).state, 'pass');
	assert.equal(ciGateState([{ id: 1, status: 'in_progress', conclusion: null }]).state, 'pending');
	assert.equal(ciGateState([{ id: 1, status: 'completed', conclusion: 'cancelled' }]).state, 'fail');
	// a failed run re-run green: the re-run (higher id) wins
	assert.equal(
		ciGateState([
			{ id: 7, status: 'completed', conclusion: 'success' },
			{ id: 3, status: 'completed', conclusion: 'failure' },
		]).state,
		'pass',
	);
	// ...and a newer red run beats an older green one
	assert.equal(
		ciGateState([
			{ id: 3, status: 'completed', conclusion: 'success' },
			{ id: 7, status: 'completed', conclusion: 'failure' },
		]).state,
		'fail',
	);
});

test('the production environment must exist and have a required reviewer', () => {
	assert.match(/** @type {string} */ (environmentProblem(null)), /does not exist/);
	assert.match(/** @type {string} */ (environmentProblem({ protection_rules: [] })), /no required reviewer/);
	assert.match(/** @type {string} */ (environmentProblem({ protection_rules: [{ type: 'wait_timer' }] })), /no required reviewer/);
	assert.match(/** @type {string} */ (environmentProblem({ protection_rules: [{ type: 'required_reviewers', reviewers: [] }] })), /no required reviewer/);
	assert.equal(environmentProblem({ protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User' }] }] }), null);
});

test('missing config lists every empty or unset name', () => {
	assert.deepEqual(missingConfig(['A', 'B', 'C'], { A: 'x', B: '  ' }), ['B', 'C']);
	assert.deepEqual(missingConfig([], {}), []);
});

const SHA = 'a'.repeat(40);
const REPO = 'Absence0760/project-water-management';
const actions = { id: 15368, slug: 'github-actions' };
const ciRun = (over = {}) => ({ path: '.github/workflows/ci.yml', event: 'push', head_sha: SHA, head_repository: REPO, ...over });

test('only a CI gate from ci.yml under GitHub Actions, on a push or manual run of the commit, counts', () => {
	const gate = (id, suite, app = actions) => ({ id, status: 'completed', conclusion: 'success', app, check_suite_id: suite });
	// the genuine one
	assert.deepEqual(trustedCiGateRuns([gate(1, 10)], { 10: [ciRun()] }, SHA, REPO).trusted.map((r) => r.id), [1]);
	assert.deepEqual(trustedCiGateRuns([gate(1, 10)], { 10: [ciRun({ event: 'workflow_dispatch' })] }, SHA, REPO).trusted.map((r) => r.id), [1]);
	assert.deepEqual(trustedCiGateRuns([gate(1, 10)], { 10: [ciRun({ path: '.github/workflows/ci.yml@refs/heads/main' })] }, SHA, REPO).trusted.map((r) => r.id), [1]);

	for (const [why, runs, bySuite, reason] of [
		['another app posting a check run by that name', [gate(1, 10, { id: 999, slug: 'evil-app' })], { 10: [ciRun()] }, /evil-app, not GitHub Actions/],
		['an app with the right slug but another id', [gate(1, 10, { id: 1, slug: 'github-actions' })], { 10: [ciRun()] }, /not GitHub Actions/],
		['no app at all', [gate(1, 10, null)], { 10: [ciRun()] }, /unknown app/],
		['a job named CI gate in another workflow', [gate(1, 10)], { 10: [ciRun({ path: '.github/workflows/other.yml' })] }, /other\.yml/],
		['a pull_request run (the merge ref\'s ci.yml, which the PR can rewrite)', [gate(1, 10)], { 10: [ciRun({ event: 'pull_request' })] }, /pull_request event/],
		['a run of another commit', [gate(1, 10)], { 10: [ciRun({ head_sha: 'b'.repeat(40) })] }, /bbbbbbbbbbbb/],
		['a run in a fork', [gate(1, 10)], { 10: [ciRun({ head_repository: 'someone/fork' })] }, /someone\/fork/],
		['a suite with no workflow run', [gate(1, 10)], {}, /no workflow run/],
		['no suite id', [gate(1, null)], { 10: [ciRun()] }, /no workflow run/],
	]) {
		const r = trustedCiGateRuns(/** @type {any} */ (runs), /** @type {any} */ (bySuite), SHA, REPO);
		assert.deepEqual(r.trusted, [], why);
		assert.match(r.ignored.join(' '), reason, why);
		const state = ciGateState(r.trusted, r.ignored);
		assert.equal(state.state, 'fail', why);
		assert.match(state.detail, /ignored:/, why);
	}

	// an untrusted green run beside a trusted red one: the red one decides
	const mixed = trustedCiGateRuns([gate(9, 20, { id: 7, slug: 'x' }), { ...gate(3, 10), conclusion: 'failure' }], { 10: [ciRun()], 20: [ciRun()] }, SHA, REPO);
	assert.equal(ciGateState(mixed.trusted, mixed.ignored).state, 'fail');
});

test('production may deploy from exactly main and the release tags', () => {
	const custom = { deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } };
	const good = [
		{ name: 'main', type: 'branch' },
		{ name: 'backend@*', type: 'tag' },
		{ name: 'web@*', type: 'tag' },
	];
	assert.equal(branchPolicyProblem(custom, good), null);
	assert.equal(branchPolicyProblem(custom, [...good].reverse()), null);
	assert.match(/** @type {string} */ (branchPolicyProblem({ deployment_branch_policy: null }, null)), /no deployment branch policy/);
	assert.match(/** @type {string} */ (branchPolicyProblem({}, null)), /no deployment branch policy/);
	assert.match(/** @type {string} */ (branchPolicyProblem({ deployment_branch_policy: { protected_branches: true, custom_branch_policies: false } }, null)), /protected branches/);
	assert.match(/** @type {string} */ (branchPolicyProblem(custom, [])), /missing branch main, tag backend@\*, tag web@\*/);
	assert.match(/** @type {string} */ (branchPolicyProblem(custom, good.slice(0, 2))), /missing tag web@\*/);
	// a tag pattern entered as a branch pattern does not match tags
	assert.match(/** @type {string} */ (branchPolicyProblem(custom, [good[0], { name: 'backend@*', type: 'branch' }, good[2]])), /missing tag backend@\*.*also allows branch backend@\*/);
	// anything broader is refused
	assert.match(/** @type {string} */ (branchPolicyProblem(custom, [...good, { name: '*', type: 'branch' }])), /also allows branch \*/);
	// the API omits `type` on old branch-only policies: that means branch
	assert.equal(branchPolicyProblem(custom, [{ name: 'main' }, good[1], good[2]]), null);
});

test('an active tag ruleset must stop creating, moving and deleting release tags', () => {
	const ruleset = (over = {}) => ({
		name: 'Release tags',
		target: 'tag',
		enforcement: 'active',
		conditions: { ref_name: { include: ['refs/tags/backend@*', 'refs/tags/web@*'], exclude: [] } },
		rules: [{ type: 'creation' }, { type: 'update' }, { type: 'deletion' }],
		...over,
	});
	assert.equal(tagRulesetProblem([ruleset()]), null);
	assert.equal(tagRulesetProblem([ruleset({ conditions: { ref_name: { include: ['~ALL'], exclude: [] } } })]), null);
	// split across two rulesets is fine
	assert.equal(
		tagRulesetProblem([
			ruleset({ conditions: { ref_name: { include: ['refs/tags/backend@*'] } } }),
			ruleset({ conditions: { ref_name: { include: ['refs/tags/web@*'] } } }),
		]),
		null,
	);
	assert.match(/** @type {string} */ (tagRulesetProblem([])), /web@\* lacks creation, update, deletion; refs\/tags\/backend@\* lacks/);
	assert.match(/** @type {string} */ (tagRulesetProblem([ruleset({ enforcement: 'evaluate' })])), /no active tag ruleset/);
	assert.match(/** @type {string} */ (tagRulesetProblem([ruleset({ enforcement: 'disabled' })])), /no active tag ruleset/);
	assert.match(/** @type {string} */ (tagRulesetProblem([ruleset({ target: 'branch' })])), /no active tag ruleset/);
	assert.match(/** @type {string} */ (tagRulesetProblem([ruleset({ rules: [{ type: 'deletion' }] })])), /lacks creation, update/);
	assert.match(/** @type {string} */ (tagRulesetProblem([ruleset({ conditions: { ref_name: { include: ['refs/tags/backend@*'] } } })])), /web@\* lacks/);
	assert.match(/** @type {string} */ (tagRulesetProblem([ruleset({ conditions: { ref_name: { include: ['~ALL'], exclude: ['refs/tags/web@*'] } } })])), /web@\* lacks/);
});
