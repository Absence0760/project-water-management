#!/usr/bin/env node
// Guard for the root package.json scripts block (CLAUDE.md "Root package.json
// scripts"). Fails if a script points at a file that doesn't exist, or
// delegates (`pnpm -C <dir> <script>`) to a workspace script that isn't defined,
// or if a script sits outside a `//--` group.
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

	for (const m of cmd.matchAll(/(?:^|\s)((?:bin|scripts|verify)\/[\w./-]+)/g)) {
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

if (errors.length) {
	console.error('Root scripts check failed:\n  ' + errors.join('\n  '));
	process.exit(1);
}
console.log(`Root scripts OK (${Object.keys(scripts).filter((k) => !k.startsWith('//')).length} scripts).`);
