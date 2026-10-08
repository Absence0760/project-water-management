#!/usr/bin/env node
// The engine build record for a web release (WP-3.13, docs/model.md §2.10f):
// runs the engine's unit suite (the invariant tests and the random-network
// soak, packages/engine/src/fuzz/) with FUZZ_CASES = --soak-cases, then writes
// the record the report's validation statement prints:
//
//   { version, gitSha, invariantsPassed, soakCases }
//
// deploy-frontend.yml runs it before `pnpm build:frontend`; the frontend build
// injects the record (frontend/vite.config.ts `__ENGINE_BUILD__`, read by the
// engine's parseEngineBuild). A failing suite fails the release: no site ships
// with invariantsPassed false. On GitHub Actions the record goes to
// $GITHUB_ENV as ENGINE_BUILD; elsewhere it is printed.
//
//   node scripts/release/engine-build.mjs --soak-cases 4000
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** ENGINE_VERSION from packages/engine/src/version.ts's source. */
export function engineVersionOf(source) {
	const m = /export const ENGINE_VERSION = '(\d+\.\d+\.\d+)';/.exec(source);
	if (!m) throw new Error('packages/engine/src/version.ts has no ENGINE_VERSION = \'X.Y.Z\'');
	return m[1];
}

/** --soak-cases N: a positive whole number. */
export function soakCasesOf(argv) {
	const i = argv.indexOf('--soak-cases');
	const n = i >= 0 ? Number(argv[i + 1]) : NaN;
	if (!Number.isInteger(n) || n < 1) throw new Error('usage: engine-build.mjs --soak-cases <N ≥ 1>');
	return n;
}

/**
 * The soak's per-case timeout for a release (FUZZ_MS_PER_CASE, packages/engine/src/fuzz/shard.ts):
 * 2 s a case, ~10x a case alone, so only a hang stops a release, never a slow runner (one at
 * ~0.4 s a case timed out web@0.1.6's 400-case shards under the 0.6 s default).
 */
export const RELEASE_MS_PER_CASE = 2_000;

/** The engine suite's environment: the soak widened to `soakCases`, with the release's timeout. */
export const suiteEnv = (soakCases, env = process.env) => ({ ...env, FUZZ_CASES: String(soakCases), FUZZ_MS_PER_CASE: String(RELEASE_MS_PER_CASE) });

/** The record, in the shape parseEngineBuild accepts. */
export function buildRecord({ version, gitSha, invariantsPassed, soakCases }) {
	if (!/^[0-9a-f]{7,40}$/.test(gitSha)) throw new Error(`not a git SHA: ${JSON.stringify(gitSha)}`);
	return { version, gitSha, invariantsPassed, soakCases };
}

/** The $GITHUB_ENV line: one line, since a record never holds a newline. */
export const envLine = (record) => `ENGINE_BUILD=${JSON.stringify(record)}\n`;

function main() {
	const soakCases = soakCasesOf(process.argv.slice(2));
	const version = engineVersionOf(readFileSync(new URL('../../packages/engine/src/version.ts', import.meta.url), 'utf8'));
	// The checked-out commit (the released one): on a manual run GITHUB_SHA is main's head, not the tag's.
	const gitSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
	const run = spawnSync('pnpm', ['-C', 'packages/engine', 'test'], { cwd: ROOT, stdio: 'inherit', env: suiteEnv(soakCases) });
	if (run.status !== 0) {
		console.error(`The engine suite failed (exit ${run.status ?? run.signal}): no build record, and no release.`);
		process.exit(1);
	}
	const record = buildRecord({ version, gitSha, invariantsPassed: true, soakCases });
	if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, envLine(record));
	console.log(JSON.stringify(record));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
