// V8 stress guard for issue #192 (docs/engine-audit.md V1): the example
// catchment Sandspruit, run through runModelChecked in child processes under
// `node --deopt-every-n-times=N`, must give the same supplyAssurance as an
// unstressed child on the same Node binary, with the `assurance` self-check
// passing on every run.
//
// Under Node 24's V8, nodeReliability's day loop, compiled by Maglev for
// on-stack replacement, read the node it was compiled for on later calls: a
// farm's reliability came out with another farm's sums under its own id.
// network/reliability.ts keeps that loop in its own function (tallyWindow),
// which this stress run never broke (0 of 88 stressed full runs); the
// original form failed in about half of them (34 of 64).
//
// Why it is in the `perf` project and not `pnpm test`: the fault depends on
// JIT timing, so the stress is probabilistic (on the original code a sweep of
// these children caught it in 4 trials of 5, not every time) and some N make
// V8 thrash (a child from 4 s to over a minute). It needs a machine to
// itself, like the wall-clock budgets here: run it alone with
// `pnpm test:backend:perf`. The deterministic guard is the `assurance`
// self-check, which runs on every saved run and in the unit suite
// (assurance-jit.test.ts, the engine's verify tests and fuzz).
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AssuranceJitRun } from './assurance-jit.child.js';

const run = promisify(execFile);
/** The deopt periods to stress with: the fault showed across 1500–5000; below ~2000 V8 can thrash for minutes. */
const PERIODS = [2250, 2500, 2750, 3000, 3250, 3500, 3750, 4000];
const RUNS = 10;

let dir = '';
let bundle = '';

async function child(flags: string[], runs: number): Promise<AssuranceJitRun[]> {
	const { stdout } = await run(process.execPath, [...flags, bundle, String(runs)], { timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
	return stdout
		.trim()
		.split('\n')
		.map((l) => JSON.parse(l) as AssuranceJitRun);
}

describe('assurance of supply under V8 deopt stress (issue #192)', () => {
	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), 'wm-assurance-jit-'));
		bundle = join(dir, 'assurance-jit.child.mjs');
		await build({ entryPoints: [fileURLToPath(new URL('./assurance-jit.child.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', outfile: bundle, logLevel: 'error' });
	});
	afterAll(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	it(`every stressed run matches the unstressed one and passes the assurance self-check (${PERIODS.length} children × ${RUNS} runs)`, async () => {
		// The reference is a child on the same binary: Math.exp and friends may differ in the last bit between Node versions.
		const [ref] = await child([], 1);
		expect(ref!.passed).toBe(true);
		const results = await Promise.all(PERIODS.map(async (n) => ({ n, runs: await child([`--deopt-every-n-times=${n}`], RUNS) })));
		const bad = results.flatMap(({ n, runs }) => runs.flatMap((r, i) => (r.passed !== true || r.hash !== ref!.hash ? [`N=${n} run ${i}: ${r.detail ?? 'supplyAssurance differs from the unstressed run'}`] : [])));
		for (const { runs } of results) expect(runs).toHaveLength(RUNS);
		expect(bad).toEqual([]);
	}, 900_000);
});
