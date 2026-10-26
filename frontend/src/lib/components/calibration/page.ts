// The Calibration page (`?tab=calibration`, issue #586): fitting the runoff
// parameters and judging the fit, brought together from Settings &
// calibration and Runs & results. Round 2 gives the page its row, its header
// and its two parts; the panels move in with Round 3. Until then each part
// links to the panels where they are today, by their headings word for word,
// so the page is never a dead end. Pure helpers, so the links and the
// forwarding are unit-tested without the page.
import type { NavGroup } from '#lib/components/common/sectionNav.js';
import { SETTINGS_SECTIONS, type SettingsSectionId } from '#lib/components/settings/sections.js';
import { defaultRunId } from '#lib/components/runs/runList.js';
import type { Role } from '#lib/api/types.js';

/** The page's two parts, by their headings' anchors (CalibrationTab.svelte sets them). */
export const CAL_PARTS = [
	{ id: 'cal-setup', label: 'Set up the fit' },
	{ id: 'cal-fit', label: 'How the shown run fits' }
] as const;

export type CalPartId = (typeof CAL_PARTS)[number]['id'];

/** The side index: one group, a link per part, each its heading. */
export function calibrationNavGroups(): NavGroup[] {
	return [{ label: null, sections: CAL_PARTS.map((p) => ({ id: p.id, label: p.label })) }];
}

export const isCalPart = (id: string): id is CalPartId => CAL_PARTS.some((p) => p.id === id);

export interface PanelLink {
	/** The panel's anchor on its page today. */
	id: string;
	/** The panel's heading there, word for word. */
	label: string;
	/** What it holds, in a few words. */
	hint: string;
}

const SETUP_HINTS: Partial<Record<SettingsSectionId, string>> = {
	'set-flow': 'the GR4J parameters, the catchment area and the warm-up',
	'set-record': 'the window, the gauge it is scored at, exclusions and quality flags',
	'set-fit': 'fit automatically, the fit record and the calibration rules',
	'set-wr2012': 'the WR2012 naturalised flow a run is compared with'
};

/**
 * "Set up the fit": the four panels on Settings & calibration, in its page order, named from its own
 * section list (settings/sections.ts), so a renamed heading renames the link.
 */
export const SETUP_LINKS: readonly PanelLink[] = SETTINGS_SECTIONS.filter((s) => s.id in SETUP_HINTS).map((s) => ({
	id: s.id,
	label: s.label,
	hint: SETUP_HINTS[s.id]!
}));

/** A link to a Settings & calibration panel. */
export const settingsHref = (id: string): string => `?tab=settings#${id}`;

/**
 * The run Runs & results shows, and so How the shown run fits (CalibrationResults.svelte): the one in the URL
 * while it is still a run of the project, else its default (the newest; a viewer's published baseline). Null
 * with no runs, or before they load.
 */
export function shownRun<T extends { id: string; published?: boolean }>(runs: readonly T[] | null, picked: string | null, role: Role | null | undefined): T | null {
	if (!runs?.length) return null;
	const id = picked && runs.some((r) => r.id === picked) ? picked : defaultRunId(runs, role);
	return runs.find((r) => r.id === id) ?? null;
}
