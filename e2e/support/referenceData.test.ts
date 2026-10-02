// Every e2e test that reads a reference-data panel loads that data itself
// (support/referenceData.ts). Run by `pnpm test`.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { missingLoads, splitSpec } from './referenceData.ts';

const testsDir = fileURLToPath(new URL('../tests/', import.meta.url));

test('every spec that reads a reference panel loads its data in the same test, describe or file', () => {
	const specs = readdirSync(testsDir).filter((f) => f.endsWith('.spec.ts'));
	assert.ok(specs.length > 50, 'the specs were found');
	const missing = specs.flatMap((f) => missingLoads(f, readFileSync(testsDir + f, 'utf8')));
	assert.deepEqual(missing, []);
});

test('a describe that loads the data covers its own tests only, not the file’s other tests (PR #362)', () => {
	const spec = [
		"import { loadSyntheticLandCover } from '../support/landCover.ts';",
		'',
		"test('desktop', async ({ page }) => {",
		"\tawait expect(page.getByTestId('cropland-body')).toBeVisible();",
		'});',
		'',
		"test.describe('phone', () => {",
		'\ttest.beforeAll(async () => {',
		'\t\tawait loadSyntheticLandCover();',
		'\t});',
		"\ttest('drawer', async ({ page }) => {",
		"\t\tawait expect(page.getByTestId('cropland-catchment')).toBeVisible();",
		'\t});',
		'});',
		''
	].join('\n');
	assert.deepEqual(
		missingLoads('x.spec.ts', spec).map((m) => m.split(' reads')[0]),
		['x.spec.ts:3']
	);
});

test('a file-wide beforeAll covers every test; a test that loads in its own body passes; unrelated test ids need nothing', () => {
	const fileWide = ["test.beforeAll(async () => {", '\tawait loadSyntheticRivers();', '});', "test('a', async ({ page }) => {", "\tpage.getByTestId('map-rivers-summary');", '});'].join('\n');
	assert.deepEqual(missingLoads('a.spec.ts', fileWide), []);
	const inBody = ["test('b', async ({ page }) => {", '\tawait loadSyntheticDamRegister();', "\tpage.getByTestId('dam-proposals-rows');", '});'].join('\n');
	assert.deepEqual(missingLoads('b.spec.ts', inBody), []);
	const unrelated = ["test('c', async ({ page }) => {", "\tpage.getByTestId('evaporation-no-boundary');", "\tpage.getByTestId('nearest-gauges');", '});'].join('\n');
	assert.deepEqual(missingLoads('c.spec.ts', unrelated), []);
	const wrongLoader = ["test('d', async ({ page }) => {", '\tawait loadSyntheticLandCover();', "\tpage.getByTestId('evaporation-rows');", '});'].join('\n');
	assert.equal(missingLoads('d.spec.ts', wrongLoader).length, 1);
});

test('a test inside a top-level loop is checked, and a loader in one loop covers that loop only', () => {
	const spec = [
		"for (const scheme of ['light', 'dark'] as const) {",
		"\ttest(`rivers in ${scheme}`, async ({ page }) => {",
		'\t\tawait loadSyntheticRivers();',
		"\t\tpage.getByTestId('map-rivers-summary');",
		'\t});',
		'}',
		"for (const w of [390, 1440]) {",
		"\ttest(`land cover at ${w}`, async ({ page }) => {",
		"\t\tpage.getByTestId('cropland-body');",
		'\t});',
		'}',
		"test('rivers again', async ({ page }) => {",
		"\tpage.getByTestId('map-rivers-list');",
		'});'
	].join('\n');
	assert.deepEqual(
		missingLoads('l.spec.ts', spec).map((m) => m.split(' reads')[0]),
		['l.spec.ts:7', 'l.spec.ts:12']
	);
});

test('the split keeps helpers and imports at file level and finds each top-level block', () => {
	const { fileLevel, blocks } = splitSpec(["import x from 'y';", 'function helper() {', '\treturn 1;', '}', "test('one', () => {", '\tx();', '});', "test.describe.serial('two', () => {", '});'].join('\n'));
	assert.deepEqual(
		blocks.map((b) => b.line),
		[5, 8]
	);
	assert.match(fileLevel, /function helper/);
	assert.doesNotMatch(fileLevel, /test\('one'/);
});
