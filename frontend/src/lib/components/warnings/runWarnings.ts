// The Warnings page's "Run warnings" (issue #611 slice 5, docs/ui.md §
// Warnings): the shown run's warnings, each coded one (summary.warningCodes,
// engine ≥ 1.102.0) with a link to the settings panel its WARNING_CODES entry
// names (or to the Data page, for a fix that loads or renames a series), the
// uncoded ones listed as they are. Things to check first, then the notes on
// how the data were handled, each in the run's order; a text the run repeats
// shows once.
import { isWarningCode, WARNING_CODES, type CodedWarning, type RunSummary, type ProjectSettings, type WarningCode, type WarningParams } from '@water-management/engine';
import { CODE_FIXES, uncodedFix, type Fix } from './fixes';
import { runWarningId } from './ids';
import type { Area } from './problems';
import { CALIBRATION_SETTINGS_SECTIONS, SETTINGS_SECTIONS, settingsPageOf } from '#lib/components/settings/sections.js';
import { warningGroups, warningItem } from '#lib/components/runs/credibility.js';

export interface RunWarningRow {
	/** Stable across runs (ids.ts runWarningId), for the kept list. */
	id: string;
	text: string;
	/** Null for a warning without a code (an older run, or one not coded yet). */
	code: WarningCode | null;
	params: WarningParams;
	group: 'check' | 'note';
	area: Area;
	/** What is wrong and what to do, and the primary action (fixes.ts). */
	fix: Fix;
	/** Where the fix is, as a link, for a reader who can't change it: the action's href, or the setting's panel. */
	href: string | null;
	label: string | null;
}

const PANEL_LABEL: Record<string, string> = Object.fromEntries([...SETTINGS_SECTIONS, ...CALIBRATION_SETTINGS_SECTIONS].map((s) => [s.id, s.label]));
// Inside Flow generation (UnitRainFields.svelte), not a panel of its own.
PANEL_LABEL['set-unit-rain'] = 'Unit rain';

/** A code's link: its settings panel on its page, or the Data page when the catalogue names none. */
export function settingLink(code: WarningCode): { href: string; label: string } {
	const anchor = WARNING_CODES[code].setting;
	// The map's warnings are fixed on the Map (issue #646 F6), not on Data.
	if (!anchor && code.startsWith('map.')) return { href: '?tab=map&checks=1', label: 'Go to the Map' };
	if (!anchor) return { href: '?tab=series', label: 'Go to Data' };
	return { href: `?tab=${settingsPageOf(anchor === 'set-unit-rain' ? 'set-share' : anchor)}#${anchor}`, label: `Go to ${PANEL_LABEL[anchor] ?? 'the setting'}` };
}

/**
 * A run warning row's state: kept (settings.warningsKept), fixed (its one-value fix is in the saved settings, so a
 * new run should no longer warn), else open. The page and the Warnings row's badge both read it.
 */
export function runWarningState(r: Pick<RunWarningRow, 'id' | 'fix' | 'params'>, settings: ProjectSettings): 'open' | 'fixed' | 'kept' {
	if ((settings.warningsKept ?? []).some((k) => k.id === r.id)) return 'kept';
	const a = r.fix.action;
	return a.kind === 'setting' && a.applied(settings, r.params) ? 'fixed' : 'open';
}

const areaOf = (code: string | null, fix: Fix): Area => {
	if (code?.startsWith('rain.')) return 'rain';
	if (code?.startsWith('calibration.')) return 'calibration';
	if (code?.startsWith('data.')) return 'data';
	const href = 'href' in fix.action ? fix.action.href : '';
	return /tab=calibration/.test(href) ? 'calibration' : /tab=settings/.test(href) ? 'rain' : /tab=(network|crops|transfers|map)/.test(href) ? 'model' : 'runs';
};

/**
 * The run's warnings as the page lists them: things to check, then notes, each in the run's order, each text once.
 * A coded one is grouped by its catalogue entry and solved by its CODE_FIXES entry; an uncoded one is grouped as
 * Runs & results groups it (credibility.ts warningGroups, by its text) and solved by its words (uncodedFix), else
 * by the guide `guideHref`.
 */
export function runWarningRows(summary: Pick<RunSummary, 'warnings' | 'warningCodes'> | null | undefined, guideHref = '/help/guides/run-and-read-results'): RunWarningRow[] {
	const codeOf = new Map<string, CodedWarning>();
	for (const c of summary?.warningCodes ?? []) if (isWarningCode(c.code)) codeOf.set(c.text, c);
	const rows: RunWarningRow[] = [];
	for (const w of new Set(summary?.warnings ?? [])) {
		const c = codeOf.get(w);
		if (c) {
			const fix = CODE_FIXES[c.code];
			rows.push({ id: runWarningId(c.code, c.params, w), text: warningItem(w), code: c.code, params: c.params, group: WARNING_CODES[c.code].group, area: areaOf(c.code, fix), fix, ...settingLink(c.code) });
		} else {
			const fix = uncodedFix(w, guideHref);
			rows.push({
				id: runWarningId(null, null, w),
				text: warningItem(w),
				code: null,
				params: {},
				group: warningGroups([w]).data.length ? 'note' : 'check',
				area: areaOf(null, fix),
				fix,
				href: 'href' in fix.action ? fix.action.href : null,
				label: fix.action.label
			});
		}
	}
	return [...rows.filter((r) => r.group === 'check'), ...rows.filter((r) => r.group === 'note')];
}
