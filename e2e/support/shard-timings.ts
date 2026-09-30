// The per-test durations the CI shards are packed from (support/shards.ts;
// e2e/README.md § CI).
//
//   node support/shard-timings.ts report <merged.json> <out.json>
//     CI's e2e-report job: from the shards' merged JSON report, check every
//     test in the suite ran on exactly one shard (a test on no shard would
//     pass CI without ever running), then write its timings for the
//     `e2e-timings` artifact.
//   node support/shard-timings.ts fetch      (pnpm gen:e2e:timings)
//     Replace shard-timings.json with that artifact from the newest green CI
//     run on main. Commit the result.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listSuite, TIMINGS_FILE } from './shard-list.ts';
import { ranOnce, testsIn, timingsFrom, type JsonReport } from './shards.ts';

function report(mergedPath: string, outPath: string) {
	const { timings, runs } = timingsFrom(JSON.parse(readFileSync(mergedPath, 'utf8')) as JsonReport);
	const listed = testsIn(listSuite());
	const { missing, repeated } = ranOnce(listed, runs);
	writeFileSync(outPath, JSON.stringify(timings, null, '\t') + '\n');
	const total = Object.values(timings).reduce((a, b) => a + b, 0);
	console.log(`${Object.keys(timings).length} tests timed, ${Math.round(total / 1000)} s of test time in all`);
	const problems = [
		...missing.map((k) => `ran on no shard: ${k}`),
		...repeated.map((k) => `ran on more than one shard: ${k}`)
	];
	if (problems.length) {
		console.error(`Shard planning lost or repeated tests (support/shards.ts):\n  ${problems.join('\n  ')}`);
		process.exit(1);
	}
	console.log(`all ${listed.length} tests ran on exactly one shard`);
}

function fetch() {
	const runs = JSON.parse(
		execFileSync('gh', ['run', 'list', '--workflow', 'ci.yml', '--branch', 'main', '--status', 'success', '--limit', '20', '--json', 'databaseId,createdAt'], { encoding: 'utf8' })
	) as { databaseId: number; createdAt: string }[];
	for (const run of runs) {
		const dir = mkdtempSync(join(tmpdir(), 'e2e-timings-'));
		try {
			execFileSync('gh', ['run', 'download', String(run.databaseId), '-n', 'e2e-timings', '-D', dir], { stdio: 'ignore' });
		} catch {
			rmSync(dir, { recursive: true, force: true });
			continue; // no e2e run (docs-only change) or the artifact expired
		}
		const file = join(dir, 'shard-timings.json');
		if (existsSync(file)) {
			copyFileSync(file, TIMINGS_FILE);
			rmSync(dir, { recursive: true, force: true });
			console.log(`e2e/shard-timings.json from CI run ${run.databaseId} (${run.createdAt}); commit it`);
			return;
		}
		rmSync(dir, { recursive: true, force: true });
	}
	throw new Error('no e2e-timings artifact in the last 20 green CI runs on main');
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'report' && args.length === 2) report(args[0]!, args[1]!);
else if (cmd === 'fetch' && args.length === 0) fetch();
else throw new Error('usage: node support/shard-timings.ts report <merged.json> <out.json> | fetch');
