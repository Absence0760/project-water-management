import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkOrder, checkUnchanged } from './check_migration_order.mjs';

const MAIN = ['001_init.sql', '175_delineation.sql', '180_evaporation_reference.sql', '181_evaporation_accepted.sql'];

test('a migration after the base highest passes', () => {
	const { added, problems } = checkOrder(MAIN, [...MAIN, '182_divide_proposal.sql']);
	assert.deepEqual(added, ['182_divide_proposal.sql']);
	assert.deepEqual(problems, []);
});

test('no new migration passes, and so does a branch behind its base', () => {
	assert.deepEqual(checkOrder(MAIN, MAIN).problems, []);
	assert.deepEqual(checkOrder(MAIN, MAIN.slice(0, 2)).problems, []);
});

test('a number reserved before the base moved past it fails, with the rename (the 178 after 181 case)', () => {
	const { problems } = checkOrder(MAIN, [...MAIN, '178_start_proposal.sql']);
	assert.equal(problems.length, 1);
	assert.equal(problems[0].name, '178_start_proposal.sql');
	assert.equal(problems[0].renamed, '182_start_proposal.sql');
	assert.match(problems[0].message, /sorts before 181_evaporation_accepted\.sql/);
	assert.match(problems[0].message, /git mv backend\/migrations\/178_start_proposal\.sql backend\/migrations\/182_start_proposal\.sql/);
});

test('a number the base already uses fails, even when its name sorts after', () => {
	const { problems } = checkOrder(MAIN, [...MAIN, '181_zz_late.sql']);
	assert.equal(problems.length, 1);
	assert.equal(problems[0].renamed, '182_zz_late.sql');
	assert.match(problems[0].message, /shares its number/);
});

test("several late files get consecutive numbers in their order, past the change's good ones", () => {
	const { problems } = checkOrder(MAIN, [...MAIN, '178_a.sql', '179_b.sql', '183_c.sql']);
	assert.deepEqual(
		problems.map((p) => [p.name, p.renamed]),
		[
			['178_a.sql', '184_a.sql'],
			['179_b.sql', '185_b.sql']
		]
	);
});

test('files that are not migrations are ignored, as the runner ignores them', () => {
	assert.deepEqual(checkOrder(MAIN, [...MAIN, 'README.md', '100_notes.txt']).problems, []);
});

test('an empty base accepts anything', () => {
	assert.deepEqual(checkOrder([], ['001_init.sql']).problems, []);
});

const blobs = (pairs) => new Map(pairs);

test('applied migrations with the same contents pass, and so does one the change lacks', () => {
	const base = blobs([['039_api_keys.sql', 'aaa'], ['040_b.sql', 'bbb']]);
	assert.deepEqual(checkUnchanged(base, blobs([['039_api_keys.sql', 'aaa'], ['041_c.sql', 'ccc']]), base, 'backend@0.4.0'), []);
});

test('a released migration edited, even in a comment, fails against the release (039 in #570)', () => {
	const problems = checkUnchanged(blobs([['039_api_keys.sql', 'aaa']]), blobs([['039_api_keys.sql', 'abc']]), blobs([['039_api_keys.sql', 'aaa']]), 'backend@0.4.0');
	assert.equal(problems.length, 1);
	assert.equal(problems[0].name, '039_api_keys.sql');
	assert.match(problems[0].message, /differs from backend@0\.4\.0/);
	assert.match(problems[0].message, /git checkout backend@0\.4\.0 -- backend\/migrations\/039_api_keys\.sql/);
});

test('putting an edited file back as released passes while the base still has the edit', () => {
	assert.deepEqual(checkUnchanged(blobs([['039_api_keys.sql', 'edited']]), blobs([['039_api_keys.sql', 'aaa']]), blobs([['039_api_keys.sql', 'aaa']]), 'backend@0.4.0'), []);
});

test('a migration no release has must match the base', () => {
	const problems = checkUnchanged(blobs([['236_new.sql', 'aaa']]), blobs([['236_new.sql', 'bbb']]), blobs([]), 'backend@0.4.0');
	assert.equal(problems.length, 1);
	assert.match(problems[0].message, /differs from the base/);
	assert.deepEqual(checkUnchanged(blobs([['236_new.sql', 'aaa']]), blobs([['236_new.sql', 'aaa']]), blobs([]), 'backend@0.4.0'), []);
});

test('without a release the base is the reference, and files that are not migrations may change', () => {
	assert.equal(checkUnchanged(blobs([['039_api_keys.sql', 'aaa']]), blobs([['039_api_keys.sql', 'b']])).length, 1);
	assert.deepEqual(checkUnchanged(blobs([['README.md', 'aaa']]), blobs([['README.md', 'bbb']])), []);
});
