import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ciGateState, compareVersions, environmentProblem, missingConfig, notNewerThan, parseReleaseTag } from './preflight.mjs';

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
