// Writes one CI shard's `--test-list` file (support/shards.ts; e2e/README.md
// § CI). Every shard plans the whole suite from `playwright test --list` and
// shard-timings.json, and keeps only its own list, so the shards need no
// coordination:
//
//   node support/shard-list.ts 3/14 shard-tests.txt
//   playwright test --test-list shard-tests.txt
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { keepsTogether, planShards, testKey, testListFile, testsIn, unlistableTitles, type JsonReport } from './shards.ts';

const E2E_DIR = fileURLToPath(new URL('..', import.meta.url));
export const TIMINGS_FILE = fileURLToPath(new URL('../shard-timings.json', import.meta.url));

/** Every test in the suite, as `playwright test --list` sees it. */
export function listSuite(): JsonReport {
	const out = execFileSync('pnpm', ['exec', 'playwright', 'test', '--list', '--reporter=json'], {
		cwd: E2E_DIR,
		encoding: 'utf8',
		maxBuffer: 256 * 1024 * 1024
	});
	return JSON.parse(out) as JsonReport;
}

function main() {
	const [spec, outPath] = process.argv.slice(2);
	const m = /^(\d+)\/(\d+)$/.exec(spec ?? '');
	if (!m || !outPath) throw new Error('usage: node support/shard-list.ts <current>/<total> <out-file>');
	const current = Number(m[1]);
	const total = Number(m[2]);
	if (current < 1 || current > total) throw new Error(`shard ${current} is not in 1..${total}`);

	const tests = testsIn(listSuite());
	const bad = unlistableTitles(tests);
	if (bad.length) throw new Error(`--test-list can't name these tests (a "›", or a title with outer whitespace); rename them:\n  ${bad.join('\n  ')}`);
	const timings = JSON.parse(readFileSync(TIMINGS_FILE, 'utf8')) as Record<string, number>;
	const sources = new Map<string, boolean>();
	const together = (file: string) => {
		if (!sources.has(file)) sources.set(file, keepsTogether(readFileSync(`${E2E_DIR}/tests/${file}`, 'utf8')));
		return sources.get(file)!;
	};
	const shards = planShards(tests, timings, total, together);
	if (shards.some((s) => s.tests.length === 0)) throw new Error(`${tests.length} tests can't fill ${total} shards`);

	const mine = shards[current - 1]!;
	writeFileSync(outPath, testListFile(mine));
	const secs = shards.map((s) => Math.round(s.ms / 1000));
	const unknown = tests.filter((t) => timings[testKey(t)] === undefined).length;
	console.log(
		`shard ${current}/${total}: ${mine.tests.length} of ${tests.length} tests, ~${secs[current - 1]} s of test time ` +
			`(all shards ${Math.min(...secs)}–${Math.max(...secs)} s; ${unknown} tests without a timing, planned at the median)`
	);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
