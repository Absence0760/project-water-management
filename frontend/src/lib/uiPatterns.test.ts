// The workspace's shared UI patterns stay one piece each (issue #521, ui-playbook.md § 2 and § 5): a static
// scan of every component, so a screen that writes its own copy fails here rather than drifting in looks.
// - A fold is common/Fold.svelte, never a hand-written <details class="fold">, so every fold has the line of
//   its values (a required prop), the same chevron, named action and "needs fixing". In Settings & calibration's
//   components every collapsible is one: no <details> of any class there (the last three moved in round 5).
// - The explain switch is common/ExplainSwitch.svelte, and app.css holds the one rule that hides `.explain`.
// - A paste dialog is model/PasteDialogFrame.svelte's frame.
// - A typed date is common/DayInput.svelte (a text field read by parseDay), never <input type="date"> (the
//   browser's own order: 12/30/2021 in a US browser). The 30 fields from before the rule were converted (issue #521).
// - Small text takes the type scale's tokens (app.css --font-xs, --font-sm: 12 px on a phone), never a literal size
//   under 0.85rem, outside paper and the decided exceptions below (issue #521 round 6, ui-playbook.md § 3).
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

/** <input type="date">, in any quoting. */
const NATIVE_DATE = /\btype\s*=\s*(?:"date"|'date'|\{\s*['"]date['"]\s*\})/g;

/** A literal font size under the floor: 0.85rem (11.9 px at the 14 px root, the floor's tolerance), 0.85em, 11.9 px. */
const LITERAL_SIZE = /^font(?:-size)?:\s*(?:[^;]*?\s)?([\d.]+)(rem|em|px|pt)\b/;
function underFloor(decl: string): string | undefined {
	const m = LITERAL_SIZE.exec(decl.trim());
	if (!m) return undefined;
	const v = Number(m[1]);
	const px = m[2] === 'px' ? v : m[2] === 'pt' ? (v * 4) / 3 : v * 14;
	return px < 11.85 ? `${m[1]}${m[2]}` : undefined;
}
/** Each literal size under the floor in a stylesheet, with the rule's selector; none inside `@media print` (paper). */
function smallSizes(css: string): { selector: string; size: string }[] {
	const found: { selector: string; size: string }[] = [];
	const stack: string[] = [];
	let buf = '';
	for (const ch of css) {
		if (ch === '{') {
			stack.push(buf.trim().replace(/\s+/g, ' '));
			buf = '';
		} else if (ch === '}') {
			stack.pop();
			buf = '';
		} else if (ch === ';') {
			const size = underFloor(buf);
			if (size && !stack.some((s) => /^@media\b[^{]*\bprint\b/.test(s))) found.push({ selector: stack.at(-1) ?? '', size });
			buf = '';
		} else buf += ch;
	}
	return found;
}
/**
 * The decided exceptions to the small-text floor, by file and rule (ui-playbook.md § 3, type scale):
 * - SVG text (`<text>` in a chart or diagram): sized in the drawing's units, so its drawn size follows the drawing's
 *   scale; the values are in a table or the figure's text beside it, and checkDiagramLabels measures the drawn size.
 * - A glyph a screen reader skips (aria-hidden): a menu's ▾, a delta's ▲▼, a sorted column's arrow.
 * - A count bubble on an icon button whose name carries the count (aria-hidden, in a fixed 14 px dot).
 */
const SMALL_TEXT_EXCEPTIONS: Record<string, string[]> = {
	'lib/components/compare/ReserveYearsChart.svelte': ['text'],
	'lib/components/help/Diagram.svelte': ['.diagram :global(.s)', '.diagram :global(.m)'],
	'lib/components/landing/MiniChart.svelte': ['text'],
	'lib/components/map/MapSetupPill.svelte': ['.icon text'],
	'lib/components/network/DamStorageFields.svelte': ['.tick, .axis-label'],
	'lib/components/network/NetworkSchematic.svelte': ['.meta'],
	'lib/components/overview/SetupSteps.svelte': ['.icon text'],
	'lib/components/report/evidence/FdcPlot.svelte': ['.axis'],
	'lib/components/report/evidence/IntervalPlot.svelte': ['.lbl, .axis'],
	'lib/components/runs/EwrAssurancePanel.svelte': ['.v, .m', '.axis'],
	'lib/components/runs/EwrFdcOverlay.svelte': ['.tick', '.axis-title'],
	'lib/components/settings/MonthlyBars.svelte': ['.m', '.max'],
	'lib/components/uncertainty/BandFdcChart.svelte': ['.tick', '.ewr-l'],
	'lib/components/uncertainty/TornadoChart.svelte': ['.tick', '.setting', '.central-l', '.threshold-l'],
	'lib/components/compare/Delta.svelte': ['.arrow'],
	'lib/components/export/DownloadMenu.svelte': ['.caret'],
	'lib/components/layout/AccountMenu.svelte': ['.caret', '.mfa-badge'],
	'routes/+page.svelte': ['.caret'],
	'lib/components/supply/UnitResultsTable.svelte': ['.dir'],
	'lib/components/notes/NotesDrawer.svelte': ['.compact .count'],
	'lib/components/workspace/SectionsMenu.svelte': ['.count']
};


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

	it('the small-text scan finds a literal size under the floor, skips paper and passes the tokens', () => {
		const css = 'a { font-size: 0.75rem; } b { font-size: 0.85rem; } c { font-size: var(--font-xs); } d { font: 700 0.8rem/1 x; } e { font-size: 0.8em; } f { font-size: 11px; } @media print { g { font-size: 7pt; } }';
		expect(smallSizes(css)).toEqual([
			{ selector: 'a', size: '0.75rem' },
			{ selector: 'd', size: '0.8rem' },
			{ selector: 'e', size: '0.8em' },
			{ selector: 'f', size: '11px' }
		]);
	});

	it('no literal font size under the floor on screen: small text takes --font-xs or --font-sm', () => {
		const sheets = [...files, { path: 'app.css', text: readFileSync(join(ROOT, 'app.css'), 'utf8').replace(COMMENTS, '$1') }].map((f) => ({
			path: f.path,
			css: f.path.endsWith('.css') ? f.text : [...f.text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n')
		}));
		const found = sheets.flatMap((f) => smallSizes(f.css).filter((x) => !SMALL_TEXT_EXCEPTIONS[f.path]?.includes(x.selector)).map((x) => `${f.path}: ${x.selector} { ${x.size} }`));
		expect(found).toEqual([]);
		// Every exception still names a small size, so the list can't outlive what it excuses.
		const stale = Object.entries(SMALL_TEXT_EXCEPTIONS).flatMap(([path, selectors]) => {
			const here = smallSizes(sheets.find((f) => f.path === path)?.css ?? '').map((x) => x.selector);
			return selectors.filter((s) => !here.includes(s)).map((s) => `${path}: ${s}`);
		});
		expect(stale).toEqual([]);
	});
});
