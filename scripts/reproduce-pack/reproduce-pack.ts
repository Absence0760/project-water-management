// pnpm reproduce:pack <bundle.zip> [--expect <manifest hash>] [--no-run] [--json]
//
// Check an evidence pack's reproduction bundle and re-run its runs (issue #71;
// docs/evidence-pack.md § Reproduction). An assessor needs only the bundle
// (downloaded from the pack's page, or handed over with the application) and
// this repository at the engine the runs were made with (the bundle's
// README.md says which): no database, no account, no network.
//
// It checks every file against bundle.json, the manifest against the pack's
// hash (and, with --expect, against the hash the public verify lookup
// returned), the inputs and stored results against the manifest, and then
// re-runs each run from its stored inputs and compares the results digest
// (engine evidence/bundle.ts checkPackBundle). --no-run stops before the
// re-run. Exits 0 when everything matches, 1 on any mismatch, 2 on a usage
// error or an unreadable file. --json prints the checks as JSON instead.
//
// Run through the backend's tsx (root package.json `reproduce:pack`); a
// relative path is taken from where you typed the command (pnpm's INIT_CWD).
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkPackBundle, type BundleCheckResult } from '../../packages/engine/src/evidence/bundle';

export const USAGE = 'usage: pnpm reproduce:pack <bundle.zip> [--expect <manifest hash>] [--no-run] [--json]';

export interface ReproduceArgs {
	file: string;
	expect: string | null;
	rerun: boolean;
	json: boolean;
}

/** The command line, or why it can't be read. */
export function parseArgs(argv: readonly string[]): ReproduceArgs | { error: string } {
	const out: ReproduceArgs = { file: '', expect: null, rerun: true, json: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (a === '--no-run') out.rerun = false;
		else if (a === '--json') out.json = true;
		else if (a === '--expect') {
			const v = argv[++i]?.trim().toLowerCase();
			if (!v || !/^[0-9a-f]{64}$/.test(v)) return { error: '--expect takes the pack’s manifest hash: 64 hex digits, as the verify lookup returns it' };
			out.expect = v;
		} else if (a.startsWith('-')) return { error: `unknown option ${a}` };
		else if (out.file) return { error: 'one bundle at a time' };
		else out.file = a;
	}
	if (!out.file) return { error: 'name the bundle (.zip)' };
	return out;
}

/** The result for a person: each check, then the verdict. */
export function formatResult(r: BundleCheckResult, file: string): string {
	const lines: string[] = [];
	lines.push(r.pack ? `Evidence pack ${r.pack.shortCode}, version ${r.pack.version} (manifest SHA-256 ${r.pack.manifestSha256})` : `Reproduction bundle ${file}`);
	const width = Math.max(...r.checks.map((c) => c.id.length));
	for (const c of r.checks) lines.push(`  ${c.ok ? 'ok  ' : 'FAIL'}  ${c.id.padEnd(width)}  ${c.detail}`);
	const other = [...new Set(r.engine.runs)].filter((v) => v !== r.engine.here);
	if (other.length) lines.push(`Note: the runs were made with engine ${other.join(', ')}; this checkout is engine ${r.engine.here}. Check out that engine (README.md) to re-run them.`);
	const failed = r.checks.filter((c) => !c.ok).length;
	const reran = r.checks.some((c) => c.id.startsWith('reproduce:'));
	lines.push(
		r.ok
			? reran
				? 'Reproduced: every file matches, and each run re-runs to the same results.'
				: 'Checked: every file matches its hash and the manifest (not re-run: --no-run).'
			: `NOT reproduced: ${failed} check${failed === 1 ? '' : 's'} failed.`
	);
	return lines.join('\n');
}

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

/** The command; returns its exit code. `env.INIT_CWD` (pnpm) is where a relative path is taken from. */
export async function main(argv: readonly string[], env: NodeJS.ProcessEnv = process.env, write: (s: string) => void = (s) => process.stdout.write(s)): Promise<number> {
	const args = parseArgs(argv);
	if ('error' in args) {
		write(`${args.error}\n${USAGE}\n`);
		return 2;
	}
	const path = resolve(env.INIT_CWD ?? process.cwd(), args.file);
	let bytes: Uint8Array<ArrayBuffer>;
	try {
		bytes = new Uint8Array(await readFile(path));
	} catch (e) {
		write(`can't read ${path}: ${e instanceof Error ? e.message : String(e)}\n`);
		return 2;
	}
	const result = await checkPackBundle(bytes, { hash: sha256, rerun: args.rerun, ...(args.expect ? { expectManifestSha256: args.expect } : {}) });
	write(args.json ? `${JSON.stringify({ file: path, bundleSha256: sha256(bytes), ...result }, null, 2)}\n` : `${formatResult(result, path)}\nBundle SHA-256: ${sha256(bytes)}\n`);
	return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	process.exitCode = await main(process.argv.slice(2));
}
