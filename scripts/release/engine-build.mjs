#!/usr/bin/env node
// The engine build's test record (roadmap WP-3.13, model.md §2.10f), for the
// validation statement every report prints and the evidence pack manifests.
//
// Runs the engine's unit suite (packages/engine, vitest project `unit`: the
// invariant tests, the pinned regression seeds and the random-network soak
// sharded across src/fuzz/) with the soak widened to --cases random
// catchments (FUZZ_CASES, from FUZZ_SEED=1, so a rerun of the same commit runs
// the same catchments), then writes
//
//   { "version": ENGINE_VERSION, "gitSha": HEAD, "invariantsPassed": bool, "soakCases": n }
//
// to --out (default engine-build.json at the repo root, gitignored). It exits
// 1 when the suite fails (the record still says so) or when vitest's report
// doesn't show the soak shards running at --cases, so a release can't ship on
// a failed or narrowed run. It refuses a checkout with uncommitted changes to
// tracked files: the record names HEAD, and must describe exactly that commit.
//
// The builds inject the file's text as ENGINE_BUILD_JSON: the frontend as a
// Vite `define` (frontend/vite.config.ts), the Lambdas as an esbuild `define`
// (infra/scripts/package-lambdas.sh, which runs `--check` first). Unset, both
// inject an empty string and the report says "Not recorded for this build".
//
// Usage:  node scripts/release/engine-build.mjs [--cases 2000] [--out engine-build.json] [--allow-dirty] [--max-workers n]
//         (--max-workers caps vitest's workers: every core at once needs more than 4 GB locally)
//         node scripts/release/engine-build.mjs --check     # validate $ENGINE_BUILD_JSON; exit 1 if it isn't a record for this engine
// Root:   pnpm test:engine:build
// Tests:  node --test scripts/release/engine-build.test.mjs
//         (packages/engine/src/liability/engineBuild.test.ts checks --check agrees with the parser the builds use)

import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_CASES = 2000;
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const VERSION_FILE = join(ROOT, 'packages/engine/src/version.ts');
const SHA = /^[0-9a-f]{7,40}$/;

/** ENGINE_VERSION from the source of packages/engine/src/version.ts. */
export function readEngineVersion(src) {
	const m = /export const ENGINE_VERSION = '([^']+)';/.exec(src);
	if (!m) throw new Error('ENGINE_VERSION not found in packages/engine/src/version.ts');
	return m[1];
}

/** @returns {{ cases: number, out: string, allowDirty: boolean, check: boolean, maxWorkers: number | null }} */
export function parseArgs(argv) {
	const o = { cases: DEFAULT_CASES, out: 'engine-build.json', allowDirty: false, check: false, maxWorkers: null };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--allow-dirty') o.allowDirty = true;
		else if (a === '--check') o.check = true;
		else if (a === '--cases' || a === '--out' || a === '--max-workers') {
			const v = argv[++i];
			if (v === undefined) throw new Error(`${a} needs a value`);
			if (a === '--out') o.out = v;
			else {
				if (!/^[1-9]\d*$/.test(v)) throw new Error(`${a} must be a positive whole number, not ${v}`);
				if (a === '--cases') o.cases = Number(v);
				else o.maxWorkers = Number(v);
			}
		} else throw new Error(`unknown argument ${a}`);
	}
	return o;
}

/**
 * Why `x` is not a record for engine `version`, or null when it is. The same
 * rules as the engine's parseEngineBuild (packages/engine/src/liability/engineBuild.ts),
 * which the builds use; its test holds the two to the same verdicts.
 */
export function recordProblem(x, version) {
	if (!x || typeof x !== 'object' || Array.isArray(x)) return 'not an object';
	if (typeof x.version !== 'string' || !x.version) return 'no version';
	if (typeof x.gitSha !== 'string' || !SHA.test(x.gitSha)) return 'gitSha is not a lower-case hex commit';
	if (typeof x.invariantsPassed !== 'boolean') return 'invariantsPassed is not a boolean';
	if (typeof x.soakCases !== 'number' || !Number.isSafeInteger(x.soakCases) || x.soakCases < 0) return 'soakCases is not a whole number';
	if (x.version !== version) return `made for engine ${x.version}, this is ${version}`;
	return null;
}

/** Why the ENGINE_BUILD_JSON text isn't a record for engine `version`, or null. Empty/unset is not a problem (no record). */
export function checkJson(json, version) {
	if (!json) return null;
	let x;
	try {
		x = JSON.parse(json);
	} catch {
		return 'not JSON';
	}
	return recordProblem(x, version);
}

// A soak shard's title (packages/engine/src/fuzz/shard.ts): "seeds <from>–<to> of <cases> from <seed0>, GR4J runoff (shard <i> of <n>)".
const SHARD_TITLE = /^seeds (\d+)–(\d+) of (\d+) from \d+, GR4J runoff \(shard (\d+) of (\d+)\)$/;

/**
 * The suite's verdict from vitest's JSON report: it passed only if every test
 * passed and the whole soak ran at `cases`: every shard 1…n, each passed and
 * at that size, their seed ranges adding up to `cases`. A renamed, dropped or
 * uncollected shard must not leave a record claiming seeds that never ran.
 */
export function verdict(report, cases) {
	const tests = (report?.testResults ?? []).flatMap((f) => f.assertionResults ?? []);
	const soak = tests.filter((t) => /GR4J runoff \(shard \d+ of \d+\)$/.test(t.title ?? ''));
	const problems = [];
	if (!report?.success || report.numFailedTests > 0 || report.numFailedTestSuites > 0) problems.push('the engine suite failed');
	if (!tests.length) problems.push('vitest reported no tests');
	if (!soak.length) problems.push('no soak shard ran');
	const shards = new Set();
	let n = null;
	let seeds = 0;
	for (const t of soak) {
		const m = SHARD_TITLE.exec(t.title);
		if (!m) {
			problems.push(`soak shard title not understood: ${t.title}`);
			continue;
		}
		const [, from, to, size, i, of] = m.map(Number);
		if (size !== cases) problems.push(`soak shard ran at another size: ${t.title}`);
		if (t.status !== 'passed') problems.push(`soak shard ${t.status}: ${t.title}`);
		if (n !== null && of !== n) problems.push(`soak shards disagree on their count: ${t.title}`);
		n = of;
		if (shards.has(i)) problems.push(`soak shard ${i} ran twice`);
		shards.add(i);
		seeds += Math.max(0, to - from + 1);
	}
	if (n !== null) {
		const missing = Array.from({ length: n }, (_, k) => k + 1).filter((i) => !shards.has(i));
		if (missing.length) problems.push(`soak shard(s) ${missing.join(', ')} of ${n} did not run`);
		if (!missing.length && seeds !== cases) problems.push(`the soak shards covered ${seeds} seeds, not ${cases}`);
	}
	return { invariantsPassed: problems.length === 0, problems };
}

/** The record, fields in a fixed order so the same run writes the same bytes. */
export function engineBuildRecord({ version, gitSha, invariantsPassed, soakCases }) {
	return { version, gitSha, invariantsPassed, soakCases };
}

function main() {
	let opts;
	try {
		opts = parseArgs(process.argv.slice(2));
	} catch (e) {
		console.error(`engine-build: ${e.message}`);
		process.exit(2);
	}
	const version = readEngineVersion(readFileSync(VERSION_FILE, 'utf8'));

	if (opts.check) {
		const problem = checkJson(process.env.ENGINE_BUILD_JSON ?? '', version);
		if (problem) {
			console.error(`engine-build: ENGINE_BUILD_JSON is not a record for engine ${version}: ${problem}`);
			process.exit(1);
		}
		console.log(process.env.ENGINE_BUILD_JSON ? `engine-build: ENGINE_BUILD_JSON OK (engine ${version})` : 'engine-build: no ENGINE_BUILD_JSON (the build says "Not recorded")');
		return;
	}

	const git = (...args) => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' }).trim();
	const dirty = git('status', '--porcelain', '--untracked-files=no');
	if (dirty && !opts.allowDirty) {
		console.error(`engine-build: tracked files have uncommitted changes, so the record can't name one commit:\n${dirty}\n(--allow-dirty for a local trial)`);
		process.exit(1);
	}
	const gitSha = git('rev-parse', 'HEAD');

	const tmp = mkdtempSync(join(tmpdir(), 'engine-build-'));
	const reportFile = join(tmp, 'vitest.json');
	let report = null;
	try {
		spawnSync('pnpm', ['-C', 'packages/engine', 'exec', 'vitest', 'run', '--project', 'unit', '--reporter=default', '--reporter=json', `--outputFile.json=${reportFile}`, ...(opts.maxWorkers ? [`--maxWorkers=${opts.maxWorkers}`] : [])], {
			cwd: ROOT,
			stdio: 'inherit',
			env: { ...process.env, FUZZ_CASES: String(opts.cases), FUZZ_SEED: '1' }
		});
		try {
			report = JSON.parse(readFileSync(reportFile, 'utf8'));
		} catch {
			report = null;
		}
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
	const { invariantsPassed, problems } = verdict(report, opts.cases);
	const record = engineBuildRecord({ version, gitSha, invariantsPassed, soakCases: opts.cases });
	const out = resolve(process.cwd(), opts.out);
	writeFileSync(out, JSON.stringify(record) + '\n');
	console.log(`engine-build: wrote ${out}: ${JSON.stringify(record)}`);
	if (!invariantsPassed) {
		console.error(`engine-build: ${problems.join('; ')}`);
		process.exit(1);
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
