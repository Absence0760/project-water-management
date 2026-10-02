#!/usr/bin/env node
// A migration takes its number when it merges, not when its work starts.
//
// The runner (backend/scripts/migrate.ts) refuses a pending file that sorts
// before one a database already applied: forward-only, which production needs.
// Two branches that each reserved a number ahead of time can merge in the
// other order (178 after 180 and 181), and then every database that applied
// the later numbers first (each developer's dev database, a worktree's, and
// production once deployed) refuses to migrate until the late file is
// renumbered. The runner can only say so after the fact; this guard says so on
// the PR, while renumbering is still free.
//
// The rule: every migration a change adds sorts after, and does not share a
// number with, the highest migration on the base it merges into.
//
//   * CI, pull_request: the checkout is GitHub's merge ref, whose first parent
//     is the base branch's tip, so the base is HEAD^1 and the change is HEAD.
//   * CI, push to main: the base is HEAD^1 (the previous main) too, so a merge
//     that slipped past a stale PR check turns main red at once.
//   * Locally: the base is origin/main (run `git fetch` first) and the change
//     is the working tree.
//
// Branch protection doesn't make a PR re-run its checks when main moves, so a
// green check can go stale; rerun it (or merge origin/main) before merging a
// PR with a migration.
//
// Run:   pnpm check:migrations [--base <rev>] [--head <rev>]
// CI:    ci.yml, job `workflow-lint`.
// Tests: node --test scripts/guards/check_migration_order.test.mjs

import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DIR = 'backend/migrations';
// The runner's own filter (migrate.ts readMigrations).
const MIGRATION = /^\d+_.+\.sql$/;

const numberOf = (name) => Number(name.slice(0, name.indexOf('_')));
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The problems with `head`'s migrations against `base`'s: every file in head
 * and not in base must sort after base's highest and take a number base
 * doesn't use. Both are lists of file names.
 */
export function checkOrder(base, head) {
	const baseNames = base.filter((n) => MIGRATION.test(n)).sort(cmp);
	const known = new Set(baseNames);
	const added = head.filter((n) => MIGRATION.test(n) && !known.has(n)).sort(cmp);
	const highest = baseNames.at(-1);
	if (highest === undefined || added.length === 0) return { added, highest, problems: [] };
	const taken = new Set(baseNames.map(numberOf));
	const late = (name) => cmp(name, highest) <= 0 || taken.has(numberOf(name));
	// Renames start past every number already in use, the change's good files' too.
	let next = Math.max(...[highest, ...added.filter((n) => !late(n))].map(numberOf)) + 1;
	const problems = [];
	for (const name of added) {
		if (!late(name)) continue;
		const width = name.indexOf('_');
		const renamed = `${String(next++).padStart(width, '0')}${name.slice(width)}`;
		const why = taken.has(numberOf(name)) ? `shares its number with a migration on the base` : `sorts before ${highest}, the base's highest`;
		problems.push({ name, renamed, message: `${name} ${why}; renumber it: git mv ${DIR}/${name} ${DIR}/${renamed}` });
	}
	return { added, highest, problems };
}

function treeAt(rev) {
	const out = execFileSync('git', ['ls-tree', '--name-only', `${rev}:${DIR}`], { encoding: 'utf8' });
	return out.split('\n').filter(Boolean);
}

function main(argv) {
	const arg = (flag) => {
		const i = argv.indexOf(flag);
		return i === -1 ? undefined : argv[i + 1];
	};
	const ci = process.env.GITHUB_ACTIONS === 'true';
	const baseRev = arg('--base') ?? (ci ? 'HEAD^1' : 'origin/main');
	const headRev = arg('--head') ?? (ci ? 'HEAD' : undefined);
	let base;
	try {
		base = treeAt(baseRev);
	} catch {
		console.error(`check:migrations: can't read ${DIR} at ${baseRev} (in CI the checkout needs fetch-depth: 2; locally, git fetch origin).`);
		return 2;
	}
	const head = headRev ? treeAt(headRev) : readdirSync(DIR);
	const { added, highest, problems } = checkOrder(base, head);
	if (problems.length === 0) {
		console.log(`check:migrations: ${added.length ? `${added.join(', ')} after ${highest}` : `no new migration against ${baseRev}`}, ok.`);
		return 0;
	}
	for (const p of problems) {
		console.error(ci ? `::error file=${DIR}/${p.name}::${p.message}` : `check:migrations: ${p.message}`);
	}
	console.error(
		'A migration takes the next free number when it merges (docs/data-model.md § Migrations). ' +
			'Renumber it, update the places that cite its file name (git grep <old name>), and push.'
	);
	return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
