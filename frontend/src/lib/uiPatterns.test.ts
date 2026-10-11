// The workspace's shared UI patterns stay one piece each (issue #521, ui-playbook.md § 2 and § 5): a static
// scan of every component, so a screen that writes its own copy fails here rather than drifting in looks.
// - A fold is common/Fold.svelte, never a hand-written <details class="fold">, so every fold has the line of
//   its values (a required prop), the same chevron, named action and "needs fixing".
// - The explain switch is common/ExplainSwitch.svelte, and app.css holds the one rule that hides `.explain`.
// - A paste dialog is model/PasteDialogFrame.svelte's frame.
// - A typed date is a text field read by parseDay, never <input type="date"> (the browser's own order: 12/30/2021
//   in a US browser). The fields from before the rule are counted below and may only go down.
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

/**
 * Native date fields written before the typed-date rule (ui-playbook § 2, "A typed date is day first too"),
 * by file. Converting them needs a shared day field that joins the save blocker's invalid fields, as
 * NumberInput does; until then the count per file may only go down. Lower it when you convert one.
 */
const NATIVE_DATE_BEFORE_THE_RULE: Record<string, number> = {
	'lib/components/allocations/AllocationForm.svelte': 2,
	'lib/components/calibration/CalibrationWindowFields.svelte': 2,
	'lib/components/common/PeriodList.svelte': 2,
	'lib/components/feeds/DataFeedsPanel.svelte': 1,
	'lib/components/feeds/UnitRain.svelte': 1,
	'lib/components/import/WorkbookReview.svelte': 1,
	'lib/components/network/DemandScheduleFields.svelte': 2,
	'lib/components/network/DevelopmentFields.svelte': 3,
	'lib/components/project/LicenceRecordPanel.svelte': 2,
	'lib/components/project/RegistrationChecksPanel.svelte': 1,
	'lib/components/runs/PublicationPanel.svelte': 1,
	'lib/components/runs/ReportWindowPanel.svelte': 2,
	'lib/components/scenarios/ApplicationPanel.svelte': 2,
	'lib/components/settings/RainSourceSection.svelte': 4,
	'lib/components/settings/SettingsTab.svelte': 4
};

describe('shared UI patterns (issue #521)', () => {
	it('every fold is common/Fold.svelte', () => {
		expect(where(/<details[^>]*\bclass\s*=\s*["'{][^"'}]*\bfold\b/, ['lib/components/common/Fold.svelte'])).toEqual([]);
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

	it('no new native date field: a typed date is day first (parseDay), and the old ones only go down', () => {
		const found = Object.fromEntries(files.map((f) => [f.path, f.text.match(NATIVE_DATE)?.length ?? 0]).filter(([, n]) => n));
		expect(found).toEqual(NATIVE_DATE_BEFORE_THE_RULE);
	});
});
