// No empty table header cell anywhere in the app's markup. A blank corner
// <th> (above a column of row headers) reads as an unnamed column to a screen
// reader, and is axe's empty-table-header: name it with a visually hidden
// label instead. The e2e a11y spec checks the rendered tabs; this catches the
// components it doesn't reach (such as the calibration MAR penalty table).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const EMPTY_TH = /<th\b[^>]*>\s*<\/th>|<th\b[^>]*\/>/g;

function svelteFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
		e.isDirectory() ? svelteFiles(join(dir, e.name)) : e.name.endsWith('.svelte') ? [join(dir, e.name)] : []
	);
}

describe('table headers', () => {
	it('the pattern finds an empty header and passes a named one', () => {
		expect('<th scope="col"></th>'.match(EMPTY_TH)).toHaveLength(1);
		expect('<th scope="col" />'.match(EMPTY_TH)).toHaveLength(1);
		expect('<th scope="col"><span class="visually-hidden">Curve</span></th>'.match(EMPTY_TH)).toBeNull();
	});

	it('no component has an empty <th>', () => {
		const src = fileURLToPath(new URL('../..', import.meta.url));
		const files = svelteFiles(src);
		expect(files.length).toBeGreaterThan(50);
		const offenders = files.flatMap((f) => (readFileSync(f, 'utf8').match(EMPTY_TH) ?? []).map((m) => `${f.slice(src.length)}: ${m}`));
		expect(offenders).toEqual([]);
	});
});
