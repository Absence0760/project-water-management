// A guard on the specs: a locator's `isVisible()`, `isHidden()`, `isChecked()`, `isEnabled()`,
// `isDisabled()` or `isEditable()` is a one-off look at the page, never retried. Used to choose what a
// spec does next, it races whatever the page is still doing: uploadThroughSheet looked for the Upload
// sheet while the lazily loaded sheet was still on its way, clicked the header's link again and hit the
// sheet that had opened over it (CI run 37204378090). Each use needs a `// settled:` comment on its line
// or the line above saying why the state can't be changing then; prefer a web-first `expect` or a
// signal the app gives (the URL, a data-ready attribute). Run by `pnpm test` (node:test).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const SNAPSHOT = /\.(isVisible|isHidden|isChecked|isEnabled|isDisabled|isEditable)\(\)/;
const SETTLED = /\/\/ settled: \S/;

/** The `file:line` of every snapshot check without a `// settled:` reason. */
export function unsettledChecks(file: string, text: string): string[] {
	const lines = text.split('\n');
	const out: string[] = [];
	lines.forEach((line, i) => {
		if (!SNAPSHOT.test(line) || line.trimStart().startsWith('//')) return;
		if (SETTLED.test(line) || SETTLED.test(lines[i - 1] ?? '')) return;
		out.push(`${file}:${i + 1}`);
	});
	return out;
}

function sources(dir: string): string[] {
	return readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' })
		.filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
		.map((f) => join(dir, f));
}

test('the guard flags a bare snapshot check and accepts one with a reason', () => {
	assert.deepEqual(unsettledChecks('a.ts', "\tif (!(await sheet.isVisible())) await open();"), ['a.ts:1']);
	assert.deepEqual(unsettledChecks('a.ts', '\t// settled: the sheet is open.\n\tif (await b.isVisible()) await b.click();'), []);
	assert.deepEqual(unsettledChecks('a.ts', '\tif (await b.isChecked()) await b.click(); // settled: nothing moves it.'), []);
	assert.deepEqual(unsettledChecks('a.ts', '\tawait expect(b).toBeVisible();'), []);
});

test('every snapshot check in the specs and their support says why the state is settled', () => {
	const found = [...sources('tests'), ...sources('support')].flatMap((f) => unsettledChecks(f, readFileSync(join(root, f), 'utf8')));
	assert.deepEqual(found, [], 'a one-off look at the page decides what the spec does next; wait on a web-first expect or an app signal, or give a `// settled:` reason');
});
