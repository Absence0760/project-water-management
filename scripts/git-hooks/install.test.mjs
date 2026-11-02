import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decide, HOOKS_PATH } from './install.mjs';

test('sets core.hooksPath when unset, keeps it when ours, leaves anyone else\'s, skips CI', () => {
	assert.equal(decide(null, false), 'set');
	assert.equal(decide(HOOKS_PATH, false), 'already');
	assert.equal(decide('/home/me/hooks', false), 'foreign');
	assert.equal(decide(null, true), 'skip-ci');
});
