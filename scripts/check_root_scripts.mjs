#!/usr/bin/env node
// Guard for the root package.json scripts block (CLAUDE.md "Root package.json
// scripts"). Fails if a script points at a file that doesn't exist, or
// delegates (`pnpm -C <dir> <script>`) to a workspace script that isn't defined,
// or if a script sits outside a `//--` group, or if a tracked file tells you to
// run a root script that one of pnpm's own commands shadows (below).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const { scripts } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const errors = [];
let inGroup = false;

for (const [name, cmd] of Object.entries(scripts)) {
	if (name.startsWith('//--')) {
		inGroup = true;
		continue;
	}
	if (!inGroup) errors.push(`${name}: not under a "//-- <group> --" divider`);

	for (const m of cmd.matchAll(/(?:^|\s)((?:bin|scripts|verify|ingest)\/[\w./-]+)/g)) {
		if (!existsSync(join(root, m[1]))) errors.push(`${name}: missing file ${m[1]}`);
	}
	for (const m of cmd.matchAll(/pnpm -C (\S+) ([\w:-]+)/g)) {
		const pkgPath = join(root, m[1], 'package.json');
		if (!existsSync(pkgPath)) {
			errors.push(`${name}: no package.json in ${m[1]}`);
			continue;
		}
		const target = JSON.parse(readFileSync(pkgPath, 'utf8')).scripts ?? {};
		if (!(m[2] in target)) errors.push(`${name}: ${m[1]} has no "${m[2]}" script`);
	}
}

// pnpm runs its own command before a script of the same name: `pnpm setup`
// is pnpm's self-setup (it edits your shell profile), never the root `setup`
// script, so a doc or workflow that says `pnpm setup` installs nothing (the
// fresh-clone job's first run, docs/testing.md § Fresh clone). Such a script
// must be written `pnpm run <name>`. pnpm 10's commands, less the ones that
// run the script of their name (test, start, restart, stop).
const PNPM_COMMANDS = new Set(
	'add approve-builds audit bin cache cat-file cat-index config create dedupe deploy dlx doctor env exec fetch find-hash get help i ignored-builds import init install install-test la licenses link list ll ls outdated pack patch patch-commit patch-remove prune publish rebuild recursive remove rm root run self-update server set setup store unlink up update why'.split(' ')
);
const shadowed = Object.keys(scripts).filter((n) => PNPM_COMMANDS.has(n));
if (shadowed.length) {
	const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
		.split('\0')
		.filter((f) => /\.(md|ya?ml|sh|mjs|js|ts|json)$/.test(f) && !f.endsWith('check_root_scripts.mjs'));
	// A bare `pnpm <name>` right after "never" or "bare" is the warning itself.
	const re = new RegExp(`(?<!(?:never|bare) \`)\\bpnpm (${shadowed.join('|')})(?![\\w:-])`, 'g');
	for (const f of tracked) {
		const path = join(root, f);
		if (!existsSync(path)) continue;
		const lines = readFileSync(path, 'utf8').split('\n');
		lines.forEach((line, i) => {
			for (const m of line.matchAll(re))
				errors.push(`${f}:${i + 1}: \`pnpm ${m[1]}\` runs pnpm's own ${m[1]} command, not the root script; write \`pnpm run ${m[1]}\``);
		});
	}
}

if (errors.length) {
	console.error('Root scripts check failed:\n  ' + errors.join('\n  '));
	process.exit(1);
}
console.log(`Root scripts OK (${Object.keys(scripts).filter((k) => !k.startsWith('//')).length} scripts).`);
