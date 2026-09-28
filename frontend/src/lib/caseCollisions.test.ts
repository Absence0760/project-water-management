// Guard: no two modules under src/ import as names that differ only in
// letter case. A macOS or Windows checkout's filesystem ignores case, so
// `x.svelte` (the import of x.svelte.ts) and `X.svelte` resolve to one file
// there: svelte-check and every vite build fail on a laptop while Linux CI
// stays green (workspace/sectionHeader.svelte.ts beside SectionHeader.svelte,
// renamed to headerSlot.svelte.ts).
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');

function files(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
		e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]
	);
}

/** The name an import uses: `a.svelte.ts` and `a.ts` import without `.ts`. */
const importName = (path: string) => path.replace(/\.(svelte\.)?[jt]s$/, (m, svelte) => (svelte ? '.svelte' : ''));

export function collisions(paths: string[]): string[][] {
	const byKey = new Map<string, Set<string>>();
	for (const p of paths) {
		for (const name of new Set([p, importName(p)])) {
			const key = name.toLowerCase();
			if (!byKey.has(key)) byKey.set(key, new Set());
			byKey.get(key)!.add(p);
		}
	}
	return [...byKey.values()].filter((s) => s.size > 1).map((s) => [...s].sort());
}

describe('module names that differ only in case', () => {
	it('finds the clash that broke the macOS build (positive control)', () => {
		expect(collisions(['w/SectionHeader.svelte', 'w/sectionHeader.svelte.ts', 'w/other.ts'])).toEqual([
			['w/SectionHeader.svelte', 'w/sectionHeader.svelte.ts']
		]);
	});

	it('has none under src/', () => {
		const paths = files(SRC).map((p) => relative(SRC, p));
		expect(paths.length).toBeGreaterThan(100);
		expect(collisions(paths)).toEqual([]);
	});
});
