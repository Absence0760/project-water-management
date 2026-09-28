import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addedLines, compileTerms, parseTerms, scanText } from './check_client_terms.mjs';

// Synthetic terms only: the real list lives outside the repo.
const patterns = compileTerms(parseTerms('# invented client\nMadeup River\nFakefarm  # a farm\n\n'));

test('parseTerms drops comments and blank lines', () => {
	assert.deepEqual(parseTerms('# c\nMadeup River\n  Fakefarm  # farm\n\n'), ['Madeup River', 'Fakefarm']);
});

test('a spaced term matches every spelling a rename produces', () => {
	for (const s of ['Madeup River', 'madeup river', 'MadeupRiver', 'madeup-river', 'madeup_river', 'data/madeupriver/x.json', "MadeupRiver's"]) {
		assert.equal(scanText(s, patterns).length, 1, s);
	}
});

test('a term split across a comment line break still matches', () => {
	assert.deepEqual(scanText('// plus the Madeup\n// River workbook', patterns), [{ line: 1, term: 1 }]);
	assert.deepEqual(scanText('# the Madeup\n# River', patterns), [{ line: 1, term: 1 }]);
});

test('whole words only, with the line and term number of each hit', () => {
	assert.deepEqual(scanText('Fakefarms and unFakefarm and Fakefarm2', patterns), []);
	assert.deepEqual(scanText('ok\nFakefarm!Z17 = 1\nMadeup River, Fakefarm', patterns), [
		{ line: 2, term: 2 },
		{ line: 3, term: 1 },
		{ line: 3, term: 2 },
	]);
});

test('addedLines keeps only added lines, with new-file line numbers', () => {
	const diff = [
		'diff --git a/a.md b/a.md',
		'--- a/a.md',
		'+++ b/a.md',
		'@@ -3,0 +4,2 @@',
		'+first',
		'+second',
		'@@ -10 +12 @@',
		'-old Fakefarm',
		'+new',
		'diff --git a/gone.md b/gone.md',
		'--- a/gone.md',
		'+++ /dev/null',
		'@@ -1 +0,0 @@',
		'-Fakefarm',
	].join('\n');
	assert.deepEqual(Object.fromEntries(addedLines(diff)), {
		'a.md': [
			{ line: 4, text: 'first' },
			{ line: 5, text: 'second' },
			{ line: 12, text: 'new' },
		],
	});
});
