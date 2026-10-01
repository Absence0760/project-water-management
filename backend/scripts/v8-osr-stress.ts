// V8 deopt stress of the assurance of supply at any git revision (issue #232,
// the upstream report of the V8 miscompile behind issue #192,
// docs/upstream/v8-maglev-osr.md).
//
// Builds the Sandspruit stress child (src/model/assurance-jit.child.ts) against
// the engine and the example catchments *as they were at --rev*, then runs it
// in child processes under `node --deopt-every-n-times=N` and compares every
// run's summary.supplyAssurance with an unstressed run on the same binary.
// The default revision is the last one with nodeReliability's original day
// loop (47e1ddb1^), so this answers "does this Node still have the bug?":
//
//   pnpm test:backend:v8-osr [--rev <git rev>] [--node <node binary>] [--periods 1800,2200,…]
//                            [--trials <n>] [--runs <n>] [--jobs <n>] [-- <extra V8 flags>]
//
// Exit 0 when every child finished and every stressed run matched, 1 when a
// run did not match, 2 when a child ended early (timeout, crash) with nothing
// wrong so far, or on a usage or build error. Timing-dependent and slow (a child takes 1–3 minutes):
// run it alone, never beside other suites. Uses only this public repo's
// engine and invented example data, so its output and bundle are safe to
// attach to an upstream report (still run `pnpm check:terms` first).
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { build, type Plugin } from 'esbuild';

const run = promisify(execFile);

/** The last revision whose nodeReliability had the day loop V8 miscompiled (the fix is 47e1ddb1, issue #192). */
export const PRE_FIX_REV = '47e1ddb1^';
/** The deopt periods the #192 investigation saw the fault at (1800–3200 most often). */
export const DEFAULT_PERIODS = [1800, 2200, 2600, 2900, 3200];

export interface StressOptions {
	rev: string;
	node: string;
	periods: number[];
	trials: number;
	runs: number;
	jobs: number;
	flags: string[];
}

export function parseStressArgs(argv: string[]): StressOptions {
	const dd = argv.indexOf('--');
	const { values } = parseArgs({
		args: dd >= 0 ? argv.slice(0, dd) : argv,
		options: {
			rev: { type: 'string', default: PRE_FIX_REV },
			node: { type: 'string', default: process.execPath },
			periods: { type: 'string', default: DEFAULT_PERIODS.join(',') },
			trials: { type: 'string', default: '2' },
			runs: { type: 'string', default: '6' },
			jobs: { type: 'string', default: '4' }
		},
		strict: true
	});
	const int = (name: string, v: string) => {
		const n = Number(v);
		if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a whole number ≥ 1, got ${v}`);
		return n;
	};
	return {
		rev: values.rev,
		node: values.node,
		periods: values.periods.split(',').map((p) => int('periods', p.trim())),
		trials: int('trials', values.trials),
		runs: int('runs', values.runs),
		jobs: int('jobs', values.jobs),
		flags: dd >= 0 ? argv.slice(dd + 1) : []
	};
}

/** One stressed child process: its deopt period, the runs it finished and how many of them differed from the reference. */
export interface ChildResult {
	period: number;
	runs: number;
	wrong: number;
	/** Why the child ended early (timeout, exit code), or null. */
	error: string | null;
}

/** The child's stdout: one JSON line per run with the hash of its supplyAssurance (assurance-jit.child.ts). */
export function hashesOf(stdout: string): string[] {
	return stdout
		.split('\n')
		.filter((l) => l.trim() !== '')
		.flatMap((l) => {
			try {
				const h = (JSON.parse(l) as { hash?: unknown }).hash;
				return typeof h === 'string' ? [h] : [];
			} catch {
				return [];
			}
		});
}

export function childResult(period: number, stdout: string, ref: string, error: string | null): ChildResult {
	const hashes = hashesOf(stdout);
	return { period, runs: hashes.length, wrong: hashes.filter((h) => h !== ref).length, error };
}

/**
 * 1 when a stressed run went wrong (the bug is there); 2 when none did but a
 * child ended early, so the sweep is incomplete and proves nothing; 0 when
 * every child finished and every run matched.
 */
export function exitCodeOf(s: ReturnType<typeof summarize>): 0 | 1 | 2 {
	if (s.wrong > 0) return 1;
	return s.incomplete > 0 ? 2 : 0;
}

export function summarize(results: ChildResult[]) {
	const runs = results.reduce((a, r) => a + r.runs, 0);
	const wrong = results.reduce((a, r) => a + r.wrong, 0);
	return { processes: results.length, failedProcesses: results.filter((r) => r.wrong > 0).length, runs, wrong, incomplete: results.filter((r) => r.error !== null).length };
}

const backendDir = fileURLToPath(new URL('..', import.meta.url));
const repoDir = join(backendDir, '..');

/** Bundle the stress child against the engine and the example catchments at `rev` (git archive, no checkout). */
export async function buildBundle(rev: string, dir: string): Promise<string> {
	const tar = join(dir, 'src.tar');
	await run('git', ['-C', repoDir, 'archive', '--format=tar', `--output=${tar}`, rev, 'packages/engine', 'backend/scripts/examples']);
	await run('tar', ['-xf', tar, '-C', dir]);
	const childDir = join(dir, 'backend', 'src', 'model');
	await mkdir(childDir, { recursive: true });
	const child = join(childDir, 'assurance-jit.child.ts');
	await writeFile(child, await readFile(join(backendDir, 'src', 'model', 'assurance-jit.child.ts'), 'utf8'));
	const engineDir = join(dir, 'packages', 'engine');
	const { exports } = JSON.parse(await readFile(join(engineDir, 'package.json'), 'utf8')) as { exports: Record<string, string> };
	// @water-management/engine[/sub] → that revision's source, by its own package.json exports.
	const engineAt: Plugin = {
		name: 'engine-at-rev',
		setup(b) {
			b.onResolve({ filter: /^@water-management\/engine(\/.*)?$/ }, (a) => {
				const target = exports[`.${a.path.slice('@water-management/engine'.length)}`];
				return target ? { path: join(engineDir, target) } : { errors: [{ text: `${a.path} is not exported by the engine at ${rev}` }] };
			});
		}
	};
	const outfile = join(dir, 'assurance-jit.child.mjs');
	await build({ entryPoints: [child], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'error', plugins: [engineAt] });
	return outfile;
}

async function stressChild(o: StressOptions, bundle: string, period: number, ref: string): Promise<ChildResult> {
	try {
		const { stdout } = await run(o.node, [...o.flags, `--deopt-every-n-times=${period}`, bundle, String(o.runs)], { timeout: 900_000, maxBuffer: 1 << 24 });
		return childResult(period, stdout, ref, null);
	} catch (e) {
		const err = e as { killed?: boolean; code?: unknown; stdout?: string };
		return childResult(period, err.stdout ?? '', ref, err.killed ? 'timeout' : `exit ${String(err.code)}`);
	}
}

async function main() {
	let o: StressOptions;
	try {
		o = parseStressArgs(process.argv.slice(2));
	} catch (e) {
		console.error((e as Error).message);
		process.exit(2);
	}
	const dir = await mkdtemp(join(tmpdir(), 'wm-v8-osr-'));
	try {
		const bundle = await buildBundle(o.rev, dir);
		const version = (await run(o.node, ['--version'])).stdout.trim();
		const v8 = (await run(o.node, ['-p', 'process.versions.v8 + " " + process.arch'])).stdout.trim();
		const [ref] = hashesOf((await run(o.node, [...o.flags, bundle, '1'])).stdout);
		if (!ref) throw new Error('the unstressed reference run printed no result');
		console.log(`node ${version} (V8 ${v8}), engine at ${o.rev}, flags [${o.flags.join(' ')}]`);
		const queue = o.periods.flatMap((p) => Array.from({ length: o.trials }, () => p));
		const results: ChildResult[] = [];
		await Promise.all(
			Array.from({ length: o.jobs }, async () => {
				for (let p = queue.shift(); p !== undefined; p = queue.shift()) {
					const r = await stressChild(o, bundle, p, ref);
					results.push(r);
					console.log(`  N=${r.period}: ${r.wrong} of ${r.runs} runs wrong${r.error ? ` (${r.error})` : ''}`);
				}
			})
		);
		const s = summarize(results);
		console.log(`${s.failedProcesses} of ${s.processes} processes had a wrong run; ${s.wrong} of ${s.runs} runs wrong${s.incomplete ? `; ${s.incomplete} ended early` : ''}`);
		process.exitCode = exitCodeOf(s);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

if (process.argv[1] && /v8-osr-stress\.ts$/.test(process.argv[1])) {
	main().catch((e) => {
		console.error(e instanceof Error ? e.message : e);
		process.exit(2);
	});
}
