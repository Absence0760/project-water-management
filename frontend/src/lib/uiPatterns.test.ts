// The workspace's shared UI patterns stay one piece each (issue #521, ui-playbook.md § 2 and § 5): a static
// scan of every component, so a screen that writes its own copy fails here rather than drifting in looks.
// - A fold is common/Fold.svelte, never a hand-written <details class="fold">, so every fold has the line of
//   its values (a required prop), the same chevron, named action and "needs fixing". In Settings & calibration's
//   components every collapsible is one: no <details> of any class there (the last three moved in round 5).
// - The explain switch is common/ExplainSwitch.svelte, and app.css holds the one rule that hides `.explain`.
// - A paste dialog is model/PasteDialogFrame.svelte's frame.
// - A typed date is common/DayInput.svelte (a text field read by parseDay), never <input type="date"> (the
//   browser's own order: 12/30/2021 in a US browser). The 30 fields from before the rule were converted (issue #521).
// - A badge's capital is app.css's `.badge::first-letter`: a component's `text-transform: none` on a badge does
//   nothing (it doesn't reach the first letter), so none is written (13 removed in round 6).
// - A field's error line never moves its row: app.css's rule for a row holding a .num-err (round 6).
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** Comments, so a sentence that names a pattern isn't one. */
const COMMENTS = /\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->|(^|[^:'"`])\/\/.*$/gm;

function svelteFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		if (e.isDirectory()) return e.name === '__fixtures__' ? [] : svelteFiles(join(dir, e.name));
		return e.name.endsWith('.svelte') ? [join(dir, e.name)] : [];
	});
}
const files = svelteFiles(ROOT).map((path) => ({ path: relative(ROOT, path), text: readFileSync(path, 'utf8').replace(COMMENTS, '$1') }));
const where = (re: RegExp, except: string[] = []) => files.filter((f) => !except.includes(f.path) && re.test(f.text)).map((f) => f.path);

/** The rules in `text` that set text-transform: none on a badge: a selector naming .badge, or a class the markup gives a badge. */
function badgeTransformRules(text: string): string[] {
	const badgeClasses = new Set(['badge', ...[...text.matchAll(/class="([^"]*\bbadge\b[^"]*)"/g)].flatMap((m) => m[1].split(/\s+/))]);
	return [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
		.filter(([, selector, body]) => /text-transform\s*:\s*none/.test(body) && [...selector.matchAll(/\.([\w-]+)/g)].some((c) => badgeClasses.has(c[1])))
		.map(([, selector]) => selector.replace(/^[\s\S]*(?:<style[^>]*>|\n)/, '').trim());
}

/** <input type="date">, in any quoting. */
const NATIVE_DATE = /\btype\s*=\s*(?:"date"|'date'|\{\s*['"]date['"]\s*\})/g;


describe('shared UI patterns (issue #521)', () => {
	it('every fold is common/Fold.svelte', () => {
		expect(where(/<details[^>]*\bclass\s*=\s*["'{][^"'}]*\bfold\b/, ['lib/components/common/Fold.svelte'])).toEqual([]);
	});

	it('every collapsible in Settings & calibration is a Fold, whatever its class', () => {
		expect(where(/<details\b/).filter((f) => f.startsWith('lib/components/settings/'))).toEqual([]);
	});

	it('the explain switch is one component, and app.css holds the one rule that hides the explanations', () => {
		expect(where(/Explain each setting under its field/, ['lib/components/common/ExplainSwitch.svelte'])).toEqual([]);
		expect(where(/:not\(\.explained\)/)).toEqual([]);
		const css = readFileSync(join(ROOT, 'app.css'), 'utf8');
		expect(css).toContain('.explain-scope:not(.explained) .explain');
		// A wrapper that turns the explanations on is a scope the rule reaches.
		for (const f of files.filter((x) => /class:explained=/.test(x.text))) expect(f.text, f.path).toMatch(/class="[^"]*\bexplain-scope\b/);
	});

	it('a paste dialog is the shared frame', () => {
		// The box's label, as a paste dialog writes it (a sentence that mentions pasting is no dialog).
		expect(where(/(?:Cells|Rows) copied from a spreadsheet["<]/, ['lib/components/model/GridPasteDialog.svelte', 'lib/components/model/PasteDialogFrame.svelte', 'lib/components/settings/EwrHighFlowsEditor.svelte'])).toEqual([]);
		for (const f of ['lib/components/model/GridPasteDialog.svelte', 'lib/components/settings/EwrHighFlowsEditor.svelte']) {
			const text = files.find((x) => x.path === f)!.text;
			expect(text, f).toContain('<PasteDialogFrame');
			expect(text, f).not.toMatch(/<textarea/);
		}
	});

	it('the date pattern finds a native date field in each spelling and passes text fields', () => {
		const count = (s: string) => s.match(NATIVE_DATE)?.length ?? 0;
		expect(count('<input id="a" type="date" />')).toBe(1);
		expect(count("<input type='date'>")).toBe(1);
		expect(count("<input type={'date'}>")).toBe(1);
		expect(count('<input type="text" placeholder="15 Nov 2021" />')).toBe(0);
		expect(count("{ t: 'date', nullLabel: 'start' }")).toBe(0);
	});

	it('no native date field: a typed date is DayInput, day first (parseDay)', () => {
		const found = Object.fromEntries(files.map((f) => [f.path, f.text.match(NATIVE_DATE)?.length ?? 0]).filter(([, n]) => n));
		expect(found).toEqual({});
		// The shared field is a text box read by parseDay (dayField.svelte.ts), and the forms use it.
		expect(files.find((f) => f.path === 'lib/components/common/DayInput.svelte')!.text).toContain('type="text"');
		expect(readFileSync(join(ROOT, 'lib/components/common/dayField.svelte.ts'), 'utf8')).toContain('parseDay(');
		expect(where(/<DayInput\b/).length).toBeGreaterThanOrEqual(15);
	});

	it('the badge rule pattern finds a badge’s text-transform: none and passes other elements’', () => {
		expect(badgeTransformRules('<style>.badge { margin-left: 0.35rem; text-transform: none; }</style>')).toEqual(['.badge']);
		expect(badgeTransformRules('<span class="badge badge-warn flag">x</span><style>.flag { text-transform: none; }</style>')).toEqual(['.flag']);
		expect(badgeTransformRules('<span class="bubble">x</span><style>.bubble { text-transform: none; }</style>')).toEqual([]);
		expect(badgeTransformRules('<style>.badge { white-space: nowrap; }</style>')).toEqual([]);
	});

	it('no component undoes a badge’s capital: app.css’s ::first-letter is the one rule', () => {
		expect(Object.fromEntries(files.map((f) => [f.path, badgeTransformRules(f.text)]).filter(([, rules]) => rules.length))).toEqual({});
		expect(readFileSync(join(ROOT, 'app.css'), 'utf8')).toMatch(/\.badge::first-letter \{\s*text-transform: uppercase;/);
	});

	it('a field showing its error line never moves its row (app.css)', () => {
		const css = readFileSync(join(ROOT, 'app.css'), 'utf8');
		expect(css).toMatch(/:has\(> \.field \.num-err\) > \.field \{\s*align-self: stretch;/);
		// The two fields that draw the line call it .num-err, so the rule reaches both.
		for (const f of ['lib/components/common/NumberInput.svelte', 'lib/components/common/DayInput.svelte']) {
			expect(files.find((x) => x.path === f)!.text, f).toContain('<span class="num-err"');
		}
	});
});
