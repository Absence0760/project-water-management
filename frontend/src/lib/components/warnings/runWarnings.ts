// The Warnings page's "Run warnings" (issue #611 slice 5, docs/ui.md §
// Warnings): the shown run's warnings, each coded one (summary.warningCodes,
// engine ≥ 1.102.0) with a link to the settings panel its WARNING_CODES entry
// names (or to the Data page, for a fix that loads or renames a series), the
// uncoded ones listed as they are. Things to check first, then the notes on
// how the data were handled, each in the run's order; a text the run repeats
// shows once.
import { isWarningCode, WARNING_CODES, type CodedWarning, type RunSummary, type WarningCode } from '@water-management/engine';
import { CALIBRATION_SETTINGS_SECTIONS, SETTINGS_SECTIONS, settingsPageOf } from '#lib/components/settings/sections.js';
import { warningGroups, warningItem } from '#lib/components/runs/credibility.js';

export interface RunWarningRow {
	text: string;
	/** Null for a warning without a code (an older run, or one not coded yet): listed with no link. */
	code: WarningCode | null;
	group: 'check' | 'note';
	/** Where the fix is: a settings panel (`?tab=settings#set-rain`) or the Data page; null without a code. */
	href: string | null;
	/** The link's words: "Go to Rain gaps", "Go to Data"; null without a code. */
	label: string | null;
}

const PANEL_LABEL: Record<string, string> = Object.fromEntries([...SETTINGS_SECTIONS, ...CALIBRATION_SETTINGS_SECTIONS].map((s) => [s.id, s.label]));
// Inside Flow generation (UnitRainFields.svelte), not a panel of its own.
PANEL_LABEL['set-unit-rain'] = 'Unit rain';

/** A code's link: its settings panel on its page, or the Data page when the catalogue names none. */
export function settingLink(code: WarningCode): { href: string; label: string } {
	const anchor = WARNING_CODES[code].setting;
	if (!anchor) return { href: '?tab=series', label: 'Go to Data' };
	return { href: `?tab=${settingsPageOf(anchor === 'set-unit-rain' ? 'set-share' : anchor)}#${anchor}`, label: `Go to ${PANEL_LABEL[anchor] ?? 'the setting'}` };
}

/**
 * The run's warnings as the page lists them: things to check, then notes, each in the run's order. A coded one is
 * grouped by its catalogue entry and links to its setting; an uncoded one is grouped as Runs & results groups it
 * (credibility.ts warningGroups, by its text) and has no link.
 */
export function runWarningRows(summary: Pick<RunSummary, 'warnings' | 'warningCodes'> | null | undefined): RunWarningRow[] {
	const codeOf = new Map<string, CodedWarning>();
	for (const c of summary?.warningCodes ?? []) if (isWarningCode(c.code)) codeOf.set(c.text, c);
	const rows: RunWarningRow[] = [];
	for (const w of new Set(summary?.warnings ?? [])) {
		const c = codeOf.get(w);
		if (c) rows.push({ text: warningItem(w), code: c.code, group: WARNING_CODES[c.code].group, ...settingLink(c.code) });
		else rows.push({ text: warningItem(w), code: null, group: warningGroups([w]).data.length ? 'note' : 'check', href: null, label: null });
	}
	return [...rows.filter((r) => r.group === 'check'), ...rows.filter((r) => r.group === 'note')];
}
