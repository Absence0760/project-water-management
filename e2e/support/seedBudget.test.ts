// Every spec that calls seedExamplesOnce (examples.ts) gives that hook or test
// a 90 s budget or more. Seeding takes ~55 s on a CI shard for whichever caller
// comes first, and which one that is depends on how the shards are packed
// (shard-timings.json), so a caller under budget passes until new specs move it
// to the front of its shard: the 320 px headers test in lang-layout.spec.ts
// seeded inline under 60 s and timed out that way (CI run 41217591637, shard 3).
// Run by `pnpm -C e2e test` (node:test).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const SEED_BUDGET_MS = 90_000;
const testsDir = new URL('../tests/', import.meta.url);

/** For each seedExamplesOnce call, the budget its enclosing test or hook sets before it, or null. */
export function seedBudgets(source: string): (number | null)[] {
	const budgets: (number | null)[] = [];
	for (const call of source.matchAll(/\bseedExamplesOnce\(/g)) {
		const before = source.slice(0, call.index);
		const openers = [...before.matchAll(/\btest(?:\.beforeAll)?\(/g)];
		const opener = openers.at(-1);
		if (!opener) {
			budgets.push(null);
			continue;
		}
		const body = before.slice(opener.index);
		const set = [...body.matchAll(/\btest\.setTimeout\(([\d_]+)\)/g)].at(-1);
		budgets.push(set ? Number(set[1]!.replaceAll('_', '')) : null);
	}
	return budgets;
}

test('seedBudgets reads the budget of the enclosing hook or test', () => {
	assert.deepEqual(seedBudgets(`test.beforeAll(async () => {\n\ttest.setTimeout(90_000);\n\tawait seedExamplesOnce(api);\n});`), [90_000]);
	assert.deepEqual(seedBudgets(`test('x', async () => {\n\ttest.setTimeout(60_000);\n\tawait seedExamplesOnce(api);\n});`), [60_000]);
	// A budget set by an earlier test doesn't count for a later one.
	assert.deepEqual(seedBudgets(`test('a', () => { test.setTimeout(120_000); });\ntest('b', async () => {\n\tawait seedExamplesOnce(api);\n});`), [null]);
});

test(`every seedExamplesOnce caller has ${SEED_BUDGET_MS / 1000} s or more`, () => {
	const short: string[] = [];
	let calls = 0;
	for (const file of readdirSync(testsDir).filter((f) => f.endsWith('.spec.ts'))) {
		const budgets = seedBudgets(readFileSync(new URL(file, testsDir), 'utf8'));
		calls += budgets.length;
		budgets.forEach((b, i) => {
			if (b === null || b < SEED_BUDGET_MS) short.push(`${file}: call ${i + 1} has ${b === null ? 'the default' : `${b} ms`}`);
		});
	}
	assert.ok(calls > 0, 'no spec calls seedExamplesOnce: is the scan looking in the right place?');
	assert.deepEqual(short, [], `give each a test.beforeAll with test.setTimeout(${SEED_BUDGET_MS})`);
});
