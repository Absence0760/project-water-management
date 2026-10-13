// A guard on the specs: an assertion on a relative day word ("ran today",
// "published today", the history's "Yesterday" heading) is the browser's clock
// against a server timestamp, so it flips when midnight falls between making
// the record and drawing it (CI, 2026-10-13T00:00:05Z). Each test asserting
// one pins the page's clock first (support/clock.ts: pinClock,
// pinClockToProject, …), and never hedges with (today|yesterday). A line whose
// "today" is fixed wording, not a day worked out from a clock, says so in a
// `// clock-free:` comment on it or the line above. Run by `pnpm test` (node:test).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
/** The word, not a name or a class that holds it (`todayPct`, `.bar.today`, `stage-today`). */
const DAY_WORD = /(?<![-.\w])(today|yesterday)(?![-\w])/i;
/** String, template and regex literals: what an assertion compares the page with. */
const LITERAL = /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|\/(?:\\.|[^/\n])+\//g;
const saysDayWord = (line: string) => (line.match(LITERAL) ?? []).some((l) => DAY_WORD.test(l));
const ASSERTION = /\bexpect(\.soft)?\(/;
const PIN = /\bpinClock\w*\(/;
const CLOCK_FREE = /\/\/ clock-free: \S/;
/** Where a test's body starts: `test('…'`, `test.only('…'`. Not `test.use(` or `test.describe(`. */
const TEST_START = /^\s*test(\.(only|fixme|skip))?\(\s*['"`]/;
const HEDGE = /today\|yesterday|yesterday\|today/i;

/** The `file:line` of every day-word assertion with no pin earlier in its test, and every (today|yesterday) hedge. */
export function unpinnedDayWords(file: string, text: string): string[] {
	const lines = text.split('\n');
	const out: string[] = [];
	let pinned = false;
	lines.forEach((line, i) => {
		if (TEST_START.test(line)) pinned = false;
		if (PIN.test(line) && !line.trimStart().startsWith('//')) pinned = true;
		if (!ASSERTION.test(line) || !saysDayWord(line) || line.trimStart().startsWith('//')) return;
		if (CLOCK_FREE.test(line) || CLOCK_FREE.test(lines[i - 1] ?? '')) return;
		if (!pinned || HEDGE.test(line)) out.push(`${file}:${i + 1}`);
	});
	return out;
}

test('the guard flags an unpinned or hedged day word and accepts a pinned one or fixed wording', () => {
	const t = (body: string) => `test('x', async ({ page }) => {\n${body}\n});`;
	assert.deepEqual(unpinnedDayWords('a.ts', t("\tawait expect(c).toContainText('ran today');")), ['a.ts:2']);
	assert.deepEqual(unpinnedDayWords('a.ts', t("\tawait pinClockToProject(page, id, 'lastRunAt');\n\tawait expect(c).toContainText('ran today');")), []);
	assert.deepEqual(unpinnedDayWords('a.ts', t("\tawait pinClock(page, at);\n\tawait expect(c).toContainText(/ran (today|yesterday)/);")), ['a.ts:3']);
	assert.deepEqual(unpinnedDayWords('a.ts', t("\tawait expect(c).toHaveText('Today'); // clock-free: a fixed label.")), []);
	assert.deepEqual(unpinnedDayWords('a.ts', t("\t// clock-free: a fixed label.\n\tawait expect(c).toHaveText(['Today', 'This plan']);")), []);
	// A variable or a class named for the day is no day word.
	assert.deepEqual(unpinnedDayWords('a.ts', t("\tawait expect(today).toContainText('full');\n\tawait expect(b.locator('.bar.today')).toBeVisible();")), []);
	// A pin in one test doesn't carry into the next.
	assert.deepEqual(unpinnedDayWords('a.ts', `${t("\tawait pinClock(page, at);")}\n${t("\tawait expect(c).toHaveText('Yesterday');")}`), ['a.ts:5']);
	// Nor does a pin after the assertion count.
	assert.deepEqual(unpinnedDayWords('a.ts', t("\tawait expect(c).toHaveText('today');\n\tawait pinClock(page, at);")), ['a.ts:2']);
});

test('every spec asserting a relative day word pins the clock first', () => {
	const specs = readdirSync(join(root, 'tests'), { recursive: true, encoding: 'utf8' })
		.filter((f) => f.endsWith('.spec.ts'))
		.map((f) => join('tests', f));
	assert.ok(specs.length > 50, `found the specs (${specs.length})`);
	const found = specs.flatMap((f) => unpinnedDayWords(f, readFileSync(join(root, f), 'utf8')));
	assert.deepEqual(found, [], 'pin the clock to the record (support/clock.ts), or mark fixed wording // clock-free: <why>');
});
