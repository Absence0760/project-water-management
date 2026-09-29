// No browser confirm() box in the app (issue #162 item 21): every question
// goes through the app's own dialog (confirmDialog, lib/components/common/
// confirm.svelte.ts), which matches the app, names its buttons after the
// action, is translated on the farmer pages, and for the leave guard says
// where you are going. The browser's own prompt is left only for closing the
// tab or reloading (lib/nav/leaveGuard.ts), which no page can restyle.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** A call of the global confirm (bare, window. or globalThis.), not a method or a longer name. */
const BROWSER_CONFIRM = /(?<![\w$.])(?:(?:window|globalThis|self)\s*\.\s*)?confirm\s*\(/g;
/** Comments, so a sentence that names confirm() isn't a call. */
const COMMENTS = /\/\*[\s\S]*?\*\/|(^|[^:'"`])\/\/.*$|<!--[\s\S]*?-->/gm;

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		if (e.isDirectory()) return sourceFiles(join(dir, e.name));
		if (e.name.endsWith('.test.ts')) return [];
		return /\.(svelte|ts|js)$/.test(e.name) ? [join(dir, e.name)] : [];
	});
}

const calls = (text: string) => text.replace(COMMENTS, '$1').match(BROWSER_CONFIRM) ?? [];

describe('browser confirm()', () => {
	it('the pattern finds the global in each spelling and passes the app helper, methods and comments', () => {
		expect(calls('if (!confirm(q)) return;')).toHaveLength(1);
		expect(calls('if (!window.confirm(q)) return;')).toHaveLength(1);
		expect(calls('globalThis.confirm("x")')).toHaveLength(1);
		expect(calls('const ok = () => !pending || confirm(DISCARD);')).toHaveLength(1);
		expect(calls('await confirmDialog({ title })')).toHaveLength(0);
		expect(calls('form.confirm(x)')).toHaveLength(0);
		expect(calls('async function unsubscribe() {}')).toHaveLength(0);
		expect(calls('// in place of the browser confirm() box')).toHaveLength(0);
		expect(calls('/* confirm() */')).toHaveLength(0);
	});

	it('no component or module calls it', () => {
		const src = fileURLToPath(new URL('../', import.meta.url));
		const files = sourceFiles(src);
		// Positive control: the walk reaches the pages that used to call it.
		expect(files.length).toBeGreaterThan(100);
		expect(files.some((f) => f.endsWith('routes/+page.svelte'))).toBe(true);
		expect(files.some((f) => f.endsWith('scenarios/OverrideEditor.svelte'))).toBe(true);
		const offenders = files.flatMap((f) => calls(readFileSync(f, 'utf8')).map((m) => `${f.slice(src.length)}: ${m}`));
		expect(offenders, 'use confirmDialog (lib/components/common/confirm.svelte.ts), not the browser box').toEqual([]);
	});
});
